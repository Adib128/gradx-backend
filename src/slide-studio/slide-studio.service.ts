import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Command, INTERRUPT } from '@langchain/langgraph';
import type { Response } from 'express';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { PrismaService } from 'prisma/prisma.service';
import { referenceChapterList } from 'src/assessment/utils/assessment-source.util';
import { ErrorMessageKey } from 'src/common/constants/error-message';
import { withDbRetry } from 'src/common/helpers/db-retry.helper';
import { normalizeGenerationErrorKey } from 'src/common/helpers/generation-error.helper';
import { runWithAiContext } from 'src/common/helpers/openrouter-chat.helper';
import { filterFiguresForChapters } from 'src/course/utils/extract-reference-figures.util';
import { resolveTenantReferenceFilePath } from 'src/course/utils/reference-document-storage.util';
import { ReferenceVectorService } from 'src/reference-vector/reference-vector.service';
import { detectContentLanguage } from 'src/topic-content/utils/content-language.util';
import { RedisCheckpointSaver } from './checkpoint/redis-checkpoint-saver';
import type { ResumeSlideStudioDto, StartSlideStudioDto } from './dto/slide-studio.dto';
import { buildStudioGraph, type StudioGraph, type StudioStateType } from './slide-studio.graph';
import { SlideStudioLlm } from './slide-studio.llm';
import { customTemplateDbId } from './slide-studio.templates';
import { SlideTemplatesService } from './slide-templates.service';
import { AiUsageService } from 'src/ai-usage/ai-usage.service';
import type {
  StudioChapterSelection,
  StudioContext,
  StudioEvent,
  StudioExcerpt,
  StudioFigure,
  StudioInput,
  StudioInterrupt,
  StudioPlanSection,
  StudioResume,
} from './slide-studio.types';
import { summarizeContext } from './slide-studio.types';

const PREFIX = 'slide-studio';
const SESSION_TTL_SECONDS = 3 * 24 * 60 * 60;
const LOCK_TTL_SECONDS = 30 * 60;
const HEARTBEAT_MS = 15_000;
const MAX_FIGURES = 40;
const CONTEXT_EXCERPTS = 24;
const SECTION_EXCERPTS = 8;
const FULLTEXT_CHAPTER_CHARS = 14_000;
const FULLTEXT_TOTAL_CHARS = 60_000;

type SessionMeta = {
  tenantId: number;
  userId: number | null;
  topicId: number;
  courseId: number;
  createdAt: string;
};

type RawReference = {
  title?: unknown;
  chapters?: Array<{
    name?: unknown;
    content?: unknown;
    startPage?: number | null;
    endPage?: number | null;
  }> | null;
  figures?: Array<{
    id: string;
    caption: string;
    pageNumber: number;
    filePath: string;
    mimeType: string;
  }> | null;
};

const referenceTitle = (reference: RawReference | undefined, index: number) =>
  (typeof reference?.title === 'string' && reference.title.trim()) ||
  `Reference ${index + 1}`;

@Injectable()
export class SlideStudioService implements OnModuleDestroy {
  private readonly logger = new Logger(SlideStudioService.name);
  private readonly redis: Redis;
  private readonly checkpointer: RedisCheckpointSaver;
  private readonly graph: StudioGraph;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly referenceVector: ReferenceVectorService,
    private readonly llm: SlideStudioLlm,
    private readonly slideTemplates: SlideTemplatesService,
    private readonly aiUsage: AiUsageService,
  ) {
    this.redis = new Redis({
      host: config.get<string>('REDIS_HOST') ?? 'localhost',
      port: Number(config.get<number>('REDIS_PORT') ?? 6379),
      maxRetriesPerRequest: 2,
    });
    this.checkpointer = new RedisCheckpointSaver(this.redis, {
      prefix: `${PREFIX}:lg`,
      ttlSeconds: SESSION_TTL_SECONDS,
      keepCheckpoints: 4,
    });
    this.graph = buildStudioGraph(
      {
        llm: this.llm,
        loadContext: (input) => this.loadContext(input),
        sectionExcerpts: (input, context, section) =>
          this.sectionExcerpts(input, context, section),
        publishFigure: (input, figure) => this.publishFigure(input, figure),
        saveDeck: (input, deck) => this.saveDeck(input, deck),
      },
      this.checkpointer,
    );
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }

  // ---------------------------------------------------------------- sessions

  private sessionKey(sessionId: string) {
    return `${PREFIX}:session:${sessionId}`;
  }

  private topicKey(tenantId: number, topicId: number) {
    return `${PREFIX}:topic:${tenantId}:${topicId}`;
  }

  private lockKey(sessionId: string) {
    return `${PREFIX}:lock:${sessionId}`;
  }

  private async requireSession(tenantId: number, sessionId: string): Promise<SessionMeta> {
    const raw = await this.redis.get(this.sessionKey(sessionId));
    const meta = raw ? (JSON.parse(raw) as SessionMeta) : null;
    if (!meta || meta.tenantId !== tenantId) {
      throw new NotFoundException(ErrorMessageKey.SLIDE_STUDIO_SESSION_NOT_FOUND);
    }
    return meta;
  }

  private config(sessionId: string) {
    return { configurable: { thread_id: sessionId } };
  }

  private async pendingInterrupt(sessionId: string): Promise<StudioInterrupt | null> {
    const snapshot = await this.graph.getState(this.config(sessionId));
    const pending = snapshot.tasks.flatMap((task) => task.interrupts ?? []);
    return (pending[0]?.value as StudioInterrupt | undefined) ?? null;
  }

  async getSession(tenantId: number, sessionId: string) {
    const meta = await this.requireSession(tenantId, sessionId);
    const snapshot = await this.graph.getState(this.config(sessionId));
    const values = (snapshot.values ?? {}) as Partial<StudioStateType>;
    const pending =
      (snapshot.tasks.flatMap((task) => task.interrupts ?? [])[0]?.value as
        | StudioInterrupt
        | undefined) ?? null;
    const running = (await this.redis.exists(this.lockKey(sessionId))) === 1;
    const status = running
      ? 'running'
      : pending
        ? 'waiting'
        : values.deck
          ? 'completed'
          : snapshot.next.length
            ? 'stopped'
            : 'empty';
    const context = values.context;
    return {
      sessionId,
      topicId: meta.topicId,
      createdAt: meta.createdAt,
      status,
      next: snapshot.next,
      pending,
      params: values.input
        ? {
            slideCount: values.input.slideCount,
            selections: values.input.selections,
            language: values.input.language,
          }
        : null,
      context: context ? summarizeContext(context) : null,
      analysis: values.analysis ?? null,
      plan: values.plan ?? null,
      templateSuggestion: values.templateSuggestion ?? null,
      templateId: values.templateId ?? null,
      outline: values.outline ?? null,
      slides: values.slides ?? null,
      qa: values.qa ?? null,
      review: values.review ?? null,
      deck: values.deck ?? null,
      models: this.llm.models,
    };
  }

  async getTopicSession(tenantId: number, topicId: number) {
    const sessionId = await this.redis.get(this.topicKey(tenantId, topicId));
    if (!sessionId) return null;
    try {
      return await this.getSession(tenantId, sessionId);
    } catch {
      return null;
    }
  }

  async discardSession(tenantId: number, sessionId: string) {
    const meta = await this.requireSession(tenantId, sessionId);
    if ((await this.redis.exists(this.lockKey(sessionId))) === 1) {
      throw new ConflictException(ErrorMessageKey.SLIDE_STUDIO_BUSY);
    }
    await this.checkpointer.deleteThread(sessionId);
    const topicKey = this.topicKey(meta.tenantId, meta.topicId);
    if ((await this.redis.get(topicKey)) === sessionId) await this.redis.del(topicKey);
    await this.redis.del(this.sessionKey(sessionId));
    return { sessionId, discarded: true };
  }

  async startSession(
    tenantId: number,
    userId: number | undefined,
    topicId: number,
    dto: StartSlideStudioDto,
    res: Response,
  ) {
    const topic = await this.prisma.topic.findFirst({
      where: { id: topicId, course: { tenantId } },
      include: {
        course: { include: { clos: true } },
        topicClos: { select: { cloId: true } },
      },
    });
    if (!topic) throw new NotFoundException(ErrorMessageKey.TOPIC_NOT_FOUND);

    const course = topic.course;
    const linkedIds = new Set(topic.topicClos.map((link) => link.cloId));
    const references = Array.isArray(course.references)
      ? (course.references as RawReference[])
      : [];
    const selections: StudioChapterSelection[] = [];
    for (const selection of dto.selections ?? []) {
      const reference = references[selection.referenceIndex];
      if (!reference) continue;
      const chapterCount = referenceChapterList(reference).length;
      if (!chapterCount) continue;
      const valid = [...new Set(selection.chapterIndices)].filter(
        (index) => index < chapterCount,
      );
      selections.push({
        referenceIndex: selection.referenceIndex,
        chapterIndices: valid.length
          ? valid
          : Array.from({ length: chapterCount }, (_, index) => index),
      });
    }

    const sessionId = randomUUID();
    const input: StudioInput = {
      sessionId,
      tenantId,
      userId: userId ?? null,
      courseId: course.id,
      topicId: topic.id,
      courseTitle: course.title,
      courseCode: course.code ?? null,
      courseDescription: course.description ?? null,
      courseLevel: course.level ?? null,
      department: course.department ?? null,
      topicTitle: topic.title,
      topicNumber: topic.topicNumber,
      clos: course.clos.map((clo) => ({
        code: clo.code,
        category: clo.category ?? null,
        description: clo.description,
        linked: linkedIds.has(clo.id),
      })),
      slideCount: dto.slideCount,
      selections,
      language: detectContentLanguage(
        topic.title,
        course.title,
        course.description,
        ...course.clos.map((clo) => clo.description),
      ),
      customTemplates: await this.slideTemplates.customTemplates(tenantId),
    };

    const meta: SessionMeta = {
      tenantId,
      userId: userId ?? null,
      topicId: topic.id,
      courseId: course.id,
      createdAt: new Date().toISOString(),
    };
    await this.redis
      .multi()
      .set(this.sessionKey(sessionId), JSON.stringify(meta), 'EX', SESSION_TTL_SECONDS)
      .set(this.topicKey(tenantId, topic.id), sessionId, 'EX', SESSION_TTL_SECONDS)
      .exec();

    await this.runStream(sessionId, meta, {
      input,
      context: null,
      analysis: null,
      plan: null,
      planRevision: 0,
      planFeedback: null,
      templateSuggestion: null,
      templateId: null,
      outline: null,
      outlineRevision: 0,
      outlineFeedback: null,
      slides: null,
      qa: null,
      review: null,
      deck: null,
    }, res);
  }

  async resumeSession(
    tenantId: number,
    sessionId: string,
    dto: ResumeSlideStudioDto,
    res: Response,
  ) {
    const meta = await this.requireSession(tenantId, sessionId);
    const pending = await this.pendingInterrupt(sessionId);
    if (!pending || pending.kind !== dto.kind) {
      throw new ConflictException(ErrorMessageKey.SLIDE_STUDIO_NOT_WAITING);
    }
    let resume = dto as StudioResume;
    if (resume.kind === 'template_review' && customTemplateDbId(resume.templateId)) {
      const customTemplate = await this.slideTemplates.findCustom(tenantId, resume.templateId);
      if (!customTemplate) throw new NotFoundException('Template not found.');
      resume = { ...resume, customTemplate };
    }
    await this.runStream(sessionId, meta, new Command({ resume }), res);
  }

  /** Re-run from the last checkpoint after a crash/disconnect mid-step. */
  async continueSession(tenantId: number, sessionId: string, res: Response) {
    const meta = await this.requireSession(tenantId, sessionId);
    const snapshot = await this.graph.getState(this.config(sessionId));
    const pending = snapshot.tasks.some((task) => task.interrupts?.length);
    if (pending || !snapshot.next.length) {
      throw new ConflictException(ErrorMessageKey.SLIDE_STUDIO_NOT_WAITING);
    }
    await this.runStream(sessionId, meta, null, res);
  }

  private async runStream(
    sessionId: string,
    meta: SessionMeta,
    payload: Partial<StudioStateType> | Command | null,
    res: Response,
  ) {
    await this.aiUsage.assertWithinLimit(meta.userId);
    const locked = await this.redis.set(
      this.lockKey(sessionId),
      '1',
      'EX',
      LOCK_TTL_SECONDS,
      'NX',
    );
    if (!locked) throw new ConflictException(ErrorMessageKey.SLIDE_STUDIO_BUSY);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const abort = new AbortController();
    let finished = false;
    const onClose = () => {
      if (!finished) abort.abort();
    };
    res.on('close', onClose);
    const send = (event: string, data: unknown) => {
      if (res.writableEnded || abort.signal.aborted) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, HEARTBEAT_MS);

    send('session', { sessionId });
    try {
      await runWithAiContext(
        { userId: meta.userId, tenantId: meta.tenantId, purpose: 'slide_studio' },
        async () => {
          const stream = await this.graph.stream(payload as never, {
            ...this.config(sessionId),
            streamMode: ['custom', 'updates'],
            signal: abort.signal,
            recursionLimit: 80,
          });
          for await (const chunk of stream as AsyncIterable<[string, unknown]>) {
            const [mode, data] = chunk;
            if (mode === 'custom') {
              const event = data as StudioEvent;
              send(event.event, event.data);
            } else if (
              mode === 'updates' &&
              data &&
              typeof data === 'object' &&
              INTERRUPT in data
            ) {
              const interrupts = (data as Record<string, Array<{ value: unknown }>>)[
                INTERRUPT
              ];
              if (interrupts?.[0]) send('interrupt', interrupts[0].value);
            }
          }
        },
      );
      const snapshot = await this.graph.getState(this.config(sessionId));
      send('end', {
        status: snapshot.next.length ? 'waiting' : 'completed',
        next: snapshot.next,
      });
    } catch (error) {
      if (abort.signal.aborted) {
        this.logger.log(`Slide studio ${sessionId} stopped by client`);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Slide studio ${sessionId} failed: ${message}`);
        const errorKey = normalizeGenerationErrorKey(
          (error as { response?: { message?: unknown } })?.response?.message ?? message,
          ErrorMessageKey.SLIDE_STUDIO_FAILED,
        );
        const balance =
          errorKey === ErrorMessageKey.GENERATION_AI_CREDITS_EXCEEDED ||
          errorKey === ErrorMessageKey.GENERATION_AI_KEY_LIMIT_EXCEEDED
            ? await this.llm.balance().catch(() => null)
            : null;
        send('error', { errorKey, message: errorKey, ...(balance ? { balance } : {}) });
      }
    } finally {
      finished = true;
      clearInterval(heartbeat);
      res.off('close', onClose);
      await this.redis.del(this.lockKey(sessionId)).catch(() => undefined);
      if (!res.writableEnded) res.end();
    }
  }

  // ----------------------------------------------------------- graph deps

  private async loadReferences(input: StudioInput): Promise<RawReference[]> {
    const course = await this.prisma.course.findFirst({
      where: { id: input.courseId, tenantId: input.tenantId },
      select: { references: true },
    });
    return Array.isArray(course?.references)
      ? (course.references as RawReference[])
      : [];
  }

  private async loadContext(input: StudioInput): Promise<StudioContext> {
    const references = await this.loadReferences(input);
    const chapters: StudioContext['chapters'] = [];
    const figures: StudioFigure[] = [];
    const chapterTexts = new Map<string, string>();

    for (const selection of input.selections) {
      const reference = references[selection.referenceIndex];
      if (!reference) continue;
      const title = referenceTitle(reference, selection.referenceIndex);
      const list = referenceChapterList(reference);
      const rawChapters = Array.isArray(reference.chapters) ? reference.chapters : [];
      for (const chapterIndex of selection.chapterIndices) {
        const chapter = list[chapterIndex];
        if (!chapter) continue;
        chapters.push({
          referenceIndex: selection.referenceIndex,
          referenceTitle: title,
          chapterIndex,
          chapterName: chapter.name,
        });
        chapterTexts.set(`${selection.referenceIndex}:${chapterIndex}`, chapter.content);
      }
      const picked = selection.chapterIndices
        .map((index) => rawChapters[index])
        .filter(Boolean) as Array<{ content?: string | null; startPage?: number | null; endPage?: number | null }>;
      const referenceFigures = rawChapters.length
        ? filterFiguresForChapters(reference.figures ?? [], picked)
        : (reference.figures ?? []);
      for (const figure of referenceFigures) {
        if (!figure?.filePath || !figure.caption) continue;
        figures.push({
          key: `r${selection.referenceIndex}-${figure.id}`,
          referenceIndex: selection.referenceIndex,
          referenceTitle: title,
          caption: figure.caption,
          pageNumber: figure.pageNumber,
          filePath: figure.filePath,
          mimeType: figure.mimeType || 'image/jpeg',
        });
      }
    }

    const context: StudioContext = {
      mode: 'none',
      excerpts: [],
      figures: figures.slice(0, MAX_FIGURES),
      chapters,
    };
    if (!chapters.length) return context;

    const linked = input.clos.filter((clo) => clo.linked);
    const query = [
      input.topicTitle,
      ...(linked.length ? linked : input.clos).map((clo) => clo.description),
    ]
      .filter(Boolean)
      .join('\n');
    try {
      const result = await this.referenceVector.searchReferenceChunks({
        tenantId: input.tenantId,
        courseId: input.courseId,
        query,
        selections: input.selections,
        limit: CONTEXT_EXCERPTS,
      });
      if (result.ready && result.chunks.length) {
        return {
          ...context,
          mode: 'vector',
          excerpts: result.chunks.map((chunk) => ({
            referenceIndex: chunk.referenceIndex,
            referenceTitle: chunk.referenceTitle || referenceTitle(references[chunk.referenceIndex], chunk.referenceIndex),
            chapterIndex: chunk.chapterIndex,
            chapterName: chunk.chapterName || `Chapter ${chunk.chapterIndex + 1}`,
            content: chunk.content,
            similarity: chunk.similarity,
          })),
        };
      }
      if (!result.ready) {
        await this.referenceVector.enqueueCourseSync(input.courseId, {
          tenantId: input.tenantId,
        });
      }
    } catch (error) {
      this.logger.warn(
        `Vector retrieval failed, using chapter text: ${error instanceof Error ? error.message : error}`,
      );
    }

    let budget = FULLTEXT_TOTAL_CHARS;
    const excerpts: StudioExcerpt[] = [];
    for (const chapter of chapters) {
      if (budget <= 0) break;
      const content = (
        chapterTexts.get(`${chapter.referenceIndex}:${chapter.chapterIndex}`) ?? ''
      ).slice(0, Math.min(FULLTEXT_CHAPTER_CHARS, budget));
      if (!content.trim()) continue;
      budget -= content.length;
      excerpts.push({ ...chapter, content, similarity: null });
    }
    return { ...context, mode: excerpts.length ? 'fulltext' : 'none', excerpts };
  }

  private async sectionExcerpts(
    input: StudioInput,
    context: StudioContext,
    section: StudioPlanSection,
  ): Promise<StudioExcerpt[]> {
    const query = [section.title, section.goal, ...section.keyPoints].join('\n');
    if (context.mode === 'vector') {
      try {
        const result = await this.referenceVector.searchReferenceChunks({
          tenantId: input.tenantId,
          courseId: input.courseId,
          query,
          selections: input.selections,
          limit: SECTION_EXCERPTS,
        });
        if (result.ready && result.chunks.length) {
          return result.chunks.map((chunk) => ({
            referenceIndex: chunk.referenceIndex,
            referenceTitle: chunk.referenceTitle || 'Reference',
            chapterIndex: chunk.chapterIndex,
            chapterName: chunk.chapterName || `Chapter ${chunk.chapterIndex + 1}`,
            content: chunk.content,
            similarity: chunk.similarity,
          }));
        }
      } catch (error) {
        this.logger.warn(
          `Section retrieval failed: ${error instanceof Error ? error.message : error}`,
        );
      }
      return context.excerpts.slice(0, SECTION_EXCERPTS);
    }
    // Full-text fallback: favour chapters that mention the section's terms.
    const terms = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((term) => term.length > 3);
    const score = (excerpt: StudioExcerpt) => {
      const haystack = excerpt.content.toLowerCase();
      return terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
    };
    return [...context.excerpts].sort((a, b) => score(b) - score(a));
  }

  private async publishFigure(input: StudioInput, figure: StudioFigure) {
    try {
      const { absolutePath } = await resolveTenantReferenceFilePath(
        input.tenantId,
        figure.filePath,
      );
      const relativeDir = join('slide-images', String(input.tenantId), String(input.topicId));
      await mkdir(join(process.cwd(), 'public', relativeDir), { recursive: true });
      const extension = extname(absolutePath) || '.jpg';
      const fileName = `studio-${input.sessionId.slice(0, 8)}-${figure.key.replace(/[^a-z0-9-]/gi, '_')}${extension}`;
      await copyFile(absolutePath, join(process.cwd(), 'public', relativeDir, fileName));
      return `/${relativeDir.replaceAll('\\', '/')}/${fileName}`;
    } catch (error) {
      this.logger.warn(
        `Could not publish figure ${figure.key}: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  private async saveDeck(input: StudioInput, deck: Record<string, unknown>) {
    await withDbRetry(() =>
      this.prisma.topicContent.upsert({
        where: { topicId_type: { topicId: input.topicId, type: 'SLIDES' } },
        create: {
          topicId: input.topicId,
          courseId: input.courseId,
          tenantId: input.tenantId,
          type: 'SLIDES',
          status: 'COMPLETED',
          reviewStatus: 'ACCEPTED',
          content: deck as never,
        },
        update: {
          status: 'COMPLETED',
          reviewStatus: 'ACCEPTED',
          content: deck as never,
        },
      }),
    );
  }
}
