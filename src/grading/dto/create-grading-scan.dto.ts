import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const CreateGradingScanSchema = z.object({
  assessmentVersionId: z.coerce.number().int().positive().optional(),
});

export class CreateGradingScanDto extends createZodDto(
  CreateGradingScanSchema,
) {}
