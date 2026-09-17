-- AlterTable
ALTER TABLE "assessments" ADD COLUMN "code" TEXT;

-- Backfill unique codes for existing rows
UPDATE "assessments"
SET "code" = 'ASM' || LPAD("id"::text, 6, '0')
WHERE "code" IS NULL;

-- Enforce NOT NULL + unique
ALTER TABLE "assessments" ALTER COLUMN "code" SET NOT NULL;
CREATE UNIQUE INDEX "assessments_code_key" ON "assessments"("code");
