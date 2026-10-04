-- Assessment closing section printed after the last question
ALTER TABLE "assessments" ADD COLUMN IF NOT EXISTS "includeAssessmentEndSection" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "assessments" ADD COLUMN IF NOT EXISTS "assessmentEndSection" TEXT;
