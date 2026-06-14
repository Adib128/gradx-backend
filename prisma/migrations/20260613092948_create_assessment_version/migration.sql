-- CreateTable
CREATE TABLE "assessment_versions" (
    "id" SERIAL NOT NULL,
    "versionName" TEXT NOT NULL,
    "assessmentId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assessment_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_version_questions" (
    "id" SERIAL NOT NULL,
    "assessmentVersionId" INTEGER NOT NULL,
    "questionId" INTEGER NOT NULL,
    "order" INTEGER NOT NULL,

    CONSTRAINT "assessment_version_questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assessment_versions_assessmentId_idx" ON "assessment_versions"("assessmentId");

-- CreateIndex
CREATE INDEX "assessment_version_questions_assessmentVersionId_idx" ON "assessment_version_questions"("assessmentVersionId");

-- CreateIndex
CREATE INDEX "assessment_version_questions_questionId_idx" ON "assessment_version_questions"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_version_questions_assessmentVersionId_questionId_key" ON "assessment_version_questions"("assessmentVersionId", "questionId");

-- AddForeignKey
ALTER TABLE "assessment_versions" ADD CONSTRAINT "assessment_versions_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_version_questions" ADD CONSTRAINT "assessment_version_questions_assessmentVersionId_fkey" FOREIGN KEY ("assessmentVersionId") REFERENCES "assessment_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_version_questions" ADD CONSTRAINT "assessment_version_questions_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
