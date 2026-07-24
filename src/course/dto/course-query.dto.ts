import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export const courseQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().default(10),
  search: z.string().optional(),
});

export class CourseQueryDto extends createZodDto(courseQuerySchema) {}
