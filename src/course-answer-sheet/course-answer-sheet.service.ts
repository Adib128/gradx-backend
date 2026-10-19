import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import { join } from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { PrismaService } from 'prisma/prisma.service';
import { CreateCourseAnswerSheetDto } from './dto/create-course-answer-sheet.dto';
import { UpdateCourseAnswerSheetDto } from './dto/update-course-answer-sheet.dto';
import { CreateStudentDto } from 'src/student/dto/create-student.dto';
import { UpdateStudentDto } from 'src/student/dto/update-student.dto';
import { academicYearMatchValues } from 'src/course/utils/academic-year.util';
import { ErrorMessageKey } from 'src/common/constants/error-message';
import { Prisma } from 'generated/prisma/client';
import * as XLSX from 'xlsx';

const includeFull = {
  questions: { orderBy: { sortOrder: 'asc' as const } },
  versions: {
    orderBy: { versionNumber: 'asc' as const },
    include: {
      answers: { orderBy: { sortOrder: 'asc' as const } },
    },
  },
  clos: { orderBy: { sortOrder: 'asc' as const } },
  course: {
    select: {
      id: true,
      title: true,
      code: true,
      academicYear: true,
      semester: true,
      clos: {
        orderBy: { id: 'asc' as const },
        select: {
          id: true,
          code: true,
          description: true,
          category: true,
        },
      },
    },
  },
};

type CloInput = {
  code: string;
  description?: string;
  sortOrder?: number;
};

@Injectable()
export class CourseAnswerSheetService {
  constructor(private readonly prisma: PrismaService) {}

  async findByTenant(
    tenantId: number,
    filters?: { academicYear?: string; semester?: string },
  ) {
    const academicYear = String(filters?.academicYear || '').trim();
    const semester = String(filters?.semester || '')
      .trim()
      .toUpperCase();

    const courseWhere: Prisma.CourseWhereInput = { deletedAt: null };
    if (academicYear) {
      courseWhere.academicYear = {
        in: academicYearMatchValues(academicYear),
      };
    }
    if (semester && ['FIRST', 'SECOND', 'THIRD'].includes(semester)) {
      courseWhere.semester = semester;
    }

    const hasCourseFilter = Boolean(academicYear || semester);
    const where: Prisma.CourseAnswerSheetWhereInput = {
      tenantId,
      ...(hasCourseFilter
        ? {
            OR: [
              { courseId: null },
              { course: courseWhere },
            ],
          }
        : {}),
    };

    return this.prisma.courseAnswerSheet.findMany({
      where,
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
            academicYear: true,
            semester: true,
          },
        },
        _count: {
          select: {
            questions: true,
            versions: true,
            clos: true,
            gradingScans: true,
          },
        },
      },
    });
  }

  async findByCourse(courseId: number, tenantId: number) {
    return this.prisma.courseAnswerSheet.findMany({
      where: { courseId, tenantId, course: { deletedAt: null } },
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

  async findOneById(id: number, tenantId: number) {
    const sheet = await this.prisma.courseAnswerSheet.findFirst({
      where: {
        id,
        tenantId,
        OR: [{ courseId: null }, { course: { deletedAt: null } }],
      },
      include: includeFull,
    });
    if (!sheet) {
      throw new NotFoundException('Answer sheet not found');
    }
    return sheet;
  }

  async findOne(courseId: number, id: number, tenantId: number) {
    const sheet = await this.prisma.courseAnswerSheet.findFirst({
      where: { id, courseId, tenantId, course: { deletedAt: null } },
      include: includeFull,
    });
    if (!sheet) {
      throw new NotFoundException('Answer sheet not found');
    }
    return sheet;
  }

  private async resolveCourseId(
    tenantId: number,
    courseId: number | null | undefined,
  ) {
    if (courseId == null) return null;
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!course) {
      throw new NotFoundException('Course not found');
    }
    return course.id;
  }

  private normalizeClos(clos: CloInput[] | undefined, linkedToCourse: boolean) {
    if (linkedToCourse) return [];
    const seen = new Set<string>();
    return (clos || [])
      .map((clo, index) => ({
        code: String(clo.code || '').trim(),
        description: String(clo.description || '').trim(),
        sortOrder: clo.sortOrder ?? index,
      }))
      .filter((clo) => {
        if (!clo.code) return false;
        const key = clo.code.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  async createForTenant(tenantId: number, dto: CreateCourseAnswerSheetDto) {
    const resolvedCourseId = await this.resolveCourseId(tenantId, dto.courseId);
    const { questions, versions, clos, courseId: _ignored, ...config } = dto;
    const sheetClos = this.normalizeClos(clos, resolvedCourseId != null);

    const sheet = await this.prisma.courseAnswerSheet.create({
      data: {
        ...config,
        courseId: resolvedCourseId,
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
        clos: {
          create: sheetClos,
        },
      },
      include: includeFull,
    });

    await this.writeSummaryPdf(sheet.id, tenantId, sheet);
    return this.findOneById(sheet.id, tenantId);
  }

  async create(
    courseId: number,
    tenantId: number,
    dto: CreateCourseAnswerSheetDto,
  ) {
    return this.createForTenant(tenantId, { ...dto, courseId });
  }

  async updateById(
    id: number,
    tenantId: number,
    dto: UpdateCourseAnswerSheetDto,
  ) {
    const existing = await this.findOneById(id, tenantId);
    const nextCourseId =
      dto.courseId !== undefined
        ? await this.resolveCourseId(tenantId, dto.courseId)
        : existing.courseId;

    const { questions, versions, clos, courseId: _ignored, ...config } =
      dto;

    await this.prisma.$transaction(async (tx) => {
      const data: Prisma.CourseAnswerSheetUpdateInput = {
        ...config,
      };
      if (dto.courseId !== undefined) {
        data.course =
          nextCourseId == null
            ? { disconnect: true }
            : { connect: { id: nextCourseId } };
      }
      if (Object.keys(data).length > 0) {
        await tx.courseAnswerSheet.update({
          where: { id },
          data,
        });
      }

      if (clos !== undefined || dto.courseId !== undefined) {
        await tx.courseAnswerSheetClo.deleteMany({
          where: { answerSheetId: id },
        });
        const sheetClos = this.normalizeClos(
          clos ??
            existing.clos.map((clo) => ({
              code: clo.code,
              description: clo.description,
              sortOrder: clo.sortOrder,
            })),
          nextCourseId != null,
        );
        if (sheetClos.length > 0) {
          await tx.courseAnswerSheetClo.createMany({
            data: sheetClos.map((clo) => ({
              answerSheetId: id,
              code: clo.code,
              description: clo.description,
              sortOrder: clo.sortOrder,
            })),
          });
        }
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
        if (!questions) {
          await tx.courseAnswerSheetVersionAnswer.deleteMany({
            where: { version: { answerSheetId: id } },
          });
          await tx.courseAnswerSheetVersion.deleteMany({
            where: { answerSheetId: id },
          });
        }

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

    const updated = await this.findOneById(id, tenantId);
    await this.writeSummaryPdf(id, tenantId, updated);
    return updated;
  }

  async update(
    courseId: number,
    id: number,
    tenantId: number,
    dto: UpdateCourseAnswerSheetDto,
  ) {
    await this.findOne(courseId, id, tenantId);
    return this.updateById(id, tenantId, { ...dto, courseId });
  }

  async removeById(id: number, tenantId: number) {
    const sheet = await this.findOneById(id, tenantId);
    const deleted = await this.prisma.courseAnswerSheet.delete({
      where: { id },
    });
    if (sheet.pdfPath) {
      await unlink(sheet.pdfPath).catch(() => undefined);
    }
    return deleted;
  }

  async remove(courseId: number, id: number, tenantId: number) {
    await this.findOne(courseId, id, tenantId);
    return this.removeById(id, tenantId);
  }

  async downloadById(id: number, tenantId: number) {
    const sheet = await this.findOneById(id, tenantId);
    if (!sheet.pdfPath || !existsSync(sheet.pdfPath)) {
      await this.writeSummaryPdf(id, tenantId, sheet);
    }

    const refreshed = await this.findOneById(id, tenantId);
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

  async download(courseId: number, id: number, tenantId: number) {
    await this.findOne(courseId, id, tenantId);
    return this.downloadById(id, tenantId);
  }

  async getReport(id: number, tenantId: number) {
    const sheet = await this.findOneById(id, tenantId);
    const scans = await this.prisma.gradingScan.findMany({
      where: {
        tenantId,
        courseAnswerSheetId: id,
        confirmedAt: { not: null },
      },
      include: {
        student: {
          select: { id: true, name: true, studentId: true, section: true },
        },
      },
      orderBy: { confirmedAt: 'desc' },
    });

    const cloDefs =
      sheet.courseId && sheet.course?.clos?.length
        ? sheet.course.clos.map((clo) => ({
            code: clo.code,
            description: clo.description || '',
          }))
        : sheet.clos.map((clo) => ({
            code: clo.code,
            description: clo.description || '',
          }));

    const version = sheet.versions[0];
    const cloMax = new Map<string, number>();
    for (const answer of version?.answers || []) {
      const code = String(answer.cloCode || '').trim();
      if (!code) continue;
      cloMax.set(code, (cloMax.get(code) || 0) + Number(answer.points || 0));
    }

    const scores = scans
      .map((scan) => Number(scan.score))
      .filter((value) => Number.isFinite(value));
    const maxScores = scans
      .map((scan) => Number(scan.maxScore))
      .filter((value) => Number.isFinite(value) && value > 0);
    const avg =
      scores.length > 0
        ? scores.reduce((sum, value) => sum + value, 0) / scores.length
        : null;
    const maxScore =
      maxScores.length > 0
        ? Math.max(...maxScores)
        : sheet.points || null;
    const passThreshold = maxScore != null ? maxScore * 0.7 : null;
    const passing =
      passThreshold == null
        ? null
        : scores.filter((score) => score >= passThreshold).length;

    const cloRows = cloDefs.map((clo) => {
      const max = cloMax.get(clo.code) || 0;
      return {
        code: clo.code,
        description: clo.description,
        maxMarks: max > 0 ? max : null,
      };
    });

    return {
      sheet: {
        id: sheet.id,
        name: sheet.name,
        assessmentType: sheet.assessmentType,
        points: sheet.points,
        numberOfQuestions: sheet.numberOfQuestions,
        courseId: sheet.courseId,
        course: sheet.course
          ? {
              id: sheet.course.id,
              title: sheet.course.title,
              code: sheet.course.code,
            }
          : null,
      },
      kpis: {
        gradedCount: scans.length,
        average: avg != null ? Math.round(avg * 10) / 10 : null,
        passing,
        passRatePercent: 70,
        maxScore,
      },
      cloRows,
      components: [
        {
          assessmentId: sheet.id,
          title: sheet.name,
          type: sheet.assessmentType,
          maxScore: sheet.points,
          weight: 100,
          courseWeight: 100,
        },
      ],
      scans: scans.map((scan) => ({
        id: scan.id,
        score: scan.score,
        maxScore: scan.maxScore,
        confidence: scan.confidence,
        detectedStudentId: scan.detectedStudentId,
        matchedStudentCode: scan.matchedStudentCode,
        confirmedAt: scan.confirmedAt,
        createdAt: scan.createdAt,
        student: scan.student,
      })),
    };
  }

  async listScans(id: number, tenantId: number) {
    await this.findOneById(id, tenantId);
    return this.prisma.gradingScan.findMany({
      where: { tenantId, courseAnswerSheetId: id },
      include: {
        student: {
          select: { id: true, name: true, studentId: true, section: true },
        },
      },
      orderBy: [{ confirmedAt: 'desc' }, { createdAt: 'desc' }],
    });
  }

  /** Students are only managed on standalone (no-course) answer sheets. */
  private async requireStandaloneSheet(id: number, tenantId: number) {
    const sheet = await this.findOneById(id, tenantId);
    if (sheet.courseId != null) {
      throw new BadRequestException(
        'Students for course-linked answer sheets are managed on the course.',
      );
    }
    return sheet;
  }

  async listStudents(id: number, tenantId: number) {
    await this.requireStandaloneSheet(id, tenantId);
    return this.prisma.student.findMany({
      where: { courseAnswerSheetId: id },
      orderBy: [{ studentId: 'asc' }, { id: 'asc' }],
    });
  }

  async createStudent(
    id: number,
    tenantId: number,
    dto: CreateStudentDto,
  ) {
    await this.requireStandaloneSheet(id, tenantId);
    const exists = await this.prisma.student.findUnique({
      where: { studentId: dto.studentId },
    });
    if (exists) {
      throw new ConflictException(ErrorMessageKey.STUDENT_EXIST);
    }
    return this.prisma.student.create({
      data: {
        ...dto,
        courseId: null,
        courseAnswerSheetId: id,
      },
    });
  }

  async updateStudent(
    sheetId: number,
    studentId: number,
    tenantId: number,
    dto: UpdateStudentDto,
  ) {
    await this.requireStandaloneSheet(sheetId, tenantId);
    const student = await this.prisma.student.findFirst({
      where: { id: studentId, courseAnswerSheetId: sheetId },
    });
    if (!student) {
      throw new NotFoundException(ErrorMessageKey.STUDENT_NOT_FOUND);
    }
    if (dto.studentId && dto.studentId !== student.studentId) {
      const conflict = await this.prisma.student.findUnique({
        where: { studentId: dto.studentId },
      });
      if (conflict) {
        throw new ConflictException(ErrorMessageKey.STUDENT_EXIST);
      }
    }
    return this.prisma.student.update({
      where: { id: studentId },
      data: dto,
    });
  }

  async removeStudent(sheetId: number, studentId: number, tenantId: number) {
    await this.requireStandaloneSheet(sheetId, tenantId);
    const student = await this.prisma.student.findFirst({
      where: { id: studentId, courseAnswerSheetId: sheetId },
    });
    if (!student) {
      throw new NotFoundException(ErrorMessageKey.STUDENT_NOT_FOUND);
    }
    return this.prisma.student.delete({ where: { id: studentId } });
  }

  async importStudents(
    id: number,
    tenantId: number,
    file: Express.Multer.File,
  ) {
    await this.requireStandaloneSheet(id, tenantId);
    if (!file?.buffer) {
      throw new BadRequestException('Excel file is required');
    }

    const workbook = XLSX.read(file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const sheetRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      defval: '',
    });

    const hasHeader = this.isStudentImportHeader(sheetRows[0]);
    const rows = sheetRows.slice(hasHeader ? 1 : 0).map((row, index) => ({
      rowNumber: index + (hasHeader ? 2 : 1),
      studentId: this.cellToString(row[0]),
      name: this.cellToString(row[1]),
      section: this.cellToString(row[2]),
      departement: this.cellToString(row[3]),
    }));

    if (!rows.length) {
      throw new BadRequestException(ErrorMessageKey.EXCEL_EMPTY);
    }

    const results = {
      success: 0,
      failed: [] as { row: number; reason: string }[],
    };

    for (const row of rows) {
      try {
        if (!row.studentId || !row.name) {
          results.failed.push({
            row: row.rowNumber,
            reason: 'Missing required fields',
          });
          continue;
        }

        const exists = await this.prisma.student.findUnique({
          where: { studentId: row.studentId },
        });
        if (exists) {
          results.failed.push({
            row: row.rowNumber,
            reason: `Student ID ${row.studentId} already exists`,
          });
          continue;
        }

        await this.prisma.student.create({
          data: {
            studentId: row.studentId,
            name: row.name,
            section: row.section || null,
            departement: row.departement || null,
            courseId: null,
            courseAnswerSheetId: id,
          },
        });
        results.success += 1;
      } catch {
        results.failed.push({ row: row.rowNumber, reason: 'Unexpected error' });
      }
    }

    return results;
  }

  private isStudentImportHeader(row?: unknown[]) {
    if (!row) return false;
    const headers = row.map((cell) =>
      this.cellToString(cell).toLowerCase().replace(/[\s_]+/g, ''),
    );
    const studentIdHeader = [
      'studentid',
      'id',
      'code',
      'studentcode',
      'studentnumber',
    ].includes(headers[0]);
    const nameHeader = [
      'name',
      'studentname',
      'fullname',
      'studentfullname',
    ].includes(headers[1]);
    const sectionHeader = ['section', 'class', 'group'].includes(headers[2]);
    const departmentHeader = [
      'departement',
      'department',
      'dept',
      'departmentname',
    ].includes(headers[3]);
    return studentIdHeader && nameHeader && sectionHeader && departmentHeader;
  }

  private cellToString(value: unknown) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Number.isInteger(value)
        ? String(value)
        : String(value).replace(/\.0+$/, '');
    }
    return String(value).trim();
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
    const body = [
      ...lines,
      stream,
      contentObj,
      font,
      'xref',
      '0 6',
      '0000000000 65535 f ',
      '0000000009 00000 n ',
      '0000000058 00000 n ',
      '0000000115 00000 n ',
      '0000000274 00000 n ',
      '0000000500 00000 n ',
      'trailer << /Size 6 /Root 1 0 R >>',
      'startxref',
      '600',
      '%%EOF',
    ].join('\n');

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
