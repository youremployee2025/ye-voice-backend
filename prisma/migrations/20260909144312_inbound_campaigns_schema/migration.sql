-- CreateEnum
CREATE TYPE "CampaignType" AS ENUM ('OUTBOUND', 'INBOUND', 'BOTH');

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "inboundEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "type" "CampaignType" NOT NULL DEFAULT 'OUTBOUND';

-- CreateTable
CREATE TABLE "CampaignInboundClaim" (
    "phoneNumberId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignInboundClaim_pkey" PRIMARY KEY ("phoneNumberId")
);

-- CreateTable
CREATE TABLE "CampaignInboundCall" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "campaignContactId" TEXT,
    "contactId" TEXT,
    "workspaceId" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "fromNumber" TEXT NOT NULL,
    "upstreamCallId" TEXT,
    "upstreamSessionId" TEXT,
    "arrivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "durationSecs" INTEGER,
    "disposition" TEXT,
    "extraction" JSONB,
    "costCredits" BIGINT,

    CONSTRAINT "CampaignInboundCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignInboundClaim_campaignId_idx" ON "CampaignInboundClaim"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignInboundCall_upstreamCallId_key" ON "CampaignInboundCall"("upstreamCallId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignInboundCall_upstreamSessionId_key" ON "CampaignInboundCall"("upstreamSessionId");

-- CreateIndex
CREATE INDEX "CampaignInboundCall_campaignId_arrivedAt_idx" ON "CampaignInboundCall"("campaignId", "arrivedAt");

-- CreateIndex
CREATE INDEX "CampaignInboundCall_campaignContactId_idx" ON "CampaignInboundCall"("campaignContactId");

-- AddForeignKey
ALTER TABLE "CampaignInboundClaim" ADD CONSTRAINT "CampaignInboundClaim_phoneNumberId_fkey" FOREIGN KEY ("phoneNumberId") REFERENCES "PhoneNumber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignInboundClaim" ADD CONSTRAINT "CampaignInboundClaim_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
