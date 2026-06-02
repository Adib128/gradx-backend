import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { QuestionSchema } from '../schema/question.schema';
import { AssessmentSchema } from '../schema/assessment.schema';

export const CreateAssessmentSchema = AssessmentSchema.extend({
  topicIds: z.array(z.number()).min(1, 'At least one topic'),
  cloIds: z.array(z.number()).min(1, 'At least one clo'),
  questions: z.array(QuestionSchema).default([]),
});

export class UpdateAssessmentDto extends createZodDto(CreateAssessmentSchema) {}
