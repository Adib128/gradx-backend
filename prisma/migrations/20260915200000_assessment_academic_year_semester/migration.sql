-- AlterTable
ALTER TABLE "assessments" ADD COLUMN IF NOT EXISTS "academicYear" TEXT;
ALTER TABLE "assessments" ADD COLUMN IF NOT EXISTS "semester" TEXT;
