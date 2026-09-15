import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export const courseQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().default(10),
  search: z.string().optional(),
  academicYear: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined)),
  semester: z
    .string()
    .trim()
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      return value.toUpperCase();
    })
    .refine(
      (value) =>
        value === undefined || ['FIRST', 'SECOND', 'THIRD'].includes(value),
      { message: 'SEMESTER_INVALID' },
    ),
});

export class CourseQueryDto extends createZodDto(courseQuerySchema) {}
