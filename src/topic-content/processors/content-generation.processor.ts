import { Processor, WorkerHost } from '@nestjs/bullmq';
import { TopicContentAiService } from '../topic-content-ai.service';
import { Job } from 'bullmq';
import { ContentGenerationJob } from '../interfaces/content-generation-job.interface';
import { TopicContentService } from '../topic-content.service';
import { SkyworkPptService } from '../skywork-ppt.service';

@Processor('topic-content-generation', {
  lockDuration: 15 * 60 * 1000,
  stalledInterval: 60 * 1000,
  maxStalledCount: 2,
})
export class ContentGeneratonProcessor extends WorkerHost {
  constructor(
    private readonly topicContentAiService: TopicContentAiService,
    private readonly topicContentService: TopicContentService,
    private readonly skyworkPptService: SkyworkPptService,
  ) {
    super();
  }

  async process(job: Job<ContentGenerationJob>) {
    try {
      if (job.data.type === 'LECTURE') {
        const result = await this.topicContentAiService.generateLectureStreaming(
          job.data,
          async (progress) => {
            await job.updateProgress(progress);
            await this.topicContentService.savePartialContent(
              job.data.topicId,
              job.data.courseId,
              job.data.tenantId,
              job.data.type,
              progress.partial,
            );
          },
        );

        await this.topicContentService.saveContent(
          job.data.topicId,
          job.data.courseId,
          job.data.tenantId,
          job.data.type,
          result,
        );
        return result;
      }

      if (job.data.type === 'SLIDES') {
        const existing = await this.topicContentService.getSlidesMeta(
          job.data.tenantId,
          job.data.topicId,
        );
        if (existing?.filePath) {
          await this.skyworkPptService.deleteStoredFile(existing.filePath);
        }

        const result = await this.skyworkPptService.generateSlides(
          job.data,
          async (progress) => {
            await job.updateProgress({
              stage: progress.stage,
              percent: progress.percent,
              message: progress.message,
              partial: {
                source: 'skywork',
                streamStatus: progress.stage,
                progressMessage: progress.message,
                outline: progress.outline,
              },
            });
            await this.topicContentService.savePartialContent(
              job.data.topicId,
              job.data.courseId,
              job.data.tenantId,
              'SLIDES',
              {
                source: 'skywork',
                provider: 'skywork',
                streamStatus: progress.stage,
                progressMessage: progress.message,
                percent: progress.percent,
                outline: progress.outline,
              },
            );
          },
        );

        await this.topicContentService.saveContent(
          job.data.topicId,
          job.data.courseId,
          job.data.tenantId,
          'SLIDES',
          result,
        );
        return result;
      }

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
