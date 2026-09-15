-- Remap CourseAnswerSheetQuestionType to MCQ | TRUE_FALSE
ALTER TABLE "course_answer_sheet_questions" ALTER COLUMN "type" DROP DEFAULT;

ALTER TYPE "CourseAnswerSheetQuestionType" RENAME TO "CourseAnswerSheetQuestionType_old";

CREATE TYPE "CourseAnswerSheetQuestionType" AS ENUM ('MCQ', 'TRUE_FALSE');

ALTER TABLE "course_answer_sheet_questions"
  ALTER COLUMN "type" TYPE "CourseAnswerSheetQuestionType"
  USING (
    CASE
      WHEN "type"::text = 'NUMERIC_ENTRY' THEN 'TRUE_FALSE'::"CourseAnswerSheetQuestionType"
      ELSE 'MCQ'::"CourseAnswerSheetQuestionType"
    END
  );

ALTER TABLE "course_answer_sheet_questions"
  ALTER COLUMN "type" SET DEFAULT 'MCQ'::"CourseAnswerSheetQuestionType";

DROP TYPE "CourseAnswerSheetQuestionType_old";
