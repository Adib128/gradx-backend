import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ContentGenerationJob } from '../interfaces/content-generation-job.interface';

/**
 * Structural type constraint helper.
 * Maps every key of ContentGenerationJob to a valid Zod schema.
 */
type ZodFieldsFromInterface<T> = {
  [K in keyof T]: z.ZodType<T[K]>;
};

const GenerateContentFields: ZodFieldsFromInterface<ContentGenerationJob> = {
  // Numbers
  tenantId: z.number().int().positive(),
  topicId: z.number().int().positive(),
  contentId: z.number().int().positive(),
  topicNumber: z.number(),

  // Explicit Endpoint validation options
  type: z.enum(['LECTURE', 'SLIDES', 'QUIZ', 'LAB']),

  // Base details
  topicTitle: z.string().min(1),
  courseId: z.number().int().positive(),
  courseTitle: z.string().min(1),
  courseDescription: z.string(),

  // Relational structures
  clos: z.array(z.any()),
  references: z.array(z.any()),
  sourceLectureContentId: z.number().int().positive().optional() as z.ZodType<
    ContentGenerationJob['sourceLectureContentId']
  >,
  sourceLectureContent: z.unknown().optional() as z.ZodType<
    ContentGenerationJob['sourceLectureContent']
  >,

  // Dropdowns - Casted from z.string() to bypass json-schema-processor limitations
  courseNoteType: z.string() as unknown as z.ZodType<
    ContentGenerationJob['courseNoteType']
  >,
  contentDepth: z.string() as unknown as z.ZodType<
    ContentGenerationJob['contentDepth']
  >,
  audience: z.string() as unknown as z.ZodType<
    ContentGenerationJob['audience']
  >,
  length: z.string() as unknown as z.ZodType<ContentGenerationJob['length']>,
  slidesLength: z.string().optional() as unknown as z.ZodType<
    ContentGenerationJob['slidesLength']
  >,
  difficulty: z.string() as unknown as z.ZodType<
    ContentGenerationJob['difficulty']
  >,
  aiQualityMode: z.string() as unknown as z.ZodType<
    ContentGenerationJob['aiQualityMode']
  >,

  // List arrays and matrix settings
  targetedCloIds: z.array(z.string()),
  bloomsTaxonomyLevels: z.array(z.any()),
  learningComponents: z.array(z.any()),
  exampleLevels: z.array(z.any()),
  visuals: z.array(z.any()),
  assessmentIntegrations: z.array(z.any()),
  humanReviewChecks: z.array(z.any()),
  contentLanguage: z.enum(['ar', 'en']).optional() as unknown as z.ZodType<
    ContentGenerationJob['contentLanguage']
  >,
};

export const GenerateContentSchema = z.object(GenerateContentFields);

/**
 * NestJS validation DTO derived strictly from the runtime fields blueprint.
 * Safe from runtime JSON Schema compilation exceptions.
 */
export class GenerateContentDto
  extends createZodDto(GenerateContentSchema) {}
