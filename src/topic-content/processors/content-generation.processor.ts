import { Processor, WorkerHost } from '@nestjs/bullmq';
import { TopicContentAiService } from '../topic-content-ai.service';
import { Job } from 'bullmq';
import { ContentGenerationJob } from '../interfaces/content-generation-job.interface';
import { TopicContentService } from '../topic-content.service';

@Processor('topic-content-generation')
export class ContentGeneratonProcessor extends WorkerHost {
  constructor(
    private readonly topicContentAiService: TopicContentAiService,
    private readonly topicContentService: TopicContentService,
  ) {
    super();
  }

  async process(job: Job<ContentGenerationJob>) {
    try {
      const result = await this.topicContentAiService.generate(
        job.data.type,
        job.data,
      );
      await this.topicContentService.saveContent(
        job.data.topicId,
        job.data.courseId,
        job.data.tenantId,
        job.data.type,
        result,
      );
      return result;
    } catch (error) {
      throw error;
    }
  }
}
