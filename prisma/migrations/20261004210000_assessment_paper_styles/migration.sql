-- Per-section typography for the printed assessment paper
ALTER TABLE "assessments" ADD COLUMN IF NOT EXISTS "paperStyles" JSONB;
