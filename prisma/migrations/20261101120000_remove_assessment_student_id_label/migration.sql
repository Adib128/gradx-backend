-- Drop the unused student ID section label (Student ID vs Student Name).
ALTER TABLE "assessments" DROP COLUMN IF EXISTS "studentIdLabel";

DROP TYPE IF EXISTS "AssessmentStudentIdLabel";
