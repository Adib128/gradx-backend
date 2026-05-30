import z from 'zod';
import { AssessmentType, Language } from 'generated/prisma/enums';
import { prismaEnumToZod } from 'src/common/helpers/zod.enum.helper';

export const AssessmentSchema = z.object({
  title: z.string(),
  type: prismaEnumToZod(AssessmentType),
  timing: z.string().optional(),
  score: z.number().optional(),
  duration: z.number().optional(),
  totalPoints: z.number().optional(),
  passMark: z.number().optional(),
  language: prismaEnumToZod(Language).optional(),
});
