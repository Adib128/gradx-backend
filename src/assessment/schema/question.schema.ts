import { Bloom, QuestionType } from 'generated/prisma/enums';
import z from 'zod';
import { QuestionOptionSchema } from './question-option.schema';
import { prismaEnumToZod } from 'src/common/helpers/zod.enum.helper';

export const QuestionSchema = z.object({
  type: z.enum(QuestionType),
  text: z.string(),
  bloom: prismaEnumToZod(Bloom).optional(),
  explanation: z.string().optional(),
  points: z.number().optional(),
  correctAnswer: z.string(),
  codeTemplate: z.string().optional(),
  codeLanguage: z.string().optional(),
  expectedOutput: z.string().optional(),
  mathFormula: z.string().optional(),
  mathSolution: z.string().optional(),
  topicId: z.number(),
  questionOptions: z.array(QuestionOptionSchema).default([]),
});
