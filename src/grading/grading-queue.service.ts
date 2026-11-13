import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, QueueEvents } from 'bullmq';
import {
  GRADING_JOB_WAIT_MS,
  GRADING_QUEUE,
} from './grading.constants';
import type { GradingJobData, GradingJobResult } from './grading-job.types';
import type { NodeGraderLayout } from './node-grader.service';
import type { OpenCvProcessResult } from './opencv-grading.service';

/**
 * Enqueues OpenCV / Node grading and waits for the worker so HTTP handlers keep
 * the same sync response shape (mobile unchanged) while concurrency is capped.
 */
@Injectable()
export class GradingQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GradingQueueService.name);
  private queueEvents: QueueEvents | null = null;

  constructor(
    @InjectQueue(GRADING_QUEUE) private readonly queue: Queue<GradingJobData>,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    this.queueEvents = new QueueEvents(GRADING_QUEUE, {
      connection: {
        host: this.config.get<string>('REDIS_HOST') ?? 'localhost',
        port: Number(this.config.get<number>('REDIS_PORT') ?? 6379),
        password: this.config.get<string>('REDIS_PASSWORD') || undefined,
        maxRetriesPerRequest: null,
      },
    });
    await this.queueEvents.waitUntilReady();
    this.logger.log(
      `Grading queue ready (wait up to ${GRADING_JOB_WAIT_MS}ms per job)`,
    );
  }

  async onModuleDestroy() {
    await this.queueEvents?.close().catch(() => undefined);
    this.queueEvents = null;
  }

  /** Same contract as OpenCvGradingService.processAnswerSheet. */
  async processAnswerSheet(
    imagePath: string,
    configJson?: string,
  ): Promise<OpenCvProcessResult> {
    return this.enqueueAndWait({
      kind: 'opencv',
      imagePath,
      configJson,
    });
  }

  /** Same contract as NodeGraderService.gradeSheet. */
  async gradeSheet(
    imagePath: string,
    numIdDigits = 5,
    layout: NodeGraderLayout = {},
  ): Promise<OpenCvProcessResult> {
    return this.enqueueAndWait({
      kind: 'node',
      imagePath,
      numIdDigits,
      layout,
    });
  }

  private async enqueueAndWait(data: GradingJobData): Promise<GradingJobResult> {
    if (!this.queueEvents) {
      throw new Error('Grading queue is not ready.');
    }
    const job = await this.queue.add(data.kind, data, {
      removeOnComplete: 100,
      removeOnFail: 50,
      attempts: 1,
    });
    this.logger.debug(
      `Queued grading job ${job.id} (${data.kind}) for ${data.imagePath}`,
    );
    return job.waitUntilFinished(
      this.queueEvents,
      GRADING_JOB_WAIT_MS,
    ) as Promise<GradingJobResult>;
  }
}
