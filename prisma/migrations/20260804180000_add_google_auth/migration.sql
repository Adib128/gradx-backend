-- AlterTable
ALTER TABLE "users" ALTER COLUMN "passwordHash" DROP NOT NULL;
ALTER TABLE "users" ALTER COLUMN "hashVersion" DROP NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "googleId" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "authProvider" TEXT NOT NULL DEFAULT 'LOCAL';

CREATE UNIQUE INDEX IF NOT EXISTS "users_googleId_key" ON "users"("googleId");
CREATE INDEX IF NOT EXISTS "users_googleId_idx" ON "users"("googleId");
