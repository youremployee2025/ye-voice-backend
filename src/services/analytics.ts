import { Prisma, type CampaignType } from '@prisma/client';
import type { AnalyticsRange } from '../lib/analyticsQuery.js';
import {
  OUTCOMES,
  classifyAttempt,
  classifyOutcome,
  isConnected,
  isUnresolved,
  type CallOutcome,
} from '../lib/callOutcome.js';
import {
  REACHED_ATTEMPT,
  reachedAttemptSql,
  reachedContactsFilter,
} from '../lib/campaignOutcomes.js';
import {
  inboundCredits,
  inboundOutcomeBreakdown,
  inboundRepeatCallers,
  inboundSeries,
  type InboundOutcomeCount,
  type InboundPoint,
} from '../lib/campaignInboundStats.js';
import { isInboundFacing } from '../lib/campaignConfig.js';
import { toDisplayCredits } from '../lib/credits.js';
import { neverPlacedSql } from '../lib/dialBudget.js';
import { prisma } from '../lib/prisma.js';

/**
 * The aggregates, computed over local tables.
 *
 * Nothing here calls the voice platform. The upstream listing accepts paging
 * and nothing else this service can use, so every total computed from it would
 * be a total over the call-history walk's truncated set — and a list that is
 * short is visibly short, while a number that is short is simply wrong.
 *
 * **Two sources, and the split is the whole design.**
 *
 * - `CallAttempt` is the dialer's record of every **campaign** call: written at
 *   dial time, updated by the completion webhook, priced against the tier the
 *   call was launched under. A campaign report reads this and nothing else.
 * - `CallRecord` is the analytics ingest's record of everything **else** on the
 *   shared partner account — inbound, hand-placed, and calls on an agent no
 *   workspace holds. None of it is a campaign call, by construction.
 *
 * The workspace overview reads **both**, because a workspace's calls are both.
 * Reading only the first would make the overview silently campaign-only;
 * reading only the second would report almost nothing on a platform whose
 * traffic is campaigns.
 *
 * Nothing here loads a workspace's calls into Node to count them. `groupBy`
 * where Prisma expresses the query, `$queryRaw` with bound parameters where it
 * does not — which is the daily buckets, since Prisma has no `date_trunc` and
 * cannot union two tables.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The bucket width, and the zone it is computed in.
 *
 * UTC, and emitted in the payload rather than assumed by the reader. A
 * per-workspace zone would have to come from somewhere — a campaign's, the
 * reader's browser, a workspace setting that does not exist — and a chart whose
 * buckets depend on who is looking at it cannot be compared with the one beside
 * it.
 */
const TIMYENE = 'UTC';
const BUCKET = 'day';

/**
 * Per-minute calling **is** billed on this platform.
 *
 * The dialer prices each attempt against the tier it was launched under and
 * writes a `CALL_USAGE` ledger row when the completion webhook lands. The flag
 * stays on the wire rather than being dropped: the dashboard reads it to decide
 * whether to render a credits figure at all, and a surface that hardcoded
 * "billed" would print a number the day somebody turns metering off.
 */
const METERED = true;

export interface AnalyticsTotals {
  calls: number;
  /** Answered plus voicemail: the call reached the far end. */
  connected: number;
  /**
   * `connected / calls`, or **null** when no calls were placed.
   *
   * Null rather than zero. `0` asserts that calls were placed and none
   * connected, which is a different claim and a false one — and it is the claim
   * a reader acts on. Both halves of the fraction ride beside it so the page
   * never has to trust a rate it cannot check.
   */
  answerRate: number | null;
  /**
   * Calls whose outcome is a statement about our knowledge rather than about
   * the call — abandoned, or a carrier value this service does not recognise.
   *
   * Reported beside the rate because they are in its denominator. A page that
   * prints "42% answered" over a set that is a third unreadable is overstating
   * how much it knows, and only this number lets the reader see that.
   */
  unresolved: number;
  totalDurationSecs: number;
  /** Over calls that have a duration; null when none do. */
  avgDurationSecs: number | null;
  /**
   * What the workspace was actually charged for these calls, as a decimal
   * string, or null when nothing was.
   *
   * **Summed from the LEDGER, never from `CallAttempt.costCredits`.** That
   * column also records what was *owed* on a shortfall — a call that completed
   * against a balance too small to cover it, where nothing was debited and the
   * campaign was paused. Adding those in would show a workspace spending
   * credits it still has. The dialer's own campaign stats take the same rule.
   */
  creditsSpent: string | null;
}

export interface SeriesPoint {
  /** `YYYY-MM-DD`, a UTC day. */
  date: string;
  calls: number;
  connected: number;
}

export interface OutcomeCount {
  outcome: CallOutcome;
  count: number;
}

export interface DispositionCount {
  /** Exactly as the carrier sent it; null for a call that carried none. */
  disposition: string | null;
  count: number;
}

export interface CampaignRollup {
  id: string;
  name: string;
  /**
   * Which directions this campaign works in, so a reader knows which of the
   * columns below can mean anything for it.
   *
   * An `INBOUND` campaign places no dials, so `calls`, `connected` and
   * `answerRate` describe an empty population — and a page that printed `0` and
   * `0%` beside a campaign that handled two hundred calls would be stating the
   * opposite of the truth. The page reads this field to render those columns as
   * "not applicable" rather than as measurements.
   */
  type: CampaignType;
  /**
   * Dials PLACED, and nothing else.
   *
   * A received call is not a dial, so it is counted in `inboundCalls` and never
   * folded in here. Summing the two would make `answerRate` a fraction over two
   * different populations — dials that connected, divided by dials plus calls
   * that arrived already connected — which is a number with no question
   * attached to it.
   */
  calls: number;
  connected: number;
  answerRate: number | null;
  /**
   * Calls this campaign ANSWERED, from `CampaignInboundCall`.
   *
   * `0` on an outbound campaign is a true count, not an absence: an OUTBOUND
   * campaign cannot receive a call, so there is nothing here to be missing.
   */
  inboundCalls: number;
  /**
   * What the ledger says this campaign cost, across both directions.
   *
   * The two halves are charged through different keys — a dial's row carries
   * `callAttemptId`, a received call's carries `reference` — so both are read
   * and added. Null only when neither charged anything, so the page can say
   * "no charges" rather than print a zero that reads as "these calls were free".
   */
  creditsSpent: string | null;
}

export interface WorkspaceOverview {
  /**
   * Which population these numbers are over.
   *
   * `workspace` is every call, from both sources. `campaigns` is the campaign
   * calls the filter selected and nothing else — non-campaign calls are not
   * merely absent from it, they are outside the question it answers. The page
   * says which, because a reader cannot tell a filtered total from a quiet week.
   */
  scope: 'workspace' | 'campaigns';
  /** The campaigns the filter selected, echoed; absent when unfiltered. */
  filteredCampaigns?: string[];
  range: AnalyticsRange;
  bucket: typeof BUCKET;
  timezone: typeof TIMYENE;
  metered: typeof METERED;
  totals: AnalyticsTotals;
  /**
   * Where the numbers came from.
   *
   * Emitted because the two halves have different freshness and the reader
   * cannot otherwise tell: campaign calls are recorded as they happen, while
   * everything else arrives on the ingest's interval. A page that presented one
   * figure over both without saying so would make a five-minute-old total look
   * live.
   */
  sources: { campaignCalls: number; otherCalls: number };
  series: SeriesPoint[];
  outcomes: OutcomeCount[];
  dispositions: DispositionCount[];
  campaigns: CampaignRollup[];
  /**
   * When this workspace's earliest call was placed, over **all time**, or null
   * when it has never placed one.
   *
   * Deliberately unbounded by the range, and deliberately a fact about the
   * *workspace* rather than about the ingest. It is what lets a page tell its
   * two empty states apart: "you have never placed a call" is a claim about the
   * reader's business, and "nothing happened in these thirty days" is a claim
   * about the window they chose — and offering the second to a workspace with
   * no calls at all sends them widening a range that will never help, while
   * offering the first to a workspace with four thousand calls last June is
   * simply false.
   *
   * `coverage` cannot answer this and never could. It is platform-wide, because
   * the ingest is, so it says the same thing on every workspace's page; and it
   * describes only the non-campaign half, while these totals span both.
   */
  firstCallAt: Date | null;
}

/**
 * The campaign's shape **since it was created**, not over the selected range.
 *
 * Every stage here is a lifetime figure, and they are all lifetime figures on
 * purpose: a funnel is a set of numbers a reader subtracts from each other, so
 * the one thing it cannot survive is two of its stages counting different
 * spans. `connected` used to be range-scoped while the other three were not,
 * which meant a campaign that ran to completion in June and was opened in
 * August under the default thirty days read "attempted 950, connected 0,
 * completed 900" — three true numbers arranged into a false sentence.
 *
 * The other thing it cannot survive is a stage narrower than the stage after
 * it. `contacts >= attempted >= completed` holds by construction and not by
 * arithmetic: each of the three is counted off `CampaignContact`, and the
 * evidence `attempted` reads is written by the claim every settle passes
 * through. It held only for the counters' sake once, and the population that
 * broke it was the ordinary one — see `attempted` below.
 *
 * The range-scoped counterpart is `totals`, which sits beside this in the same
 * payload. `scope` is on the wire so no reader has to know that from the docs.
 */
export interface CampaignFunnel {
  /** Always `campaign_to_date`. Present so the payload states its own span. */
  scope: 'campaign_to_date';
  contacts: number;
  /**
   * Contacts the dialer has placed, or tried to place, a call for — evidenced
   * by `lastAttemptAt`, which the claim stamps and nothing clears. Never the
   * dial counters: none of the three moves on a contact that answers its first
   * dial and settles. See the count in `campaignAnalytics`.
   */
  attempted: number;
  /**
   * Leads the campaign has reached — **contacts, not calls**, and the same
   * count `lifetime.reached` publishes from the same filter.
   *
   * It counted attempt rows, which is not a stage of this funnel at all: every
   * other stage counts `CampaignContact`, so a reader subtracting one from the
   * next got nonsense, and the figure was unbounded above — on a campaign with
   * a retry ladder most leads connect more than once, so the row read
   * "3026, 202% of contacts" under two stages reading 1500 and drew a bar
   * pinned full. A share of the roster has to be a share.
   *
   * Published twice rather than measured twice: `reachedContactsFilter` is the
   * one definition of "connected" behind the campaign list's ring, the Overview
   * strip and this row. The **calls** reading still exists and still belongs —
   * it is `totals.connected`, beside this in the same payload, where it is a
   * share of calls and is labelled as one.
   */
  connected: number;
  /** Contacts the campaign has finished with. */
  completed: number;
}

/**
 * How one rung of the retry ladder actually did.
 *
 * The distribution this replaces counted how far up the ladder each contact had
 * got and said nothing about what happened there — 558 contacts on their first
 * retry, with no way to tell whether placing that retry was worth anything. The
 * question an operator has about a ladder is whether the next dial picks
 * anybody up, and that is one row per ordinal split two ways.
 *
 * **Unique by construction**, which is the property `funnel.connected` had to
 * be rewritten to get: `unique(campaignContactId, attemptNo)` means a contact
 * contributes at most one row to each ordinal, so neither count can exceed the
 * contacts that reached that rung.
 */
export interface AttemptOutcome {
  /** The dial ordinal. 1 is the first call, 2 the first retry. */
  attemptNo: number;
  /** Dials at this ordinal that reached a person — `reachedAttemptSql`, the
   *  same predicate every other reader of this question uses. */
  connected: number;
  /**
   * Dials at this ordinal that rang and reached nobody.
   *
   * A claim the platform refused (`launchError`) is in **neither** count: no
   * telephone rang, so it is not a lead who did not pick up, and filing it as
   * one reports our own outage as their refusal.
   */
  notConnected: number;
}

/**
 * The campaign-to-date figures the analytics strip reads.
 *
 * **Lifetime, never range-scoped, and that is not an oversight.** Two of the
 * three are per-contact counts, and `CampaignContact` holds only a contact's
 * *current* state — there is no history to slice by date. A talk-time sum
 * bounded by the picker divided by a lifetime contact count is a ratio of two
 * different time spans, which is a number that looks like a measurement and is
 * not one. So the whole block is lifetime and the page says so, which is the
 * arrangement `CampaignFunnel` beside it already uses.
 */
export interface CampaignLifetime {
  /**
   * Leads this campaign has had a conversation with, at any point in its life.
   *
   * Contacts, not calls, unlike `funnel.connected` — a lead rung four times and
   * reached three of them is one. Counted over the ATTEMPTS
   * (`reachedContactsFilter`), so it is **monotonic**: nothing a later dial
   * does can un-hold a conversation that happened.
   *
   * It used to be counted off `CampaignContact.disposition` under a
   * `SETTLED_STATUSES` gate, and both halves of that were wrong in the same
   * direction. The column is the LAST dial's outcome, so a lead followed up
   * into voicemail stopped counting; the gate then dropped everyone the goal
   * follow-up had re-armed to PENDING. On a live touchbase campaign the pair
   * reported 158 where 323 leads had picked up, and the figure FELL as the
   * campaign kept working.
   *
   * **Expected to exceed the reached tier of the outcome bar**, which
   * partitions the roster by where each contact stands now. Two questions, two
   * answers, both published. `/stats` carries this same count as `reached`.
   */
  reached: number;
  /**
   * Contacts the extraction judged done — `goalAchieved`.
   *
   * **Null when the campaign has no goal**, which is a real and different state
   * from zero: the column is null for every contact of such a campaign, so a
   * zero here would report that the bot judged nobody complete when in truth
   * it was never asked.
   *
   * Counted over every contact carrying the verdict, with no status gate, so
   * that it is the same figure `/stats` puts on the goal tile.
   *
   * **A subset of `reached` in every case the platform can produce**, which is
   * what lets the completion rate divide by it. The verdict is written by the
   * post-call extraction, so a contact carrying one has a conversation
   * somewhere in its history — and `reached` now counts that history rather
   * than the state the contact ended in. Under the old count it was NOT a
   * subset (a settle whose last dial was a voicemail kept its verdict and lost
   * its reached flag), which is why the rate used to divide by the roster and
   * read a campaign that had spoken to two thirds of its list as having
   * completed a quarter.
   *
   * Not enforced, though: it is a property of how the verdict is produced, not
   * a constraint the schema carries, so a reader building a rate should still
   * render a ratio above 1 honestly rather than assume it cannot happen.
   */
  /** Never null since 2026-09-06. It used to be null for a campaign with the
   *  goal switch off — "this campaign does not have a verdict" as opposed to
   *  "no contact has one yet" — and there is no such campaign any more. The
   *  wire type stays nullable for a dashboard build that still reads it that
   *  way; nothing produces the null. */
  goalCompleted: number | null;
  /** Every recorded call second on this campaign, over all attempts. */
  talkSecs: number;
  /**
   * The seconds of `talkSecs` spent on calls a person actually took.
   *
   * Here so that an average talk time has a numerator drawn from the same
   * population as its denominator. `talkSecs / reached` is not that average:
   * the numerator carries every voicemail and every ringing no-answer on the
   * campaign while the denominator counts only people who were spoken to, so
   * five real conversations among ninety-five answering machines rendered as
   * ten minutes "per contact".
   *
   * Narrowed to the reached ATTEMPTS, not to every attempt of a reached
   * contact: the voicemails left for a lead before they finally picked up are
   * not time spent talking to them, and rolling those in would push the
   * average back above the length of any conversation that happened.
   */
  reachedTalkSecs: number;
}

/**
 * One rung of the dial ladder: a dial ordinal, and how that dial went.
 *
 * **Ordinals, not lanes.** An earlier cut of this split the ladder by the arm
 * the dial came out of — a retry ladder, a follow-up ladder, a callback ladder
 * — and it answered a question nobody was asking: an operator counts a
 * contact's dials, and reads "attempt 4" as the fourth time that telephone
 * rang, whichever arm chose it. Splitting the rows by lane also made the panel
 * depend on `CallAttempt.kind`, which is nullable on everything dialled before
 * 2026-09-01 and therefore mis-filed a whole campaign's follow-ups as retries.
 * The ordinal needs none of that: it is a count of rows.
 */
export interface DialLadderRung {
  /**
   * 1-based, and it is the contact's own count of dials that RANG — not
   * `CallAttempt.attemptNo`. A claim the platform refused leaves an attempt row
   * behind with no telephone call in it, so the stored ordinal has gaps; the
   * ladder renumbers over the placed rows so that rung 1 is always the first
   * dial that happened, and so that `due` (placed + 1) names the same rung the
   * placed counts do.
   */
  attemptNo: number;
  connected: number;
  notConnected: number;
  /**
   * Contacts still WAITING for this dial — PENDING rows, counted on the rung
   * they are next owed. A rung with nothing due is one this campaign has
   * finished; one with a hundred due is half-placed, and the two are
   * indistinguishable from the placed counts alone.
   */
  due: number;
}

export interface CampaignReport {
  range: AnalyticsRange;
  bucket: typeof BUCKET;
  timezone: typeof TIMYENE;
  metered: typeof METERED;
  campaign: { id: string; name: string };
  totals: AnalyticsTotals;
  funnel: CampaignFunnel;
  lifetime: CampaignLifetime;
  /** One row per dial ordinal, ascending, omitting ordinals nothing rang at. */
  attemptOutcomes: AttemptOutcome[];
  /**
   * The same ordinals, plus what each one still owes.
   *
   * Beside `attemptOutcomes` rather than instead of it, because a dashboard
   * build that reads only the ordinals must keep working across the deploy —
   * the dashboard ships ahead of this service. The difference is `due`: the
   * ordinal rows say how the dials that happened went, and cannot say whether a
   * rung is finished or half-placed, which is the reading an operator retunes a
   * campaign on.
   */
  dialLadder: DialLadderRung[];
  series: SeriesPoint[];
  outcomes: OutcomeCount[];
  dispositions: DispositionCount[];
  /**
   * What this campaign RECEIVED, over the range.
   *
   * Present only when the campaign is inbound-facing, and **absent rather than
   * zeroed** on an OUTBOUND one: a zero here would assert that a campaign
   * which answers calls took none, which is a claim about the business.
   * Absent says the question does not apply.
   *
   * Beside the dialing figures rather than instead of them, because a BOTH
   * campaign does both. On an INBOUND campaign every dialing figure in this
   * report is a truthful zero — there are no `CallAttempt` rows to count,
   * because an attempt row exists only for a call the dialer PLACED — and the
   * dashboard renders this block on its own tab instead of them.
   */
  inbound?: CampaignInboundReport;
}

export interface CampaignInboundReport {
  calls: number;
  /** Distinct `fromNumber`s in the range, so a stranger who rang three times is
   *  one caller whether or not a settle has enrolled them yet. */
  callers: number;
  repeatCallers: number;
  /** Calls with no contact attached at read time. Shrinks as settles enrol. */
  unknownCalls: number;
  talkSecs: number;
  /** Over calls that HAVE a duration; `null` when none do. Never `0` — zero
   *  seconds is a call that ended instantly, and this is a call whose length we
   *  do not know. */
  avgTalkSecs: number | null;
  /** Display credits, as a decimal string, from the LEDGER. `null` when nothing
   *  was charged in the range: a zero under a credits heading reads as "these
   *  calls were free". */
  creditsSpent: string | null;
  series: InboundPoint[];
  /** The bot's own verdict off the call note. */
  outcomes: InboundOutcomeCount[];
  /** The carrier's, which answers a different question. */
  dispositions: DispositionCount[];
  callerHistogram: Array<{ calls: number; callers: number }>;
}

/**
 * The non-campaign scope.
 *
 * `startedAt` is bounded on both ends and non-null by construction, so a call
 * upstream sent with no start time is excluded — it cannot be shown to fall
 * inside the range, and an aggregate that silently admitted undated rows would
 * not be an aggregate over the range it prints.
 */
function recordScope(workspaceId: string, range: AnalyticsRange): Prisma.CallRecordWhereInput {
  return { workspaceId, startedAt: { gte: range.from, lte: range.to } };
}

/**
 * The campaign scope, optionally narrowed to a set of campaigns.
 *
 * A list rather than a single id, because the overview's filter is a
 * multi-select. An **empty** list is not "no filter" — it is a filter that
 * selects nothing, and it must produce nothing; the caller passes `undefined`
 * when it means unfiltered. Getting that backwards would answer a request for
 * zero campaigns with the whole workspace.
 */
function attemptScope(
  workspaceId: string,
  range: AnalyticsRange,
  campaignIds?: readonly string[],
): Prisma.CallAttemptWhereInput {
  return {
    workspaceId,
    startedAt: { gte: range.from, lte: range.to },
    // Redundant with the ownership check the route has already run, and it
    // stays: two independent filters mean a later refactor of that lookup
    // cannot silently widen this query.
    ...(campaignIds ? { campaignId: { in: [...campaignIds] } } : {}),
  };
}

/**
 * The same scope for a campaign that ANSWERS.
 *
 * Its own function rather than a flag on `attemptScope`, because the two differ
 * in the column that decides the window: an attempt is placed at `startedAt`,
 * an inbound call is received at `arrivedAt`, and there is no `startedAt` on
 * the inbound row to get wrong. Sharing one helper would have meant a
 * stringly-typed field name threaded through both.
 *
 * The empty-list rule is `attemptScope`'s, for the reason given there: an empty
 * filter selects nothing and must return nothing.
 */
function inboundScope(
  workspaceId: string,
  range: AnalyticsRange,
  campaignIds?: readonly string[],
): Prisma.CampaignInboundCallWhereInput {
  return {
    workspaceId,
    arrivedAt: { gte: range.from, lte: range.to },
    ...(campaignIds ? { campaignId: { in: [...campaignIds] } } : {}),
  };
}

/**
 * Everything the overview needs to know about the calls this workspace ANSWERED,
 * read once.
 *
 * Read once because two readers need it and they sit beside each other on the
 * page: the campaign table breaks the calls out per campaign, and the credits
 * tile above it sums the spend. Reading the same rows twice would be two
 * chances for a tile and the column under it to disagree — which is the fault
 * this whole surface is written to avoid.
 */
interface InboundHalf {
  /** Calls received, per campaign. */
  calls: ReadonlyMap<string, number>;
  /** What the ledger took for them, per campaign. Internal credits, negative. */
  credits: ReadonlyMap<string, bigint>;
  /** The same spend, summed. Internal credits, negative. */
  totalCredits: bigint;
}

const NO_INBOUND: InboundHalf = { calls: new Map(), credits: new Map(), totalCredits: 0n };

async function inboundHalf(
  workspaceId: string,
  range: AnalyticsRange,
  campaignIds?: readonly string[],
): Promise<InboundHalf> {
  const rows = await prisma.campaignInboundCall.groupBy({
    by: ['campaignId'],
    where: inboundScope(workspaceId, range, campaignIds),
    _count: { _all: true },
  });

  const calls = new Map<string, number>(rows.map((row) => [row.campaignId, row._count._all]));

  // Nothing was received, so there is nothing for the ledger read to join to.
  // The guard is the point: without it, every workspace on the platform — the
  // overwhelming majority of which have never received a call — would pay for
  // the query below on every load of this page.
  if (rows.length === 0) return NO_INBOUND;

  /**
   * The inbound half of the ledger, folded up in one query.
   *
   * A received call's charge carries `reference`, not `callAttemptId` — the row
   * it is about is not an attempt — so a Prisma `groupBy` on `callAttemptId`
   * cannot see it however it is scoped. That is why the credits column read
   * null on every inbound campaign even once its calls were counted.
   *
   * Raw because the join is ledger→call on a text column that is not a declared
   * relation.
   *
   * **`t."workspaceId"` is pinned, and that is not belt-and-braces.**
   * `CreditTransaction` has no index on `reference` alone — the only one
   * carrying it is `@@unique([accountId, reference])`, which a predicate on
   * `reference` by itself cannot use. Without a pin on the ledger side this is
   * a scan of the production ledger on every load of this page, which is the
   * same trap `inboundCredits` (`lib/campaignInboundStats.ts`) documents at
   * length for `/stats`. The workspace is the right pin rather than that
   * function's account: the inbound charge writer stamps the call's own
   * `workspaceId` on the row (`campaignInbound.ts`), so it is the same snapshot
   * `c."workspaceId"` already filters on and it survives an account transfer,
   * which a pin on the workspace's *current* `ownerAccountId` does not.
   */
  const spend = await prisma.$queryRaw<Array<{ campaign_id: string; credits: bigint | null }>>`
      SELECT c."campaignId"           AS campaign_id,
             SUM(t.amount)::bigint    AS credits
        FROM "CampaignInboundCall" c
        JOIN "CreditTransaction" t
          ON t."workspaceId" = ${workspaceId}
         AND t.reference = c.id
         AND t.type = 'CALL_USAGE'
       WHERE c."workspaceId" = ${workspaceId}
         AND c."arrivedAt" >= ${range.from}
         AND c."arrivedAt" <= ${range.to}
         ${
           campaignIds
             ? Prisma.sql`AND c."campaignId" = ANY(${[...campaignIds]}::text[])`
             : Prisma.empty
         }
       GROUP BY 1`;

  const credits = new Map<string, bigint>(spend.map((row) => [row.campaign_id, row.credits ?? 0n]));

  let totalCredits = 0n;
  for (const amount of credits.values()) totalCredits += amount;

  return { calls, credits, totalCredits };
}

/** `connected / calls`, or null. See `AnalyticsTotals.answerRate`. */
function rate(connected: number, calls: number): number | null {
  return calls === 0 ? null : connected / calls;
}

/**
 * How each dial ordinal did, for one campaign over its whole life.
 *
 * One grouped statement: the row count is the length of the campaign's retry
 * ladder — eight rows on a campaign that dials eight times — whatever its call
 * volume, so this does not grow with the campaign.
 *
 * `reachedAttemptSql` rather than the classifier `tally` runs in TypeScript,
 * and the difference is deliberate. That one answers "how did this CALL land",
 * over a vocabulary of nine dispositions, and its `connected` bucket includes a
 * voicemail — the right reading for a chart of calls. This asks whether a
 * person was on the line, which is the question every contact-level reader in
 * the product now asks with one predicate: the list's ring, the Overview
 * strip's `reached`, the lead buckets, and the re-extraction picker.
 *
 * Workspace-scoped as well as campaign-scoped, for the reason `attemptScope`
 * gives: the ownership check the route already ran is a different query, and
 * two independent filters mean a later refactor of that lookup cannot silently
 * widen this one.
 */
async function attemptOutcomesFor(
  workspaceId: string,
  campaignId: string,
): Promise<AttemptOutcome[]> {
  const rows = await prisma.$queryRaw<
    Array<{ attemptNo: number; connected: bigint; not_connected: bigint }>
  >`
    SELECT a."attemptNo",
           COUNT(*) FILTER (WHERE ${reachedAttemptSql('a')}) AS connected,
           /*
            * COALESCE, and it is load-bearing. The reached predicate compares
            * answeredBy, which is NULL on most attempts, so the whole
            * expression evaluates to NULL rather than to false — and NOT NULL
            * is NULL, which a FILTER treats as no. Written bare, every dial
            * nobody picked up fell out of BOTH counts and the panel reported a
            * campaign whose retries had all connected. (No backticks in here:
            * this comment lives inside a tagged template literal, and one
            * would end the SQL.)
            */
           COUNT(*) FILTER (WHERE NOT COALESCE(${reachedAttemptSql('a')}, false))
             AS not_connected
    FROM "CallAttempt" a
    WHERE a."campaignId" = ${campaignId}
      AND a."workspaceId" = ${workspaceId}
      /*
       * A claim the platform refused is not a telephone that rang. It belongs
       * in neither count: reporting it as a lead who did not pick up files our
       * own outage under their refusal, which is the rule the campaign list's
       * ring holds for the same reason. (No backticks in here: this comment
       * lives inside a tagged template literal, and one would end the SQL.)
       */
      AND a."launchError" IS NULL
    GROUP BY a."attemptNo"
    ORDER BY a."attemptNo"`;

  return rows.map((row) => ({
    attemptNo: row.attemptNo,
    connected: Number(row.connected),
    notConnected: Number(row.not_connected),
  }));
}

/**
 * The dial ladder: one rung per dial ordinal, with what it has left to place.
 *
 * One grouped statement over a campaign's attempts plus a join to its pending
 * contacts. Neither half grows with the campaign's call volume in ROWS — a
 * campaign has as many rungs as its longest contact has dials — though both
 * scan the attempts, which is the same shape `attemptOutcomesFor` beside it
 * already runs.
 *
 * **The rung is a `ROW_NUMBER` over the dials that RANG, not
 * `CallAttempt.attemptNo`.** The stored ordinal counts claims, and a claim the
 * platform refused leaves a row behind with no telephone call in it, so a
 * contact whose second claim was refused would have its third dial filed under
 * "attempt 3" while it was in fact that number's second ring. Renumbering also
 * makes the two halves agree: `due` is placed + 1, so a contact with two dials
 * behind it is owed rung 3 — the rung the placed counts call rung 3.
 *
 * **`due` is read from the contact, not from the attempts**, because it is
 * about a dial that has not happened. Only PENDING rows count: a settled
 * contact is owed nothing, whatever its arm still reads.
 *
 * **A dial in flight is in NEITHER count**, which is the one asymmetry worth
 * stating: it is not owed, and it is not yet evidence about the number either,
 * so the placed half waits for `resolvedAt` rather than coalescing a ringing
 * phone into "did not pick up". The same is true, briefly, of a contact
 * between the claim and the placement worker's insert — not PENDING, and with
 * no attempt row yet. Both windows are bounded by live dial concurrency.
 *
 * **`due` counts a contact the claim would refuse**, in one bounded case. The
 * budget sweeps run on every dispatcher pass, so an over-budget PENDING row
 * clears itself — but a PAUSED campaign is not swept, so a do-not-call listed
 * contact on one is reported as owed on a rung it will never be dialled for.
 * Duplicating the claim's predicate here is the drift `dialBudget.ts` exists
 * to prevent, so it is written down instead.
 *
 * Workspace-scoped as well as campaign-scoped on the attempts, for the reason
 * `attemptScope` gives. `CampaignContact` has no `workspaceId` column to repeat
 * the check against, and the campaign was resolved in this workspace before
 * this ran — written down because the asymmetry otherwise reads as an omission.
 */
async function dialLadderFor(
  workspaceId: string,
  campaignId: string,
): Promise<DialLadderRung[]> {
  const rows = await prisma.$queryRaw<
    Array<{ attemptNo: number; connected: bigint; not_connected: bigint; due: bigint }>
  >`
    WITH dials AS (
      SELECT a."campaignContactId",
             ROW_NUMBER() OVER (
               PARTITION BY a."campaignContactId" ORDER BY a."attemptNo"
             ) AS ordinal,
             COALESCE(${reachedAttemptSql('a')}, false) AS reached
      FROM "CallAttempt" a
      WHERE a."campaignId" = ${campaignId}
        AND a."workspaceId" = ${workspaceId}
        /*
         * A claim the platform refused is not a telephone that rang — asked
         * with the shared rule rather than a fourth spelling of it. A
         * launchError alone is the wrong question in BOTH directions: the
         * reaper stamps one on a call that did ring, and a platform fault
         * carrying only an errorCode writes none at all. (No backticks in
         * here: this comment lives inside a tagged template literal, and one
         * would end the SQL.)
         */
        AND NOT ${neverPlacedSql('a')}
        /*
         * And a dial still ringing is not yet evidence about the number:
         * reached would coalesce it to "did not pick up" and file our own
         * in-flight call under their refusal, which is the reading
         * attemptOutcomesFor refuses beside this one.
         */
        AND a."resolvedAt" IS NOT NULL
        /* A ladder is per contact, so a dial belonging to none is not on it. */
        AND a."campaignContactId" IS NOT NULL
    ),
    placed AS (
      SELECT ordinal,
             COUNT(*) FILTER (WHERE reached) AS connected,
             COUNT(*) FILTER (WHERE NOT reached) AS not_connected
      FROM dials
      GROUP BY ordinal
    ),
    waiting AS (
      /*
       * The rung a pending contact is next owed: one past however many dials
       * it already has. A contact nobody has rung is owed rung 1, which is
       * what makes an untouched campaign draw a full first rung of waiting
       * rather than an empty panel.
       */
      SELECT COALESCE(behind.placed, 0) + 1 AS ordinal, COUNT(*) AS due
      FROM "CampaignContact" cc
      LEFT JOIN (
        SELECT "campaignContactId", COUNT(*) AS placed FROM dials GROUP BY 1
      ) behind ON behind."campaignContactId" = cc.id
      WHERE cc."campaignId" = ${campaignId}
        AND cc.status = 'PENDING'
      GROUP BY 1
    )
    SELECT COALESCE(placed.ordinal, waiting.ordinal)::int AS "attemptNo",
           COALESCE(placed.connected, 0) AS connected,
           COALESCE(placed.not_connected, 0) AS not_connected,
           COALESCE(waiting.due, 0) AS due
    FROM placed
    FULL OUTER JOIN waiting ON waiting.ordinal = placed.ordinal
    ORDER BY 1`;

  return rows.map((row) => ({
    attemptNo: row.attemptNo,
    connected: Number(row.connected),
    notConnected: Number(row.not_connected),
    due: Number(row.due),
  }));
}

interface Tally {
  calls: number;
  connected: number;
  unresolved: number;
  byOutcome: Map<CallOutcome, number>;
  byDisposition: Map<string | null, number>;
}

function emptyTally(): Tally {
  return {
    calls: 0,
    connected: 0,
    unresolved: 0,
    byOutcome: new Map(OUTCOMES.map((outcome) => [outcome, 0])),
    byDisposition: new Map(),
  };
}

function record(tally: Tally, outcome: CallOutcome, disposition: string | null, count: number) {
  tally.calls += count;
  tally.byOutcome.set(outcome, (tally.byOutcome.get(outcome) ?? 0) + count);
  if (isConnected(outcome)) tally.connected += count;
  if (isUnresolved(outcome)) tally.unresolved += count;
  tally.byDisposition.set(disposition, (tally.byDisposition.get(disposition) ?? 0) + count);
}

/**
 * Counts by outcome across both sources.
 *
 * Grouped in SQL on the raw columns — a handful of rows whatever the call
 * volume — and classified here, so the classifier stays one function in
 * TypeScript rather than a `CASE` expression duplicated into every query.
 */
async function tally(
  workspaceId: string,
  range: AnalyticsRange,
  options: { campaignIds?: readonly string[]; includeRecords?: boolean } = {},
): Promise<Tally> {
  const result = emptyTally();

  const attempts = await prisma.callAttempt.groupBy({
    by: ['disposition', 'upstreamStatus', 'status', 'answeredBy'],
    where: attemptScope(workspaceId, range, options.campaignIds),
    _count: { _all: true },
  });

  for (const row of attempts) {
    record(
      result,
      classifyAttempt(row.disposition, row.upstreamStatus, row.status, row.answeredBy),
      row.disposition,
      row._count._all,
    );
  }

  if (options.includeRecords) {
    const records = await prisma.callRecord.groupBy({
      by: ['disposition', 'status'],
      where: recordScope(workspaceId, range),
      _count: { _all: true },
    });

    for (const row of records) {
      record(
        result,
        classifyOutcome(row.disposition, row.status),
        row.disposition,
        row._count._all,
      );
    }
  }

  return result;
}

/**
 * What was actually charged, from the ledger.
 *
 * Scoped through `callAttempt` rather than through the ledger row's own
 * `workspaceId`, so the credits cover exactly the population of calls counted
 * beside them: a charge lands minutes after the call it is for, and filtering
 * on the ledger's own `createdAt` would drop the last day's calls out of the
 * money column while leaving them in the call count.
 *
 * `CALL_USAGE` only. `CALL_USAGE_SHORTFALL` is a zero-amount marker for a call
 * that completed against a balance too small to cover it — nothing was debited,
 * so nothing was spent.
 *
 * Amounts are signed and a charge is negative; "spent" is a positive quantity
 * on a page.
 */
async function creditsSpent(
  workspaceId: string,
  range: AnalyticsRange,
  campaignIds?: readonly string[],
  /**
   * The inbound half, already read (`inboundHalf`). Internal credits, negative.
   *
   * Passed in rather than read here, because an inbound charge is **unreachable
   * from the query below by construction**: it carries `callAttemptId = null`,
   * so a scope threaded through the `callAttempt` relation can never see it,
   * however it is written. Left at zero this tile could not agree with the
   * per-campaign credits column beneath it on any workspace that answers a
   * call — and money is the sharpest place on a page for two numbers to
   * disagree.
   */
  inboundCredits: bigint = 0n,
): Promise<string | null> {
  const spend = await prisma.creditTransaction.aggregate({
    _sum: { amount: true },
    where: {
      type: 'CALL_USAGE',
      callAttempt: attemptScope(workspaceId, range, campaignIds),
    },
  });

  const total = (spend._sum.amount ?? 0n) + inboundCredits;

  // Null when nothing was charged at all, so the page can say "no charges in
  // this range" rather than printing a zero that reads as "these calls were
  // free".
  return total === 0n ? null : toDisplayCredits(-total);
}

async function totalsFor(
  workspaceId: string,
  range: AnalyticsRange,
  options: {
    campaignIds?: readonly string[];
    includeRecords?: boolean;
    /**
     * See `creditsSpent`. Defaulted to zero, which is right for every caller
     * that has no inbound half to add — the per-campaign report reads its own
     * through `inboundReportFor` and shows it as its own figure.
     */
    inboundCredits?: bigint;
  } = {},
): Promise<{ totals: AnalyticsTotals; counts: Tally }> {
  const timed = { durationSecs: { not: null } };

  const [counts, attemptDurations, recordDurations, credits] = await Promise.all([
    tally(workspaceId, range, options),
    prisma.callAttempt.aggregate({
      where: { ...attemptScope(workspaceId, range, options.campaignIds), ...timed },
      _sum: { durationSecs: true },
      _count: { durationSecs: true },
    }),
    options.includeRecords
      ? prisma.callRecord.aggregate({
          where: { ...recordScope(workspaceId, range), ...timed },
          _sum: { durationSecs: true },
          _count: { durationSecs: true },
        })
      : null,
    creditsSpent(workspaceId, range, options.campaignIds, options.inboundCredits),
  ]);

  const totalDurationSecs =
    (attemptDurations._sum.durationSecs ?? 0) + (recordDurations?._sum.durationSecs ?? 0);
  const withDuration =
    attemptDurations._count.durationSecs + (recordDurations?._count.durationSecs ?? 0);

  return {
    counts,
    totals: {
      calls: counts.calls,
      connected: counts.connected,
      answerRate: rate(counts.connected, counts.calls),
      unresolved: counts.unresolved,
      totalDurationSecs,
      // Averaged over calls that HAVE a duration. An unknown duration is not a
      // zero-second call, and folding it in as one would drag every average
      // down by however many rows had not finished being written.
      avgDurationSecs: withDuration === 0 ? null : totalDurationSecs / withDuration,
      creditsSpent: credits,
    },
  };
}

interface DayRow {
  day: Date;
  disposition: string | null;
  status: string | null;
  attempt_status: string | null;
  /** Null on every `CallRecord` row: the ingest has no such column. */
  answered_by: string | null;
  calls: bigint;
}

/** Turns grouped day rows into a dense series over the range. */
function densify(rows: DayRow[], range: AnalyticsRange): SeriesPoint[] {
  const byDay = new Map<string, { calls: number; connected: number }>();

  for (const row of rows) {
    const key = row.day.toISOString().slice(0, 10);
    const point = byDay.get(key) ?? { calls: 0, connected: 0 };
    const count = Number(row.calls);

    const outcome =
      row.attempt_status === null
        ? classifyOutcome(row.disposition, row.status)
        : classifyAttempt(row.disposition, row.status, row.attempt_status, row.answered_by);

    point.calls += count;
    if (isConnected(outcome)) point.connected += count;

    byDay.set(key, point);
  }

  const points: SeriesPoint[] = [];
  // Walked from the range rather than from the rows, which is what fills the
  // gaps. A sparse series drawn as a line silently connects across them and
  // renders a quiet week as a smooth decline — a shape a reader takes for a
  // trend that did not happen.
  const first = Date.UTC(
    range.from.getUTCFullYear(),
    range.from.getUTCMonth(),
    range.from.getUTCDate(),
  );
  const last = Date.UTC(range.to.getUTCFullYear(), range.to.getUTCMonth(), range.to.getUTCDate());

  for (let at = first; at <= last; at += DAY_MS) {
    const date = new Date(at).toISOString().slice(0, 10);
    const point = byDay.get(date);
    points.push({ date, calls: point?.calls ?? 0, connected: point?.connected ?? 0 });
  }

  return points;
}

/**
 * The workspace's daily series, over both sources.
 *
 * `$queryRaw` because Prisma has neither `date_trunc` nor a union, and with
 * **bound parameters** throughout: a workspace id interpolated into SQL is the
 * one mistake on this surface that would be worse than a wrong number.
 *
 * **`date_trunc` takes the bare column, with no `AT TIME ZONE`.** `startedAt`
 * is `timestamp` *without* time zone and already holds UTC, so truncating it
 * directly is a UTC day. Writing `"startedAt" AT TIME ZONE 'UTC'` reads like it
 * forces the intended zone and does the opposite: it converts the naive value
 * to a `timestamptz`, and `date_trunc` on a `timestamptz` truncates in the
 * **session's** `TimeZone`, which nothing here sets and Prisma does not pin.
 * The payload asserts `timezone: 'UTC'` and `densify` walks UTC calendar days,
 * so on any database not running UTC the buckets would shift out from under
 * both — and a row whose key shifts before the range's first day is dropped
 * from the series entirely, leaving the tile and the chart disagreeing about
 * the same calls. `test/analytics-service.test.ts` pins this under a non-UTC
 * session.
 *
 * `attempt_status` is null on the `CallRecord` half, which is how `densify`
 * tells the two apart and applies the right classifier to each.
 */
function workspaceSeries(
  workspaceId: string,
  range: AnalyticsRange,
  /**
   * The campaign filter, or undefined for none.
   *
   * When present the `CallRecord` half is dropped entirely rather than
   * filtered, and that is correct rather than a shortcut: a `CallRecord` is by
   * construction a call that belongs to **no** campaign, so no campaign filter
   * can ever select one. Filtering it would be writing a predicate that is
   * always false; keeping it unfiltered would leave every non-campaign call in
   * a chart the reader has narrowed to two campaigns.
   */
  campaignIds?: readonly string[],
): Promise<DayRow[]> {
  // `answeredBy` rides in the group key beside the two labels, because the
  // classifier reads it: a conversation the platform labelled `no_answer` is
  // connected only if the row still says a human answered it.
  const attempts = Prisma.sql`
    SELECT date_trunc('day', "startedAt") AS day,
           "disposition",
           "upstreamStatus" AS "status",
           "status"::text AS attempt_status,
           "answeredBy" AS answered_by,
           COUNT(*)::bigint AS calls
      FROM "CallAttempt"
     WHERE "workspaceId" = ${workspaceId}
       AND "startedAt" >= ${range.from}
       AND "startedAt" <= ${range.to}
       ${
         campaignIds
           ? Prisma.sql`AND "campaignId" = ANY(${[...campaignIds]}::text[])`
           : Prisma.empty
       }
     GROUP BY 1, 2, 3, 4, 5
  `;

  if (campaignIds) {
    return prisma.$queryRaw<DayRow[]>`
      SELECT day, "disposition", "status", attempt_status, answered_by, SUM(calls)::bigint AS calls
        FROM (${attempts}) merged
       GROUP BY 1, 2, 3, 4, 5
    `;
  }

  return prisma.$queryRaw<DayRow[]>`
    SELECT day, "disposition", "status", attempt_status, answered_by, SUM(calls)::bigint AS calls
      FROM (
        SELECT date_trunc('day', "startedAt") AS day,
               "disposition",
               "status",
               NULL::text AS attempt_status,
               NULL::text AS answered_by,
               COUNT(*)::bigint AS calls
          FROM "CallRecord"
         WHERE "workspaceId" = ${workspaceId}
           AND "startedAt" >= ${range.from}
           AND "startedAt" <= ${range.to}
         GROUP BY 1, 2, 3, 4, 5
        UNION ALL
        ${attempts}
      ) merged
     GROUP BY 1, 2, 3, 4, 5
  `;
}

/** One campaign's daily series. Attempts only — a campaign has no other calls. */
function campaignSeries(
  workspaceId: string,
  campaignId: string,
  range: AnalyticsRange,
): Promise<DayRow[]> {
  return prisma.$queryRaw<DayRow[]>`
    SELECT date_trunc('day', "startedAt") AS day,
           "disposition",
           "upstreamStatus" AS "status",
           "status"::text AS attempt_status,
           "answeredBy" AS answered_by,
           COUNT(*)::bigint AS calls
      FROM "CallAttempt"
     WHERE "workspaceId" = ${workspaceId}
       AND "campaignId" = ${campaignId}
       AND "startedAt" >= ${range.from}
       AND "startedAt" <= ${range.to}
     GROUP BY 1, 2, 3, 4, 5
  `;
}

function outcomeList(tally: Tally): OutcomeCount[] {
  // Every bucket, in the classifier's order, zeros included: a breakdown that
  // omitted its empty rows would change shape between two readings of the same
  // page and hide that a category exists at all.
  return OUTCOMES.map((outcome) => ({ outcome, count: tally.byOutcome.get(outcome) ?? 0 }));
}

function dispositionList(tally: Tally): DispositionCount[] {
  // The raw values as the carrier sent them, so nothing is hidden by the
  // classification above — an unrecognised disposition appears verbatim here as
  // well as inside `other`.
  return [...tally.byDisposition.entries()]
    .map(([disposition, count]) => ({ disposition, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Every campaign of this workspace with calls in the range.
 *
 * Derived from the CALLS outward, not from the campaigns table: starting from
 * campaigns would list every draft as a row of zeros and would need a second
 * query per row to fill the counts in. Both kinds of call, since inbound
 * campaigns — a campaign whose calls are every one of them received — have a
 * line on this table too.
 *
 * `inbound` is handed in rather than read here so that the credits tile above
 * this table sums exactly the rows this table breaks out. See `InboundHalf`.
 */
async function campaignRollup(
  workspaceId: string,
  range: AnalyticsRange,
  campaignIds: readonly string[] | undefined,
  inbound: InboundHalf,
): Promise<CampaignRollup[]> {
  const rows = await prisma.callAttempt.groupBy({
    by: ['campaignId', 'disposition', 'upstreamStatus', 'status', 'answeredBy'],
    where: attemptScope(workspaceId, range, campaignIds),
    _count: { _all: true },
  });

  // Both sources, because either alone can be empty on a workspace that has
  // the other. Returning early on `rows` was correct only while a campaign
  // call meant a dial: it made a filter naming one inbound campaign answer
  // with an empty table, which is what the reader sees as "no data" and reads
  // as "this campaign did nothing".
  if (rows.length === 0 && inbound.calls.size === 0) return [];

  const inboundTallies = inbound.calls;

  const tallies = new Map<string, { calls: number; connected: number }>();

  for (const row of rows) {
    // An attempt whose campaign was deleted keeps its history but belongs to
    // no campaign row any more, so it has no line in a per-campaign tally.
    if (row.campaignId === null) continue;
    const entry = tallies.get(row.campaignId) ?? { calls: 0, connected: 0 };
    const count = row._count._all;

    entry.calls += count;
    if (isConnected(classifyAttempt(row.disposition, row.upstreamStatus, row.status, row.answeredBy))) {
      entry.connected += count;
    }

    tallies.set(row.campaignId, entry);
  }

  // Both sources, unioned. An INBOUND campaign has no attempt row to tally, so
  // an id list built from `tallies` alone dropped it here — and because the
  // names are then looked up BY that list, it vanished from the table entirely
  // rather than appearing as a row of zeros somebody could question.
  const ids = [...new Set([...tallies.keys(), ...inboundTallies.keys()])];

  const [campaigns, spend] = await Promise.all([
    // Scoped to the workspace as well as to the ids. The ids came off rows this
    // workspace owns, so it is redundant — and it is what stops a stale row
    // naming a campaign that has since moved from printing another workspace's
    // campaign name.
    prisma.campaign.findMany({
      where: { id: { in: ids }, workspaceId },
      select: { id: true, name: true, type: true },
    }),
    prisma.creditTransaction.groupBy({
      by: ['callAttemptId'],
      _sum: { amount: true },
      where: { type: 'CALL_USAGE', callAttempt: attemptScope(workspaceId, range, campaignIds) },
    }),
  ]);

  const inboundCreditsBy = inbound.credits;

  // The ledger groups by attempt, so the attempt→campaign mapping is needed to
  // fold it up. One query rather than a per-campaign aggregate, which would be
  // a query per row of the table.
  const attemptCampaigns = new Map(
    (
      await prisma.callAttempt.findMany({
        where: {
          ...attemptScope(workspaceId, range, campaignIds),
          id: { in: spend.map((s) => s.callAttemptId!) },
        },
        select: { id: true, campaignId: true },
      })
    ).map((attempt) => [attempt.id, attempt.campaignId]),
  );

  const creditsByCampaign = new Map<string, bigint>();
  for (const row of spend) {
    const campaignId = row.callAttemptId ? attemptCampaigns.get(row.callAttemptId) : null;
    if (!campaignId) continue;
    creditsByCampaign.set(campaignId, (creditsByCampaign.get(campaignId) ?? 0n) + (row._sum.amount ?? 0n));
  }

  return campaigns
    .map(({ id, name, type }) => {
      // Defaulted rather than asserted. A campaign reaches this list from
      // EITHER tally, so the other one legitimately has no entry for it — the
      // `!` that used to stand here was safe only while attempts were the sole
      // source, and would have thrown on the first inbound-only campaign.
      const entry = tallies.get(id) ?? { calls: 0, connected: 0 };
      const credits = (creditsByCampaign.get(id) ?? 0n) + (inboundCreditsBy.get(id) ?? 0n);

      return {
        id,
        name,
        type,
        calls: entry.calls,
        connected: entry.connected,
        answerRate: rate(entry.connected, entry.calls),
        inboundCalls: inboundTallies.get(id) ?? 0,
        creditsSpent: credits === 0n ? null : toDisplayCredits(-credits),
      };
    })
    // Ordered by everything the campaign did, not by its dials alone: ranking
    // an inbound campaign that answered four hundred calls below one that
    // placed a single dial would bury the busiest campaign on the page.
    .sort(
      (a, b) =>
        b.calls + b.inboundCalls - (a.calls + a.inboundCalls) || a.name.localeCompare(b.name),
    );
}

/**
 * The workspace's own numbers over a range, across both sources.
 *
 * **The campaign filter narrows the page to campaign calls.** When one is
 * given, `includeRecords` goes off: a `CallRecord` is by construction a call
 * that belongs to no campaign — inbound, hand-placed, or on an agent no
 * workspace holds — so it can never be one of the campaigns asked for. Leaving
 * it in would mean a filtered page whose totals still carried every call the
 * reader had just excluded, which is the failure this whole surface is written
 * to avoid. The payload says which happened through `scope`, so the page can
 * state it rather than leaving the reader to infer it from a number that got
 * smaller.
 */
export async function workspaceOverview(
  workspaceId: string,
  range: AnalyticsRange,
  campaignIds?: readonly string[],
): Promise<WorkspaceOverview> {
  const filtered = campaignIds !== undefined;

  // Read before the rest, and once. Two readers below need it — the campaign
  // table breaks these calls out, the credits tile sums their spend — and a
  // tile that disagrees with the column under it is the fault this surface
  // exists to prevent. It is also the guard: on a workspace that has received
  // nothing, this settles for one indexed `groupBy` and the ledger join never
  // runs at all. See `InboundHalf`.
  const inbound = await inboundHalf(workspaceId, range, campaignIds);

  const [{ totals, counts }, rows, campaigns, campaignCalls, firstCallAt] = await Promise.all([
    totalsFor(workspaceId, range, {
      campaignIds,
      includeRecords: !filtered,
      inboundCredits: inbound.totalCredits,
    }),
    workspaceSeries(workspaceId, range, campaignIds),
    campaignRollup(workspaceId, range, campaignIds, inbound),
    prisma.callAttempt.count({ where: attemptScope(workspaceId, range, campaignIds) }),
    workspaceFirstCallAt(workspaceId),
  ]);

  return {
    scope: filtered ? 'campaigns' : 'workspace',
    // Echoed, never implied. A page rendering "1,204 calls" over a window the
    // reader did not choose and cannot see is a number with no question
    // attached to it.
    range,
    bucket: BUCKET,
    timezone: TIMYENE,
    metered: METERED,
    totals,
    sources: { campaignCalls, otherCalls: totals.calls - campaignCalls },
    filteredCampaigns: campaignIds ? [...campaignIds] : undefined,
    series: densify(rows, range),
    outcomes: outcomeList(counts),
    dispositions: dispositionList(counts),
    campaigns,
    firstCallAt,
  };
}

/**
 * The earliest call this workspace has ever placed, from either source.
 *
 * Two indexed `min` aggregates over `(workspaceId, startedAt)`, which is a
 * single index row each — cheap enough to run on every overview, and the only
 * honest way to answer a question about all time on a page that is otherwise
 * entirely range-scoped.
 */
async function workspaceFirstCallAt(workspaceId: string): Promise<Date | null> {
  const [attempts, records] = await Promise.all([
    prisma.callAttempt.aggregate({ where: { workspaceId }, _min: { startedAt: true } }),
    prisma.callRecord.aggregate({ where: { workspaceId }, _min: { startedAt: true } }),
  ]);

  const candidates = [attempts._min.startedAt, records._min.startedAt].filter(
    (at): at is Date => at !== null,
  );

  if (candidates.length === 0) return null;
  return candidates.reduce((earliest, at) => (at < earliest ? at : earliest));
}

/**
 * One campaign's report, or `null` when it is not this workspace's.
 *
 * Null rather than a thrown 404, so the route decides the wording. A foreign
 * campaign, an unmapped id and pure nonsense all arrive here as the same
 * answer, which is what stops the endpoint being used to sort ids into real
 * and unreal.
 *
 * Reads `CallAttempt` and nothing else: a campaign call is a dial the dialer
 * placed, and the analytics ingest deliberately never stores one.
 */
export async function campaignAnalytics(
  workspaceId: string,
  campaignId: string,
  range: AnalyticsRange,
): Promise<CampaignReport | null> {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, workspaceId },
    // `type` decides whether the inbound block applies at all; `workspace` is
    // read for the owner account, which is who an inbound charge is billed to
    // and therefore the only account the ledger join may be pinned on.
    select: {
      id: true,
      name: true,
      type: true,
      workspace: { select: { ownerAccountId: true } },
    },
  });

  if (!campaign) return null;

  const shown = { id: campaign.id, name: campaign.name };

  const [
    { totals, counts },
    rows,
    contacts,
    attempted,
    completed,
    attemptOutcomes,
    dialLadder,
    reached,
    goalCompleted,
    talk,
    reachedTalk,
  ] = await Promise.all([
      totalsFor(workspaceId, range, { campaignIds: [campaignId] }),
      campaignSeries(workspaceId, campaignId, range),
      prisma.campaignContact.count({ where: { campaignId } }),
      /**
       * "Has been dialled at least once", campaign-wide.
       *
       * **`lastAttemptAt`, and deliberately not the dial counters.** The claim
       * stamps it in the same `UPDATE` that flips a contact `PENDING → QUEUED`
       * (`dialerClaim.ts`), whatever lane the dial came out of, and nothing
       * ever clears it — so it is present on every contact any later stage of
       * this funnel can describe, which is the property a funnel stage needs.
       *
       * The three dial counters cannot answer this question campaign-wide,
       * because **none of them moves on a contact that answers its first dial
       * and settles**: `attempts` is retries CONSUMED and only the retry re-arm
       * increments it, `callbackCount` moves only on a booked callback, and
       * `followUpCount` only on a goal re-arm. On a plain campaign where most
       * people pick up, a counter-based `attempted` reports every one of them
       * as never dialled and comes out *below* `completed` — the funnel's third
       * stage exceeding its second, which is the same "three true numbers
       * arranged into a false sentence" this docstring already records the
       * funnel being fixed for once.
       *
       * `HAS_BEEN_DIALED_SQL` (`campaignQueue.ts`) is this same column, so the
       * campaign list's `outcomes` bar, `/stats`' `waiting` split and the
       * bucket report all answer this question the way this stage does. One
       * predicate, so no two panels of one dashboard can disagree about
       * whether a contact has been rung.
       *
       * **`lastAttemptAt` and not an `EXISTS` over `CallAttempt`, and the
       * reason is not cost.** The exact alternative is one
       * `COUNT(DISTINCT "campaignContactId")` aggregate, which is a single
       * cheap statement, not a per-contact subquery. It is the wrong evidence:
       *
       * - **The column is atomic with the claim.** `dialerClaim.ts` writes it
       *   in the same `UPDATE` that flips the contact to `QUEUED`; the
       *   `CallAttempt` row is inserted later still, by the placement worker.
       *   Between those two writes a contact is claimed with no attempt row —
       *   the window `releaseStaleClaims` exists to clean up — and read off
       *   `CallAttempt` this stage would report the campaign's in-flight batch
       *   as untouched.
       * - **A funnel stage should err wide.** Counting a claim whose placement
       *   never ran keeps `contacts >= attempted >= completed` true; missing a
       *   dial that happened breaks it, and a funnel that reports its third
       *   stage above its second is the exact failure this docstring already
       *   records the funnel being fixed for once.
       * - **It is the column every neighbouring panel reads.** The bucket
       *   report's `unreached`, the journey, and now the campaign list's bar
       *   and `/stats` all take `lastAttemptAt`; a second source of truth here
       *   would put two numbers for one sentence on one page.
       */
      prisma.campaignContact.count({ where: { campaignId, lastAttemptAt: { not: null } } }),
      prisma.campaignContact.count({ where: { campaignId, status: 'COMPLETED' } }),
      attemptOutcomesFor(workspaceId, campaignId),
      dialLadderFor(workspaceId, campaignId),
      /**
       * Leads spoken to, over the campaign's life — contacts, not calls.
       *
       * Counted over the ATTEMPTS through `reachedContactsFilter`, and
       * emphatically not off `CampaignContact.disposition`. That column is the
       * last dial's outcome, so a lead that had a conversation and was later
       * followed up into a voicemail stopped counting; gating it on
       * `SETTLED_STATUSES` as well then dropped every contact the follow-up had
       * re-armed to PENDING. Together they reported 158 on a live touchbase
       * campaign where 323 leads had picked up — a figure that also FELL as the
       * campaign kept working, which is the property that makes it unusable
       * rather than merely low.
       *
       * The consequence to hold onto: **this figure is deliberately larger than
       * the reached tier of the outcome bar beside it**, and the two are not in
       * disagreement. The bar partitions contacts by where they are NOW; this
       * counts what has happened to them at any point. `/stats` publishes the
       * same number under `reached`, from this same filter, so the strip on the
       * Overview and this tile cannot drift.
       */
      prisma.campaignContact.count({ where: reachedContactsFilter(campaignId) }),
      // No status gate, deliberately: `goalAchieved` is written only at settle
      // time, and this is the figure `/stats` puts on the goal tile. See
      // `CampaignLifetime.goalCompleted` for why that leaves it outside
      // `reached` rather than inside it.
      prisma.campaignContact.count({ where: { campaignId, goalAchieved: true } }),
      // Lifetime, deliberately unbounded by the range — see `CampaignLifetime`.
      prisma.callAttempt.aggregate({
        where: { campaignId, durationSecs: { not: null } },
        _sum: { durationSecs: true },
      }),
      /**
       * The same seconds, narrowed to the calls a person actually took.
       *
       * Narrowed to the reached ATTEMPTS, not to every attempt of a reached
       * contact: the four voicemails left for a lead before they finally picked
       * up are not time spent talking to them, and rolling them in would put
       * the average per person above the length of any conversation that
       * happened. Same predicate as `reached` on the other side of the divide,
       * so the ratio is one population over its own count.
       */
      prisma.callAttempt.aggregate({
        where: {
          campaignId,
          durationSecs: { not: null },
          ...REACHED_ATTEMPT,
        },
        _sum: { durationSecs: true },
      }),
    ]);

  const inbound = isInboundFacing(campaign.type)
    ? await inboundReportFor(workspaceId, campaignId, campaign.workspace.ownerAccountId, range)
    : undefined;

  return {
    range,
    bucket: BUCKET,
    timezone: TIMYENE,
    metered: METERED,
    campaign: shown,
    totals,
    funnel: {
      scope: 'campaign_to_date',
      contacts,
      attempted,
      // The SAME count as `lifetime.reached` below, from the same filter, and
      // deliberately not a second measurement of the idea. See the field.
      connected: reached,
      completed,
    },
    lifetime: {
      reached,
      goalCompleted,
      // `_sum` of an empty set is null, which is a campaign that has recorded
      // no call seconds — zero of them, not an unknown quantity.
      talkSecs: talk._sum.durationSecs ?? 0,
      reachedTalkSecs: reachedTalk._sum.durationSecs ?? 0,
    },
    attemptOutcomes,
    dialLadder,
    series: densify(rows, range),
    outcomes: outcomeList(counts),
    dispositions: dispositionList(counts),
    // Spread, never `inbound` bare. A spread `undefined` key survives
    // `'inbound' in report` while `JSON.stringify` drops it, so a bare key
    // would be absent on the wire and present to any consumer that checks for
    // the field — which is exactly the check a deploy-skew fallback makes.
    ...(inbound ? { inbound } : {}),
  };
}

/**
 * The inbound half of a campaign report, in one round of parallel reads.
 *
 * Every query is scoped by `workspaceId` as well as `campaignId`. The route has
 * already checked ownership, so the second filter is redundant — and it is the
 * rule every neighbouring query in this service follows, precisely so a later
 * refactor of that lookup cannot silently widen these.
 *
 * `avgTalkSecs` divides by the calls that HAVE a duration rather than by every
 * call, the rule `totals.avgDurationSecs` follows: a range whose calls are
 * mostly still open would otherwise report an average pulled toward zero by
 * lengths nobody has measured yet.
 */
async function inboundReportFor(
  workspaceId: string,
  campaignId: string,
  ownerAccountId: string,
  range: AnalyticsRange,
): Promise<CampaignInboundReport> {
  const scope = {
    campaignId,
    workspaceId,
    arrivedAt: { gte: range.from, lte: range.to },
  };

  const [series, outcomes, repeat, credits, dispositionGroups, duration, unknownCalls] =
    await Promise.all([
      inboundSeries(workspaceId, campaignId, range),
      inboundOutcomeBreakdown(workspaceId, campaignId, range),
      inboundRepeatCallers(workspaceId, campaignId, range),
      inboundCredits(workspaceId, campaignId, ownerAccountId, range),
      prisma.campaignInboundCall.groupBy({
        by: ['disposition'],
        where: scope,
        _count: { _all: true },
      }),
      prisma.campaignInboundCall.aggregate({
        where: { ...scope, durationSecs: { not: null } },
        _sum: { durationSecs: true },
        _count: { _all: true },
      }),
      prisma.campaignInboundCall.count({ where: { ...scope, campaignContactId: null } }),
    ]);

  const calls = series.reduce((sum, point) => sum + point.calls, 0);
  const talkSecs = duration._sum.durationSecs ?? 0;
  const measured = duration._count._all;

  return {
    calls,
    callers: repeat.callers,
    repeatCallers: repeat.repeatCallers,
    unknownCalls,
    talkSecs,
    avgTalkSecs: measured === 0 ? null : Math.round(talkSecs / measured),
    creditsSpent: credits.credits === 0n ? null : toDisplayCredits(credits.credits),
    series,
    outcomes,
    dispositions: dispositionGroups
      .map((group) => ({ disposition: group.disposition, count: group._count._all }))
      .sort((a, b) => b.count - a.count),
    callerHistogram: repeat.histogram,
  };
}
