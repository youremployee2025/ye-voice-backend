-- `Campaign.agentId` has been an unconstrained string since the campaigns
-- slice, filled from a free-text field. Anything could be in it: a typo, an id
-- whose agent has since been removed, or another workspace's agent id.
--
-- Postgres refuses to add a foreign key while any row violates it, so the
-- column is cleaned here rather than failing a deploy.
--
-- This clears exactly what the constraint requires and nothing more: rows whose
-- agent id names no Agent at all. It deliberately does NOT also clear pointers
-- to an agent that exists but sits in another workspace, or in none.
--
-- Those rows are not corruption, they are the "unavailable" state. Unassignment
-- is a routine, reversible staff UPDATE, so a campaign whose agent happens to
-- be sitting in the pool at deploy time has made a valid choice that staff will
-- likely undo within the hour. Nulling it would destroy that choice
-- irreversibly, with nothing recording what it was — and would collapse
-- "unavailable" into "not set", which is the one distinction the serializer
-- goes out of its way to keep on the wire.
--
-- Nor would clearing them buy a durable invariant. The running system re-creates
-- cross-workspace and unassigned pointers continuously through staff
-- reassignment, and that is fine, because every reader re-resolves ownership
-- rather than trusting the column. A one-time sweep cannot hold a property the
-- system does not maintain; it can only lose data.
--
-- Set-based and ordering-independent: re-running it changes nothing.
UPDATE "Campaign" c SET "agentId" = NULL
WHERE c."agentId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Agent" a WHERE a."id" = c."agentId"
  );

-- AddForeignKey
-- SET NULL, not RESTRICT: an agent is the platform's record and a campaign is
-- the customer's. A campaign must not be able to pin an agent row in place,
-- and a campaign left without an agent refuses to start, which is accurate.
--
-- NOT VALID, validated in the next migration. A plain ADD CONSTRAINT validates
-- on creation, holding ACCESS EXCLUSIVE on "Campaign" — every read and write
-- blocked — for a full scan probing "Agent"'s primary key, with the UPDATE
-- above added to that hold because Prisma wraps this file in one transaction.
--
-- NOT VALID takes the lock only long enough to record the constraint, and it
-- enforces on every insert and update immediately. That last part also closes a
-- hole the one-step version has: in READ COMMITTED the validating scan takes a
-- fresh snapshot, so a row written by still-running old code between the UPDATE
-- and the ALTER is visible to it, violates the constraint, and aborts the whole
-- deploy. Here there is no window to write into.
SET lock_timeout = '3s';

ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id")
  ON DELETE SET NULL ON UPDATE CASCADE
  NOT VALID;
