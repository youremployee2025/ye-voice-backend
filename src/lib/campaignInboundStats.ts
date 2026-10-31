import { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { CALL_OUTCOME_KEY, CALL_OUTCOMES, type CallOutcome } from './extractionConfig.js';

/**
 * What an inbound-facing campaign has RECEIVED, beside the `outcomes` block
 * that says what its contacts have been dialled into.
 *
 * Read off `CampaignInboundCall`, never off `CampaignContact`: a contact row
 * is one person, and the question here is calls. `callers` counts distinct
 * numbers rather than contact rows, so a stranger who rang three times is one
 * caller and three calls whether or not the settle has enrolled them yet.
 * `unknownCalls` is the count of calls with no contact attached at the time of
 * reading — on an INBOUND campaign that shrinks as settles enrol callers.
 *
 * `lastCallAt` is the end when the call has one and the arrival otherwise, so
 * a call still open reads as the campaign's most recent activity.
 */
export interface CampaignInboundOutcomes {
  calls: number;
  callers: number;
  unknownCalls: number;
  talkSecs: number;
  lastCallAt: string | null;
}

export const EMPTY_INBOUND_OUTCOMES: CampaignInboundOutcomes = {
  calls: 0,
  callers: 0,
  unknownCalls: 0,
  talkSecs: 0,
  lastCallAt: null,
};

/**
 * One grouped statement for a whole page of campaigns, the shape
 * `campaignOutcomes` has and for the same reason: the list's job is to load
 * quickly. Every id asked for is answered, zeroed when it has no calls, so a
 * caller can index without a fallback. Rides `[campaignId, arrivedAt]`.
 *
 * KNOWN COST, written down rather than discovered later: this is an ALL-TIME
 * aggregate over a table that only grows. `campaignOutcomes` beside it
 * aggregates `CampaignContact`, which is bounded by the uploaded list;
 * `CampaignInboundCall` is bounded by nothing — a DID taking 500 calls a day
 * is ~180k rows a year, and a list page asks for up to 25 campaigns at once.
 * `COUNT(DISTINCT "fromNumber")` cannot be answered from the index alone, so
 * every one of those rows is touched. It is fine at today's volumes and it
 * will not stay fine; the fix when it stops being fine is a per-campaign
 * rollup maintained at settle, not another index here.
 */
export async function inboundOutcomes(
  campaignIds: readonly string[],
): Promise<Record<string, CampaignInboundOutcomes>> {
  const out: Record<string, CampaignInboundOutcomes> = Object.fromEntries(
    campaignIds.map((id) => [id, { ...EMPTY_INBOUND_OUTCOMES }]),
  );
  if (campaignIds.length === 0) return out;

  const rows = await prisma.$queryRaw<
    Array<{
      campaignId: string;
      calls: bigint;
      callers: bigint;
      unknown_calls: bigint;
      talk_secs: bigint;
      last_call_at: Date | null;
    }>
  >`
    SELECT "campaignId",
           COUNT(*)                                            AS calls,
           COUNT(DISTINCT "fromNumber")                        AS callers,
           COUNT(*) FILTER (WHERE "campaignContactId" IS NULL) AS unknown_calls,
           COALESCE(SUM("durationSecs"), 0)::bigint            AS talk_secs,
           MAX(COALESCE("endedAt", "arrivedAt"))               AS last_call_at
    FROM "CampaignInboundCall"
    WHERE "campaignId" IN (${Prisma.join([...campaignIds])})
    GROUP BY "campaignId"`;

  for (const row of rows) {
    out[row.campaignId] = {
      calls: Number(row.calls),
      callers: Number(row.callers),
      unknownCalls: Number(row.unknown_calls),
      talkSecs: Number(row.talk_secs),
      lastCallAt: row.last_call_at ? row.last_call_at.toISOString() : null,
    };
  }

  return out;
}

/**
 * What the workspace was charged for a campaign's inbound calls, and how many
 * of its calls that figure covers.
 *
 * Both come off ONE ledger join, and the count is here rather than in the
 * browser for the reason the sum is: the ledger is the only place that knows.
 *
 * ## The sum
 *
 * In internal credits, summed from the LEDGER — never from
 * `CampaignInboundCall.costCredits`, for the reason `/stats` gives for the
 * outbound figure: a shortfall records what was owed and never taken. An
 * inbound charge carries no `callAttemptId`; its `reference` is the inbound
 * call's id, which is the join here.
 *
 * ## The count, and why a tile needs it
 *
 * `Dhandha Support Inbound` reads `137 calls · 5h 8m talk time · 25.9
 * credits`. Every figure is right and the three together read as a fault: 5h
 * 8m at any plausible rate is not 25.9 credits. 135 of those calls were billed
 * on the Vocobase platform before YE existed and were imported as history,
 * so they carry no ledger row here at all — and `137` is therefore the wrong
 * denominator for `25.9`.
 *
 * `billedCalls` is the right one. `COUNT(DISTINCT c.id)`, not `COUNT(*)`,
 * though `@@unique([accountId, reference])` makes a second `CALL_USAGE` row
 * against one call unwritable today: the sum wants every row and the
 * denominator wants every CALL, and writing the count in terms of the thing it
 * counts costs nothing and does not depend on that index staying as it is.
 * There is deliberately no test for the second row — the constraint refuses to
 * let one be created, and a test that reached around it would be asserting
 * over a state production cannot produce.
 *
 * ## The range is the CALL's arrival, not the ledger row's clock
 *
 * A charge lands after its call — seconds later on a good day, minutes on a
 * bad one. Filtering on `CreditTransaction.createdAt` would drop the last
 * day's calls out of the money column while leaving them in the call count
 * beside it, which is the same trap the outbound figure documents for scoping
 * through `callAttempt` rather than through the ledger row's own timestamp.
 *
 * `ALL_TIME` is what the lifetime callers pass — `/stats` and the campaign
 * list report a campaign's whole life and must go on doing so.
 *
 * ## Why the account is pinned
 *
 * Scoped by `accountId` as well, and that is not belt-and-braces — it is the
 * only reason this query is cheap. `CreditTransaction` has no index on
 * `reference` alone; it has `@@unique([accountId, reference])`. Joining on
 * `reference` by itself is a full scan of the production ledger on every
 * `/stats` load of an inbound campaign. With the account pinned, each inbound
 * call is one lookup on that unique index. (The outbound figure on the same
 * endpoint gets this for free: it joins on `callAttemptId`, which is indexed.)
 */
export interface InboundCredits {
  /** Internal credits. */
  credits: bigint;
  /** Distinct calls on this campaign that YE charged for at all. */
  billedCalls: number;
}

export async function inboundCredits(
  workspaceId: string,
  campaignId: string,
  accountId: string,
  range: InboundRange,
): Promise<InboundCredits> {
  const [row] = await prisma.$queryRaw<Array<{ credits: bigint | null; billed_calls: bigint }>>`
    SELECT COALESCE(SUM(-t.amount), 0)::bigint AS credits,
           COUNT(DISTINCT c.id)::bigint        AS billed_calls
    FROM "CampaignInboundCall" c
    JOIN "CreditTransaction" t
      ON t."accountId" = ${accountId} AND t.reference = c.id AND t.type = 'CALL_USAGE'
    WHERE c."campaignId" = ${campaignId}
      AND c."workspaceId" = ${workspaceId}
      AND c."arrivedAt" >= ${range.from}
      AND c."arrivedAt" <= ${range.to}`;

  return { credits: row?.credits ?? 0n, billedCalls: Number(row?.billed_calls ?? 0n) };
}

/**
 * What each of a page of contacts has CALLED IN, for a campaign that answers.
 *
 * Raw rather than `groupBy`, for one reason: `lastCallAt` must be
 * `MAX(COALESCE("endedAt", "arrivedAt"))` — one value off ONE row. Prisma's
 * `_max: { endedAt, arrivedAt }` returns two independent maxima that need not
 * come from the same call, so a contact with one settled call at 10:05 and one
 * still open since 12:00 reads 10:05 here and 12:00 on the campaign tile above
 * it. Same expression as `inboundOutcomes`, so the two surfaces agree.
 */
export interface ContactInboundSummary {
  calls: number;
  talkSecs: number;
  lastCallAt: string | null;
}

export async function inboundByContact(
  campaignContactIds: readonly string[],
): Promise<Map<string, ContactInboundSummary>> {
  const out = new Map<string, ContactInboundSummary>();
  if (campaignContactIds.length === 0) return out;

  const rows = await prisma.$queryRaw<
    Array<{ campaignContactId: string; calls: bigint; talk_secs: bigint; last_call_at: Date | null }>
  >`
    SELECT "campaignContactId",
           COUNT(*)                                 AS calls,
           COALESCE(SUM("durationSecs"), 0)::bigint AS talk_secs,
           MAX(COALESCE("endedAt", "arrivedAt"))    AS last_call_at
    FROM "CampaignInboundCall"
    WHERE "campaignContactId" IN (${Prisma.join([...campaignContactIds])})
    GROUP BY "campaignContactId"`;

  for (const row of rows) {
    out.set(row.campaignContactId, {
      calls: Number(row.calls),
      talkSecs: Number(row.talk_secs),
      lastCallAt: row.last_call_at ? row.last_call_at.toISOString() : null,
    });
  }

  return out;
}

/**
 * The range every read on this surface takes.
 *
 * `arrivedAt`, always — the rest of the analytics service ranges on
 * `startedAt` and `CampaignInboundCall` has no such column. `arrivedAt` is
 * stamped when the carrier's routing callback lands, which is the moment the
 * phone rang: a call that arrives at 23:58 and ends at 00:04 belongs to the
 * first day, which is the reading an operator wants of "when did the phone
 * ring". It is also the only one of the two instants that is never null, so an
 * open call is on the chart rather than missing from it until it settles.
 */
export interface InboundRange {
  from: Date;
  to: Date;
}

/**
 * Every call, for the callers that want the campaign's whole life.
 *
 * `/stats` and the campaign list report lifetime figures and must go on doing
 * so: a strip that silently became month-to-date would be a regression in what
 * #77 shipped, visible to an operator as numbers that fell overnight.
 */
export const ALL_TIME: InboundRange = {
  from: new Date(0),
  to: new Date('9999-12-31T23:59:59.999Z'),
};

export interface InboundPoint {
  /** `YYYY-MM-DD`, a UTC day — the `AnalyticsPoint` convention. */
  date: string;
  calls: number;
  talkSecs: number;
}

/**
 * Calls received per day, over a range.
 *
 * `date_trunc` takes the **bare column**, with no `AT TIME ZONE`, matching
 * `campaignSeries`. `arrivedAt` is a naive timestamp already holding UTC, and
 * `"arrivedAt" AT TIME ZONE 'UTC'` reads like it forces the intended zone while
 * doing the opposite — it yields a `timestamptz`, whose truncation follows the
 * session's `TimeZone`, which nothing sets and Prisma does not pin. Two day
 * boundaries on one page is how a chart and the tile above it come to disagree.
 *
 * Talk time is `COALESCE(SUM("durationSecs"), 0)`. A day whose only call is
 * still on the line reads one call and no seconds: the seconds are not yet
 * known, and the chart says so by the call being there with a flat bar beside
 * it rather than by the day being absent.
 *
 * Densified over the whole range, zeros included, for the reason the outbound
 * series densifies: a sparse series drawn as a line silently connects across
 * its gaps and renders a quiet week as a decline.
 *
 * `workspaceId` is redundant with the ownership check the route has already
 * made, and is here on purpose — the rule every neighbouring query in this
 * service follows, so that a later refactor of that lookup cannot silently
 * widen this one.
 */
export async function inboundSeries(
  workspaceId: string,
  campaignId: string,
  range: InboundRange,
): Promise<InboundPoint[]> {
  const rows = await prisma.$queryRaw<Array<{ day: Date; calls: bigint; talk_secs: bigint }>>`
    SELECT date_trunc('day', "arrivedAt")          AS day,
           COUNT(*)::bigint                        AS calls,
           COALESCE(SUM("durationSecs"), 0)::bigint AS talk_secs
      FROM "CampaignInboundCall"
     WHERE "campaignId" = ${campaignId}
       AND "workspaceId" = ${workspaceId}
       AND "arrivedAt" >= ${range.from}
       AND "arrivedAt" <= ${range.to}
     GROUP BY 1`;

  const byDay = new Map(
    rows.map((row) => [
      row.day.toISOString().slice(0, 10),
      { calls: Number(row.calls), talkSecs: Number(row.talk_secs) },
    ]),
  );

  const out: InboundPoint[] = [];
  const cursor = new Date(
    Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), range.from.getUTCDate()),
  );

  while (cursor <= range.to) {
    const date = cursor.toISOString().slice(0, 10);
    out.push({ date, calls: 0, talkSecs: 0, ...byDay.get(date) });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return out;
}

export interface InboundOutcomeCount {
  /** `null` is a real bucket: no note at all, or a note whose verdict this
   *  build cannot read. */
  outcome: CallOutcome | null;
  count: number;
}

/**
 * How the conversations went, by the bot's own verdict.
 *
 * Beside the carrier's disposition rather than instead of it: they answer
 * different questions, and a call that completed perfectly can still leave the
 * caller's business unfinished.
 *
 * Read straight out of the extraction JSON in SQL rather than through
 * `readCallNote` in TypeScript, because this is an aggregate: pulling every row
 * into the process to classify it would make the cost of one chart grow with
 * the campaign's call volume, which is exactly what a chart of a busy campaign
 * must not do. The key is the same `CALL_OUTCOME_KEY` constant `readCallNote`
 * reads, so the two cannot drift apart on the NAME; they could still drift on
 * the vocabulary, which is why the values are filtered against `CALL_OUTCOMES`
 * here too.
 *
 * **A value outside the enum is not a new bucket.** The platform's value set
 * grows without either side deploying, and a chart that invented a bar for one
 * would be reporting this service's vocabulary rather than the calls. It joins
 * the `null` bucket, with the notes that carry no verdict at all: in both cases
 * we do not know how the conversation went, and splitting them would put a bar
 * on the chart about our JSON rather than about the campaign.
 *
 * Every bucket is present, zeros included — the outcome list's rule. A
 * breakdown that omitted its empty rows would change shape between two
 * readings of one page and hide that a category exists.
 */
export async function inboundOutcomeBreakdown(
  workspaceId: string,
  campaignId: string,
  range: InboundRange,
): Promise<InboundOutcomeCount[]> {
  const rows = await prisma.$queryRaw<Array<{ outcome: string | null; count: bigint }>>`
    SELECT "extraction" ->> ${CALL_OUTCOME_KEY} AS outcome,
           COUNT(*)::bigint                     AS count
      FROM "CampaignInboundCall"
     WHERE "campaignId" = ${campaignId}
       AND "workspaceId" = ${workspaceId}
       AND "arrivedAt" >= ${range.from}
       AND "arrivedAt" <= ${range.to}
     GROUP BY 1`;

  const byOutcome = new Map<string, number>();
  let unknown = 0;

  for (const row of rows) {
    if (row.outcome !== null && (CALL_OUTCOMES as readonly string[]).includes(row.outcome)) {
      byOutcome.set(row.outcome, Number(row.count));
    } else {
      unknown += Number(row.count);
    }
  }

  return [
    ...CALL_OUTCOMES.map((outcome) => ({ outcome, count: byOutcome.get(outcome) ?? 0 })),
    { outcome: null, count: unknown },
  ];
}

export interface InboundRepeatCallers {
  callers: number;
  /** Callers who rang more than once in this range. */
  repeatCallers: number;
  /** One row per distinct call count, ascending. Empty when nobody rang — not
   *  zero-filled, because there is no natural set of counts to fill. */
  histogram: Array<{ calls: number; callers: number }>;
}

/**
 * Whether the same people are ringing back.
 *
 * Keyed on `fromNumber` and not on `contactId`, for `inboundOutcomes`' reason:
 * an unknown caller has no contact row until a settle enrols them, so a
 * stranger who rang three times before that would otherwise be three anonymous
 * calls and no caller at all.
 *
 * Scoped to the range like everything else on this report, which makes
 * `callers` here a SMALLER number than the lifetime `callers` on the Overview
 * strip. That is not a disagreement to fix — one counts the people who rang
 * this month and the other everyone who has ever rung — and the tab labels its
 * range above the tile.
 */
export async function inboundRepeatCallers(
  workspaceId: string,
  campaignId: string,
  range: InboundRange,
): Promise<InboundRepeatCallers> {
  const rows = await prisma.$queryRaw<Array<{ calls: bigint; callers: bigint }>>`
    SELECT calls, COUNT(*)::bigint AS callers
      FROM (
        SELECT "fromNumber", COUNT(*)::bigint AS calls
          FROM "CampaignInboundCall"
         WHERE "campaignId" = ${campaignId}
           AND "workspaceId" = ${workspaceId}
           AND "arrivedAt" >= ${range.from}
           AND "arrivedAt" <= ${range.to}
         GROUP BY "fromNumber"
      ) per_caller
     GROUP BY calls
     ORDER BY calls`;

  const histogram = rows.map((row) => ({
    calls: Number(row.calls),
    callers: Number(row.callers),
  }));

  return {
    callers: histogram.reduce((sum, row) => sum + row.callers, 0),
    repeatCallers: histogram
      .filter((row) => row.calls > 1)
      .reduce((sum, row) => sum + row.callers, 0),
    histogram,
  };
}

/**
 * How wide one bucket of `inboundBuckets` is.
 *
 * Fifteen minutes, and the number is not arbitrary. The Overview draws TWO
 * charts off ONE response — today hour by hour, and the last fortnight day by
 * day — and every IANA offset is a whole multiple of 15 minutes, so a local
 * hour anywhere on earth is exactly four of these buckets and a local day
 * exactly 96. One read, one grid, and the client assembles either chart from
 * it. Bucketing by day here would need a second grouping for the hourly half,
 * and two groupings of one window is how two charts on one page come to
 * disagree about which calls happened when.
 *
 * It is also what keeps the payload bounded by the WINDOW rather than by the
 * call volume: a fortnight is 1,440 integers whether the DID took ten calls or
 * ten thousand. Shipping arrival timestamps instead would have been simpler to
 * write and would have grown without limit on exactly the campaigns that most
 * need the chart.
 *
 * **A zone is not needed, rather than not available.** `resolvePgTimeZone`
 * landed on main with the lead analytics and would resolve one safely — the
 * alias trap (Chrome in India says `Asia/Calcutta`; this database carries only
 * `Asia/Kolkata`) is solved there. This path simply does not ask the question:
 * no zone on the wire, no catalogue read, and nothing to get wrong. If a
 * future caller needs the buckets pre-folded into local days, that helper is
 * the way to do it and this grid is what it should be folded from.
 */
export const INBOUND_BUCKET_MINUTES = 15;

const BUCKET_SECS = INBOUND_BUCKET_MINUTES * 60;
const BUCKET_MS = BUCKET_SECS * 1000;

/** The bucket boundary at or before `at`. Exported because the route has to
 *  align its window to the same grid the counts are on. */
export function floorToBucket(at: Date): Date {
  return new Date(Math.floor(at.getTime() / BUCKET_MS) * BUCKET_MS);
}

/**
 * Calls received per fifteen minutes, dense, from `since` up to but not
 * including `until`.
 *
 * `extract(epoch from "arrivedAt")` takes the **bare column**, for the reason
 * `inboundSeries` writes down at length: `arrivedAt` is a naive timestamp
 * already holding UTC, and Postgres reads the epoch of a `timestamp without
 * time zone` as UTC regardless of the session's `TimeZone` — which nothing
 * here sets and Prisma does not pin. An `AT TIME ZONE` on either side would
 * make the grid depend on the connection.
 *
 * Dense, zeros included, because the caller draws it as a bar per bucket: a
 * sparse series would silently close its own gaps and render a quiet night as
 * a shorter day.
 *
 * `workspaceId` is redundant with the ownership check the route has already
 * made, and is here for the reason every neighbouring query in this file keeps
 * it: a later refactor of that lookup must not be able to widen this one.
 */
export async function inboundBuckets(
  workspaceId: string,
  campaignId: string,
  since: Date,
  until: Date,
): Promise<number[]> {
  const rows = await prisma.$queryRaw<Array<{ slot: bigint; calls: bigint }>>`
    SELECT floor(extract(epoch from "arrivedAt") / ${BUCKET_SECS})::bigint AS slot,
           COUNT(*)::bigint                                                AS calls
      FROM "CampaignInboundCall"
     WHERE "campaignId" = ${campaignId}
       AND "workspaceId" = ${workspaceId}
       AND "arrivedAt" >= ${since}
       AND "arrivedAt" < ${until}
     GROUP BY 1`;

  const first = Math.floor(since.getTime() / BUCKET_MS);
  const out = new Array<number>(Math.max(0, Math.round((until.getTime() - since.getTime()) / BUCKET_MS))).fill(0);

  for (const row of rows) {
    const index = Number(row.slot) - first;
    // A row outside the array cannot happen while the WHERE clause and the
    // window agree, and is dropped rather than trusted if they ever stop
    // agreeing: a negative index would write to a property named "-1" and a
    // chart would read the right total off an array of the wrong length.
    if (index >= 0 && index < out.length) out[index] = Number(row.calls);
  }

  return out;
}

/**
 * When this campaign first answered anybody, ever — or null if it never has.
 *
 * Lifetime on purpose, beside a windowed series: it is the difference between
 * "nobody rang this fortnight" and "nobody has ever rung this number", and
 * those want different sentences on the page. Rides `[campaignId, arrivedAt]`.
 */
export async function inboundFirstCallAt(
  workspaceId: string,
  campaignId: string,
): Promise<string | null> {
  const row = await prisma.campaignInboundCall.findFirst({
    where: { campaignId, workspaceId },
    orderBy: { arrivedAt: 'asc' },
    select: { arrivedAt: true },
  });

  return row?.arrivedAt.toISOString() ?? null;
}
