/*
  Warnings:

  - You are about to drop the column `topicId` on the `assessments` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "assessments" DROP CONSTRAINT "assessments_topicId_fkey";

-- DropIndex
DROP INDEX "assessments_topicId_idx";

-- AlterTable
ALTER TABLE "assessments" DROP COLUMN "topicId";
