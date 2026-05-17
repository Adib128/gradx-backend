import { Module } from '@nestjs/common';
import { CourseService } from './course.service';
import { CourseController } from './course.controller';
import { CourseAIService } from './course-ai.service';
import { BullModule } from '@nestjs/bullmq';
import { CourseProcessors } from './processors/course-extraction.processors';
import { TopicService } from './topic.service';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'course-extraction',
    }),
  ],
  controllers: [CourseController],
  providers: [CourseService, CourseAIService, CourseProcessors, TopicService],
})
export class CourseModule {}
