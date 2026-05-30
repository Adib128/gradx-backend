-- CreateEnum
CREATE TYPE "Bloom" AS ENUM ('REMEMBER', 'UNDERSTAND', 'APPLY', 'ANALYZE', 'EVALUATE', 'CREATE');

-- AlterTable
ALTER TABLE "questions" ADD COLUMN     "bloom" "Bloom";

-- CreateTable
CREATE TABLE "question_clos" (
    "questionId" INTEGER NOT NULL,
    "cloId" INTEGER NOT NULL,

    CONSTRAINT "question_clos_pkey" PRIMARY KEY ("questionId","cloId")
);

-- AddForeignKey
ALTER TABLE "question_clos" ADD CONSTRAINT "question_clos_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_clos" ADD CONSTRAINT "question_clos_cloId_fkey" FOREIGN KEY ("cloId") REFERENCES "clos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
