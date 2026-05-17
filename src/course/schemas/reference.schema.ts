import { z } from 'zod';

export const ReferenceSchema = z.object({
  type: z.enum(['ESSENTIAL', 'SUPPORTIVE', 'ELECTRONIC', 'OTHER']),
  title: z.string().min(1),
  authors: z.string().nullable().optional(),
  publisher: z.string().nullable().optional(),
});
