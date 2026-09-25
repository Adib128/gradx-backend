import { Module, OnModuleInit } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { PrismaService } from 'prisma/prisma.service';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { setAiUsageLogger } from 'src/common/helpers/openrouter-chat.helper';

@Module({
  controllers: [AdminController],
  providers: [AdminService, RolesGuard],
  exports: [AdminService],
})
export class AdminModule implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

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
      }
    });
  }
}
