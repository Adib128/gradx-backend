-- CreateEnum
CREATE TYPE "AssessmentPaperSize" AS ENUM ('LETTER', 'A3', 'A4', 'A5', 'A6');

-- CreateEnum
CREATE TYPE "AssessmentAnswerSheetMode" AS ENUM ('APPEND_SEPARATE_PDF', 'APPEND_SAME_PDF', 'NONE');

-- CreateEnum
CREATE TYPE "AssessmentStudentIdLabel" AS ENUM ('STUDENT_ID', 'STUDENT_NAME');

-- AlterTable
ALTER TABLE "assessments"
ADD COLUMN "numberOfVersions" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN "paperSize" "AssessmentPaperSize" NOT NULL DEFAULT 'A4',
ADD COLUMN "answerSheetMode" "AssessmentAnswerSheetMode" NOT NULL DEFAULT 'APPEND_SAME_PDF',
ADD COLUMN "showMarksPerQuestion" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "includeStudentInfoHeader" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "studentIdLabel" "AssessmentStudentIdLabel" NOT NULL DEFAULT 'STUDENT_ID',
ADD COLUMN "numberOfStudentIdDigits" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN "includeAssessmentInstructionsSection" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "assessmentInstructions" TEXT,
ADD COLUMN "printCloCodeNextToEachQuestion" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "printBloomLevelNextToEachQuestion" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "printDifficultyLabelNextToEachQuestion" BOOLEAN NOT NULL DEFAULT false;
