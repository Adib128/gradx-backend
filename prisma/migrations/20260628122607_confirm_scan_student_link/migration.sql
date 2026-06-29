-- AlterTable
ALTER TABLE "grading_scans" ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "studentId" INTEGER;

-- CreateIndex
CREATE INDEX "grading_scans_studentId_idx" ON "grading_scans"("studentId");

-- AddForeignKey
ALTER TABLE "grading_scans" ADD CONSTRAINT "grading_scans_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;
