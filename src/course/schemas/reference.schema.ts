import { z } from 'zod';
import { ValidationMessageKey as V } from 'src/common/constants/validation-message';
import { MAX_REFERENCE_EXTRACTED_CHARS } from '../utils/extract-reference-document.util';

export const ReferenceSchema = z.object({
  type: z.enum(['ESSENTIAL', 'SUPPORTIVE', 'ELECTRONIC', 'OTHER'], {
    message: V.REFERENCE_TYPE_INVALID,
  }),
  title: z.string().min(1, V.REFERENCE_TITLE_REQUIRED),
  authors: z.string().nullable().optional(),
  publisher: z.string().nullable().optional(),
  /** Original uploaded file name (optional attachment). */
  fileName: z.string().nullable().optional(),
  /** Relative or absolute stored file path (optional). */
  filePath: z.string().nullable().optional(),
  mimeType: z.string().nullable().optional(),
  fileSize: z.number().int().nonnegative().nullable().optional(),
  /** Plain text extracted from the attached PDF/DOCX (truncated server-side). */
  extractedText: z
    .string()
    .max(MAX_REFERENCE_EXTRACTED_CHARS + 80)
    .nullable()
    .optional(),
  characterCount: z.number().int().nonnegative().nullable().optional(),
  truncated: z.boolean().nullable().optional(),
  extractionMethod: z.enum(['pdf', 'docx']).nullable().optional(),
  extractedAt: z.string().nullable().optional(),
});
