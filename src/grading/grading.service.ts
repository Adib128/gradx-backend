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
import * as XLSX from 'xlsx';

type RequestUser = {
  userId: number;
  tenantId: number;
};

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
    const numIdDigits = assessment.numberOfStudentIdDigits ?? 5;

    let processResult: {
      answers: Record<string, string>;
      confidence: number;
      decodedFormId: number | null;
      questionDetails?: unknown[];
      detectedStudentId?: string | null;
    } | null = null;
    let processError: string | null = null;

    // Build config with numIdDigits so Python grader knows how many columns to scan
    const sheetConfigWithDigits = { ...SHEET_CONFIG, numIdDigits };

    // Try Python OpenCV first
    try {
      const pyResult = await this.openCvService.processAnswerSheet(
        imagePath,
        JSON.stringify(sheetConfigWithDigits),
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
        const nodeResult = await this.nodeGrader.gradeSheet(imagePath, numIdDigits);
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
    const orderedQuestions =
      scoringVersion?.versionQuestions?.length
        ? scoringVersion.versionQuestions.map((vq) => vq.question)
        : assessment.questions;

    if (
      processResult!.decodedFormId != null &&
      !detectedVersion &&
      assessment.assessmentVersions.length > 0
    ) {
      this.logger.warn(
        `Decoded version ${processResult!.decodedFormId} is outside assessment ${assessmentId}'s ${assessment.assessmentVersions.length} versions; using Version A`,
      );
    }

    const { score, maxScore, questionResults } = this.gradeAnswers(
      processResult!.answers,
      orderedQuestions,
    );

    // Enrich grader questionDetails with per-question correctness and answer key
    const enrichedDetails = (
      (processResult!.questionDetails as Array<Record<string, unknown>>) ?? []
    ).map((qd) => {
      const qr = questionResults.find((r) => r.question === (qd['question'] as number));
      return {
        ...qd,
        isCorrect: qr?.isCorrect ?? false,
        correctAnswer: qr?.correctAnswer ?? null,
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
      correctAnswer: string | null;
      questionOptions: Array<{ text: string; isCorrect: boolean; order?: number | null }>;
      points: number;
    }>,
  ) {
    const norm = (v: string) =>
      v.trim().toUpperCase().replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, '');

    const prefixRe = /^(?:OPTION\s*)?([A-E])(?:[\).\-:\s]|$)/i;
    const letterRe = /\b([A-E])\b/i;

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

      const lm = raw.match(letterRe);
      if (lm?.[1]) accepted.add(lm[1].toUpperCase());

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
      const accepted = getAccepted(q);
      const isCorrect = Boolean(answer && accepted.has(answer));
      if (isCorrect) score += points;
      // Resolve the primary correct letter (A-E) from the accepted set
      const correctLetter =
        ['A', 'B', 'C', 'D', 'E'].find((l) => accepted.has(l)) ?? null;
      questionResults.push({ question: qNum, isCorrect, correctAnswer: correctLetter });
    });

    return { score, maxScore, questionResults };
  }
}
