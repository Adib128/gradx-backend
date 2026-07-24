import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { AssessmentService } from '../assessment.service';
import {
  AssessmentGenerationJob,
  AssessmentGenerationProgress,
} from '../interfaces/assessment-generation-job.interface';

@Processor('assessment-generation', {
  lockDuration: 15 * 60 * 1000,
  stalledInterval: 60 * 1000,
  maxStalledCount: 2,
})
export class AssessmentGenerationProcessor extends WorkerHost {
  constructor(private readonly assessmentService: AssessmentService) {
    super();
  }

  async process(job: Job<AssessmentGenerationJob>) {
    return this.assessmentService.runGenerationJob(
      job.data,
      async (progress: AssessmentGenerationProgress) => {
        await job.updateProgress(progress);
      },
    );
  }
}
