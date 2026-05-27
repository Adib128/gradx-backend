/*
  Warnings:

  - You are about to drop the column `description` on the `assessments` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "Language" AS ENUM ('ENGLISH', 'ARABIC');

-- AlterTable
ALTER TABLE "assessments" DROP COLUMN "description",
ADD COLUMN     "language" "Language";

-- CreateTable
CREATE TABLE "assessment_topic" (
    "assessmentId" INTEGER NOT NULL,
    "topicId" INTEGER NOT NULL,

    CONSTRAINT "assessment_topic_pkey" PRIMARY KEY ("assessmentId","topicId")
);

-- AddForeignKey
ALTER TABLE "assessment_topic" ADD CONSTRAINT "assessment_topic_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "assessments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_topic" ADD CONSTRAINT "assessment_topic_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "topics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
