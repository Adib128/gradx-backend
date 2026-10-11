import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import OpenAI from 'openai';
import { Prisma } from 'generated/prisma/client';
import { PrismaService } from 'prisma/prisma.service';
import { ErrorMessageKey } from 'src/common/constants/error-message';
import {
  createEmbeddings,
  DEFAULT_EMBEDDING_MODEL,
  toVectorLiteral,
} from 'src/common/helpers/openrouter-embedding.helper';
import type { ReferenceChapterSelection } from 'src/assessment/dto/generate-assessment.dto';
import {
  buildReferenceEntries,
  chunkReferenceEntry,
  type ReferenceIndexEntry,
} from './utils/reference-chunking.util';

export const REFERENCE_EMBEDDING_QUEUE = 'reference-embedding';

export type ReferenceEmbeddingJob = {
  courseId: number;
  tenantId?: number | null;
  userId?: number | null;
};

export type ReferenceIndexState =
  | 'NO_CONTENT'
  | 'NOT_INDEXED'
  | 'STALE'
  | 'PENDING'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED';

export type RetrievedReferenceChunk = {
  referenceIndex: number;
  referenceTitle: string | null;
  chapterIndex: number;
  chapterName: string | null;
  chunkIndex: number;
  content: string;
  similarity: number;
};

/** Rows per INSERT; each 1536-d vector literal is ~30KB of SQL text. */
const INSERT_BATCH_SIZE = 50;
const SYNC_DEBOUNCE_MS = 3000;

@Injectable()
export class ReferenceVectorService {
  private readonly logger = new Logger(ReferenceVectorService.name);
  private readonly client: OpenAI;
  readonly embeddingModel: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
    @InjectQueue(REFERENCE_EMBEDDING_QUEUE)
    private readonly queue: Queue<ReferenceEmbeddingJob>,
  ) {
    this.client = new OpenAI({
      apiKey: config.get<string>('OPENROUTER_API_KEY'),
      baseURL: config.get<string>('OPENROUTER_BASE_URL'),
      // SDK default is 10 min per request; a stalled batch would freeze the job.
      timeout: 60_000,
      maxRetries: 3,
    });
    this.embeddingModel =
      config.get<string>('EMBEDDING_MODEL')?.trim() || DEFAULT_EMBEDDING_MODEL;
  }

  /**
   * Queue a (debounced) re-sync of a course's reference vectors. Never throws:
   * saving a course must not fail because Redis or the indexer is unavailable.
   */
  async enqueueCourseSync(
    courseId: number,
    context: Omit<ReferenceEmbeddingJob, 'courseId'> = {},
  ): Promise<void> {
    try {
      await this.queue.add(
        'sync-course',
        { courseId, ...context },
        {
          delay: SYNC_DEBOUNCE_MS,
          deduplication: {
            id: `course-${courseId}`,
            ttl: SYNC_DEBOUNCE_MS,
            extend: true,
            replace: true,
          },
          attempts: 3,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: 200,
          removeOnFail: 500,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Could not queue reference embedding for course ${courseId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Bring `reference_documents`/`reference_chunks` in line with
   * `Course.references`: unchanged documents are skipped, changed ones are
   * re-embedded and removed ones deleted.
   */
  async syncCourse(courseId: number) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true, tenantId: true, references: true, deletedAt: true },
    });
    if (!course || course.deletedAt) {
      await this.prisma.referenceDocument.deleteMany({ where: { courseId } });
      return { indexed: 0, skipped: 0, removed: 0, failed: 0 };
    }

    const entries = buildReferenceEntries(course.references, this.embeddingModel);
    const removed = await this.prisma.referenceDocument.deleteMany({
      where: {
        courseId,
        documentKey: { notIn: entries.map((entry) => entry.documentKey) },
      },
    });
    const existing = await this.prisma.referenceDocument.findMany({
      where: { courseId },
    });

    let indexed = 0;
    let skipped = 0;
    const failures: string[] = [];

    for (const entry of entries) {
      const doc = existing.find((item) => item.documentKey === entry.documentKey);
      if (doc && doc.contentHash === entry.contentHash && doc.status === 'COMPLETED') {
        if (
          doc.referenceIndex !== entry.referenceIndex ||
          doc.title !== entry.title ||
          doc.fileName !== entry.fileName
        ) {
          await this.prisma.referenceDocument.update({
            where: { id: doc.id },
            data: {
              referenceIndex: entry.referenceIndex,
              title: entry.title,
              fileName: entry.fileName,
            },
          });
        }
        skipped++;
        continue;
      }

      try {
        await this.indexDocument(course.id, course.tenantId, entry);
        indexed++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${entry.documentKey}: ${message}`);
        this.logger.error(
          `Embedding reference ${entry.documentKey} of course ${courseId} failed: ${message}`,
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(`REFERENCE_EMBEDDING_FAILED: ${failures.join(' | ')}`);
    }
    return { indexed, skipped, removed: removed.count, failed: 0 };
  }

  private async indexDocument(
    courseId: number,
    tenantId: number,
    entry: ReferenceIndexEntry,
  ) {
    const meta = {
      referenceIndex: entry.referenceIndex,
      title: entry.title,
      fileName: entry.fileName,
      filePath: entry.filePath,
      contentHash: entry.contentHash,
      embeddingModel: this.embeddingModel,
      status: 'PROCESSING' as const,
      error: null,
    };
    const doc = await this.prisma.referenceDocument.upsert({
      where: { courseId_documentKey: { courseId, documentKey: entry.documentKey } },
      create: { courseId, tenantId, documentKey: entry.documentKey, ...meta },
      update: meta,
    });

    try {
      const chunks = chunkReferenceEntry(entry);
      const vectors = await createEmbeddings(
        this.client,
        this.embeddingModel,
        chunks.map((chunk) => chunk.embedText),
        { tenantId, purpose: 'reference_embedding' },
      );

      await this.prisma.$transaction(
        async (tx) => {
          await tx.referenceChunk.deleteMany({ where: { documentId: doc.id } });
          for (let offset = 0; offset < chunks.length; offset += INSERT_BATCH_SIZE) {
            const rows = chunks
              .slice(offset, offset + INSERT_BATCH_SIZE)
              .map(
                (chunk, i) => Prisma.sql`(
                  ${doc.id}, ${courseId}, ${tenantId}, ${chunk.chapterIndex},
                  ${chunk.chapterName}, ${chunk.chunkIndex}, ${chunk.content},
                  ${chunk.tokenCount}, ${toVectorLiteral(vectors[offset + i])}::vector
                )`,
              );
            await tx.$executeRaw`
              INSERT INTO "reference_chunks"
                ("documentId", "courseId", "tenantId", "chapterIndex", "chapterName",
                 "chunkIndex", "content", "tokenCount", "embedding")
              VALUES ${Prisma.join(rows)}`;
          }
          await tx.referenceDocument.update({
            where: { id: doc.id },
            data: {
              status: 'COMPLETED',
              chunkCount: chunks.length,
              indexedAt: new Date(),
              error: null,
            },
          });
        },
        { timeout: 120_000 },
      );
    } catch (error) {
      await this.prisma.referenceDocument.update({
        where: { id: doc.id },
        data: {
          status: 'FAILED',
          error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
        },
      });
      throw error;
    }
  }

  /** Per-reference index state, aligned with `Course.references` order. */
  async getCourseStatus(tenantId: number, courseId: number) {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, tenantId, deletedAt: null },
      select: { references: true },
    });
    if (!course) throw new NotFoundException(ErrorMessageKey.COURSE_NOT_FOUND);

    const entries = buildReferenceEntries(course.references, this.embeddingModel);
    const docs = await this.prisma.referenceDocument.findMany({
      where: { courseId },
      select: {
        documentKey: true,
        contentHash: true,
        status: true,
        chunkCount: true,
        indexedAt: true,
        error: true,
      },
    });
    const references = Array.isArray(course.references) ? course.references : [];
    const syncQueued = await this.hasQueuedSync(courseId);

    return {
      embeddingModel: this.embeddingModel,
      references: references.map((_, referenceIndex) => {
        const entry = entries.find((item) => item.referenceIndex === referenceIndex);
        if (!entry) {
          return { referenceIndex, state: 'NO_CONTENT' as ReferenceIndexState, chunkCount: 0, indexedAt: null, error: null };
        }
        const doc = docs.find((item) => item.documentKey === entry.documentKey);
        let state: ReferenceIndexState = 'NOT_INDEXED';
        if (doc) {
          state =
            doc.contentHash !== entry.contentHash && doc.status === 'COMPLETED'
              ? 'STALE'
              : doc.status;
        }
        if (syncQueued && (state === 'NOT_INDEXED' || state === 'STALE' || state === 'FAILED')) {
          state = 'PENDING';
        }
        return {
          referenceIndex,
          state,
          chunkCount: doc?.chunkCount ?? 0,
          indexedAt: doc?.indexedAt ?? null,
          error: state === 'FAILED' ? (doc?.error ?? null) : null,
        };
      }),
    };
  }

  private async hasQueuedSync(courseId: number): Promise<boolean> {
    try {
      const jobs = await this.queue.getJobs(['waiting', 'delayed', 'active'], 0, 500);
      return jobs.some((job) => job?.data?.courseId === courseId);
    } catch {
      return false;
    }
  }

  /** Re-sync now; `force` re-embeds documents even when their content is unchanged. */
  async reindexCourse(
    tenantId: number,
    courseId: number,
    options: { force?: boolean; userId?: number | null } = {},
  ) {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!course) throw new NotFoundException(ErrorMessageKey.COURSE_NOT_FOUND);

    if (options.force) {
      await this.prisma.referenceDocument.updateMany({
        where: { courseId },
        data: { status: 'PENDING' },
      });
    }
    await this.enqueueCourseSync(courseId, { tenantId, userId: options.userId });
    return this.getCourseStatus(tenantId, courseId);
  }

  private async assertCourse(tenantId: number, courseId: number) {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!course) throw new NotFoundException(ErrorMessageKey.COURSE_NOT_FOUND);
  }

  /** Debug: indexed documents plus a page of their stored chunks and vector previews. */
  async debugCourse(
    tenantId: number,
    courseId: number,
    params: { referenceIndex?: number; limit: number; offset: number },
  ) {
    await this.assertCourse(tenantId, courseId);
    const documents = await this.prisma.referenceDocument.findMany({
      where: { courseId, tenantId },
      orderBy: { referenceIndex: 'asc' },
    });
    const scoped =
      params.referenceIndex === undefined
        ? documents
        : documents.filter((doc) => doc.referenceIndex === params.referenceIndex);
    const documentIds = scoped.map((doc) => doc.id);

    if (documentIds.length === 0) {
      return { embeddingModel: this.embeddingModel, documents, total: 0, chunks: [] };
    }

    const [{ total }] = await this.prisma.$queryRaw<{ total: number }[]>`
      SELECT COUNT(*)::int AS "total" FROM "reference_chunks"
      WHERE "documentId" IN (${Prisma.join(documentIds)})`;

    const chunks = await this.prisma.$queryRaw<
      {
        id: number;
        documentId: number;
        chapterIndex: number;
        chapterName: string | null;
        chunkIndex: number;
        content: string;
        tokenCount: number | null;
        dimensions: number | null;
        norm: number | null;
        vectorHead: string | null;
      }[]
    >`
      SELECT "id", "documentId", "chapterIndex", "chapterName", "chunkIndex", "content",
             "tokenCount",
             vector_dims("embedding") AS "dimensions",
             vector_norm("embedding") AS "norm",
             subvector("embedding", 1, 8)::text AS "vectorHead"
      FROM "reference_chunks"
      WHERE "documentId" IN (${Prisma.join(documentIds)})
      ORDER BY "documentId", "chapterIndex", "chunkIndex"
      LIMIT ${params.limit} OFFSET ${params.offset}`;

    return {
      embeddingModel: this.embeddingModel,
      documents,
      total,
      chunks: chunks.map((chunk) => ({
        ...chunk,
        referenceIndex: documents.find((doc) => doc.id === chunk.documentId)?.referenceIndex ?? null,
        norm: chunk.norm === null ? null : Number(chunk.norm),
        vectorHead: chunk.vectorHead
          ? chunk.vectorHead.replace(/[[\]]/g, '').split(',').map(Number)
          : [],
      })),
    };
  }

  /** Debug: embed `query` and return the nearest chunks across the course's references. */
  async debugSearch(
    tenantId: number,
    courseId: number,
    params: { query: string; referenceIndex?: number; limit: number },
  ) {
    await this.assertCourse(tenantId, courseId);
    const documents = await this.prisma.referenceDocument.findMany({
      where: {
        courseId,
        tenantId,
        ...(params.referenceIndex !== undefined && { referenceIndex: params.referenceIndex }),
      },
      select: { id: true, referenceIndex: true, title: true, fileName: true },
    });
    if (documents.length === 0) {
      return { embeddingModel: this.embeddingModel, query: params.query, tookMs: 0, results: [] };
    }

    const started = Date.now();
    const [queryVector] = await createEmbeddings(
      this.client,
      this.embeddingModel,
      [params.query],
      { tenantId, purpose: 'reference_search_debug' },
    );
    const vector = toVectorLiteral(queryVector);
    const rows = await this.prisma.$queryRaw<
      {
        id: number;
        documentId: number;
        chapterIndex: number;
        chapterName: string | null;
        chunkIndex: number;
        content: string;
        similarity: number;
      }[]
    >`
      SELECT "id", "documentId", "chapterIndex", "chapterName", "chunkIndex", "content",
             1 - ("embedding" <=> ${vector}::vector) AS "similarity"
      FROM "reference_chunks"
      WHERE "documentId" IN (${Prisma.join(documents.map((doc) => doc.id))})
        AND "embedding" IS NOT NULL
      ORDER BY "embedding" <=> ${vector}::vector
      LIMIT ${params.limit}`;

    return {
      embeddingModel: this.embeddingModel,
      query: params.query,
      tookMs: Date.now() - started,
      results: rows.map((row) => {
        const doc = documents.find((item) => item.id === row.documentId);
        return {
          ...row,
          similarity: Number(row.similarity),
          referenceIndex: doc?.referenceIndex ?? null,
          referenceTitle: doc?.title ?? doc?.fileName ?? null,
        };
      }),
    };
  }

  /**
   * Cosine-nearest chunks within the selected reference chapters. `ready` is
   * false when any selected document is missing or out of date, so callers can
   * fall back to the raw chapter text.
   */
  async searchReferenceChunks(params: {
    tenantId: number;
    courseId: number;
    query: string;
    selections: ReferenceChapterSelection[];
    limit: number;
  }): Promise<{ ready: boolean; chunks: RetrievedReferenceChunk[] }> {
    const { tenantId, courseId, query, selections, limit } = params;
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, tenantId },
      select: { references: true },
    });
    if (!course) return { ready: false, chunks: [] };

    const entries = buildReferenceEntries(course.references, this.embeddingModel);
    const docs = await this.prisma.referenceDocument.findMany({
      where: { courseId, tenantId },
      select: { id: true, documentKey: true, contentHash: true, status: true },
    });

    const filters: Prisma.Sql[] = [];
    const docEntries = new Map<number, ReferenceIndexEntry>();
    for (const selection of selections) {
      const entry = entries.find((item) => item.referenceIndex === selection.referenceIndex);
      const chapterIndices = Array.from(new Set(selection.chapterIndices));
      if (!entry || chapterIndices.length === 0) continue;
      const doc = docs.find((item) => item.documentKey === entry.documentKey);
      if (!doc || doc.status !== 'COMPLETED' || doc.contentHash !== entry.contentHash) {
        return { ready: false, chunks: [] };
      }
      docEntries.set(doc.id, entry);
      filters.push(
        Prisma.sql`("documentId" = ${doc.id} AND "chapterIndex" IN (${Prisma.join(chapterIndices)}))`,
      );
    }
    if (filters.length === 0) return { ready: false, chunks: [] };

    const [queryVector] = await createEmbeddings(
      this.client,
      this.embeddingModel,
      [query],
      { tenantId, purpose: 'reference_search' },
    );
    const vector = toVectorLiteral(queryVector);

    const rows = await this.prisma.$queryRaw<
      {
        documentId: number;
        chapterIndex: number;
        chapterName: string | null;
        chunkIndex: number;
        content: string;
        similarity: number;
      }[]
    >`
      SELECT "documentId", "chapterIndex", "chapterName", "chunkIndex", "content",
             1 - ("embedding" <=> ${vector}::vector) AS "similarity"
      FROM "reference_chunks"
      WHERE "courseId" = ${courseId}
        AND "tenantId" = ${tenantId}
        AND "embedding" IS NOT NULL
        AND (${Prisma.join(filters, ' OR ')})
      ORDER BY "embedding" <=> ${vector}::vector
      LIMIT ${limit}`;

    return {
      ready: true,
      chunks: rows.map((row) => {
        const entry = docEntries.get(row.documentId);
        return {
          referenceIndex: entry?.referenceIndex ?? -1,
          referenceTitle: entry?.title ?? entry?.fileName ?? null,
          chapterIndex: row.chapterIndex,
          chapterName: row.chapterName,
          chunkIndex: row.chunkIndex,
          content: row.content,
          similarity: Number(row.similarity),
        };
      }),
    };
  }
}
