import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const PasswordSchema = z
  .string({ message: 'Password is required' })
  .min(6, 'Password must be at least 6 characters')
  .regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*[^a-zA-Z0-9]).*$/,
    'Password must contain uppercase, lowercase, number, and special character',
  );

const PhoneSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s()-]/g, ''))
  .transform((value) => (value === '' ? undefined : value))
  .refine(
    (value) => !value || /^\+?\d{8,15}$/.test(value),
    'Invalid phone number format',
  )
  .transform((value) => {
    if (!value) {
      return undefined;
    }

    return value.startsWith('+') ? value : `+${value}`;
  })
  .optional();

export const RegisterSchema = z.object({
  email: z
    .string({ message: 'Email is required' }) // Use 'message' instead of 'required_error'
    .trim()
    .email('Invalid email address'),

  phone: PhoneSchema,

  password: PasswordSchema,

  firstName: z.string().min(3).optional(),
  lastName: z.string().min(3).optional(),
});

export class RegisterDto extends createZodDto(RegisterSchema) {}
