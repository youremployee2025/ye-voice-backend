-- The workspace's own customer on the voice platform. Null until the first
-- integration is connected: the customer is created on demand, so no existing
-- workspace has one and none needs one until somebody connects Google.
--
-- Unique rather than merely indexed. The upstream create is idempotent on
-- `external_id = workspace.id`, so two requests racing the first use both come
-- back holding the same customer id; the constraint is what turns the loser of
-- that race into a re-read of the winner's row rather than a second write.
ALTER TABLE "Workspace" ADD COLUMN "partnerCustomerId" TEXT;

CREATE UNIQUE INDEX "Workspace_partnerCustomerId_key" ON "Workspace"("partnerCustomerId");
