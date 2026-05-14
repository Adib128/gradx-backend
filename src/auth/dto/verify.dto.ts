import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export const verifySchema = z.object({
  email: z.string().email(),
  code: z.string().min(6).max(6),
});

export class VerifyDto extends createZodDto(verifySchema) {}
