import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { runWithAiContext } from 'src/common/helpers/openrouter-chat.helper';
import {
  REFERENCE_EMBEDDING_QUEUE,
  ReferenceVectorService,
  type ReferenceEmbeddingJob,
} from '../reference-vector.service';

/** Concurrency 1 keeps two syncs of the same course from interleaving writes. */
@Processor(REFERENCE_EMBEDDING_QUEUE, {
  concurrency: 1,
  lockDuration: 10 * 60 * 1000,
  stalledInterval: 60 * 1000,
  maxStalledCount: 2,
})
export class ReferenceEmbeddingProcessor extends WorkerHost {
  constructor(private readonly referenceVectorService: ReferenceVectorService) {
    super();
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
