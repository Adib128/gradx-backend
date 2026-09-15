import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export const verifySchema = z.object({
  email: z.string().email(),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Code must be 6 digits'),
});

export class VerifyDto extends createZodDto(verifySchema) {}
