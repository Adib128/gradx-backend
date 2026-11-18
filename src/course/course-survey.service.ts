import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma } from 'generated/prisma/client';
import { PrismaService } from 'prisma/prisma.service';
import { requireTenantId } from 'src/common/helpers/require-tenant.helper';

export type SurveyCloRow = {
  code: string;
  statement: string;
};

export type SurveyBrand = {
  countryEn?: string;
  countryAr?: string;
  ministryEn?: string;
  ministryAr?: string;
  universityEn?: string;
  universityAr?: string;
  facultyEn?: string;
  facultyAr?: string;
  departmentEn?: string;
  departmentAr?: string;
  logoUrl?: string;
};

export type UpdateCourseSurveyDto = {
  title?: string;
  subtitle?: string;
  introText?: string;
  instructions?: string;
  closingText?: string | null;
  instructor?: string | null;
  semester?: string | null;
  section?: string | null;
  courseCode?: string | null;
  courseName?: string | null;
  brand?: SurveyBrand | null;
  /** When true, re-snapshot CLOs from the live course. */
  refreshClos?: boolean;
};

export type SubmitPublicSurveyDto = {
  studentName?: string;
  studentId?: string;
  section?: string;
  comments?: string;
  locale?: string;
  ratings: Array<{ cloCode: string; rating: number }>;
};

const DEFAULT_TITLE = 'Course Learning Outcomes (CLO) Survey';
const DEFAULT_SUBTITLE = 'Student Self-Assessment of CLO Achievement';
const DEFAULT_INTRO = `Dear Student,

The College is committed to the continuous improvement of its programs in line with NCAAA and ABET accreditation requirements. This survey asks you to reflect on the Course Learning Outcomes (CLOs) of this course and rate how well you feel you have achieved each outcome.`;
const DEFAULT_INSTRUCTIONS =
  'Instructions: Considering the course material covered and what you have gained from this course, please tick (✓) one box only for each statement below.';
const DEFAULT_CLOSING =
  'Comments and suggestions for improving the course\n\nThank you for your time and valuable feedback.';

/** 32 random bytes → URL-safe token (~43 chars). Never derive from survey/course ids. */
function createShareToken(): string {
  return randomBytes(32).toString('base64url');
}

function asSyllabus(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

function text(value: unknown, fallback = ''): string {
  if (value == null) return fallback;
  const s = String(value).trim();
  return s || fallback;
}

function sortCloCode(a: string, b: string): number {
  const na = Number((a.match(/\d+/) || [])[0] || 0);
  const nb = Number((b.match(/\d+/) || [])[0] || 0);
  if (na !== nb) return na - nb;
  return a.localeCompare(b);
}

@Injectable()
export class CourseSurveyService {
  constructor(private readonly prisma: PrismaService) {}

  private async requireCourse(tenantId: number, courseId: number) {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, tenantId, deletedAt: null },
      include: { clos: true },
    });
    if (!course) throw new NotFoundException('COURSE_NOT_FOUND');
    return course;
  }

  private snapshotClos(
    clos: Array<{ code: string; description: string }>,
  ): SurveyCloRow[] {
    return [...clos]
      .map((clo) => ({
        code: text(clo.code),
        statement: text(clo.description),
      }))
      .filter((row) => row.code && row.statement)
      .sort((a, b) => sortCloCode(a.code, b.code));
  }

  private buildDefaults(course: {
    title: string;
    code: string | null;
    college: string | null;
    department: string | null;
    institution: string | null;
    semester: string | null;
    academicYear: string | null;
    syllabusData: unknown;
  }) {
    const syllabus = asSyllabus(course.syllabusData);
    const college =
      text(syllabus.college) ||
      text(course.college) ||
      'the College';
    const introText = DEFAULT_INTRO.replace(
      'The College is committed',
      `The ${college} is committed`,
    );
    const semesterParts = [
      text(course.semester) || text(syllabus.semester),
      text(course.academicYear) || text(syllabus.academicYear),
    ].filter(Boolean);
    return {
      title: DEFAULT_TITLE,
      subtitle: DEFAULT_SUBTITLE,
      introText,
      instructions: DEFAULT_INSTRUCTIONS,
      closingText: DEFAULT_CLOSING,
      instructor:
        text(syllabus.instructorName) || text(syllabus.instructor) || null,
      semester: semesterParts.join(', ') || null,
      section: text(syllabus.section) || null,
      courseCode: text(course.code) || null,
      courseName: text(course.title) || null,
      brand: null as SurveyBrand | null,
    };
  }

  private toPublicDto(survey: {
    id: number;
    title: string;
    subtitle: string | null;
    introText: string;
    instructions: string;
    closingText: string | null;
    instructor: string | null;
    semester: string | null;
    section: string | null;
    courseCode: string | null;
    courseName: string | null;
    brand: Prisma.JsonValue | null;
    clos: Prisma.JsonValue;
    shareToken: string | null;
    shareEnabled: boolean;
    shareExpiresAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: survey.id,
      title: survey.title,
      subtitle: survey.subtitle,
      introText: survey.introText,
      instructions: survey.instructions,
      closingText: survey.closingText,
      instructor: survey.instructor,
      semester: survey.semester,
      section: survey.section,
      courseCode: survey.courseCode,
      courseName: survey.courseName,
      brand: (survey.brand as SurveyBrand | null) ?? null,
      clos: Array.isArray(survey.clos)
        ? (survey.clos as SurveyCloRow[])
        : [],
      shareToken: survey.shareToken,
      shareEnabled: survey.shareEnabled,
      shareExpiresAt: survey.shareExpiresAt,
      createdAt: survey.createdAt,
      updatedAt: survey.updatedAt,
    };
  }

  /** Teacher view: latest survey for the course, or null. */
  async getForCourse(tenantId: number, courseId: number) {
    requireTenantId(tenantId);
    await this.requireCourse(tenantId, courseId);
    const survey = await this.prisma.courseSurvey.findFirst({
      where: { courseId, tenantId },
      orderBy: { updatedAt: 'desc' },
    });
    return survey ? this.toPublicDto(survey) : null;
  }

  /**
   * Create or regenerate the CLO survey from live course data.
   * Regenerating refreshes CLO snapshot and metadata defaults without
   * rotating an existing share token (teacher must rotate explicitly).
   */
  async generate(tenantId: number, courseId: number, brand?: SurveyBrand | null) {
    requireTenantId(tenantId);
    const course = await this.requireCourse(tenantId, courseId);
    const clos = this.snapshotClos(course.clos);
    if (clos.length === 0) {
      throw new BadRequestException('SURVEY_REQUIRES_CLOS');
    }

    const defaults = this.buildDefaults(course);
    const existing = await this.prisma.courseSurvey.findFirst({
      where: { courseId, tenantId },
      orderBy: { updatedAt: 'desc' },
    });

    const data = {
      title: defaults.title,
      subtitle: defaults.subtitle,
      introText: defaults.introText,
      instructions: defaults.instructions,
      closingText: defaults.closingText,
      instructor: defaults.instructor,
      semester: defaults.semester,
      section: defaults.section,
      courseCode: defaults.courseCode,
      courseName: defaults.courseName,
      brand: (brand ?? existing?.brand ?? null) as Prisma.InputJsonValue,
      clos: clos as unknown as Prisma.InputJsonValue,
    };

    const survey = existing
      ? await this.prisma.courseSurvey.update({
          where: { id: existing.id },
          data,
        })
      : await this.prisma.courseSurvey.create({
          data: {
            courseId,
            tenantId,
            ...data,
          },
        });

    return this.toPublicDto(survey);
  }

  async update(
    tenantId: number,
    courseId: number,
    surveyId: number,
    dto: UpdateCourseSurveyDto,
  ) {
    requireTenantId(tenantId);
    const survey = await this.prisma.courseSurvey.findFirst({
      where: { id: surveyId, courseId, tenantId },
    });
    if (!survey) throw new NotFoundException('SURVEY_NOT_FOUND');

    let clos: Prisma.InputJsonValue | undefined;
    if (dto.refreshClos) {
      const course = await this.requireCourse(tenantId, courseId);
      const snapshot = this.snapshotClos(course.clos);
      if (snapshot.length === 0) {
        throw new BadRequestException('SURVEY_REQUIRES_CLOS');
      }
      clos = snapshot as unknown as Prisma.InputJsonValue;
    }

    const updated = await this.prisma.courseSurvey.update({
      where: { id: survey.id },
      data: {
        ...(dto.title !== undefined ? { title: text(dto.title, survey.title) } : {}),
        ...(dto.subtitle !== undefined
          ? { subtitle: text(dto.subtitle) || null }
          : {}),
        ...(dto.introText !== undefined
          ? { introText: text(dto.introText, survey.introText) }
          : {}),
        ...(dto.instructions !== undefined
          ? { instructions: text(dto.instructions, survey.instructions) }
          : {}),
        ...(dto.closingText !== undefined
          ? { closingText: text(dto.closingText) || null }
          : {}),
        ...(dto.instructor !== undefined
          ? { instructor: text(dto.instructor) || null }
          : {}),
        ...(dto.semester !== undefined
          ? { semester: text(dto.semester) || null }
          : {}),
        ...(dto.section !== undefined
          ? { section: text(dto.section) || null }
          : {}),
        ...(dto.courseCode !== undefined
          ? { courseCode: text(dto.courseCode) || null }
          : {}),
        ...(dto.courseName !== undefined
          ? { courseName: text(dto.courseName) || null }
          : {}),
        ...(dto.brand !== undefined
          ? { brand: (dto.brand ?? null) as Prisma.InputJsonValue }
          : {}),
        ...(clos !== undefined ? { clos } : {}),
      },
    });

    return this.toPublicDto(updated);
  }

  /**
   * Enable public access: issue a new high-entropy token if missing,
   * or keep the current one. Optional expiry (days).
   */
  async enableShare(
    tenantId: number,
    courseId: number,
    surveyId: number,
    options?: { rotate?: boolean; expiresInDays?: number | null },
  ) {
    requireTenantId(tenantId);
    const survey = await this.prisma.courseSurvey.findFirst({
      where: { id: surveyId, courseId, tenantId },
    });
    if (!survey) throw new NotFoundException('SURVEY_NOT_FOUND');

    const rotate = options?.rotate === true || !survey.shareToken;
    let shareExpiresAt: Date | null = survey.shareExpiresAt;
    if (options?.expiresInDays === null) {
      shareExpiresAt = null;
    } else if (
      typeof options?.expiresInDays === 'number' &&
      Number.isFinite(options.expiresInDays) &&
      options.expiresInDays > 0
    ) {
      shareExpiresAt = new Date(
        Date.now() + options.expiresInDays * 24 * 60 * 60 * 1000,
      );
    }

    const updated = await this.prisma.courseSurvey.update({
      where: { id: survey.id },
      data: {
        shareEnabled: true,
        shareToken: rotate ? createShareToken() : survey.shareToken,
        shareExpiresAt,
      },
    });

    return this.toPublicDto(updated);
  }

  async disableShare(tenantId: number, courseId: number, surveyId: number) {
    requireTenantId(tenantId);
    const survey = await this.prisma.courseSurvey.findFirst({
      where: { id: surveyId, courseId, tenantId },
    });
    if (!survey) throw new NotFoundException('SURVEY_NOT_FOUND');

    const updated = await this.prisma.courseSurvey.update({
      where: { id: survey.id },
      data: { shareEnabled: false },
    });
    return this.toPublicDto(updated);
  }

  private async requirePublicSurvey(token: string) {
    const cleaned = text(token);
    if (!cleaned || cleaned.length < 16 || cleaned.length > 128) {
      throw new NotFoundException('SURVEY_NOT_FOUND');
    }

    const survey = await this.prisma.courseSurvey.findFirst({
      where: { shareToken: cleaned },
      include: {
        course: {
          select: {
            title: true,
            code: true,
            semester: true,
            academicYear: true,
          },
        },
      },
    });

    if (
      !survey ||
      !survey.shareEnabled ||
      (survey.shareExpiresAt && survey.shareExpiresAt.getTime() < Date.now())
    ) {
      throw new NotFoundException('SURVEY_NOT_FOUND');
    }

    return survey;
  }

  /**
   * Public lookup by token only. Invalid / disabled / expired → same 404
   * so callers cannot distinguish course existence.
   */
  async findPublicByToken(token: string) {
    const survey = await this.requirePublicSurvey(token);
    const dto = this.toPublicDto(survey);
    const courseSemester = text(survey.course?.semester);
    const courseAcademicYear = text(survey.course?.academicYear);
    // Prefer live course identity; fall back to survey snapshot / combined semester.
    let semesterLabel = courseSemester || null;
    let academicYear = courseAcademicYear || null;
    if (!semesterLabel || !academicYear) {
      const snapshot = text(dto.semester);
      if (snapshot.includes(',')) {
        const [left, ...rest] = snapshot.split(',');
        semesterLabel = semesterLabel || text(left) || null;
        academicYear = academicYear || text(rest.join(',')) || null;
      } else if (!semesterLabel) {
        semesterLabel = snapshot || null;
      }
    }

    return {
      title: dto.title,
      subtitle: dto.subtitle,
      introText: dto.introText,
      instructions: dto.instructions,
      closingText: dto.closingText,
      instructor: dto.instructor,
      semester: semesterLabel || dto.semester,
      academicYear,
      section: dto.section,
      courseCode: dto.courseCode || text(survey.course?.code) || null,
      courseName: dto.courseName || text(survey.course?.title) || null,
      brand: dto.brand,
      clos: dto.clos,
    };
  }

  async getResults(tenantId: number, courseId: number, surveyId: number) {
    requireTenantId(tenantId);
    const survey = await this.prisma.courseSurvey.findFirst({
      where: { id: surveyId, courseId, tenantId },
    });
    if (!survey) throw new NotFoundException('SURVEY_NOT_FOUND');

    const clos = Array.isArray(survey.clos)
      ? (survey.clos as SurveyCloRow[])
      : [];
    const responses = await this.prisma.courseSurveyResponse.findMany({
      where: { surveyId: survey.id },
      orderBy: { submittedAt: 'desc' },
    });

    const ratingDist = new Map<number, number>([
      [5, 0],
      [4, 0],
      [3, 0],
      [2, 0],
      [1, 0],
    ]);
    const cloAgg = new Map<
      string,
      {
        code: string;
        statement: string;
        sum: number;
        count: number;
        dist: Record<1 | 2 | 3 | 4 | 5, number>;
      }
    >();

    for (const clo of clos) {
      const code = text(clo.code);
      if (!code) continue;
      cloAgg.set(code, {
        code,
        statement: text(clo.statement),
        sum: 0,
        count: 0,
        dist: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      });
    }

    let ratingSum = 0;
    let ratingCount = 0;
    let agreeCount = 0;
    const byDay = new Map<string, number>();

    for (const response of responses) {
      const day = response.submittedAt.toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + 1);

      const ratings = Array.isArray(response.ratings)
        ? (response.ratings as Array<{ cloCode?: string; rating?: number }>)
        : [];
      for (const row of ratings) {
        const code = text(row?.cloCode);
        const rating = Number(row?.rating);
        if (!code || !Number.isInteger(rating) || rating < 1 || rating > 5) {
          continue;
        }
        ratingSum += rating;
        ratingCount += 1;
        ratingDist.set(rating, (ratingDist.get(rating) || 0) + 1);
        if (rating >= 4) agreeCount += 1;

        let agg = cloAgg.get(code);
        if (!agg) {
          agg = {
            code,
            statement: '',
            sum: 0,
            count: 0,
            dist: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
          };
          cloAgg.set(code, agg);
        }
        agg.sum += rating;
        agg.count += 1;
        agg.dist[rating as 1 | 2 | 3 | 4 | 5] += 1;
      }
    }

    const totalRatings = ratingCount || 1;
    const cloStats = [...cloAgg.values()]
      .map((row) => {
        const average = row.count > 0 ? row.sum / row.count : 0;
        const agree =
          row.count > 0
            ? ((row.dist[5] + row.dist[4]) / row.count) * 100
            : 0;
        return {
          code: row.code,
          statement: row.statement,
          average: Number(average.toFixed(2)),
          responseCount: row.count,
          agreementPercent: Number(agree.toFixed(1)),
          distribution: [
            { rating: 5, count: row.dist[5] },
            { rating: 4, count: row.dist[4] },
            { rating: 3, count: row.dist[3] },
            { rating: 2, count: row.dist[2] },
            { rating: 1, count: row.dist[1] },
          ],
        };
      })
      .sort((a, b) => sortCloCode(a.code, b.code));

    const timeline = [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));

    return {
      responseCount: responses.length,
      ratingCount,
      averageOverall:
        ratingCount > 0 ? Number((ratingSum / ratingCount).toFixed(2)) : 0,
      agreementPercent:
        ratingCount > 0
          ? Number(((agreeCount / ratingCount) * 100).toFixed(1))
          : 0,
      ratingDistribution: [5, 4, 3, 2, 1].map((rating) => {
        const count = ratingDist.get(rating) || 0;
        return {
          rating,
          count,
          percent: Number(((count / totalRatings) * 100).toFixed(1)),
        };
      }),
      cloStats,
      timeline,
      recentResponses: responses.slice(0, 12).map((row) => ({
        id: row.id,
        studentName: row.studentName,
        studentId: row.studentId,
        section: row.section,
        submittedAt: row.submittedAt,
        comments: row.comments,
        average:
          Array.isArray(row.ratings) && row.ratings.length > 0
            ? Number(
                (
                  (
                    row.ratings as Array<{ rating?: number }>
                  ).reduce((sum, item) => sum + (Number(item.rating) || 0), 0) /
                  (row.ratings as unknown[]).length
                ).toFixed(2),
              )
            : null,
      })),
    };
  }

  async submitPublicResponse(
    token: string,
    dto: SubmitPublicSurveyDto,
    userAgent?: string | null,
  ) {
    const survey = await this.requirePublicSurvey(token);
    const clos = Array.isArray(survey.clos)
      ? (survey.clos as SurveyCloRow[])
      : [];
    if (clos.length === 0) {
      throw new BadRequestException('SURVEY_REQUIRES_CLOS');
    }

    const allowed = new Set(clos.map((row) => text(row.code)));
    const ratingsRaw = Array.isArray(dto.ratings) ? dto.ratings : [];
    if (ratingsRaw.length === 0) {
      throw new BadRequestException('SURVEY_RATINGS_REQUIRED');
    }

    const seen = new Set<string>();
    const ratings: Array<{ cloCode: string; rating: number }> = [];
    for (const row of ratingsRaw) {
      const cloCode = text(row?.cloCode);
      const rating = Number(row?.rating);
      if (!cloCode || !allowed.has(cloCode)) {
        throw new BadRequestException('SURVEY_RATING_INVALID');
      }
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        throw new BadRequestException('SURVEY_RATING_INVALID');
      }
      if (seen.has(cloCode)) {
        throw new BadRequestException('SURVEY_RATING_DUPLICATE');
      }
      seen.add(cloCode);
      ratings.push({ cloCode, rating });
    }

    // Require a rating for every CLO on the published survey.
    if (seen.size !== allowed.size) {
      throw new BadRequestException('SURVEY_RATINGS_INCOMPLETE');
    }

    const studentId = text(dto.studentId);
    if (!studentId) {
      throw new BadRequestException('SURVEY_STUDENT_ID_REQUIRED');
    }

    const enrolled = await this.prisma.student.findFirst({
      where: {
        studentId,
        courseId: survey.courseId,
      },
    });
    if (!enrolled) {
      throw new BadRequestException('SURVEY_STUDENT_NOT_ENROLLED');
    }

    const alreadySubmitted = await this.prisma.courseSurveyResponse.findFirst({
      where: {
        surveyId: survey.id,
        studentId,
      },
      select: { id: true },
    });
    if (alreadySubmitted) {
      throw new ConflictException('SURVEY_ALREADY_SUBMITTED');
    }

    const studentName =
      text(dto.studentName) || text(enrolled.name) || null;
    const section = text(dto.section) || text(enrolled.section) || null;
    const comments = text(dto.comments) || null;
    const locale = text(dto.locale).slice(0, 16) || null;

    try {
      await this.prisma.courseSurveyResponse.create({
        data: {
          surveyId: survey.id,
          studentName,
          studentId,
          section,
          comments,
          locale,
          userAgent: text(userAgent).slice(0, 512) || null,
          ratings: ratings as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      // Race: unique (surveyId, studentId) was hit by a concurrent submit.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('SURVEY_ALREADY_SUBMITTED');
      }
      throw error;
    }

    return { ok: true };
  }
}
