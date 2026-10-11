import z from 'zod';
import { createZodDto } from 'nestjs-zod';
import { MAX_SLIDES, MIN_SLIDES } from '../utils/studio-coerce.util';

const SelectionSchema = z.object({
  referenceIndex: z.number().int().nonnegative(),
  chapterIndices: z.array(z.number().int().nonnegative()).max(200),
});

export const StartSlideStudioSchema = z.object({
  slideCount: z.number().int().min(MIN_SLIDES).max(MAX_SLIDES),
  selections: z.array(SelectionSchema).max(10).default([]),
});

export const ResumeSlideStudioSchema = z.object({
  kind: z.enum(['plan_review', 'template_review', 'outline_review']),
  action: z.enum(['confirm', 'revise']),
  feedback: z.string().trim().max(2000).optional(),
  templateId: z.string().max(60).optional(),
  plan: z.unknown().optional(),
  outline: z.unknown().optional(),
});

export const SaveSlideTemplateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).nullable().optional(),
  source: z.enum(['pptx', 'custom']).default('custom'),
  /** The user confirms they own or are licensed to use the uploaded logo/artwork/PPTX. */
  rightsConfirmed: z.boolean().optional(),
  theme: z
    .record(z.string(), z.unknown())
    .refine((theme) => JSON.stringify(theme).length <= 40_000, 'Template is too large.'),
});

export class StartSlideStudioDto extends createZodDto(StartSlideStudioSchema) {}
export class SaveSlideTemplateDto extends createZodDto(SaveSlideTemplateSchema) {}
export class ResumeSlideStudioDto extends createZodDto(ResumeSlideStudioSchema) {}
