-- Assessment-level pass rate (%), separate from CLO pass rate (`passRate`).
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "assessmentPassRate" INTEGER NOT NULL DEFAULT 70;
