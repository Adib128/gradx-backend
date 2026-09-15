import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const resendVerificationSchema = z.object({
  email: z.string().email(),
  language: z.enum(['en', 'ar']).optional().default('en'),
});

export class ResendVerificationDto extends createZodDto(
  resendVerificationSchema,
) {}
