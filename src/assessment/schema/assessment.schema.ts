import z from 'zod';
import {
  AssessmentAnswerSheetMode,
  AssessmentPaperSize,
  AssessmentStudentIdLabel,
  AssessmentType,
  DifficultyDistribution,
  Language,
} from 'generated/prisma/enums';
import { prismaEnumToZod } from 'src/common/helpers/zod.enum.helper';
import { ValidationMessageKey as V } from 'src/common/constants/validation-message';

const nullableNonNegativeInt = z
  .number({ message: V.ASSESSMENT_TOTAL_MARKS_INVALID })
  .int()
  .nonnegative(V.ASSESSMENT_TOTAL_MARKS_INVALID)
  .nullable()
  .optional();

const normalizeAssessmentMeta = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const assessment = { ...(value as Record<string, unknown>) };

  if (
    (assessment.percentage == null || assessment.percentage === '') &&
    assessment.score != null &&
    assessment.score !== ''
  ) {
    assessment.percentage = assessment.score;
  }

  if (typeof assessment.percentage === 'string') {
    const cleaned = assessment.percentage.replace(/%/g, '').trim();
    const parsed = Number(cleaned);
    assessment.percentage = Number.isFinite(parsed) ? parsed : null;
  }

  if (assessment.timing != null) {
    const timing = String(assessment.timing).trim();
    assessment.timing = timing || null;
  }

  if (!assessment.difficulty || String(assessment.difficulty).trim() === '') {
    assessment.difficulty = 'BALANCED';
  }

  return assessment;
};

export const AssessmentObjectSchema = z.object({
  title: z.string().min(1, V.ASSESSMENT_TITLE_REQUIRED),
  type: prismaEnumToZod(AssessmentType, V.ASSESSMENT_TYPE_INVALID),
  timing: z.string().nullable().optional(),
  percentage: nullableNonNegativeInt,
  duration: z
    .number({ message: V.ASSESSMENT_DURATION_INVALID })
    .int()
    .positive(V.ASSESSMENT_DURATION_INVALID)
    .nullable()
    .optional(),
  totalMarks: z
    .number({ message: V.ASSESSMENT_TOTAL_MARKS_INVALID })
    .int()
    .positive(V.ASSESSMENT_TOTAL_MARKS_INVALID)
    .nullable()
    .optional(),
  passMark: z
    .number({ message: V.ASSESSMENT_PASS_MARK_INVALID })
    .int()
    .positive(V.ASSESSMENT_PASS_MARK_INVALID)
    .max(100, V.ASSESSMENT_PASS_MARK_RANGE)
    .nullable()
    .optional(),
  numberOfVersions: z
    .number({ message: V.ASSESSMENT_VERSIONS_INVALID })
    .int()
    .positive(V.ASSESSMENT_VERSIONS_INVALID)
    .default(2),
  paperSize: prismaEnumToZod(AssessmentPaperSize, V.INVALID_ENUM_VALUE).default(
    'A4',
  ),
  answerSheetMode: prismaEnumToZod(
    AssessmentAnswerSheetMode,
    V.INVALID_ENUM_VALUE,
  ).default('APPEND_SAME_PDF'),
  showMarksPerQuestion: z.boolean().default(false),
  includeStudentInfoHeader: z.boolean().default(false),
  studentIdLabel: prismaEnumToZod(
    AssessmentStudentIdLabel,
    V.INVALID_ENUM_VALUE,
  ).default('STUDENT_ID'),
  numberOfStudentIdDigits: z
    .number({ message: V.ASSESSMENT_STUDENT_ID_DIGITS_INVALID })
    .int()
    .min(3, V.ASSESSMENT_STUDENT_ID_DIGITS_INVALID)
    .max(12, V.ASSESSMENT_STUDENT_ID_DIGITS_INVALID)
    .default(3),
  includeAssessmentInstructionsSection: z.boolean().default(false),
  assessmentInstructions: z.string().nullable().optional(),
  printCloCodeNextToEachQuestion: z.boolean().default(false),
  printBloomLevelNextToEachQuestion: z.boolean().default(false),
  printDifficultyLabelNextToEachQuestion: z.boolean().default(false),
  language: prismaEnumToZod(Language, V.ASSESSMENT_LANGUAGE_INVALID)
    .nullable()
    .optional(),
  difficulty: prismaEnumToZod(
    DifficultyDistribution,
    V.ASSESSMENT_DIFFICULTY_INVALID,
  ).default('BALANCED'),
});

export const AssessmentSchema = z.preprocess(
  normalizeAssessmentMeta,
  AssessmentObjectSchema,
);
