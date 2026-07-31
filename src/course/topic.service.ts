import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { CreateTopicDto } from './dto/create-topic.dto';
import { ErrorMessageKey } from 'src/common/constants/error-message';
import { UpdateTopicDto } from './dto/update-topic.dto';

@Injectable()
export class TopicService {
  constructor(private readonly prisma: PrismaService) {}

  async create(courseId: number, createTopicDto: CreateTopicDto) {
    const { mappedClos = [], ...topicData } = createTopicDto;

    const existing = await this.prisma.topic.findFirst({
      where: { courseId, topicNumber: topicData.topicNumber },
    });

    if (existing) {
      throw new ConflictException(ErrorMessageKey.TOPIC_EXIST);
    }

    return await this.prisma.$transaction(async (tx) => {
      const topic = await tx.topic.create({
        data: {
          courseId,
          topicNumber: topicData.topicNumber,
          title: topicData.title,
          contactHours: topicData.contactHours,
        },
      });

      await this.syncTopicClos(tx, courseId, topic.id, mappedClos);

      return tx.topic.findUniqueOrThrow({
        where: { id: topic.id },
        include: {
          topicClos: {
            include: { clo: true },
          },
        },
      });
    });
  }

  async updateTopic(topicId: number, updateTopicDto: UpdateTopicDto) {
    const topic = await this.prisma.topic.findUnique({
      where: { id: topicId },
    });

    if (!topic) {
      throw new NotFoundException(ErrorMessageKey.TOPIC_NOT_FOUND);
    }

    const { mappedClos, ...topicData } = updateTopicDto;

    return await this.prisma.$transaction(async (tx) => {
      const updated = await tx.topic.update({
        where: { id: topicId },
        data: {
          ...(topicData.topicNumber !== undefined && {
            topicNumber: topicData.topicNumber,
          }),
          ...(topicData.title !== undefined && { title: topicData.title }),
          ...(topicData.contactHours !== undefined && {
            contactHours: topicData.contactHours,
          }),
        },
      });

      if (mappedClos !== undefined) {
        await this.syncTopicClos(tx, topic.courseId, topicId, mappedClos);
      }

      return tx.topic.findUniqueOrThrow({
        where: { id: updated.id },
        include: {
          topicClos: {
            include: { clo: true },
          },
        },
      });
    });
  }

  async deleteTopic(topicId: number) {
    const topic = await this.prisma.topic.findUnique({
      where: { id: topicId },
    });

    if (!topic) {
      throw new NotFoundException(ErrorMessageKey.TOPIC_NOT_FOUND);
    }

    return await this.prisma.topic.delete({
      where: { id: topicId },
    });
  }

  private async syncTopicClos(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    courseId: number,
    topicId: number,
    mappedClos: string[],
  ) {
    const codes = Array.from(
      new Set(
        (mappedClos ?? [])
          .map((code) => String(code ?? '').trim())
          .filter(Boolean),
      ),
    );

    await tx.topicClo.deleteMany({ where: { topicId } });

    if (codes.length === 0) return;

    const clos = await tx.clo.findMany({
      where: { courseId },
      select: { id: true, code: true },
    });

    const byCode = new Map(
      clos.map((clo) => [clo.code.trim().toUpperCase(), clo.id]),
    );

    const cloIds = codes
      .map((code) => byCode.get(code.toUpperCase()))
      .filter((id): id is number => typeof id === 'number');

    if (cloIds.length === 0) return;

    await tx.topicClo.createMany({
      data: cloIds.map((cloId) => ({ topicId, cloId })),
      skipDuplicates: true,
    });
  }
}
