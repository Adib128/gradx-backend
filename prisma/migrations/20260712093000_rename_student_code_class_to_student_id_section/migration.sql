-- Rename student business id and class/section columns
ALTER TABLE "students" RENAME COLUMN "code" TO "student_id";
ALTER TABLE "students" RENAME COLUMN "class" TO "section";

-- Rename unique constraint / indexes if present
ALTER INDEX IF EXISTS "students_code_key" RENAME TO "students_student_id_key";
ALTER INDEX IF EXISTS "students_code_idx" RENAME TO "students_student_id_idx";
