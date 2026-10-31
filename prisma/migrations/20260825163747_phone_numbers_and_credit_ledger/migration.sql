-- CreateEnum
CREATE TYPE "PhoneNumberStatus" AS ENUM ('UNASSIGNED', 'ASSIGNED', 'RELEASED_NONPAYMENT');

-- CreateEnum
CREATE TYPE "CreditTransactionType" AS ENUM ('DID_PURCHASE', 'DID_RENEWAL', 'DID_RELEASE', 'DID_RELEASE_NONPAYMENT', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "PhoneNumber" (
    "id" TEXT NOT NULL,
    "did" TEXT NOT NULL,
    "externalId" TEXT,
    "provider" TEXT,
    "countryCode" TEXT,
    "numberType" TEXT,
    "providerStatus" TEXT,
    "providerExpiresAt" TIMESTAMP(3),
    "rawProvider" JSONB,
    "lastSyncedAt" TIMESTAMP(3),
    "status" "PhoneNumberStatus" NOT NULL DEFAULT 'UNASSIGNED',
    "workspaceId" TEXT,
    "monthlyPriceCredits" BIGINT,
    "rentedAt" TIMESTAMP(3),
    "nextRenewalAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhoneNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditTransaction" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "phoneNumberId" TEXT,
    "amount" BIGINT NOT NULL,
    "type" "CreditTransactionType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PhoneNumber_did_key" ON "PhoneNumber"("did");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneNumber_externalId_key" ON "PhoneNumber"("externalId");

-- CreateIndex
CREATE INDEX "PhoneNumber_workspaceId_idx" ON "PhoneNumber"("workspaceId");

-- CreateIndex
CREATE INDEX "PhoneNumber_status_idx" ON "PhoneNumber"("status");

-- CreateIndex
CREATE INDEX "PhoneNumber_status_nextRenewalAt_idx" ON "PhoneNumber"("status", "nextRenewalAt");

-- CreateIndex
CREATE INDEX "CreditTransaction_accountId_createdAt_idx" ON "CreditTransaction"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditTransaction_workspaceId_createdAt_idx" ON "CreditTransaction"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditTransaction_phoneNumberId_idx" ON "CreditTransaction"("phoneNumberId");

-- AddForeignKey
ALTER TABLE "PhoneNumber" ADD CONSTRAINT "PhoneNumber_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_phoneNumberId_fkey" FOREIGN KEY ("phoneNumberId") REFERENCES "PhoneNumber"("id") ON DELETE SET NULL ON UPDATE CASCADE;
