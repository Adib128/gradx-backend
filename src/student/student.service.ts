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
import { paginate } from 'src/common/helpers/paginate.helper';

@Injectable()
export class StudentService {
  constructor(private readonly prisma: PrismaService) {}

  async create(courseId: number, createStudentDto: CreateStudentDto) {
    const student = await this.prisma.student.findUnique({
      where: { code: createStudentDto.code },
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
      code: this.cellToString(row[0]),
      name: this.cellToString(row[1]),
      class: this.cellToString(row[2]),
      departement: this.cellToString(row[3]),
    }));

    if (!rows.length)
      throw new BadRequestException(ErrorMessageKey.EXCEL_EMPTY);

    const results = {
      success: 0,
      failed: [] as { row: number; reason: string }[],
    };

    for (const row of rows) {
      try {
        // validate required fields
        if (!row.code || !row.name) {
          results.failed.push({
            row: row.rowNumber,
            reason: 'Missing required fields',
          });
          continue;
        }

        const exists = await this.prisma.student.findUnique({
          where: { code: row.code },
        });

        if (exists) {
          results.failed.push({
            row: row.rowNumber,
            reason: `Code ${row.code} already exists`,
          });
          continue;
        }

        await this.prisma.student.create({
          data: {
            code: row.code,
            name: row.name,
            class: row.class,
            departement: row.departement,
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
      this.cellToString(cell).toLowerCase().replace(/\s+/g, ''),
    );

    return (
      headers[0] === 'code' &&
      headers[1] === 'name' &&
      headers[2] === 'class' &&
      (headers[3] === 'departement' || headers[3] === 'department')
    );
  }

  private cellToString(value: unknown) {
    return value === undefined || value === null ? '' : String(value).trim();
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

    if (updateStudentDto.code && updateStudentDto.code !== student.code) {
      const codeExists = await this.prisma.student.findUnique({
        where: { code: updateStudentDto.code },
      });

      if (codeExists) {
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
