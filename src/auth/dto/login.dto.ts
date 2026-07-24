import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ValidationMessageKey as V } from 'src/common/constants/validation-message';

export const loginSchema = z.object({
  email: z
    .string({ message: V.EMAIL_REQUIRED })
    .trim()
    .email(V.EMAIL_INVALID),

  password: z
    .string({ message: V.PASSWORD_REQUIRED })
    .min(1, V.PASSWORD_REQUIRED),
});

export class LoginDto extends createZodDto(loginSchema) {}
