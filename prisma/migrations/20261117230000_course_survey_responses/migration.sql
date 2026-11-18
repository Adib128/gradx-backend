-- CreateTable
CREATE TABLE "course_survey_responses" (
    "id" SERIAL NOT NULL,
    "surveyId" INTEGER NOT NULL,
    "studentName" TEXT,
    "studentId" TEXT,
    "section" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ratings" JSONB NOT NULL,
    "comments" TEXT,
    "locale" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "course_survey_responses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "course_survey_responses_surveyId_idx" ON "course_survey_responses"("surveyId");

-- CreateIndex
CREATE INDEX "course_survey_responses_submittedAt_idx" ON "course_survey_responses"("submittedAt");

-- AddForeignKey
ALTER TABLE "course_survey_responses" ADD CONSTRAINT "course_survey_responses_surveyId_fkey" FOREIGN KEY ("surveyId") REFERENCES "course_surveys"("id") ON DELETE CASCADE ON UPDATE CASCADE;
