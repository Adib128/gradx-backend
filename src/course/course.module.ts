import { Module } from '@nestjs/common';
import { CourseService } from './course.service';
import { CourseController } from './course.controller';
import { CourseAIService } from './course-ai.service';
import { BullModule } from '@nestjs/bullmq';
import { CourseProcessors } from './processors/course-extraction.processors';
import { TopicService } from './topic.service';
import { DocxPdfService } from './docx-pdf.service';
import { CourseReportsService } from './course-reports.service';
import { CourseWorkbookService } from './course-workbook.service';
import { CourseSurveyService } from './course-survey.service';
import { CourseSurveyController } from './course-survey.controller';
import { PublicSurveyController } from './public-survey.controller';
import { ReferenceVectorModule } from 'src/reference-vector/reference-vector.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'course-extraction',
    }),
    ReferenceVectorModule,
  ],
  controllers: [
    CourseController,
    CourseSurveyController,
    PublicSurveyController,
  ],
  providers: [
    CourseService,
    CourseAIService,
    CourseProcessors,
    TopicService,
    CourseReportsService,
    DocxPdfService,
    CourseWorkbookService,
    CourseSurveyService,
  ],
})
export class CourseModule {}
