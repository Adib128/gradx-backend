-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN "renewalOfId" INTEGER;

-- CreateIndex
CREATE INDEX "subscriptions_renewalOfId_idx" ON "subscriptions"("renewalOfId");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_renewalOfId_fkey" FOREIGN KEY ("renewalOfId") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
