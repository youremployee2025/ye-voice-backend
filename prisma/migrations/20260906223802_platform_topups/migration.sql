-- CreateEnum
CREATE TYPE "PlatformTopupStatus" AS ENUM ('CREATED', 'ATTEMPTED', 'FAILED', 'CREDITED', 'EXPIRED', 'MISMATCH');

-- CreateTable
CREATE TABLE "PlatformTopup" (
    "id" TEXT NOT NULL,
    "paymentOrderId" TEXT NOT NULL,
    "shortUrl" TEXT NOT NULL,
    "amountRupees" INTEGER NOT NULL,
    "gstRupees" INTEGER NOT NULL,
    "totalRupees" INTEGER NOT NULL,
    "status" "PlatformTopupStatus" NOT NULL DEFAULT 'CREATED',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "creditedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformTopup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformTopup_paymentOrderId_key" ON "PlatformTopup"("paymentOrderId");

-- CreateIndex
CREATE INDEX "PlatformTopup_status_expiresAt_idx" ON "PlatformTopup"("status", "expiresAt");
