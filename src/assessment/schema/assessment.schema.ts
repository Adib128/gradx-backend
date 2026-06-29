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

export const AssessmentSchema = z.object({
  title: z.string().min(1, 'Assessment title is required'),
  type: prismaEnumToZod(AssessmentType),
  duration: z.number().int().positive().nullable().optional(),
  totalMarks: z.number().int().positive().nullable().optional(),
  passMark: z.number().int().positive().nullable().optional(),
  numberOfVersions: z.number().int().positive().default(2),
  paperSize: prismaEnumToZod(AssessmentPaperSize).default('A4'),
  answerSheetMode: prismaEnumToZod(AssessmentAnswerSheetMode).default(
    'APPEND_SAME_PDF',
  ),
  showMarksPerQuestion: z.boolean().default(false),
  includeStudentInfoHeader: z.boolean().default(false),
  studentIdLabel: prismaEnumToZod(AssessmentStudentIdLabel).default(
    'STUDENT_ID',
  ),
  numberOfStudentIdDigits: z.number().int().min(3).max(12).default(3),
  includeAssessmentInstructionsSection: z.boolean().default(false),
  assessmentInstructions: z.string().nullable().optional(),
  printCloCodeNextToEachQuestion: z.boolean().default(false),
  printBloomLevelNextToEachQuestion: z.boolean().default(false),
  printDifficultyLabelNextToEachQuestion: z.boolean().default(false),
  language: prismaEnumToZod(Language).nullable().optional(),
  difficulty: prismaEnumToZod(DifficultyDistribution),
});
