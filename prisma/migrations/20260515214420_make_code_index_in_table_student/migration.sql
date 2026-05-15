/*
  Warnings:

  - A unique constraint covering the columns `[code]` on the table `students` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "students_code_key" ON "students"("code");

-- CreateIndex
CREATE INDEX "students_code_idx" ON "students"("code");
