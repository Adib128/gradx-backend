import z from 'zod';

export const CLOSchema = z.object({
  code: z.string().min(1),
  category: z.string(),
  programCLOCode: z.string().nullable().optional(),
  description: z.string().min(1),
  teachingStrategies: z.array(z.string()).default([]),
  assessmentMethods: z.array(z.string()).default([]),
});
