-- AlterTable
ALTER TABLE "assessments" ADD COLUMN IF NOT EXISTS "generationConfig" JSONB;
