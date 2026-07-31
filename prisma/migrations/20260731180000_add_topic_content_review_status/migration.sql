-- CreateEnum
CREATE TYPE "ContentReviewStatus" AS ENUM ('DRAFT', 'ACCEPTED');

-- AlterTable
ALTER TABLE "topic_contents" ADD COLUMN "reviewStatus" "ContentReviewStatus" NOT NULL DEFAULT 'DRAFT';

-- Existing completed content was already treated as accepted in the UI.
UPDATE "topic_contents"
SET "reviewStatus" = 'ACCEPTED'
WHERE "status" = 'COMPLETED' AND "content" IS NOT NULL;
