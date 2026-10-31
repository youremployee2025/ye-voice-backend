-- `accountId` means WHO ACTED. A grant and a revoke have no identifiable
-- actor — the staff console holds one shared `ADMIN_STAFF_TOKEN`, so the
-- request names nobody — and the account in the URL is the one the flag was
-- done TO. Writing it into `accountId` made one column mean two opposite
-- things, discriminated only by the `method` string, so filtering the audit
-- trail by an account mixed what it did with what was done to it.

-- The actor becomes optional, and stops taking the trail with it. Cascade on
-- this key erased every record of what a super admin did the moment their
-- account was deleted, which is the one table whose job is to outlive them.
ALTER TABLE "SuperAdminAction" DROP CONSTRAINT "SuperAdminAction_accountId_fkey";
ALTER TABLE "SuperAdminAction" ALTER COLUMN "accountId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "SuperAdminAction" ADD COLUMN "subjectAccountId" TEXT;

-- Rows written before this migration put the recipient in `accountId`. There
-- are none in production — the feature has never been deployed — but the
-- branch's own development databases carry them.
UPDATE "SuperAdminAction"
SET "subjectAccountId" = "accountId", "accountId" = NULL
WHERE "method" IN ('GRANT', 'REVOKE');

-- CreateIndex
CREATE INDEX "SuperAdminAction_subjectAccountId_createdAt_idx" ON "SuperAdminAction"("subjectAccountId", "createdAt");

-- AddForeignKey
ALTER TABLE "SuperAdminAction" ADD CONSTRAINT "SuperAdminAction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuperAdminAction" ADD CONSTRAINT "SuperAdminAction_subjectAccountId_fkey" FOREIGN KEY ("subjectAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
