-- Course specification: "Assessment of Course Quality" table + "Specification Approval Data"
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "courseQualityAssessment" JSONB;
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "approvalCouncil" TEXT;
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "approvalReferenceNo" TEXT;
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "approvalDate" TEXT;
