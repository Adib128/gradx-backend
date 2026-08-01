import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { CreateStudentDto } from './dto/create-student.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { PrismaService } from 'prisma/prisma.service';
import { ErrorMessageKey } from 'src/common/constants/error-message';
import * as XLSX from 'xlsx';

@Injectable()
export class StudentService {
  constructor(private readonly prisma: PrismaService) {}

  async create(courseId: number, createStudentDto: CreateStudentDto) {
    const student = await this.prisma.student.findUnique({
      where: { studentId: createStudentDto.studentId },
    });

    if (student) {
      throw new ConflictException(ErrorMessageKey.STUDENT_EXIST);
    }

    return await this.prisma.student.create({
      data: {
        ...createStudentDto,
        courseId,
      },
    });
  }

  async importExcel(courseId: number, file: Express.Multer.File) {
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
            courseId,
          },
        });

        results.success++;
      } catch {
        results.failed.push({ row: row.rowNumber, reason: 'Unexpected error' });
      }
    }

    return results;
  }

  private isStudentImportHeader(row?: unknown[]) {
    if (!row) {
      return false;
    }

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
    // Excel often stores IDs as numbers; keep integer form without scientific notation.
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Number.isInteger(value)
        ? String(value)
        : String(value).replace(/\.0+$/, '');
    }
    return String(value).trim();
  }

  findAll() {
    return `This action returns all student`;
  }

  async findOne(id: number) {
    const student = await this.prisma.student.findUnique({
      where: { id },
    });

    if (!student) {
      throw new ConflictException(ErrorMessageKey.STUDENT_NOT_FOUND);
    }
    return student;
  }

  async update(id: number, updateStudentDto: UpdateStudentDto) {
    const student = await this.prisma.student.findUnique({
      where: { id },
    });

    if (!student) {
      throw new ConflictException(ErrorMessageKey.STUDENT_NOT_FOUND);
    }

    if (
      updateStudentDto.studentId &&
      updateStudentDto.studentId !== student.studentId
    ) {
      const studentIdExists = await this.prisma.student.findUnique({
        where: { studentId: updateStudentDto.studentId },
      });

      if (studentIdExists) {
        throw new ConflictException(ErrorMessageKey.STUDENT_EXIST);
      }
    }

    return await this.prisma.student.update({
      where: { id },
      data: updateStudentDto,
    });
  }

  async remove(id: number) {
    const student = await this.prisma.student.findUnique({
      where: { id },
    });

    if (!student) {
      throw new ConflictException(ErrorMessageKey.STUDENT_NOT_FOUND);
    }

    return await this.prisma.student.delete({
      where: { id },
    });
  }
}
