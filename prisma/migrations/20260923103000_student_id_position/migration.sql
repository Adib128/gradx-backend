-- AlterTable
ALTER TABLE "assessments" ADD COLUMN IF NOT EXISTS "studentIdPosition" TEXT NOT NULL DEFAULT 'TOP_LEFT';

-- AlterTable
ALTER TABLE "course_answer_sheets" ADD COLUMN IF NOT EXISTS "studentIdPosition" TEXT NOT NULL DEFAULT 'TOP_LEFT';
