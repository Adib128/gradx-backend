/*
  Warnings:

  - The values [EXAM] on the enum `AssessmentType` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "AssessmentType_new" AS ENUM ('QUIZ', 'FINAL_EXAM', 'MID_TERM_EXAM', 'LAB', 'OTHER');
ALTER TABLE "assessments" ALTER COLUMN "type" TYPE "AssessmentType_new" USING ("type"::text::"AssessmentType_new");
ALTER TYPE "AssessmentType" RENAME TO "AssessmentType_old";
ALTER TYPE "AssessmentType_new" RENAME TO "AssessmentType";
DROP TYPE "public"."AssessmentType_old";
COMMIT;
