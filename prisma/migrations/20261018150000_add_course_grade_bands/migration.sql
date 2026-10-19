-- Per-course editable letter-grade intervals (A+, A, B+, …). Null = use defaults.
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "gradeBands" JSONB;
