import { QuestionType } from 'generated/prisma/enums';
import z from 'zod';
import { QuestionOptionSchema } from './question-option.schema';

export const QuestionSchema = z.object({
  type: z.enum(QuestionType),
  text: z.string(),
  explanation: z.string().optional(),
  points: z.number().optional(),
  difficulty: z.enum(['Easy', 'Medium', 'Hard']).optional(),
  sortOrder: z.number().int().optional(),
  /** Single letter ("A") or multi ("A,C") when several MCQ options are correct. */
  correctAnswer: z.string(),
  allowMultipleCorrect: z.boolean().optional().default(false),
  codeTemplate: z.string().optional(),
  codeLanguage: z.string().optional(),
  expectedOutput: z.string().optional(),
  mathFormula: z.string().optional(),
  mathSolution: z.string().optional(),
  topicId: z.number(),
  questionOptions: z.array(QuestionOptionSchema).default([]),
});
