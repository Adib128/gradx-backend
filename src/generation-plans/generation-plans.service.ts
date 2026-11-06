import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from 'generated/prisma/browser';
import { PrismaService } from 'prisma/prisma.service';
import { ErrorMessageKey } from 'src/common/constants/error-message';
import { paginate } from 'src/common/helpers/paginate.helper';
import type {
  CreateGenerationPlanDto,
  UpdateGenerationPlanDto,
  UpdateGenerationPlanModelDto,
  UpsertGenerationPlanModelDto,
} from './dto/generation-plans.dto';
import {
  estimateStudioCostUsd,
  estimateStudioTokens,
  parseGenerationTier,
  STUDIO_REFERENCE_SLIDES,
} from './generation-plan.presets';
import type { PlanModelsMap } from './generation-plan.roles';

const PLAN_INCLUDE = {
  models: { orderBy: { role: 'asc' as const } },
} satisfies Prisma.GenerationPlanInclude;

@Injectable()
export class GenerationPlansService {
  constructor(private readonly prisma: PrismaService) {}

  /** Active plans for the instructor picker (cards). Token/cost estimates follow slide count. */
  async listActive(slideCount = STUDIO_REFERENCE_SLIDES) {
    const plans = await this.prisma.generationPlan.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
      include: {
        models: {
          orderBy: { role: 'asc' },
          select: {
            id: true,
            role: true,
            model: true,
            fallbackModels: true,
            maxTokens: true,
            reasoningTokens: true,
          },
        },
      },
    });
    const slides = Number.isFinite(slideCount) ? slideCount : STUDIO_REFERENCE_SLIDES;
    return plans.map((plan) => {
      const tier = parseGenerationTier(plan.code);
      const estimatedTokens = tier
        ? estimateStudioTokens(tier, slides)
        : plan.estimatedTokens;
      const cost = estimateStudioCostUsd(plan.code, slides);
      return {
        ...plan,
        estimatedTokens,
        referenceSlideCount: STUDIO_REFERENCE_SLIDES,
        estimatedCostUsdMin: cost?.min ?? null,
        estimatedCostUsdMax: cost?.max ?? null,
      };
    });
  }

  async listAdmin(query: { page?: number; limit?: number; search?: string }) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const search = query.search?.trim();
    const where: Prisma.GenerationPlanWhereInput = search
      ? {
          OR: [
            { code: { contains: search, mode: 'insensitive' } },
            { nameEn: { contains: search, mode: 'insensitive' } },
            { nameAr: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {};
    const [total, data] = await Promise.all([
      this.prisma.generationPlan.count({ where }),
      this.prisma.generationPlan.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
        include: PLAN_INCLUDE,
      }),
    ]);
    return paginate(data, total, page, limit);
  }

  async getById(id: number) {
    const plan = await this.prisma.generationPlan.findUnique({
      where: { id },
      include: PLAN_INCLUDE,
    });
    if (!plan) throw new NotFoundException(ErrorMessageKey.GENERATION_PLAN_NOT_FOUND);
    return plan;
  }

  async getByCode(code: string) {
    const plan = await this.prisma.generationPlan.findUnique({
      where: { code: code.toUpperCase() },
      include: PLAN_INCLUDE,
    });
    if (!plan) throw new NotFoundException(ErrorMessageKey.GENERATION_PLAN_NOT_FOUND);
    return plan;
  }

  /** Resolve model overrides for a plan id, or MEDIUM / first active as fallback. */
  async resolveModels(planId?: number | null): Promise<{
    planId: number | null;
    code: string | null;
    models: PlanModelsMap;
  }> {
    const plan = planId
      ? await this.prisma.generationPlan.findFirst({
          where: { id: planId, isActive: true },
          include: { models: true },
        })
      : await this.prisma.generationPlan.findFirst({
          where: { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          include: { models: true },
        });

    if (!plan) {
      return { planId: null, code: null, models: {} };
    }

    const models: PlanModelsMap = {};
    for (const row of plan.models) {
      const fallbacks = Array.isArray(row.fallbackModels)
        ? (row.fallbackModels as unknown[]).filter(
            (value): value is string => typeof value === 'string' && value.trim().length > 0,
          )
        : [];
      models[row.role as keyof PlanModelsMap] = {
        model: row.model,
        fallbackModels: fallbacks,
        maxTokens: row.maxTokens,
        reasoningTokens: row.reasoningTokens,
      };
    }
    return { planId: plan.id, code: plan.code, models };
  }

  async create(dto: CreateGenerationPlanDto) {
    await this.assertCodeFree(dto.code);
    this.assertUniqueRoles(dto.models);
    const plan = await this.prisma.generationPlan.create({
      data: {
        code: dto.code,
        nameEn: dto.nameEn,
        nameAr: dto.nameAr,
        descriptionEn: dto.descriptionEn || null,
        descriptionAr: dto.descriptionAr || null,
        qualityLabelEn: dto.qualityLabelEn,
        qualityLabelAr: dto.qualityLabelAr,
        estimatedTokens: dto.estimatedTokens ?? 0,
        isActive: dto.isActive ?? true,
        sortOrder: dto.sortOrder ?? 0,
        models: {
          create: (dto.models ?? []).map((model) => ({
            role: model.role,
            model: model.model,
            fallbackModels: model.fallbackModels ?? [],
            maxTokens: model.maxTokens ?? null,
            reasoningTokens: model.reasoningTokens ?? null,
          })),
        },
      },
      include: PLAN_INCLUDE,
    });
    return plan;
  }

  async update(id: number, dto: UpdateGenerationPlanDto) {
    await this.getById(id);
    if (dto.code !== undefined) await this.assertCodeFree(dto.code, id);
    if (dto.models !== undefined) this.assertUniqueRoles(dto.models);

    return this.prisma.$transaction(async (tx) => {
      await tx.generationPlan.update({
        where: { id },
        data: {
          code: dto.code,
          nameEn: dto.nameEn,
          nameAr: dto.nameAr,
          descriptionEn:
            dto.descriptionEn === undefined ? undefined : dto.descriptionEn || null,
          descriptionAr:
            dto.descriptionAr === undefined ? undefined : dto.descriptionAr || null,
          qualityLabelEn: dto.qualityLabelEn,
          qualityLabelAr: dto.qualityLabelAr,
          estimatedTokens: dto.estimatedTokens,
          isActive: dto.isActive,
          sortOrder: dto.sortOrder,
        },
      });

      if (dto.models !== undefined) {
        await tx.generationPlanModel.deleteMany({ where: { planId: id } });
        if (dto.models.length) {
          await tx.generationPlanModel.createMany({
            data: dto.models.map((model) => ({
              planId: id,
              role: model.role,
              model: model.model,
              fallbackModels: model.fallbackModels ?? [],
              maxTokens: model.maxTokens ?? null,
              reasoningTokens: model.reasoningTokens ?? null,
            })),
          });
        }
      }

      return tx.generationPlan.findUniqueOrThrow({
        where: { id },
        include: PLAN_INCLUDE,
      });
    });
  }

  async remove(id: number) {
    await this.getById(id);
    await this.prisma.generationPlan.delete({ where: { id } });
    return { id, deleted: true };
  }

  async upsertModel(planId: number, dto: UpsertGenerationPlanModelDto) {
    await this.getById(planId);
    return this.prisma.generationPlanModel.upsert({
      where: { planId_role: { planId, role: dto.role } },
      create: {
        planId,
        role: dto.role,
        model: dto.model,
        fallbackModels: dto.fallbackModels ?? [],
        maxTokens: dto.maxTokens ?? null,
        reasoningTokens: dto.reasoningTokens ?? null,
      },
      update: {
        model: dto.model,
        fallbackModels: dto.fallbackModels ?? [],
        maxTokens: dto.maxTokens ?? null,
        reasoningTokens: dto.reasoningTokens ?? null,
      },
    });
  }

  async updateModel(planId: number, modelId: number, dto: UpdateGenerationPlanModelDto) {
    const row = await this.prisma.generationPlanModel.findFirst({
      where: { id: modelId, planId },
    });
    if (!row) throw new NotFoundException(ErrorMessageKey.GENERATION_PLAN_MODEL_NOT_FOUND);
    return this.prisma.generationPlanModel.update({
      where: { id: modelId },
      data: {
        model: dto.model,
        fallbackModels: dto.fallbackModels,
        maxTokens: dto.maxTokens === undefined ? undefined : dto.maxTokens,
        reasoningTokens: dto.reasoningTokens === undefined ? undefined : dto.reasoningTokens,
      },
    });
  }

  async removeModel(planId: number, modelId: number) {
    const row = await this.prisma.generationPlanModel.findFirst({
      where: { id: modelId, planId },
    });
    if (!row) throw new NotFoundException(ErrorMessageKey.GENERATION_PLAN_MODEL_NOT_FOUND);
    await this.prisma.generationPlanModel.delete({ where: { id: modelId } });
    return { id: modelId, deleted: true };
  }

  private async assertCodeFree(code: string, excludeId?: number) {
    const existing = await this.prisma.generationPlan.findUnique({ where: { code } });
    if (existing && existing.id !== excludeId) {
      throw new ConflictException(ErrorMessageKey.GENERATION_PLAN_CODE_TAKEN);
    }
  }

  private assertUniqueRoles(models: Array<{ role: string }>) {
    const seen = new Set<string>();
    for (const model of models) {
      if (seen.has(model.role)) {
        throw new BadRequestException(ErrorMessageKey.GENERATION_PLAN_ROLE_DUPLICATE);
      }
      seen.add(model.role);
    }
  }
}
