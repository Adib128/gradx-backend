-- Students can belong to a standalone answer sheet (no course).

ALTER TABLE "students"
  ADD COLUMN IF NOT EXISTS "courseAnswerSheetId" INTEGER;

CREATE INDEX IF NOT EXISTS "students_courseId_idx" ON "students"("courseId");
CREATE INDEX IF NOT EXISTS "students_courseAnswerSheetId_idx" ON "students"("courseAnswerSheetId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'students_courseAnswerSheetId_fkey'
  ) THEN
    ALTER TABLE "students"
      ADD CONSTRAINT "students_courseAnswerSheetId_fkey"
      FOREIGN KEY ("courseAnswerSheetId") REFERENCES "course_answer_sheets"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
