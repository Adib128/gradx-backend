// src/course/dto/create-course.dto.ts
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const ReferenceSchema = z.object({
  type: z.enum(['ESSENTIAL', 'SUPPORTIVE', 'ELECTRONIC', 'OTHER']),
  title: z.string().min(1),
  authors: z.string().nullable().optional(),
  publisher: z.string().nullable().optional(),
});

const AssessmentSchema = z.object({
  title: z.string().min(1),
  timing: z.string().nullable().optional(),
  percentage: z.number().int().min(0).max(100),
});

const CLOSchema = z.object({
  code: z.string().min(1),
  category: z.enum(['KNOWLEDGE', 'SKILLS', 'VALUES']),
  programCLOCode: z.string().nullable().optional(),
  description: z.string().min(1),
  teachingStrategies: z.array(z.string()).default([]),
  assessmentMethods: z.array(z.string()).default([]),
});

const TopicSchema = z.object({
  topicNumber: z.number().int().positive(),
  title: z.string().min(1),
  contactHours: z.number().int().positive().default(3),
});

export const CreateCourseSchema = z.object({
  // basic info
  title: z.string().min(1, 'Title is required'),
  code: z.string().nullable().optional(),
  program: z.string().nullable().optional(),
  description: z.string().nullable().optional(),

  // hours & mode
  creditHours: z.number().int().positive().nullable().optional(),
  level: z.string().nullable().optional(),
  teachingMode: z
    .enum(['TRADITIONAL', 'ONLINE', 'HYBRID', 'LAB'])
    .default('TRADITIONAL'),
  totalContactHours: z.number().int().positive().nullable().optional(),
  lectureHours: z.number().int().positive().nullable().optional(),
  labHours: z.number().int().positive().nullable().optional(),

  // arrays
  prerequisites: z.array(z.string()).default([]),
  references: z.array(ReferenceSchema).default([]),
  assessments: z.array(AssessmentSchema).default([]),

  // relations
  clos: z.array(CLOSchema).default([]),
  topics: z.array(TopicSchema).default([]),
});

export class CreateCourseDto extends createZodDto(CreateCourseSchema) {}
