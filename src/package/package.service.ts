import { Injectable } from '@nestjs/common';
import { SubscriptionStatus } from 'generated/prisma/browser';
import { PrismaService } from 'prisma/prisma.service';

const toNumber = (value: unknown) => (value == null ? null : Number(value));

@Injectable()
export class PackageService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Active packages with their active prices and features, plus the billing
   * periods and feature catalogue they use, ready for pricing pages.
   */
  async getCatalogue() {
    const [plans, periods, features] = await Promise.all([
      this.prisma.plan.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
        include: {
          prices: {
            where: { isActive: true, period: { isActive: true } },
            orderBy: { period: { sortOrder: 'asc' } },
          },
          featureValues: {
            where: { feature: { isActive: true } },
            orderBy: { feature: { sortOrder: 'asc' } },
          },
        },
      }),
      this.prisma.billingPeriod.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { durationMonths: 'asc' }],
      }),
      this.prisma.planFeature.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
      }),
    ]);

    const usedPeriodIds = new Set(plans.flatMap((plan) => plan.prices.map((p) => p.periodId)));

    return {
      periods: periods
        .filter((period) => usedPeriodIds.has(period.id))
        .map((period) => ({
          id: period.id,
          code: period.code,
          nameEn: period.nameEn,
          nameAr: period.nameAr,
          durationMonths: period.durationMonths,
        })),
      features: features.map((feature) => ({
        id: feature.id,
        key: feature.key,
        nameEn: feature.nameEn,
        nameAr: feature.nameAr,
        type: feature.type,
        unitEn: feature.unitEn,
        unitAr: feature.unitAr,
      })),
      packages: plans.map((plan) => ({
        id: plan.id,
        code: plan.code,
        nameEn: plan.nameEn,
        nameAr: plan.nameAr,
        descriptionEn: plan.descriptionEn,
        descriptionAr: plan.descriptionAr,
        currency: plan.currency,
        prices: plan.prices.map((price) => ({
          periodId: price.periodId,
          price: Number(price.price),
          compareAtPrice: toNumber(price.compareAtPrice),
        })),
        features: plan.featureValues.map((value) => ({
          featureId: value.featureId,
          enabled: value.enabled,
          limitValue: value.limitValue,
        })),
      })),
    };
  }

  /** The tenant's current (active or trialing) subscription, if any. */
  async getCurrentSubscription(tenantId: number | null | undefined) {
    if (!tenantId) return null;
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        tenantId,
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] },
        OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }],
      },
      orderBy: { startsAt: 'desc' },
      include: { plan: { select: { id: true, code: true, nameEn: true, nameAr: true } } },
    });
    if (!subscription) return null;
    return {
      id: subscription.id,
      status: subscription.status,
      startsAt: subscription.startsAt,
      endsAt: subscription.endsAt,
      plan: subscription.plan,
    };
  }
}
