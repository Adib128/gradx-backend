import { ForbiddenException, Injectable, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'events';
import { UserRole } from 'generated/prisma/browser';
import { PrismaService } from 'prisma/prisma.service';
import { ErrorMessageKey } from 'src/common/constants/error-message';
import {
  setAiQuotaGuard,
  setAiUsageLogger,
} from 'src/common/helpers/openrouter-chat.helper';
import { paginate } from 'src/common/helpers/paginate.helper';

/** Background reference indexing is a platform cost, not the user's generation. */
const UNMETERED_PURPOSES = [
  'reference_embedding',
  'reference_search',
  'reference_search_debug',
];

/**
 * Every metered AI call rolls up into one user-facing operation.
 * Sub-steps (planner, designer, extract vision, …) are not reported separately.
 */
export function aiOperationCode(purpose: string | null | undefined): string {
  const value = (purpose || '').trim();
  if (
    value === 'course_extract' ||
    value === 'course_extract_text' ||
    value === 'course_extract_vision' ||
    value === 'course_clo_topic_matching'
  ) {
    return 'course_extraction';
  }
  if (
    value === 'slide_studio' ||
    value.startsWith('slide_studio_') ||
    value.startsWith('topic_') ||
    value.startsWith('assessment_')
  ) {
    return 'content_generation';
  }
  if (value.startsWith('grading_')) return 'grading';
  if (value === 'reference_relevance' || value.startsWith('reference_')) {
    return 'reference_check';
  }
  if (
    value === 'clo_analysis' ||
    value === 'clo_analysis_all' ||
    value === 'clo_analysis_stream' ||
    value === 'course_report_narrative'
  ) {
    return 'course_report';
  }
  return 'other';
}

const OPERATION_ORDER = [
  'content_generation',
  'course_extraction',
  'grading',
  'reference_check',
  'course_report',
  'other',
];

export type AiUsageSummary = {
  used: number;
  /** null = unlimited. */
  limit: number | null;
  periodStart: string;
  resetsAt: string;
};

export type AiUsageOperation = {
  code: string;
  tokens: number;
  lastAt: string | null;
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
            generationPlanCode: entry.generationPlanCode || null,
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

  /** This month's tokens summed by operation, with sub-steps already combined. */
  async operations(userId: number) {
    const summary = await this.summary(userId);
    const rows = await this.prisma.aiUsageLog.groupBy({
      by: ['purpose'],
      where: {
        userId,
        createdAt: { gte: new Date(summary.periodStart) },
        purpose: { notIn: UNMETERED_PURPOSES },
      },
      _sum: { totalTokens: true },
      _max: { createdAt: true },
    });
    const buckets = new Map<string, { tokens: number; lastAt: Date | null }>();
    for (const row of rows) {
      const code = aiOperationCode(row.purpose);
      const current = buckets.get(code) ?? { tokens: 0, lastAt: null };
      current.tokens += row._sum.totalTokens ?? 0;
      const at = row._max.createdAt;
      if (at && (!current.lastAt || at > current.lastAt)) current.lastAt = at;
      buckets.set(code, current);
    }
    const operations: AiUsageOperation[] = [...buckets.entries()]
      .map(([code, value]) => ({
        code,
        tokens: value.tokens,
        lastAt: value.lastAt ? value.lastAt.toISOString() : null,
      }))
      .sort(
        (a, b) =>
          OPERATION_ORDER.indexOf(a.code) - OPERATION_ORDER.indexOf(b.code) ||
          b.tokens - a.tokens,
      );
    return { ...summary, operations };
  }

  /** This month's metered AI calls for the signed-in user, newest first. */
  async listMine(userId: number, page = 1, limit = 20) {
    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    const safeLimit = Math.min(
      50,
      Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 20),
    );
    const where = {
      userId,
      createdAt: { gte: monthStart(new Date()) },
      purpose: { notIn: UNMETERED_PURPOSES },
    };
    const [total, data] = await Promise.all([
      this.prisma.aiUsageLog.count({ where }),
      this.prisma.aiUsageLog.findMany({
        where,
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          purpose: true,
          model: true,
          promptTokens: true,
          completionTokens: true,
          totalTokens: true,
          success: true,
          durationMs: true,
          startedAt: true,
          createdAt: true,
          generationPlanCode: true,
        },
      }),
    ]);
    return paginate(data, total, safePage, safeLimit);
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
