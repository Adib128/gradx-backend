import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { PrismaService } from 'prisma/prisma.service';
import { GenerateContentDto } from './dto/generate-content.dto';
import { ContentGenerationJob } from './interfaces/content-generation-job.interface';
import { TopicContentAiService } from './topic-content-ai.service';
import { ReferenceSchemaDto } from 'src/course/dto/create-reference.dto';
import z from 'zod';
import { ReferenceSchema } from 'src/course/schemas/reference.schema';
import { ContentType } from 'generated/prisma/enums';

@Injectable()
export class TopicContentService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('topic-content-generation')
    private readonly contentQueue: Queue,
    private readonly topicContentAiService: TopicContentAiService,
  ) {}

  async generate(
    tenantId: number,
    topicId: number,
    generationContentDto: GenerateContentDto,
  ) {
    const topic = await this.prisma.topic.findFirst({
      where: { id: topicId, course: { tenantId } },
      include: {
        course: {
          include: {
            clos: true,
          },
        },
      },
    });

    if (!topic) {
      throw new NotFoundException('Topic not found');
    }

    const contentGenration: ContentGenerationJob = {
      tenantId: tenantId,
      topicId: topic.id,
      topicNumber: topic.topicNumber,
      contentId: topic.id,
      type: 'LECTURE',
      topicTitle: topic.title,
      courseId: topic.course.id,
      courseTitle: topic.course.title ?? '',
      courseDescription: topic.course.description ?? '',
      clos: topic.course.clos.map((c) => ({
        code: c.code,
        category: c.category,
        programCLOCode: c.programCLOCode,
        description: c.description,
        teachingStrategies: c.teachingStrategies,
        assessmentMethods: c.assessmentMethods,
      })),
      references: z.array(ReferenceSchema).parse(topic.course.references ?? []),
    };

    const job = await this.contentQueue.add(
      'topic-content-generation',
      contentGenration,
      {
        attempts: 3,
        removeOnComplete: false,
        removeOnFail: false,
      },
    );

    return { jobId: job.id, status: 'processing' };
  }

  async getGenerateStatus(jobId: string) {
    const job = await this.contentQueue.getJob(jobId);

    if (!job) throw new NotFoundException('Job not found');

    const state = await job.getState();

    return {
      jobId,
      status: state,
      progress: job.progress,
      result: state === 'completed' ? job.returnvalue : null,
      error: state === 'failed' ? job.failedReason : null,
    };
  }

  async saveContent(
    topicId: number,
    courseId: number,
    tenantId: number,
    type: ContentType,
    content: any,
  ) {
    console.log('dkhal');
    return await this.prisma.topicContent.upsert({
      where: { topicId_type: { topicId, type } },
      create: {
        topicId,
        courseId,
        tenantId,
        type,
        status: 'COMPLETED',
        content,
      },
      update: {
        status: 'COMPLETED',
        content,
      },
    });
  }
}
