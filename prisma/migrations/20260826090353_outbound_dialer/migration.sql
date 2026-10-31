-- CreateEnum
CREATE TYPE "CallAttemptStatus" AS ENUM ('QUEUED', 'RINGING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'ABANDONED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CreditTransactionType" ADD VALUE 'CALL_USAGE';
ALTER TYPE "CreditTransactionType" ADD VALUE 'CALL_USAGE_SHORTFALL';

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "concurrencyLimit" INTEGER;

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "voiceTierSlug" TEXT;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "concurrency" INTEGER NOT NULL DEFAULT 2;

-- AlterTable
ALTER TABLE "CreditTransaction" ADD COLUMN     "callAttemptId" TEXT;

-- CreateTable
CREATE TABLE "CallAttempt" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "campaignContactId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "upstreamCallId" TEXT,
    "upstreamSessionId" TEXT,
    "status" "CallAttemptStatus" NOT NULL DEFAULT 'QUEUED',
    "disposition" TEXT,
    "upstreamStatus" TEXT,
    "answeredBy" TEXT,
    "hangupCause" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSecs" INTEGER,
    "tierId" TEXT,
    "tierSlug" TEXT,
    "rateCreditsPerMin" BIGINT,
    "costCredits" BIGINT,
    "chargedAt" TIMESTAMP(3),
    "shortfall" BOOLEAN NOT NULL DEFAULT false,
    "launchError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CallAttempt_upstreamCallId_key" ON "CallAttempt"("upstreamCallId");

-- CreateIndex
CREATE UNIQUE INDEX "CallAttempt_upstreamSessionId_key" ON "CallAttempt"("upstreamSessionId");

-- CreateIndex
CREATE INDEX "CallAttempt_campaignId_status_idx" ON "CallAttempt"("campaignId", "status");

-- CreateIndex
CREATE INDEX "CallAttempt_accountId_status_idx" ON "CallAttempt"("accountId", "status");

-- CreateIndex
CREATE INDEX "CallAttempt_campaignContactId_idx" ON "CallAttempt"("campaignContactId");

-- CreateIndex
CREATE INDEX "CallAttempt_campaignId_startedAt_idx" ON "CallAttempt"("campaignId", "startedAt");

-- CreateIndex
CREATE INDEX "CallAttempt_status_startedAt_idx" ON "CallAttempt"("status", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_eventKey_key" ON "WebhookEvent"("eventKey");

-- CreateIndex
CREATE INDEX "WebhookEvent_receivedAt_idx" ON "WebhookEvent"("receivedAt");

-- CreateIndex
CREATE INDEX "CreditTransaction_callAttemptId_idx" ON "CreditTransaction"("callAttemptId");

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_callAttemptId_fkey" FOREIGN KEY ("callAttemptId") REFERENCES "CallAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallAttempt" ADD CONSTRAINT "CallAttempt_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallAttempt" ADD CONSTRAINT "CallAttempt_campaignContactId_fkey" FOREIGN KEY ("campaignContactId") REFERENCES "CampaignContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
