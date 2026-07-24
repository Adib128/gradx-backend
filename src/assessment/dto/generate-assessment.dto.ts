import z from 'zod';
import { QuestionType } from 'generated/prisma/enums';
import { createZodDto } from 'nestjs-zod';
import { AssessmentSchema } from '../schema/assessment.schema';
import { ACTIVE_GENERATION_QUESTION_TYPES } from '../config/question-types.config';

const QuestionTypeConfigSchema = z.object({
  questionType: z.enum(ACTIVE_GENERATION_QUESTION_TYPES),
  questionTypeNumber: z.number().int().positive(),
});

const TopicGenerationSchema = z.object({
  topicId: z.number(),
  cloIds: z.array(z.number()).default([]),
  cloCodes: z.array(z.string()).default([]),
  blooms: z.array(z.string()),
  questionTypes: z.array(QuestionTypeConfigSchema),
});

export const GenerateAssessmentSchema = z.object({
  assessment: AssessmentSchema,
  topicGenerations: z.array(TopicGenerationSchema),
});

export class GenerateAssessmentDto extends createZodDto(
  GenerateAssessmentSchema,
) {}
