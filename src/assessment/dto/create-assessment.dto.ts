import { createZodDto } from 'nestjs-zod';
import { AssessmentSchema } from '../schema/assessment.schema';

export class CreateAssessmentDto extends createZodDto(AssessmentSchema) {}
