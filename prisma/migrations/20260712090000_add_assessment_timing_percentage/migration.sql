-- AlterTable
ALTER TABLE "assessments" ADD COLUMN IF NOT EXISTS "timing" TEXT;
ALTER TABLE "assessments" ADD COLUMN IF NOT EXISTS "percentage" INTEGER;
