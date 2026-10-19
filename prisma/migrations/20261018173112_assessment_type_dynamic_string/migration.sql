-- Assessment types are free-text labels (from course-spec names), not a fixed enum.
ALTER TABLE "assessments"
  ALTER COLUMN "type" TYPE TEXT
  USING ("type"::text);

ALTER TABLE "course_answer_sheets"
  ALTER COLUMN "assessmentType" DROP DEFAULT;

ALTER TABLE "course_answer_sheets"
  ALTER COLUMN "assessmentType" TYPE TEXT
  USING ("assessmentType"::text);

ALTER TABLE "course_answer_sheets"
  ALTER COLUMN "assessmentType" SET DEFAULT 'Final Exam';
