import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(6, 'Current password is required'),
    newPassword: z
      .string()
      .min(6, 'New password must be at least 8 characters'),
    confirmNewPassword: z.string().min(1, 'Please confirm your new password'),
  })
  .refine((data) => data.newPassword === data.confirmNewPassword, {
    message: 'Password is must match',
    path: ['confirmNewPassword'],
  });

export class ChangePasswordDto extends createZodDto(changePasswordSchema) {}
