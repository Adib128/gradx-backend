import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export const createStudentSchema = z.object({
  name: z.string(),
  code: z.string(),
  class: z.string().nullable().optional(),
  departement: z.string().nullable().optional(),
});

export class CreateStudentDto extends createZodDto(createStudentSchema) {}
