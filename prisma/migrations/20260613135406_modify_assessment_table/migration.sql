/*
  Warnings:

  - You are about to drop the column `score` on the `assessments` table. All the data in the column will be lost.
  - You are about to drop the column `timing` on the `assessments` table. All the data in the column will be lost.
  - You are about to drop the column `totalPoints` on the `assessments` table. All the data in the column will be lost.
  - Added the required column `difficulty` to the `assessments` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "DifficultyDistribution" AS ENUM ('BEGINNER', 'EASY', 'BALANCED', 'MIXED', 'ADVANCED', 'EXPERT');

-- AlterTable
ALTER TABLE "assessments" DROP COLUMN "score",
DROP COLUMN "timing",
DROP COLUMN "totalPoints",
ADD COLUMN     "difficulty" "DifficultyDistribution" NOT NULL,
ADD COLUMN     "totalMarks" INTEGER;
