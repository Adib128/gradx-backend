import z from 'zod';
import { createZodDto } from 'nestjs-zod';
import { AssessmentSchema } from '../schema/assessment.schema';
import { ACTIVE_GENERATION_QUESTION_TYPES } from '../config/question-types.config';

const QuestionTypeConfigSchema = z.object({
  questionType: z.enum(ACTIVE_GENERATION_QUESTION_TYPES),
  questionTypeNumber: z.number().int().positive(),
});

export const ASSESSMENT_QUESTION_SOURCES = [
  'SLIDES',
  'REFERENCE',
  'COURSE_SPECIFICATION',
] as const;

const ReferenceChapterSelectionSchema = z.object({
  referenceIndex: z.number().int().nonnegative(),
  chapterIndices: z.array(z.number().int().nonnegative()).max(200),
});

const TopicSourceSchema = z.object({
  type: z.enum(ASSESSMENT_QUESTION_SOURCES),
  /** REFERENCE only: chapters to ground questions in, per Course.references index. */
  references: z.array(ReferenceChapterSelectionSchema).max(50).default([]),
});

const TopicGenerationSchema = z.object({
  topicId: z.number(),
  cloIds: z.array(z.number()).default([]),
  cloCodes: z.array(z.string()).default([]),
  questionTypes: z.array(QuestionTypeConfigSchema),
  source: TopicSourceSchema.default({
    type: 'COURSE_SPECIFICATION',
    references: [],
  }),
});

export const GenerateAssessmentSchema = z.object({
  assessment: AssessmentSchema,
  /** CLOs the teacher picked first; topics are chosen among those mapped to them. */
  selectedCloIds: z.array(z.number().int().positive()).default([]),
  topicGenerations: z.array(TopicGenerationSchema),
  /** When true, keep existing questions and append newly generated ones. */
  append: z.boolean().optional().default(false),
});

export type TopicSource = z.infer<typeof TopicSourceSchema>;
export type ReferenceChapterSelection = z.infer<
  typeof ReferenceChapterSelectionSchema
>;

export class GenerateAssessmentDto extends createZodDto(
  GenerateAssessmentSchema,
) {}
