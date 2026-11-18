-- CreateTable
CREATE TABLE "course_surveys" (
    "id" SERIAL NOT NULL,
    "courseId" INTEGER NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "introText" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "closingText" TEXT,
    "instructor" TEXT,
    "semester" TEXT,
    "section" TEXT,
    "courseCode" TEXT,
    "courseName" TEXT,
    "brand" JSONB,
    "clos" JSONB NOT NULL,
    "shareToken" TEXT,
    "shareEnabled" BOOLEAN NOT NULL DEFAULT false,
    "shareExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "course_surveys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "course_surveys_shareToken_key" ON "course_surveys"("shareToken");

-- CreateIndex
CREATE INDEX "course_surveys_courseId_idx" ON "course_surveys"("courseId");

-- CreateIndex
CREATE INDEX "course_surveys_tenantId_idx" ON "course_surveys"("tenantId");

-- AddForeignKey
ALTER TABLE "course_surveys" ADD CONSTRAINT "course_surveys_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_surveys" ADD CONSTRAINT "course_surveys_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
