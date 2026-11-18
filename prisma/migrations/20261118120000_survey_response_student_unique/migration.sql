-- CreateIndex
CREATE UNIQUE INDEX "course_survey_responses_surveyId_studentId_key" ON "course_survey_responses"("surveyId", "studentId");
