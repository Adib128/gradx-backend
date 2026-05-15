import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const RegisterSchema = z.object({
  email: z
    .string({ message: 'Email is required' }) // Use 'message' instead of 'required_error'
    .trim()
    .email('Invalid email address'),

  phone: z
    .string()
    .trim()
    .pipe(z.string().regex(/^\+\d{12}$/, 'Invalid phone number format')),

  password: z
    .string({ message: 'Password is required' })
    .min(6, 'Password must be at least 6 characters')
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*[^a-zA-Z0-9]).*$/,
      'Password must contain uppercase, lowercase, number, and special character',
    ),

  firstName: z.string().min(3).optional(),
  lastName: z.string().min(3).optional(),
});

export class RegisterDto extends createZodDto(RegisterSchema) {}
