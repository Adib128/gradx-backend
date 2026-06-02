import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateCloDto } from './dto/create-clo.dto';
import { UpdateCloDto } from './dto/update-clo.dto';
import { PrismaService } from 'prisma/prisma.service';

@Injectable()
export class CloService {
  constructor(private readonly prisma: PrismaService) {}
  async create(createCloDto: CreateCloDto) {
    return await this.prisma.clo.create({
      data: {
        ...createCloDto,
      },
    });
  }

  async findOne(id: number) {
    const clo = await this.prisma.clo.findUnique({
      where: { id },
    });

    if (!clo) {
      throw new NotFoundException('Clo is not found');
    }
    return clo;
  }

  async update(id: number, updateCloDto: UpdateCloDto) {
    const clo = await this.prisma.clo.findUnique({
      where: { id },
    });

    if (!clo) {
      throw new NotFoundException('Clo is not found');
    }
    return await this.prisma.clo.update({
      where: { id },
      data: {
        ...updateCloDto,
      },
    });
  }

  async remove(id: number) {
    return await this.prisma.clo.delete({
      where: { id },
    });
  }
}
