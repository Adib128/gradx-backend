import { createZodDto } from 'nestjs-zod';
import { RegisterSchema } from './register.dto';

export const UpdateProfileSchema = RegisterSchema.omit({
  password: true,
}).partial();

export class UpdateProfileDto extends createZodDto(UpdateProfileSchema) {}
