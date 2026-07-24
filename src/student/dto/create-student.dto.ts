import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const emptyToNull = (value: unknown) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
};

export const createStudentSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  studentId: z.string().min(1, 'Student ID is required'),
  section: z.preprocess(emptyToNull, z.string().nullable().optional()),
  departement: z.preprocess(emptyToNull, z.string().nullable().optional()),
});

export class CreateStudentDto extends createZodDto(createStudentSchema) {}
