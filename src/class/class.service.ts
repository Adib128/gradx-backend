import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateClassDto } from './dto/create-class.dto';
import { UpdateClassDto } from './dto/update-class.dto';
import { PrismaService } from 'prisma/prisma.service';
import { ErrorMessageKey } from 'src/common/constants/error-message';
import { StudentQueryDto } from './dto/student-query.dto';

@Injectable()
export class ClassService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: number, createClassDto: CreateClassDto) {
    const selectClass = await this.prisma.class.findFirst({
      where: { name: createClassDto.name },
    });

    if (selectClass) {
      throw new ConflictException(ErrorMessageKey.CLASS_EXIST);
    }

    return await this.prisma.class.create({
      data: {
        name: createClassDto.name,
        tenant: { connect: { id: tenantId } },
        departement: { connect: { id: createClassDto.departementId } },
      },
    });
  }

  async findAll(tenantId: number) {
    return await this.prisma.class.findMany({ where: { tenantId } });
  }

  async findOne(id: number) {
    const selectClass = this.prisma.class.findUnique({
      where: { id },
      include: {
        students: {
          select: {
            name: true,
            code: true,
          },
        },
      },
    });

    if (!selectClass) {
      return new NotFoundException(ErrorMessageKey.CLASS_NOT_FOUND);
    }

    return selectClass;
  }

  async update(id: number, updateClassDto: UpdateClassDto) {
    const selectClass = this.prisma.class.findUnique({
      where: { id },
    });

    if (!selectClass) {
      return new NotFoundException(ErrorMessageKey.CLASS_NOT_FOUND);
    }

    return await this.prisma.class.update({
      where: { id },
      data: {
        name: updateClassDto.name,
      },
      select: {
        id: true,
        name: true,
        departement: true,
      },
    });
  }

  async remove(id: number) {
    const selectClass = await this.prisma.class.findUnique({
      where: { id },
    });

    if (!selectClass) {
      return new NotFoundException(ErrorMessageKey.CLASS_NOT_FOUND);
    }

    return await this.prisma.class.delete({
      where: { id },
    });
  }
}
