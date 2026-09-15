import { z } from 'zod';
import { ValidationMessageKey as V } from 'src/common/constants/validation-message';
import { MAX_REFERENCE_EXTRACTED_CHARS } from '../utils/extract-reference-document.util';
import { normalizeReferenceType } from '../utils/normalize-course-confirm.util';

export const ReferenceSchema = z.object({
  type: z.preprocess(
    normalizeReferenceType,
    z.enum(['ESSENTIAL', 'SUPPORTIVE', 'ELECTRONIC', 'OTHER'], {
      message: V.REFERENCE_TYPE_INVALID,
    }),
  ),
  title: z.string().min(1, V.REFERENCE_TITLE_REQUIRED),
  authors: z.string().nullable().optional(),
  publisher: z.string().nullable().optional(),
  /** Original uploaded file name (optional attachment). */
  fileName: z.string().nullable().optional(),
  /** Relative path under uploads/reference-documents/{tenantId}/ (archive only). */
  filePath: z.string().nullable().optional(),
  mimeType: z.string().nullable().optional(),
  fileSize: z.number().int().nonnegative().nullable().optional(),
  /**
   * Legacy flat body. Prefer `chapters`; normalize clears this when chapters exist.
   * Kept only for older rows that have not been re-saved.
   */
  extractedText: z
    .string()
    .max(MAX_REFERENCE_EXTRACTED_CHARS + 80)
    .nullable()
    .optional(),
  /** Chapter-split plain text — source of truth for AI prompts (no images). */
  chapters: z
    .array(
      z.object({
        name: z.string().min(1),
        content: z.string().max(MAX_REFERENCE_EXTRACTED_CHARS + 80),
      }),
    )
    .max(200)
    .nullable()
    .optional(),
  characterCount: z.number().int().nonnegative().nullable().optional(),
  truncated: z.boolean().nullable().optional(),
  extractionMethod: z.enum(['pdf', 'docx']).nullable().optional(),
  extractedAt: z.string().nullable().optional(),
  /** Rasterized figure pages + captions (files on disk; not DB blobs). */
  figures: z
    .array(
      z.object({
        id: z.string().min(1),
        caption: z.string().min(1),
        pageNumber: z.number().int().positive(),
        filePath: z.string().min(1),
        mimeType: z.string().min(1),
        width: z.number().int().positive().nullable().optional(),
        height: z.number().int().positive().nullable().optional(),
      }),
    )
    .max(48)
    .nullable()
    .optional(),
});
