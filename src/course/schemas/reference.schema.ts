import { z } from 'zod';
import { ValidationMessageKey as V } from 'src/common/constants/validation-message';

export const ReferenceSchema = z.object({
  type: z.enum(['ESSENTIAL', 'SUPPORTIVE', 'ELECTRONIC', 'OTHER'], {
    message: V.REFERENCE_TYPE_INVALID,
  }),
  title: z.string().min(1, V.REFERENCE_TITLE_REQUIRED),
  authors: z.string().nullable().optional(),
  publisher: z.string().nullable().optional(),
});
