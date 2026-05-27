import z from 'zod';
import { AssessmentSchema } from './assessment.schema';
import { QuestionType } from 'generated/prisma/enums';
import { createZodDto } from 'nestjs-zod';

const QuestionTypeConfigSchema = z.object({
  questionType: z.enum(QuestionType),
  questionTypeNumber: z.number().int().positive(),
});

const TopicGenerationSchema = z.object({
  topicId: z.number(),
  cloIds: z.array(z.number()),
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
