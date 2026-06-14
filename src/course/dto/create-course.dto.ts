import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { TopicSchema } from '../schemas/topic.schema';
import { ReferenceSchema } from '../schemas/reference.schema';
import { AssessmentSchema } from 'src/assessment/schema/assessment.schema';
import { CloSchema } from 'src/clo/schemas/clo.schema';

const normalizeCourseAssessment = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const assessment = { ...(value as Record<string, unknown>) };
  const title = String(assessment.title ?? '').toLowerCase();
  const rawType = String(assessment.type ?? '').trim().toUpperCase();

  if (rawType === 'EXAM') {
    assessment.type = title.includes('mid') ? 'MID_TERM_EXAM' : 'FINAL_EXAM';
  } else if (rawType === 'MIDTERM' || rawType === 'MID_TERM') {
    assessment.type = 'MID_TERM_EXAM';
  } else if (rawType === 'FINAL') {
    assessment.type = 'FINAL_EXAM';
  }

  if (!assessment.difficulty || String(assessment.difficulty).trim() === '') {
    assessment.difficulty = 'BALANCED';
  } else {
    const rawDifficulty = String(assessment.difficulty).trim().toUpperCase();
    const difficultyAliases: Record<string, string> = {
      MEDIUM: 'BALANCED',
      MODERATE: 'BALANCED',
      NORMAL: 'BALANCED',
      HARD: 'ADVANCED',
      DIFFICULT: 'ADVANCED',
    };

    assessment.difficulty = difficultyAliases[rawDifficulty] ?? rawDifficulty;
  }

  if (!assessment.totalMarks && typeof assessment.percentage === 'number') {
    assessment.totalMarks = assessment.percentage;
  }

  return assessment;
};

const CourseAssessmentSchema = z.preprocess(
  normalizeCourseAssessment,
  AssessmentSchema,
);

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
  assessments: z.array(CourseAssessmentSchema).default([]),
});

export class CreateCourseDto extends createZodDto(CreateCourseSchema) {}
