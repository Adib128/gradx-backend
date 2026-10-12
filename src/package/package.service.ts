import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SubscriptionStatus } from 'generated/prisma/browser';
import { PrismaService } from 'prisma/prisma.service';
import { AiUsageService } from 'src/ai-usage/ai-usage.service';
import type { RenewDto, SubscribeDto } from './dto/subscribe.dto';

const toNumber = (value: unknown) => (value == null ? null : Number(value));

const GRANTING = [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING];

/** Subscriptions that currently grant their package. */
export const activeSubscriptionWhere = (): Prisma.SubscriptionWhereInput => {
  const now = new Date();
  return {
    status: { in: GRANTING },
    startsAt: { lte: now },
    OR: [{ endsAt: null }, { endsAt: { gt: now } }],
  };
};

const SUBSCRIPTION_INCLUDE = {
  plan: {
    select: {
      id: true,
      code: true,
      nameEn: true,
      nameAr: true,
      isFree: true,
      isActive: true,
      aiTokenLimit: true,
      currency: true,
    },
  },
  period: { select: { id: true, code: true, nameEn: true, nameAr: true, durationMonths: true } },
} satisfies Prisma.SubscriptionInclude;

type SubscriptionRow = Prisma.SubscriptionGetPayload<{ include: typeof SUBSCRIPTION_INCLUDE }>;

const toView = (row: SubscriptionRow) => ({
  id: row.id,
  status: row.status,
  amount: toNumber(row.amount),
  currency: row.currency,
  startsAt: row.startsAt,
  endsAt: row.endsAt,
  isRenewal: row.renewalOfId !== null,
  plan: row.plan,
  period: row.period,
});

const addMonths = (date: Date, months: number) => {
  const result = new Date(date);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
};

@Injectable()
export class PackageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiUsage: AiUsageService,
  ) {}

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

    const anyFree = plans.some((plan) => plan.isFree);
    const usedPeriodIds = new Set(plans.flatMap((plan) => plan.prices.map((p) => p.periodId)));

    return {
      periods: periods
        .filter((period) => anyFree || usedPeriodIds.has(period.id))
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
        isFree: plan.isFree,
        aiTokenLimit: plan.aiTokenLimit,
        prices: plan.isFree
          ? []
          : plan.prices.map((price) => ({
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
      where: { tenantId, ...activeSubscriptionWhere() },
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

  /**
   * Chooses a package for the user's tenant. Free packages start right away and
   * apply their token allowance; paid ones wait for payment.
   */
  async subscribe(user: { userId: number; tenantId: number }, dto: SubscribeDto) {
    const [plan, period] = await Promise.all([
      this.prisma.plan.findFirst({
        where: { id: dto.planId, isActive: true },
        include: { prices: { where: { periodId: dto.periodId, isActive: true } } },
      }),
      this.prisma.billingPeriod.findFirst({ where: { id: dto.periodId, isActive: true } }),
    ]);
    if (!plan) throw new NotFoundException('PLAN_NOT_FOUND');
    if (!period) throw new BadRequestException('BILLING_PERIOD_NOT_FOUND');
    const price = plan.prices[0];
    if (!plan.isFree && !price) throw new BadRequestException('PLAN_PERIOD_UNAVAILABLE');

    const now = new Date();
    const replaced: SubscriptionStatus[] = plan.isFree
      ? [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING, SubscriptionStatus.PENDING_PAYMENT]
      : [SubscriptionStatus.PENDING_PAYMENT];

    const subscription = await this.prisma.$transaction(async (tx) => {
      await tx.subscription.updateMany({
        where: { tenantId: user.tenantId, status: { in: replaced } },
        data: { status: SubscriptionStatus.CANCELED, canceledAt: now },
      });
      const created = await tx.subscription.create({
        data: {
          tenantId: user.tenantId,
          userId: user.userId,
          planId: plan.id,
          periodId: period.id,
          status: plan.isFree ? SubscriptionStatus.ACTIVE : SubscriptionStatus.PENDING_PAYMENT,
          amount: plan.isFree ? 0 : price.price,
          currency: plan.currency,
          startsAt: now,
          endsAt: plan.isFree ? addMonths(now, period.durationMonths) : null,
        },
      });
      if (plan.isFree) {
        await tx.user.update({
          where: { id: user.userId },
          data: { aiTokenLimit: plan.aiTokenLimit },
        });
      }
      return created;
    });

    if (plan.isFree) void this.aiUsage.publish(user.userId);
    return {
      subscriptionId: subscription.id,
      status: subscription.status,
      requiresPayment: !plan.isFree,
    };
  }

  /** One of the tenant's subscriptions, with what is needed to pay for it. */
  async getSubscription(tenantId: number, id: number) {
    const subscription = await this.prisma.subscription.findFirst({
      where: { id, tenantId },
      include: SUBSCRIPTION_INCLUDE,
    });
    if (!subscription) throw new NotFoundException('SUBSCRIPTION_NOT_FOUND');
    return toView(subscription);
  }

  /**
   * What the tenant has now, the next period already booked after it, and an
   * order still waiting for payment.
   */
  async getMine(tenantId: number) {
    const now = new Date();
    const [current, upcoming, pending] = await Promise.all([
      this.prisma.subscription.findFirst({
        where: { tenantId, ...activeSubscriptionWhere() },
        orderBy: { startsAt: 'desc' },
        include: SUBSCRIPTION_INCLUDE,
      }),
      this.prisma.subscription.findFirst({
        where: { tenantId, status: { in: GRANTING }, startsAt: { gt: now } },
        orderBy: { startsAt: 'asc' },
        include: SUBSCRIPTION_INCLUDE,
      }),
      this.prisma.subscription.findFirst({
        where: { tenantId, status: SubscriptionStatus.PENDING_PAYMENT },
        orderBy: { createdAt: 'desc' },
        include: SUBSCRIPTION_INCLUDE,
      }),
    ]);
    return {
      current: current && toView(current),
      upcoming: upcoming && toView(upcoming),
      pending: pending && toView(pending),
    };
  }

  /**
   * Books one more period of the current package after it ends: right away when
   * the package is free, otherwise as an order waiting for payment.
   */
  async renew(user: { userId: number; tenantId: number }, dto: RenewDto) {
    const now = new Date();
    const current = await this.prisma.subscription.findFirst({
      where: { tenantId: user.tenantId, ...activeSubscriptionWhere() },
      orderBy: { startsAt: 'desc' },
      include: {
        plan: { include: { prices: { where: { periodId: dto.periodId, isActive: true } } } },
      },
    });
    if (!current) throw new BadRequestException('SUBSCRIPTION_NONE_ACTIVE');
    if (!current.endsAt) throw new BadRequestException('SUBSCRIPTION_NO_END');
    if (!current.plan.isActive) throw new BadRequestException('PLAN_NO_LONGER_OFFERED');

    const upcoming = await this.prisma.subscription.count({
      where: { tenantId: user.tenantId, status: { in: GRANTING }, startsAt: { gt: now } },
    });
    if (upcoming > 0) throw new ConflictException('SUBSCRIPTION_ALREADY_RENEWED');

    const period = await this.prisma.billingPeriod.findFirst({
      where: { id: dto.periodId, isActive: true },
    });
    if (!period) throw new BadRequestException('BILLING_PERIOD_NOT_FOUND');
    const { plan } = current;
    const price = plan.prices[0];
    if (!plan.isFree && !price) throw new BadRequestException('PLAN_PERIOD_UNAVAILABLE');

    const order = await this.prisma.$transaction(async (tx) => {
      if (!plan.isFree) {
        await tx.subscription.updateMany({
          where: { tenantId: user.tenantId, status: SubscriptionStatus.PENDING_PAYMENT },
          data: { status: SubscriptionStatus.CANCELED, canceledAt: now },
        });
      }
      return tx.subscription.create({
        data: {
          tenantId: user.tenantId,
          userId: user.userId,
          planId: plan.id,
          periodId: period.id,
          renewalOfId: current.id,
          status: plan.isFree ? SubscriptionStatus.ACTIVE : SubscriptionStatus.PENDING_PAYMENT,
          amount: plan.isFree ? 0 : price.price,
          currency: plan.currency,
          startsAt: plan.isFree ? current.endsAt! : now,
          endsAt: plan.isFree ? addMonths(current.endsAt!, period.durationMonths) : null,
        },
      });
    });

    return {
      subscriptionId: order.id,
      status: order.status,
      requiresPayment: !plan.isFree,
    };
  }

  /** Drops an order the user no longer wants to pay for. */
  async cancelOrder(tenantId: number, id: number) {
    const order = await this.prisma.subscription.findFirst({ where: { id, tenantId } });
    if (!order) throw new NotFoundException('SUBSCRIPTION_NOT_FOUND');
    if (order.status !== SubscriptionStatus.PENDING_PAYMENT) {
      throw new BadRequestException('SUBSCRIPTION_NOT_PENDING');
    }
    await this.prisma.subscription.update({
      where: { id },
      data: { status: SubscriptionStatus.CANCELED, canceledAt: new Date() },
    });
    return { success: true };
  }

  /**
   * Turns a paid order into an active subscription. A renewal starts when the
   * period it extends ends; a package change replaces the current package now
   * and applies its token allowance.
   */
  async activateOrder(id: number) {
    const order = await this.prisma.subscription.findUnique({
      where: { id },
      include: { plan: true, period: true, renewalOf: true },
    });
    if (!order) throw new NotFoundException('SUBSCRIPTION_NOT_FOUND');
    if (order.status !== SubscriptionStatus.PENDING_PAYMENT) {
      throw new BadRequestException('SUBSCRIPTION_NOT_PENDING');
    }

    const now = new Date();
    const extended = order.renewalOf;
    const isRenewal = Boolean(extended && GRANTING.some((status) => status === extended.status));
    const startsAt =
      isRenewal && extended?.endsAt && extended.endsAt > now ? extended.endsAt : now;
    const endsAt = addMonths(startsAt, order.period?.durationMonths ?? 1);

    await this.prisma.$transaction(async (tx) => {
      if (!isRenewal) {
        await tx.subscription.updateMany({
          where: { tenantId: order.tenantId, status: { in: GRANTING }, id: { not: id } },
          data: { status: SubscriptionStatus.CANCELED, canceledAt: now },
        });
        if (order.userId) {
          await tx.user.update({
            where: { id: order.userId },
            data: { aiTokenLimit: order.plan.aiTokenLimit },
          });
        }
      }
      await tx.subscription.update({
        where: { id },
        data: { status: SubscriptionStatus.ACTIVE, startsAt, endsAt },
      });
    });

    if (!isRenewal && order.userId) void this.aiUsage.publish(order.userId);
  }
}
