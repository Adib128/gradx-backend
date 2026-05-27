import z from 'zod';
import { AssessmentType, Language } from 'generated/prisma/enums';

export const AssessmentSchema = z.object({
  title: z.string(),
  type: z.enum(AssessmentType),
  timing: z.string().optional(),
  score: z.number().optional(),
  duration: z.number().optional(),
  totalPoints: z.number().optional(),
  passMark: z.number().optional(),
  language: z.enum(Language).optional(),
  courseId: z.number().optional(),
});
