import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { QuestionSchema } from '../schema/question.schema';
import { AssessmentObjectSchema } from '../schema/assessment.schema';
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

export const CreateAssessmentSchema = AssessmentObjectSchema.extend({
  topicIds: z.array(z.number()).min(1, V.INVALID_ENUM_VALUE),
  cloIds: z.array(z.number()).min(1, V.INVALID_ENUM_VALUE),
  questions: z.array(QuestionSchema).default([]),
});

export const UpdateAssessmentSchema = z.object({
  title: z.string().min(1, V.ASSESSMENT_TITLE_REQUIRED).optional(),
  type: prismaEnumToZod(AssessmentType, V.ASSESSMENT_TYPE_INVALID).optional(),
  timing: z.string().nullable().optional(),
  percentage: z
    .number({ message: V.ASSESSMENT_TOTAL_MARKS_INVALID })
    .int()
    .nonnegative(V.ASSESSMENT_TOTAL_MARKS_INVALID)
    .nullable()
    .optional(),
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
    .optional(),
  paperSize: prismaEnumToZod(AssessmentPaperSize, V.INVALID_ENUM_VALUE).optional(),
  answerSheetMode: prismaEnumToZod(
    AssessmentAnswerSheetMode,
    V.INVALID_ENUM_VALUE,
  ).optional(),
  showMarksPerQuestion: z.boolean().optional(),
  includeStudentInfoHeader: z.boolean().optional(),
  studentIdLabel: prismaEnumToZod(
    AssessmentStudentIdLabel,
    V.INVALID_ENUM_VALUE,
  ).optional(),
  numberOfStudentIdDigits: z
    .number({ message: V.ASSESSMENT_STUDENT_ID_DIGITS_INVALID })
    .int()
    .min(3, V.ASSESSMENT_STUDENT_ID_DIGITS_INVALID)
    .max(12, V.ASSESSMENT_STUDENT_ID_DIGITS_INVALID)
    .optional(),
  includeAssessmentInstructionsSection: z.boolean().optional(),
  assessmentInstructions: z.string().nullable().optional(),
  printCloCodeNextToEachQuestion: z.boolean().optional(),
  printBloomLevelNextToEachQuestion: z.boolean().optional(),
  printDifficultyLabelNextToEachQuestion: z.boolean().optional(),
  headerConfig: z.unknown().nullable().optional(),
  language: prismaEnumToZod(Language, V.ASSESSMENT_LANGUAGE_INVALID)
    .nullable()
    .optional(),
  difficulty: prismaEnumToZod(
    DifficultyDistribution,
    V.ASSESSMENT_DIFFICULTY_INVALID,
  ).optional(),
  topicIds: z.array(z.number()).optional(),
  cloIds: z.array(z.number()).optional(),
  questions: z.array(QuestionSchema).optional(),
});

export class UpdateAssessmentDto extends createZodDto(UpdateAssessmentSchema) {}
