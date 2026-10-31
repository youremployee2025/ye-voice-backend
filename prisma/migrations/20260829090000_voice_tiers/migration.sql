-- CreateEnum
CREATE TYPE "TierStatus" AS ENUM ('ACTIVE', 'REMOVED');

-- CreateTable
CREATE TABLE "Tier" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TierStatus" NOT NULL DEFAULT 'ACTIVE',
    "defaultPriceCreditsPerMin" BIGINT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountTier" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "tierId" TEXT NOT NULL,
    "priceCreditsPerMin" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountTier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tier_slug_key" ON "Tier"("slug");

-- CreateIndex
CREATE INDEX "AccountTier_tierId_idx" ON "AccountTier"("tierId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountTier_accountId_tierId_key" ON "AccountTier"("accountId", "tierId");

-- AddForeignKey
ALTER TABLE "AccountTier" ADD CONSTRAINT "AccountTier_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountTier" ADD CONSTRAINT "AccountTier_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "Tier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exactly one default tier, enforced by the database rather than by care.
--
-- Prisma's schema language has no partial index, so this cannot live in
-- schema.prisma and is written here deliberately — `Tier.isDefault` carries the
-- comment saying where to find it. Postgres leaves every `false` row outside
-- the index, so any number of tiers may be non-default and at most one may be
-- default. Two concurrent attempts to move the default cannot both land.
--
-- Zero defaults is a legal state, and the one a fresh install is in: an account
-- with no assignment then holds no tier and is offered no tiered voice. That
-- fails closed, which is right. The alternative — treating "the first tier" as
-- the default when none is marked — prices somebody's calls off an arbitrary
-- row.
CREATE UNIQUE INDEX "Tier_isDefault_key" ON "Tier" ("isDefault") WHERE "isDefault";
