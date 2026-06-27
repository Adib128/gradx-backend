import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from 'prisma/prisma.service';
import { OpenCvGradingService } from './opencv-grading.service';

type RequestUser = {
  userId: number;
  tenantId: number;
};

@Injectable()
export class GradingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly openCvService: OpenCvGradingService,
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
      where: {
        id: assessmentId,
        tenantId: user.tenantId,
      },
      include: {
        questions: {
          include: {
            questionOptions: true,
          },
          orderBy: { id: 'asc' },
        },
      },
    });
    if (!assessment) {
      throw new NotFoundException('Assessment not found.');
    }

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

    let processResult:
      | Awaited<ReturnType<OpenCvGradingService['processAnswerSheet']>>
      | null = null;
    let processError: string | null = null;

    try {
      processResult = await this.openCvService.processAnswerSheet(imagePath);
    } catch (error) {
      processError =
        error instanceof Error ? error.message : 'OpenCV processing failed';
      processResult = await this.openCvService.processWithFallback(imagePath);
    }

    const { score, maxScore } = this.gradeAnswers(
      processResult.answers,
      assessment.questions,
    );

    return this.prisma.gradingScan.update({
      where: { id: created.id },
      data: {
        status: processError ? 'FAILED' : 'COMPLETED',
        confidence: processResult.confidence,
        decodedFormId: processResult.decodedFormId,
        detectedAnswers: processResult.answers,
        score,
        maxScore,
        errorMessage: processError,
      },
    });
  }

  async getScan(user: RequestUser, scanId: number) {
    const scan = await this.prisma.gradingScan.findFirst({
      where: {
        id: scanId,
        tenantId: user.tenantId,
      },
      include: {
        assessment: {
          select: { id: true, title: true, type: true },
        },
      },
    });
    if (!scan) {
      throw new NotFoundException('Grading scan not found.');
    }
    return scan;
  }

  listScansByAssessment(user: RequestUser, assessmentId: number) {
    return this.prisma.gradingScan.findMany({
      where: {
        tenantId: user.tenantId,
        assessmentId,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private gradeAnswers(
    detectedAnswers: Record<string, string>,
    questions: Array<{
      correctAnswer: string | null;
      questionOptions: Array<{ text: string; isCorrect: boolean; order?: number }>;
      points: number;
    }>,
  ) {
    const normalizeToken = (value: string) =>
      value.trim().toUpperCase().replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, '');

    const getAcceptedAnswers = (question: {
      correctAnswer: string | null;
      questionOptions: Array<{ text: string; isCorrect: boolean; order?: number }>;
    }) => {
      const accepted = new Set<string>();
      const sortedOptions = [...question.questionOptions].sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0),
      );

      sortedOptions.forEach((option, index) => {
        if (!option.isCorrect) return;
        const letter = String.fromCharCode(65 + index); // A, B, C...
        accepted.add(normalizeToken(letter));
        const textToken = normalizeToken(option.text || '');
        if (textToken) accepted.add(textToken);
      });

      const rawCorrectAnswer = question.correctAnswer || '';
      rawCorrectAnswer
        .split(/[;,|/]/)
        .map((part) => normalizeToken(part))
        .filter(Boolean)
        .forEach((token) => accepted.add(token));

      return accepted;
    };

    let score = 0;
    let maxScore = 0;
    questions.forEach((question, index) => {
      const questionNumber = String(index + 1);
      const answer = normalizeToken(detectedAnswers[questionNumber] || '');
      const acceptedAnswers = getAcceptedAnswers(question);
      const points = question.points || 1;
      maxScore += points;
      if (answer && acceptedAnswers.has(answer)) {
        score += points;
      }
    });
    return { score, maxScore };
  }
}
