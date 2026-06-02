-- DropForeignKey
ALTER TABLE "clos" DROP CONSTRAINT "clos_courseId_fkey";

-- AlterTable
ALTER TABLE "clos" ALTER COLUMN "courseId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "clos" ADD CONSTRAINT "clos_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
