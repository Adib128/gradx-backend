/*
  Warnings:

  - You are about to drop the `Departement` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "Departement" DROP CONSTRAINT "Departement_tenantId_fkey";

-- DropTable
DROP TABLE "Departement";

-- CreateTable
CREATE TABLE "departements" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "departements_name_key" ON "departements"("name");

-- CreateIndex
CREATE INDEX "departements_tenantId_idx" ON "departements"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "departements_name_tenantId_key" ON "departements"("name", "tenantId");

-- AddForeignKey
ALTER TABLE "departements" ADD CONSTRAINT "departements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
