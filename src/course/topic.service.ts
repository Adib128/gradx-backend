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
    const topic = await this.prisma.topic.findFirst({
      where: { topicNumber: createTopicDto.topicNumber },
    });

    if (topic) {
      throw new ConflictException(ErrorMessageKey.TOPIC_EXIST);
    }

    return await this.prisma.topic.create({
      data: {
        courseId,
        ...createTopicDto,
      },
    });
  }

  async updateTopic(topicId: number, updateTopicDto: UpdateTopicDto) {
    const topic = await this.prisma.topic.findUnique({
      where: { id: topicId },
    });

    if (!topic) {
      throw new NotFoundException(ErrorMessageKey.TOPIC_NOT_FOUND);
    }

    return await this.prisma.topic.update({
      where: { id: topicId },
      data: {
        ...updateTopicDto,
      },
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
}
