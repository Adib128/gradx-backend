import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export const createDepartementSchema = z.object({
  name: z.string(),
});

export class CreateDepartementDto extends createZodDto(
  createDepartementSchema,
) {}
