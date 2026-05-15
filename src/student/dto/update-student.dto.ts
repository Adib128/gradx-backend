import { createZodDto } from 'nestjs-zod';
import { createStudentSchema } from './create-student.dto';

export const updateStudentSchema = createStudentSchema.partial();

export class UpdateStudentDto extends createZodDto(updateStudentSchema) {}
