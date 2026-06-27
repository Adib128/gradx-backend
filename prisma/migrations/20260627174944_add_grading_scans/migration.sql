-- CreateEnum
CREATE TYPE "GradingScanStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "grading_scans" (
    "id" SERIAL NOT NULL,
    "assessmentId" INTEGER NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "graderUserId" INTEGER NOT NULL,
    "status" "GradingScanStatus" NOT NULL DEFAULT 'PENDING',
    "imagePath" TEXT,
    "decodedFormId" INTEGER,
    "confidence" DOUBLE PRECISION,
    "detectedAnswers" JSONB,
    "score" DOUBLE PRECISION,
    "maxScore" DOUBLE PRECISION,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grading_scans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "grading_scans_assessmentId_idx" ON "grading_scans"("assessmentId");

-- CreateIndex
CREATE INDEX "grading_scans_tenantId_idx" ON "grading_scans"("tenantId");

-- CreateIndex
CREATE INDEX "grading_scans_graderUserId_idx" ON "grading_scans"("graderUserId");

-- AddForeignKey
ALTER TABLE "grading_scans" ADD CONSTRAINT "grading_scans_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grading_scans" ADD CONSTRAINT "grading_scans_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grading_scans" ADD CONSTRAINT "grading_scans_graderUserId_fkey" FOREIGN KEY ("graderUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
