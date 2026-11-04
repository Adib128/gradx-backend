-- Content generation quality plans (High / Medium / Low) and per-role models.
CREATE TABLE "generation_plans" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "descriptionEn" TEXT,
    "descriptionAr" TEXT,
    "qualityLabelEn" TEXT NOT NULL,
    "qualityLabelAr" TEXT NOT NULL,
    "estimatedTokens" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generation_plans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "generation_plans_code_key" ON "generation_plans"("code");
CREATE INDEX "generation_plans_isActive_sortOrder_idx" ON "generation_plans"("isActive", "sortOrder");

CREATE TABLE "generation_plan_models" (
    "id" SERIAL NOT NULL,
    "planId" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "fallbackModels" JSONB NOT NULL DEFAULT '[]',
    "maxTokens" INTEGER,
    "reasoningTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generation_plan_models_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "generation_plan_models_planId_role_key" ON "generation_plan_models"("planId", "role");
CREATE INDEX "generation_plan_models_planId_idx" ON "generation_plan_models"("planId");

ALTER TABLE "generation_plan_models"
  ADD CONSTRAINT "generation_plan_models_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "generation_plans"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the three default plans used by Slide Studio.
INSERT INTO "generation_plans"
  ("code", "nameEn", "nameAr", "descriptionEn", "descriptionAr", "qualityLabelEn", "qualityLabelAr", "estimatedTokens", "isActive", "sortOrder", "updatedAt")
VALUES
  (
    'HIGH',
    'High',
    'عالي',
    'Best models and deeper reasoning for publication-ready lecture slides. Uses more tokens.',
    'أفضل النماذج واستدلال أعمق لشرائح محاضرة جاهزة للنشر. يستهلك رموزاً أكثر.',
    'Highest quality',
    'أعلى جودة',
    180000,
    true,
    1,
    CURRENT_TIMESTAMP
  ),
  (
    'MEDIUM',
    'Medium',
    'متوسط',
    'Balanced quality and cost for everyday teaching decks.',
    'توازن بين الجودة والتكلفة لشرائح التدريس اليومية.',
    'Balanced quality',
    'جودة متوازنة',
    90000,
    true,
    2,
    CURRENT_TIMESTAMP
  ),
  (
    'LOW',
    'Low',
    'منخفض',
    'Fastest and cheapest models for drafts and quick reviews.',
    'أسرع وأرخص النماذج للمسودات والمراجعات السريعة.',
    'Draft quality',
    'جودة مسودة',
    45000,
    true,
    3,
    CURRENT_TIMESTAMP
  );

-- HIGH plan models
INSERT INTO "generation_plan_models"
  ("planId", "role", "model", "fallbackModels", "maxTokens", "reasoningTokens", "updatedAt")
SELECT p.id, v.role, v.model, v.fallback::jsonb, v.max_tokens, v.reasoning, CURRENT_TIMESTAMP
FROM "generation_plans" p
CROSS JOIN (VALUES
  ('analyst',     'google/gemini-3.8-flash',       '["anthropic/claude-sonnet-4.5"]', 2000, 0),
  ('planner',     'anthropic/claude-sonnet-4.5',   '["google/gemini-3.8-flash"]',     5000, 8000),
  ('designer',    'anthropic/claude-sonnet-4.5',   '["google/gemini-3.8-flash"]',     1200, 0),
  ('outliner',    'anthropic/claude-sonnet-4.5',   '["google/gemini-3.8-flash"]',     7000, 6000),
  ('writer',      'anthropic/claude-sonnet-4.5',   '["openai/gpt-6-luna"]',           10000, 3000),
  ('illustrator', 'anthropic/claude-sonnet-4.5',   '["google/gemini-3.8-flash"]',     4000, 1500),
  ('inspector',   'google/gemini-3.8-flash',       '["openai/gpt-6-luna"]',           4500, 8000),
  ('optimizer',   'anthropic/claude-sonnet-4.5',   '["openai/gpt-6-luna"]',           10000, 3000),
  ('reviewer',    'google/gemini-3.8-flash',       '["openai/gpt-6-luna"]',           2500, 3000),
  ('default',     'anthropic/claude-sonnet-4.5',   '["google/gemini-3.8-flash"]',     8000, 2000)
) AS v(role, model, fallback, max_tokens, reasoning)
WHERE p.code = 'HIGH';

-- MEDIUM plan models (balanced defaults)
INSERT INTO "generation_plan_models"
  ("planId", "role", "model", "fallbackModels", "maxTokens", "reasoningTokens", "updatedAt")
SELECT p.id, v.role, v.model, v.fallback::jsonb, v.max_tokens, v.reasoning, CURRENT_TIMESTAMP
FROM "generation_plans" p
CROSS JOIN (VALUES
  ('analyst',     'google/gemini-3.8-flash',       '["anthropic/claude-haiku-5.5"]', 1500, 0),
  ('planner',     'google/gemini-3.8-flash',       '["anthropic/claude-haiku-5.5"]', 4000, 6000),
  ('designer',    'anthropic/claude-haiku-5.5',    '["google/gemini-3.8-flash"]',    800, 0),
  ('outliner',    'google/gemini-3.8-flash',       '["anthropic/claude-haiku-5.5"]', 6000, 4000),
  ('writer',      'anthropic/claude-haiku-5.5',    '["openai/gpt-6-luna"]',          8000, 2000),
  ('illustrator', 'anthropic/claude-haiku-5.5',    '["google/gemini-3.8-flash"]',    3000, 1000),
  ('inspector',   'google/gemini-3.8-flash',       '["openai/gpt-6-luna"]',          3500, 6000),
  ('optimizer',   'anthropic/claude-haiku-5.5',    '["openai/gpt-6-luna"]',          8000, 2000),
  ('reviewer',    'google/gemini-3.8-flash',       '["openai/gpt-6-luna"]',          2000, 2000),
  ('default',     'google/gemini-3.8-flash',       '["anthropic/claude-haiku-5.5"]', 6000, 1000)
) AS v(role, model, fallback, max_tokens, reasoning)
WHERE p.code = 'MEDIUM';

-- LOW plan models (fast / cheap)
INSERT INTO "generation_plan_models"
  ("planId", "role", "model", "fallbackModels", "maxTokens", "reasoningTokens", "updatedAt")
SELECT p.id, v.role, v.model, v.fallback::jsonb, v.max_tokens, v.reasoning, CURRENT_TIMESTAMP
FROM "generation_plans" p
CROSS JOIN (VALUES
  ('analyst',     'google/gemini-3.8-flash', '["openai/gpt-6-luna"]', 1000, 0),
  ('planner',     'google/gemini-3.8-flash', '["openai/gpt-6-luna"]', 2500, 2000),
  ('designer',    'google/gemini-3.8-flash', '["openai/gpt-6-luna"]', 600, 0),
  ('outliner',    'google/gemini-3.8-flash', '["openai/gpt-6-luna"]', 3500, 1500),
  ('writer',      'google/gemini-3.8-flash', '["openai/gpt-6-luna"]', 5000, 500),
  ('illustrator', 'google/gemini-3.8-flash', '["openai/gpt-6-luna"]', 2000, 0),
  ('inspector',   'google/gemini-3.8-flash', '["openai/gpt-6-luna"]', 2000, 2000),
  ('optimizer',   'google/gemini-3.8-flash', '["openai/gpt-6-luna"]', 5000, 500),
  ('reviewer',    'google/gemini-3.8-flash', '["openai/gpt-6-luna"]', 1200, 500),
  ('default',     'google/gemini-3.8-flash', '["openai/gpt-6-luna"]', 4000, 0)
) AS v(role, model, fallback, max_tokens, reasoning)
WHERE p.code = 'LOW';
