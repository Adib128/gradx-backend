import { ForbiddenException, Injectable, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'events';
import { UserRole } from 'generated/prisma/browser';
import { PrismaService } from 'prisma/prisma.service';
import { ErrorMessageKey } from 'src/common/constants/error-message';
import {
  setAiQuotaGuard,
  setAiUsageLogger,
} from 'src/common/helpers/openrouter-chat.helper';

/** Background reference indexing is a platform cost, not the user's generation. */
const UNMETERED_PURPOSES = [
  'reference_embedding',
  'reference_search',
  'reference_search_debug',
];

export type AiUsageSummary = {
  used: number;
  /** null = unlimited. */
  limit: number | null;
  periodStart: string;
  resetsAt: string;
};

function monthStart(date: Date, offset = 0) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));
}

/**
 * Monthly AI token allowance per user: meters every chat completion, blocks
 * calls once the allowance is spent and pushes the new total to open streams.
 */
@Injectable()
export class AiUsageService implements OnModuleInit {
  private readonly events = new EventEmitter();

  constructor(private readonly prisma: PrismaService) {
    this.events.setMaxListeners(0);
  }

  onModuleInit() {
    setAiUsageLogger(async (entry) => {
      try {
        await this.prisma.aiUsageLog.create({
          data: {
            userId: entry.userId ?? null,
            tenantId: entry.tenantId ?? null,
            purpose: entry.purpose || 'other',
            model: entry.model || null,
            requestPreview: entry.requestPreview || null,
            responsePreview: entry.responsePreview || null,
            promptTokens: entry.promptTokens ?? null,
            completionTokens: entry.completionTokens ?? null,
            totalTokens: entry.totalTokens ?? null,
            success: entry.success,
            errorMessage: entry.errorMessage || null,
            durationMs: entry.durationMs ?? null,
            startedAt: entry.startedAt ?? null,
          },
        });
      } catch {
        // Never break AI generation if logging fails.
        return;
      }
      if (entry.userId && entry.totalTokens) void this.publish(entry.userId);
    });
    setAiQuotaGuard((context) => this.assertWithinLimit(context.userId));
  }

  async summary(userId: number): Promise<AiUsageSummary> {
    const now = new Date();
    const periodStart = monthStart(now);
    const [user, usage] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { aiTokenLimit: true, role: true },
      }),
      this.prisma.aiUsageLog.aggregate({
        where: {
          userId,
          createdAt: { gte: periodStart },
          purpose: { notIn: UNMETERED_PURPOSES },
        },
        _sum: { totalTokens: true },
      }),
    ]);
    const unlimited =
      !user || user.role !== UserRole.USER || user.aiTokenLimit === null;
    return {
      used: usage._sum.totalTokens ?? 0,
      limit: unlimited ? null : user.aiTokenLimit,
      periodStart: periodStart.toISOString(),
      resetsAt: monthStart(now, 1).toISOString(),
    };
  }

  /** Tokens each user consumed in the current month, for admin listings. */
  async usedThisMonth(userIds: number[]): Promise<Map<number, number>> {
    if (!userIds.length) return new Map();
    const rows = await this.prisma.aiUsageLog.groupBy({
      by: ['userId'],
      where: {
        userId: { in: userIds },
        createdAt: { gte: monthStart(new Date()) },
        purpose: { notIn: UNMETERED_PURPOSES },
      },
      _sum: { totalTokens: true },
    });
    return new Map(
      rows.map((row) => [row.userId as number, row._sum.totalTokens ?? 0]),
    );
  }

  async assertWithinLimit(userId?: number | null) {
    if (!userId) return;
    const { used, limit } = await this.summary(userId);
    if (limit !== null && used >= limit) {
      throw new ForbiddenException(ErrorMessageKey.AI_TOKEN_LIMIT_REACHED);
    }
  }

  /** Calls `listener` with the user's new total after each metered AI call. */
  subscribe(userId: number, listener: (summary: AiUsageSummary) => void) {
    const channel = `user:${userId}`;
    this.events.on(channel, listener);
    return () => {
      this.events.off(channel, listener);
    };
  }

  /** Re-sends the current total, e.g. after an admin changes the limit. */
  async publish(userId: number) {
    const channel = `user:${userId}`;
    if (!this.events.listenerCount(channel)) return;
    try {
      this.events.emit(channel, await this.summary(userId));
    } catch {
      // A missed live update is corrected by the next one or a reconnect.
    }
  }
}
