-- AlterTable
ALTER TABLE "courses" ADD COLUMN     "coRequisites" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "teachingModes" JSONB;
