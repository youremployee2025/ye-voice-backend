-- Campaign parity: the retry ladder, callbacks, number rotation, scheduling,
-- lane concurrency and the counters the read surface needs.
--
-- Three of the columns are RENAMED rather than dropped and re-added. Prisma
-- generates DROP + ADD for a rename, which on these three would discard every
-- customer's retry policy and concurrency setting and silently replace them
-- with defaults. The renames below are hand-written for that reason, and each
-- carries the data conversion its new meaning requires.

-- ---------------------------------------------------------------------------
-- Campaign: renames first, so the conversions below read one set of columns.
-- ---------------------------------------------------------------------------

-- `maxAttempts` counted DIALS; `retryCount` counts what happens AFTER the
-- first one. Three dials is two retries.
ALTER TABLE "Campaign" RENAME COLUMN "maxAttempts" TO "retryCount";
ALTER TABLE "Campaign" RENAME COLUMN "retryDelayMins" TO "cooldownMinutes";
ALTER TABLE "Campaign" RENAME COLUMN "concurrency" TO "concurrencyLimit";

-- A rename keeps the old column default, so the new defaults are set here.
-- `retryCount` moves 3 → 2 for the same reason its values do.
ALTER TABLE "Campaign" ALTER COLUMN "retryCount" SET DEFAULT 2;
ALTER TABLE "Campaign" ALTER COLUMN "cooldownMinutes" SET DEFAULT 30;
ALTER TABLE "Campaign" ALTER COLUMN "concurrencyLimit" SET DEFAULT 2;

-- ---------------------------------------------------------------------------
-- Campaign: the new columns.
-- ---------------------------------------------------------------------------

-- Nullable adds and adds with a constant default are both metadata-only on
-- Postgres 11+, so none of this rewrites the table.
ALTER TABLE "Campaign"
  ADD COLUMN "description"        TEXT,
  ADD COLUMN "retryDelaysMinutes" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN "retryConcurrency"   INTEGER   NOT NULL DEFAULT 0,
  ADD COLUMN "callbackEnabled"    BOOLEAN   NOT NULL DEFAULT true,
  ADD COLUMN "variableMap"        JSONB,
  ADD COLUMN "stoppedAt"          TIMESTAMP(3),
  ADD COLUMN "scheduledStartAt"   TIMESTAMP(3),
  ADD COLUMN "scheduleError"      TEXT,
  ADD COLUMN "rrCursor"           INTEGER   NOT NULL DEFAULT 0,
  ADD COLUMN "totalContacts"      INTEGER   NOT NULL DEFAULT 0,
  ADD COLUMN "completedCount"     INTEGER   NOT NULL DEFAULT 0,
  ADD COLUMN "failedCount"        INTEGER   NOT NULL DEFAULT 0,
  ADD COLUMN "skippedCount"       INTEGER   NOT NULL DEFAULT 0,
  ADD COLUMN "startedAt"          TIMESTAMP(3),
  ADD COLUMN "pausedAt"           TIMESTAMP(3),
  ADD COLUMN "completedAt"        TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- CampaignContact: the new columns, then the conversion.
-- ---------------------------------------------------------------------------

ALTER TABLE "CampaignContact"
  ADD COLUMN "nextEligibleAt" TIMESTAMP(3),
  ADD COLUMN "callbackAt"     TIMESTAMP(3),
  ADD COLUMN "callbackCount"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastSessionId"  TEXT,
  ADD COLUMN "disposition"    TEXT,
  ADD COLUMN "answeredBy"     TEXT;

-- `attempts` changes meaning from DIALS MADE to RETRIES CONSUMED, and
-- eligibility moves from a query-time formula over `lastAttemptAt` to a stored
-- `nextEligibleAt`. Both conversions run in ONE statement, because the two
-- depend on the same before-value and a second pass would read the first's
-- output.
--
-- The split is between rows that will be dialed again and rows that will not,
-- and it is not cosmetic. Under the new rule the counter is incremented by the
-- retry RE-ARM, so a contact waiting for retry #1 already carries 1 while a
-- contact that exhausted n dials carries n-1. Applying `attempts - 1`
-- uniformly would hand every waiting contact one extra call.
--
-- `retryCount` still holds the old dial budget at this point (the value
-- conversion is below), so the waiting test is the old dialer's own predicate:
-- dials made < dials allowed.
--
-- `nextEligibleAt` reproduces the retry delay that used to be computed at
-- query time. A NULL `lastAttemptAt` leaves it NULL, which reads as "due now"
-- and is correct for a contact nobody has dialed.
UPDATE "CampaignContact" cc
SET
  attempts = CASE
    WHEN cc.status IN ('PENDING', 'FAILED') AND cc.attempts < c."retryCount"
      THEN cc.attempts
    ELSE GREATEST(cc.attempts - 1, 0)
  END,
  status = CASE
    WHEN cc.status = 'FAILED' AND cc.attempts < c."retryCount"
      THEN 'PENDING'::"CampaignContactStatus"
    ELSE cc.status
  END,
  "nextEligibleAt" = CASE
    WHEN cc.status IN ('PENDING', 'FAILED')
     AND cc.attempts < c."retryCount"
     AND cc."lastAttemptAt" IS NOT NULL
      THEN cc."lastAttemptAt" + make_interval(mins => c."cooldownMinutes")
    ELSE NULL
  END
FROM "Campaign" c
WHERE c.id = cc."campaignId";

-- ---------------------------------------------------------------------------
-- Campaign: the value conversions, after the contacts have read the old ones.
-- ---------------------------------------------------------------------------

-- Three dials becomes two retries. Clamped to the new [0,20] range so a value
-- written outside the API cannot be frozen in place by a column that no longer
-- validates it.
UPDATE "Campaign" SET "retryCount" = LEAST(GREATEST("retryCount" - 1, 0), 20);

-- A zero cooldown is the dispatcher re-dialing a number the moment it hung up.
-- The old column allowed it; the new one starts at 1.
UPDATE "Campaign" SET "cooldownMinutes" = GREATEST("cooldownMinutes", 1);

-- The counters describe what the contact rows already say, so they are seeded
-- from them rather than from zero. Every write from here on maintains them in
-- the same transaction as the status change they describe.
UPDATE "Campaign" c
SET
  "totalContacts"  = counts.total,
  "completedCount" = counts.completed,
  "failedCount"    = counts.failed,
  "skippedCount"   = counts.skipped
FROM (
  SELECT
    "campaignId",
    -- EXCLUDED stays out of the roster, exactly as the runtime keeps it: an
    -- exclude decrements totalContacts, and the outcomes partition buckets it
    -- nowhere. Counted here, every pre-migration removal would leave the four
    -- outcome numbers summing short of totalContacts forever.
    COUNT(*) FILTER (WHERE status <> 'EXCLUDED')        AS total,
    COUNT(*) FILTER (WHERE status = 'COMPLETED')        AS completed,
    COUNT(*) FILTER (WHERE status = 'FAILED')           AS failed,
    COUNT(*) FILTER (WHERE status = 'SKIPPED')          AS skipped
  FROM "CampaignContact"
  GROUP BY "campaignId"
) AS counts
WHERE c.id = counts."campaignId";

-- ---------------------------------------------------------------------------
-- Contact: the columns the CSV importer will start recognising.
-- ---------------------------------------------------------------------------

ALTER TABLE "Contact"
  ADD COLUMN "email" TEXT,
  ADD COLUMN "tags"  TEXT[] DEFAULT ARRAY[]::TEXT[];

-- ---------------------------------------------------------------------------
-- CampaignPhoneNumber: the dialing rotation.
-- ---------------------------------------------------------------------------

CREATE TABLE "CampaignPhoneNumber" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignPhoneNumber_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignPhoneNumber_phoneNumberId_idx" ON "CampaignPhoneNumber"("phoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignPhoneNumber_campaignId_phoneNumberId_key" ON "CampaignPhoneNumber"("campaignId", "phoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignPhoneNumber_campaignId_position_key" ON "CampaignPhoneNumber"("campaignId", "position");

-- AddForeignKey
-- Validated on creation rather than NOT VALID, unlike the CallAttempt keys
-- below: the referencing table is empty at this instant, so the scan is a
-- no-op and the lock is held for microseconds.
ALTER TABLE "CampaignPhoneNumber" ADD CONSTRAINT "CampaignPhoneNumber_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignPhoneNumber" ADD CONSTRAINT "CampaignPhoneNumber_phoneNumberId_fkey" FOREIGN KEY ("phoneNumberId") REFERENCES "PhoneNumber"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The rotation a campaign already has: its single caller number, at the front.
-- `gen_random_uuid()` rather than a cuid because the id shape is not load
-- bearing — nothing parses it, and cuid has no SQL implementation.
INSERT INTO "CampaignPhoneNumber" ("id", "campaignId", "phoneNumberId", "position", "createdAt")
SELECT gen_random_uuid()::text, c.id, c."phoneNumberId", 0, NOW()
FROM "Campaign" c
WHERE c."phoneNumberId" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- CampaignContact indexes.
-- ---------------------------------------------------------------------------

-- CreateIndex
CREATE INDEX "CampaignContact_campaignId_status_nextEligibleAt_idx" ON "CampaignContact"("campaignId", "status", "nextEligibleAt");

-- CreateIndex
CREATE INDEX "CampaignContact_campaignId_callbackAt_idx" ON "CampaignContact"("campaignId", "callbackAt");

-- CreateIndex
-- The callback lane's own index, and raw SQL because Prisma cannot express a
-- partial index. The lane reads a vanishingly small slice of a large table —
-- armed promises among every contact ever queued — so the partial predicate is
-- what keeps it small enough to stay in cache.
CREATE INDEX "campaign_contacts_callback_claim_idx"
  ON "CampaignContact" ("campaignId", "callbackAt")
  WHERE "status" = 'PENDING' AND "callbackAt" IS NOT NULL;

-- CreateIndex
CREATE INDEX "Campaign_status_scheduledStartAt_idx" ON "Campaign"("status", "scheduledStartAt");

-- ---------------------------------------------------------------------------
-- CallAttempt: rotation, resolution time, the dial token, and survival.
-- ---------------------------------------------------------------------------

ALTER TABLE "CallAttempt"
  ADD COLUMN "fromNumber" TEXT,
  ADD COLUMN "resolvedAt" TIMESTAMP(3);

-- When the outcome was applied. For rows that already settled, that is when
-- the call ended: the two instants differed by the webhook's flight time, and
-- inventing NOW() here would print a cooldown of months on old history.
UPDATE "CallAttempt"
SET "resolvedAt" = "endedAt"
WHERE "endedAt" IS NOT NULL AND status IN ('COMPLETED', 'FAILED', 'ABANDONED');

-- `attemptNo` was derived from the contact's dial counter, and a launch that
-- was given back decremented that counter — so a contact whose first launch
-- failed transiently has two rows numbered 1. The unique below would refuse
-- to build over them.
--
-- Only contacts that actually collide are renumbered, and they are renumbered
-- by the order they were dialed in, which is what the column claims to mean.
WITH colliding AS (
  SELECT "campaignContactId"
  FROM "CallAttempt"
  GROUP BY "campaignContactId", "attemptNo"
  HAVING COUNT(*) > 1
),
renumbered AS (
  SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY "campaignContactId" ORDER BY "startedAt", id) AS n
  FROM "CallAttempt"
  WHERE "campaignContactId" IN (SELECT "campaignContactId" FROM colliding)
)
UPDATE "CallAttempt" a
SET "attemptNo" = r.n
FROM renumbered r
WHERE a.id = r.id;

-- CreateIndex
-- The dial mutual-exclusion token. `campaignContactId` becomes nullable below,
-- and NULLs are distinct in a Postgres unique index, so attempt rows orphaned
-- by a campaign deletion never collide with each other.
CREATE UNIQUE INDEX "CallAttempt_campaignContactId_attemptNo_key" ON "CallAttempt"("campaignContactId", "attemptNo");

-- An attempt row is the billing record as well as the call record, so it must
-- outlive the campaign it was placed for. The cascade that used to delete it
-- deleted the evidence for the charge along with it.
ALTER TABLE "CallAttempt" ALTER COLUMN "campaignId" DROP NOT NULL;
ALTER TABLE "CallAttempt" ALTER COLUMN "campaignContactId" DROP NOT NULL;

ALTER TABLE "CallAttempt" DROP CONSTRAINT "CallAttempt_campaignId_fkey";
ALTER TABLE "CallAttempt" DROP CONSTRAINT "CallAttempt_campaignContactId_fkey";

-- NOT VALID, then validated in the next migration. A plain ADD CONSTRAINT
-- holds ACCESS EXCLUSIVE on "CallAttempt" — the table every sweep, every
-- webhook and every call listing reads — for a full scan probing two primary
-- keys. NOT VALID takes the lock only long enough to record the constraint,
-- and enforces on every insert and update from that instant. This is the same
-- split "Campaign_phoneNumberId_fkey" was added with, and the table is a great
-- deal larger.
SET lock_timeout = '3s';

ALTER TABLE "CallAttempt" ADD CONSTRAINT "CallAttempt_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id")
  ON DELETE SET NULL ON UPDATE CASCADE
  NOT VALID;

ALTER TABLE "CallAttempt" ADD CONSTRAINT "CallAttempt_campaignContactId_fkey"
  FOREIGN KEY ("campaignContactId") REFERENCES "CampaignContact"("id")
  ON DELETE SET NULL ON UPDATE CASCADE
  NOT VALID;
