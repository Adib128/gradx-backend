import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  GRADING_QUEUE,
  GRADING_QUEUE_CONCURRENCY,
} from '../grading.constants';
import type { GradingJobData, GradingJobResult } from '../grading-job.types';
import { NodeGraderService } from '../node-grader.service';
import { OpenCvGradingService } from '../opencv-grading.service';

/**
 * Runs OpenCV / Node OMR with a hard concurrency cap so exam-day scans
 * cannot stampede the single Nest process.
 */
@Processor(GRADING_QUEUE, {
  concurrency: GRADING_QUEUE_CONCURRENCY,
  lockDuration: 3 * 60 * 1000,
  stalledInterval: 60 * 1000,
  maxStalledCount: 1,
})
export class GradingProcessor extends WorkerHost {
  private readonly logger = new Logger(GradingProcessor.name);

  constructor(
    private readonly openCvService: OpenCvGradingService,
    private readonly nodeGrader: NodeGraderService,
  ) {
    super();
    this.logger.log(
      `Grading worker concurrency=${GRADING_QUEUE_CONCURRENCY}`,
    );
  }

  async process(job: Job<GradingJobData>): Promise<GradingJobResult> {
    const started = Date.now();
    try {
      if (job.data.kind === 'opencv') {
        const result = await this.openCvService.processAnswerSheet(
          job.data.imagePath,
          job.data.configJson,
        );
        this.logger.debug(
          `OpenCV job ${job.id} done in ${Date.now() - started}ms`,
        );
        return result;
      }

      const result = await this.nodeGrader.gradeSheet(
        job.data.imagePath,
        job.data.numIdDigits,
        job.data.layout ?? {},
      );
      this.logger.debug(
        `Node grader job ${job.id} done in ${Date.now() - started}ms`,
      );
      return result;
    } catch (err) {
      this.logger.warn(
        `Grading job ${job.id} (${job.data.kind}) failed after ${Date.now() - started}ms: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw err;
    }
  }
}
