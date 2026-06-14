/*
  Warnings:

  - You are about to drop the column `classId` on the `students` table. All the data in the column will be lost.
  - You are about to drop the column `tenantId` on the `students` table. All the data in the column will be lost.
  - Added the required column `courseId` to the `students` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "students" DROP CONSTRAINT "students_classId_fkey";

-- DropForeignKey
ALTER TABLE "students" DROP CONSTRAINT "students_tenantId_fkey";

-- AlterTable
ALTER TABLE "students" DROP COLUMN "classId",
DROP COLUMN "tenantId",
ADD COLUMN     "class" TEXT,
ADD COLUMN     "courseId" INTEGER NOT NULL,
ADD COLUMN     "departement" TEXT;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
