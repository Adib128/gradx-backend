import { Module } from '@nestjs/common';
import { AnswerSheetsController } from './answer-sheets.controller';
import { CourseAnswerSheetController } from './course-answer-sheet.controller';
import { CourseAnswerSheetService } from './course-answer-sheet.service';

@Module({
  controllers: [CourseAnswerSheetController, AnswerSheetsController],
  providers: [CourseAnswerSheetService],
})
export class CourseAnswerSheetModule {}
