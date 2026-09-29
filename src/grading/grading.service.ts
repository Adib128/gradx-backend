import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from 'prisma/prisma.service';
import { OpenCvGradingService } from './opencv-grading.service';
import { NodeGraderService } from './node-grader.service';
import { SHEET_CONFIG } from './sheet-config';
import {
  buildGraderSheetConfigForQuestions,
  isTrueFalseQuestion,
  orderQuestionsForSheet,
  resolvePrintedIdDigits,
} from './answer-sheet-layout';
import * as XLSX from 'xlsx';

type RequestUser = {
  userId: number;
  tenantId: number;
};

const ANCHOR_NAMES = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] as const;
type AnchorHints = Record<(typeof ANCHOR_NAMES)[number], { x: number; y: number }>;

/**
 * Registration-mark centres the mobile camera already located, normalised to
 * the uploaded image (0..1). Invalid input is ignored and the grader searches
 * the image corners on its own.
 */
function parseAnchorHints(raw: unknown): AnchorHints | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const hints = {} as AnchorHints;
  for (const name of ANCHOR_NAMES) {
    const point = (value as Record<string, unknown>)[name] as
      | { x?: unknown; y?: unknown }
      | undefined;
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
      return null;
    }
    hints[name] = { x, y };
  }
  return hints;
}

@Injectable()
export class GradingService {
  private readonly logger = new Logger(GradingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openCvService: OpenCvGradingService,
    private readonly nodeGrader: NodeGraderService,
  ) {}

  async createScan(
    user: RequestUser,
    assessmentId: number,
    file: Express.Multer.File,
    anchorHintsRaw?: unknown,
  ) {
    if (!file) {
      throw new InternalServerErrorException('Scan image is required.');
    }

    const assessment = await this.prisma.assessment.findFirst({
      where: { id: assessmentId, tenantId: user.tenantId },
      include: {
        questions: {
          include: { questionOptions: { orderBy: { order: 'asc' } } },
          orderBy: { id: 'asc' },
        },
        assessmentVersions: {
          orderBy: { id: 'asc' },
          include: {
            versionQuestions: {
              orderBy: { order: 'asc' },
              include: {
                question: {
                  include: { questionOptions: { orderBy: { order: 'asc' } } },
                },
              },
            },
          },
        },
      },
    });

    if (!assessment) throw new NotFoundException('Assessment not found.');

    // Persist image to disk
    const uploadDir = join(process.cwd(), 'tmp', 'grading-scans');
    await mkdir(uploadDir, { recursive: true });
    const fileName = `scan-${assessmentId}-${Date.now()}-${file.originalname.replace(/\s+/g, '-')}`;
    const imagePath = join(uploadDir, fileName);
    await writeFile(imagePath, file.buffer);

    const created = await this.prisma.gradingScan.create({
      data: {
        assessmentId,
        tenantId: user.tenantId,
        graderUserId: user.userId,
        imagePath,
        status: 'PROCESSING',
      },
    });

    // -----------------------------------------------------------------------
    // Grading pipeline:
    //  1. Try Python/OpenCV (best quality)
    //  2. Fall back to Node.js/sharp (always available)
    // -----------------------------------------------------------------------
    const numIdDigits = resolvePrintedIdDigits(assessment.numberOfStudentIdDigits);

    // Every version shares one printed layout (versions only reorder questions
    // within the MCQ / True-False bands), so any version defines the geometry.
    const layoutVersion = assessment.assessmentVersions.find(
      (version) => version.versionQuestions.length > 0,
    );
    const sheetLayout = buildGraderSheetConfigForQuestions({
      questions: layoutVersion
        ? layoutVersion.versionQuestions.map((vq) => vq.question)
        : assessment.questions,
      numberOfStudentIdDigits: assessment.numberOfStudentIdDigits,
      studentIdPosition: assessment.studentIdPosition,
    });
    const anchorHints = parseAnchorHints(anchorHintsRaw);

    let processResult: {
      answers: Record<string, string>;
      confidence: number;
      decodedFormId: number | null;
      questionDetails?: unknown[];
      detectedStudentId?: string | null;
    } | null = null;
    let processError: string | null = null;

    const graderConfig = {
      ...SHEET_CONFIG,
      ...(sheetLayout ?? {}),
      numIdDigits,
      ...(anchorHints ? { anchorHints } : {}),
    };

    // Try Python OpenCV first
    try {
      const pyResult = await this.openCvService.processAnswerSheet(
        imagePath,
        JSON.stringify(graderConfig),
      );
      if (pyResult && !pyResult.error) {
        processResult = pyResult;
        const sidDebug = (pyResult as any).debug?.studentIdDebug;
        this.logger.log(
          `Python grader used (conf=${pyResult.confidence}, studentId=${pyResult.detectedStudentId}, blanks=${sidDebug?.blanks ?? '?'})`,
        );
        if (sidDebug) {
          this.logger.debug(`StudentID debug: ${JSON.stringify(sidDebug)}`);
        }
      }
    } catch (err) {
      this.logger.warn(
        `Python grader failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Fallback: Node.js sharp grader
    if (!processResult || (processResult.confidence ?? 0) < 0.2) {
      try {
        const nodeResult = await this.nodeGrader.gradeSheet(imagePath, numIdDigits, {
          answerGrid: sheetLayout?.answerGrid,
          studentIdGrid: sheetLayout?.studentIdGrid,
        });
        processResult = nodeResult;
        this.logger.log(`Node grader used (conf=${nodeResult.confidence}, studentId=${nodeResult.detectedStudentId})`);
      } catch (err) {
        processError =
          err instanceof Error ? err.message : 'Grading processing failed';
        processResult = { answers: {}, confidence: 0, decodedFormId: null, questionDetails: [], detectedStudentId: null };
      }
    }

    // Score against the answer key for the machine-detected paper version.
    // The marker stores a one-based version index (A=1, B=2, ...), matching
    // assessmentVersions' creation/id order. Old sheets without a marker keep
    // the previous Version A fallback.
    const decodedVersionIndex =
      processResult!.decodedFormId != null
        ? processResult!.decodedFormId - 1
        : 0;
    const detectedVersion =
      decodedVersionIndex >= 0
        ? assessment.assessmentVersions[decodedVersionIndex]
        : undefined;
    const scoringVersion =
      detectedVersion ?? assessment.assessmentVersions[0];
    // Printed number N is the N-th question of the sheet order (MCQ band, then
    // True/False band) of the version the student received.
    const orderedQuestions = orderQuestionsForSheet(
      scoringVersion?.versionQuestions?.length
        ? scoringVersion.versionQuestions.map((vq) => vq.question)
        : assessment.questions,
    );
    const masterNumberById = new Map(
      orderQuestionsForSheet(assessment.questions).map(
        (question, index) => [question.id, index + 1] as const,
      ),
    );
    const scoringVersionNumber = scoringVersion
      ? assessment.assessmentVersions.indexOf(scoringVersion) + 1
      : null;

    if (
      processResult!.decodedFormId != null &&
      !detectedVersion &&
      assessment.assessmentVersions.length > 0
    ) {
      this.logger.warn(
        `Decoded version ${processResult!.decodedFormId} is outside assessment ${assessmentId}'s ${assessment.assessmentVersions.length} versions; using Version A`,
      );
    }

    // A row with more than one mark earns no credit, even if the darkest
    // mark is the key.
    const scoredAnswers = { ...processResult!.answers };
    for (const detail of (processResult!.questionDetails as Array<Record<string, unknown>>) ?? []) {
      if (detail['status'] === 'multiple') scoredAnswers[String(detail['question'])] = '';
    }
    const { score, maxScore, questionResults } = this.gradeAnswers(
      scoredAnswers,
      orderedQuestions,
    );

    // Enrich grader questionDetails with per-question correctness and answer key
    const enrichedDetails = (
      (processResult!.questionDetails as Array<Record<string, unknown>>) ?? []
    ).map((qd) => {
      const printedNumber = qd['question'] as number;
      const qr = questionResults.find((r) => r.question === printedNumber);
      const question = orderedQuestions[printedNumber - 1];
      return {
        ...qd,
        isCorrect: qr?.isCorrect ?? false,
        correctAnswer: qr?.correctAnswer ?? null,
        questionId: question?.id ?? null,
        masterNumber: question ? (masterNumberById.get(question.id) ?? null) : null,
        versionNumber: scoringVersionNumber,
      };
    });

    // Try to match detected student ID against students table
    const rawStudentId = processResult!.detectedStudentId ?? null;
    let matchedStudentCode: string | null = null;
    if (rawStudentId) {
      const student = await this.prisma.student.findUnique({
        where: { studentId: rawStudentId },
        select: { studentId: true },
      });
      matchedStudentCode = student?.studentId ?? null;
    }

    return this.prisma.gradingScan.update({
      where: { id: created.id },
      data: {
        status: processError ? 'FAILED' : 'COMPLETED',
        confidence: processResult!.confidence,
        decodedFormId: processResult!.decodedFormId,
        detectedAnswers: processResult!.answers,
        questionDetails: enrichedDetails,
        score,
        maxScore,
        errorMessage: processError,
        detectedStudentId: rawStudentId,
        matchedStudentCode,
      },
    });
  }

  async getScan(user: RequestUser, scanId: number) {
    const scan = await this.prisma.gradingScan.findFirst({
      where: { id: scanId, tenantId: user.tenantId },
      include: {
        assessment: { select: { id: true, title: true, type: true } },
      },
    });
    if (!scan) throw new NotFoundException('Grading scan not found.');
    return scan;
  }

  listScansByAssessment(user: RequestUser, assessmentId: number) {
    return this.prisma.gradingScan.findMany({
      where: {
        tenantId: user.tenantId,
        assessmentId,
        status: 'COMPLETED',
      },
      select: {
        id: true,
        score: true,
        maxScore: true,
        confidence: true,
        decodedFormId: true,
        detectedStudentId: true,
        matchedStudentCode: true,
        confirmedAt: true,
        createdAt: true,
        questionDetails: true,
        status: true,
        student: {
          select: { id: true, name: true, studentId: true, section: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Confirm a grading scan: link to the detected student and timestamp the confirmation. */
  async confirmScan(user: RequestUser, scanId: number) {
    const scan = await this.prisma.gradingScan.findFirst({
      where: { id: scanId, tenantId: user.tenantId },
    });
    if (!scan) throw new NotFoundException('Grading scan not found.');

    // Resolve the student FK from the detected / matched student code
    let studentId: number | null = scan.studentId ?? null;
    const code = scan.matchedStudentCode ?? scan.detectedStudentId;
    if (!studentId && code) {
      const student = await this.prisma.student.findUnique({
        where: { studentId: code },
        select: { id: true },
      });
      studentId = student?.id ?? null;
    }

    const confirmed = await this.prisma.gradingScan.update({
      where: { id: scanId },
      data: {
        confirmedAt: new Date(),
        ...(studentId ? { studentId } : {}),
        // Ensure matchedStudentCode is set even if it wasn't before
        ...(code && !scan.matchedStudentCode ? { matchedStudentCode: code } : {}),
        status: 'COMPLETED',
      },
      include: {
        student: {
          select: { id: true, name: true, studentId: true, section: true },
        },
        assessment: {
          select: { id: true, title: true, type: true },
        },
      },
    });

    return { success: true, scan: confirmed };
  }

  /**
   * Student score vs. maximum score per CLO for one scan. Uses the course
   * reports' weighting: each question is worth its share of the assessment's
   * total marks, split evenly across its CLOs (question CLO links, otherwise
   * its topic's CLOs), and a correct answer earns the full share.
   */
  async getScanCloBreakdown(user: RequestUser, scanId: number) {
    const scan = await this.prisma.gradingScan.findFirst({
      where: { id: scanId, tenantId: user.tenantId },
      select: {
        id: true,
        score: true,
        decodedFormId: true,
        questionDetails: true,
        assessment: {
          select: {
            id: true,
            totalMarks: true,
            course: {
              select: {
                clos: {
                  orderBy: { id: 'asc' },
                  select: { id: true, code: true, description: true },
                },
                topics: {
                  select: { id: true, topicClos: { select: { cloId: true } } },
                },
              },
            },
            questions: {
              orderBy: { id: 'asc' },
              select: {
                id: true,
                type: true,
                points: true,
                topicId: true,
                questionClos: { select: { cloId: true } },
              },
            },
            assessmentVersions: {
              orderBy: { id: 'asc' },
              select: {
                versionQuestions: {
                  orderBy: { order: 'asc' },
                  select: {
                    question: {
                      select: {
                        id: true,
                        type: true,
                        points: true,
                        topicId: true,
                        questionClos: { select: { cloId: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!scan) throw new NotFoundException('Grading scan not found.');

    const assessment = scan.assessment;
    const details = Array.isArray(scan.questionDetails)
      ? (scan.questionDetails as Array<Record<string, unknown>>)
      : [];

    const versions = assessment.assessmentVersions;
    const versionNumber = Number(details[0]?.versionNumber);
    const version =
      (Number.isInteger(versionNumber) && versionNumber > 0
        ? versions[versionNumber - 1]
        : undefined) ??
      (scan.decodedFormId != null ? versions[scan.decodedFormId - 1] : undefined) ??
      versions[0];
    const orderedQuestions = orderQuestionsForSheet(
      version?.versionQuestions?.length
        ? version.versionQuestions.map((vq) => vq.question)
        : assessment.questions,
    );

    const topicCloMap = new Map<number, number[]>(
      (assessment.course?.topics ?? []).map((topic) => [
        topic.id,
        topic.topicClos.map((link) => link.cloId),
      ]),
    );
    const courseClos = assessment.course?.clos ?? [];
    const courseCloIds = new Set(courseClos.map((clo) => clo.id));
    const resolveCloIds = (question: (typeof orderedQuestions)[number]) => {
      const linked = question.questionClos.map((link) => link.cloId);
      const ids = linked.length > 0
        ? linked
        : question.topicId != null
          ? (topicCloMap.get(question.topicId) ?? [])
          : [];
      return Array.from(new Set(ids)).filter((id) => courseCloIds.has(id));
    };

    const weights = orderedQuestions.map((question) =>
      question.points > 0 ? question.points : 1,
    );
    const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
    const examTotal =
      assessment.totalMarks && assessment.totalMarks > 0
        ? assessment.totalMarks
        : weightSum;

    const hasDetails = details.length > 0;
    const detailByQuestion = new Map<number, Record<string, unknown>>();
    for (const detail of details) {
      const number = Number(detail.question);
      if (Number.isFinite(number)) detailByQuestion.set(number, detail);
    }

    type Column = {
      cloId: number | null;
      code: string | null;
      description: string | null;
      questionNumbers: number[];
      maxScore: number;
      studentScore: number;
    };
    const columns = new Map<number | 'none', Column>();
    const columnFor = (cloId: number | null) => {
      const key = cloId ?? 'none';
      let column = columns.get(key);
      if (!column) {
        const clo = cloId != null ? courseClos.find((item) => item.id === cloId) : null;
        column = {
          cloId,
          code: clo?.code ?? null,
          description: clo?.description ?? null,
          questionNumbers: [],
          maxScore: 0,
          studentScore: 0,
        };
        columns.set(key, column);
      }
      return column;
    };

    orderedQuestions.forEach((question, index) => {
      const questionNumber = index + 1;
      const weightedPoints =
        weightSum > 0 ? (weights[index] / weightSum) * examTotal : 0;
      const detail = detailByQuestion.get(questionNumber);
      const earned = detail?.isCorrect === true ? weightedPoints : 0;
      const cloIds = resolveCloIds(question);
      const targets = cloIds.length > 0 ? cloIds : [null];
      for (const cloId of targets) {
        const column = columnFor(cloId);
        column.questionNumbers.push(questionNumber);
        column.maxScore += weightedPoints / targets.length;
        column.studentScore += earned / targets.length;
      }
    });

    const round = (value: number) => Math.round(value * 100) / 100;
    const cloOrder = new Map(courseClos.map((clo, index) => [clo.id, index]));
    const rows = Array.from(columns.values())
      .sort(
        (a, b) =>
          (a.cloId == null ? Infinity : (cloOrder.get(a.cloId) ?? 0)) -
          (b.cloId == null ? Infinity : (cloOrder.get(b.cloId) ?? 0)),
      )
      .map((column) => ({
        ...column,
        maxScore: round(column.maxScore),
        studentScore: hasDetails ? round(column.studentScore) : null,
      }));

    return {
      scanId: scan.id,
      hasQuestionDetails: hasDetails,
      columns: rows,
      total: {
        maxScore: round(examTotal),
        studentScore: hasDetails
          ? round(
              Array.from(columns.values()).reduce(
                (sum, column) => sum + column.studentScore,
                0,
              ),
            )
          : scan.score,
      },
    };
  }

  async deleteScan(user: RequestUser, scanId: number) {
    const scan = await this.prisma.gradingScan.findFirst({
      where: { id: scanId, tenantId: user.tenantId },
    });
    if (!scan) throw new NotFoundException('Grading scan not found.');

    await this.prisma.gradingScan.delete({ where: { id: scanId } });
    return { success: true };
  }

  /** Full grading history for the tenant (all confirmed scans with student + assessment details). */
  getGradingHistory(user: RequestUser) {
    return this.prisma.gradingScan.findMany({
      where: {
        tenantId: user.tenantId,
        status: 'COMPLETED',
      },
      select: {
        id: true,
        score: true,
        maxScore: true,
        confidence: true,
        decodedFormId: true,
        detectedStudentId: true,
        matchedStudentCode: true,
        confirmedAt: true,
        createdAt: true,
        questionDetails: true,
        student: {
          select: { id: true, name: true, studentId: true, section: true },
        },
        assessment: {
          select: {
            id: true,
            title: true,
            type: true,
            courseId: true,
            code: true,
            academicYear: true,
            semester: true,
            course: {
              select: {
                id: true,
                title: true,
                code: true,
                academicYear: true,
                semester: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  }

  /**
   * Validate grading Excel without inserting.
   * Expected columns:
   * course_code | assessment_code | student_id | student_name | score | max_score | confidence
   */
  async validateExcel(user: RequestUser, file: Express.Multer.File) {
    const outcome = await this.processGradingExcel(user, file, { dryRun: true });
    return {
      total: outcome.total,
      valid: outcome.valid,
      invalid: outcome.failed,
      canImport: outcome.total > 0 && outcome.failed.length === 0,
      preview: outcome.preview,
    };
  }

  /**
   * Import confirmed grading rows from Excel (after validation).
   * Rejects the whole file if any row is invalid.
   */
  async importExcel(user: RequestUser, file: Express.Multer.File) {
    const outcome = await this.processGradingExcel(user, file, { dryRun: false });
    if (outcome.failed.length > 0) {
      throw new BadRequestException({
        message: 'Grading import validation failed',
        total: outcome.total,
        valid: outcome.valid,
        invalid: outcome.failed,
        canImport: false,
      });
    }
    return {
      success: outcome.valid,
      failed: outcome.failed,
      total: outcome.total,
    };
  }

  private async processGradingExcel(
    user: RequestUser,
    file: Express.Multer.File,
    options: { dryRun: boolean },
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Excel file is required');
    }

    const workbook = XLSX.read(file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      throw new BadRequestException('Excel file is empty');
    }
    const sheet = workbook.Sheets[sheetName];
    const sheetRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      defval: '',
    });

    const hasHeader = this.isGradingImportHeader(sheetRows[0]);
    const rows = sheetRows.slice(hasHeader ? 1 : 0).map((row, index) => ({
      rowNumber: index + (hasHeader ? 2 : 1),
      courseCode: this.cellToString(row[0]),
      assessmentCode: this.cellToString(row[1]),
      studentCode: this.cellToString(row[2]),
      studentName: this.cellToString(row[3]),
      score: this.cellToNumber(row[4]),
      maxScore: this.cellToNumber(row[5]),
      confidence: this.normalizeConfidence(this.cellToNumber(row[6])),
    }));

    if (!rows.length) {
      throw new BadRequestException('Excel file has no data rows');
    }

    const failed: { row: number; reason: string }[] = [];
    const preview: Array<{
      row: number;
      courseCode: string;
      assessmentCode: string;
      studentId: string;
      studentName: string;
      score: number;
      maxScore: number;
      studentAction: 'existing' | 'create';
    }> = [];
    let valid = 0;

    const courseCache = new Map<
      string,
      { id: number; title: string; code: string | null } | null
    >();
    const assessmentCache = new Map<
      string,
      {
        id: number;
        title: string;
        code: string;
        courseId: number;
        totalMarks: number | null;
      } | null
    >();

    type PreparedRow = {
      rowNumber: number;
      course: { id: number; title: string; code: string | null };
      assessment: {
        id: number;
        title: string;
        code: string;
        courseId: number;
        totalMarks: number | null;
      };
      studentCode: string;
      studentName: string;
      score: number;
      maxScore: number;
      confidence: number | null;
      studentAction: 'existing' | 'create';
      existingStudentId?: number;
    };

    const prepared: PreparedRow[] = [];

    for (const row of rows) {
      try {
        if (!row.courseCode) {
          failed.push({ row: row.rowNumber, reason: 'Missing course_code' });
          continue;
        }
        if (!row.assessmentCode) {
          failed.push({
            row: row.rowNumber,
            reason: 'Missing assessment_code',
          });
          continue;
        }
        if (!row.studentCode) {
          failed.push({ row: row.rowNumber, reason: 'Missing student_id' });
          continue;
        }
        if (row.score == null || !Number.isFinite(row.score)) {
          failed.push({
            row: row.rowNumber,
            reason: 'Missing or invalid score',
          });
          continue;
        }

        const courseKey = row.courseCode.toLowerCase();
        let course = courseCache.get(courseKey);
        if (course === undefined) {
          const matches = await this.prisma.course.findMany({
            where: {
              tenantId: user.tenantId,
              deletedAt: null,
              code: { equals: row.courseCode, mode: 'insensitive' },
            },
            select: { id: true, title: true, code: true },
            take: 2,
          });
          if (matches.length === 0) {
            course = null;
          } else if (matches.length > 1) {
            failed.push({
              row: row.rowNumber,
              reason: `Multiple courses found for code ${row.courseCode}`,
            });
            continue;
          } else {
            course = matches[0];
          }
          courseCache.set(courseKey, course);
        }

        if (!course) {
          failed.push({
            row: row.rowNumber,
            reason: `Course not found for code ${row.courseCode}`,
          });
          continue;
        }

        const assessmentKey = row.assessmentCode.toLowerCase();
        let assessment = assessmentCache.get(assessmentKey);
        if (assessment === undefined) {
          const matches = await this.prisma.assessment.findMany({
            where: {
              tenantId: user.tenantId,
              code: { equals: row.assessmentCode, mode: 'insensitive' },
            },
            select: {
              id: true,
              title: true,
              code: true,
              courseId: true,
              totalMarks: true,
            },
            take: 2,
          });
          if (matches.length === 0) {
            assessment = null;
          } else if (matches.length > 1) {
            failed.push({
              row: row.rowNumber,
              reason: `Multiple assessments found for code ${row.assessmentCode}`,
            });
            continue;
          } else {
            assessment = matches[0];
          }
          assessmentCache.set(assessmentKey, assessment);
        }

        if (!assessment) {
          failed.push({
            row: row.rowNumber,
            reason: `Assessment not found for code ${row.assessmentCode}`,
          });
          continue;
        }

        if (assessment.courseId !== course.id) {
          failed.push({
            row: row.rowNumber,
            reason: `Assessment ${row.assessmentCode} does not belong to course ${row.courseCode}`,
          });
          continue;
        }

        const maxScore =
          row.maxScore != null &&
          Number.isFinite(row.maxScore) &&
          row.maxScore > 0
            ? row.maxScore
            : assessment.totalMarks != null && assessment.totalMarks > 0
              ? assessment.totalMarks
              : null;

        if (maxScore == null) {
          failed.push({
            row: row.rowNumber,
            reason: 'Missing max_score (and assessment has no totalMarks)',
          });
          continue;
        }

        if (row.score < 0 || row.score > maxScore) {
          failed.push({
            row: row.rowNumber,
            reason: `Score ${row.score} is outside 0..${maxScore}`,
          });
          continue;
        }

        const existingStudent = await this.prisma.student.findUnique({
          where: { studentId: row.studentCode },
          select: { id: true, studentId: true, courseId: true },
        });

        let studentAction: 'existing' | 'create' = 'existing';
        if (!existingStudent) {
          if (!row.studentName) {
            failed.push({
              row: row.rowNumber,
              reason: `Student ${row.studentCode} not found (provide student_name to create)`,
            });
            continue;
          }
          studentAction = 'create';
        }

        valid += 1;
        const preparedRow: PreparedRow = {
          rowNumber: row.rowNumber,
          course,
          assessment,
          studentCode: row.studentCode,
          studentName: row.studentName || '',
          score: row.score,
          maxScore,
          confidence: row.confidence,
          studentAction,
          existingStudentId: existingStudent?.id,
        };
        prepared.push(preparedRow);

        if (preview.length < 8) {
          preview.push({
            row: row.rowNumber,
            courseCode: course.code || row.courseCode,
            assessmentCode: assessment.code,
            studentId: row.studentCode,
            studentName: row.studentName || '',
            score: row.score,
            maxScore,
            studentAction,
          });
        }
      } catch (error) {
        this.logger.warn(
          `Grading import row ${row.rowNumber} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        failed.push({ row: row.rowNumber, reason: 'Unexpected error' });
      }
    }

    if (!options.dryRun && failed.length === 0) {
      for (const row of prepared) {
        let studentId = row.existingStudentId;
        if (row.studentAction === 'create') {
          const created = await this.prisma.student.create({
            data: {
              studentId: row.studentCode,
              name: row.studentName,
              courseId: row.course.id,
            },
            select: { id: true },
          });
          studentId = created.id;
        } else if (studentId) {
          const existing = await this.prisma.student.findUnique({
            where: { id: studentId },
            select: { courseId: true },
          });
          if (existing && !existing.courseId) {
            await this.prisma.student.update({
              where: { id: studentId },
              data: { courseId: row.course.id },
            });
          }
        }

        await this.prisma.gradingScan.create({
          data: {
            assessmentId: row.assessment.id,
            tenantId: user.tenantId,
            graderUserId: user.userId,
            status: 'COMPLETED',
            score: row.score,
            maxScore: row.maxScore,
            confidence: row.confidence,
            detectedStudentId: row.studentCode,
            matchedStudentCode: row.studentCode,
            studentId: studentId ?? null,
            confirmedAt: new Date(),
            questionDetails: [],
            detectedAnswers: {},
          },
        });
      }
    }

    return {
      total: rows.length,
      valid,
      failed,
      preview,
    };
  }

  private isGradingImportHeader(row?: unknown[]) {
    if (!row) return false;
    const headers = row.map((cell) =>
      this.cellToString(cell).toLowerCase().replace(/[\s_-]+/g, ''),
    );
    return (
      ['coursecode', 'course', 'code'].includes(headers[0] || '') &&
      [
        'assessmentcode',
        'assessment',
        'exam',
        'assessmentname',
        'assessmenttitle',
        'examcode',
      ].includes(headers[1] || '') &&
      ['studentid', 'id', 'studentcode', 'studentnumber'].includes(
        headers[2] || '',
      )
    );
  }

  private cellToString(value: unknown) {
    if (value == null) return '';
    return String(value).trim();
  }

  private cellToNumber(value: unknown): number | null {
    if (value == null || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const cleaned = String(value).replace(/[%\s,]/g, '').trim();
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private normalizeConfidence(value: number | null): number | null {
    if (value == null || !Number.isFinite(value)) return null;
    if (value > 1) return Math.min(1, value / 100);
    if (value < 0) return null;
    return value;
  }

  /** All scans attributed to a student code (detected or matched). */
  getStudentHistory(user: RequestUser, studentCode: string) {
    return this.prisma.gradingScan.findMany({
      where: {
        tenantId: user.tenantId,
        OR: [
          { detectedStudentId: studentCode },
          { matchedStudentCode: studentCode },
        ],
      },
      include: {
        assessment: { select: { id: true, title: true, type: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // -------------------------------------------------------------------------
  // Scoring
  // -------------------------------------------------------------------------
  private gradeAnswers(
    detectedAnswers: Record<string, string>,
    questions: Array<{
      type?: string | null;
      correctAnswer: string | null;
      questionOptions: Array<{ text: string; isCorrect: boolean; order?: number | null }>;
      points: number;
    }>,
  ) {
    const norm = (v: string) =>
      v.trim().toUpperCase().replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, '');

    const prefixRe = /^(?:OPTION\s*)?([A-E])(?:[\).\-:\s]|$)/i;
    // Case-sensitive so the article "a" in a text answer is not read as option A.
    const letterRe = /\b([A-E])\b/;

    const getAccepted = (q: {
      correctAnswer: string | null;
      questionOptions: Array<{ text: string; isCorrect: boolean; order?: number | null }>;
    }): Set<string> => {
      const accepted = new Set<string>();
      const opts = [...q.questionOptions].sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0),
      );

      // Add letter + text of every isCorrect option
      opts.forEach((opt, idx) => {
        if (!opt.isCorrect) return;
        accepted.add(String.fromCharCode(65 + idx)); // 'A', 'B', …
        const t = norm(opt.text || '');
        if (t) accepted.add(t);
      });

      // Parse correctAnswer string
      const raw = q.correctAnswer ?? '';
      const normRaw = norm(raw);
      if (normRaw) accepted.add(normRaw);

      const pm = raw.match(prefixRe);
      if (pm?.[1]) accepted.add(pm[1].toUpperCase());

      // Options flagged isCorrect are authoritative; only fall back to a
      // loose letter search when the key exists solely as text.
      if (!opts.some((opt) => opt.isCorrect)) {
        const lm = raw.match(letterRe);
        if (lm?.[1]) accepted.add(lm[1]);
      }

      // Cross-reference: if correctAnswer text matches an option text, accept that letter
      opts.forEach((opt, idx) => {
        const t = norm(opt.text || '');
        if (!t || !normRaw) return;
        if (t === normRaw || normRaw.includes(t) || t.includes(normRaw)) {
          accepted.add(String.fromCharCode(65 + idx));
        }
      });

      // Multi-value correctAnswer (semicolons, commas, etc.)
      raw
        .split(/[;,|/]/)
        .map(norm)
        .filter(Boolean)
        .forEach((token) => accepted.add(token));

      return accepted;
    };

    // True/False sheets print T/F bubbles regardless of option order.
    const trueWords = new Set(['T', 'TRUE', 'VRAI', 'YES', 'صح', 'صحيح']);
    const falseWords = new Set(['F', 'FALSE', 'FAUX', 'NO', 'خطأ', 'خطا']);
    const trueFalseKey = (q: {
      correctAnswer: string | null;
      questionOptions: Array<{ text: string; isCorrect: boolean; order?: number | null }>;
    }): 'T' | 'F' | null => {
      const candidates = [
        ...q.questionOptions.filter((opt) => opt.isCorrect).map((opt) => opt.text),
        q.correctAnswer ?? '',
      ];
      for (const candidate of candidates) {
        const value = String(candidate || '').trim().toUpperCase();
        if (trueWords.has(value)) return 'T';
        if (falseWords.has(value)) return 'F';
      }
      return null;
    };

    let score = 0;
    let maxScore = 0;
    const questionResults: Array<{
      question: number;
      isCorrect: boolean;
      correctAnswer: string | null;
    }> = [];

    questions.forEach((q, idx) => {
      const qNum = idx + 1;
      const points = q.points || 1;
      maxScore += points;
      const answer = norm(detectedAnswers[String(qNum)] ?? '');
      const tfKey = isTrueFalseQuestion(q) ? trueFalseKey(q) : null;
      const accepted = getAccepted(q);
      const isCorrect = tfKey
        ? answer === tfKey
        : Boolean(answer && accepted.has(answer));
      if (isCorrect) score += points;
      // Resolve the primary correct letter (A-E, or T/F) from the accepted set
      const correctLetter =
        tfKey ?? ['A', 'B', 'C', 'D', 'E', 'F'].find((l) => accepted.has(l)) ?? null;
      questionResults.push({ question: qNum, isCorrect, correctAnswer: correctLetter });
    });

    return { score, maxScore, questionResults };
  }
}
