import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { CourseAIService } from './course-ai.service';
import { Prisma } from 'generated/prisma/client';

const DEFAULT_PASS_RATE_PERCENT = 70;

const GRADE_BANDS = [
  { grade: 'A+', min: 90, max: 100, markRange: '90-100', gpa: 4.0 },
  { grade: 'A', min: 85, max: 89, markRange: '85-89', gpa: 3.75 },
  { grade: 'B+', min: 80, max: 84, markRange: '80-84', gpa: 3.5 },
  { grade: 'B', min: 75, max: 79, markRange: '75-79', gpa: 3.0 },
  { grade: 'C+', min: 70, max: 74, markRange: '70-74', gpa: 2.5 },
  { grade: 'F', min: 0, max: 69, markRange: '0-69', gpa: 0 },
] as const;

type GradeBand = (typeof GRADE_BANDS)[number];

type QuestionMeta = {
  questionNumber: number;
  points: number;
  cloIds: number[];
  /** Weighted contribution of this question toward each linked CLO (course-weight scale). */
  weightedPoints: number;
};

type AssessmentSource = {
  assessmentId: number;
  title: string;
  cloMarks: number;
  questionNumbers: number[];
};

@Injectable()
export class CourseReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courseAIService: CourseAIService,
  ) {}

  private formatAssessmentSourcesSummary(
    sources: Array<{
      title: string;
      cloMarks: number;
      questionNumbers: number[];
    }>,
  ) {
    if (!sources.length) {
      return 'Assessment sources for this CLO are not linked yet.';
    }

    const parts = sources.map((source) => {
      const questions = (source.questionNumbers ?? []).filter((n) =>
        Number.isFinite(n),
      );
      if (questions.length === 1) {
        return `Question ${questions[0]} on the ${source.title}`;
      }
      if (questions.length > 1) {
        return `Questions ${questions.join(', ')} on the ${source.title}`;
      }
      return source.title;
    });

    if (parts.length === 1) {
      return `This CLO is primarily assessed by ${parts[0]}.`;
    }

    return `This CLO is assessed by ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}.`;
  }

  async getOrGenerateAllCloAnalysis(
    tenantId: number,
    courseId: number,
    options: { force?: boolean } = {},
  ) {
    const report = await this.getCloAchievementReport(tenantId, courseId);
    if (!report.rows.length) {
      throw new NotFoundException('No CLO data available for analysis.');
    }

    const closPayload = report.rows.map((row) => ({
      cloId: row.id,
      code: row.code,
      description: row.description,
      achievementRate: row.achievementRate,
      thresholdScore: row.thresholdScore,
      maxScore: row.maxScore,
      studentsMet: row.studentsMet,
      totalStudents: row.totalStudents,
      avgScore: row.avgScore,
      avgScoreLabel: row.avgScoreLabel,
      avgPercent: row.avgPercent,
      achieved: row.achieved,
      statusLabel: row.statusLabel,
      hasGradingData: row.hasGradingData,
      assessmentSourcesSummary: this.formatAssessmentSourcesSummary(
        row.assessmentSources ?? [],
      ),
    }));

    const fingerprint = this.courseAIService.buildCloAnalysisFingerprint(
      report.thresholdPercent,
      closPayload,
    );

    const course = await this.prisma.course.findFirst({
      where: { id: courseId, tenantId },
      select: { cloAnalysisCache: true },
    });

    if (!course) {
      throw new NotFoundException('Course not found.');
    }

    const cached = course.cloAnalysisCache as
      | {
          fingerprint?: string;
          generatedAt?: string;
          overview?: { title: string; paragraphs: string[] };
          analyses?: Array<{
            cloId: number;
            code: string;
            title: string;
            paragraphs: string[];
            highlightPercent: number;
          }>;
        }
      | null;

    if (
      !options.force &&
      cached?.fingerprint === fingerprint &&
      cached.overview &&
      Array.isArray(cached.analyses) &&
      cached.analyses.length > 0
    ) {
      return {
        ...cached,
        cached: true,
        fingerprint,
      };
    }

    const generated = await this.courseAIService.analyzeAllCloAchievements({
      passRatePercent: report.thresholdPercent,
      clos: closPayload,
    });

    const result = {
      fingerprint,
      generatedAt: new Date().toISOString(),
      overview: generated.overview,
      analyses: generated.analyses,
      cached: false,
    };

    await this.prisma.course.update({
      where: { id: courseId },
      data: {
        cloAnalysisCache: result as unknown as Prisma.InputJsonValue,
      },
    });

    return result;
  }

  async getCloAchievementReport(tenantId: number, courseId: number) {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, tenantId },
      include: {
        clos: { orderBy: { id: 'asc' } },
        students: { select: { id: true, studentId: true } },
        topics: {
          select: {
            id: true,
            topicClos: { select: { cloId: true } },
          },
        },
      },
    });

    if (!course) {
      throw new NotFoundException('Course not found.');
    }

    const passRatePercent =
      Number.isFinite(course.passRate) && course.passRate >= 0
        ? course.passRate
        : DEFAULT_PASS_RATE_PERCENT;

    const assessments = await this.prisma.assessment.findMany({
      where: { courseId, tenantId },
      include: {
        questions: {
          orderBy: { id: 'asc' },
          include: {
            questionClos: { select: { cloId: true } },
          },
        },
        assessmentVersions: {
          orderBy: { id: 'asc' },
          take: 1,
          include: {
            versionQuestions: {
              orderBy: { order: 'asc' },
              include: {
                question: {
                  include: {
                    questionClos: { select: { cloId: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    const topicCloMap = new Map<number, number[]>(
      course.topics.map((topic) => [
        topic.id,
        topic.topicClos.map((link) => link.cloId),
      ]),
    );

    const assessmentWeights = this.resolveAssessmentWeights(assessments);
    const assessmentIds = assessments.map((assessment) => assessment.id);
    const scans =
      assessmentIds.length > 0
        ? await this.prisma.gradingScan.findMany({
            where: {
              tenantId,
              assessmentId: { in: assessmentIds },
              status: 'COMPLETED',
            },
            select: {
              id: true,
              assessmentId: true,
              questionDetails: true,
              matchedStudentCode: true,
              detectedStudentId: true,
              studentId: true,
            },
          })
        : [];

    const questionMaps = new Map<number, QuestionMeta[]>();
    const cloAssessmentSources = new Map<number, AssessmentSource[]>();
    const cloTotalT = new Map<number, number>();

    for (const clo of course.clos) {
      cloTotalT.set(clo.id, 0);
      cloAssessmentSources.set(clo.id, []);
    }

    for (const assessment of assessments) {
      const examWeight = assessmentWeights.get(assessment.id) ?? 0;
      const orderedQuestions = this.getOrderedQuestions(assessment, topicCloMap);
      const examTotal =
        (Number.isFinite(assessment.totalMarks) &&
        assessment.totalMarks &&
        assessment.totalMarks > 0
          ? assessment.totalMarks
          : null) ??
        orderedQuestions.reduce((sum, question) => sum + question.points, 0);

      const enrichedQuestions: QuestionMeta[] = orderedQuestions.map((question) => {
        const weightedPoints =
          examTotal > 0 && examWeight > 0
            ? (question.points / examTotal) * examWeight
            : 0;
        return { ...question, weightedPoints };
      });

      questionMaps.set(assessment.id, enrichedQuestions);

      const perCloMarks = new Map<
        number,
        { marks: number; questionNumbers: number[] }
      >();

      for (const question of enrichedQuestions) {
        if (question.cloIds.length === 0 || question.weightedPoints <= 0) continue;

        // Split question weight evenly across linked CLOs
        const share = question.weightedPoints / question.cloIds.length;
        for (const cloId of question.cloIds) {
          if (!cloTotalT.has(cloId)) continue;
          cloTotalT.set(cloId, (cloTotalT.get(cloId) ?? 0) + share);

          const existing = perCloMarks.get(cloId) ?? {
            marks: 0,
            questionNumbers: [],
          };
          existing.marks += share;
          existing.questionNumbers.push(question.questionNumber);
          perCloMarks.set(cloId, existing);
        }
      }

      for (const [cloId, info] of perCloMarks.entries()) {
        const sources = cloAssessmentSources.get(cloId) ?? [];
        sources.push({
          assessmentId: assessment.id,
          title: assessment.title,
          cloMarks: Math.round(info.marks * 100) / 100,
          questionNumbers: info.questionNumbers,
        });
        cloAssessmentSources.set(cloId, sources);
      }
    }

    // Fallback T from CLO assessmentMethods when no question-CLO links exist
    const hasQuestionLinkedMarks = Array.from(cloTotalT.values()).some((value) => value > 0);
    if (!hasQuestionLinkedMarks) {
      for (const assessment of assessments) {
        const examWeight = assessmentWeights.get(assessment.id) ?? 0;
        if (examWeight <= 0) continue;

        const matchedClos = course.clos.filter((clo) =>
          (clo.assessmentMethods || []).some((method) =>
            this.assessmentMatchesMethod(assessment.title, method),
          ),
        );
        if (matchedClos.length === 0) continue;

        const share = examWeight / matchedClos.length;
        for (const clo of matchedClos) {
          cloTotalT.set(clo.id, (cloTotalT.get(clo.id) ?? 0) + share);
          const sources = cloAssessmentSources.get(clo.id) ?? [];
          sources.push({
            assessmentId: assessment.id,
            title: assessment.title,
            cloMarks: Math.round(share * 100) / 100,
            questionNumbers: [],
          });
          cloAssessmentSources.set(clo.id, sources);
        }
      }
    }

    const studentCloScores = new Map<number, Map<string, number>>();
    for (const clo of course.clos) {
      studentCloScores.set(clo.id, new Map());
    }

    const enrolledStudents = course.students;
    const enrolledKeys = enrolledStudents.map(
      (student) => student.studentId || `student-${student.id}`,
    );

    // Initialize enrolled students with 0 so S uses full class denominator
    for (const clo of course.clos) {
      const scores = studentCloScores.get(clo.id)!;
      for (const key of enrolledKeys) {
        scores.set(key, 0);
      }
    }

    const gradedStudentKeys = new Set<string>();

    for (const scan of scans) {
      const studentKey =
        (scan.studentId != null
          ? enrolledStudents.find((student) => student.id === scan.studentId)
              ?.studentId || `student-${scan.studentId}`
          : null) ??
        scan.matchedStudentCode ??
        scan.detectedStudentId ??
        `scan-${scan.id}`;

      gradedStudentKeys.add(studentKey);

      const questions = questionMaps.get(scan.assessmentId) ?? [];
      const details = Array.isArray(scan.questionDetails)
        ? (scan.questionDetails as Array<Record<string, unknown>>)
        : [];

      for (const detail of details) {
        const questionNumber = Number(detail.question);
        if (!Number.isFinite(questionNumber)) continue;

        const meta = questions.find((item) => item.questionNumber === questionNumber);
        if (!meta || meta.cloIds.length === 0 || meta.weightedPoints <= 0) continue;

        const rawEarned = Number(
          detail.score ?? detail.points ?? detail.marks ?? detail.earned,
        );
        const fraction =
          Number.isFinite(rawEarned) && meta.points > 0
            ? Math.min(1, Math.max(0, rawEarned / meta.points))
            : detail.isCorrect === true
              ? 1
              : 0;
        const earnedShare =
          (meta.weightedPoints * fraction) / meta.cloIds.length;
        if (earnedShare <= 0) continue;

        for (const cloId of meta.cloIds) {
          const scores = studentCloScores.get(cloId);
          if (!scores) continue;
          scores.set(studentKey, (scores.get(studentKey) ?? 0) + earnedShare);
        }
      }
    }

    const totalStudents =
      enrolledStudents.length > 0
        ? enrolledStudents.length
        : gradedStudentKeys.size;

    const rows = course.clos.map((clo, index) => {
      const totalT = Math.round((cloTotalT.get(clo.id) ?? 0) * 100) / 100;
      const thresholdScore =
        Math.round(totalT * (passRatePercent / 100) * 100) / 100;

      const scoresMap = studentCloScores.get(clo.id) ?? new Map<string, number>();
      const studentScores =
        enrolledStudents.length > 0
          ? enrolledKeys.map((key) => scoresMap.get(key) ?? 0)
          : Array.from(scoresMap.values());

      const hasGradingData = gradedStudentKeys.size > 0 && totalT > 0;

      const avgScore = hasGradingData
        ? Math.round(
            (studentScores.reduce((sum, score) => sum + score, 0) /
              Math.max(totalStudents, 1)) *
              100,
          ) / 100
        : null;

      const studentsMet = hasGradingData
        ? studentScores.filter((score) => score >= thresholdScore).length
        : 0;

      const achievementRate =
        hasGradingData && totalStudents > 0
          ? Math.round((studentsMet / totalStudents) * 1000) / 10
          : null;

      const achieved =
        achievementRate != null ? achievementRate >= passRatePercent : false;

      const maxScore = totalT;
      const avgScoreLabel =
        avgScore != null && maxScore > 0
          ? `${avgScore} / ${maxScore}`
          : maxScore > 0
            ? `— / ${maxScore}`
            : '—';
      const thresholdLabel =
        maxScore > 0 ? `${thresholdScore} / ${maxScore}` : '—';

      return {
        id: clo.id,
        code: clo.code || `CLO ${index + 1}`,
        programCLOCode: clo.programCLOCode || null,
        category: clo.category || null,
        description: clo.description,
        maxScore,
        thresholdScore,
        thresholdLabel,
        avgScore,
        avgScoreLabel,
        avgPercent:
          avgScore != null && maxScore > 0
            ? Math.round((avgScore / maxScore) * 1000) / 10
            : null,
        achievementRate,
        studentsMet,
        totalStudents,
        achieved,
        statusLabel: achieved ? 'Achieved' : 'Not achieved',
        assessmentSources: cloAssessmentSources.get(clo.id) ?? [],
        hasGradingData,
      };
    });

    const focusCloId =
      rows
        .filter((row) => row.hasGradingData)
        .sort((a, b) => (a.achievementRate ?? 100) - (b.achievementRate ?? 100))[0]
        ?.id ??
      rows[0]?.id ??
      null;

    return {
      thresholdPercent: passRatePercent,
      rows,
      focusCloId,
      enrolledCount: totalStudents,
      hasGradingData: rows.some((row) => row.hasGradingData),
    };
  }

  async getPloAlignmentReport(tenantId: number, courseId: number) {
    const cloReport = await this.getCloAchievementReport(tenantId, courseId);
    const passRatePercent = cloReport.thresholdPercent;

    type CloRow = (typeof cloReport.rows)[number] & {
      programCLOCode?: string | null;
      category?: string | null;
    };

    const cloRows = cloReport.rows as CloRow[];
    const ploToClos = new Map<
      string,
      Array<{
        id: number;
        code: string;
        category: string | null;
        achievementRate: number | null;
        achieved: boolean;
        hasGradingData: boolean;
      }>
    >();

    for (const clo of cloRows) {
      const ploCodes = this.parseProgramCloCodes(clo.programCLOCode);
      for (const ploCode of ploCodes) {
        const list = ploToClos.get(ploCode) ?? [];
        list.push({
          id: clo.id,
          code: clo.code,
          category: clo.category ?? null,
          achievementRate: clo.achievementRate,
          achieved: clo.achieved,
          hasGradingData: clo.hasGradingData,
        });
        ploToClos.set(ploCode, list);
      }
    }

    const ploCodes = Array.from(ploToClos.keys()).sort((a, b) =>
      this.comparePloCodes(a, b),
    );

    const ploRows = ploCodes.map((ploCode) => {
      const mapped = ploToClos.get(ploCode) ?? [];
      const rates = mapped
        .map((clo) => clo.achievementRate)
        .filter((rate): rate is number => rate != null);
      const rate =
        rates.length > 0
          ? Math.round(
              (rates.reduce((sum, value) => sum + value, 0) / rates.length) * 10,
            ) / 10
          : null;
      const achieved = rate != null ? rate >= passRatePercent : false;
      const category = this.formatPloCategory(
        mapped.find((clo) => clo.category)?.category ?? null,
        ploCode,
      );

      return {
        code: ploCode,
        category,
        cloCodes: mapped.map((clo) => clo.code),
        closLabel: mapped.map((clo) => clo.code).join(', ') || '—',
        rate,
        achieved,
        statusLabel: achieved ? 'Achieved' : 'Below threshold',
        hasGradingData: rates.length > 0,
      };
    });

    const matrixRows = cloRows.map((clo) => {
      const mappedPlos = new Set(this.parseProgramCloCodes(clo.programCLOCode));
      return {
        cloId: clo.id,
        cloCode: clo.code,
        mappings: ploCodes.map((ploCode) => ({
          ploCode,
          mapped: mappedPlos.has(ploCode),
        })),
      };
    });

    return {
      thresholdPercent: passRatePercent,
      hasGradingData: cloReport.hasGradingData,
      ploCodes,
      ploRows,
      matrixRows,
    };
  }

  private parseProgramCloCodes(value: string | null | undefined) {
    if (!value) return [] as string[];
    return String(value)
      .split(/[,;/|]+/)
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean);
  }

  private comparePloCodes(a: string, b: string) {
    const rank = (code: string) => {
      const letter = code.charAt(0).toUpperCase();
      const num = Number(code.slice(1)) || 0;
      const letterRank = letter === 'K' ? 0 : letter === 'S' ? 1 : letter === 'V' ? 2 : 3;
      return letterRank * 1000 + num;
    };
    return rank(a) - rank(b) || a.localeCompare(b);
  }

  private formatPloCategory(category: string | null, ploCode: string) {
    const normalized = String(category || '').toUpperCase();
    if (normalized.includes('KNOWLEDGE')) return 'Knowledge & Understanding';
    if (normalized.includes('SKILL')) return 'Skills';
    if (normalized.includes('VALUE')) return 'Values';
    const letter = ploCode.charAt(0).toUpperCase();
    if (letter === 'K') return 'Knowledge & Understanding';
    if (letter === 'S') return 'Skills';
    if (letter === 'V') return 'Values';
    return category || '—';
  }

  /**
   * Resolve each assessment's exam weight percentage.
   * Explicit `percentage` wins. Assessments of the same type that lack a
   * percentage share any leftover type weight equally (e.g. Quizzes 10% →
   * two quiz assessments without individual % become 5% each when only one
   * type-level weight is implied by siblings).
   */
  private resolveAssessmentWeights(
    assessments: Array<{
      id: number;
      type: string;
      percentage: number | null;
    }>,
  ) {
    const weights = new Map<number, number>();
    const withPercentage = assessments.filter(
      (assessment) =>
        assessment.percentage != null &&
        Number.isFinite(assessment.percentage) &&
        assessment.percentage >= 0,
    );
    const withoutPercentage = assessments.filter(
      (assessment) =>
        assessment.percentage == null ||
        !Number.isFinite(assessment.percentage) ||
        assessment.percentage < 0,
    );

    for (const assessment of withPercentage) {
      weights.set(assessment.id, Number(assessment.percentage));
    }

    if (withoutPercentage.length === 0) {
      return weights;
    }

    // Share remaining weight equally across assessments missing percentage.
    const assigned = withPercentage.reduce(
      (sum, assessment) => sum + Number(assessment.percentage),
      0,
    );
    const remaining = Math.max(0, 100 - assigned);
    const share =
      withoutPercentage.length > 0 ? remaining / withoutPercentage.length : 0;
    for (const assessment of withoutPercentage) {
      weights.set(assessment.id, share);
    }

    // If percentages over-count 100%, treat identical per-type values as a
    // shared type weight (e.g. two quizzes both stored as 10 → 5 each).
    const totalWeight = Array.from(weights.values()).reduce(
      (sum, value) => sum + value,
      0,
    );
    if (totalWeight > 100.01) {
      const byType = new Map<string, typeof assessments>();
      for (const assessment of assessments) {
        const type = String(assessment.type || 'OTHER');
        const list = byType.get(type) ?? [];
        list.push(assessment);
        byType.set(type, list);
      }

      for (const group of byType.values()) {
        if (group.length < 2) continue;
        const explicit = group
          .map((assessment) => weights.get(assessment.id) ?? 0)
          .filter((value) => value > 0);
        if (explicit.length !== group.length) continue;
        const unique = new Set(explicit.map((value) => Number(value)));
        if (unique.size === 1) {
          const shared = explicit[0] / group.length;
          for (const assessment of group) {
            weights.set(assessment.id, shared);
          }
        }
      }
    }

    return weights;
  }

  private assessmentMatchesMethod(assessmentTitle: string, method: string) {
    const normalize = (value: string) =>
      value.toLowerCase().replace(/[^a-z0-9]/g, '');
    const title = normalize(assessmentTitle);
    const methodText = normalize(method);
    if (!title || !methodText) return false;
    if (title.includes(methodText) || methodText.includes(title)) return true;
    const compactTitle = title.replace(/s$/g, '');
    const compactMethod = methodText.replace(/s$/g, '');
    if (
      compactTitle.includes(compactMethod) ||
      compactMethod.includes(compactTitle)
    ) {
      return true;
    }
    const keywords = [
      'midterm',
      'final',
      'quiz',
      'lab',
      'project',
      'exam',
      'assignment',
    ];
    const titleKeys = keywords.filter((key) => title.includes(key));
    const methodKeys = keywords.filter((key) => methodText.includes(key));
    return titleKeys.some((key) => methodKeys.includes(key));
  }

  async getGradeDistributionReport(tenantId: number, courseId: number) {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, tenantId },
      include: {
        students: { select: { id: true, studentId: true } },
        assessments: {
          select: {
            id: true,
            title: true,
            totalMarks: true,
            percentage: true,
            type: true,
          },
        },
      },
    });

    if (!course) {
      throw new NotFoundException('Course not found.');
    }

    const passMarkThreshold =
      Number.isFinite(course.passRate) && course.passRate >= 0
        ? course.passRate
        : DEFAULT_PASS_RATE_PERCENT;

    const assessmentWeights = this.resolveAssessmentWeights(course.assessments);
    const assessmentIds = course.assessments.map((assessment) => assessment.id);
    const scans =
      assessmentIds.length > 0
        ? await this.prisma.gradingScan.findMany({
            where: {
              tenantId,
              assessmentId: { in: assessmentIds },
              status: 'COMPLETED',
            },
            select: {
              id: true,
              assessmentId: true,
              score: true,
              maxScore: true,
              confirmedAt: true,
              createdAt: true,
              matchedStudentCode: true,
              detectedStudentId: true,
              studentId: true,
            },
            orderBy: [{ confirmedAt: 'desc' }, { createdAt: 'desc' }],
          })
        : [];

    const enrolledById = new Map(
      course.students.map((student) => [
        student.id,
        student.studentId || `student-${student.id}`,
      ]),
    );

    const studentScores = this.aggregateWeightedStudentScores(
      scans,
      assessmentWeights,
      enrolledById,
    );
    const gradedCount = studentScores.length;
    const enrolledCount = course.students.length;

    const bandCounts = new Map<string, number>(
      GRADE_BANDS.map((band) => [band.grade, 0]),
    );

    for (const entry of studentScores) {
      const band = this.scoreToGradeBand(entry.score);
      bandCounts.set(band.grade, (bandCounts.get(band.grade) ?? 0) + 1);
    }

    const rows = GRADE_BANDS.map((band) => {
      const count = bandCounts.get(band.grade) ?? 0;
      const percentOfClass =
        gradedCount > 0 ? Math.round((count / gradedCount) * 1000) / 10 : 0;

      return {
        grade: band.grade,
        markRange: band.markRange,
        count,
        percentOfClass,
        gpa: band.gpa,
        statusLabel: band.min >= passMarkThreshold ? 'Achieved' : 'Not achieved',
        achieved: band.min >= passMarkThreshold,
      };
    });

    const scores = studentScores.map((entry) => entry.score);
    const highestScore = scores.length > 0 ? Math.max(...scores) : null;
    const lowestScore = scores.length > 0 ? Math.min(...scores) : null;
    const averageScore =
      scores.length > 0
        ? Math.round(
            (scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10,
          ) / 10
        : null;

    const highestBand =
      highestScore != null ? this.scoreToGradeBand(highestScore) : null;
    const lowestBand =
      lowestScore != null ? this.scoreToGradeBand(lowestScore) : null;
    const averageBand =
      averageScore != null ? this.scoreToGradeBand(averageScore) : null;

    const failingCount = studentScores.filter(
      (entry) => entry.score < passMarkThreshold,
    ).length;
    const failingPercent =
      gradedCount > 0
        ? Math.round((failingCount / gradedCount) * 1000) / 10
        : null;

    const aaCount = (bandCounts.get('A+') ?? 0) + (bandCounts.get('A') ?? 0);
    const bbCount = (bandCounts.get('B+') ?? 0) + (bandCounts.get('B') ?? 0);
    const aaPercent =
      gradedCount > 0 ? Math.round((aaCount / gradedCount) * 1000) / 10 : null;
    const bbPercent =
      gradedCount > 0 ? Math.round((bbCount / gradedCount) * 1000) / 10 : null;

    const averageGpa =
      gradedCount > 0
        ? Math.round(
            (rows.reduce((sum, row) => sum + row.count * row.gpa, 0) /
              gradedCount) *
              100,
          ) / 100
        : 0;

    const focusGrade =
      rows
        .filter((row) => row.count > 0)
        .sort((a, b) => b.count - a.count || b.percentOfClass - a.percentOfClass)[0]
        ?.grade ??
      averageBand?.grade ??
      GRADE_BANDS[0].grade;

    return {
      passMarkThreshold,
      enrolledCount,
      gradedCount,
      hasGradingData: gradedCount > 0,
      kpis: {
        highest: {
          value: highestScore ?? 0,
          subtitle: highestBand ? highestBand.grade : '—',
        },
        lowest: {
          value: lowestScore ?? 0,
          subtitle: lowestBand ? lowestBand.grade : '—',
        },
        average: {
          value: averageScore ?? 0,
          subtitle: averageBand ? `${averageBand.grade} range` : '—',
        },
        failing: {
          value: failingCount,
          subtitle:
            failingPercent != null ? `${failingPercent}% of class` : '—',
        },
        aa: {
          value: aaCount,
          subtitle: aaPercent != null ? `${aaPercent}% of class` : '—',
        },
        bb: {
          value: bbCount,
          subtitle: bbPercent != null ? `${bbPercent}% of class` : '—',
        },
      },
      rows,
      totalRow: {
        count: gradedCount,
        percentOfClass: gradedCount > 0 ? 100 : 0,
        gpa: averageGpa,
        statusLabel: '—',
      },
      focusGrade,
    };
  }

  async getAssessmentsReport(tenantId: number, courseId: number) {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, tenantId },
      include: {
        students: { select: { id: true, studentId: true } },
        assessments: {
          select: {
            id: true,
            title: true,
            type: true,
            totalMarks: true,
            percentage: true,
          },
        },
      },
    });

    if (!course) {
      throw new NotFoundException('Course not found.');
    }

    const assessmentIds = course.assessments.map((assessment) => assessment.id);
    const scans =
      assessmentIds.length > 0
        ? await this.prisma.gradingScan.findMany({
            where: {
              tenantId,
              assessmentId: { in: assessmentIds },
              status: 'COMPLETED',
            },
            select: {
              id: true,
              assessmentId: true,
              score: true,
              maxScore: true,
              confirmedAt: true,
              createdAt: true,
              matchedStudentCode: true,
              detectedStudentId: true,
              studentId: true,
            },
            orderBy: [{ confirmedAt: 'desc' }, { createdAt: 'desc' }],
          })
        : [];

    const enrolledById = new Map(
      course.students.map((student) => [
        student.id,
        student.studentId || `student-${student.id}`,
      ]),
    );

    const scoresByAssessment = this.collectAssessmentStudentScores(
      scans,
      enrolledById,
    );

    const typeOrder: Record<string, number> = {
      MID_TERM_EXAM: 0,
      FINAL_EXAM: 1,
      QUIZ: 2,
      LAB: 3,
      OTHER: 4,
    };

    const orderedAssessments = [...course.assessments].sort((a, b) => {
      const typeDiff =
        (typeOrder[a.type] ?? 99) - (typeOrder[b.type] ?? 99);
      if (typeDiff !== 0) return typeDiff;
      return (a.title || '').localeCompare(b.title || '');
    });

    const distributions = orderedAssessments
      .map((assessment) => {
        const scores = scoresByAssessment.get(assessment.id) ?? [];
        const maxFromScans =
          scores.length > 0
            ? Math.max(...scores.map((entry) => entry.maxScore))
            : null;
        const maxScore =
          (Number.isFinite(assessment.totalMarks) &&
          (assessment.totalMarks as number) > 0
            ? (assessment.totalMarks as number)
            : null) ??
          maxFromScans;

        if (maxScore == null || maxScore <= 0 || scores.length === 0) {
          return null;
        }

        const bands = this.buildAssessmentScoreBands(maxScore);
        const bandCounts = new Map(bands.map((band) => [band.key, 0]));

        for (const entry of scores) {
          const band = this.scoreToAssessmentBand(entry.score, bands);
          bandCounts.set(band.key, (bandCounts.get(band.key) ?? 0) + 1);
        }

        const gradedCount = scores.length;
        const rows = bands.map((band) => {
          const count = bandCounts.get(band.key) ?? 0;
          return {
            key: band.key,
            label: band.label,
            count,
            percentOfClass:
              gradedCount > 0
                ? Math.round((count / gradedCount) * 1000) / 10
                : 0,
          };
        });

        const focusBandKey =
          rows
            .filter((row) => row.count > 0)
            .sort(
              (a, b) =>
                b.count - a.count || b.percentOfClass - a.percentOfClass,
            )[0]?.key ?? rows[0]?.key ?? null;

        return {
          assessmentId: assessment.id,
          title: assessment.title || `Assessment ${assessment.id}`,
          type: assessment.type,
          maxScore,
          gradedCount,
          focusBandKey,
          bands: rows,
        };
      })
      .filter((item) => item != null);

    const components = orderedAssessments
      .map((assessment) => {
        const scores = scoresByAssessment.get(assessment.id) ?? [];
        const maxFromScans =
          scores.length > 0
            ? Math.max(...scores.map((entry) => entry.maxScore))
            : null;
        const maxScore =
          (Number.isFinite(assessment.totalMarks) &&
          (assessment.totalMarks as number) > 0
            ? (assessment.totalMarks as number)
            : null) ??
          maxFromScans;

        if (maxScore == null || maxScore <= 0) {
          return null;
        }

        const averageScore =
          scores.length > 0
            ? Math.round(
                (scores.reduce((sum, entry) => sum + entry.score, 0) /
                  scores.length) *
                  10,
              ) / 10
            : null;

        const averagePercent =
          averageScore != null
            ? Math.round((averageScore / maxScore) * 1000) / 10
            : null;

        return {
          assessmentId: assessment.id,
          title: assessment.title || `Assessment ${assessment.id}`,
          type: assessment.type,
          label: this.formatAssessmentComponentLabel(
            assessment.title,
            assessment.type,
            maxScore,
          ),
          maxScore,
          averageScore,
          averagePercent,
          gradedCount: scores.length,
          hasGradingData: scores.length > 0,
        };
      })
      .filter((item) => item != null);

    return {
      enrolledCount: course.students.length,
      hasGradingData: distributions.length > 0,
      distributions,
      components,
    };
  }

  private formatAssessmentComponentLabel(
    title: string | null | undefined,
    type: string,
    maxScore: number,
  ) {
    const raw = String(title || '').trim();
    const typeFallback: Record<string, string> = {
      MID_TERM_EXAM: 'Midterm',
      FINAL_EXAM: 'Final',
      QUIZ: 'Quizzes',
      LAB: 'Lab',
      OTHER: 'Other',
    };

    let short = raw;
    if (!short) {
      short = typeFallback[type] ?? 'Assessment';
    } else if (short.length > 22) {
      if (/quiz/i.test(short)) short = 'Quizzes';
      else if (/lab/i.test(short)) short = 'Lab';
      else if (/project/i.test(short)) short = 'Project';
      else if (/mid/i.test(short)) short = 'Midterm';
      else if (/final/i.test(short)) short = 'Final';
      else short = `${short.slice(0, 18).trim()}…`;
    }

    return `${short} /${maxScore}`;
  }

  private collectAssessmentStudentScores(
    scans: Array<{
      id: number;
      assessmentId: number;
      score: number | null;
      maxScore: number | null;
      matchedStudentCode: string | null;
      detectedStudentId: string | null;
      studentId: number | null;
    }>,
    enrolledById: Map<number, string>,
  ) {
    const byAssessment = new Map<
      number,
      Map<string, { score: number; maxScore: number }>
    >();

    for (const scan of scans) {
      const score = Number(scan.score);
      const maxScore = Number(scan.maxScore);
      if (!Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) {
        continue;
      }

      const studentKey =
        (scan.studentId != null
          ? enrolledById.get(scan.studentId) ?? `student-${scan.studentId}`
          : null) ??
        scan.matchedStudentCode ??
        scan.detectedStudentId ??
        `scan-${scan.id}`;

      const studentMap = byAssessment.get(scan.assessmentId) ?? new Map();
      if (!studentMap.has(studentKey)) {
        studentMap.set(studentKey, { score, maxScore });
      }
      byAssessment.set(scan.assessmentId, studentMap);
    }

    return new Map(
      Array.from(byAssessment.entries()).map(([assessmentId, studentMap]) => [
        assessmentId,
        Array.from(studentMap.values()),
      ]),
    );
  }

  /**
   * Point bands for an assessment max score, matching the report UX:
   * <50%, 50–75%, 75–90%, >90%.
   */
  private buildAssessmentScoreBands(maxScore: number) {
    const t1 = Math.max(1, Math.round(maxScore * 0.5));
    const t2 = Math.min(maxScore, Math.max(t1 + 1, Math.round(maxScore * 0.75)));
    const t3 = Math.min(maxScore, Math.max(t2, Math.round(maxScore * 0.9)));

    const bands: Array<{
      key: string;
      label: string;
      min: number;
      max: number;
      mode: 'lt' | 'range' | 'gt';
    }> = [
      {
        key: 'low',
        label: `<${t1}`,
        min: 0,
        max: t1,
        mode: 'lt',
      },
    ];

    if (t1 <= t2 - 1) {
      bands.push({
        key: 'mid',
        label: `${t1}-${t2 - 1}`,
        min: t1,
        max: t2 - 1,
        mode: 'range',
      });
    }

    if (t2 <= t3) {
      bands.push({
        key: 'high',
        label: `${t2}-${t3}`,
        min: t2,
        max: t3,
        mode: 'range',
      });
    }

    if (t3 < maxScore) {
      bands.push({
        key: 'top',
        label: `>${t3}`,
        min: t3,
        max: maxScore,
        mode: 'gt',
      });
    }

    return bands;
  }

  private scoreToAssessmentBand(
    score: number,
    bands: Array<{
      key: string;
      label: string;
      min: number;
      max: number;
      mode: 'lt' | 'range' | 'gt';
    }>,
  ) {
    for (const band of bands) {
      if (band.mode === 'lt' && score < band.max) return band;
      if (band.mode === 'gt' && score > band.min) return band;
      if (band.mode === 'range' && score >= band.min && score <= band.max) {
        return band;
      }
    }
    return bands[bands.length - 1];
  }

  private aggregateWeightedStudentScores(
    scans: Array<{
      id: number;
      assessmentId: number;
      score: number | null;
      maxScore: number | null;
      matchedStudentCode: string | null;
      detectedStudentId: string | null;
      studentId: number | null;
    }>,
    assessmentWeights: Map<number, number>,
    enrolledById: Map<number, string>,
  ) {
    const perStudent = new Map<
      string,
      Map<number, { normalized: number; weight: number }>
    >();

    for (const scan of scans) {
      const studentKey =
        (scan.studentId != null
          ? enrolledById.get(scan.studentId) ?? `student-${scan.studentId}`
          : null) ??
        scan.matchedStudentCode ??
        scan.detectedStudentId ??
        `scan-${scan.id}`;

      const score = Number(scan.score);
      const maxScore = Number(scan.maxScore);
      if (!Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) {
        continue;
      }

      const weight = assessmentWeights.get(scan.assessmentId) ?? 0;
      if (weight <= 0) continue;

      const normalized = (score / maxScore) * 100;
      const byAssessment = perStudent.get(studentKey) ?? new Map();
      // Prefer first completed scan per assessment (already ordered desc)
      if (!byAssessment.has(scan.assessmentId)) {
        byAssessment.set(scan.assessmentId, { normalized, weight });
      }
      perStudent.set(studentKey, byAssessment);
    }

    return Array.from(perStudent.values())
      .map((assessmentScores) => {
        const entries = Array.from(assessmentScores.values());
        if (entries.length === 0) return null;
        // Course % = Σ (assessment% × assessment weight%/100)
        const weighted =
          Math.round(
            entries.reduce(
              (sum, entry) => sum + entry.normalized * (entry.weight / 100),
              0,
            ) * 10,
          ) / 10;
        return { score: weighted };
      })
      .filter((entry): entry is { score: number } => entry != null);
  }

  private scoreToGradeBand(score: number): GradeBand {
    const rounded = Math.round(score);
    return (
      GRADE_BANDS.find((band) => rounded >= band.min && rounded <= band.max) ??
      GRADE_BANDS[GRADE_BANDS.length - 1]
    );
  }

  private getOrderedQuestions(
    assessment: {
      questions: Array<{
        id: number;
        points: number;
        topicId?: number | null;
        questionClos: Array<{ cloId: number }>;
      }>;
      assessmentVersions: Array<{
        versionQuestions: Array<{
          order: number;
          question: {
            points: number;
            topicId?: number | null;
            questionClos: Array<{ cloId: number }>;
          };
        }>;
      }>;
    },
    topicCloMap: Map<number, number[]>,
  ): QuestionMeta[] {
    const resolveCloIds = (question: {
      topicId?: number | null;
      questionClos: Array<{ cloId: number }>;
    }) => {
      const linked = question.questionClos.map((link) => link.cloId);
      if (linked.length > 0) return linked;
      if (question.topicId != null) {
        return topicCloMap.get(question.topicId) ?? [];
      }
      return [];
    };

    const version = assessment.assessmentVersions[0];
    if (version?.versionQuestions?.length) {
      return version.versionQuestions.map((entry, index) => ({
        questionNumber: index + 1,
        points: entry.question.points,
        cloIds: resolveCloIds(entry.question),
        weightedPoints: 0,
      }));
    }

    return assessment.questions.map((question, index) => ({
      questionNumber: index + 1,
      points: question.points,
      cloIds: resolveCloIds(question),
      weightedPoints: 0,
    }));
  }
}
