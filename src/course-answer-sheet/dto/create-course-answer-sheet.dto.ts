import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  AssessmentPaperSize,
  AssessmentType,
  CourseAnswerSheetAnswerType,
  CourseAnswerSheetQuestionType,
} from 'generated/prisma/enums';
import { prismaEnumToZod } from 'src/common/helpers/zod.enum.helper';

const QuestionSchema = z.object({
  sortOrder: z.number().int().min(0).default(0),
  name: z.string().min(1),
  type: prismaEnumToZod(CourseAnswerSheetQuestionType).default(
    'MULTIPLE_CHOICE',
  ),
  labels: z.string().default('ABCD'),
});

const VersionAnswerSchema = z.object({
  sortOrder: z.number().int().min(0).default(0),
  questionNumber: z.number().int().positive(),
  answers: z.array(z.string()).default([]),
  type: prismaEnumToZod(CourseAnswerSheetAnswerType).default('MSQ'),
  cloCode: z.string().nullable().optional(),
  points: z.number().int().positive().default(1),
  questionId: z.number().int().positive().optional(),
});

const VersionSchema = z.object({
  versionNumber: z.number().int().positive(),
  versionName: z.string().min(1),
  answers: z.array(VersionAnswerSchema).default([]),
});

export const CreateCourseAnswerSheetSchema = z.object({
  name: z.string().min(1),
  assessmentType: prismaEnumToZod(AssessmentType).default('FINAL_EXAM'),
  points: z.number().int().positive().default(100),
  showMarksPerQuestion: z.boolean().default(false),
  numberOfQuestions: z.number().int().positive().default(50),
  paperSize: prismaEnumToZod(AssessmentPaperSize).default('A4'),
  sheetsPerPage: z.number().int().positive().default(1),
  includeSection: z.boolean().default(true),
  includeSignature: z.boolean().default(true),
  includeDate: z.boolean().default(true),
  includeStudentInfoHeader: z.boolean().default(true),
  studentInfoLabel: z.string().nullable().optional(),
  numberOfStudentIdDigits: z.number().int().min(1).max(20).default(9),
  includeKeyVersionSection: z.boolean().default(true),
  numberOfKeyVersions: z.number().int().positive().default(3),
  keyVersionLetters: z.string().default('ABCD'),
  keyVersionLabel: z.string().nullable().optional(),
  questions: z.array(QuestionSchema).default([]),
  versions: z.array(VersionSchema).default([]),
});

export class CreateCourseAnswerSheetDto extends createZodDto(
  CreateCourseAnswerSheetSchema,
) {}
