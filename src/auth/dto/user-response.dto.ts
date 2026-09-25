import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const UserResponseSchema = z.object({
  id: z.number(),
  email: z.string().email(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  phone: z.string().nullable(),
  tenantId: z.number(),
  role: z.enum(['USER', 'ADMIN', 'SUPER_ADMIN']),
  isActive: z.boolean().optional(),
  lastLogin: z.coerce.date().nullable().optional(),
});

export class UserResponseDto extends createZodDto(UserResponseSchema) {}
