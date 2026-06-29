-- AlterTable
ALTER TABLE "grading_scans" ADD COLUMN     "detectedStudentId" TEXT,
ADD COLUMN     "matchedStudentCode" TEXT;

-- CreateIndex
CREATE INDEX "grading_scans_detectedStudentId_idx" ON "grading_scans"("detectedStudentId");
