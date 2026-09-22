import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export const forgotPasswordSchema = z
  .object({
    email: z.string().email().optional(),
    phone: z.string().trim().min(6).optional(),
    language: z.enum(['en', 'ar']).optional(),
  })
  .refine((value) => Boolean(value.email || value.phone), {
    message: 'Email or phone is required',
  });

export class ForgotPasswordDto extends createZodDto(forgotPasswordSchema) {}

export const verifyResetCodeSchema = z
  .object({
    email: z.string().email().optional(),
    phone: z.string().trim().min(6).optional(),
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, 'Code must be 6 digits'),
  })
  .refine((value) => Boolean(value.email || value.phone), {
    message: 'Email or phone is required',
  });

export class VerifyResetCodeDto extends createZodDto(verifyResetCodeSchema) {}

export const resetPasswordSchema = z
  .object({
    email: z.string().email().optional(),
    phone: z.string().trim().min(6).optional(),
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, 'Code must be 6 digits'),
    newPassword: z.string().min(6, 'New password must be at least 6 characters'),
    confirmNewPassword: z.string().min(1, 'Please confirm your new password'),
  })
  .refine((value) => Boolean(value.email || value.phone), {
    message: 'Email or phone is required',
  })
  .refine((value) => value.newPassword === value.confirmNewPassword, {
    message: 'Passwords do not match',
    path: ['confirmNewPassword'],
  });

export class ResetPasswordDto extends createZodDto(resetPasswordSchema) {}
