import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { QuestionSchema } from '../schema/question.schema';

export const AddQuestionSchema = QuestionSchema.extend({
  cloIds: z.array(z.number()).default([]),
});

export const UpdateQuestionSchema = QuestionSchema.partial().extend({
  cloIds: z.array(z.number()).optional(),
});

export const ReorderQuestionsSchema = z.object({
  questionIds: z.array(z.number().int().positive()).min(1),
});

export const EnhanceQuestionSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
});

export class AddQuestionDto extends createZodDto(AddQuestionSchema) {}

export class UpdateQuestionDto extends createZodDto(UpdateQuestionSchema) {}

export class ReorderQuestionsDto extends createZodDto(ReorderQuestionsSchema) {}

export class EnhanceQuestionDto extends createZodDto(EnhanceQuestionSchema) {}
