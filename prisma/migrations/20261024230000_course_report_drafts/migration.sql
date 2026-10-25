-- Editable course-report drafts (auto-saved from the reports tab)
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "courseReportDrafts" JSONB;
