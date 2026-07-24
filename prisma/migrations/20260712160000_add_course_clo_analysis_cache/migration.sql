-- AlterTable
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "cloAnalysisCache" JSONB;
