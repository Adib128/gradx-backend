import { Processor, WorkerHost } from '@nestjs/bullmq';
import { TopicContentAiService } from '../topic-content-ai.service';
import { Job } from 'bullmq';
import { ContentGenerationJob } from '../interfaces/content-generation-job.interface';
import { TopicContentService } from '../topic-content.service';
import { ErrorMessageKey } from 'src/common/constants/error-message';

@Processor('topic-content-generation', {
  lockDuration: 15 * 60 * 1000,
  stalledInterval: 60 * 1000,
  maxStalledCount: 2,
})
export class ContentGeneratonProcessor extends WorkerHost {
  constructor(
    private readonly topicContentAiService: TopicContentAiService,
    private readonly topicContentService: TopicContentService,
  ) {
    super();
  }

  private assertNotCancelled(job: Job<ContentGenerationJob>) {
    this.topicContentService.assertGenerationNotCancelled(job.id);
  }

  async process(job: Job<ContentGenerationJob>) {
    try {
      this.assertNotCancelled(job);

      if (job.data.type === 'LECTURE') {
        const result =
          await this.topicContentAiService.generateLectureStreaming(
            job.data,
            async (progress) => {
              this.assertNotCancelled(job);
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

        this.assertNotCancelled(job);
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
        // In-system AI slides (lecture → deck JSON → pagination). No external PPT API.
        const result = await this.topicContentAiService.generateSlides(
          job.data,
          async (progress) => {
            this.assertNotCancelled(job);
            await job.updateProgress({
              stage: progress.stage,
              percent: progress.percent,
              message: progress.message,
              partial: progress.partial,
            });
            await this.topicContentService.savePartialContent(
              job.data.topicId,
              job.data.courseId,
              job.data.tenantId,
              'SLIDES',
              progress.partial,
            );
          },
        );

        this.assertNotCancelled(job);
        await this.topicContentService.saveContent(
          job.data.topicId,
          job.data.courseId,
          job.data.tenantId,
          'SLIDES',
          result,
        );
        return result;
      }

      if (job.data.type === 'LAB') {
        const result = await this.topicContentAiService.generateLabStreaming(
          job.data,
          async (progress) => {
            this.assertNotCancelled(job);
            await job.updateProgress(progress);
            await this.topicContentService.savePartialContent(
              job.data.topicId,
              job.data.courseId,
              job.data.tenantId,
              'LAB',
              progress.partial,
            );
          },
        );

        this.assertNotCancelled(job);
        await this.topicContentService.saveContent(
          job.data.topicId,
          job.data.courseId,
          job.data.tenantId,
          'LAB',
          result,
          'ACCEPTED',
        );
        return result;
      }

      this.assertNotCancelled(job);
      const result = await this.topicContentAiService.generate(
        job.data.type,
        job.data,
      );
      this.assertNotCancelled(job);
      await this.topicContentService.saveContent(
        job.data.topicId,
        job.data.courseId,
        job.data.tenantId,
        job.data.type,
        result,
      );
      return result;
    } catch (error) {
      if (
        this.topicContentService.isGenerationCancelled(job.id) ||
        String((error as Error)?.message || '')
          .toUpperCase()
          .includes('CANCELLED')
      ) {
        throw new Error(ErrorMessageKey.TOPIC_CONTENT_GENERATION_CANCELLED);
      }
      throw error;
    }
  }
}
