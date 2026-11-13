import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { runWithAiContext } from 'src/common/helpers/openrouter-chat.helper';
import {
  REFERENCE_EMBEDDING_QUEUE,
  REFERENCE_EMBEDDING_QUEUE_CONCURRENCY,
} from '../reference-vector.constants';
import {
  ReferenceVectorService,
  type ReferenceEmbeddingJob,
} from '../reference-vector.service';

/**
 * Serializes reference indexing (default concurrency 1) so large textbooks
 * cannot run many embedding jobs in parallel alongside content generation.
 */
@Processor(REFERENCE_EMBEDDING_QUEUE, {
  concurrency: REFERENCE_EMBEDDING_QUEUE_CONCURRENCY,
  lockDuration: 10 * 60 * 1000,
  stalledInterval: 60 * 1000,
  maxStalledCount: 2,
})
export class ReferenceEmbeddingProcessor extends WorkerHost {
  private readonly logger = new Logger(ReferenceEmbeddingProcessor.name);

  constructor(private readonly referenceVectorService: ReferenceVectorService) {
    super();
    this.logger.log(
      `Reference embedding worker concurrency=${REFERENCE_EMBEDDING_QUEUE_CONCURRENCY}`,
    );
  }

  async process(job: Job<ReferenceEmbeddingJob>) {
    return runWithAiContext(
      {
        userId: job.data.userId ?? null,
        tenantId: job.data.tenantId ?? null,
        purpose: 'reference_embedding',
      },
      () => this.referenceVectorService.syncCourse(job.data.courseId),
    );
  }
}
