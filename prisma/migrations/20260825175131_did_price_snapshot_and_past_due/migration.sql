-- AlterEnum
ALTER TYPE "PhoneNumberStatus" ADD VALUE 'PAST_DUE';

-- DropForeignKey
ALTER TABLE "CreditTransaction" DROP CONSTRAINT "CreditTransaction_accountId_fkey";

-- DropForeignKey
ALTER TABLE "CreditTransaction" DROP CONSTRAINT "CreditTransaction_phoneNumberId_fkey";

-- DropForeignKey
ALTER TABLE "CreditTransaction" DROP CONSTRAINT "CreditTransaction_workspaceId_fkey";

-- AlterTable
ALTER TABLE "PhoneNumber" ADD COLUMN     "pastDueSince" TIMESTAMP(3),
ADD COLUMN     "rentedPriceCredits" BIGINT;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_phoneNumberId_fkey" FOREIGN KEY ("phoneNumberId") REFERENCES "PhoneNumber"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill the price snapshot for rentals that already exist.
--
-- Only where the catalog price was set explicitly: a null there means "use the
-- configured default", which lives in the environment and has no SQL
-- equivalent. Those rows keep a null snapshot and the sweep falls back to the
-- same default it charges today, so this backfill changes nobody's bill — it
-- only pins the ones that were already pinned.
UPDATE "PhoneNumber"
   SET "rentedPriceCredits" = "monthlyPriceCredits"
 WHERE "workspaceId" IS NOT NULL
   AND "monthlyPriceCredits" IS NOT NULL
   AND "rentedPriceCredits" IS NULL;
