-- Per-topic question source (slides / reference chapters / course specification) and selected CLOs
CREATE TYPE "AssessmentQuestionSource" AS ENUM ('SLIDES', 'REFERENCE', 'COURSE_SPECIFICATION');

ALTER TABLE "assessment_topic" ADD COLUMN     "mcqCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "referenceChapters" JSONB,
ADD COLUMN     "sourceType" "AssessmentQuestionSource" NOT NULL DEFAULT 'COURSE_SPECIFICATION',
ADD COLUMN     "trueFalseCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "assessment_clos" (
    "assessmentId" INTEGER NOT NULL,
    "cloId" INTEGER NOT NULL,

    CONSTRAINT "assessment_clos_pkey" PRIMARY KEY ("assessmentId","cloId")
);

CREATE INDEX "assessment_clos_cloId_idx" ON "assessment_clos"("cloId");

ALTER TABLE "assessment_clos" ADD CONSTRAINT "assessment_clos_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "assessment_clos" ADD CONSTRAINT "assessment_clos_cloId_fkey" FOREIGN KEY ("cloId") REFERENCES "clos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
