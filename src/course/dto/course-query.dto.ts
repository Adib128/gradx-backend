import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export const courseQuerySchema = z
  .object({
    page: z.coerce.number().int().positive(),
    limit: z.coerce.number().int().positive(),
    search: z.string().optional(),
  })
  .default({ page: 1, limit: 10 });

export class CourseQueryDto extends createZodDto(courseQuerySchema) {}
