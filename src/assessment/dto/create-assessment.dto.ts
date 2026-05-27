import { createZodDto } from 'nestjs-zod';
import { AssessmentSchema } from './assessment.schema';

export class CreateAssessmentDto extends createZodDto(AssessmentSchema) {}
