import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { QuestionSchema } from '../schema/question.schema';

export const AddQuestionSchema = QuestionSchema.extend({
  cloIds: z.array(z.number()).default([]),
});

export const UpdateQuestionSchema = QuestionSchema.partial().extend({
  cloIds: z.array(z.number()).optional(),
});

export class AddQuestionDto extends createZodDto(AddQuestionSchema) {}

export class UpdateQuestionDto extends createZodDto(UpdateQuestionSchema) {}
