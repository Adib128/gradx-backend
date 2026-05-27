/*
  Warnings:

  - A unique constraint covering the columns `[code]` on the table `clos` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "clos" DROP CONSTRAINT "clos_courseId_fkey";

-- DropIndex
DROP INDEX "clos_courseId_code_key";

-- CreateIndex
CREATE UNIQUE INDEX "clos_code_key" ON "clos"("code");

-- AddForeignKey
ALTER TABLE "clos" ADD CONSTRAINT "clos_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
