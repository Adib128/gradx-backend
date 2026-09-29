import z from 'zod';
import { ValidationMessageKey as V } from 'src/common/constants/validation-message';

/** Accepts an array or newline/semicolon/bullet separated text; one entry per strategy/method. */
const normalizeCloTextList = (value: unknown) => {
  if (value === undefined || value === null) return value;
  const items = Array.isArray(value) ? value : [value];
  return items
    .flatMap((item) =>
      String(item ?? '')
        .split(/\r?\n|;|؛|•|▪|●/)
        .map((part) => part.replace(/^\s*(?:[-*–]|\d+[.)])\s+/, '').trim()),
    )
    .filter(Boolean);
};

export const CloSchema = z.object({
  code: z.string().min(1, V.CLO_CODE_REQUIRED),
  category: z.string().default(''),
  programCLOCode: z.string().nullable().optional(),
  description: z.string().min(1, V.CLO_DESCRIPTION_REQUIRED),
  teachingStrategies: z.preprocess(normalizeCloTextList, z.array(z.string()).default([])),
  assessmentMethods: z.preprocess(normalizeCloTextList, z.array(z.string()).default([])),
  courseId: z.number().positive().optional().nullable(),
});
