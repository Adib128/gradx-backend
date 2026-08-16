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
import z from 'zod';
import { ReferenceSchema } from 'src/course/schemas/reference.schema';
import { ContentType } from 'generated/prisma/enums';
import { extractPdfDocument } from './utils/extract-pdf-text.util';
import { buildLectureContentFromPdfExtraction } from './utils/pdf-lecture-content.util';
import { ErrorMessageKey } from 'src/common/constants/error-message';
import { generationErrorPayload } from 'src/common/helpers/generation-error.helper';
import { detectContentLanguage } from './utils/content-language.util';
import { withDbRetry } from 'src/common/helpers/db-retry.helper';

/** Slide decks and lab manuals skip the draft/accept review cycle entirely. */
const ALWAYS_ACCEPTED_TYPES = new Set<ContentType>(['SLIDES', 'LAB']);

function isAlwaysAccepted(type: ContentType) {
  return ALWAYS_ACCEPTED_TYPES.has(type);
}

type CourseReference = z.infer<typeof ReferenceSchema>;

/**
 * Keep bibliographic refs; only keep `extractedText` for selected indices when opted in.
 */
function applyReferenceDocumentSelection(
  references: CourseReference[],
  useReferenceDocuments?: boolean,
  referenceDocumentIndices?: number[],
): CourseReference[] {
  const selectedIndices = new Set(
    (referenceDocumentIndices ?? []).filter(
      (index) => Number.isInteger(index) && index >= 0,
    ),
  );
  const includeBodies =
    Boolean(useReferenceDocuments) && selectedIndices.size > 0;

  return references.map((reference, index) => {
    if (includeBodies && selectedIndices.has(index)) {
      return reference;
    }

    return {
      ...reference,
      extractedText: null,
      characterCount: null,
      truncated: null,
      extractionMethod: null,
      extractedAt: null,
    };
  });
}

function resolveReviewStatus(
  type: ContentType,
  requested: 'DRAFT' | 'ACCEPTED',
): 'DRAFT' | 'ACCEPTED' {
  return isAlwaysAccepted(type) ? 'ACCEPTED' : requested;
}

type UploadedFileMeta = {
  source: 'upload';
  fileName: string;
  filePath: string;
  size: number;
  mimeType: string;
};

type UploadMaterialType = 'LECTURE' | 'SLIDES' | 'LAB';

const DOCUMENT_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const SLIDE_MIME = new Set([
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

function isDocumentFile(mimeType: string, originalName: string) {
  const name = originalName.toLowerCase();
  return (
    DOCUMENT_MIME.has(mimeType) ||
    name.endsWith('.pdf') ||
    name.endsWith('.doc') ||
    name.endsWith('.docx')
  );
}

function isSlideFile(mimeType: string, originalName: string) {
  const name = originalName.toLowerCase();
  return (
    SLIDE_MIME.has(mimeType) || name.endsWith('.ppt') || name.endsWith('.pptx')
  );
}

function isPdfFile(mimeType: string, originalName: string) {
  return (
    mimeType === 'application/pdf' ||
    originalName.toLowerCase().endsWith('.pdf')
  );
}

function folderForType(type: UploadMaterialType) {
  if (type === 'SLIDES') return 'slide-uploads';
  if (type === 'LAB') return 'lab-uploads';
  return 'lecture-uploads';
}

@Injectable()
export class TopicContentService {
  private readonly logger = new Logger(TopicContentService.name);
  private readonly cancelledGenerationJobs = new Set<string>();

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
    const contentGeneration = await this.buildGenerationJob(
      tenantId,
      topicId,
      generationContentDto,
    );

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

  async previewPrompt(
    tenantId: number,
    topicId: number,
    generationContentDto: GenerateContentDto,
  ) {
    const contentGeneration = await this.buildGenerationJob(
      tenantId,
      topicId,
      generationContentDto,
    );

    return this.topicContentAiService.previewPrompts(contentGeneration);
  }

  private async buildGenerationJob(
    tenantId: number,
    topicId: number,
    generationContentDto: GenerateContentDto,
  ): Promise<ContentGenerationJob> {
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
      throw new NotFoundException(ErrorMessageKey.TOPIC_NOT_FOUND);
    }

    const lectureContent = topic.topicContents[0];

    if (
      (generationContentDto.type === 'SLIDES' ||
        generationContentDto.type === 'LAB') &&
      !lectureContent?.content
    ) {
      throw new NotFoundException(
        ErrorMessageKey.TOPIC_CONTENT_LECTURE_REQUIRED,
      );
    }

    const cloDescriptions = topic.course.clos.map((clo) => clo.description);
    const requestedLanguage = generationContentDto.contentLanguage;
    const detectedLanguage: 'ar' | 'en' =
      requestedLanguage === 'ar' || requestedLanguage === 'en'
        ? requestedLanguage
        : detectContentLanguage(
            topic.title,
            topic.course.title,
            topic.course.description,
            ...cloDescriptions,
          );

    const courseReferences = z
      .array(ReferenceSchema)
      .parse(topic.course.references ?? []);
    const rawUseReferenceDocuments = (
      generationContentDto as {
        useReferenceDocuments?: boolean;
      }
    ).useReferenceDocuments;
    const rawReferenceDocumentIndices = (
      generationContentDto as {
        referenceDocumentIndices?: number[];
      }
    ).referenceDocumentIndices;
    const useReferenceDocuments = Boolean(rawUseReferenceDocuments);
    const referenceDocumentIndices = Array.isArray(rawReferenceDocumentIndices)
      ? rawReferenceDocumentIndices.filter(
          (index) => Number.isInteger(index) && index >= 0,
        )
      : [];
    const references = applyReferenceDocumentSelection(
      courseReferences,
      useReferenceDocuments,
      referenceDocumentIndices,
    );

    return {
      ...(generationContentDto as unknown as ContentGenerationJob),
      tenantId,
      topicId: topic.id,
      topicNumber: topic.topicNumber,
      contentId: topic.id,
      topicTitle: topic.title,
      courseId: topic.course.id,
      courseTitle: topic.course.title ?? '',
      courseDescription: topic.course.description ?? '',
      contentLanguage: detectedLanguage,
      slidesLength:
        typeof generationContentDto.slidesLength === 'string'
          ? generationContentDto.slidesLength
          : undefined,
      clos: topic.course.clos.map((clo) => ({
        code: clo.code,
        category: clo.category,
        programCLOCode: clo.programCLOCode,
        description: clo.description,
        teachingStrategies: clo.teachingStrategies,
        assessmentMethods: clo.assessmentMethods,
        courseId: clo.courseId,
      })),
      references,
      useReferenceDocuments,
      referenceDocumentIndices,
      sourceLectureContentId: lectureContent?.id,
      sourceLectureContent: lectureContent?.content,
    };
  }

  async getGenerateStatus(jobId: string) {
    const job = await this.contentQueue.getJob(jobId);

    if (!job)
      throw new NotFoundException(ErrorMessageKey.GENERATION_JOB_NOT_FOUND);

    const state = await job.getState();
    const cancelled =
      this.isGenerationCancelled(jobId) ||
      (state === 'failed' &&
        String(job.failedReason || '')
          .toUpperCase()
          .includes('CANCELLED'));

    const failure = generationErrorPayload(
      state === 'failed' ? job.failedReason : null,
      cancelled
        ? ErrorMessageKey.TOPIC_CONTENT_GENERATION_CANCELLED
        : ErrorMessageKey.TOPIC_CONTENT_GENERATE_FAILED,
    );

    return {
      jobId,
      status: cancelled && state === 'failed' ? 'cancelled' : state,
      progress: job.progress,
      result: state === 'completed' ? job.returnvalue : null,
      error: failure.error,
      errorKey: failure.errorKey,
      cancelled,
    };
  }

  isGenerationCancelled(jobId: string | number | undefined | null): boolean {
    if (jobId == null) return false;
    return this.cancelledGenerationJobs.has(String(jobId));
  }

  assertGenerationNotCancelled(jobId: string | number | undefined | null) {
    if (this.isGenerationCancelled(jobId)) {
      throw new BadRequestException(
        ErrorMessageKey.TOPIC_CONTENT_GENERATION_CANCELLED,
      );
    }
  }

  async cancelGenerate(jobId: string) {
    const job = await this.contentQueue.getJob(jobId);
    if (!job)
      throw new NotFoundException(ErrorMessageKey.GENERATION_JOB_NOT_FOUND);

    const state = await job.getState();
    if (state === 'completed') {
      return {
        jobId,
        status: state,
        cancelled: false,
        message: 'Generation already completed',
      };
    }

    this.cancelledGenerationJobs.add(String(jobId));

    try {
      const previous =
        job.progress && typeof job.progress === 'object'
          ? (job.progress as Record<string, unknown>)
          : {};
      await job.updateProgress({
        ...previous,
        cancelled: true,
        message: 'Cancelled by user',
      });
    } catch {
      /* progress update is best-effort while cancelling */
    }

    if (state === 'waiting' || state === 'delayed' || state === 'prioritized') {
      try {
        await job.remove();
      } catch {
        /* ignore */
      }
    } else if (state === 'active') {
      try {
        await job.moveToFailed(
          new Error(ErrorMessageKey.TOPIC_CONTENT_GENERATION_CANCELLED),
          '0',
          true,
        );
      } catch {
        /* worker will stop at next cancellation check */
      }
    } else if (state === 'failed') {
      /* already failed — treat as cancelled if we marked the set */
    }

    // Drop the cancel flag later so memory does not grow forever
    setTimeout(
      () => this.cancelledGenerationJobs.delete(String(jobId)),
      30 * 60 * 1000,
    );

    return {
      jobId,
      status: 'cancelled',
      cancelled: true,
    };
  }

  private parseUploadedFileMeta(content: unknown): UploadedFileMeta | null {
    if (!content || typeof content !== 'object') return null;
    const data = content as Record<string, unknown>;

    const readMeta = (
      meta: Record<string, unknown>,
    ): UploadedFileMeta | null => {
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
          typeof meta.mimeType === 'string'
            ? meta.mimeType
            : 'application/octet-stream',
      };
    };

    const direct = readMeta(data);
    if (direct) return direct;

    if (data.metadata && typeof data.metadata === 'object') {
      return readMeta(data.metadata as Record<string, unknown>);
    }

    return null;
  }

  /** @deprecated use parseUploadedFileMeta */
  private parseUploadedLectureMeta(content: unknown): UploadedFileMeta | null {
    return this.parseUploadedFileMeta(content);
  }

  async uploadLecture(
    tenantId: number,
    topicId: number,
    file: Express.Multer.File,
  ) {
    return this.uploadTopicMaterial(tenantId, topicId, 'LECTURE', file);
  }

  async uploadSlideImage(
    tenantId: number,
    topicId: number,
    file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Image file is required.');
    if (!file.mimetype?.toLowerCase().startsWith('image/')) {
      throw new BadRequestException('File must be an image.');
    }
    if (file.size > 3 * 1024 * 1024) {
      throw new BadRequestException('Image must be smaller than 3 MB.');
    }

    const topic = await this.prisma.topic.findFirst({
      where: { id: topicId, course: { tenantId } },
      select: { id: true },
    });
    if (!topic) throw new NotFoundException(ErrorMessageKey.TOPIC_NOT_FOUND);

    const extensionByMime: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/svg+xml': 'svg',
    };
    const extension = extensionByMime[file.mimetype.toLowerCase()];
    if (!extension) {
      throw new BadRequestException(
        'Image must be PNG, JPEG, WebP, GIF, or SVG.',
      );
    }

    const relativeDir = join('slide-images', String(tenantId), String(topicId));
    const uploadDir = join(process.cwd(), 'public', relativeDir);
    await mkdir(uploadDir, { recursive: true });
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${extension}`;
    await writeFile(join(uploadDir, fileName), file.buffer);

    return {
      url: `/${relativeDir.replaceAll('\\', '/')}/${fileName}`,
      fileName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
    };
  }

  async uploadTopicMaterial(
    tenantId: number,
    topicId: number,
    type: UploadMaterialType,
    file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException(`${type} file is required.`);
    }

    const mimeType = file.mimetype?.toLowerCase() ?? '';
    const originalName = file.originalname ?? 'upload';

    if (type === 'SLIDES') {
      if (!isSlideFile(mimeType, originalName)) {
        throw new BadRequestException(
          'Slides must be a PowerPoint file (.ppt or .pptx).',
        );
      }
    } else if (!isDocumentFile(mimeType, originalName)) {
      throw new BadRequestException(
        `${type === 'LAB' ? 'Lab manual' : 'Lecture'} must be a Word or PDF file (.doc, .docx, .pdf).`,
      );
    }

    const topic = await this.prisma.topic.findFirst({
      where: { id: topicId, course: { tenantId } },
      include: {
        topicContents: {
          where: { type },
          take: 1,
        },
      },
    });

    if (!topic) {
      throw new NotFoundException('Topic not found');
    }

    const existingMeta =
      this.parseUploadedFileMeta(topic.topicContents[0]?.content) ||
      (type === 'SLIDES'
        ? this.parseSkyworkSlidesMeta(topic.topicContents[0]?.content)
        : null);

    if (existingMeta?.filePath) {
      try {
        await unlink(join(process.cwd(), existingMeta.filePath));
      } catch {
        // Ignore missing files on disk.
      }
    }

    const folder = folderForType(type);
    const uploadDir = join(process.cwd(), 'tmp', folder, String(tenantId));
    await mkdir(uploadDir, { recursive: true });

    const safeName = originalName.replace(/[^\w.\-() ]+/g, '-');
    const storedFileName = `topic-${topicId}-${type.toLowerCase()}-${Date.now()}-${safeName}`;
    const relativePath = join('tmp', folder, String(tenantId), storedFileName);
    const absolutePath = join(process.cwd(), relativePath);

    await writeFile(absolutePath, file.buffer);

    // PDF lectures: extract text for downstream AI use. Word/PPT uploads are stored as files.
    if (type === 'LECTURE' && isPdfFile(mimeType, originalName)) {
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
        fileName: originalName,
        filePath: relativePath,
        size: file.size,
        extraction,
      });

      this.logger.log(
        `Uploaded lecture extracted for topic ${topicId}: method=${extraction.method}, pages=${extraction.pageCount}, characters=${extraction.characterCount}`,
      );

      return this.saveContent(
        topicId,
        topic.courseId,
        tenantId,
        'LECTURE',
        content,
      );
    }

    const content: UploadedFileMeta & {
      uploadedAt: string;
      materialType: UploadMaterialType;
    } = {
      source: 'upload',
      fileName: originalName,
      filePath: relativePath,
      size: file.size,
      mimeType: mimeType || 'application/octet-stream',
      uploadedAt: new Date().toISOString(),
      materialType: type,
    };

    return this.saveContent(topicId, topic.courseId, tenantId, type, content);
  }

  async getLectureFile(tenantId: number, topicId: number) {
    return this.getUploadedMaterialFile(tenantId, topicId, 'LECTURE');
  }

  async getLabFile(tenantId: number, topicId: number) {
    return this.getUploadedMaterialFile(tenantId, topicId, 'LAB');
  }

  private async getUploadedMaterialFile(
    tenantId: number,
    topicId: number,
    type: UploadMaterialType,
  ) {
    const topic = await this.prisma.topic.findFirst({
      where: { id: topicId, course: { tenantId } },
      include: {
        topicContents: {
          where: { type, status: 'COMPLETED' },
          take: 1,
        },
      },
    });

    if (!topic) {
      throw new NotFoundException('Topic not found');
    }

    let meta: { fileName: string; filePath: string; mimeType: string } | null =
      this.parseUploadedFileMeta(topic.topicContents[0]?.content);

    if (!meta && type === 'SLIDES') {
      meta = this.parseSkyworkSlidesMeta(topic.topicContents[0]?.content);
    }

    if (!meta) {
      throw new NotFoundException(
        `Uploaded ${type.toLowerCase()} file not found`,
      );
    }

    return {
      filePath: join(process.cwd(), meta.filePath),
      fileName: meta.fileName,
      mimeType: meta.mimeType,
    };
  }

  async deleteUploadedLecture(tenantId: number, topicId: number) {
    return this.deleteUploadedMaterial(tenantId, topicId, 'LECTURE');
  }

  async deleteUploadedMaterial(
    tenantId: number,
    topicId: number,
    type: UploadMaterialType,
  ) {
    const topic = await this.prisma.topic.findFirst({
      where: { id: topicId, course: { tenantId } },
      include: {
        topicContents: {
          where: { type },
          take: 1,
        },
      },
    });

    if (!topic) {
      throw new NotFoundException('Topic not found');
    }

    const meta =
      this.parseUploadedFileMeta(topic.topicContents[0]?.content) ||
      (type === 'SLIDES'
        ? this.parseSkyworkSlidesMeta(topic.topicContents[0]?.content)
        : null);

    if (!meta) {
      throw new NotFoundException(
        `Uploaded ${type.toLowerCase()} file not found`,
      );
    }

    try {
      await unlink(join(process.cwd(), meta.filePath));
    } catch {
      // Ignore missing files on disk.
    }

    await this.prisma.topicContent.delete({
      where: { topicId_type: { topicId, type } },
    });

    return { success: true };
  }

  private parseSkyworkSlidesMeta(content: unknown): {
    source: 'skywork';
    fileName: string;
    filePath: string;
    mimeType: string;
  } | null {
    if (!content || typeof content !== 'object') return null;
    const data = content as Record<string, unknown>;
    if (
      data.source !== 'skywork' ||
      typeof data.fileName !== 'string' ||
      typeof data.filePath !== 'string'
    ) {
      return null;
    }

    return {
      source: 'skywork',
      fileName: data.fileName,
      filePath: data.filePath,
      mimeType:
        typeof data.mimeType === 'string'
          ? data.mimeType
          : 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
  }

  async getSlidesMeta(tenantId: number, topicId: number) {
    const topic = await this.prisma.topic.findFirst({
      where: { id: topicId, course: { tenantId } },
      include: {
        topicContents: {
          where: { type: 'SLIDES' },
          take: 1,
        },
      },
    });

    if (!topic?.topicContents?.[0]) return null;
    return (
      this.parseSkyworkSlidesMeta(topic.topicContents[0].content) ||
      this.parseUploadedFileMeta(topic.topicContents[0].content)
    );
  }

  async getSlidesFile(tenantId: number, topicId: number) {
    return this.getUploadedMaterialFile(tenantId, topicId, 'SLIDES');
  }

  async savePartialContent(
    topicId: number,
    courseId: number,
    tenantId: number,
    type: ContentType,
    content: any,
  ) {
    const review = resolveReviewStatus(type, 'DRAFT');
    return await this.prisma.topicContent.upsert({
      where: { topicId_type: { topicId, type } },
      create: {
        topicId,
        courseId,
        tenantId,
        type,
        status: 'PROCESSING',
        reviewStatus: review,
        content,
      },
      update: {
        status: 'PROCESSING',
        reviewStatus: review,
        content,
      },
    });
  }

  async saveContent(
    topicId: number,
    courseId: number,
    tenantId: number,
    type: ContentType,
    content: any,
    reviewStatus: 'DRAFT' | 'ACCEPTED' = 'DRAFT',
  ) {
    const review = resolveReviewStatus(type, reviewStatus);
    return await withDbRetry(() =>
      this.prisma.topicContent.upsert({
        where: { topicId_type: { topicId, type } },
        create: {
          topicId,
          courseId,
          tenantId,
          type,
          status: 'COMPLETED',
          reviewStatus: review,
          content,
        },
        update: {
          status: 'COMPLETED',
          reviewStatus: review,
          content,
        },
      }),
    );
  }

  async acceptContent(
    tenantId: number,
    topicId: number,
    type: ContentType,
    content?: unknown,
  ) {
    // Single scoped write on the happy path; the tenant check rides along in
    // the filter so accepting never needs a second round trip.
    const updated = await withDbRetry(() =>
      this.prisma.topicContent.updateMany({
        where: { topicId, type, course: { tenantId } },
        data: {
          status: 'COMPLETED',
          reviewStatus: 'ACCEPTED',
          ...(content != null ? { content: content as any } : {}),
        },
      }),
    );

    if (updated.count > 0) {
      return { topicId, type, reviewStatus: 'ACCEPTED' as const };
    }

    const topic = await withDbRetry(() =>
      this.prisma.topic.findFirst({
        where: { id: topicId, course: { tenantId } },
        select: { id: true, courseId: true },
      }),
    );

    if (!topic) {
      throw new NotFoundException(ErrorMessageKey.TOPIC_NOT_FOUND);
    }
    if (content == null) {
      throw new BadRequestException('No content to accept');
    }

    await this.saveContent(
      topicId,
      topic.courseId,
      tenantId,
      type,
      content,
      'ACCEPTED',
    );
    return { topicId, type, reviewStatus: 'ACCEPTED' as const };
  }

  async markContentDraft(tenantId: number, topicId: number, type: ContentType) {
    if (isAlwaysAccepted(type)) {
      return { topicId, type, reviewStatus: 'ACCEPTED' as const };
    }

    const updated = await withDbRetry(() =>
      this.prisma.topicContent.updateMany({
        where: { topicId, type, course: { tenantId } },
        data: { reviewStatus: 'DRAFT' },
      }),
    );

    if (updated.count === 0) {
      throw new NotFoundException('Topic content not found');
    }

    return { topicId, type, reviewStatus: 'DRAFT' as const };
  }

  async updateSlidesDeck(
    tenantId: number,
    topicId: number,
    body: { content?: Record<string, unknown>; slides?: unknown[] },
  ) {
    const topic = await this.prisma.topic.findFirst({
      where: { id: topicId, course: { tenantId } },
      include: {
        topicContents: {
          where: { type: 'SLIDES' },
          orderBy: { updatedAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!topic) {
      throw new NotFoundException(ErrorMessageKey.TOPIC_NOT_FOUND);
    }

    const existingRow = topic.topicContents[0];
    const existing = existingRow?.content;
    const existingObj =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {};

    const incomingSlides = Array.isArray(body?.slides)
      ? body.slides
      : Array.isArray(body?.content?.slides)
        ? (body.content.slides as unknown[])
        : null;

    if (!incomingSlides) {
      throw new BadRequestException('slides array is required');
    }

    const normalizedSlides = incomingSlides.map((slide, index) => {
      const item =
        slide && typeof slide === 'object'
          ? (slide as Record<string, unknown>)
          : {};
      return {
        ...item,
        slideNumber: index + 1,
      };
    });

    const contentPayload = {
      ...existingObj,
      ...(body.content && typeof body.content === 'object' ? body.content : {}),
      source: existingObj.source || 'gradx',
      provider: existingObj.provider || 'openrouter',
      slides: normalizedSlides,
      totalSlides: normalizedSlides.length,
      editedAt: new Date().toISOString(),
    };

    return this.saveContent(
      topicId,
      topic.courseId,
      tenantId,
      'SLIDES',
      contentPayload,
      'ACCEPTED',
    );
  }

  async updateLabManual(
    tenantId: number,
    topicId: number,
    body: { content?: Record<string, unknown> },
  ) {
    const topic = await this.prisma.topic.findFirst({
      where: { id: topicId, course: { tenantId } },
      include: {
        topicContents: {
          where: { type: 'LAB' },
          orderBy: { updatedAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!topic) {
      throw new NotFoundException(ErrorMessageKey.TOPIC_NOT_FOUND);
    }

    const existingRow = topic.topicContents[0];
    const existing = existingRow?.content;
    const existingObj =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {};

    const incoming =
      body?.content && typeof body.content === 'object' ? body.content : body;

    if (!incoming || typeof incoming !== 'object') {
      throw new BadRequestException('lab content is required');
    }

    const contentPayload = {
      ...existingObj,
      ...incoming,
      source: existingObj.source || 'gradx',
      provider: existingObj.provider || 'openrouter',
      editedAt: new Date().toISOString(),
    };

    return this.saveContent(
      topicId,
      topic.courseId,
      tenantId,
      'LAB',
      contentPayload,
      'ACCEPTED',
    );
  }
}
