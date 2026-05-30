import z from 'zod';

export const QuestionOptionSchema = z.object({
  text: z.string(),
  isCorrect: z.boolean(),
  order: z.number().positive(),
});
