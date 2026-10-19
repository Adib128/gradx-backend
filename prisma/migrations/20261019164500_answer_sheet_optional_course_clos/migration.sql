-- Optional course on answer sheets + standalone CLOs + grading scans link.

ALTER TABLE "course_answer_sheets"
  ALTER COLUMN "courseId" DROP NOT NULL;

CREATE TABLE "course_answer_sheet_clos" (
  "id" SERIAL NOT NULL,
  "code" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "answerSheetId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "course_answer_sheet_clos_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "course_answer_sheet_clos_answerSheetId_idx" ON "course_answer_sheet_clos"("answerSheetId");
CREATE UNIQUE INDEX "course_answer_sheet_clos_answerSheetId_code_key" ON "course_answer_sheet_clos"("answerSheetId", "code");

ALTER TABLE "course_answer_sheet_clos"
  ADD CONSTRAINT "course_answer_sheet_clos_answerSheetId_fkey"
  FOREIGN KEY ("answerSheetId") REFERENCES "course_answer_sheets"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "grading_scans"
  ALTER COLUMN "assessmentId" DROP NOT NULL;

ALTER TABLE "grading_scans"
  ADD COLUMN "courseAnswerSheetId" INTEGER;

CREATE INDEX "grading_scans_courseAnswerSheetId_idx" ON "grading_scans"("courseAnswerSheetId");

ALTER TABLE "grading_scans"
  ADD CONSTRAINT "grading_scans_courseAnswerSheetId_fkey"
  FOREIGN KEY ("courseAnswerSheetId") REFERENCES "course_answer_sheets"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
