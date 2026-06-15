import { Processor, WorkerHost } from '@nestjs/bullmq';
import { CourseAIService } from '../course-ai.service';
import { Job } from 'bullmq';

export interface CourseExtractionJob {
  base64: string;
  mimeType: string;
  filename?: string;
}

@Processor('course-extraction')
export class CourseProcessors extends WorkerHost {
  constructor(private readonly courseAIService: CourseAIService) {
    super();
  }

  async process(job: Job<CourseExtractionJob>) {
    await job.updateProgress(10);

    const result = await this.courseAIService.extractFromBase64(
      job.data.base64,
      job.data.mimeType,
      job.data.filename,
    );

    console.log(result);

    await job.updateProgress(100);

    return result;
  }
}
