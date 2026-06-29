import { z } from 'zod';

export const ReferenceSchema = z.object({
  type: z.enum(['ESSENTIAL', 'SUPPORTIVE', 'ELECTRONIC', 'OTHER'], {
    message: 'Reference type is invalid',
  }),
  title: z.string().min(1, 'Reference title is required'),
  authors: z.string().nullable().optional(),
  publisher: z.string().nullable().optional(),
});
