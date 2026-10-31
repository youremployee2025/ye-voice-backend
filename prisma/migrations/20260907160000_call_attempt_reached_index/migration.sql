-- The attempts that reached somebody, indexed by the campaign that placed them.
--
-- `campaignOutcomes` folds a campaign's attempts to one row per contact to
-- answer "have we ever spoken to this lead". Without an index the disposition
-- is not reachable from one, so that fold reads every attempt the campaign ever
-- made — on a workspace list that draws every campaign it has, which is the one
-- page whose whole job is to load quickly.
--
-- PARTIAL, on the two literals `REACHED_DISPOSITIONS` names. A conversation is
-- a small minority of a dialer's attempts, so the index holds a fraction of the
-- table and the planner can take the reached rows straight out of it. The
-- predicate is spelled out rather than parameterised because a partial index
-- has to be a constant expression; it is the same pair asserted by name in
-- `analytics-service.test.ts`, so a tier edited there fails that test rather
-- than silently leaving this index matching nothing.
--
-- `campaignContactId` rides along as a second key column so the fold is an
-- index-only scan: both columns it groups on come out of the index and the
-- heap is not touched at all.
CREATE INDEX "call_attempts_campaign_reached_idx"
  ON "CallAttempt" ("campaignId", "campaignContactId")
  WHERE "disposition" IN ('completed', 'transferred');
