import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const googleLoginSchema = z.object({
  idToken: z.string().trim().min(1, 'GOOGLE_ID_TOKEN_REQUIRED'),
});

export class GoogleLoginDto extends createZodDto(googleLoginSchema) {}
