import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export const createClassSchema = z.object({
  name: z.string(),
  departementId: z.number(),
});

export class CreateClassDto extends createZodDto(createClassSchema) {}
