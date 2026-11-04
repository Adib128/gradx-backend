import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { GENERATION_PLAN_ROLES } from '../generation-plan.roles';

const code = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .transform((value) => value.toUpperCase().replace(/[^A-Z0-9]+/g, '_'));
const name = z.string().trim().min(1).max(120);
const optionalText = z.string().trim().max(2000).nullable().optional();
const qualityLabel = z.string().trim().min(1).max(120);
const modelId = z.string().trim().min(1).max(120);

const planModelShape = z.object({
  role: z.enum(GENERATION_PLAN_ROLES),
  model: modelId,
  fallbackModels: z.array(modelId).max(10).default([]),
  maxTokens: z.number().int().min(1).max(200_000).nullable().optional(),
  reasoningTokens: z.number().int().min(0).max(100_000).nullable().optional(),
});

const planShape = z.object({
  code,
  nameEn: name,
  nameAr: name,
  descriptionEn: optionalText,
  descriptionAr: optionalText,
  qualityLabelEn: qualityLabel,
  qualityLabelAr: qualityLabel,
  estimatedTokens: z.number().int().min(0).max(10_000_000),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  models: z.array(planModelShape),
});

export const createGenerationPlanSchema = planShape.extend({
  estimatedTokens: planShape.shape.estimatedTokens.default(0),
  isActive: planShape.shape.isActive.default(true),
  sortOrder: planShape.shape.sortOrder.default(0),
  models: planShape.shape.models.default([]),
});
export class CreateGenerationPlanDto extends createZodDto(createGenerationPlanSchema) {}

export const updateGenerationPlanSchema = planShape.partial();
export class UpdateGenerationPlanDto extends createZodDto(updateGenerationPlanSchema) {}

export const upsertGenerationPlanModelSchema = planModelShape;
export class UpsertGenerationPlanModelDto extends createZodDto(upsertGenerationPlanModelSchema) {}

export const updateGenerationPlanModelSchema = planModelShape.omit({ role: true }).partial();
export class UpdateGenerationPlanModelDto extends createZodDto(updateGenerationPlanModelSchema) {}
