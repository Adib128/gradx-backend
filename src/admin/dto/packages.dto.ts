import { createZodDto } from 'nestjs-zod';
import z from 'zod';

// Update schemas are `.partial()` of the base shapes, which carry no defaults:
// zod 4 applies defaults even inside optional fields, so a PATCH would reset them.

const code = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .transform((value) => value.toUpperCase().replace(/[^A-Z0-9]+/g, '_'));
const name = z.string().trim().min(1).max(120);
const optionalText = z.string().trim().max(2000).nullable().optional();
const money = z.coerce.number().min(0).max(99_999_999);

const packageFeatureValueSchema = z.object({
  featureId: z.number().int().positive(),
  enabled: z.boolean(),
  /** LIMIT features: null = unlimited */
  limitValue: z.number().int().min(0).nullable().optional(),
});

const packagePriceSchema = z.object({
  periodId: z.number().int().positive(),
  price: money,
  compareAtPrice: money.nullable().optional(),
  isActive: z.boolean(),
});

const packageShape = z.object({
  code,
  nameEn: name,
  nameAr: name,
  descriptionEn: optionalText,
  descriptionAr: optionalText,
  currency: z.string().trim().min(1).max(10),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  features: z.array(packageFeatureValueSchema),
  prices: z.array(packagePriceSchema),
});

export const createPackageSchema = packageShape.extend({
  currency: packageShape.shape.currency.default('SAR'),
  isActive: packageShape.shape.isActive.default(true),
  sortOrder: packageShape.shape.sortOrder.default(0),
  features: packageShape.shape.features.default([]),
  prices: packageShape.shape.prices.default([]),
});
export class CreatePackageDto extends createZodDto(createPackageSchema) {}

export const updatePackageSchema = packageShape.partial();
export class UpdatePackageDto extends createZodDto(updatePackageSchema) {}

const billingPeriodShape = z.object({
  code,
  nameEn: name,
  nameAr: name,
  durationMonths: z.number().int().min(1).max(120),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
});

export const createBillingPeriodSchema = billingPeriodShape.extend({
  isActive: billingPeriodShape.shape.isActive.default(true),
  sortOrder: billingPeriodShape.shape.sortOrder.default(0),
});
export class CreateBillingPeriodDto extends createZodDto(createBillingPeriodSchema) {}

export const updateBillingPeriodSchema = billingPeriodShape.partial();
export class UpdateBillingPeriodDto extends createZodDto(updateBillingPeriodSchema) {}

const planFeatureShape = z.object({
  key: code,
  nameEn: name,
  nameAr: name,
  type: z.enum(['LIMIT', 'BOOLEAN']),
  unitEn: z.string().trim().max(40).nullable().optional(),
  unitAr: z.string().trim().max(40).nullable().optional(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
});

export const createPlanFeatureSchema = planFeatureShape.extend({
  type: planFeatureShape.shape.type.default('LIMIT'),
  isActive: planFeatureShape.shape.isActive.default(true),
  sortOrder: planFeatureShape.shape.sortOrder.default(0),
});
export class CreatePlanFeatureDto extends createZodDto(createPlanFeatureSchema) {}

export const updatePlanFeatureSchema = planFeatureShape.partial();
export class UpdatePlanFeatureDto extends createZodDto(updatePlanFeatureSchema) {}
