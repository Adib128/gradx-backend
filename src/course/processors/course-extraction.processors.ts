import { Processor, WorkerHost } from '@nestjs/bullmq';
import { CourseAIService } from '../course-ai.service';
import { Job } from 'bullmq';
import { runWithAiContext } from 'src/common/helpers/openrouter-chat.helper';

export interface CourseExtractionJob {
  base64: string;
  mimeType: string;
  filename?: string;
  userId?: number;
  tenantId?: number;
}

@Processor('course-extraction')
export class CourseProcessors extends WorkerHost {
  constructor(private readonly courseAIService: CourseAIService) {
    super();
  }

  async process(job: Job<CourseExtractionJob>) {
    await job.updateProgress(10);

    const result = await runWithAiContext(
      {
        userId: job.data.userId,
        tenantId: job.data.tenantId,
        purpose: 'course_extract',
      },
      () =>
        this.courseAIService.extractFromBase64(
          job.data.base64,
          job.data.mimeType,
          job.data.filename,
        ),
    );

    await job.updateProgress(100);

    return result;
  }
}
