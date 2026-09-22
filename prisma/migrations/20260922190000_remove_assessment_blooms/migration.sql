-- Remove Bloom's taxonomy from assessments / questions
ALTER TABLE "questions" DROP COLUMN IF EXISTS "bloom";
ALTER TABLE "assessments" DROP COLUMN IF EXISTS "printBloomLevelNextToEachQuestion";

DROP TYPE IF EXISTS "Bloom";
