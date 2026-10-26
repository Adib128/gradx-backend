-- AlterTable
ALTER TABLE "assessments" ADD COLUMN "allowMultipleCorrect" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "questions" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;
