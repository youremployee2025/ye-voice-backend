-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "SuperAdminAction" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuperAdminAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SuperAdminAction_accountId_createdAt_idx" ON "SuperAdminAction"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "SuperAdminAction_workspaceId_createdAt_idx" ON "SuperAdminAction"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "SuperAdminAction_createdAt_idx" ON "SuperAdminAction"("createdAt");

-- AddForeignKey
ALTER TABLE "SuperAdminAction" ADD CONSTRAINT "SuperAdminAction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuperAdminAction" ADD CONSTRAINT "SuperAdminAction_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
