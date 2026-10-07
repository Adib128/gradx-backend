import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from 'generated/prisma/browser';
import { PrismaService } from 'prisma/prisma.service';
import { paginate } from 'src/common/helpers/paginate.helper';
import type {
  CreateBillingPeriodDto,
  CreatePackageDto,
  CreatePlanFeatureDto,
  UpdateBillingPeriodDto,
  UpdatePackageDto,
  UpdatePlanFeatureDto,
} from './dto/packages.dto';

const PACKAGE_INCLUDE = {
  prices: {
    include: { period: true },
    orderBy: { period: { sortOrder: 'asc' } },
  },
  featureValues: {
    include: { feature: true },
    orderBy: { feature: { sortOrder: 'asc' } },
  },
  _count: { select: { subscriptions: true } },
} satisfies Prisma.PlanInclude;

type PackageFeatureInput = NonNullable<CreatePackageDto['features']>[number];
type PackagePriceInput = NonNullable<CreatePackageDto['prices']>[number];
type Tx = Prisma.TransactionClient;

/** Legacy `plans` columns kept in sync with the matching feature values. */
const LEGACY_LIMIT_COLUMNS = {
  MAX_COURSES: 'maxCourses',
  MAX_ASSESSMENTS: 'maxAssessments',
  MAX_AI_REQUESTS: 'maxAiRequests',
} as const;

@Injectable()
export class AdminPackagesService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Packages ───────────────────────────────────────────────────────────

  async listPackages(query: { page?: number; limit?: number; search?: string }) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const search = query.search?.trim();
    const where: Prisma.PlanWhereInput = search
      ? {
          OR: [
            { code: { contains: search, mode: 'insensitive' } },
            { nameEn: { contains: search, mode: 'insensitive' } },
            { nameAr: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {};
    const [total, data] = await Promise.all([
      this.prisma.plan.count({ where }),
      this.prisma.plan.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
        include: PACKAGE_INCLUDE,
      }),
    ]);
    return paginate(data, total, page, limit);
  }

  async getPackage(id: number) {
    const plan = await this.prisma.plan.findUnique({
      where: { id },
      include: PACKAGE_INCLUDE,
    });
    if (!plan) throw new NotFoundException('PLAN_NOT_FOUND');
    return plan;
  }

  async createPackage(dto: CreatePackageDto) {
    await this.assertPlanCodeFree(dto.code);
    const features = await this.normalizeFeatures(dto.features ?? []);
    const prices = await this.normalizePrices(dto.prices ?? []);

    const id = await this.prisma.$transaction(async (tx) => {
      const plan = await tx.plan.create({
        data: {
          code: dto.code,
          nameEn: dto.nameEn,
          nameAr: dto.nameAr,
          descriptionEn: dto.descriptionEn || null,
          descriptionAr: dto.descriptionAr || null,
          currency: dto.currency ?? 'SAR',
          isActive: dto.isActive ?? true,
          sortOrder: dto.sortOrder ?? 0,
          featureValues: { create: features },
          prices: { create: prices },
        },
      });
      await this.syncLegacyColumns(tx, plan.id);
      return plan.id;
    });
    return this.getPackage(id);
  }

  async updatePackage(id: number, dto: UpdatePackageDto) {
    await this.getPackage(id);
    if (dto.code !== undefined) await this.assertPlanCodeFree(dto.code, id);
    const features =
      dto.features !== undefined ? await this.normalizeFeatures(dto.features) : undefined;
    const prices =
      dto.prices !== undefined ? await this.normalizePrices(dto.prices) : undefined;

    await this.prisma.$transaction(async (tx) => {
      await tx.plan.update({
        where: { id },
        data: {
          code: dto.code,
          nameEn: dto.nameEn,
          nameAr: dto.nameAr,
          descriptionEn:
            dto.descriptionEn === undefined ? undefined : dto.descriptionEn || null,
          descriptionAr:
            dto.descriptionAr === undefined ? undefined : dto.descriptionAr || null,
          currency: dto.currency,
          isActive: dto.isActive,
          sortOrder: dto.sortOrder,
        },
      });

      if (features) {
        await tx.planFeatureValue.deleteMany({
          where: { planId: id, featureId: { notIn: features.map((f) => f.featureId) } },
        });
        for (const feature of features) {
          await tx.planFeatureValue.upsert({
            where: { planId_featureId: { planId: id, featureId: feature.featureId } },
            create: { planId: id, ...feature },
            update: { enabled: feature.enabled, limitValue: feature.limitValue },
          });
        }
      }

      if (prices) {
        await tx.planPrice.deleteMany({
          where: { planId: id, periodId: { notIn: prices.map((p) => p.periodId) } },
        });
        for (const price of prices) {
          await tx.planPrice.upsert({
            where: { planId_periodId: { planId: id, periodId: price.periodId } },
            create: { planId: id, ...price },
            update: {
              price: price.price,
              compareAtPrice: price.compareAtPrice,
              isActive: price.isActive,
            },
          });
        }
      }

      await this.syncLegacyColumns(tx, id);
    });
    return this.getPackage(id);
  }

  async deletePackage(id: number) {
    const plan = await this.getPackage(id);
    if (plan._count.subscriptions > 0) {
      throw new ConflictException('PLAN_HAS_SUBSCRIPTIONS');
    }
    await this.prisma.plan.delete({ where: { id } });
    return { success: true };
  }

  // ── Billing periods ────────────────────────────────────────────────────

  listBillingPeriods() {
    return this.prisma.billingPeriod.findMany({
      orderBy: [{ sortOrder: 'asc' }, { durationMonths: 'asc' }],
      include: { _count: { select: { prices: true } } },
    });
  }

  async createBillingPeriod(dto: CreateBillingPeriodDto) {
    await this.assertPeriodCodeFree(dto.code);
    return this.prisma.billingPeriod.create({ data: dto });
  }

  async updateBillingPeriod(id: number, dto: UpdateBillingPeriodDto) {
    await this.findPeriod(id);
    if (dto.code !== undefined) await this.assertPeriodCodeFree(dto.code, id);
    const period = await this.prisma.billingPeriod.update({ where: { id }, data: dto });
    await this.resyncPlansUsingPeriod(id);
    return period;
  }

  async deleteBillingPeriod(id: number) {
    await this.findPeriod(id);
    const planIds = await this.planIdsWhere({ prices: { some: { periodId: id } } });
    await this.prisma.$transaction(async (tx) => {
      await tx.billingPeriod.delete({ where: { id } });
      for (const planId of planIds) await this.syncLegacyColumns(tx, planId);
    });
    return { success: true };
  }

  // ── Feature catalogue ──────────────────────────────────────────────────

  listPlanFeatures() {
    return this.prisma.planFeature.findMany({
      orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
      include: { _count: { select: { values: true } } },
    });
  }

  async createPlanFeature(dto: CreatePlanFeatureDto) {
    await this.assertFeatureKeyFree(dto.key);
    return this.prisma.planFeature.create({
      data: { ...dto, unitEn: dto.unitEn || null, unitAr: dto.unitAr || null },
    });
  }

  async updatePlanFeature(id: number, dto: UpdatePlanFeatureDto) {
    const existing = await this.findFeature(id);
    if (dto.key !== undefined) await this.assertFeatureKeyFree(dto.key, id);
    const feature = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.planFeature.update({
        where: { id },
        data: {
          ...dto,
          unitEn: dto.unitEn === undefined ? undefined : dto.unitEn || null,
          unitAr: dto.unitAr === undefined ? undefined : dto.unitAr || null,
        },
      });
      if (updated.type === 'BOOLEAN' && existing.type !== 'BOOLEAN') {
        await tx.planFeatureValue.updateMany({
          where: { featureId: id },
          data: { limitValue: null },
        });
      }
      return updated;
    });
    await this.resyncPlansUsingFeature(id);
    return feature;
  }

  async deletePlanFeature(id: number) {
    await this.findFeature(id);
    const planIds = await this.planIdsWhere({ featureValues: { some: { featureId: id } } });
    await this.prisma.$transaction(async (tx) => {
      await tx.planFeature.delete({ where: { id } });
      for (const planId of planIds) await this.syncLegacyColumns(tx, planId);
    });
    return { success: true };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private async normalizeFeatures(input: PackageFeatureInput[]) {
    const unique = new Map(input.map((item) => [item.featureId, item]));
    const catalogue = await this.prisma.planFeature.findMany({
      where: { id: { in: [...unique.keys()] } },
      select: { id: true, type: true },
    });
    if (catalogue.length !== unique.size) {
      throw new BadRequestException('PLAN_FEATURE_NOT_FOUND');
    }
    const typeById = new Map(catalogue.map((feature) => [feature.id, feature.type]));
    return [...unique.values()].map((item) => ({
      featureId: item.featureId,
      enabled: item.enabled,
      limitValue:
        typeById.get(item.featureId) === 'LIMIT' && item.enabled
          ? (item.limitValue ?? null)
          : null,
    }));
  }

  private async normalizePrices(input: PackagePriceInput[]) {
    const unique = new Map(input.map((item) => [item.periodId, item]));
    const count = await this.prisma.billingPeriod.count({
      where: { id: { in: [...unique.keys()] } },
    });
    if (count !== unique.size) {
      throw new BadRequestException('BILLING_PERIOD_NOT_FOUND');
    }
    return [...unique.values()].map((item) => ({
      periodId: item.periodId,
      price: item.price,
      compareAtPrice: item.compareAtPrice ?? null,
      isActive: item.isActive,
    }));
  }

  /**
   * Keeps `priceMonthly` and the legacy limit columns equal to the monthly
   * price and the MAX_* feature values, for screens that still read them.
   */
  private async syncLegacyColumns(tx: Tx, planId: number) {
    const plan = await tx.plan.findUnique({
      where: { id: planId },
      include: {
        prices: { include: { period: true } },
        featureValues: { include: { feature: true } },
      },
    });
    if (!plan) return;

    const monthly =
      plan.prices.find((price) => price.period.code === 'MONTHLY') ??
      plan.prices.find((price) => price.period.durationMonths === 1);

    const legacy: Partial<Record<(typeof LEGACY_LIMIT_COLUMNS)[keyof typeof LEGACY_LIMIT_COLUMNS], number | null>> = {};
    for (const [key, column] of Object.entries(LEGACY_LIMIT_COLUMNS)) {
      const value = plan.featureValues.find((item) => item.feature.key === key);
      legacy[column] = !value ? null : value.enabled ? value.limitValue : 0;
    }

    await tx.plan.update({
      where: { id: planId },
      data: { priceMonthly: monthly ? monthly.price : 0, ...legacy },
    });
  }

  private async resyncPlansUsingPeriod(periodId: number) {
    const planIds = await this.planIdsWhere({ prices: { some: { periodId } } });
    if (planIds.length === 0) return;
    await this.prisma.$transaction(async (tx) => {
      for (const planId of planIds) await this.syncLegacyColumns(tx, planId);
    });
  }

  private async resyncPlansUsingFeature(featureId: number) {
    const planIds = await this.planIdsWhere({ featureValues: { some: { featureId } } });
    if (planIds.length === 0) return;
    await this.prisma.$transaction(async (tx) => {
      for (const planId of planIds) await this.syncLegacyColumns(tx, planId);
    });
  }

  private async planIdsWhere(where: Prisma.PlanWhereInput) {
    const plans = await this.prisma.plan.findMany({ where, select: { id: true } });
    return plans.map((plan) => plan.id);
  }

  private async findPeriod(id: number) {
    const period = await this.prisma.billingPeriod.findUnique({ where: { id } });
    if (!period) throw new NotFoundException('BILLING_PERIOD_NOT_FOUND');
    return period;
  }

  private async findFeature(id: number) {
    const feature = await this.prisma.planFeature.findUnique({ where: { id } });
    if (!feature) throw new NotFoundException('PLAN_FEATURE_NOT_FOUND');
    return feature;
  }

  private async assertPlanCodeFree(code: string, exceptId?: number) {
    const existing = await this.prisma.plan.findFirst({
      where: { code, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (existing) throw new ConflictException('PLAN_CODE_EXISTS');
  }

  private async assertPeriodCodeFree(code: string, exceptId?: number) {
    const existing = await this.prisma.billingPeriod.findFirst({
      where: { code, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (existing) throw new ConflictException('BILLING_PERIOD_CODE_EXISTS');
  }

  private async assertFeatureKeyFree(key: string, exceptId?: number) {
    const existing = await this.prisma.planFeature.findFirst({
      where: { key, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (existing) throw new ConflictException('PLAN_FEATURE_KEY_EXISTS');
  }
}
