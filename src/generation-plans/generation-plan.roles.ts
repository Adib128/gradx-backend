/** Slide Studio agent roles that can be assigned a model in a generation plan. */
export const GENERATION_PLAN_ROLES = [
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
] as const;

export type GenerationPlanRole = (typeof GENERATION_PLAN_ROLES)[number];

export type PlanModelOverride = {
  model: string;
  fallbackModels: string[];
  maxTokens: number | null;
  reasoningTokens: number | null;
};

export type PlanModelsMap = Partial<Record<GenerationPlanRole, PlanModelOverride>>;
