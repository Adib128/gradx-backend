import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export const studentQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(10),
    search: z.string().optional(),
  })
  .default({ page: 1, limit: 10 });

export class StudentQueryDto extends createZodDto(studentQuerySchema) {}
