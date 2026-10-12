-- AlterEnum
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'PENDING_PAYMENT';

-- AlterTable
ALTER TABLE "plans" ADD COLUMN "isFree" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "aiTokenLimit" INTEGER DEFAULT 500000;

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN "periodId" INTEGER,
ADD COLUMN "amount" DECIMAL(10,2),
ADD COLUMN "currency" TEXT;

-- CreateIndex
CREATE INDEX "subscriptions_periodId_idx" ON "subscriptions"("periodId");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "billing_periods"("id") ON DELETE SET NULL ON UPDATE CASCADE;
