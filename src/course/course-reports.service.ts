import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { CourseAIService } from './course-ai.service';
import { Prisma } from 'generated/prisma/client';
import { runWithAiContext } from 'src/common/helpers/openrouter-chat.helper';
import {
  GRADE_BANDS,
  computeCloScores,
  computeStudentTotals,
  isPassingTotal,
  resolveAssessmentMax,
  resolvePassRate,
  resolveScopedWeights,
  rosterKey,
  round1,
  round2,
  scaleScanScore,
  scoreToGradeBand,
  selectStudentScans,
  type RosterStudent,
  type SelectedScan,
} from './utils/course-report-scoring.util';

const QUESTION_SELECT = {
  id: true,
  type: true,
  points: true,
  topicId: true,
  questionClos: { select: { cloId: true } },
} satisfies Prisma.QuestionSelect;

const CLO_ASSESSMENT_SELECT = {
  id: true,
  title: true,
  type: true,
  totalMarks: true,
  percentage: true,
  questions: { orderBy: { id: 'asc' }, select: QUESTION_SELECT },
  assessmentVersions: {
    orderBy: { id: 'asc' },
    select: {
      versionQuestions: {
        orderBy: { order: 'asc' },
        select: { question: { select: QUESTION_SELECT } },
      },
    },
  },
} satisfies Prisma.AssessmentSelect;

const TOPIC_CLO_SELECT = {
  select: { id: true, topicClos: { select: { cloId: true } } },
} as const;

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
    options: { force?: boolean; userId?: number } = {},
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

    const generated = await runWithAiContext(
      {
        userId: options.userId,
        tenantId,
        purpose: 'clo_analysis_all',
      },
      () =>
        this.courseAIService.analyzeAllCloAchievements({
          passRatePercent: report.thresholdPercent,
          clos: closPayload,
        }),
    );

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

  /**
   * Teacher-confirmed scans only, newest confirmation first, reduced to one
   * result per student per assessment.
   */
  private async loadStudentScans(
    tenantId: number,
    assessmentIds: number[],
    roster: RosterStudent[],
  ): Promise<SelectedScan[]> {
    if (assessmentIds.length === 0) return [];
    const scans = await this.prisma.gradingScan.findMany({
      where: {
        tenantId,
        assessmentId: { in: assessmentIds },
        status: 'COMPLETED',
        confirmedAt: { not: null },
      },
      select: {
        id: true,
        assessmentId: true,
        score: true,
        maxScore: true,
        studentId: true,
        matchedStudentCode: true,
        detectedStudentId: true,
        decodedFormId: true,
        questionDetails: true,
      },
      orderBy: [{ confirmedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    });
    return selectStudentScans(scans, roster);
  }

  private async loadCloCourse(tenantId: number, courseId: number) {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, tenantId },
      include: {
        clos: { orderBy: { id: 'asc' } },
        students: {
          select: { id: true, studentId: true, name: true },
          orderBy: { studentId: 'asc' },
        },
        topics: TOPIC_CLO_SELECT,
      },
    });
    if (!course) {
      throw new NotFoundException('Course not found.');
    }
    return course;
  }

  private loadCloAssessments(tenantId: number, courseId: number, assessmentId?: number) {
    return this.prisma.assessment.findMany({
      where: {
        courseId,
        tenantId,
        ...(assessmentId ? { id: assessmentId } : {}),
      },
      select: CLO_ASSESSMENT_SELECT,
    });
  }

  async getCloAchievementReport(
    tenantId: number,
    courseId: number,
    assessmentId?: number,
  ) {
    const course = await this.loadCloCourse(tenantId, courseId);
    const passRatePercent = resolvePassRate(course.passRate);
    const assessments = await this.loadCloAssessments(tenantId, courseId, assessmentId);
    const weights = resolveScopedWeights(assessments, assessmentId);
    const scans = await this.loadStudentScans(
      tenantId,
      assessments.map((assessment) => assessment.id),
      course.students,
    );
    const { cloTotals, cloSources, studentCloScores } = computeCloScores({
      clos: course.clos,
      topics: course.topics,
      assessments,
      weights,
      scans,
    });

    const assessedKeys = Array.from(new Set(scans.map((scan) => scan.studentKey)));
    const totalStudents = assessedKeys.length;

    const rows = course.clos
      .map((clo, index) => {
        const rawMax = cloTotals.get(clo.id) ?? 0;
        const rawThreshold = rawMax * (passRatePercent / 100);
        const maxScore = round2(rawMax);
        const thresholdScore = round2(rawThreshold);
        const scoresMap = studentCloScores.get(clo.id) ?? new Map<string, number>();
        const studentScores = assessedKeys.map((key) => scoresMap.get(key) ?? 0);
        const hasGradingData = totalStudents > 0 && rawMax > 0;

        const avgScore = hasGradingData
          ? round2(studentScores.reduce((sum, score) => sum + score, 0) / totalStudents)
          : null;
        const studentsMet = hasGradingData
          ? studentScores.filter((score) => score + 1e-9 >= rawThreshold).length
          : 0;
        const achievementRate = hasGradingData
          ? round1((studentsMet / totalStudents) * 100)
          : null;
        const achieved = achievementRate != null && achievementRate >= passRatePercent;

        return {
          id: clo.id,
          code: clo.code || `CLO ${index + 1}`,
          programCLOCode: clo.programCLOCode || null,
          category: clo.category || null,
          description: clo.description,
          maxScore,
          thresholdScore,
          thresholdLabel: maxScore > 0 ? `${thresholdScore} / ${maxScore}` : '—',
          avgScore,
          avgScoreLabel:
            avgScore != null && maxScore > 0
              ? `${avgScore} / ${maxScore}`
              : maxScore > 0
                ? `— / ${maxScore}`
                : '—',
          avgPercent:
            avgScore != null && maxScore > 0 ? round1((avgScore / maxScore) * 100) : null,
          achievementRate,
          studentsMet,
          totalStudents,
          achieved,
          statusLabel: achieved ? 'Achieved' : 'Not achieved',
          assessmentSources: cloSources.get(clo.id) ?? [],
          hasGradingData,
        };
      })
      .filter((row) => !assessmentId || row.maxScore > 0);

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
      enrolledCount: course.students.length,
      assessedCount: totalStudents,
      hasGradingData: rows.some((row) => row.hasGradingData),
    };
  }

  async getPloAlignmentReport(
    tenantId: number,
    courseId: number,
    assessmentId?: number,
  ) {
    const cloReport = await this.getCloAchievementReport(
      tenantId,
      courseId,
      assessmentId,
    );
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
          ? round1(rates.reduce((sum, value) => sum + value, 0) / rates.length)
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

  private async loadScoreCourse(tenantId: number, courseId: number, assessmentId?: number) {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, tenantId },
      include: {
        students: { select: { id: true, studentId: true } },
        assessments: {
          where: assessmentId ? { id: assessmentId } : undefined,
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
    return course;
  }

  async getGradeDistributionReport(
    tenantId: number,
    courseId: number,
    assessmentId?: number,
  ) {
    const course = await this.loadScoreCourse(tenantId, courseId, assessmentId);
    const passMarkThreshold = resolvePassRate(course.passRate);
    const weights = resolveScopedWeights(course.assessments, assessmentId);
    const scans = await this.loadStudentScans(
      tenantId,
      course.assessments.map((assessment) => assessment.id),
      course.students,
    );

    const scores = Array.from(computeStudentTotals(scans, weights).values());
    const gradedCount = scores.length;
    const enrolledCount = course.students.length;
    const percentOf = (count: number) =>
      gradedCount > 0 ? round1((count / gradedCount) * 100) : null;

    const bandCounts = new Map<string, number>(GRADE_BANDS.map((band) => [band.grade, 0]));
    for (const score of scores) {
      const band = scoreToGradeBand(score);
      bandCounts.set(band.grade, (bandCounts.get(band.grade) ?? 0) + 1);
    }

    const rows = GRADE_BANDS.map((band) => {
      const count = bandCounts.get(band.grade) ?? 0;
      const achieved = band.min >= passMarkThreshold;
      return {
        grade: band.grade,
        markRange: band.markRange,
        count,
        percentOfClass: percentOf(count) ?? 0,
        gpa: band.gpa,
        statusLabel: achieved ? 'Achieved' : 'Not achieved',
        achieved,
      };
    });

    const highestScore = scores.length > 0 ? Math.max(...scores) : null;
    const lowestScore = scores.length > 0 ? Math.min(...scores) : null;
    const averageScore =
      scores.length > 0 ? round1(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null;

    const highestBand = highestScore != null ? scoreToGradeBand(highestScore) : null;
    const lowestBand = lowestScore != null ? scoreToGradeBand(lowestScore) : null;
    const averageBand = averageScore != null ? scoreToGradeBand(averageScore) : null;

    const failingCount = scores.filter((score) => !isPassingTotal(score, passMarkThreshold)).length;
    const failingPercent = percentOf(failingCount);
    const aaCount = (bandCounts.get('A+') ?? 0) + (bandCounts.get('A') ?? 0);
    const bbCount = (bandCounts.get('B+') ?? 0) + (bandCounts.get('B') ?? 0);
    const aaPercent = percentOf(aaCount);
    const bbPercent = percentOf(bbCount);

    const averageGpa =
      gradedCount > 0
        ? round2(rows.reduce((sum, row) => sum + row.count * row.gpa, 0) / gradedCount)
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
          subtitle: failingPercent != null ? `${failingPercent}% of class` : '—',
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

  async getAssessmentsReport(
    tenantId: number,
    courseId: number,
    assessmentId?: number,
  ) {
    const course = await this.loadScoreCourse(tenantId, courseId, assessmentId);
    const scans = await this.loadStudentScans(
      tenantId,
      course.assessments.map((assessment) => assessment.id),
      course.students,
    );

    const typeOrder: Record<string, number> = {
      MID_TERM_EXAM: 0,
      FINAL_EXAM: 1,
      QUIZ: 2,
      LAB: 3,
      ASSIGNMENT: 4,
      OTHER: 5,
    };

    const orderedAssessments = [...course.assessments].sort((a, b) => {
      const typeDiff = (typeOrder[a.type] ?? 99) - (typeOrder[b.type] ?? 99);
      if (typeDiff !== 0) return typeDiff;
      return (a.title || '').localeCompare(b.title || '');
    });

    const summaries = orderedAssessments.map((assessment) => {
      const assessmentScans = scans.filter((scan) => scan.assessmentId === assessment.id);
      const maxScore = resolveAssessmentMax(
        assessment.totalMarks,
        assessmentScans.map((scan) => scan.maxScore),
      );
      const scores = assessmentScans.map((scan) => scaleScanScore(scan, maxScore));
      return { assessment, maxScore, scores };
    });

    const distributions = summaries
      .map(({ assessment, maxScore, scores }) => {
        if (maxScore <= 0 || scores.length === 0) return null;

        const bands = this.buildAssessmentScoreBands(maxScore);
        const bandCounts = new Map(bands.map((band) => [band.key, 0]));
        for (const score of scores) {
          const band = this.scoreToAssessmentBand(score, bands);
          bandCounts.set(band.key, (bandCounts.get(band.key) ?? 0) + 1);
        }

        const gradedCount = scores.length;
        const rows = bands.map((band) => {
          const count = bandCounts.get(band.key) ?? 0;
          return {
            key: band.key,
            label: band.label,
            count,
            percentOfClass: round1((count / gradedCount) * 100),
          };
        });

        const focusBandKey =
          rows
            .filter((row) => row.count > 0)
            .sort((a, b) => b.count - a.count || b.percentOfClass - a.percentOfClass)[0]
            ?.key ??
          rows[0]?.key ??
          null;

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

    const components = summaries
      .map(({ assessment, maxScore, scores }) => {
        if (maxScore <= 0) return null;
        const averageScore =
          scores.length > 0
            ? round1(scores.reduce((sum, score) => sum + score, 0) / scores.length)
            : null;
        return {
          assessmentId: assessment.id,
          title: assessment.title || `Assessment ${assessment.id}`,
          type: assessment.type,
          label: this.formatAssessmentComponentLabel(assessment.title, assessment.type, maxScore),
          maxScore,
          averageScore,
          averagePercent: averageScore != null ? round1((averageScore / maxScore) * 100) : null,
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

  async getStudentResultsReport(
    tenantId: number,
    courseId: number,
    assessmentId?: number,
  ) {
    const course = await this.loadCloCourse(tenantId, courseId);
    const passRatePercent = resolvePassRate(course.passRate);
    const assessments = await this.loadCloAssessments(tenantId, courseId, assessmentId);

    const typeOrder: Record<string, number> = {
      QUIZ: 0,
      ASSIGNMENT: 1,
      OTHER: 2,
      MID_TERM_EXAM: 3,
      LAB: 4,
      FINAL_EXAM: 5,
    };

    const orderedAssessments = [...assessments].sort((a, b) => {
      const typeDiff = (typeOrder[a.type] ?? 99) - (typeOrder[b.type] ?? 99);
      if (typeDiff !== 0) return typeDiff;
      return (a.title || '').localeCompare(b.title || '');
    });

    const weights = resolveScopedWeights(orderedAssessments, assessmentId);
    const scans = await this.loadStudentScans(
      tenantId,
      orderedAssessments.map((assessment) => assessment.id),
      course.students,
    );

    const scanByStudent = new Map<string, Map<number, SelectedScan>>();
    for (const scan of scans) {
      const byAssessment = scanByStudent.get(scan.studentKey) ?? new Map<number, SelectedScan>();
      byAssessment.set(scan.assessmentId, scan);
      scanByStudent.set(scan.studentKey, byAssessment);
    }

    const components = orderedAssessments.map((assessment) => {
      const maxScore = resolveAssessmentMax(
        assessment.totalMarks,
        scans
          .filter((scan) => scan.assessmentId === assessment.id)
          .map((scan) => scan.maxScore),
      );
      return {
        assessmentId: assessment.id,
        title: assessment.title || `Assessment ${assessment.id}`,
        type: assessment.type,
        label: this.formatAssessmentComponentLabel(assessment.title, assessment.type, maxScore),
        shortLabel: this.formatAssessmentShortLabel(assessment.title, assessment.type),
        maxScore,
        weight: weights.get(assessment.id) ?? 0,
        color: this.assessmentTypeColor(assessment.type),
      };
    });

    const { cloTotals, studentCloScores } = computeCloScores({
      clos: course.clos,
      topics: course.topics,
      assessments: orderedAssessments,
      weights,
      scans,
    });

    const cloColumns = course.clos.map((clo, index) => {
      const rawMax = cloTotals.get(clo.id) ?? 0;
      return {
        id: clo.id,
        code: clo.code || `CLO ${index + 1}`,
        maxScore: round2(rawMax),
        thresholdScore: round2(rawMax * (passRatePercent / 100)),
        color: this.cloDotColor(index),
      };
    });

    const totals = computeStudentTotals(scans, weights);

    const buildRow = (student: { id: number | null; studentId: string; name: string | null }) => {
      const studentScans = scanByStudent.get(student.studentId) ?? new Map<number, SelectedScan>();
      const total = totals.get(student.studentId) ?? null;
      const gradeBand = total != null ? scoreToGradeBand(total) : null;
      return {
        key: student.studentId,
        studentDbId: student.id,
        studentId: student.studentId,
        name: student.name,
        components: components.map((component) => {
          const scan = studentScans.get(component.assessmentId);
          return {
            assessmentId: component.assessmentId,
            score: scan ? round2(scaleScanScore(scan, component.maxScore)) : null,
            maxScore: component.maxScore || scan?.maxScore || 0,
            percent: scan ? round1((scan.score / scan.maxScore) * 100) : null,
          };
        }),
        total,
        grade: gradeBand?.grade ?? null,
        gradeColor: gradeBand ? this.gradeBadgeColor(gradeBand.grade) : null,
        cloAchievements: cloColumns.map((clo) => {
          const earned = studentCloScores.get(clo.id)?.get(student.studentId) ?? 0;
          const rawThreshold = (cloTotals.get(clo.id) ?? 0) * (passRatePercent / 100);
          return {
            cloId: clo.id,
            code: clo.code,
            earned: round2(earned),
            threshold: clo.thresholdScore,
            achieved: total != null && clo.maxScore > 0 && earned + 1e-9 >= rawThreshold,
            color: clo.color,
          };
        }),
        hasGradingData: total != null,
      };
    };

    const roster =
      course.students.length > 0
        ? course.students.map((student) => ({
            id: student.id,
            studentId: rosterKey(student),
            name: student.name || null,
          }))
        : Array.from(scanByStudent.keys())
            .sort()
            .map((key) => ({ id: null, studentId: key, name: null }));

    const allRows = roster.map(buildRow);
    const gradedRows = allRows
      .filter((row) => row.hasGradingData)
      .sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
    const displayRows = gradedRows.length > 0 ? gradedRows : allRows;

    const totalValues = gradedRows.map((row) => row.total as number);
    const average =
      totalValues.length > 0
        ? round1(totalValues.reduce((sum, value) => sum + value, 0) / totalValues.length)
        : null;
    const highest = totalValues.length > 0 ? Math.max(...totalValues) : null;
    const lowest = totalValues.length > 0 ? Math.min(...totalValues) : null;
    const passingCount = totalValues.filter((value) => isPassingTotal(value, passRatePercent)).length;
    const passing =
      totalValues.length > 0 ? round1((passingCount / totalValues.length) * 100) : null;

    const distributionBands = [
      { key: '0-49', label: '0-49', min: 0, max: 49 },
      { key: '50-59', label: '50-59', min: 50, max: 59 },
      { key: '60-69', label: '60-69', min: 60, max: 69 },
      { key: '70-79', label: '70-79', min: 70, max: 79 },
      { key: '80-89', label: '80-89', min: 80, max: 89 },
      { key: '90-100', label: '90-100', min: 90, max: 100 },
    ];

    const distribution = distributionBands.map((band) => {
      const count = totalValues.filter((value) => {
        const rounded = Math.round(value);
        return rounded >= band.min && rounded <= band.max;
      }).length;
      return {
        ...band,
        count,
        percent: totalValues.length > 0 ? round1((count / totalValues.length) * 100) : 0,
      };
    });

    const focusBandKey =
      [...distribution].sort((a, b) => b.count - a.count)[0]?.key ??
      distribution[distribution.length - 1]?.key ??
      null;

    return {
      passRatePercent,
      hasGradingData: gradedRows.length > 0,
      enrolledCount: course.students.length,
      components,
      cloColumns,
      kpis: {
        showing: gradedRows.length || displayRows.length,
        average,
        highest,
        lowest,
        passing,
      },
      rows: displayRows,
      distribution,
      focusBandKey,
    };
  }

  private formatAssessmentShortLabel(
    title: string | null | undefined,
    type: string,
  ) {
    const raw = String(title || '').trim();
    const typeFallback: Record<string, string> = {
      MID_TERM_EXAM: 'Midterm',
      FINAL_EXAM: 'Final',
      QUIZ: 'Quizzes',
      LAB: 'Lab',
      ASSIGNMENT: 'Assign',
      OTHER: 'Other',
    };
    if (!raw) return typeFallback[type] ?? 'Assessment';
    if (/quiz/i.test(raw)) return 'Quizzes';
    if (/assign/i.test(raw)) return 'Assign';
    if (/lab/i.test(raw)) return 'Lab';
    if (/mid/i.test(raw)) return 'Midterm';
    if (/final/i.test(raw)) return 'Final';
    if (/project/i.test(raw)) return 'Project';
    return raw.length > 12 ? `${raw.slice(0, 10).trim()}…` : raw;
  }

  private assessmentTypeColor(type: string) {
    const colors: Record<string, string> = {
      QUIZ: '#5B3A9E',
      ASSIGNMENT: '#E07A3A',
      OTHER: '#64748B',
      MID_TERM_EXAM: '#3B82F6',
      LAB: '#22C55E',
      FINAL_EXAM: '#A16207',
    };
    return colors[type] ?? '#5B3A9E';
  }

  private cloDotColor(index: number) {
    const colors = [
      '#1D4ED8',
      '#0D9488',
      '#16A34A',
      '#EAB308',
      '#EA580C',
      '#DC2626',
      '#5B3A9E',
      '#0891B2',
    ];
    return colors[index % colors.length];
  }

  private gradeBadgeColor(grade: string) {
    const colors: Record<string, { bg: string; text: string }> = {
      'A+': { bg: '#CCFBF1', text: '#0F766E' },
      A: { bg: '#CFFAFE', text: '#0E7490' },
      'B+': { bg: '#DBEAFE', text: '#1D4ED8' },
      B: { bg: '#E0E7FF', text: '#4338CA' },
      'C+': { bg: '#FEF3C7', text: '#B45309' },
      F: { bg: '#FEE2E2', text: '#B91C1C' },
    };
    return colors[grade] ?? { bg: '#F1F5F9', text: '#475569' };
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
      ASSIGNMENT: 'Assign',
      OTHER: 'Other',
    };

    let short = raw;
    if (!short) {
      short = typeFallback[type] ?? 'Assessment';
    } else if (short.length > 22) {
      if (/quiz/i.test(short)) short = 'Quizzes';
      else if (/assign/i.test(short)) short = 'Assign';
      else if (/lab/i.test(short)) short = 'Lab';
      else if (/project/i.test(short)) short = 'Project';
      else if (/mid/i.test(short)) short = 'Midterm';
      else if (/final/i.test(short)) short = 'Final';
      else short = `${short.slice(0, 18).trim()}…`;
    }

    return `${short} /${maxScore}`;
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

  /** Fractional scores between two labelled ranges belong to the lower one (e.g. 14.5 → "10-14"). */
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
    for (const [index, band] of bands.entries()) {
      const next = bands[index + 1];
      if (band.mode === 'lt' && score < band.max) return band;
      if (band.mode === 'gt' && score > band.min) return band;
      if (band.mode === 'range' && score >= band.min) {
        const upper = next && next.mode === 'range' ? next.min : band.max;
        if (next && next.mode === 'range' ? score < upper : score <= upper) return band;
      }
    }
    return bands[bands.length - 1];
  }
}
