/*
  Warnings:

  - You are about to drop the `Course` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "Course" DROP CONSTRAINT "Course_tenantId_fkey";

-- DropTable
DROP TABLE "Course";

-- CreateTable
CREATE TABLE "courses" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "code" TEXT,
    "program" TEXT,
    "description" TEXT,
    "creditHours" INTEGER,
    "level" TEXT,
    "teachingMode" TEXT,
    "totalContactHours" INTEGER,
    "lectureHours" INTEGER,
    "labHours" INTEGER,
    "prerequisites" TEXT[],
    "references" JSONB,
    "assessments" JSONB,
    "tenantId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topics" (
    "id" SERIAL NOT NULL,
    "topicNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "contactHours" INTEGER NOT NULL DEFAULT 3,
    "courseId" INTEGER NOT NULL,

    CONSTRAINT "topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clos" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "programCLOCode" TEXT,
    "description" TEXT NOT NULL,
    "teachingStrategies" TEXT[],
    "assessmentMethods" TEXT[],
    "courseId" INTEGER NOT NULL,

    CONSTRAINT "clos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "courses_tenantId_idx" ON "courses"("tenantId");

-- CreateIndex
CREATE INDEX "topics_courseId_idx" ON "topics"("courseId");

-- CreateIndex
CREATE UNIQUE INDEX "topics_courseId_topicNumber_key" ON "topics"("courseId", "topicNumber");

-- CreateIndex
CREATE INDEX "clos_courseId_idx" ON "clos"("courseId");

-- CreateIndex
CREATE UNIQUE INDEX "clos_courseId_code_key" ON "clos"("courseId", "code");

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topics" ADD CONSTRAINT "topics_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clos" ADD CONSTRAINT "clos_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
