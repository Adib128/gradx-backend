import {
  Injectable,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import { join } from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { PrismaService } from 'prisma/prisma.service';
import { CreateCourseAnswerSheetDto } from './dto/create-course-answer-sheet.dto';
import { UpdateCourseAnswerSheetDto } from './dto/update-course-answer-sheet.dto';

const includeFull = {
  questions: { orderBy: { sortOrder: 'asc' as const } },
  versions: {
    orderBy: { versionNumber: 'asc' as const },
    include: {
      answers: { orderBy: { sortOrder: 'asc' as const } },
    },
  },
};

@Injectable()
export class CourseAnswerSheetService {
  constructor(private readonly prisma: PrismaService) {}

  async findByTenant(tenantId: number) {
    return this.prisma.courseAnswerSheet.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        assessmentType: true,
        points: true,
        numberOfQuestions: true,
        numberOfKeyVersions: true,
        pdfPath: true,
        pdfSizeBytes: true,
        createdAt: true,
        updatedAt: true,
        courseId: true,
        course: {
          select: {
            id: true,
            title: true,
            code: true,
          },
        },
        _count: {
          select: {
            questions: true,
            versions: true,
          },
        },
      },
    });
  }

  async findByCourse(courseId: number, tenantId: number) {
    return this.prisma.courseAnswerSheet.findMany({
      where: { courseId, tenantId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        assessmentType: true,
        points: true,
        numberOfQuestions: true,
        pdfPath: true,
        pdfSizeBytes: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async findOne(courseId: number, id: number, tenantId: number) {
    const sheet = await this.prisma.courseAnswerSheet.findFirst({
      where: { id, courseId, tenantId },
      include: includeFull,
    });
    if (!sheet) {
      throw new NotFoundException('Answer sheet not found');
    }
    return sheet;
  }

  async create(
    courseId: number,
    tenantId: number,
    dto: CreateCourseAnswerSheetDto,
  ) {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, tenantId },
    });
    if (!course) {
      throw new NotFoundException('Course not found');
    }

    const { questions, versions, ...config } = dto;

    const sheet = await this.prisma.courseAnswerSheet.create({
      data: {
        ...config,
        courseId,
        tenantId,
        questions: {
          create: questions.map((question, index) => ({
            sortOrder: question.sortOrder ?? index,
            name: question.name,
            type: question.type,
            labels: question.labels,
          })),
        },
        versions: {
          create: versions.map((version) => ({
            versionNumber: version.versionNumber,
            versionName: version.versionName,
            answers: {
              create: version.answers.map((answer, index) => ({
                sortOrder: answer.sortOrder ?? index,
                questionNumber: answer.questionNumber,
                answers: answer.answers,
                type: answer.type,
                cloCode: answer.cloCode ?? null,
                points: answer.points,
              })),
            },
          })),
        },
      },
      include: includeFull,
    });

    await this.writeSummaryPdf(sheet.id, tenantId, sheet);
    return this.findOne(courseId, sheet.id, tenantId);
  }

  async update(
    courseId: number,
    id: number,
    tenantId: number,
    dto: UpdateCourseAnswerSheetDto,
  ) {
    await this.findOne(courseId, id, tenantId);

    const { questions, versions, ...config } = dto;

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(config).length > 0) {
        await tx.courseAnswerSheet.update({
          where: { id },
          data: config,
        });
      }

      if (questions) {
        await tx.courseAnswerSheetVersionAnswer.deleteMany({
          where: { version: { answerSheetId: id } },
        });
        await tx.courseAnswerSheetVersion.deleteMany({
          where: { answerSheetId: id },
        });
        await tx.courseAnswerSheetQuestion.deleteMany({
          where: { answerSheetId: id },
        });
        await tx.courseAnswerSheetQuestion.createMany({
          data: questions.map((question, index) => ({
            answerSheetId: id,
            sortOrder: question.sortOrder ?? index,
            name: question.name,
            type: question.type,
            labels: question.labels,
          })),
        });
      }

      if (versions) {
        await tx.courseAnswerSheetVersionAnswer.deleteMany({
          where: { version: { answerSheetId: id } },
        });
        await tx.courseAnswerSheetVersion.deleteMany({
          where: { answerSheetId: id },
        });

        for (const version of versions) {
          await tx.courseAnswerSheetVersion.create({
            data: {
              answerSheetId: id,
              versionNumber: version.versionNumber,
              versionName: version.versionName,
              answers: {
                create: version.answers.map((answer, index) => ({
                  sortOrder: answer.sortOrder ?? index,
                  questionNumber: answer.questionNumber,
                  answers: answer.answers,
                  type: answer.type,
                  cloCode: answer.cloCode ?? null,
                  points: answer.points,
                })),
              },
            },
          });
        }
      }
    });

    const updated = await this.findOne(courseId, id, tenantId);
    await this.writeSummaryPdf(id, tenantId, updated);
    return updated;
  }

  async remove(courseId: number, id: number, tenantId: number) {
    await this.findOne(courseId, id, tenantId);
    return this.prisma.courseAnswerSheet.delete({ where: { id } });
  }

  async download(courseId: number, id: number, tenantId: number) {
    const sheet = await this.findOne(courseId, id, tenantId);
    if (!sheet.pdfPath || !existsSync(sheet.pdfPath)) {
      await this.writeSummaryPdf(id, tenantId, sheet);
    }

    const refreshed = await this.findOne(courseId, id, tenantId);
    const filePath = refreshed.pdfPath;
    if (!filePath || !existsSync(filePath)) {
      throw new NotFoundException('PDF file not found');
    }

    const stream = createReadStream(filePath);
    const filename = `${sheet.name.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase() || 'answer-sheet'}.pdf`;
    return new StreamableFile(stream, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  private async writeSummaryPdf(
    sheetId: number,
    tenantId: number,
    sheet: {
      name: string;
      assessmentType: string;
      points: number;
      numberOfQuestions: number;
      versions: Array<{
        versionName: string;
        answers: Array<{
          questionNumber: number;
          answers: string[];
          type: string;
          cloCode: string | null;
          points: number;
        }>;
      }>;
    },
  ) {
    const dir = join(process.cwd(), 'tmp', 'answer-sheets', String(tenantId));
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `sheet-${sheetId}.pdf`);

    const lines: string[] = [
      `%PDF-1.4`,
      `1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj`,
      `2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj`,
    ];

    const content = [
      `BT /F1 16 Tf 50 780 Td (${this.escapePdfText(sheet.name)}) Tj ET`,
      `BT /F1 11 Tf 50 750 Td (${this.escapePdfText(`Type: ${sheet.assessmentType} | Points: ${sheet.points} | Questions: ${sheet.numberOfQuestions}`)}) Tj ET`,
      ...sheet.versions.flatMap((version, versionIndex) => {
        const yBase = 720 - versionIndex * 120;
        return [
          `BT /F1 12 Tf 50 ${yBase} Td (${this.escapePdfText(version.versionName)}) Tj ET`,
          ...version.answers.slice(0, 12).map((answer, answerIndex) => {
            const y = yBase - 18 - answerIndex * 14;
            const text = `Q${answer.questionNumber}: ${answer.answers.join(', ') || '-'} (${answer.type}, ${answer.points}pt${answer.cloCode ? `, ${answer.cloCode}` : ''})`;
            return `BT /F1 10 Tf 60 ${y} Td (${this.escapePdfText(text)}) Tj ET`;
          }),
        ];
      }),
    ].join('\n');

    const stream = `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj`;
    const contentObj = `4 0 obj << /Length ${Buffer.byteLength(content, 'utf8')} >> stream\n${content}\nendstream endobj`;
    const font = `5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj`;
    const body = [...lines, stream, contentObj, font, 'xref', '0 6', '0000000000 65535 f ', '0000000009 00000 n ', '0000000058 00000 n ', '0000000115 00000 n ', '0000000274 00000 n ', '0000000500 00000 n ', 'trailer << /Size 6 /Root 1 0 R >>', 'startxref', '600', '%%EOF'].join('\n');

    await writeFile(filePath, body, 'utf8');
    const stats = await import('node:fs/promises').then((fs) => fs.stat(filePath));

    await this.prisma.courseAnswerSheet.update({
      where: { id: sheetId },
      data: {
        pdfPath: filePath,
        pdfSizeBytes: stats.size,
      },
    });
  }

  private escapePdfText(value: string) {
    return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }
}
