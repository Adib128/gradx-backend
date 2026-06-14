import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { QuestionSchema } from '../schema/question.schema';
import { AssessmentSchema } from '../schema/assessment.schema';
import {
  AssessmentAnswerSheetMode,
  AssessmentPaperSize,
  AssessmentStudentIdLabel,
  AssessmentType,
  DifficultyDistribution,
  Language,
} from 'generated/prisma/enums';
import { prismaEnumToZod } from 'src/common/helpers/zod.enum.helper';

export const CreateAssessmentSchema = AssessmentSchema.extend({
  topicIds: z.array(z.number()).min(1, 'At least one topic'),
  cloIds: z.array(z.number()).min(1, 'At least one clo'),
  questions: z.array(QuestionSchema).default([]),
});

export const UpdateAssessmentSchema = z.object({
  title: z.string().min(1, 'Title is required').optional(),
  type: prismaEnumToZod(AssessmentType).optional(),
  duration: z.number().int().positive().nullable().optional(),
  totalMarks: z.number().int().positive().nullable().optional(),
  passMark: z.number().int().positive().nullable().optional(),
  numberOfVersions: z.number().int().positive().optional(),
  paperSize: prismaEnumToZod(AssessmentPaperSize).optional(),
  answerSheetMode: prismaEnumToZod(AssessmentAnswerSheetMode).optional(),
  showMarksPerQuestion: z.boolean().optional(),
  includeStudentInfoHeader: z.boolean().optional(),
  studentIdLabel: prismaEnumToZod(AssessmentStudentIdLabel).optional(),
  numberOfStudentIdDigits: z.number().int().min(3).max(6).optional(),
  includeAssessmentInstructionsSection: z.boolean().optional(),
  assessmentInstructions: z.string().nullable().optional(),
  printCloCodeNextToEachQuestion: z.boolean().optional(),
  printBloomLevelNextToEachQuestion: z.boolean().optional(),
  printDifficultyLabelNextToEachQuestion: z.boolean().optional(),
  language: prismaEnumToZod(Language).nullable().optional(),
  difficulty: prismaEnumToZod(DifficultyDistribution).optional(),
  topicIds: z.array(z.number()).optional(),
  cloIds: z.array(z.number()).optional(),
  questions: z.array(QuestionSchema).optional(),
});

export class UpdateAssessmentDto extends createZodDto(UpdateAssessmentSchema) {}
