-- Lead buckets: which extracted answer sorts a campaign's leads, and which of
-- its values count as won.
--
-- Membership is computed at READ time out of `CallAttempt.extraction`, never
-- stamped onto a contact, so choosing a key — or changing it — re-reads the
-- campaign's own history rather than only affecting calls placed afterwards.
-- An operator does not know which answer matters until they have the answers,
-- and a campaign that finished last week is exactly the one worth sorting.
--
-- Both nullable-or-defaulted, so this is a catalog-only change on a table the
-- dispatcher reads every pass: no rewrite, and `lock_timeout` bounds the wait
-- for the brief exclusive lock rather than letting one long read queue every
-- writer behind us.
SET lock_timeout = '3s';

ALTER TABLE "Campaign" ADD COLUMN "leadBucketKey" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "wonBuckets" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- The bucket readout's own query: the latest attempt per contact within one
-- campaign that carries extraction at all.
--
-- It reads DISTINCT ON ("campaignContactId") … ORDER BY "campaignContactId",
-- "attemptNo" DESC under a "campaignId" predicate, which this index answers in
-- order. Without it the plan is the campaign's whole attempt history sorted in
-- memory on every stats load — and a campaign is allowed a hundred thousand
-- contacts.
--
-- Partial on the extraction column, because a campaign whose agent extracts
-- nothing has no rows here at all and should not carry an index of them — and
-- raw SQL with a name of its own for the same reason
-- `campaign_contacts_callback_claim_idx` is: Prisma cannot express the
-- predicate, so declaring it in the schema would drop the predicate.
CREATE INDEX "call_attempts_campaign_extraction_idx"
  ON "CallAttempt" ("campaignId", "campaignContactId", "attemptNo" DESC)
  WHERE "extraction" IS NOT NULL;
