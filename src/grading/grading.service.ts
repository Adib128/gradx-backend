import {
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
            course: {
              select: { id: true, title: true, code: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
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
