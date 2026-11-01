-- Answer sheet print options: Name / Section / Department; drop unused labels & sheets-per-page.
ALTER TABLE "course_answer_sheets" ADD COLUMN IF NOT EXISTS "includeName" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "course_answer_sheets" ADD COLUMN IF NOT EXISTS "includeDepartment" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "course_answer_sheets" DROP COLUMN IF EXISTS "sheetsPerPage";
ALTER TABLE "course_answer_sheets" DROP COLUMN IF EXISTS "includeSignature";
ALTER TABLE "course_answer_sheets" DROP COLUMN IF EXISTS "includeDate";
ALTER TABLE "course_answer_sheets" DROP COLUMN IF EXISTS "includeStudentInfoHeader";
ALTER TABLE "course_answer_sheets" DROP COLUMN IF EXISTS "studentInfoLabel";
ALTER TABLE "course_answer_sheets" DROP COLUMN IF EXISTS "keyVersionLabel";
