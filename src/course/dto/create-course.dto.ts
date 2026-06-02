import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { TopicSchema } from '../schemas/topic.schema';
import { ReferenceSchema } from '../schemas/reference.schema';
import { AssessmentSchema } from 'src/assessment/schema/assessment.schema';
import { CloSchema } from 'src/clo/schemas/clo.schema';

export const CreateCourseSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  code: z.string().nullable().optional(),
  program: z.string().nullable().optional(),
  description: z.string().nullable().optional(),

  creditHours: z.number().int().positive().nullable().optional(),
  level: z.string().nullable().optional(),
  teachingMode: z
    .enum(['TRADITIONAL', 'ONLINE', 'HYBRID', 'LAB'])
    .default('TRADITIONAL'),
  totalContactHours: z.number().int().positive().nullable().optional(),
  lectureHours: z.number().int().positive().nullable().optional(),
  labHours: z.number().int().positive().nullable().optional(),

  prerequisites: z.array(z.string()).default([]),
  references: z.array(ReferenceSchema).default([]),

  clos: z.array(CloSchema).default([]),
  topics: z.array(TopicSchema).default([]),
  assessments: z.array(AssessmentSchema).default([]),
});

export class CreateCourseDto extends createZodDto(CreateCourseSchema) {}
