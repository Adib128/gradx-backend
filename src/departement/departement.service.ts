import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateDepartementDto } from './dto/create-departement.dto';
import { UpdateDepartementDto } from './dto/update-departement.dto';
import { PrismaService } from 'prisma/prisma.service';
import { ErrorMessageKey } from 'src/common/constants/error-message';

@Injectable()
export class DepartementService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: number, createDepartementDto: CreateDepartementDto) {
    const departement = await this.prisma.departement.findFirst({
      where: { name: createDepartementDto.name },
    });

    if (departement) {
      throw new ConflictException(ErrorMessageKey.DEPARTEMENT_EXIST);
    }

    return await this.prisma.departement.create({
      data: {
        ...createDepartementDto,
        tenant: { connect: { id: tenantId } },
      },
    });
  }

  async findAll(tenantId: number) {
    return await this.prisma.departement.findMany({ where: { tenantId } });
  }

  async findOne(tenantId: number, id: number) {
    const tenant = await this.prisma.departement.findFirst({
      where: { id, tenantId },
      include: {
        classes: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!tenant) {
      throw new NotFoundException(ErrorMessageKey.USER_NOT_FOUND);
    }
    return tenant;
  }

  async update(id: number, updateDepartementDto: UpdateDepartementDto) {
    const departement = await this.prisma.departement.findUnique({
      where: { id },
    });

    if (!departement) {
      throw new NotFoundException(ErrorMessageKey.USER_NOT_FOUND);
    }

    const updatedDepartement = await this.prisma.departement.update({
      where: { id },
      data: {
        ...updateDepartementDto,
      },
    });
    return updatedDepartement;
  }

  async remove(id: number) {
    return await this.prisma.departement.delete({
      where: { id },
    });
  }
}
