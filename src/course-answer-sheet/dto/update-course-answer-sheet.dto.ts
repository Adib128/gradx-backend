import { createZodDto } from 'nestjs-zod';
import { CreateCourseAnswerSheetSchema } from './create-course-answer-sheet.dto';

export const UpdateCourseAnswerSheetSchema = CreateCourseAnswerSheetSchema.partial();

export class UpdateCourseAnswerSheetDto extends createZodDto(
  UpdateCourseAnswerSheetSchema,
) {}
