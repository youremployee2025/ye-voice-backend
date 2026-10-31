-- Adds the DID a campaign dials from.
--
-- Additive only: one nullable column, one foreign key, one index. No existing
-- row is read or changed, and no existing migration is touched or re-dated.

-- Metadata-only on Postgres 11+: a nullable ADD COLUMN with no default does not
-- rewrite the table, so this is instant however many campaigns exist.
ALTER TABLE "Campaign" ADD COLUMN "phoneNumberId" TEXT;

-- AddForeignKey
-- SET NULL, not RESTRICT, matching "Campaign_agentId_fkey" and for the same
-- reason: a PhoneNumber is the platform's record and a campaign is the
-- customer's. A campaign must not be able to pin a DID row in place, and a
-- campaign left without a number is an accurate description of what happened.
--
-- Every row is NULL at this point, so nothing can violate the constraint. It is
-- still added NOT VALID and validated in the next migration, because a plain
-- ADD CONSTRAINT validates on creation and holds ACCESS EXCLUSIVE on "Campaign"
-- — every read and write blocked — for a full scan probing "PhoneNumber"'s
-- primary key. NOT VALID takes the lock only long enough to record the
-- constraint, and enforces on every insert and update from that instant.
--
-- The lock_timeout is what keeps a deploy from queueing behind a long-running
-- reader and then blocking every campaign query behind itself.
SET lock_timeout = '3s';

ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_phoneNumberId_fkey"
  FOREIGN KEY ("phoneNumberId") REFERENCES "PhoneNumber"("id")
  ON DELETE SET NULL ON UPDATE CASCADE
  NOT VALID;

-- CreateIndex
-- Serves the constraint's own lookups, and the "which campaigns dial from this
-- number" question the release path will eventually have to ask.
CREATE INDEX "Campaign_phoneNumberId_idx" ON "Campaign"("phoneNumberId");
