import type { GenerationPlanRole } from './generation-plan.roles';

/** Default lecture length used when storing plan.estimatedTokens. */
export const STUDIO_REFERENCE_SLIDES = 16;

export type GenerationTier = 'LOW' | 'MEDIUM' | 'HIGH';

export type PlanModelSpec = {
  role: GenerationPlanRole;
  model: string;
  fallbackModels: string[];
  maxTokens: number;
  reasoningTokens: number;
};

export type GenerationPlanPreset = {
  code: GenerationTier;
  nameEn: string;
  nameAr: string;
  descriptionEn: string;
  descriptionAr: string;
  qualityLabelEn: string;
  qualityLabelAr: string;
  /** Typical USD for a 16-slide lecture (OpenRouter list prices). */
  costUsdMin: number;
  costUsdMax: number;
  models: PlanModelSpec[];
};

const ROLES: GenerationPlanRole[] = [
  'analyst',
  'planner',
  'designer',
  'outliner',
  'writer',
  'illustrator',
  'inspector',
  'optimizer',
  'reviewer',
  'default',
];

function stack(
  primary: string,
  fallback: string,
  tokens: Record<GenerationPlanRole, { max: number; reasoning: number }>,
): PlanModelSpec[] {
  return ROLES.map((role) => ({
    role,
    model: primary,
    fallbackModels: [fallback],
    maxTokens: tokens[role].max,
    reasoningTokens: tokens[role].reasoning,
  }));
}

const LOW_TOKENS: Record<GenerationPlanRole, { max: number; reasoning: number }> = {
  analyst: { max: 1200, reasoning: 0 },
  planner: { max: 2800, reasoning: 0 },
  designer: { max: 700, reasoning: 0 },
  outliner: { max: 4000, reasoning: 0 },
  writer: { max: 5500, reasoning: 0 },
  illustrator: { max: 2200, reasoning: 0 },
  inspector: { max: 2200, reasoning: 0 },
  optimizer: { max: 5500, reasoning: 0 },
  reviewer: { max: 1400, reasoning: 0 },
  default: { max: 4000, reasoning: 0 },
};

const MEDIUM_TOKENS: Record<GenerationPlanRole, { max: number; reasoning: number }> = {
  analyst: { max: 1500, reasoning: 0 },
  planner: { max: 4000, reasoning: 2000 },
  designer: { max: 800, reasoning: 0 },
  outliner: { max: 6000, reasoning: 1500 },
  writer: { max: 8000, reasoning: 0 },
  illustrator: { max: 3000, reasoning: 0 },
  inspector: { max: 3500, reasoning: 2000 },
  optimizer: { max: 8000, reasoning: 0 },
  reviewer: { max: 2000, reasoning: 0 },
  default: { max: 6000, reasoning: 0 },
};

const HIGH_TOKENS: Record<GenerationPlanRole, { max: number; reasoning: number }> = {
  analyst: { max: 2000, reasoning: 0 },
  planner: { max: 5000, reasoning: 4000 },
  designer: { max: 1200, reasoning: 0 },
  outliner: { max: 7000, reasoning: 3000 },
  writer: { max: 10000, reasoning: 1500 },
  illustrator: { max: 4000, reasoning: 800 },
  inspector: { max: 4500, reasoning: 4000 },
  optimizer: { max: 10000, reasoning: 1500 },
  reviewer: { max: 2500, reasoning: 1500 },
  default: { max: 8000, reasoning: 1500 },
};

/**
 * Instructor-facing quality tiers. Primary / fallback match the published
 * Low / Medium / High model pairs.
 */
export const GENERATION_PLAN_PRESETS: Record<GenerationTier, GenerationPlanPreset> = {
  LOW: {
    code: 'LOW',
    nameEn: 'Low',
    nameAr: 'منخفض',
    descriptionEn:
      'Fast draft decks with DeepSeek V3 (GPT-4o mini fallback). Best for a first pass.',
    descriptionAr: 'مسودات سريعة بنموذج DeepSeek V3 (الاحتياطي GPT-4o mini). مناسبة للمرور الأول.',
    qualityLabelEn: 'Draft quality',
    qualityLabelAr: 'جودة مسودة',
    costUsdMin: 0.02,
    costUsdMax: 0.05,
    models: stack('deepseek/deepseek-chat', 'openai/gpt-4o-mini', LOW_TOKENS),
  },
  MEDIUM: {
    code: 'MEDIUM',
    nameEn: 'Medium',
    nameAr: 'متوسط',
    descriptionEn:
      'Everyday teaching decks with Claude 3.5 Haiku (GPT-4o fallback). Balanced quality and cost.',
    descriptionAr: 'شرائح تدريس يومية بـ Claude 3.5 Haiku (الاحتياطي GPT-4o). توازن بين الجودة والتكلفة.',
    qualityLabelEn: 'Balanced quality',
    qualityLabelAr: 'جودة متوازنة',
    costUsdMin: 0.15,
    costUsdMax: 0.4,
    models: stack('anthropic/claude-3.5-haiku', 'openai/gpt-4o', MEDIUM_TOKENS),
  },
  HIGH: {
    code: 'HIGH',
    nameEn: 'High',
    nameAr: 'عالي',
    descriptionEn:
      'Publication-ready lectures with Claude 4.5 Sonnet (Claude 3.5 Sonnet fallback). Uses more tokens.',
    descriptionAr:
      'محاضرات جاهزة للنشر بـ Claude 4.5 Sonnet (الاحتياطي Claude 3.5 Sonnet). تستهلك رموزاً أكثر.',
    qualityLabelEn: 'Highest quality',
    qualityLabelAr: 'أعلى جودة',
    costUsdMin: 0.7,
    costUsdMax: 1.5,
    models: stack('anthropic/claude-sonnet-4.5', 'anthropic/claude-3.5-sonnet', HIGH_TOKENS),
  },
};

/**
 * Token budget for one Slide Studio run after the lecture-arc work
 * (CLO bands, Think about it, summary → check → references, writer recipes).
 *
 * Fixed agents: analyst, planner, designer, outliner, illustrator.
 * Writer scales with slide count (one NDJSON call per plan section).
 * QA: inspector passes + optimizer rewrites + reviewer.
 */
const TIER_BUDGET: Record<
  GenerationTier,
  {
    fixed: number;
    qaFixed: number;
    writerPerSlide: number;
    optimizerPerSlide: number;
  }
> = {
  LOW: { fixed: 28_000, qaFixed: 14_000, writerPerSlide: 4_200, optimizerPerSlide: 900 },
  MEDIUM: { fixed: 38_000, qaFixed: 28_000, writerPerSlide: 5_200, optimizerPerSlide: 2_400 },
  HIGH: { fixed: 42_000, qaFixed: 38_000, writerPerSlide: 5_200, optimizerPerSlide: 2_800 },
};

export function parseGenerationTier(code: string | null | undefined): GenerationTier | null {
  const key = String(code ?? '').trim().toUpperCase();
  return key === 'LOW' || key === 'MEDIUM' || key === 'HIGH' ? key : null;
}

export function estimateStudioTokens(
  tier: string | null | undefined,
  slideCount = STUDIO_REFERENCE_SLIDES,
): number {
  const key = parseGenerationTier(tier);
  if (!key) return 0;
  const cfg = TIER_BUDGET[key];
  const slides = Math.min(40, Math.max(4, Math.round(slideCount) || STUDIO_REFERENCE_SLIDES));
  const total = cfg.fixed + cfg.qaFixed + slides * (cfg.writerPerSlide + cfg.optimizerPerSlide);
  return Math.max(1_000, Math.round(total / 1_000) * 1_000);
}

export function estimateStudioCostUsd(
  tier: string | null | undefined,
  slideCount = STUDIO_REFERENCE_SLIDES,
): { min: number; max: number } | null {
  const key = parseGenerationTier(tier);
  if (!key) return null;
  const preset = GENERATION_PLAN_PRESETS[key];
  const tokens = estimateStudioTokens(key, slideCount);
  const baseline = estimateStudioTokens(key, STUDIO_REFERENCE_SLIDES);
  const scale = baseline ? tokens / baseline : 1;
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    min: round(preset.costUsdMin * scale),
    max: round(preset.costUsdMax * scale),
  };
}

export function referenceTokenBudget(tier: GenerationTier): number {
  return estimateStudioTokens(tier, STUDIO_REFERENCE_SLIDES);
}
