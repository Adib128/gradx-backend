-- pgvector (Neon ships 0.8.x). Course-scoped searches filter by document first, so
-- an exact cosine scan over those rows is used instead of an ANN index.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "ReferenceEmbeddingStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "reference_documents" (
    "id" SERIAL NOT NULL,
    "courseId" INTEGER NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "documentKey" TEXT NOT NULL,
    "referenceIndex" INTEGER NOT NULL,
    "title" TEXT,
    "fileName" TEXT,
    "filePath" TEXT,
    "contentHash" TEXT NOT NULL,
    "embeddingModel" TEXT NOT NULL,
    "status" "ReferenceEmbeddingStatus" NOT NULL DEFAULT 'PENDING',
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "indexedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reference_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_chunks" (
    "id" SERIAL NOT NULL,
    "documentId" INTEGER NOT NULL,
    "courseId" INTEGER NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "chapterIndex" INTEGER NOT NULL,
    "chapterName" TEXT,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "tokenCount" INTEGER,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reference_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reference_documents_tenantId_idx" ON "reference_documents"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "reference_documents_courseId_documentKey_key" ON "reference_documents"("courseId", "documentKey");

-- CreateIndex
CREATE INDEX "reference_chunks_documentId_chapterIndex_idx" ON "reference_chunks"("documentId", "chapterIndex");

-- CreateIndex
CREATE INDEX "reference_chunks_courseId_idx" ON "reference_chunks"("courseId");

-- AddForeignKey
ALTER TABLE "reference_documents" ADD CONSTRAINT "reference_documents_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_chunks" ADD CONSTRAINT "reference_chunks_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "reference_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

