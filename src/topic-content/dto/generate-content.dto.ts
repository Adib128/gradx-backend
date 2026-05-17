import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const GenerateContentSchema = z.object({
  type: z.enum(['LECTURE', 'SLIDES', 'QUIZ', 'LAB']),
});

export class GenerateContentDto extends createZodDto(GenerateContentSchema) {}
