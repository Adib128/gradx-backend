import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PrismaService } from 'prisma/prisma.service';
import { OpenCvGradingService, ScanQuality } from './opencv-grading.service';
import { NodeGraderService } from './node-grader.service';
import { StudentInfoVisionService } from './student-info-vision.service';
import { SHEET_CONFIG } from './sheet-config';
import {
  buildGraderSheetConfigForQuestions,
  isTrueFalseQuestion,
  orderQuestionsForSheet,
  resolvePrintedIdDigits,
} from './answer-sheet-layout';
import { ErrorMessageKey } from '../common/constants/error-message';
import * as XLSX from 'xlsx';

type RequestUser = {
  userId: number;
  tenantId: number;
};

const ANCHOR_NAMES = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] as const;
type AnchorHints = Record<(typeof ANCHOR_NAMES)[number], { x: number; y: number }>;

/** Blank columns from the bubble grid are stored as `_`. */
function isCompleteStudentId(code: string | null | undefined): code is string {
  const value = (code ?? '').trim();
  return value.length > 0 && !value.includes('_');
}

/**
 * Candidate codes to look up for a printed student ID. Exact match first, then
 * common padding / leading-zero variants so "0443206950" still finds "443206950".
 * Incomplete bubble grids use `_` for blank columns — those skip exact variants
 * (partial matching handles them in findCourseStudent). Digits-only forms are
 * still tried so an add-student flow that stripped `_` can be re-linked.
 */
function studentIdLookupVariants(raw: string): string[] {
  const code = raw.trim();
  if (!code) return [];
  const digitsOnly = code.replace(/_/g, '');
  if (!digitsOnly) return [];
  // Incomplete grids: only try the digits-only form (add-student strips `_`).
  if (code.includes('_')) {
    return studentIdLookupVariants(digitsOnly);
  }
  const variants = new Set<string>([code]);
  const noLeadingZeros = code.replace(/^0+/, '') || '0';
  variants.add(noLeadingZeros);
  for (const width of [6, 9, 10, 12]) {
    if (noLeadingZeros.length <= width) {
      variants.add(noLeadingZeros.padStart(width, '0'));
    }
  }
  return Array.from(variants);
}

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
    private readonly studentInfoVision: StudentInfoVisionService,
  ) {}

  async createScan(
    user: RequestUser,
    assessmentId: number,
    file: Express.Multer.File,
    anchorHintsRaw?: unknown,
    opts?: { detectOnly?: boolean },
  ) {
    if (!file) {
      throw new InternalServerErrorException('Scan image is required.');
    }
    const detectOnly = !!opts?.detectOnly;

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
    const fileName = `scan-${assessmentId}-${Date.now()}-${randomBytes(4).toString('hex')}-${file.originalname.replace(/\s+/g, '-')}`;
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
      detectedAssessmentCode?: string | null;
      detectedStudentName?: string | null;
      detectedStudentSection?: string | null;
    } | null = null;
    let processError: string | null = null;

    const graderConfig = {
      ...SHEET_CONFIG,
      ...(sheetLayout ?? {}),
      numIdDigits,
      studentIdPosition: assessment.studentIdPosition ?? 'TOP_LEFT',
      ...(anchorHints ? { anchorHints } : {}),
      ...(detectOnly ? { mode: 'idOnly', qualityGate: true } : {}),
    };

    // Try Python OpenCV first
    try {
      const pyResult = await this.openCvService.processAnswerSheet(
        imagePath,
        JSON.stringify(graderConfig),
      );
      if (pyResult?.error === 'sheet_not_straight') {
        await this.prisma.gradingScan
          .delete({ where: { id: created.id } })
          .catch(() => undefined);
        throw new BadRequestException({
          message: ErrorMessageKey.SHEET_NOT_STRAIGHT,
          detail: String((pyResult as { alignmentReason?: string }).alignmentReason || 'skew'),
        });
      }
      if (pyResult && !pyResult.error) {
        processResult = pyResult;
        if (detectOnly) {
          await this.rejectUnclearScan(created.id, pyResult.scanQuality);
        }
        const sidDebug = (pyResult as any).debug?.studentIdDebug;
        this.logger.log(
          `Python grader used (conf=${pyResult.confidence}, studentId=${pyResult.detectedStudentId}, blanks=${sidDebug?.blanks ?? '?'})`,
        );
        if (sidDebug) {
          this.logger.debug(`StudentID debug: ${JSON.stringify(sidDebug)}`);
        }
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.warn(
        `Python grader failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Fallback: Node.js sharp grader (full grade only — no idOnly mode yet).
    if (
      !detectOnly &&
      (!processResult || (processResult.confidence ?? 0) < 0.2)
    ) {
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
    } else if (detectOnly && !processResult) {
      processError = 'Student ID detection failed';
      processResult = {
        answers: {},
        confidence: 0,
        decodedFormId: null,
        questionDetails: [],
        detectedStudentId: null,
      };
    }

    // Score against the answer key for the machine-detected paper version.
    // The marker stores a one-based version index (A=1, B=2, ...), matching
    // assessmentVersions' creation/id order. Old sheets without a marker keep
    // the previous Version A fallback.
    // Match a fully-read student ID against this course's roster only.
    const rawStudentId = (processResult!.detectedStudentId ?? '').trim() || null;
    const matchedStudent = await this.findCourseStudent(
      assessment.courseId,
      rawStudentId,
    );
    if (rawStudentId && !isCompleteStudentId(rawStudentId)) {
      this.logger.warn(
        `Student ID incomplete for scan ${created.id}: detected="${rawStudentId}"`,
      );
    } else if (rawStudentId && !matchedStudent) {
      this.logger.warn(
        `Student ID not in course ${assessment.courseId} roster: detected="${rawStudentId}"`,
      );
    }

    const detectedAssessmentCode = (
      processResult!.detectedAssessmentCode ?? ''
    )
      .trim()
      .toUpperCase() || null;
    const expectedAssessmentCode = String(assessment.code || '')
      .trim()
      .toUpperCase();
    if (
      detectedAssessmentCode &&
      expectedAssessmentCode &&
      detectedAssessmentCode !== expectedAssessmentCode
    ) {
      await this.prisma.gradingScan
        .delete({ where: { id: created.id } })
        .catch(() => undefined);
      throw new BadRequestException({
        message: ErrorMessageKey.ASSESSMENT_CODE_MISMATCH,
        detail: `${detectedAssessmentCode}|${expectedAssessmentCode}`,
      });
    }

    const detectedStudentName = (
      processResult!.detectedStudentName ?? ''
    ).trim() || null;
    const detectedStudentSection = (
      processResult!.detectedStudentSection ?? ''
    ).trim() || null;

    // Fast path: mobile detect-only — store ID/roster match; full grade on confirm.
    if (detectOnly) {
      const scan = await this.prisma.gradingScan.update({
        where: { id: created.id },
        data: {
          status: processError ? 'FAILED' : 'PENDING',
          confidence: processResult!.confidence,
          decodedFormId: null,
          detectedAnswers: undefined,
          questionDetails: undefined,
          score: null,
          maxScore: null,
          errorMessage: processError,
          detectedStudentId: rawStudentId,
          matchedStudentCode: matchedStudent?.studentId ?? null,
          ...(matchedStudent ? { studentId: matchedStudent.id } : {}),
        },
        include: {
          student: {
            select: { id: true, name: true, studentId: true, section: true },
          },
          assessment: {
            select: { id: true, title: true, code: true, type: true },
          },
        },
      });
      return {
        ...scan,
        detectedAssessmentCode,
        detectedStudentName,
        detectedStudentSection,
        detectOnly: true,
      };
    }

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

    // Multi-mark rows: zero for single-answer MCQ; for multi-correct questions,
    // keep all marked letters (from candidates) so partial credit can apply.
    const scoredAnswers = { ...processResult!.answers };
    const detailsRaw =
      (processResult!.questionDetails as Array<Record<string, unknown>>) ?? [];
    for (const detail of detailsRaw) {
      const qNum = Number(detail['question']);
      const question = orderedQuestions[qNum - 1];
      const multiAllowed = this.questionAllowsMultipleCorrect(question);
      if (detail['status'] === 'multiple') {
        if (multiAllowed) {
          const candidates = Array.isArray(detail['candidates'])
            ? (detail['candidates'] as unknown[])
                .map((value) => String(value || '').trim().toUpperCase())
                .filter(Boolean)
            : [];
          const joined = candidates.join(',');
          scoredAnswers[String(qNum)] = joined;
          detail['detected'] = joined || null;
          detail['status'] = joined ? 'answered' : 'blank';
        } else {
          scoredAnswers[String(qNum)] = '';
        }
      }
    }
    const { score, maxScore, questionResults } = this.gradeAnswers(
      scoredAnswers,
      orderedQuestions,
    );

    // Enrich grader questionDetails with per-question correctness and answer key.
    // Blank rows are not "incorrect"; multi-correct may earn partial credit.
    const enrichedDetails = detailsRaw.map((qd) => {
      const printedNumber = qd['question'] as number;
      const status = String(qd['status'] ?? '');
      const qr = questionResults.find((r) => r.question === printedNumber);
      const question = orderedQuestions[printedNumber - 1];
      const isAnswered = status === 'answered';
      return {
        ...qd,
        isCorrect: isAnswered ? (qr?.isCorrect ?? false) : null,
        correctAnswer: qr?.correctAnswer ?? null,
        earnedPoints: isAnswered ? (qr?.earnedPoints ?? 0) : null,
        maxPoints: question?.points ?? null,
        questionId: question?.id ?? null,
        masterNumber: question ? (masterNumberById.get(question.id) ?? null) : null,
        versionNumber: scoringVersionNumber,
      };
    });

    // PENDING = graded for review only; COMPLETED + confirmedAt = saved.
    const scan = await this.prisma.gradingScan.update({
      where: { id: created.id },
      data: {
        status: processError ? 'FAILED' : 'PENDING',
        confidence: processResult!.confidence,
        decodedFormId: processResult!.decodedFormId,
        detectedAnswers: processResult!.answers,
        questionDetails: enrichedDetails,
        score,
        maxScore,
        errorMessage: processError,
        detectedStudentId: rawStudentId,
        matchedStudentCode: matchedStudent?.studentId ?? null,
        ...(matchedStudent ? { studentId: matchedStudent.id } : {}),
      },
      include: {
        student: {
          select: { id: true, name: true, studentId: true, section: true },
        },
        assessment: {
          select: { id: true, title: true, code: true, type: true },
        },
      },
    });

    return {
      ...scan,
      detectedAssessmentCode,
      detectedStudentName,
      detectedStudentSection,
    };
  }

  /**
   * Finish bubble grading for a detect-only draft (mobile confirm step).
   */
  /**
   * Stop a photo the grader cannot read reliably (blur, page not fully
   * visible, bad light, misaligned grid) so the teacher rescans instead of
   * saving a wrong ID / wrong answers. Drops the draft; `detail` carries the
   * issue codes (most important first) for the app to explain.
   */
  private async rejectUnclearScan(
    scanId: number | null,
    quality: ScanQuality | undefined,
  ) {
    const blocking = quality?.blocking ?? [];
    if (blocking.length === 0) return;
    if (scanId != null) {
      await this.prisma.gradingScan
        .delete({ where: { id: scanId } })
        .catch(() => undefined);
    }
    this.logger.warn(
      `Scan rejected as unclear (${blocking.join(',')}): ${JSON.stringify(quality?.metrics ?? {})}`,
    );
    throw new BadRequestException({
      message: ErrorMessageKey.SCAN_UNCLEAR,
      detail: blocking.join(','),
    });
  }

  /**
   * Name + section printed on a scanned sheet (handwritten, Arabic or English).
   * Used by the mobile app when the detected student ID is not on the roster,
   * so the teacher can add the student. Runs OCR only — no ID / answer work.
   */
  async detectScanStudentInfo(user: RequestUser, scanId: number) {
    const scan = await this.prisma.gradingScan.findFirst({
      where: { id: scanId, tenantId: user.tenantId },
      select: { imagePath: true, assessmentId: true },
    });
    if (!scan?.imagePath || !scan.assessmentId) {
      throw new NotFoundException('Scan not found.');
    }
    // The grader reports whether each field holds any handwriting at all. An
    // empty field must come back empty: neither the vision model nor Tesseract
    // is asked to read blank paper (they invent characters from it).
    // 1) Vision model on the cropped name/section box (reads cursive Arabic far
    //    better than Tesseract). 2) Tesseract as the fallback when the model is
    //    unavailable or fails.
    let nameWritten = true;
    let sectionWritten = true;
    if (this.studentInfoVision.enabled) {
      try {
        const cropResult = await this.openCvService.processAnswerSheet(
          scan.imagePath,
          JSON.stringify({ ...SHEET_CONFIG, mode: 'nameCrop' }),
        );
        const debug = cropResult?.debug as
          | { nameCrop?: string; nameWritten?: boolean; sectionWritten?: boolean }
          | undefined;
        nameWritten = debug?.nameWritten !== false;
        sectionWritten = debug?.sectionWritten !== false;
        if (!nameWritten && !sectionWritten) {
          return { detectedStudentName: null, detectedStudentSection: null };
        }
        const crop = debug?.nameCrop;
        if (typeof crop === 'string' && crop) {
          const read = await this.studentInfoVision.read(crop, {
            userId: user.userId,
            tenantId: user.tenantId,
          });
          if (read) {
            // The model answered (possibly "empty"): trust it, no OCR fallback.
            return {
              detectedStudentName: nameWritten ? read.name : null,
              detectedStudentSection: sectionWritten ? read.section : null,
            };
          }
        }
      } catch (err) {
        this.logger.warn(
          `Vision name/section detection failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    try {
      const result = await this.openCvService.processAnswerSheet(
        scan.imagePath,
        JSON.stringify({ ...SHEET_CONFIG, mode: 'nameOnly' }),
      );
      return {
        detectedStudentName: (result?.detectedStudentName ?? '').trim() || null,
        detectedStudentSection:
          (result?.detectedStudentSection ?? '').trim() || null,
      };
    } catch (err) {
      this.logger.warn(
        `Name/section detection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { detectedStudentName: null, detectedStudentSection: null };
    }
  }

  /**
   * The teacher typed the Student ID because the bubbles could not give a full
   * one (double mark, smudge, faint ink) or read it wrongly. Stored on the
   * unsaved draft and matched against the roster exactly like a detected ID.
   * `MANUAL_ID` in errorMessage tells the save step not to second-guess it with
   * a fresh bubble read.
   */
  async setScanStudentId(user: RequestUser, scanId: number, rawCode: string) {
    const scan = await this.prisma.gradingScan.findFirst({
      where: { id: scanId, tenantId: user.tenantId },
      include: {
        assessment: { select: { courseId: true, numberOfStudentIdDigits: true } },
      },
    });
    if (!scan) throw new NotFoundException('Grading scan not found.');
    if (scan.confirmedAt) {
      throw new BadRequestException('This grading is already saved.');
    }
    const code = String(rawCode ?? '').replace(/\s+/g, '');
    const expected = resolvePrintedIdDigits(scan.assessment?.numberOfStudentIdDigits);
    if (!/^\d+$/.test(code) || code.length !== expected) {
      throw new BadRequestException(
        `The Student ID must be exactly ${expected} digits.`,
      );
    }
    const courseId = scan.assessment?.courseId ?? null;
    const matched = courseId != null ? await this.findCourseStudent(courseId, code) : null;
    const updated = await this.prisma.gradingScan.update({
      where: { id: scan.id },
      data: {
        detectedStudentId: code,
        matchedStudentCode: matched?.studentId ?? null,
        studentId: matched?.id ?? null,
        errorMessage: 'MANUAL_ID',
      },
      include: {
        student: {
          select: { id: true, name: true, studentId: true, section: true },
        },
        assessment: {
          select: { id: true, title: true, code: true, type: true },
        },
      },
    });
    this.logger.log(`Student ID set manually on scan ${scanId}: ${code}`);
    return { ...updated, detectOnly: true };
  }

  /**
   * Optional second check on the Student ID. The OpenCV bubble read stays the
   * source of truth; a vision model looks at the hand-written ID boxes printed
   * above the grid and says how many clearly contradict it. Handwriting is a
   * weak signal (0/o, 9/q ...), so one or two doubtful boxes are ignored and
   * the result is advisory only — it never blocks or changes a grade.
   *
   *   match        no clear contradiction
   *   mismatch     several boxes clearly show different digits
   *   unavailable  model off, boxes unreadable, or any error
   */
  async verifyScanStudentId(user: RequestUser, scanId: number) {
    const unavailable = { status: 'unavailable' as const };
    if (
      !this.studentInfoVision.enabled ||
      process.env.ID_AI_CHECK === '0' ||
      process.env.ID_AI_CHECK === 'false'
    ) {
      return unavailable;
    }
    const scan = await this.prisma.gradingScan.findFirst({
      where: { id: scanId, tenantId: user.tenantId },
      select: {
        imagePath: true,
        detectedStudentId: true,
        assessment: { select: { studentIdPosition: true } },
      },
    });
    if (!scan?.imagePath) throw new NotFoundException('Scan not found.');
    const bubbled = (scan.detectedStudentId ?? '').trim();
    if (!bubbled || !/^\d+$/.test(bubbled)) return unavailable;
    try {
      const cropResult = await this.openCvService.processAnswerSheet(
        scan.imagePath,
        JSON.stringify({
          ...SHEET_CONFIG,
          numIdDigits: bubbled.length,
          studentIdPosition: scan.assessment?.studentIdPosition ?? 'TOP_LEFT',
          mode: 'idOnly',
          idCrop: true,
        }),
      );
      const crop = (cropResult as { debug?: { idCrop?: string } })?.debug?.idCrop;
      if (typeof crop !== 'string' || !crop) return unavailable;
      const differing = await this.studentInfoVision.countClearlyDifferentIdBoxes(
        crop,
        bubbled,
        { userId: user.userId, tenantId: user.tenantId },
      );
      if (differing === null) return unavailable;
      const threshold = Math.max(3, Math.ceil(bubbled.length * 0.34));
      const mismatch = differing >= threshold;
      this.logger.log(
        `ID cross-check scan ${scanId}: bubbles=${bubbled} differingBoxes=${differing} (alert at ${threshold}) -> ${mismatch ? 'mismatch' : 'match'}`,
      );
      return mismatch
        ? { status: 'mismatch' as const, differing, bubbled }
        : { status: 'match' as const, differing, bubbled };
    } catch (err) {
      this.logger.warn(
        `ID cross-check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return unavailable;
    }
  }

  private async gradeDetectOnlyScan(user: RequestUser, scanId: number) {
    const existing = await this.prisma.gradingScan.findFirst({
      where: { id: scanId, tenantId: user.tenantId },
    });
    if (!existing?.imagePath || !existing.assessmentId) {
      throw new BadRequestException('Scan image is missing.');
    }

    const assessment = await this.prisma.assessment.findFirst({
      where: { id: existing.assessmentId, tenantId: user.tenantId },
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

    const numIdDigits = resolvePrintedIdDigits(assessment.numberOfStudentIdDigits);
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
    const graderConfig = {
      ...SHEET_CONFIG,
      ...(sheetLayout ?? {}),
      numIdDigits,
      studentIdPosition: assessment.studentIdPosition ?? 'TOP_LEFT',
      // The mobile review never uses the OCR'd name here (it is read on demand
      // for unknown IDs), and Tesseract is by far the slowest step.
      skipName: true,
      qualityGate: true,
    };

    let processResult: {
      answers: Record<string, string>;
      confidence: number;
      decodedFormId: number | null;
      questionDetails?: unknown[];
      detectedStudentId?: string | null;
      detectedStudentName?: string | null;
      detectedStudentSection?: string | null;
    } | null = null;
    let processError: string | null = null;

    try {
      const pyResult = await this.openCvService.processAnswerSheet(
        existing.imagePath,
        JSON.stringify(graderConfig),
      );
      if (pyResult && !pyResult.error) processResult = pyResult;
    } catch (err) {
      this.logger.warn(
        `Full grade after detect failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Fresh detection of this exact photo (nothing carried over from the
    // review step): refuse it if it is unreliable, or if the ID read now
    // disagrees with the ID the teacher reviewed.
    if (processResult) {
      const quality = (processResult as { scanQuality?: ScanQuality }).scanQuality;
      const reviewed = (existing.detectedStudentId ?? '').trim();
      const now = (processResult.detectedStudentId ?? '').trim();
      if (
        existing.errorMessage !== 'MANUAL_ID' &&
        isCompleteStudentId(reviewed) &&
        isCompleteStudentId(now) &&
        reviewed !== now
      ) {
        await this.rejectUnclearScan(scanId, {
          ok: false,
          issues: ['id_unstable'],
          blocking: ['id_unstable'],
        });
      }
      await this.rejectUnclearScan(scanId, quality);
    }

    if (!processResult || (processResult.confidence ?? 0) < 0.2) {
      try {
        processResult = await this.nodeGrader.gradeSheet(
          existing.imagePath,
          numIdDigits,
          {
            answerGrid: sheetLayout?.answerGrid,
            studentIdGrid: sheetLayout?.studentIdGrid,
          },
        );
      } catch (err) {
        processError =
          err instanceof Error ? err.message : 'Grading processing failed';
        processResult = {
          answers: {},
          confidence: 0,
          decodedFormId: null,
          questionDetails: [],
        };
      }
    }

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

    const scoredAnswers = { ...processResult!.answers };
    const detailsRaw =
      (processResult!.questionDetails as Array<Record<string, unknown>>) ?? [];
    for (const detail of detailsRaw) {
      const qNum = Number(detail['question']);
      const question = orderedQuestions[qNum - 1];
      const multiAllowed = this.questionAllowsMultipleCorrect(question);
      if (detail['status'] === 'multiple') {
        if (multiAllowed) {
          const candidates = Array.isArray(detail['candidates'])
            ? (detail['candidates'] as unknown[])
                .map((value) => String(value || '').trim().toUpperCase())
                .filter(Boolean)
            : [];
          const joined = candidates.join(',');
          scoredAnswers[String(qNum)] = joined;
          detail['detected'] = joined || null;
          detail['status'] = joined ? 'answered' : 'blank';
        } else {
          scoredAnswers[String(qNum)] = '';
        }
      }
    }
    const { score, maxScore, questionResults } = this.gradeAnswers(
      scoredAnswers,
      orderedQuestions,
    );
    const enrichedDetails = detailsRaw.map((qd) => {
      const printedNumber = qd['question'] as number;
      const status = String(qd['status'] ?? '');
      const qr = questionResults.find((r) => r.question === printedNumber);
      const question = orderedQuestions[printedNumber - 1];
      const isAnswered = status === 'answered';
      return {
        ...qd,
        isCorrect: isAnswered ? (qr?.isCorrect ?? false) : null,
        correctAnswer: qr?.correctAnswer ?? null,
        earnedPoints: isAnswered ? (qr?.earnedPoints ?? 0) : null,
        maxPoints: question?.points ?? null,
        questionId: question?.id ?? null,
        masterNumber: question
          ? (masterNumberById.get(question.id) ?? null)
          : null,
        versionNumber: scoringVersionNumber,
      };
    });

    // Keep the student ID from the fast detect step unless full grade found one.
    const rawStudentId =
      existing.errorMessage === 'MANUAL_ID'
        ? existing.detectedStudentId
        : (processResult!.detectedStudentId ?? '').trim() ||
          existing.detectedStudentId ||
          null;

    await this.prisma.gradingScan.update({
      where: { id: scanId },
      data: {
        status: processError ? 'FAILED' : 'PENDING',
        confidence: processResult!.confidence,
        decodedFormId: processResult!.decodedFormId,
        detectedAnswers: processResult!.answers,
        questionDetails: enrichedDetails,
        score,
        maxScore,
        errorMessage: processError,
        detectedStudentId: rawStudentId,
      },
    });
  }

  /**
   * Resolve a printed student ID to a student. Prefers this course's roster,
   * then a global exact match, then a unique partial match on filled digits
   * (so `44320695_` can still resolve `443206950`).
   */
  private async findCourseStudent(courseId: number, rawCode: string | null) {
    const select = {
      id: true,
      studentId: true,
      name: true,
      section: true,
    } as const;
    const variants = studentIdLookupVariants(rawCode ?? '');
    if (variants.length > 0) {
      const inCourse = await this.prisma.student.findFirst({
        where: { courseId, studentId: { in: variants } },
        select,
      });
      if (inCourse) return inCourse;
      // Legacy rows / wrong course link: still accept a unique global ID.
      const global = await this.prisma.student.findFirst({
        where: { studentId: { in: variants } },
        select,
      });
      if (global) return global;
      // Digits-only match found nothing; fall through to partial `_` matching.
    }

    const pattern = (rawCode ?? '').trim();
    if (!pattern || !pattern.includes('_') || /^_+$/.test(pattern)) return null;
    const filled = (pattern.match(/\d/g) ?? []).length;
    if (filled < 4) return null;

    const roster = await this.prisma.student.findMany({
      where: { courseId },
      select,
    });
    const matches = roster.filter((student) => {
      const code =
        student.studentId.length === pattern.length
          ? student.studentId
          : student.studentId.padStart(pattern.length, '0');
      if (code.length !== pattern.length) return false;
      return [...pattern].every((ch, index) => ch === '_' || ch === code[index]);
    });
    return matches.length === 1 ? matches[0] : null;
  }

  private async findAnswerSheetStudent(
    courseAnswerSheetId: number,
    rawCode: string | null,
  ) {
    const select = {
      id: true,
      studentId: true,
      name: true,
      section: true,
    } as const;
    const variants = studentIdLookupVariants(rawCode ?? '');
    if (variants.length > 0) {
      const onSheet = await this.prisma.student.findFirst({
        where: { courseAnswerSheetId, studentId: { in: variants } },
        select,
      });
      if (onSheet) return onSheet;
    }

    const pattern = (rawCode ?? '').trim();
    if (!pattern || !pattern.includes('_') || /^_+$/.test(pattern)) return null;
    const filled = (pattern.match(/\d/g) ?? []).length;
    if (filled < 4) return null;

    const roster = await this.prisma.student.findMany({
      where: { courseAnswerSheetId },
      select,
    });
    const matches = roster.filter((student) => {
      const code =
        student.studentId.length === pattern.length
          ? student.studentId
          : student.studentId.padStart(pattern.length, '0');
      if (code.length !== pattern.length) return false;
      return [...pattern].every((ch, index) => ch === '_' || ch === code[index]);
    });
    return matches.length === 1 ? matches[0] : null;
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

  /**
   * Every scan of an assessment with its grading state (confirmed, awaiting
   * confirmation, processing, failed) plus summary counts. Unlike
   * `listScansByAssessment` this is not limited to confirmed results.
   */
  async getAssessmentGradingOverview(user: RequestUser, assessmentId: number) {
    const assessment = await this.prisma.assessment.findFirst({
      where: { id: assessmentId, tenantId: user.tenantId },
      select: { id: true },
    });
    if (!assessment) throw new NotFoundException('Assessment not found.');

    const rows = await this.prisma.gradingScan.findMany({
      where: { tenantId: user.tenantId, assessmentId },
      select: {
        id: true,
        status: true,
        score: true,
        maxScore: true,
        confidence: true,
        detectedStudentId: true,
        matchedStudentCode: true,
        confirmedAt: true,
        createdAt: true,
        student: { select: { id: true, name: true, studentId: true, section: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    type State = 'confirmed' | 'pending' | 'processing' | 'failed';
    const scans = rows.map((row) => {
      const state: State = row.confirmedAt
        ? 'confirmed'
        : row.status === 'FAILED'
          ? 'failed'
          : row.status === 'PROCESSING'
            ? 'processing'
            : 'pending';
      return { ...row, state };
    });

    const confirmed = scans.filter((scan) => scan.state === 'confirmed');
    const confidences = scans
      .map((scan) => Number(scan.confidence))
      .filter((value) => Number.isFinite(value));
    const percents = confirmed
      .map((scan) =>
        scan.maxScore && scan.score != null ? (scan.score / scan.maxScore) * 100 : null,
      )
      .filter((value): value is number => value != null);
    const average = (values: number[]) =>
      values.length
        ? Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 10) / 10
        : null;

    return {
      summary: {
        total: scans.length,
        confirmed: confirmed.length,
        pending: scans.filter((scan) => scan.state === 'pending').length,
        processing: scans.filter((scan) => scan.state === 'processing').length,
        failed: scans.filter((scan) => scan.state === 'failed').length,
        averageConfidence: average(confidences),
        averagePercent: average(percents),
      },
      scans,
    };
  }

  listScansByAssessment(user: RequestUser, assessmentId: number) {
    return this.prisma.gradingScan.findMany({
      where: {
        tenantId: user.tenantId,
        assessmentId,
        status: 'COMPLETED',
        confirmedAt: { not: null },
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

  /**
   * Persist a grading scan: only Submit grading promotes PENDING → COMPLETED.
   * Optional `studentId` (course-student FK) is used after mobile add-student
   * so the new roster row is linked even if bubble-ID lookup would miss.
   */
  async confirmScan(
    user: RequestUser,
    scanId: number,
    opts?: { studentId?: number | null },
  ) {
    let scan = await this.prisma.gradingScan.findFirst({
      where: { id: scanId, tenantId: user.tenantId },
      include: { assessment: { select: { courseId: true } } },
    });
    if (!scan) throw new NotFoundException('Grading scan not found.');
    if (scan.status === 'FAILED') {
      throw new BadRequestException('Cannot save a failed grading scan.');
    }

    // Detect-only drafts grade bubbles here so the first mobile step stays fast.
    if (scan.questionDetails == null && scan.imagePath && scan.assessmentId) {
      await this.gradeDetectOnlyScan(user, scan.id);
      scan = await this.prisma.gradingScan.findFirst({
        where: { id: scanId, tenantId: user.tenantId },
        include: { assessment: { select: { courseId: true } } },
      });
      if (!scan) throw new NotFoundException('Grading scan not found.');
      if (scan.status === 'FAILED') {
        throw new BadRequestException(
          scan.errorMessage || 'Grading failed while saving.',
        );
      }
    }

    // Resolve the student FK: explicit body wins, then existing link, then roster lookup.
    let studentId: number | null = scan.studentId ?? null;
    let matchedStudentCode = scan.matchedStudentCode;
    const explicitId =
      typeof opts?.studentId === 'number' && Number.isFinite(opts.studentId)
        ? opts.studentId
        : null;
    const answerSheetId = scan.courseAnswerSheetId ?? null;
    const courseId =
      scan.assessment?.courseId ??
      (
        await this.prisma.courseAnswerSheet.findFirst({
          where: { id: answerSheetId ?? -1, tenantId: user.tenantId },
          select: { courseId: true },
        })
      )?.courseId ??
      null;

    if (explicitId != null) {
      const explicit = await this.prisma.student.findFirst({
        where: {
          id: explicitId,
          ...(courseId != null
            ? { courseId }
            : answerSheetId != null
              ? { courseAnswerSheetId: answerSheetId }
              : { id: -1 }),
        },
        select: { id: true, studentId: true },
      });
      if (!explicit) {
        throw new BadRequestException(
          'Student does not belong to this assessment or answer sheet.',
        );
      }
      studentId = explicit.id;
      matchedStudentCode = explicit.studentId;
    } else if (!studentId) {
      if (courseId != null) {
        const student = await this.findCourseStudent(
          courseId,
          scan.matchedStudentCode ?? scan.detectedStudentId,
        );
        studentId = student?.id ?? null;
        if (student) matchedStudentCode = student.studentId;
      } else if (answerSheetId != null) {
        const student = await this.findAnswerSheetStudent(
          answerSheetId,
          scan.matchedStudentCode ?? scan.detectedStudentId,
        );
        studentId = student?.id ?? null;
        if (student) matchedStudentCode = student.studentId;
      }
    }

    const confirmed = await this.prisma.gradingScan.update({
      where: { id: scanId },
      data: {
        confirmedAt: new Date(),
        ...(studentId ? { studentId } : {}),
        ...(matchedStudentCode
          ? { matchedStudentCode }
          : {}),
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
    if (!assessment) {
      throw new BadRequestException(
        'CLO breakdown is only available for assessment grading scans.',
      );
    }
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
      const maxPts = Number(detail?.maxPoints);
      const earnedPts = Number(detail?.earnedPoints);
      const earned =
        Number.isFinite(earnedPts) && Number.isFinite(maxPts) && maxPts > 0
          ? (earnedPts / maxPts) * weightedPoints
          : detail?.isCorrect === true
            ? weightedPoints
            : 0;
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

  /** Full grading history for the tenant (saved scans only). */
  async getGradingHistory(user: RequestUser) {
    const scans = await this.prisma.gradingScan.findMany({
      where: {
        tenantId: user.tenantId,
        status: 'COMPLETED',
        confirmedAt: { not: null },
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

    // Scans are often not linked to a student row; resolve them by printed code.
    const unlinkedCodes = Array.from(
      new Set(
        scans
          .filter((scan) => !scan.student)
          .flatMap((scan) =>
            studentIdLookupVariants(
              scan.matchedStudentCode ?? scan.detectedStudentId ?? '',
            ),
          ),
      ),
    );
    if (unlinkedCodes.length === 0) return scans;

    const students = await this.prisma.student.findMany({
      where: {
        studentId: { in: unlinkedCodes },
        course: { tenantId: user.tenantId },
      },
      select: { id: true, name: true, studentId: true, section: true, courseId: true },
    });
    const byCode = new Map(students.map((student) => [student.studentId, student]));

    return scans.map((scan) => {
      if (scan.student) return scan;
      const variants = studentIdLookupVariants(
        scan.matchedStudentCode ?? scan.detectedStudentId ?? '',
      );
      const student =
        variants.map((code) => byCode.get(code)).find(Boolean) ?? null;
      return { ...scan, student };
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

  /** Saved scans attributed to a student code (detected or matched). */
  getStudentHistory(user: RequestUser, studentCode: string) {
    return this.prisma.gradingScan.findMany({
      where: {
        tenantId: user.tenantId,
        status: 'COMPLETED',
        confirmedAt: { not: null },
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
  private questionAllowsMultipleCorrect(question: {
    allowMultipleCorrect?: boolean | null;
    questionOptions?: Array<{ isCorrect: boolean }> | null;
  } | null | undefined): boolean {
    if (!question) return false;
    if (question.allowMultipleCorrect) return true;
    const correctCount = (question.questionOptions ?? []).filter(
      (opt) => opt.isCorrect,
    ).length;
    return correctCount > 1;
  }

  private gradeAnswers(
    detectedAnswers: Record<string, string>,
    questions: Array<{
      type?: string | null;
      correctAnswer: string | null;
      allowMultipleCorrect?: boolean | null;
      questionOptions: Array<{ text: string; isCorrect: boolean; order?: number | null }>;
      points: number;
    }>,
  ) {
    const norm = (v: string) =>
      v.trim().toUpperCase().replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, '');

    const prefixRe = /^(?:OPTION\s*)?([A-F])(?:[\).\-:\s]|$)/i;
    const letterRe = /\b([A-F])\b/;
    const OPTION_LETTERS = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'T']);

    /** Correct option letters only (A–F / T–F), used for partial credit. */
    const getCorrectLetters = (q: {
      correctAnswer: string | null;
      questionOptions: Array<{ text: string; isCorrect: boolean; order?: number | null }>;
    }): string[] => {
      const opts = [...q.questionOptions].sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0),
      );
      const fromFlags = opts
        .map((opt, idx) =>
          opt.isCorrect ? String.fromCharCode(65 + idx) : null,
        )
        .filter(Boolean) as string[];
      if (fromFlags.length > 0) return fromFlags;

      const raw = q.correctAnswer ?? '';
      const tokens = raw
        .split(/[;,|/]/)
        .map(norm)
        .filter(Boolean);
      const letters: string[] = [];
      for (const token of tokens) {
        if (OPTION_LETTERS.has(token) || token === 'F') {
          letters.push(token);
          continue;
        }
        const pm = token.match(prefixRe);
        if (pm?.[1]) letters.push(pm[1].toUpperCase());
        else {
          const lm = token.match(letterRe);
          if (lm?.[1]) letters.push(lm[1].toUpperCase());
        }
      }
      return Array.from(new Set(letters));
    };

    const parseSelectedLetters = (raw: string): string[] => {
      if (!raw) return [];
      return Array.from(
        new Set(
          raw
            .split(/[;,|/\s]+/)
            .map(norm)
            .filter((token) => /^[A-F]$/.test(token) || token === 'T' || token === 'F'),
        ),
      );
    };

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

    /**
     * Partial credit for multi-correct MCQ:
     * earned = points × max(0, |hit| − |extra|) / |correct|
     * so marking only some correct options awards a share; wrong extras cancel hits.
     */
    const scoreSelection = (
      selected: string[],
      correct: string[],
      points: number,
    ): { earned: number; isCorrect: boolean } => {
      if (correct.length === 0) {
        return { earned: 0, isCorrect: false };
      }
      const correctSet = new Set(correct);
      const selectedSet = new Set(selected);
      let hit = 0;
      let extra = 0;
      for (const letter of selectedSet) {
        if (correctSet.has(letter)) hit += 1;
        else extra += 1;
      }
      const earned = Math.round(
        ((points * Math.max(0, hit - extra)) / correct.length) * 100,
      ) / 100;
      const isCorrect =
        hit === correct.length && extra === 0 && selectedSet.size === correct.length;
      return { earned, isCorrect };
    };

    let score = 0;
    let maxScore = 0;
    const questionResults: Array<{
      question: number;
      isCorrect: boolean;
      correctAnswer: string | null;
      earnedPoints: number;
    }> = [];

    questions.forEach((q, idx) => {
      const qNum = idx + 1;
      const points = q.points || 1;
      maxScore += points;
      const rawAnswer = String(detectedAnswers[String(qNum)] ?? '');
      const tfKey = isTrueFalseQuestion(q) ? trueFalseKey(q) : null;

      if (tfKey) {
        const answer = norm(rawAnswer);
        const isCorrect = answer === tfKey;
        const earned = isCorrect ? points : 0;
        if (earned) score += earned;
        questionResults.push({
          question: qNum,
          isCorrect,
          correctAnswer: tfKey,
          earnedPoints: earned,
        });
        return;
      }

      const correctLetters = getCorrectLetters(q);
      const multi =
        this.questionAllowsMultipleCorrect(q) || correctLetters.length > 1;
      const selected = parseSelectedLetters(rawAnswer);

      if (!multi) {
        // Single-answer MCQ: full points only when the one selected letter matches.
        const answer = selected[0] ?? norm(rawAnswer);
        const isCorrect = Boolean(answer && correctLetters.includes(answer));
        const earned = isCorrect ? points : 0;
        if (earned) score += earned;
        questionResults.push({
          question: qNum,
          isCorrect,
          correctAnswer: correctLetters[0] ?? null,
          earnedPoints: earned,
        });
        return;
      }

      const { earned, isCorrect } = scoreSelection(selected, correctLetters, points);
      score += earned;
      questionResults.push({
        question: qNum,
        isCorrect,
        correctAnswer: correctLetters.join(',') || null,
        earnedPoints: earned,
      });
    });

    return { score, maxScore, questionResults };
  }
}
