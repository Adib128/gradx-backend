import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { CreateStudentDto } from './dto/create-student.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { PrismaService } from 'prisma/prisma.service';
import { ErrorMessageKey } from 'src/common/constants/error-message';
import { StudentQueryDto } from 'src/class/dto/student-query.dto';
import * as XLSX from 'xlsx';
import { paginate } from 'src/common/helpers/paginate.helper';

@Injectable()
export class StudentService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: number, createStudentDto: CreateStudentDto) {
    const student = await this.prisma.student.findUnique({
      where: { code: createStudentDto.code },
    });

    if (student) {
      throw new ConflictException(ErrorMessageKey.STUDENT_EXIST);
    }

    return await this.prisma.student.create({
      data: {
        name: createStudentDto.name,
        code: createStudentDto.code,
        tenant: { connect: { id: tenantId } },
        class: { connect: { id: createStudentDto.classId } },
      },
    });
  }

  async importExcel(
    tenantId: number,
    classId: number,
    file: Express.Multer.File,
  ) {
    const workbook = XLSX.read(file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<{
      code: string;
      name: string;
    }>(sheet, {
      header: ['code', 'name'],
      range: 0,
    });
    if (!rows.length)
      throw new BadRequestException(ErrorMessageKey.EXCEL_EMPTY);

    const results = {
      success: 0,
      failed: [] as { row: number; reason: string }[],
    };

    for (const [index, row] of rows.entries()) {
      try {
        // validate required fields
        if (!row.code || !row.name) {
          results.failed.push({
            row: index + 2,
            reason: 'Missing required fields',
          });
          continue;
        }

        // check duplicate email within tenant
        const exists = await this.prisma.student.findFirst({
          where: { code: row.code, tenantId },
        });

        if (exists) {
          results.failed.push({
            row: index + 2,
            reason: `Code ${row.code} already exists`,
          });
          continue;
        }

        await this.prisma.student.create({
          data: {
            code: row.code,
            name: row.name,
            tenant: { connect: { id: tenantId } },
            class: { connect: { id: classId } },
          },
        });

        results.success++;
      } catch {
        results.failed.push({ row: index + 2, reason: 'Unexpected error' });
      }
    }

    return results;
  }

  findAll() {
    return `This action returns all student`;
  }

  async findByClass(classId: number, tenantId: number, query: StudentQueryDto) {
    const { page, limit, search } = query;

    const skip = (page - 1) * limit;

    const where = {
      classId,
      tenantId,
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' as const } },
          { code: { contains: search, mode: 'insensitive' as const } },
        ],
      }),
    };

    const [students, total] = await Promise.all([
      this.prisma.student.findMany({
        where,
        skip,
        take: limit,
        select: {
          id: true,
          name: true,
          code: true,
        },
      }),
      this.prisma.student.count({ where }),
    ]);

    return paginate(students, total, page, limit);
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

    return await this.prisma.student.update({
      where: { id },
      data: {
        name: updateStudentDto.name,
        code: updateStudentDto.code,
      },
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
