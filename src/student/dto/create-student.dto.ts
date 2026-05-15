import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export const createStudentSchema = z.object({
  name: z.string(),
  code: z.string(),
  classId: z.number(),
});

export class CreateStudentDto extends createZodDto(createStudentSchema) {}
