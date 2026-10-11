-- CreateTable
CREATE TABLE "slide_templates" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "createdById" INTEGER,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "source" TEXT NOT NULL DEFAULT 'custom',
    "theme" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slide_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "slide_templates_tenantId_idx" ON "slide_templates"("tenantId");
