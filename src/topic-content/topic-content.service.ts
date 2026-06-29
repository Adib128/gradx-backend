import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from 'prisma/prisma.service';
import { GenerateContentDto } from './dto/generate-content.dto';
import { ContentGenerationJob } from './interfaces/content-generation-job.interface';
import { TopicContentAiService } from './topic-content-ai.service';
import { ReferenceSchemaDto } from 'src/course/dto/create-reference.dto';
import z from 'zod';
import { ReferenceSchema } from 'src/course/schemas/reference.schema';
import { ContentType } from 'generated/prisma/enums';
import { extractPdfDocument } from './utils/extract-pdf-text.util';
import { buildLectureContentFromPdfExtraction } from './utils/pdf-lecture-content.util';

type UploadedLectureMeta = {
  source: 'upload';
  fileName: string;
  filePath: string;
  size: number;
  mimeType: string;
};

@Injectable()
export class TopicContentService {
  private readonly logger = new Logger(TopicContentService.name);

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
        topicContents: {
          where: {
            type: 'LECTURE',
            status: 'COMPLETED',
          },
          orderBy: { updatedAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!topic) {
      throw new NotFoundException('Topic not found');
    }

    const lectureContent = topic.topicContents[0];

    if (
      (generationContentDto.type === 'SLIDES' ||
        generationContentDto.type === 'LAB') &&
      !lectureContent?.content
    ) {
      throw new NotFoundException(
        'Generate and accept lecture content before generating slides or lab content.',
      );
    }

    const contentGeneration: ContentGenerationJob = {
      ...generationContentDto,
      tenantId,
      topicId: topic.id,
      topicNumber: topic.topicNumber,
      contentId: topic.id,
      topicTitle: topic.title,
      courseId: topic.course.id,
      courseTitle: topic.course.title ?? '',
      courseDescription: topic.course.description ?? '',
      clos: topic.course.clos.map((clo) => ({
        code: clo.code,
        category: clo.category,
        programCLOCode: clo.programCLOCode,
        description: clo.description,
        teachingStrategies: clo.teachingStrategies,
        assessmentMethods: clo.assessmentMethods,
        courseId: clo.courseId,
      })),
      references: z.array(ReferenceSchema).parse(topic.course.references ?? []),
      sourceLectureContentId: lectureContent?.id,
      sourceLectureContent: lectureContent?.content,
    };

    const job = await this.contentQueue.add(
      'topic-content-generation',
      contentGeneration,
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

  private parseUploadedLectureMeta(content: unknown): UploadedLectureMeta | null {
    if (!content || typeof content !== 'object') return null;
    const data = content as Record<string, unknown>;

    const readMeta = (meta: Record<string, unknown>): UploadedLectureMeta | null => {
      if (
        meta.source !== 'upload' ||
        typeof meta.fileName !== 'string' ||
        typeof meta.filePath !== 'string'
      ) {
        return null;
      }

      return {
        source: 'upload',
        fileName: meta.fileName,
        filePath: meta.filePath,
        size: typeof meta.size === 'number' ? meta.size : 0,
        mimeType:
          typeof meta.mimeType === 'string' ? meta.mimeType : 'application/pdf',
      };
    };

    if (data.source === 'upload') {
      return readMeta(data);
    }

    if (data.metadata && typeof data.metadata === 'object') {
      return readMeta(data.metadata as Record<string, unknown>);
    }

    return null;
  }

  async uploadLecture(
    tenantId: number,
    topicId: number,
    file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Lecture PDF file is required.');
    }

    const mimeType = file.mimetype?.toLowerCase() ?? '';
    const originalName = file.originalname?.toLowerCase() ?? '';
    const isPdf =
      mimeType === 'application/pdf' || originalName.endsWith('.pdf');

    if (!isPdf) {
      throw new BadRequestException('Only PDF files are supported.');
    }

    const topic = await this.prisma.topic.findFirst({
      where: { id: topicId, course: { tenantId } },
      include: {
        topicContents: {
          where: { type: 'LECTURE' },
          take: 1,
        },
      },
    });

    if (!topic) {
      throw new NotFoundException('Topic not found');
    }

    const existingMeta = this.parseUploadedLectureMeta(
      topic.topicContents[0]?.content,
    );
    if (existingMeta?.filePath) {
      try {
        await unlink(join(process.cwd(), existingMeta.filePath));
      } catch {
        // Ignore missing files on disk.
      }
    }

    const uploadDir = join(
      process.cwd(),
      'tmp',
      'lecture-uploads',
      String(tenantId),
    );
    await mkdir(uploadDir, { recursive: true });

    const safeName = file.originalname.replace(/[^\w.\-() ]+/g, '-');
    const storedFileName = `topic-${topicId}-${Date.now()}-${safeName}`;
    const relativePath = join('tmp', 'lecture-uploads', String(tenantId), storedFileName);
    const absolutePath = join(process.cwd(), relativePath);

    await writeFile(absolutePath, file.buffer);

    const extraction = await extractPdfDocument(file.buffer);
    if (!extraction.text || extraction.nonEmptyPageCount === 0) {
      try {
        await unlink(absolutePath);
      } catch {
        // Ignore cleanup errors.
      }
      throw new BadRequestException(
        extraction.warnings.length > 0
          ? `PDF text extraction failed: ${extraction.warnings.join(' ')}`
          : 'PDF does not contain readable text. Upload a text-based PDF or a clearer scan.',
      );
    }

    const content = buildLectureContentFromPdfExtraction({
      topicTitle: topic.title,
      fileName: file.originalname,
      filePath: relativePath,
      size: file.size,
      extraction,
    });

    this.logger.log(
      `Uploaded lecture extracted for topic ${topicId}: method=${extraction.method}, pages=${extraction.pageCount}, nonEmpty=${extraction.nonEmptyPageCount}, characters=${extraction.characterCount}`,
    );

    if (extraction.warnings.length > 0) {
      this.logger.warn(
        `Uploaded lecture extraction warnings for topic ${topicId}: ${extraction.warnings.join(' ')}`,
      );
    }

    return this.saveContent(
      topicId,
      topic.courseId,
      tenantId,
      'LECTURE',
      content,
    );
  }

  async getLectureFile(tenantId: number, topicId: number) {
    const topic = await this.prisma.topic.findFirst({
      where: { id: topicId, course: { tenantId } },
      include: {
        topicContents: {
          where: { type: 'LECTURE', status: 'COMPLETED' },
          take: 1,
        },
      },
    });

    if (!topic) {
      throw new NotFoundException('Topic not found');
    }

    const meta = this.parseUploadedLectureMeta(
      topic.topicContents[0]?.content,
    );

    if (!meta) {
      throw new NotFoundException('Uploaded lecture not found');
    }

    return {
      filePath: join(process.cwd(), meta.filePath),
      fileName: meta.fileName,
      mimeType: meta.mimeType,
    };
  }

  async deleteUploadedLecture(tenantId: number, topicId: number) {
    const topic = await this.prisma.topic.findFirst({
      where: { id: topicId, course: { tenantId } },
      include: {
        topicContents: {
          where: { type: 'LECTURE' },
          take: 1,
        },
      },
    });

    if (!topic) {
      throw new NotFoundException('Topic not found');
    }

    const meta = this.parseUploadedLectureMeta(
      topic.topicContents[0]?.content,
    );

    if (!meta) {
      throw new NotFoundException('Uploaded lecture not found');
    }

    try {
      await unlink(join(process.cwd(), meta.filePath));
    } catch {
      // Ignore missing files on disk.
    }

    await this.prisma.topicContent.delete({
      where: { topicId_type: { topicId, type: 'LECTURE' } },
    });

    return { success: true };
  }

  async saveContent(
    topicId: number,
    courseId: number,
    tenantId: number,
    type: ContentType,
    content: any,
  ) {
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
