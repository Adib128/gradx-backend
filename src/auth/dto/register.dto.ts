import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ValidationMessageKey as V } from 'src/common/constants/validation-message';

const PasswordSchema = z
  .string({ message: V.PASSWORD_REQUIRED })
  .min(6, V.PASSWORD_MIN_LENGTH)
  .regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*[^a-zA-Z0-9]).*$/,
    V.PASSWORD_COMPLEXITY,
  );

const PhoneSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s()-]/g, ''))
  .transform((value) => (value === '' ? undefined : value))
  .refine((value) => !value || /^\+?\d{8,15}$/.test(value), V.PHONE_INVALID)
  .transform((value) => {
    if (!value) {
      return undefined;
    }

    return value.startsWith('+') ? value : `+${value}`;
  })
  .optional();

export const RegisterSchema = z.object({
  email: z
    .string({ message: V.EMAIL_REQUIRED })
    .trim()
    .email(V.EMAIL_INVALID),

  phone: PhoneSchema,

  password: PasswordSchema,

  firstName: z.string().min(3, V.FIRST_NAME_MIN_LENGTH).optional(),
  lastName: z.string().min(3, V.LAST_NAME_MIN_LENGTH).optional(),
});

export class RegisterDto extends createZodDto(RegisterSchema) {}
