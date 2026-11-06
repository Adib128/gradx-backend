-- Record which content-generation quality plan (HIGH / MEDIUM / LOW) an LLM call used.
ALTER TABLE "ai_usage_logs" ADD COLUMN IF NOT EXISTS "generationPlanCode" TEXT;

CREATE INDEX IF NOT EXISTS "ai_usage_logs_generationPlanCode_idx"
  ON "ai_usage_logs"("generationPlanCode");
