-- Refresh Low / Medium / High generation plans to the published model pairs
-- and token budgets that match the current Slide Studio lecture arc.

UPDATE "generation_plans"
SET
  "nameEn" = 'High',
  "nameAr" = 'عالي',
  "descriptionEn" = 'Publication-ready lectures with Claude 4.5 Sonnet (Claude 3.5 Sonnet fallback). Uses more tokens.',
  "descriptionAr" = 'محاضرات جاهزة للنشر بـ Claude 4.5 Sonnet (الاحتياطي Claude 3.5 Sonnet). تستهلك رموزاً أكثر.',
  "qualityLabelEn" = 'Highest quality',
  "qualityLabelAr" = 'أعلى جودة',
  "estimatedTokens" = 208000,
  "sortOrder" = 1,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'HIGH';

UPDATE "generation_plans"
SET
  "nameEn" = 'Medium',
  "nameAr" = 'متوسط',
  "descriptionEn" = 'Everyday teaching decks with Claude 3.5 Haiku (GPT-4o fallback). Balanced quality and cost.',
  "descriptionAr" = 'شرائح تدريس يومية بـ Claude 3.5 Haiku (الاحتياطي GPT-4o). توازن بين الجودة والتكلفة.',
  "qualityLabelEn" = 'Balanced quality',
  "qualityLabelAr" = 'جودة متوازنة',
  "estimatedTokens" = 188000,
  "sortOrder" = 2,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'MEDIUM';

UPDATE "generation_plans"
SET
  "nameEn" = 'Low',
  "nameAr" = 'منخفض',
  "descriptionEn" = 'Fast draft decks with DeepSeek V3 (GPT-4o mini fallback). Best for a first pass.',
  "descriptionAr" = 'مسودات سريعة بنموذج DeepSeek V3 (الاحتياطي GPT-4o mini). مناسبة للمرور الأول.',
  "qualityLabelEn" = 'Draft quality',
  "qualityLabelAr" = 'جودة مسودة',
  "estimatedTokens" = 124000,
  "sortOrder" = 3,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'LOW';

DELETE FROM "generation_plan_models"
WHERE "planId" IN (SELECT "id" FROM "generation_plans" WHERE "code" IN ('HIGH', 'MEDIUM', 'LOW'));

-- HIGH: Claude 4.5 Sonnet / Claude 3.5 Sonnet
INSERT INTO "generation_plan_models"
  ("planId", "role", "model", "fallbackModels", "maxTokens", "reasoningTokens", "updatedAt")
SELECT p.id, v.role, v.model, v.fallback::jsonb, v.max_tokens, v.reasoning, CURRENT_TIMESTAMP
FROM "generation_plans" p
CROSS JOIN (VALUES
  ('analyst',     'anthropic/claude-sonnet-4.5', '["anthropic/claude-3.5-sonnet"]', 2000, 0),
  ('planner',     'anthropic/claude-sonnet-4.5', '["anthropic/claude-3.5-sonnet"]', 5000, 4000),
  ('designer',    'anthropic/claude-sonnet-4.5', '["anthropic/claude-3.5-sonnet"]', 1200, 0),
  ('outliner',    'anthropic/claude-sonnet-4.5', '["anthropic/claude-3.5-sonnet"]', 7000, 3000),
  ('writer',      'anthropic/claude-sonnet-4.5', '["anthropic/claude-3.5-sonnet"]', 10000, 1500),
  ('illustrator', 'anthropic/claude-sonnet-4.5', '["anthropic/claude-3.5-sonnet"]', 4000, 800),
  ('inspector',   'anthropic/claude-sonnet-4.5', '["anthropic/claude-3.5-sonnet"]', 4500, 4000),
  ('optimizer',   'anthropic/claude-sonnet-4.5', '["anthropic/claude-3.5-sonnet"]', 10000, 1500),
  ('reviewer',    'anthropic/claude-sonnet-4.5', '["anthropic/claude-3.5-sonnet"]', 2500, 1500),
  ('default',     'anthropic/claude-sonnet-4.5', '["anthropic/claude-3.5-sonnet"]', 8000, 1500)
) AS v(role, model, fallback, max_tokens, reasoning)
WHERE p.code = 'HIGH';

-- MEDIUM: Claude 3.5 Haiku / GPT-4o
INSERT INTO "generation_plan_models"
  ("planId", "role", "model", "fallbackModels", "maxTokens", "reasoningTokens", "updatedAt")
SELECT p.id, v.role, v.model, v.fallback::jsonb, v.max_tokens, v.reasoning, CURRENT_TIMESTAMP
FROM "generation_plans" p
CROSS JOIN (VALUES
  ('analyst',     'anthropic/claude-3.5-haiku', '["openai/gpt-4o"]', 1500, 0),
  ('planner',     'anthropic/claude-3.5-haiku', '["openai/gpt-4o"]', 4000, 2000),
  ('designer',    'anthropic/claude-3.5-haiku', '["openai/gpt-4o"]', 800, 0),
  ('outliner',    'anthropic/claude-3.5-haiku', '["openai/gpt-4o"]', 6000, 1500),
  ('writer',      'anthropic/claude-3.5-haiku', '["openai/gpt-4o"]', 8000, 0),
  ('illustrator', 'anthropic/claude-3.5-haiku', '["openai/gpt-4o"]', 3000, 0),
  ('inspector',   'anthropic/claude-3.5-haiku', '["openai/gpt-4o"]', 3500, 2000),
  ('optimizer',   'anthropic/claude-3.5-haiku', '["openai/gpt-4o"]', 8000, 0),
  ('reviewer',    'anthropic/claude-3.5-haiku', '["openai/gpt-4o"]', 2000, 0),
  ('default',     'anthropic/claude-3.5-haiku', '["openai/gpt-4o"]', 6000, 0)
) AS v(role, model, fallback, max_tokens, reasoning)
WHERE p.code = 'MEDIUM';

-- LOW: DeepSeek V3 / GPT-4o mini
INSERT INTO "generation_plan_models"
  ("planId", "role", "model", "fallbackModels", "maxTokens", "reasoningTokens", "updatedAt")
SELECT p.id, v.role, v.model, v.fallback::jsonb, v.max_tokens, v.reasoning, CURRENT_TIMESTAMP
FROM "generation_plans" p
CROSS JOIN (VALUES
  ('analyst',     'deepseek/deepseek-chat', '["openai/gpt-4o-mini"]', 1200, 0),
  ('planner',     'deepseek/deepseek-chat', '["openai/gpt-4o-mini"]', 2800, 0),
  ('designer',    'deepseek/deepseek-chat', '["openai/gpt-4o-mini"]', 700, 0),
  ('outliner',    'deepseek/deepseek-chat', '["openai/gpt-4o-mini"]', 4000, 0),
  ('writer',      'deepseek/deepseek-chat', '["openai/gpt-4o-mini"]', 5500, 0),
  ('illustrator', 'deepseek/deepseek-chat', '["openai/gpt-4o-mini"]', 2200, 0),
  ('inspector',   'deepseek/deepseek-chat', '["openai/gpt-4o-mini"]', 2200, 0),
  ('optimizer',   'deepseek/deepseek-chat', '["openai/gpt-4o-mini"]', 5500, 0),
  ('reviewer',    'deepseek/deepseek-chat', '["openai/gpt-4o-mini"]', 1400, 0),
  ('default',     'deepseek/deepseek-chat', '["openai/gpt-4o-mini"]', 4000, 0)
) AS v(role, model, fallback, max_tokens, reasoning)
WHERE p.code = 'LOW';
