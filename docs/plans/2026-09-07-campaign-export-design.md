# Campaign export — design

**Date:** 2026-09-07
**Status:** built — see `CLAUDE.md` § The campaign exports for the shipped surface

Two CSV exports per campaign, at byte-identical header parity with the Convin
export they replace (`activate.convin.ai/tenant/ezo`). Reference files:
`Autopay_Touchbase_September_2026_leads_*.csv` (1500 rows, 141 columns) and
`ai_call_detail_<campaignId>_*.csv` (5328 rows, 27 columns).

## What we already store, and what we do not

Established by reading the schema, not by assumption:

- **Extraction: stored.** `CallAttempt.extraction Json?`, written by the
  `session.completed` webhook from `data.extraction.values`
  (`webhookOutcome.ts:437`). Campaign calls only.
- **Transcripts: not stored — REVISED, see the addendum below.** The webhook payload carries
  `data.transcript` and this service discards it. The old `ezo-backend`
  persisted it (`Call.transcript`); the rewrite dropped it. Not needed for
  either export — neither Convin file has a transcript column.
- **Pre-call variables: effectively stored.** `dialer.ts:600` computes them and
  forgets them, but at contact grain they are reproducible from
  `Contact.metadata` through `Campaign.variableMap` — see "Variables" below.
- **`hangup_source`: sent by the platform, not stored.** The old repo kept it
  (`Call.hangupSource`, `webhookProcessor.ts:362`); the rewrite reads only
  `hangup_cause`. It survives as a live read on call detail
  (`serialize.ts:1202`). **This is the one schema gap and the one backfill.**
- **Tool executions: genuinely absent.** No such field in either repo. Platform
  tool logs live only behind the admin session-dump route, a different backend
  behind a debug token. Empty in all 5328 rows of the reference file. The three
  columns are emitted, always blank — **on the call-detail sheet only.** This
  document originally put them on both; the leads file has no such columns, and
  the header fixture caught it on its first run.

## Surface

    GET /:workspaceId/campaigns/:campaignId/export/leads
    GET /:workspaceId/campaigns/:campaignId/export/calls

Mirrors `analytics/export` exactly: `requireAuth` + `requireMembership()`,
campaign resolved against the workspace before anything else (a foreign id,
an unmapped one and nonsense all 404 alike — an unresolved filter must never
fall through to exporting everything), streamed rather than assembled,
`Content-Type: text/csv; charset=utf-8`, `Cache-Control: private, no-store`,
`X-Content-Type-Options: nosniff`.

Both reuse `toCsvLine`/`csvCell` from `analyticsExport.ts` unchanged, including
its formula-injection guard — which matters more here than there, because the
leads file carries free-text extraction reasons written by a language model.

## The leads file — one row per `CampaignContact`

Column groups, in Convin's order:

1. **Identity** — `Lead Link`, `Lead ID` (= `CampaignContact.id`, the
   assignment, not the person), `Visitor ID` (always empty; YE has no such
   concept), `External ID`, `Lead Created Date`, `Lead Name`, `Lead State`,
   `Lead Ownership` (constant `ai`), `Phone Number`.
2. **Interest** — `Lead Interest` and `Lead Interest Reason`: the campaign's
   lead bucket and the prose behind it.
3. **Campaign** — id, name, status, start date.
4. **Call aggregates** — attempts, connected calls, connected seconds, first
   and last call timestamps, last status, last disconnected-by, caller id used,
   DND flag.
5. **`Lead Metric <Key>` + `Lead Metric <Key> Reason`** — the extraction.
6. **Variables** — the `tb_*` group.
7. **`Lead Entity <Key>`** — the rest of the extraction.

No tool columns on this sheet. See the correction above.

### Which extraction speaks for a contact

**The existing rule, reused verbatim — not a new one.** `campaignBuckets.ts`
already answers this: the latest attempt that has a non-null extraction **and**
a disposition in `REACHED_DISPOSITIONS`. Both halves are load-bearing and each
was a production bug:

- A later dial that extracted nothing must not erase what an earlier one
  learned — absent is not an answer.
- A voicemail's extraction is not an answer either. The post-call model fills
  in every key it is given, so a machine that beeped for thirty seconds is
  graded as confidently as a four-minute conversation. On the two September
  Touchbase campaigns that was 27 contacts of 843 (PR #48).

The export MUST use the same `DISTINCT ON` predicate, or a lead's export row
will contradict the bucket chip the dashboard shows for that same lead.

### Which keys become columns, and the Metric/Entity split

Derived from the data, not from config:

    SELECT DISTINCT jsonb_object_keys(extraction) FROM "CallAttempt"
    WHERE "campaignId" = $1 AND extraction IS NOT NULL

riding `call_attempts_campaign_extraction_idx`. Then:

> **A key with a sibling `<key>_reason` is a Metric. A key without one is an
> Entity.**

Verified against the reference file: it reproduces Convin's split exactly —
all ten Metrics have a Reason, none of the five Entities do. Reason keys are
consumed by their parent and never emitted as columns of their own.

`Lead Interest` is the value of `Campaign.leadBucketKey`; `Lead Interest Reason`
is its `_reason` sibling. When the campaign sorts no leads, both are empty.

Reserved keys (`*_vocobaseplatform`, `callback_at`, `callback_requested_at`)
are filtered out — they are YE's own machinery, already surfaced as first-class
columns, and Convin's file has no equivalent.

### Variables

The `tb_*` columns are **agent variable names**, not CSV column names.
`Campaign.variableMap` is `{ csvColumn: agentVariable }`, so the header is its
*values* (or `Agent.variables` when no map is saved) — campaign-level config,
stable, needing no data scan. Values come from `variablesFor()` in `dialer.ts`,
**called directly rather than reimplemented**, so the export shows exactly what
a dial sends, with the same metadata-plus-lifted-columns precedence and the same
empty-string-for-a-mapped-miss semantics.

Two honest limits, to be stated in the route's doc comment: this is what a dial
would send *now* (a `variableMap` edited mid-campaign is not versioned), and it
excludes the goal variables the dialer spreads in afterwards — which Convin's
file has no columns for anyway.

### Lead Link

YE has no per-lead deep link: the journey dialog is deliberately not
URL-addressable (`campaigns/[id]/page.tsx:64-74`). The export emits
`<APP_URL>/campaigns/<campaignId>?contact=<campaignContactId>`, and the
dashboard is taught to honour that param — a link in the first column that
opens nothing is worse than no column.

## The call-detail file — one row per `CallAttempt`

Direct column mappings, all from stored data: `Call Attempt ID` = `id`,
`Call Direction` = constant `Outbound`, `From Phone Num` = `fromNumber`,
`Attempt Number` = `attemptNo`, timestamps from `startedAt`/`answeredAt`/
`endedAt`, `Call Duration (Seconds)` = `durationSecs`.

**Pulse billing maps exactly**: `Call Pulse Unit` = `<billingIncrementSecs>s`,
`Call Pulse Count` = `billedSecs`. In the reference file the unit is `1s` and
the count equals the duration, which is per-second billing — the same shape
YE's pulse fields carry. Both are null on attempts settled before pulse
billing existed, and null is emitted as empty, never as zero: the schema is
explicit that "not recorded" and "zero" are different facts.

**Disconnect columns**, derived from the new `hangupSource` beside the existing
`hangupCause`. The reference file's value counts constrain the mapping:
`Disconnect Reason Key` is 1278 `user` / 276 `voicebot_hangup` / 3774 empty,
while `Telephony Disposition` splits the same 1278 into 1250 "User connection
lost" and 28 "User disconnected" — so the key comes from the *source* and the
disposition from source-plus-cause. **The exact mapping table is to be built
against real `hangupSource`/`hangupCause` distributions from the production
database, not guessed.** Until it is verified, `Disconnect Reason Key` and
`Call Disconnected By` ship (they need the source alone) and
`Telephony Disposition` ships empty rather than wrong.

## The schema change and the backfill

One column: `CallAttempt.hangupSource String?`. Verbatim upstream free text,
never an enum — same reasoning as `disposition` and `hangupCause` beside it.

**Forward:** read it in `webhookOutcome.ts` everywhere `hangup_cause` is
already read (lines 179, 375, 417), from `data.call.hangup_source` then
`data.hangup_source`. Whether the webhook actually carries it is *unproven* —
the old repo read both spellings defensively with no fixture behind it — which
is precisely why the backfill below is not optional and is not one-shot.

**Backfill:** page `GET /calls` and match `upstreamCallId` against
`CallAttempt`. The listing carries `hangup_cause`, `hangup_source`,
`disposition`, `answered_by`, durations and timestamps
(`docs/plans/2026-08-28-call-history-design.md:36`), so this costs one request
per hundred calls rather than one per call. It reuses `analyticsIngest.ts`'s
existing walk — same partner-wide listing, same 100-row page, same
correlation-id attribution — but writes to `CallAttempt` for rows the ingest
deliberately *skips* as campaign calls.

Run as a script first (`scripts/backfill-hangup-source.ts`), then as a periodic
reconciliation, which also self-heals the missed-webhook case.

## Testing

- `toCsvLine` reuse means injection guarding is already covered; the new tests
  are about **shape**, not escaping.
- Header parity is asserted against the two reference files checked into
  `test/fixtures/` — the header line, byte for byte, is the contract.
- The extraction-selection test must include a contact whose latest attempt is
  a **voicemail with a populated extraction** over an earlier reached call.
  That is the PR #48 regression and a fixture without it proves nothing.
- The Metric/Entity split test must include a key with no `_reason` sibling and
  one with, in the same campaign.
- A `variableMap` test must include a `phone`/`name`/`email`/`tags` metadata
  column, because `storageKey` and the raw header agree everywhere else and a
  test over `city`/`plan` is vacuous.


## What changed while building it

Two things this document got wrong, both caught by tests rather than by
review:

- **The tool columns are on the call detail only.** Written here as belonging
  to both files. `test/fixtures/convin-export-headers.json` holds the reference
  headers and the "adds nothing of its own" case failed immediately, which is
  what the fixture is for.
- **Phone numbers are formula-guarded, so the leads file is not byte-identical
  after all.** Every number is E.164 and begins with a character a spreadsheet
  reads as a formula; the reference file writes them bare. This service has
  neutralised that on every export it ships, and re-introducing a known
  injection vector to match a competitor byte for byte is not a trade worth
  making. The apostrophe is invisible in a spreadsheet and the digits are
  unchanged. Pinned by its own case so it reads as a decision.

## Still open

- **`Telephony Disposition` is empty.** Needs a measured
  `hangupSource` × `hangupCause` distribution from production before the
  mapping can be written; see the design note above.
- **`Lead Link` points at `?contact=<campaignContactId>`, which the dashboard
  does not yet honour.** The journey dialog is deliberately not URL-addressable
  (`campaigns/[id]/page.tsx`), so the link opens the campaign rather than the
  lead. The dashboard change is small and belongs with this wave.
- **`External ID` is read from contact metadata** under three spellings. Which
  column a customer's upload actually carries has not been confirmed against a
  real import.


---

# Addendum, 2026-09-08: keeping what the platform sends

This document reasoned that a transcript backfill was impractical, on two
grounds. **Both were wrong**, and the record is more useful than the
conclusion.

**"Transcripts are only retrievable by fetching per call."** True, and not a
limitation — fetching per call *is* what a backfill is. The listing carries no
transcript, so the walk costs one request per call rather than one per hundred;
that is a cost difference, not an impossibility, and describing a mechanism as
though it were an obstacle is how a feasible thing gets declined.

**"The storage cost is real."** The 4.3 GB figure cited was the *platform's*
`sessions` table across every customer and all history. The reference export
was 5,328 calls for one campaign; at a few KB of text each that is tens of
megabytes. Not a reason to decline anything.

The precedent also already existed and was not consulted:
`scripts/reextract/run.ts` walks a whole campaign fetching one session dump per
contact, at concurrency 4 in batches of 20, with resume and an advisory lock,
and has run over the September Touchbase campaigns.

## What was actually stored as a result

`transcript`, `variables`, `recordingAvailable` and `billDurationSeconds` on
`CallAttempt` — everything `GET /calls/:id` returns that this product renders
and was fetching live, plus one field the journey was *guessing* at. Written by
the webhook and the reaper; recovered by `npm run backfill:session`.

Two exclusions stand and are not oversights: `credits_used` publishes the
margin, and a recording **URL** expires in seven days while being a bearer
credential that outlives any membership check — so the flag is stored and the
URL never is.

## The question this leaves

**Vocobase's transcript retention is unknown.** `SessionLog` bot logs are
pruned after `SESSION_LOG_RETENTION_DAYS` (default 30) and the dump route says
so explicitly; nothing establishes the retention on a session's transcript. If
it is bounded, the window to recover the September campaigns is closing, and
the backfill's `gone` count is the measurement — it reports exactly how much
the platform no longer holds. **Run it against one old campaign first and read
that number** before assuming the history is safe.
