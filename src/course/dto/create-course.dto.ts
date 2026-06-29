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

const emptyStringToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const normalizeStringList = (value: unknown) => {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? '').trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
};

const zeroOrEmptyToNull = (value: unknown) => {
  if (value === null || value === undefined || value === '') return null;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return null;
  return numberValue;
};

const nullableNumber = (value: unknown) => {
  if (value === null || value === undefined || value === '') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
};

const nullablePositiveInt = z.preprocess(
  zeroOrEmptyToNull,
  z.number().int().positive().nullable().optional(),
);

const TeachingModeRowSchema = z.object({
  modeOfInstruction: z.string().default(''),
  contactHours: z.preprocess(nullableNumber, z.number().int().nullable()),
  percentage: z.preprocess(nullableNumber, z.number().nullable()),
});

const RequiredFacilitiesAndEquipmentRowSchema = z.object({
  item: z.string().default(''),
  resources: z.string().nullable().optional().default(''),
});

export const CreateCourseSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  code: z.string().nullable().optional(),
  program: z.string().nullable().optional(),
  description: z.string().nullable().optional(),

  creditHours: nullablePositiveInt,
  level: z.string().nullable().optional(),
  // Backwards compatible single teachingMode (optional).
  teachingMode: z.preprocess(
    emptyStringToUndefined,
    z.enum(['TRADITIONAL', 'ONLINE', 'HYBRID', 'LAB'], {
      message: 'Teaching mode is invalid',
    }).optional(),
  ),

  // New teachingModes table extracted from the document (array of rows).
  teachingModes: z
    .preprocess(
      (value) => (Array.isArray(value) ? value : []),
      z.array(TeachingModeRowSchema),
    )
    .transform((rows) =>
      rows.filter(
        (row) =>
          row.modeOfInstruction.trim() ||
          row.contactHours !== null ||
          row.percentage !== null,
      ),
    )
    .default([]),
  totalContactHours: nullablePositiveInt,
  lectureHours: nullablePositiveInt,
  labHours: nullablePositiveInt,

  prerequisites: z.preprocess(normalizeStringList, z.array(z.string()).default([])),
  coRequisites: z.preprocess(normalizeStringList, z.array(z.string()).default([])),
  requiredFacilitiesAndEquipment: z
    .preprocess(
      (value) => (Array.isArray(value) ? value : []),
      z.array(RequiredFacilitiesAndEquipmentRowSchema),
    )
    .transform((rows) =>
      rows.filter((row) => row.item.trim() || String(row.resources ?? '').trim()),
    )
    .default([]),
  references: z.array(ReferenceSchema).default([]),

  clos: z.array(CloSchema).default([]),
  topics: z.array(TopicSchema).default([]),
  assessments: z.array(CourseAssessmentSchema).default([]),
});

export class CreateCourseDto extends createZodDto(CreateCourseSchema) {}
