import { Module } from '@nestjs/common';
import { CourseService } from './course.service';
import { CourseController } from './course.controller';
import { CourseAIService } from './course-ai.service';
import { BullModule } from '@nestjs/bullmq';
import { CourseProcessors } from './processors/course-extraction.processors';
import { TopicService } from './topic.service';
import { DocxPdfService } from './docx-pdf.service';
import { CourseReportsService } from './course-reports.service';
import { ReferenceVectorModule } from 'src/reference-vector/reference-vector.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'course-extraction',
    }),
    ReferenceVectorModule,
  ],
  controllers: [CourseController],
  providers: [
    CourseService,
    CourseAIService,
    CourseProcessors,
    TopicService,
    CourseReportsService,
    DocxPdfService,
  ],
})
export class CourseModule {}
