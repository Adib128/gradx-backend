import { Module } from '@nestjs/common';
import { TopicContentController } from './topic-content.controller';
import { TopicContentService } from './topic-content.service';
import { BullModule } from '@nestjs/bullmq';
import { TopicContentAiService } from './topic-content-ai.service';
import { ContentGeneratonProcessor } from './processors/content-generation.processor';
import { SkyworkPptService } from './skywork-ppt.service';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'topic-content-generation',
    }),
  ],
  controllers: [TopicContentController],
  providers: [
    TopicContentService,
    TopicContentAiService,
    SkyworkPptService,
    ContentGeneratonProcessor,
  ],
})
export class TopicContentModule {}
