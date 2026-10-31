import { Prisma, type CampaignContactStatus, type CampaignStatus } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import {
  REACHED_ATTEMPT,
  SETTLED_STATUSES,
  reachedAttemptSql,
} from '../lib/campaignOutcomes.js';
import {
  MAX_REPORTED_BUCKETS,
  campaignLeadBuckets,
  foldBucketName,
} from '../lib/campaignBuckets.js';
import type { AnalyticsRange } from '../lib/analyticsQuery.js';
import { toDisplayCredits } from '../lib/credits.js';
import { UnknownTimeZoneError, resolvePgTimeZone } from '../lib/pgTimeZone.js';

/**
 * The workspace's leads, as opposed to its calls.
 *
 * **The distinction this whole service exists for.** `CallAttempt` is one row
 * per dial; `CampaignContact` is one row per lead. A lead rung four times is
 * four attempts and one lead. `services/analytics.ts` answers "how did the
 * calls go"; this file answers "how did the leads go", and the two give
 * different numbers over the same data on purpose.
 *
 * Reading the call table and labelling the result "leads" is the single bug
 * every function here is shaped to avoid.
 *
 * **What the range means.** The window is on the *interaction*, not on the
 * lead: a lead is in these numbers when it was dialled inside the window,
 * whenever the lead itself was created. That is the same thing Convin's
 * "Interaction Activity" filter selects, and it is why the filter carries a
 * separate lead-created window for the other question.
 *
 * Everything is counted in SQL. Nothing loads a workspace's contacts into
 * Node to count them; a workspace with two hundred thousand leads has to
 * answer as fast as one with two hundred.
 */

/** What the caller asks for. */
export interface LeadQuery {
  range: AnalyticsRange;
  /**
   * Which campaigns to count, and the two absences are different.
   *
   * `undefined` is a caller who named no filter: every campaign in the
   * workspace. `[]` is a caller who named a filter that selects nothing, and
   * it selects nothing — answering that with the whole workspace hands a
   * reader who narrowed to zero campaigns every lead there is. The overview
   * route's `campaignFilter` draws the same distinction and this must not
   * disagree with it: they are read off one filter control on one page.
   */
  campaigns?: string[];
  /**
   * Campaign statuses to keep. Undefined or empty means every status.
   *
   * Unlike `campaigns`, an empty list here means "no restriction" rather
   * than "nothing". The two differ because the controls differ: the campaign
   * picker can be narrowed to an explicit selection, while a status
   * multi-select with nothing ticked is the unfiltered state of that control.
   */
  campaignStatuses?: CampaignStatus[];
  /** Lead states to keep. Undefined or empty means every state. */
  leadStates?: CampaignContactStatus[];
  /**
   * When the LEAD entered, which is a different question from when it was
   * called. A lead uploaded in March and rung in August is inside the
   * interaction window and outside a March-onward creation window, and the
   * filter bar carries both because operators ask both.
   */
  leadCreatedFrom?: Date;
  leadCreatedUntil?: Date;
}

export interface LeadTotals {
  /** Leads with at least one dial inside the window. */
  attemptedLeads: number;
  /** Of those, the ones an attempt actually reached. */
  connectedLeads: number;
  /**
   * `connectedLeads / attemptedLeads`, or **null** when nothing was dialled.
   *
   * Never `0`. A zero here asserts that leads were dialled and none answered,
   * which is a measurement; "nothing was dialled" is the absence of one.
   */
  connectivity: number | null;
  /**
   * Leads whose goal was met, over the **connected** population — or null
   * when nothing was reached.
   */
  goalAchievedRate: number | null;
}

/** Where each reached lead's journey stands. */
export interface LeadStateCounts {
  completed: number;
  active: number;
}

/**
 * The goal verdict, in three parts rather than two.
 *
 * `notEvaluated` is not a rounding of `no`. A null verdict is two real
 * states — the campaign has no goal, or the contact has not settled — and
 * neither is a missed goal. Folding it into `no` reports a campaign that
 * never asked for a verdict as having failed every lead it spoke to.
 */
export interface GoalCounts {
  yes: number;
  no: number;
  notEvaluated: number;
}

/**
 * The interest ring, pooled across every campaign that buckets.
 *
 * **This adds unlike things, knowingly.** `Campaign.leadBucketKey` is
 * per-campaign, so one campaign's `interest_level` and another's
 * `gbp_work_status` are different questions and their answers share no
 * vocabulary. Summing them is what the reference product does and what this
 * page was asked for; what keeps it honest is `keys` and `distinctKeys`,
 * which let the card say how many questions fed the ring instead of
 * presenting it as one.
 *
 * A reader who wants a single-key reading filters to one campaign.
 */
export interface InterestBuckets {
  /** Descending by count. At most `MAX_REPORTED_BUCKETS` after pooling. */
  buckets: { name: string; count: number }[];
  /**
   * Every lead with a bucketed answer, **complete** — not the sum of
   * `buckets`, which is capped. The difference between the two is the
   * unshown tail, which is how a card renders an honest "Other" even when
   * a campaign was itself truncated.
   */
  bucketed: number;
  /** Of those, the ones whose answer their own campaign counts as won. */
  won: number;
  /** Whether any campaign's list was capped, or the pooled list was. */
  truncated: boolean;
  /** The distinct extraction keys pooled here, sorted, for the caption. */
  keys: string[];
  distinctKeys: number;
}

/** Derived from the goal verdict and the journey's state, never stored. */
export interface QualificationCounts {
  qualified: number;
  notQualified: number;
  inProgress: number;
  notEvaluated: number;
}

export interface LeadOutcome {
  range: AnalyticsRange;
  totals: LeadTotals;
  /**
   * The denominator every distribution below is drawn over: the leads an
   * attempt in this window actually reached. Emitted rather than left to be
   * derived, because each card has to name it — a ring whose total silently
   * differs from the tile above it is read as a contradiction.
   */
  population: number;
  leadState: LeadStateCounts;
  goal: GoalCounts;
  qualification: QualificationCounts;
  interest: InterestBuckets;
  /**
   * The calls this workspace ANSWERED, or absent when nothing in scope
   * answers any. Never zeroed — see `LeadInbound`.
   */
  inbound?: LeadInbound;
}

/**
 * The contacts this query is about: in this workspace, on the named campaigns
 * if any were named, and dialled inside the window.
 *
 * Scoped through the campaign's `workspaceId` rather than trusting the id list
 * — a campaign id from another workspace narrows to nothing instead of
 * widening the read.
 */
function contactScope(
  workspaceId: string,
  query: LeadQuery,
): Prisma.CampaignContactWhereInput {
  const created =
    query.leadCreatedFrom || query.leadCreatedUntil
      ? {
          createdAt: {
            ...(query.leadCreatedFrom ? { gte: query.leadCreatedFrom } : {}),
            ...(query.leadCreatedUntil ? { lte: query.leadCreatedUntil } : {}),
          },
        }
      : {};

  return {
    campaign: {
      workspaceId,
      ...(query.campaigns === undefined ? {} : { id: { in: query.campaigns } }),
      ...(query.campaignStatuses?.length ? { status: { in: query.campaignStatuses } } : {}),
    },
    ...(query.leadStates?.length ? { status: { in: query.leadStates } } : {}),
    ...created,
  };
}

/** An attempt inside the window. */
function inWindow(range: AnalyticsRange): Prisma.CallAttemptWhereInput {
  return { startedAt: { gte: range.from, lte: range.to } };
}

/* ------------------------------------------------------------------ *
 * One predicate set, spliced into every read.
 *
 * **This is the file's load-bearing invariant and it was once wrong.** Each
 * endpoint assembles its payload from several statements — a grouped read over
 * contacts, raw aggregates over attempts, a ledger sum. A filter wired into one
 * and not the others does not make two tabs disagree; it makes two numbers in
 * ONE card disagree, one narrowed and one not, with nothing on screen saying
 * so. The money version is worse still: an unfiltered numerator over a filtered
 * denominator inflates a cost-per-lead without bound while the total beside it
 * stays consistent with the wrong figure.
 *
 * So the filters are expressed ONCE, here, and every statement below splices
 * these helpers rather than restating a predicate. `test/lead-filter-
 * consistency.test.ts` holds the line by asserting the figures each *suspect*
 * read produces — never `connectedLeads`, which is the one that was never at
 * risk and which the previous test asserted instead.
 * ------------------------------------------------------------------ */

/**
 * The campaign side: workspace, the named campaigns, the named statuses.
 *
 * Always scoped through `c."workspaceId"` rather than trusting the id list, so
 * a campaign id from another workspace narrows to nothing instead of widening
 * the read.
 */
function campaignSql(workspaceId: string, query: LeadQuery): Prisma.Sql {
  const campaigns =
    query.campaigns === undefined
      ? Prisma.empty
      : query.campaigns.length === 0
        ? // A filter that selects nothing selects nothing. `IN ()` is not
          // valid SQL, so it is spelled as a predicate that cannot hold.
          Prisma.sql`AND FALSE`
        : Prisma.sql`AND c."id" IN (${Prisma.join(query.campaigns)})`;

  const statuses = query.campaignStatuses?.length
    ? Prisma.sql`AND c."status"::text IN (${Prisma.join([...query.campaignStatuses])})`
    : Prisma.empty;

  return Prisma.sql`
    c."workspaceId" = ${workspaceId}
    ${campaigns}
    ${statuses}
  `;
}

/**
 * The contact side, as clauses over whichever `CampaignContact` alias is given.
 *
 * Returned as a list rather than a block because two shapes need them: the
 * statements that already join the contact apply them inline, and the ones that
 * only reach attempts wrap them in an `EXISTS`.
 */
function contactClauses(query: LeadQuery, alias: string): Prisma.Sql[] {
  const cc = Prisma.raw(`"${alias}"`);
  const clauses: Prisma.Sql[] = [];

  if (query.leadStates?.length) {
    clauses.push(Prisma.sql`${cc}."status"::text IN (${Prisma.join([...query.leadStates])})`);
  }
  if (query.leadCreatedFrom) {
    clauses.push(Prisma.sql`${cc}."createdAt" >= ${query.leadCreatedFrom}`);
  }
  if (query.leadCreatedUntil) {
    clauses.push(Prisma.sql`${cc}."createdAt" <= ${query.leadCreatedUntil}`);
  }

  return clauses;
}

/** The contact filters inline, for a statement that already joined `alias`. */
function contactInlineSql(query: LeadQuery, alias: string): Prisma.Sql {
  const clauses = contactClauses(query, alias);
  if (clauses.length === 0) return Prisma.empty;

  return Prisma.sql`AND ${Prisma.join(clauses, ' AND ')}`;
}

/**
 * The contact filters as an `EXISTS`, for a statement that only reaches `a`.
 *
 * An `EXISTS` rather than a join so that a statement with no contact filter
 * emits no reference to `CampaignContact` at all and keeps the plan it had.
 */
function contactExistsSql(query: LeadQuery, alias = 'a'): Prisma.Sql {
  const clauses = contactClauses(query, 'lcc');
  if (clauses.length === 0) return Prisma.empty;

  const outer = Prisma.raw(`"${alias}"`);

  return Prisma.sql`AND EXISTS (
    SELECT 1 FROM "CampaignContact" "lcc"
    WHERE "lcc"."id" = ${outer}."campaignContactId"
      AND ${Prisma.join(clauses, ' AND ')}
  )`;
}

/* ------------------------------------------------------------------ *
 * The calls this workspace ANSWERED.
 * ------------------------------------------------------------------ */

/**
 * What an inbound-facing campaign took, over the window.
 *
 * **Never folded into the dial figures**, which is the convention
 * `services/analytics.ts` set and the reason it set it: a received call is not
 * a dial, so adding it to `attemptedLeads` would make `connectivity` dials
 * that connected over dials plus calls that arrived already connected — a
 * fraction over two populations with no question attached to it.
 *
 * Money is the one thing that does add. A credit is spent whichever way the
 * phone rang, so `leadSpend` sums both halves and names each.
 */
export interface LeadInbound {
  /** Calls received. */
  calls: number;
  /** Distinct numbers that rang, so a stranger calling three times is one. */
  callers: number;
  /** Calls with no contact attached yet; shrinks as settles enrol callers. */
  unknownCalls: number;
  /** Seconds of conversation, summed over the calls that have a duration. */
  talkSecs: number;
}

interface InboundRow {
  calls: number;
  callers: number;
  unknown_calls: number;
  talk_secs: number;
  avg_talk_secs: number | null;
}

interface InboundCreditsRow {
  amount: bigint | null;
}

interface InboundHalf {
  counts: LeadInbound;
  avgTalkSecs: number | null;
  /** Internal credits, already negated into a positive spend. */
  credits: bigint;
}

/**
 * The inbound half, or **null** when nothing in scope answers calls.
 *
 * Null rather than a zeroed block, the rule the campaign report keeps: a zero
 * asserts that a workspace which answers calls took none, where the truth is
 * that none of its campaigns answers any. The guard is also what keeps this
 * free for the overwhelming majority of workspaces, which have never received
 * a call — no inbound-facing campaign, no second statement.
 *
 * Scoped on `arrivedAt`, never `endedAt`: the question is when the phone rang,
 * and `arrivedAt` is never null, so a call still open is on the chart rather
 * than missing until it settles.
 */
async function inboundHalf(
  workspaceId: string,
  query: LeadQuery,
): Promise<InboundHalf | null> {
  const answering = await prisma.campaign.count({
    where: {
      workspaceId,
      type: { in: ['INBOUND', 'BOTH'] },
      ...(query.campaigns === undefined ? {} : { id: { in: query.campaigns } }),
      ...(query.campaignStatuses?.length ? { status: { in: query.campaignStatuses } } : {}),
    },
  });

  if (answering === 0) return null;

  const scope = Prisma.sql`
    FROM "CampaignInboundCall" ic
    JOIN "Campaign" c ON c."id" = ic."campaignId"
    WHERE ${campaignSql(workspaceId, query)}
      AND ic."arrivedAt" >= ${query.range.from}
      AND ic."arrivedAt" <= ${query.range.to}
      ${contactExistsSql(query, 'ic')}
  `;

  const [rows, credits] = await Promise.all([
    prisma.$queryRaw<InboundRow[]>`
      SELECT
        COUNT(*)::int                                              AS calls,
        COUNT(DISTINCT ic."fromNumber")::int                       AS callers,
        COUNT(*) FILTER (WHERE ic."campaignContactId" IS NULL)::int AS unknown_calls,
        COALESCE(SUM(ic."durationSecs"), 0)::int                   AS talk_secs,
        AVG(ic."durationSecs")::float8                             AS avg_talk_secs
      ${scope}
    `,
    /*
      `t."workspaceId"` is pinned, and that is not belt-and-braces:
      `CreditTransaction` has no index on `reference` alone — the only one
      carrying it is `@@unique([accountId, reference])`, which a predicate on
      `reference` by itself cannot use — so an unpinned join is a scan of the
      production ledger on every load of this page. The workspace is the right
      pin rather than the owner account: the inbound charge writer stamps the
      call's own `workspaceId`, and that survives an account transfer where a
      pin on the workspace's current owner does not.
    */
    prisma.$queryRaw<InboundCreditsRow[]>`
      SELECT SUM(t."amount")::bigint AS amount
      FROM "CampaignInboundCall" ic
      JOIN "Campaign" c ON c."id" = ic."campaignId"
      JOIN "CreditTransaction" t
        ON t."workspaceId" = ${workspaceId}
       AND t."reference" = ic."id"
       AND t."type" = 'CALL_USAGE'
      WHERE ${campaignSql(workspaceId, query)}
        AND ic."arrivedAt" >= ${query.range.from}
        AND ic."arrivedAt" <= ${query.range.to}
        ${contactExistsSql(query, 'ic')}
    `,
  ]);

  const row = rows[0];

  return {
    counts: {
      calls: row?.calls ?? 0,
      callers: row?.callers ?? 0,
      unknownCalls: row?.unknown_calls ?? 0,
      talkSecs: row?.talk_secs ?? 0,
    },
    avgTalkSecs: row?.avg_talk_secs ?? null,
    // Usage is written as a negative amount, so the spend is its negation.
    credits: -(credits[0]?.amount ?? 0n),
  };
}

/** A fraction, or null when the denominator is zero. */
function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * Every campaign's buckets, summed into one ring on the folded name.
 *
 * `campaignLeadBuckets` does the reading — the latest reached, extracting
 * call per contact, the voicemail exclusion, the case fold, the 40-bucket
 * cap. None of that is restated here; this reduces its per-campaign output.
 * Re-deriving any of it would make this ring disagree with the chip the
 * campaign page shows for the same lead.
 */
async function pooledInterest(
  workspaceId: string,
  query: LeadQuery,
): Promise<InterestBuckets> {
  const campaigns = await prisma.campaign.findMany({
    where: {
      workspaceId,
      ...(query.campaigns === undefined ? {} : { id: { in: query.campaigns } }),
      ...(query.campaignStatuses?.length ? { status: { in: query.campaignStatuses } } : {}),
      // A campaign that does not bucket is not one whose leads are unsorted;
      // it is one nobody asked the question of. Filtering here rather than
      // inside the reader keeps `keys` to the campaigns that actually
      // contributed.
      leadBucketKey: { not: null },
    },
    select: { id: true, leadBucketKey: true, wonBuckets: true },
  });

  const empty: InterestBuckets = {
    buckets: [],
    bucketed: 0,
    won: 0,
    truncated: false,
    keys: [],
    distinctKeys: 0,
  };

  if (campaigns.length === 0) return empty;

  // The contact-level filters go down too. Without them this ring would be
  // drawn over a wider population than the two beside it, under the one
  // denominator the card prints.
  const perCampaign = await campaignLeadBuckets(campaigns, query.range, {
    statuses: query.leadStates,
    createdFrom: query.leadCreatedFrom,
    createdUntil: query.leadCreatedUntil,
  });

  const totals = new Map<string, number>();
  const contributing = new Set<string>();
  let bucketed = 0;
  let won = 0;
  let truncated = false;

  for (const [campaignId, report] of Object.entries(perCampaign)) {
    // `keys` names the questions that actually fed the ring, not every
    // campaign in scope that happens to declare one. A second bucketing
    // campaign that placed no calls in the window made the card say two
    // questions fed a single-key ring — the exact misreading `distinctKeys`
    // exists to prevent.
    if (report.bucketed > 0) contributing.add(campaignId);

    // `bucketed` and `won` are window aggregates over EVERY bucket, so they
    // survive the per-campaign cap. Summing the visible list instead would
    // make the ring's total shrink as a campaign's vocabulary grew.
    bucketed += report.bucketed;
    won += report.won;
    truncated ||= report.truncated;

    for (const bucket of report.buckets) {
      // Folded again on the way in. Each campaign folded within itself, but
      // two campaigns can still surface `Hot` and `hot` as separate names,
      // and the whole point of pooling is that those are one slice.
      const name = foldBucketName(bucket.name);
      totals.set(name, (totals.get(name) ?? 0) + bucket.count);
    }
  }

  const buckets = [...totals]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const keys = [
    ...new Set(
      campaigns.filter((c) => contributing.has(c.id)).map((c) => c.leadBucketKey!),
    ),
  ].sort();

  return {
    buckets: buckets.slice(0, MAX_REPORTED_BUCKETS),
    bucketed,
    won,
    truncated: truncated || buckets.length > MAX_REPORTED_BUCKETS,
    keys: keys,
    distinctKeys: keys.length,
  };
}

/** `COUNT(DISTINCT campaignContactId)` over the attempts in scope. */
interface AttemptedRow {
  n: number;
}

/**
 * One `(status, goalAchieved)` cell of the reached population.
 *
 * `status` arrives as text because the column is a Postgres enum and the raw
 * read casts it; it is narrowed back to `CampaignContactStatus` at the one
 * place it is compared, against `SETTLED_STATUSES`.
 */
interface BreakdownRow {
  status: string;
  goal_achieved: boolean | null;
  n: number;
}

/**
 * The outcome payload AND the inbound half it was built from.
 *
 * Activity and Spend both need the outcome's denominators and the inbound
 * half's own figures — the talk-time average and the credits, neither of which
 * belongs on the outcome payload. Returning both from one call is what keeps
 * those two tabs from reading the inbound rows a second time, on a second
 * snapshot, to print figures beside the ones they already have.
 */
async function computeOutcome(
  workspaceId: string,
  query: LeadQuery,
): Promise<{ outcome: LeadOutcome; inbound: InboundHalf | null }> {
  const scope = attemptScopeSql(workspaceId, query);

  /*
    Both reads are driven FROM `CallAttempt` and joined up through `Campaign`,
    rather than read off `CampaignContact` with a `callAttempts: { some }`.

    **That is a performance fix, not a style one.** The Prisma form compiles to
    a semi-join whose only attempt-side predicates are `campaignContactId` and
    `startedAt`, and no index on this table covers that pair — nothing leads on
    `startedAt` at all. The planner's choices were one probe per contact, or a
    hash semi-join over every tenant's attempts filtered by date alone: one
    member's GET scanning the whole platform's call history, on a route with no
    rate limit and a 366-day ceiling. Led by the campaign instead, both ride
    `CallAttempt_campaignId_startedAt_idx`.

    `COUNT(DISTINCT ...)` because the unit is the LEAD: a lead rung four times
    inside the window is one row here and four attempts, which is the single
    distinction this whole service exists to keep.

    `reachedAttemptSql` rather than a disposition list written out here.
    "Reached" is not only an allow-list of dispositions — a human who answered
    with no disposition recorded is reached too — and a second definition in
    this file would drift from the first the next time the carrier adds a
    label. Applied to the attempt inside one statement, so a lead with an
    out-of-window conversation and an in-window failed dial is not counted as
    reached; as two independent predicates it would be.
  */
  const [attemptedRows, breakdown, interest, inbound] = await Promise.all([
    prisma.$queryRaw<AttemptedRow[]>`
      SELECT COUNT(DISTINCT a."campaignContactId")::int AS n
      ${scope}
        AND a."campaignContactId" IS NOT NULL
    `,
    /*
      One grouped read for every distribution, rather than one count per
      slice. Separate statements take separate READ COMMITTED snapshots, and
      these are partitions of one population — a ring assembled across
      snapshots can sum to more or less than the total printed in its middle
      while every individual number is true. The campaigns list's `outcomes`
      block carries the same rule for the same reason.
    */
    prisma.$queryRaw<BreakdownRow[]>`
      SELECT
        cc."status"::text            AS status,
        cc."goalAchieved"            AS goal_achieved,
        COUNT(DISTINCT cc."id")::int AS n
      FROM "CallAttempt" a
      JOIN "Campaign" c ON c."id" = a."campaignId"
      JOIN "CampaignContact" cc ON cc."id" = a."campaignContactId"
      WHERE ${campaignSql(workspaceId, query)}
        AND a."startedAt" >= ${query.range.from}
        AND a."startedAt" <= ${query.range.to}
        AND ${reachedAttemptSql('a')}
        ${contactInlineSql(query, 'cc')}
      GROUP BY 1, 2
    `,
    pooledInterest(workspaceId, query),
    inboundHalf(workspaceId, query),
  ]);

  const attemptedLeads = attemptedRows[0]?.n ?? 0;

  const settled = new Set<CampaignContactStatus>(SETTLED_STATUSES);

  const leadState: LeadStateCounts = { completed: 0, active: 0 };
  const goal: GoalCounts = { yes: 0, no: 0, notEvaluated: 0 };
  const qualification: QualificationCounts = {
    qualified: 0,
    notQualified: 0,
    inProgress: 0,
    notEvaluated: 0,
  };
  let population = 0;

  for (const row of breakdown) {
    const n = row.n;
    population += n;

    // `SETTLED_STATUSES` rather than a list of names here. EXCLUDED is
    // deliberately outside it — an operator's removal decremented
    // `totalContacts`, so calling it completed puts this one ahead of the
    // campaign it describes.
    const isSettled = settled.has(row.status as CampaignContactStatus);

    if (isSettled) leadState.completed += n;
    else leadState.active += n;

    if (row.goal_achieved === true) goal.yes += n;
    else if (row.goal_achieved === false) goal.no += n;
    else goal.notEvaluated += n;

    /*
      The qualification ring, derived here and nowhere else.

      | Qualified     | settled and the goal was met     |
      | Not Qualified | settled and the goal was missed  |
      | In Progress   | not settled, whatever the goal   |
      | Not Evaluated | settled with no verdict          |

      The four are exhaustive over (settled, goalAchieved) by construction —
      the `else` arms have no gap — which is what makes them a partition
      rather than four counts that happen to nearly add up. A lead falling
      through all four would shrink the ring silently.
    */
    if (!isSettled) qualification.inProgress += n;
    else if (row.goal_achieved === true) qualification.qualified += n;
    else if (row.goal_achieved === false) qualification.notQualified += n;
    else qualification.notEvaluated += n;
  }

  const outcome: LeadOutcome = {
    range: query.range,
    totals: {
      attemptedLeads,
      connectedLeads: population,
      connectivity: rate(population, attemptedLeads),
      // Over the reached population, not the dialled one: a lead nobody
      // spoke to was never judged against the goal, so counting it in the
      // denominator reports unreached numbers as missed goals.
      goalAchievedRate: rate(goal.yes, population),
    },
    population,
    leadState,
    goal,
    qualification,
    interest,
    // Spread rather than assigned: a bare `undefined` key is dropped by
    // `JSON.stringify` but still answers `'inbound' in payload`, so a reader
    // testing for the key would see one on a workspace that has none.
    ...(inbound ? { inbound: inbound.counts } : {}),
  };

  return { outcome, inbound };
}

export async function leadOutcome(
  workspaceId: string,
  query: LeadQuery,
): Promise<LeadOutcome> {
  return (await computeOutcome(workspaceId, query)).outcome;
}

/* ------------------------------------------------------------------ *
 * Activity: how the dialling itself went.
 * ------------------------------------------------------------------ */

export interface ActivityTotals {
  attemptedLeads: number;
  connectedLeads: number;
  connectivity: number | null;
  /**
   * Mean seconds of a **reached** call, or null when none were reached.
   *
   * Over the conversations and not over every dial. A no-answer ran for zero
   * seconds and is not a short conversation; averaging it in drags the figure
   * toward zero and reports a campaign that talks for two minutes as talking
   * for one. Null rather than 0 for the same reason every rate here is.
   */
  avgTalkSecs: number | null;
}

export interface CallerIdRow {
  /** Null is a real row: every attempt predating the rotation carries one. */
  fromNumber: string | null;
  attempted: number;
  connected: number;
  noAnswer: number;
  failed: number;
  connectivity: number | null;
}

/** One cell of the weekly pattern. `weekday` is 0 = Sunday. */
export interface WeeklyCell {
  weekday: number;
  hour: number;
  attempted: number;
  connected: number;
}

export interface LeadActivity {
  range: AnalyticsRange;
  /** The zone the weekly pattern was bucketed in. Stated, never assumed. */
  timeZone: string;
  totals: ActivityTotals;
  callerIds: CallerIdRow[];
  weekly: WeeklyCell[];
  /**
   * The answered half, with its own talk-time average.
   *
   * Its own, because an inbound conversation is not a dial: averaging the two
   * together would report one figure over two populations. Absent when
   * nothing in scope answers calls.
   */
  inbound?: (LeadInbound & { avgTalkSecs: number | null }) | undefined;
}

export interface ActivityQuery extends LeadQuery {
  /** An IANA zone. Defaults to UTC, and an unresolvable one throws. */
  timeZone?: string;
}

/**
 * The attempts this query is about, as SQL.
 *
 * The scope goes through the campaign rather than `CallAttempt.workspaceId`,
 * matching `contactScope`: one predicate for the page, so the tiles and the
 * tables below them cannot end up describing different populations.
 */
function attemptScopeSql(workspaceId: string, query: LeadQuery): Prisma.Sql {
  return Prisma.sql`
    FROM "CallAttempt" a
    JOIN "Campaign" c ON c."id" = a."campaignId"
    WHERE ${campaignSql(workspaceId, query)}
      AND a."startedAt" >= ${query.range.from}
      AND a."startedAt" <= ${query.range.to}
      ${contactExistsSql(query)}
  `;
}

interface CallerRow {
  from_number: string | null;
  attempted: bigint;
  connected: bigint;
  no_answer: bigint;
  failed: bigint;
}

interface WeeklyRow {
  weekday: number;
  hour: number;
  attempted: bigint;
  connected: bigint;
}

interface TalkRow {
  avg_secs: number | null;
}

export async function leadActivity(
  workspaceId: string,
  query: ActivityQuery,
): Promise<LeadActivity> {
  const scope = attemptScopeSql(workspaceId, query);
  const reached = reachedAttemptSql('a');

  /*
    The zone is resolved against POSTGRES' own catalogue before it reaches a
    statement — not against `Intl`, which accepts names this database does
    not carry and canonicalises the ones it shares in the opposite
    direction. `resolvePgTimeZone` has the whole argument; the short version
    is that a browser in India says `Asia/Calcutta` and Postgres only knows
    `Asia/Kolkata`, and an `Intl` check waves that through into a 500.

    Refused rather than quietly bucketed in UTC: a heatmap computed in one
    zone and labelled with another is wrong in the one way nothing on the
    page could reveal.
  */
  const requested = query.timeZone ?? 'UTC';
  const timeZone = await resolvePgTimeZone(requested);

  if (timeZone === null) throw new UnknownTimeZoneError(requested);

  const [{ outcome, inbound }, talk, callers, weekly] = await Promise.all([
    computeOutcome(workspaceId, query),
    prisma.$queryRaw<TalkRow[]>`
      SELECT AVG(a."durationSecs")::float8 AS avg_secs
      ${scope}
        AND a."durationSecs" IS NOT NULL
        AND ${reached}
    `,
    /*
      `launchError IS NULL` — the only evidence a telephone actually rang.

      An attempt the platform refused at launch is written pre-dial with the
      DID already stamped and no disposition, so it counted in `attempted` and
      in none of `connected`, `no_answer` or `failed`, silently dragging
      `connectivity` down for whichever number was next in the rotation. This
      table exists to prompt a rotation change, so a number made to look bad by
      a refusal that never reached the carrier is a wrong ACTION, not just a
      wrong figure. The same predicate `CampaignConnect.notConnected` keeps.
    */
    prisma.$queryRaw<CallerRow[]>`
      SELECT
        a."fromNumber"                                   AS from_number,
        COUNT(*)                                         AS attempted,
        COUNT(*) FILTER (WHERE ${reached})               AS connected,
        COUNT(*) FILTER (WHERE LOWER(a."disposition") = 'no_answer') AS no_answer,
        COUNT(*) FILTER (WHERE LOWER(a."disposition") IN ('failed', 'blocked')) AS failed
      ${scope}
        AND a."launchError" IS NULL
      GROUP BY a."fromNumber"
    `,
    /*
      `AT TIME ZONE` twice, which is not a typo.

      `startedAt` is a naive `timestamp` already holding UTC. The first
      conversion labels it as UTC to get a `timestamptz`; the second reads
      that instant back in the target zone. One alone would follow the
      SESSION's zone, which nothing sets and Prisma does not pin — the same
      trap the overview's `date_trunc` comment documents.
    */
    prisma.$queryRaw<WeeklyRow[]>`
      SELECT
        EXTRACT(DOW  FROM (a."startedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone})::int AS weekday,
        EXTRACT(HOUR FROM (a."startedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone})::int AS hour,
        COUNT(*)                           AS attempted,
        COUNT(*) FILTER (WHERE ${reached}) AS connected
      ${scope}
      GROUP BY 1, 2
      ORDER BY 1, 2
    `,
  ]);

  const callerIds: CallerIdRow[] = callers
    .map((row) => ({
      fromNumber: row.from_number,
      attempted: Number(row.attempted),
      connected: Number(row.connected),
      noAnswer: Number(row.no_answer),
      failed: Number(row.failed),
      connectivity: rate(Number(row.connected), Number(row.attempted)),
    }))
    // Which of my numbers is still being picked up, best first. Ties break on
    // the number so the order does not wander between reads.
    .sort(
      (a, b) =>
        (b.connectivity ?? -1) - (a.connectivity ?? -1) ||
        b.attempted - a.attempted ||
        (a.fromNumber ?? '').localeCompare(b.fromNumber ?? ''),
    );

  return {
    range: query.range,
    timeZone,
    totals: {
      attemptedLeads: outcome.totals.attemptedLeads,
      connectedLeads: outcome.totals.connectedLeads,
      connectivity: outcome.totals.connectivity,
      avgTalkSecs: talk[0]?.avg_secs ?? null,
    },
    ...(inbound ? { inbound: { ...inbound.counts, avgTalkSecs: inbound.avgTalkSecs } } : {}),
    callerIds,
    weekly: weekly.map((row) => ({
      weekday: row.weekday,
      hour: row.hour,
      attempted: Number(row.attempted),
      connected: Number(row.connected),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Spend: what the leads cost.
 * ------------------------------------------------------------------ */

export interface SpendPoint {
  /** A UTC day, `YYYY-MM-DD`. */
  date: string;
  /** Display credits. `'0'` on a day with no charges — `toDisplayCredits`
   *  trims trailing zeros, so this is not a fixed-width decimal. */
  credits: string;
}

export interface LeadSpend {
  range: AnalyticsRange;
  /** Whether per-minute calling is billed on this deployment. */
  metered: boolean;
  /**
   * Display credits across BOTH directions, or null when nothing was charged.
   *
   * Money is the one figure inbound is folded into. A credit is spent
   * whichever way the phone rang, so a total that counted only dials would
   * understate the bill on every workspace that answers calls — which is what
   * it did, because an inbound charge carries `reference` and not
   * `callAttemptId` and the attempt-joined read cannot see it.
   */
  totalSpend: string | null;
  /** The dialled half alone, or null when no dial was charged. */
  outboundSpend: string | null;
  /**
   * The answered half alone, or null when nothing inbound was charged.
   *
   * Named separately because the `costPer*` figures below divide only the
   * OUTBOUND half by outbound denominators — a ratio needs one population,
   * and `attemptedLeads` counts dials.
   */
  inboundSpend: string | null;
  costPerConnectedLead: string | null;
  costPerGoalLead: string | null;
  costPerInterestedLead: string | null;
  timeline: SpendPoint[];
}

/**
 * Calling is metered on this backend: the dialer prices each attempt and
 * writes a ledger row when the call completes. Read from the payload by the
 * page rather than assumed, so a deployment that stops billing does not
 * leave a credits figure on screen that nobody was charged.
 */
const METERED = true;

interface SpendDayRow {
  day: Date;
  amount: bigint | null;
}

/**
 * A cost per lead, or null when there is no denominator.
 *
 * Divided in INTERNAL units and converted once, so the 0.0001 precision the
 * multiplier exists for survives the division. Never a float: a per-lead cost
 * is exactly the kind of value that ends up in a billing dispute.
 */
function perLead(totalInternal: bigint, leads: number): string | null {
  if (leads <= 0 || totalInternal === 0n) return null;

  return toDisplayCredits(totalInternal / BigInt(leads));
}

/** Every UTC day in the range, so the series is dense. */
function daysOf(range: AnalyticsRange): string[] {
  const days: string[] = [];
  const cursor = new Date(
    Date.UTC(
      range.from.getUTCFullYear(),
      range.from.getUTCMonth(),
      range.from.getUTCDate(),
    ),
  );

  while (cursor.getTime() <= range.to.getTime()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return days;
}

export async function leadSpend(
  workspaceId: string,
  query: LeadQuery,
): Promise<LeadSpend> {
  const [{ outcome, inbound }, perDay] = await Promise.all([
    computeOutcome(workspaceId, query),
    /*
      `CALL_USAGE` only, scoped THROUGH the attempt, and read ONCE.

      The type filter excludes `CALL_USAGE_SHORTFALL`, a zero-amount marker
      for a call that completed against a balance too small to cover it —
      the cost is real and nothing was debited. And the scope is the call's
      own window rather than the ledger row's `createdAt`, because a charge
      lands minutes after its call: filtering on the ledger's clock drops the
      last day's calls out of the money column while leaving them in the call
      count beside it.

      Summed from the ledger and never from `CallAttempt.costCredits`, which
      also records what was OWED on that shortfall.

      **`totalSpend` is summed from these days rather than read separately.**
      Every charged row is inside the range, so the day sums add up to the
      total by construction — where two statements would take two READ
      COMMITTED snapshots and put a total beside a timeline that need not
      agree with it. The same rule `leadOutcome`'s grouped read keeps.

      The predicates are `campaignSql` and `contactExistsSql`, not a third
      hand-written copy: this read used to carry its own campaign clause and
      no contact clause at all, which is how the money column came to
      describe a wider population than the tiles it sat beside.
    */
    prisma.$queryRaw<SpendDayRow[]>`
      SELECT
        date_trunc('day', a."startedAt") AS day,
        SUM(t."amount")::bigint          AS amount
      FROM "CreditTransaction" t
      JOIN "CallAttempt" a ON a."id" = t."callAttemptId"
      JOIN "Campaign" c ON c."id" = a."campaignId"
      WHERE t."type" = 'CALL_USAGE'
        AND ${campaignSql(workspaceId, query)}
        AND a."startedAt" >= ${query.range.from}
        AND a."startedAt" <= ${query.range.to}
        ${contactExistsSql(query)}
      GROUP BY 1
    `,
  ]);

  const byDay = new Map<string, bigint>();
  // Usage is written as a negative amount, so the spend is its negation.
  let spent = 0n;
  for (const row of perDay) {
    const amount = -(row.amount ?? 0n);
    byDay.set(row.day.toISOString().slice(0, 10), amount);
    spent += amount;
  }

  const inboundSpent = inbound?.credits ?? 0n;
  const total = spent + inboundSpent;

  return {
    range: query.range,
    metered: METERED,
    // Null rather than zero: a zero under a credits heading reads as "these
    // calls were free", where the truth is that none were charged.
    totalSpend: total === 0n ? null : toDisplayCredits(total),
    outboundSpend: spent === 0n ? null : toDisplayCredits(spent),
    inboundSpend: inboundSpent === 0n ? null : toDisplayCredits(inboundSpent),
    costPerConnectedLead: perLead(spent, outcome.population),
    costPerGoalLead: perLead(spent, outcome.goal.yes),
    // The denominator is `won`, not `bucketed`: an "interested" lead is one
    // whose answer its own campaign counts as won, which is what the tile
    // beside it on the Outcome tab divides by. A campaign carrying a
    // `leadBucketKey` and an empty `wonBuckets` therefore leaves this null
    // for ever while `bucketed` is large — legal, and the honest reading of
    // a campaign that sorts its leads without marking any answer as won.
    costPerInterestedLead: perLead(spent, outcome.interest.won),
    timeline: daysOf(query.range).map((date) => ({
      date,
      credits: toDisplayCredits(byDay.get(date) ?? 0n),
    })),
  };
}
