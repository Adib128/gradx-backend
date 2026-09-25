-- AlterTable
ALTER TABLE "ai_usage_logs" ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ai_usage_logs_startedAt_idx" ON "ai_usage_logs"("startedAt");
