import z from 'zod';
import { ValidationMessageKey as V } from 'src/common/constants/validation-message';

export const CloSchema = z.object({
  code: z.string().min(1, V.CLO_CODE_REQUIRED),
  category: z.string().default(''),
  programCLOCode: z.string().nullable().optional(),
  description: z.string().min(1, V.CLO_DESCRIPTION_REQUIRED),
  teachingStrategies: z.array(z.string()).default([]),
  assessmentMethods: z.array(z.string()).default([]),
  courseId: z.number().positive().optional().nullable(),
});
