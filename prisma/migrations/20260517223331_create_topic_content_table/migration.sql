-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('LECTURE', 'SLIDES', 'QUIZ', 'LAB');

-- CreateEnum
CREATE TYPE "GenerationStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "topic_contents" (
    "id" SERIAL NOT NULL,
    "type" "ContentType" NOT NULL,
    "status" "GenerationStatus" NOT NULL DEFAULT 'PENDING',
    "content" JSONB,
    "topicId" INTEGER NOT NULL,
    "courseId" INTEGER NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "topic_contents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "topic_contents_topicId_idx" ON "topic_contents"("topicId");

-- CreateIndex
CREATE INDEX "topic_contents_tenantId_idx" ON "topic_contents"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "topic_contents_topicId_type_key" ON "topic_contents"("topicId", "type");

-- AddForeignKey
ALTER TABLE "topic_contents" ADD CONSTRAINT "topic_contents_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_contents" ADD CONSTRAINT "topic_contents_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_contents" ADD CONSTRAINT "topic_contents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
