-- CreateEnum
CREATE TYPE "TestSessionStatus" AS ENUM ('ACTIVE', 'ENDING', 'COMPLETED', 'FAILED', 'ABANDONED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CreditTransactionType" ADD VALUE 'TEST_SESSION_USAGE';
ALTER TYPE "CreditTransactionType" ADD VALUE 'TEST_SESSION_SHORTFALL';

-- AlterTable
ALTER TABLE "CreditTransaction" ADD COLUMN     "testSessionId" TEXT;

-- CreateTable
CREATE TABLE "TestSession" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "startedByAccountId" TEXT NOT NULL,
    "upstreamSessionId" TEXT,
    "status" "TestSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "upstreamStatus" TEXT,
    "tierId" TEXT,
    "tierSlug" TEXT,
    "rateCreditsPerMin" BIGINT,
    "billingIncrementSecs" INTEGER,
    "durationSecs" INTEGER,
    "billedSecs" INTEGER,
    "costCredits" BIGINT,
    "chargedAt" TIMESTAMP(3),
    "shortfall" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TestSession_upstreamSessionId_key" ON "TestSession"("upstreamSessionId");

-- CreateIndex
CREATE INDEX "TestSession_workspaceId_startedAt_idx" ON "TestSession"("workspaceId", "startedAt");

-- CreateIndex
CREATE INDEX "TestSession_status_startedAt_idx" ON "TestSession"("status", "startedAt");

-- CreateIndex
CREATE INDEX "TestSession_accountId_status_idx" ON "TestSession"("accountId", "status");

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_testSessionId_fkey" FOREIGN KEY ("testSessionId") REFERENCES "TestSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One live test session per workspace.
--
-- Prisma cannot express a partial unique index, so it is hand-written here —
-- the same arrangement the partial unique index on `Tier.isDefault` has. A
-- unique index rather than a counted check, because a count is a check-then-act
-- that two clicks slip between, and the thing being capped is a line taken from
-- the same concurrency pool the dialer runs on.
CREATE UNIQUE INDEX "test_sessions_one_live_per_workspace"
  ON "TestSession" ("workspaceId") WHERE status = 'ACTIVE';
