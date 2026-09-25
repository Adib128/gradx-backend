import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SubscriptionStatus, UserRole } from 'generated/prisma/browser';
import { PrismaService } from 'prisma/prisma.service';
import { paginate } from 'src/common/helpers/paginate.helper';
import { ErrorMessageKey } from 'src/common/constants/error-message';
import * as argon2 from 'argon2';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, extname } from 'path';
import { randomBytes } from 'crypto';

type PageQuery = {
  page?: number;
  limit?: number;
  search?: string;
};

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  private pageLimit(query: PageQuery) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    return { page, limit, skip: (page - 1) * limit };
  }

  async dashboard() {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const days = 14;
    const rangeStart = new Date(startOfToday);
    rangeStart.setDate(rangeStart.getDate() - (days - 1));

    const [
      users,
      activeUsers,
      courses,
      assessments,
      universities,
      subscriptionsActive,
      aiToday,
      loginsToday,
      recentAi,
      recentUsers,
      recentLogins,
      recentAiAll,
      recentCourses,
      recentAssessments,
    ] = await Promise.all([
      this.prisma.user.count({
        where: { role: { notIn: [UserRole.SUPER_ADMIN, UserRole.ADMIN] } },
      }),
      this.prisma.user.count({
        where: {
          isActive: true,
          role: { notIn: [UserRole.SUPER_ADMIN, UserRole.ADMIN] },
        },
      }),
      this.prisma.course.count({ where: { deletedAt: null } }),
      this.prisma.assessment.count(),
      this.prisma.university.count(),
      this.prisma.subscription.count({
        where: { status: SubscriptionStatus.ACTIVE },
      }),
      this.prisma.aiUsageLog.count({
        where: { createdAt: { gte: startOfToday } },
      }),
      this.prisma.loginLog.count({
        where: { success: true, createdAt: { gte: startOfToday } },
      }),
      this.prisma.aiUsageLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: {
          id: true,
          purpose: true,
          model: true,
          success: true,
          totalTokens: true,
          createdAt: true,
          user: { select: { id: true, email: true } },
        },
      }),
      this.prisma.user.findMany({
        where: {
          createdAt: { gte: rangeStart },
          role: { notIn: [UserRole.SUPER_ADMIN, UserRole.ADMIN] },
        },
        select: { createdAt: true },
      }),
      this.prisma.loginLog.findMany({
        where: { success: true, createdAt: { gte: rangeStart } },
        select: { createdAt: true },
      }),
      this.prisma.aiUsageLog.findMany({
        where: { createdAt: { gte: rangeStart } },
        select: { createdAt: true, success: true, totalTokens: true },
      }),
      this.prisma.course.findMany({
        where: { createdAt: { gte: rangeStart }, deletedAt: null },
        select: { createdAt: true },
      }),
      this.prisma.assessment.findMany({
        where: { createdAt: { gte: rangeStart } },
        select: { createdAt: true },
      }),
    ]);

    const dayKeys: string[] = [];
    for (let i = 0; i < days; i += 1) {
      const d = new Date(rangeStart);
      d.setDate(rangeStart.getDate() + i);
      dayKeys.push(d.toISOString().slice(0, 10));
    }

    const bump = (
      map: Map<string, number>,
      date: Date,
      amount = 1,
    ) => {
      const key = date.toISOString().slice(0, 10);
      map.set(key, (map.get(key) || 0) + amount);
    };

    const signupsMap = new Map<string, number>();
    const loginsMap = new Map<string, number>();
    const aiMap = new Map<string, number>();
    const aiFailMap = new Map<string, number>();
    const coursesMap = new Map<string, number>();
    const assessmentsMap = new Map<string, number>();

    recentUsers.forEach((row) => bump(signupsMap, row.createdAt));
    recentLogins.forEach((row) => bump(loginsMap, row.createdAt));
    recentAiAll.forEach((row) => {
      bump(aiMap, row.createdAt);
      if (!row.success) bump(aiFailMap, row.createdAt);
    });
    recentCourses.forEach((row) => bump(coursesMap, row.createdAt));
    recentAssessments.forEach((row) => bump(assessmentsMap, row.createdAt));

    const charts = {
      days: dayKeys,
      signups: dayKeys.map((d) => signupsMap.get(d) || 0),
      logins: dayKeys.map((d) => loginsMap.get(d) || 0),
      aiRequests: dayKeys.map((d) => aiMap.get(d) || 0),
      aiFailures: dayKeys.map((d) => aiFailMap.get(d) || 0),
      courses: dayKeys.map((d) => coursesMap.get(d) || 0),
      assessments: dayKeys.map((d) => assessmentsMap.get(d) || 0),
    };

    return {
      kpis: {
        users,
        activeUsers,
        courses,
        assessments,
        universities,
        subscriptionsActive,
        aiRequestsToday: aiToday,
        loginsToday,
      },
      recentAi,
      charts,
    };
  }

  private nonAdminFilter(): Prisma.UserWhereInput {
    return { role: { notIn: [UserRole.SUPER_ADMIN, UserRole.ADMIN] } };
  }

  async listUsers(query: PageQuery & { role?: string; isActive?: string }) {
    const { page, limit, skip } = this.pageLimit(query);
    const search = query.search?.trim();
    const where: Prisma.UserWhereInput = {
      ...this.nonAdminFilter(),
    };
    if (search) {
      where.AND = [
        this.nonAdminFilter(),
        {
          OR: [
            { email: { contains: search, mode: 'insensitive' } },
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search, mode: 'insensitive' } },
          ],
        },
      ];
      delete (where as { role?: unknown }).role;
    }
    if (query.role === UserRole.USER) {
      where.role = UserRole.USER;
    }
    if (query.isActive === 'true') where.isActive = true;
    if (query.isActive === 'false') where.isActive = false;

    const [total, users] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          role: true,
          isActive: true,
          isVerified: true,
          tenantId: true,
          lastLogin: true,
          createdAt: true,
          authProvider: true,
          _count: {
            select: { loginLogs: true, aiUsageLogs: true, subscriptions: true },
          },
        },
      }),
    ]);

    const tenantIds = [...new Set(users.map((u) => u.tenantId))];
    const [courseCounts, assessmentCounts] =
      tenantIds.length === 0
        ? [[], []]
        : await Promise.all([
            this.prisma.course.groupBy({
              by: ['tenantId'],
              where: { tenantId: { in: tenantIds }, deletedAt: null },
              _count: { _all: true },
            }),
            this.prisma.assessment.groupBy({
              by: ['tenantId'],
              where: { tenantId: { in: tenantIds } },
              _count: { _all: true },
            }),
          ]);
    const courseMap = new Map(
      courseCounts.map((row) => [row.tenantId, row._count._all]),
    );
    const assessmentMap = new Map(
      assessmentCounts.map((row) => [row.tenantId, row._count._all]),
    );

    const data = users.map(({ _count, ...user }) => ({
      ...user,
      loginCount: _count.loginLogs,
      aiRequestCount: _count.aiUsageLogs,
      subscriptionCount: _count.subscriptions,
      courseCount: courseMap.get(user.tenantId) || 0,
      assessmentCount: assessmentMap.get(user.tenantId) || 0,
    }));

    return paginate(data, total, page, limit);
  }

  async getUserDetail(id: number) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        isActive: true,
        isVerified: true,
        tenantId: true,
        lastLogin: true,
        createdAt: true,
        updatedAt: true,
        authProvider: true,
        universityName: true,
        fieldName: true,
      },
    });
    if (!user) throw new NotFoundException(ErrorMessageKey.USER_NOT_FOUND);
    if (user.role === UserRole.SUPER_ADMIN || user.role === UserRole.ADMIN) {
      throw new NotFoundException(ErrorMessageKey.USER_NOT_FOUND);
    }

    const [
      loginCount,
      aiCount,
      aiTokens,
      courseCount,
      assessmentCount,
      recentLogins,
      recentAi,
      subscriptions,
    ] = await Promise.all([
      this.prisma.loginLog.count({
        where: { userId: id, success: true },
      }),
      this.prisma.aiUsageLog.count({ where: { userId: id } }),
      this.prisma.aiUsageLog.aggregate({
        where: { userId: id },
        _sum: { totalTokens: true },
      }),
      this.prisma.course.count({
        where: { tenantId: user.tenantId, deletedAt: null },
      }),
      this.prisma.assessment.count({ where: { tenantId: user.tenantId } }),
      this.prisma.loginLog.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.aiUsageLog.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          purpose: true,
          model: true,
          success: true,
          totalTokens: true,
          durationMs: true,
          errorMessage: true,
          createdAt: true,
          requestPreview: true,
          responsePreview: true,
        },
      }),
      this.prisma.subscription.findMany({
        where: { OR: [{ userId: id }, { tenantId: user.tenantId }] },
        include: { plan: true },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    return {
      user,
      kpis: {
        loginCount,
        aiRequestCount: aiCount,
        aiTokenSum: aiTokens._sum.totalTokens || 0,
        courseCount,
        assessmentCount,
      },
      recentLogins,
      recentAi,
      subscriptions,
    };
  }

  async updateUser(
    id: number,
    body: {
      role?: UserRole;
      isActive?: boolean;
      firstName?: string;
      lastName?: string;
      phone?: string | null;
    },
  ) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException(ErrorMessageKey.USER_NOT_FOUND);
    if (user.role === UserRole.SUPER_ADMIN) {
      throw new BadRequestException(ErrorMessageKey.VALIDATION_FAILED);
    }
    return this.prisma.user.update({
      where: { id },
      data: {
        role: body.role === UserRole.SUPER_ADMIN ? undefined : body.role,
        isActive: body.isActive,
        firstName: body.firstName,
        lastName: body.lastName,
        phone: body.phone === undefined ? undefined : body.phone,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        isActive: true,
        tenantId: true,
        lastLogin: true,
      },
    });
  }

  async listUniversities(query: PageQuery) {
    const { page, limit, skip } = this.pageLimit(query);
    const search = query.search?.trim();
    const where: Prisma.UniversityWhereInput = search
      ? {
          OR: [
            { code: { contains: search, mode: 'insensitive' } },
            { nameEn: { contains: search, mode: 'insensitive' } },
            { nameAr: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {};
    const [total, data] = await Promise.all([
      this.prisma.university.count({ where }),
      this.prisma.university.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
      }),
    ]);
    return paginate(data, total, page, limit);
  }

  async createUniversity(body: {
    code: string;
    nameEn: string;
    nameAr: string;
    website?: string;
    sortOrder?: number;
    faculties?: unknown;
  }) {
    const code = body.code.trim().toLowerCase();
    if (!code || !body.nameEn?.trim() || !body.nameAr?.trim()) {
      throw new BadRequestException(ErrorMessageKey.VALIDATION_FAILED);
    }
    return this.prisma.university.create({
      data: {
        code,
        nameEn: body.nameEn.trim(),
        nameAr: body.nameAr.trim(),
        website: body.website || null,
        sortOrder: body.sortOrder ?? 0,
        faculties: (body.faculties as Prisma.InputJsonValue) ?? [],
      },
    });
  }

  async updateUniversity(
    id: number,
    body: {
      code?: string;
      nameEn?: string;
      nameAr?: string;
      website?: string | null;
      sortOrder?: number;
      faculties?: unknown;
      logoUrl?: string | null;
    },
  ) {
    const existing = await this.prisma.university.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('UNIVERSITY_NOT_FOUND');
    return this.prisma.university.update({
      where: { id },
      data: {
        code: body.code?.trim().toLowerCase(),
        nameEn: body.nameEn?.trim(),
        nameAr: body.nameAr?.trim(),
        website: body.website,
        sortOrder: body.sortOrder,
        faculties:
          body.faculties === undefined
            ? undefined
            : (body.faculties as Prisma.InputJsonValue),
        logoUrl: body.logoUrl,
      },
    });
  }

  async deleteUniversity(id: number) {
    await this.prisma.university.delete({ where: { id } });
    return { success: true };
  }

  async uploadUniversityLogo(id: number, file: Express.Multer.File) {
    const university = await this.prisma.university.findUnique({ where: { id } });
    if (!university) throw new NotFoundException('UNIVERSITY_NOT_FOUND');
    if (!file?.buffer?.length) {
      throw new BadRequestException(ErrorMessageKey.VALIDATION_FAILED);
    }

    const allowed = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif'];
    const ext = extname(file.originalname || '').toLowerCase() || '.png';
    if (!allowed.includes(ext)) {
      throw new BadRequestException(ErrorMessageKey.VALIDATION_FAILED);
    }

    const dir = join(process.cwd(), 'public', 'universities');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const filename = `${university.code}${ext}`;
    writeFileSync(join(dir, filename), file.buffer);
    const logoUrl = `/universities/${filename}?v=${randomBytes(3).toString('hex')}`;
    return this.prisma.university.update({
      where: { id },
      data: { logoUrl },
    });
  }

  /** Flatten faculties across universities for admin faculty manager. */
  async listFaculties(query: PageQuery) {
    const universities = await this.prisma.university.findMany({
      orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
      select: { id: true, code: true, nameEn: true, nameAr: true, faculties: true },
    });
    const search = query.search?.trim().toLowerCase() || '';
    const rows: Array<{
      universityId: number;
      universityCode: string;
      universityNameEn: string;
      universityNameAr: string;
      facultyId: string;
      en: string;
      ar: string;
    }> = [];

    for (const uni of universities) {
      const faculties = Array.isArray(uni.faculties) ? uni.faculties : [];
      for (const raw of faculties) {
        const faculty = raw as { id?: string; en?: string; ar?: string };
        const en = String(faculty.en || '');
        const ar = String(faculty.ar || '');
        const facultyId = String(faculty.id || '');
        if (
          search &&
          !en.toLowerCase().includes(search) &&
          !ar.includes(search) &&
          !uni.code.includes(search) &&
          !uni.nameEn.toLowerCase().includes(search)
        ) {
          continue;
        }
        rows.push({
          universityId: uni.id,
          universityCode: uni.code,
          universityNameEn: uni.nameEn,
          universityNameAr: uni.nameAr,
          facultyId,
          en,
          ar,
        });
      }
    }

    const { page, limit } = this.pageLimit(query);
    const total = rows.length;
    const start = (page - 1) * limit;
    return paginate(rows.slice(start, start + limit), total, page, limit);
  }

  async upsertFaculty(
    universityId: number,
    body: { facultyId?: string; en: string; ar: string },
  ) {
    const university = await this.prisma.university.findUnique({
      where: { id: universityId },
    });
    if (!university) throw new NotFoundException('UNIVERSITY_NOT_FOUND');
    const faculties = Array.isArray(university.faculties)
      ? [...(university.faculties as Array<{ id: string; en: string; ar: string }>)]
      : [];
    const id =
      body.facultyId?.trim() ||
      body.en
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') ||
      `faculty-${Date.now()}`;
    const idx = faculties.findIndex((f) => f.id === id);
    const next = { id, en: body.en.trim(), ar: body.ar.trim() };
    if (idx >= 0) faculties[idx] = next;
    else faculties.push(next);
    return this.prisma.university.update({
      where: { id: universityId },
      data: { faculties },
    });
  }

  async deleteFaculty(universityId: number, facultyId: string) {
    const university = await this.prisma.university.findUnique({
      where: { id: universityId },
    });
    if (!university) throw new NotFoundException('UNIVERSITY_NOT_FOUND');
    const faculties = (
      Array.isArray(university.faculties)
        ? (university.faculties as Array<{ id: string }>)
        : []
    ).filter((f) => f.id !== facultyId);
    return this.prisma.university.update({
      where: { id: universityId },
      data: { faculties },
    });
  }

  async listPlans(query: PageQuery) {
    const { page, limit, skip } = this.pageLimit(query);
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
        skip,
        take: limit,
        orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
        include: { _count: { select: { subscriptions: true } } },
      }),
    ]);
    return paginate(data, total, page, limit);
  }

  async createPlan(body: {
    code: string;
    nameEn: string;
    nameAr: string;
    descriptionEn?: string;
    descriptionAr?: string;
    priceMonthly: number;
    currency?: string;
    maxCourses?: number | null;
    maxAssessments?: number | null;
    maxAiRequests?: number | null;
    features?: unknown;
    isActive?: boolean;
    sortOrder?: number;
  }) {
    return this.prisma.plan.create({
      data: {
        code: body.code.trim().toUpperCase(),
        nameEn: body.nameEn.trim(),
        nameAr: body.nameAr.trim(),
        descriptionEn: body.descriptionEn || null,
        descriptionAr: body.descriptionAr || null,
        priceMonthly: body.priceMonthly,
        currency: body.currency || 'SAR',
        maxCourses: body.maxCourses ?? null,
        maxAssessments: body.maxAssessments ?? null,
        maxAiRequests: body.maxAiRequests ?? null,
        features: (body.features as Prisma.InputJsonValue) ?? [],
        isActive: body.isActive ?? true,
        sortOrder: body.sortOrder ?? 0,
      },
    });
  }

  async updatePlan(id: number, body: Record<string, unknown>) {
    const existing = await this.prisma.plan.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('PLAN_NOT_FOUND');
    return this.prisma.plan.update({
      where: { id },
      data: {
        code:
          typeof body.code === 'string'
            ? body.code.trim().toUpperCase()
            : undefined,
        nameEn: typeof body.nameEn === 'string' ? body.nameEn.trim() : undefined,
        nameAr: typeof body.nameAr === 'string' ? body.nameAr.trim() : undefined,
        descriptionEn:
          body.descriptionEn === undefined
            ? undefined
            : (body.descriptionEn as string | null),
        descriptionAr:
          body.descriptionAr === undefined
            ? undefined
            : (body.descriptionAr as string | null),
        priceMonthly:
          body.priceMonthly === undefined
            ? undefined
            : Number(body.priceMonthly),
        currency:
          typeof body.currency === 'string' ? body.currency : undefined,
        maxCourses:
          body.maxCourses === undefined
            ? undefined
            : (body.maxCourses as number | null),
        maxAssessments:
          body.maxAssessments === undefined
            ? undefined
            : (body.maxAssessments as number | null),
        maxAiRequests:
          body.maxAiRequests === undefined
            ? undefined
            : (body.maxAiRequests as number | null),
        features:
          body.features === undefined
            ? undefined
            : (body.features as Prisma.InputJsonValue),
        isActive:
          body.isActive === undefined ? undefined : Boolean(body.isActive),
        sortOrder:
          body.sortOrder === undefined ? undefined : Number(body.sortOrder),
      },
    });
  }

  async deletePlan(id: number) {
    await this.prisma.plan.delete({ where: { id } });
    return { success: true };
  }

  async listSubscriptions(query: PageQuery & { status?: string }) {
    const { page, limit, skip } = this.pageLimit(query);
    const search = query.search?.trim();
    const where: Prisma.SubscriptionWhereInput = {};
    if (
      query.status &&
      Object.values(SubscriptionStatus).includes(
        query.status as SubscriptionStatus,
      )
    ) {
      where.status = query.status as SubscriptionStatus;
    }
    if (search) {
      where.OR = [
        { notes: { contains: search, mode: 'insensitive' } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
        { plan: { code: { contains: search, mode: 'insensitive' } } },
        { plan: { nameEn: { contains: search, mode: 'insensitive' } } },
      ];
    }
    const [total, data] = await Promise.all([
      this.prisma.subscription.count({ where }),
      this.prisma.subscription.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          plan: true,
          user: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
          tenant: { select: { id: true, createdAt: true } },
        },
      }),
    ]);
    return paginate(data, total, page, limit);
  }

  async createSubscription(body: {
    tenantId: number;
    userId?: number | null;
    planId: number;
    status?: SubscriptionStatus;
    startsAt?: string;
    endsAt?: string | null;
    notes?: string;
  }) {
    return this.prisma.subscription.create({
      data: {
        tenantId: body.tenantId,
        userId: body.userId || null,
        planId: body.planId,
        status: body.status || SubscriptionStatus.ACTIVE,
        startsAt: body.startsAt ? new Date(body.startsAt) : new Date(),
        endsAt: body.endsAt ? new Date(body.endsAt) : null,
        notes: body.notes || null,
      },
      include: { plan: true, user: true },
    });
  }

  async updateSubscription(
    id: number,
    body: {
      status?: SubscriptionStatus;
      endsAt?: string | null;
      notes?: string | null;
      planId?: number;
    },
  ) {
    const existing = await this.prisma.subscription.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('SUBSCRIPTION_NOT_FOUND');
    return this.prisma.subscription.update({
      where: { id },
      data: {
        status: body.status,
        endsAt:
          body.endsAt === undefined
            ? undefined
            : body.endsAt
              ? new Date(body.endsAt)
              : null,
        notes: body.notes,
        planId: body.planId,
        canceledAt:
          body.status === SubscriptionStatus.CANCELED ? new Date() : undefined,
      },
      include: { plan: true, user: true },
    });
  }

  async listAiLogs(
    query: PageQuery & { purpose?: string; success?: string; userId?: string },
  ) {
    const { page, limit, skip } = this.pageLimit(query);
    const where: Prisma.AiUsageLogWhereInput = {};
    if (query.purpose) where.purpose = query.purpose;
    if (query.success === 'true') where.success = true;
    if (query.success === 'false') where.success = false;
    if (query.userId) where.userId = Number(query.userId);
    if (query.search?.trim()) {
      const search = query.search.trim();
      where.OR = [
        { model: { contains: search, mode: 'insensitive' } },
        { purpose: { contains: search, mode: 'insensitive' } },
        { requestPreview: { contains: search, mode: 'insensitive' } },
        { responsePreview: { contains: search, mode: 'insensitive' } },
        { errorMessage: { contains: search, mode: 'insensitive' } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }
    const [total, data] = await Promise.all([
      this.prisma.aiUsageLog.count({ where }),
      this.prisma.aiUsageLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
        },
      }),
    ]);
    return paginate(data, total, page, limit);
  }

  async listLoginLogs(query: PageQuery & { success?: string; userId?: string }) {
    const { page, limit, skip } = this.pageLimit(query);
    const where: Prisma.LoginLogWhereInput = {};
    if (query.success === 'true') where.success = true;
    if (query.success === 'false') where.success = false;
    if (query.userId) where.userId = Number(query.userId);
    if (query.search?.trim()) {
      const search = query.search.trim();
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { ip: { contains: search, mode: 'insensitive' } },
        { reason: { contains: search, mode: 'insensitive' } },
      ];
    }
    const [total, data] = await Promise.all([
      this.prisma.loginLog.count({ where }),
      this.prisma.loginLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
        },
      }),
    ]);
    return paginate(data, total, page, limit);
  }

  async listTenants(query: PageQuery) {
    const { page, limit, skip } = this.pageLimit(query);
    const [total, tenants] = await Promise.all([
      this.prisma.tenant.count(),
      this.prisma.tenant.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: {
              users: true,
              courses: true,
              assessments: true,
              subscriptions: true,
            },
          },
          users: {
            take: 3,
            orderBy: { createdAt: 'asc' },
            select: { id: true, email: true, role: true },
          },
        },
      }),
    ]);
    return paginate(tenants, total, page, limit);
  }

  async createSuperAdmin(input: {
    email: string;
    password: string;
    firstName?: string;
    lastName?: string;
  }) {
    const email = input.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      return this.prisma.user.update({
        where: { id: existing.id },
        data: {
          role: UserRole.SUPER_ADMIN,
          isActive: true,
          isVerified: true,
          passwordHash: await argon2.hash(input.password),
          hashVersion: 'argon2',
          firstName: input.firstName || existing.firstName,
          lastName: input.lastName || existing.lastName,
        },
        select: {
          id: true,
          email: true,
          role: true,
          isActive: true,
          tenantId: true,
        },
      });
    }
    const hash = await argon2.hash(input.password);
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({ data: {} });
      return tx.user.create({
        data: {
          email,
          passwordHash: hash,
          hashVersion: 'argon2',
          firstName: input.firstName || 'Platform',
          lastName: input.lastName || 'Admin',
          role: UserRole.SUPER_ADMIN,
          isActive: true,
          isVerified: true,
          tenantId: tenant.id,
        },
        select: {
          id: true,
          email: true,
          role: true,
          isActive: true,
          tenantId: true,
        },
      });
    });
  }
}
