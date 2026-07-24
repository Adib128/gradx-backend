import { Module } from '@nestjs/common';
import { CourseAnswerSheetController } from './course-answer-sheet.controller';
import { CourseAnswerSheetService } from './course-answer-sheet.service';

@Module({
  controllers: [CourseAnswerSheetController],
  providers: [CourseAnswerSheetService],
})
export class CourseAnswerSheetModule {}
