import { listCalls } from '../adapter/vocobase.js';
import { parseCorrelationId } from '../lib/callCorrelation.js';
import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';
import { readNumber, readString } from '../lib/upstream.js';

/**
 * Filling the analytics fact table from the voice platform's call listing.
 *
 * This is the only thing on the analytics surface that talks upstream. Every
 * read route runs over `CallRecord` in the local database, because an
 * aggregate cannot be computed by the walk call history uses: that walk is
 * bounded at twenty upstream pages so one request cannot read an account's
 * whole history, which makes every total computed over it a total over a
 * truncated set. A list that is short is visibly short; a number that is short
 * is simply wrong.
 *
 * The awkward part, as everywhere on this platform, is that the upstream pool
 * is **partner-wide**. Ingest walks it once for the whole platform and stamps
 * each row with the workspace it resolves to; a mistake here does not lose
 * data, it puts one customer's traffic onto another customer's chart.
 */

/** Upstream caps a page at 100, so asking for fewer only costs more requests. */
export const UPSTREAM_PAGE_SIZE = 100;

/**
 * How far ahead of this server's clock an upstream `started_at` may sit and
 * still be believed.
 *
 * The high-water mark only ever moves forward, so a single row carrying a bad
 * carrier clock would otherwise park it in the future permanently: every later
 * pass would find page one already at or below the mark, exit immediately, and
 * silently degrade the walk from "read everything new" to "read the newest
 * hundred rows" with nothing to say so. A row dated past this bound is used for
 * ordering and stored like any other — it is only barred from moving the mark.
 */
const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Which workspace a call belongs to, and whether it is ours to store.
 *
 * `campaignCall` is the important one. A call whose correlation key resolves to
 * a campaign is **already recorded** by the dialer as a `CallAttempt`, with a
 * richer record than this table holds and written in real time. Ingesting it
 * here as well would double every campaign figure on every chart, so the walk
 * skips it — and this flag is how it knows.
 *
 * The campaign leg therefore still runs in full, including its two-factor
 * check: a forged correlation key must not cause a call to be *dropped* any
 * more than it should cause one to be misattributed. A key that fails the check
 * is not a campaign call, and the row falls through to the agent leg.
 */
export interface CallAttribution {
  workspaceId: string | null;
  agentId: string | null;
  /** The dialer already owns this call. Skip it; do not store it. */
  campaignCall: boolean;
}

const UNATTRIBUTED: CallAttribution = {
  workspaceId: null,
  agentId: null,
  campaignCall: false,
};

/** The correlation key as the platform spells it, on a listing row. */
function correlationOf(row: unknown) {
  return parseCorrelationId(readString(row, ['client_reference_id', 'clientReferenceId']));
}

/** The upstream agent id on a listing row. */
function agentIdOf(row: unknown): string | null {
  return readString(row, ['agent_id', 'agentId']);
}

/**
 * Decides the workspace for every row on a page.
 *
 * Two legs, the same two call history uses, resolved from maps built **once
 * per page** rather than per row — a page of a hundred must not be a hundred
 * queries, and the ordinary page carries no correlation key at all and so
 * costs one query rather than two.
 *
 * **The agent leg.** The row's `agent_id` is an upstream id and local `Agent`
 * rows are keyed by `externalId`. An agent with `workspaceId = null` maps
 * nothing: an unassigned agent sits in the pool and its calls belong to
 * nobody.
 *
 * `agentIsUsable` / `NOT_REMOVED` are deliberately not applied. Those answer
 * "may this workspace start something with this agent", and a retired agent
 * must not take new work. This asks whether the workspace *placed* the call,
 * which does not stop being true when staff retire the agent afterwards —
 * filtering here would erase a workspace's past on the day an agent is retired.
 *
 * **The campaign leg**, and why it takes two factors. `client_reference_id` is
 * free text on an account every customer of the platform shares, and a
 * campaign id is an ordinary identifier every member of a workspace can read.
 * A leg resting on the key alone would let anyone able to place a call on that
 * account drop their call into somebody else's history by writing one guessable
 * string into a field nobody validates. So the key's *contact* id is resolved
 * against the database and must name a contact that is actually on the campaign
 * the key claims. The contact id is the second factor and it is not derivable
 * from the first.
 *
 * **The campaign leg decides whether to store the row at all**, not which
 * workspace it belongs to. A call it resolves is a call the dialer already
 * wrote a `CallAttempt` for, so storing it here would double every campaign
 * figure on every chart. The leg runs in full anyway, two-factor check
 * included: a forged key must not cause a call to be dropped any more than it
 * should cause one to be misattributed, so a key that fails the check falls
 * through to the agent leg like any other row.
 *
 * What remains here is the agent leg, and with it the calls that have no local
 * record anywhere else — inbound, hand-placed, and calls on an agent no
 * workspace holds.
 */
export async function resolveAttribution(rows: unknown[]): Promise<CallAttribution[]> {
  if (rows.length === 0) return [];

  const externalIds = new Set<string>();
  const contactIds = new Set<string>();

  for (const row of rows) {
    const externalId = agentIdOf(row);
    if (externalId) externalIds.add(externalId);

    const correlation = correlationOf(row);
    if (correlation) contactIds.add(correlation.campaignContactId);
  }

  const [agents, contacts] = await Promise.all([
    externalIds.size === 0
      ? []
      : prisma.agent.findMany({
          where: { externalId: { in: [...externalIds] } },
          select: { id: true, externalId: true, workspaceId: true },
        }),
    contactIds.size === 0
      ? []
      : prisma.campaignContact.findMany({
          where: { id: { in: [...contactIds] } },
          select: {
            id: true,
            campaignId: true,
            campaign: { select: { workspaceId: true } },
          },
        }),
  ]);

  const agentsByExternalId = new Map(agents.map((agent) => [agent.externalId, agent]));
  const contactsById = new Map(contacts.map((contact) => [contact.id, contact]));

  return rows.map((row) => {
    const externalId = agentIdOf(row);
    const agent = externalId ? agentsByExternalId.get(externalId) ?? null : null;
    // An unassigned agent maps nothing. Recorded as no leg at all rather than
    // as an agent with a null workspace, so nothing downstream has to remember
    // that `agentId` set and `workspaceId` null means two different things.
    const agentWorkspaceId = agent?.workspaceId ?? null;

    const correlation = correlationOf(row);
    const contact = correlation ? contactsById.get(correlation.campaignContactId) ?? null : null;
    // Both halves of the key, or neither: the contact must be on the campaign
    // the key names. A contact that is real elsewhere proves nothing here.
    const campaignMatches = Boolean(
      correlation && contact && contact.campaignId === correlation.campaignId,
    );

    // The dialer's own record covers this call. Nothing else about the row
    // matters — it is not stored.
    if (campaignMatches) {
      return { workspaceId: null, agentId: null, campaignCall: true };
    }

    if (!agentWorkspaceId) return { ...UNATTRIBUTED };

    return {
      workspaceId: agentWorkspaceId,
      agentId: agent!.id,
      campaignCall: false,
    };
  });
}

/**
 * The scalar facts, read off an upstream listing row.
 *
 * Everything is optional because everything is absent on some real row.
 * `status` and `disposition` stay as sent: they follow whichever carrier placed
 * the call and their published sets grow without this service deploying, so
 * normalising them here would fold next month's value into something it is not.
 * Classification happens on the way out, in `src/lib/callOutcome.ts`.
 */
export interface CallFacts {
  upstreamCallId: string;
  direction: string | null;
  status: string | null;
  disposition: string | null;
  phone: string | null;
  startedAt: Date | null;
  durationSecs: number | null;
}

/**
 * The counterparty's number.
 *
 * `to_number` on an outbound call, `from_number` on an inbound one — the far
 * end, never ours. Storing both would duplicate what the DID inventory already
 * knows and would put this platform's own numbers into a customer-facing
 * export. An unreadable direction falls back to `to_number`, which is right for
 * the overwhelming majority of what this platform places.
 */
function counterparty(row: unknown): string | null {
  const direction = readString(row, ['direction'])?.trim().toLowerCase();

  return direction === 'inbound'
    ? readString(row, ['from_number', 'fromNumber'])
    : readString(row, ['to_number', 'toNumber']);
}

/** `started_at` as a Date, or null when upstream sent none or sent nonsense. */
function startedAt(row: unknown): Date | null {
  const raw = readString(row, ['started_at', 'startedAt']);
  if (!raw) return null;

  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * A duration that is a whole non-negative number of seconds, or null.
 *
 * Null rather than zero, the rule the call serializer already holds: zero
 * seconds is a call that connected and said nothing, and unknown is a different
 * fact. Rendering the second as the first is a claim.
 */
function durationSecs(row: unknown): number | null {
  const value = readNumber(row, ['duration_seconds', 'durationSeconds']);
  if (value === null || !Number.isFinite(value) || value < 0) return null;

  return Math.round(value);
}

/**
 * Reads one upstream row, or `null` when it carries no call id.
 *
 * A row with no id cannot be stored: the id is the unique key and the whole of
 * the idempotency story, and inventing one would make every re-ingest a
 * duplicate. Skipped and counted rather than stored under a fabricated key.
 */
export function readCallFacts(row: unknown): CallFacts | null {
  const upstreamCallId = readString(row, ['call_id', 'callId', 'id']);
  if (!upstreamCallId) return null;

  return {
    upstreamCallId,
    direction: readString(row, ['direction']),
    status: readString(row, ['status']),
    disposition: readString(row, ['disposition']),
    phone: counterparty(row),
    startedAt: startedAt(row),
    durationSecs: durationSecs(row),
  };
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/**
 * The cursor's primary key. One row, keyed on a constant — this is the state of
 * a platform-wide worker, not a fact about any workspace, so there is nothing
 * else for it to hang off.
 */
export const CURSOR_ID = 'singleton';

export interface SyncOptions {
  /** Upstream pages this pass may read. Defaults to `ANALYTICS_SYNC_MAX_PAGES`. */
  maxPages?: number;
  /** How far below the high-water mark to re-read. Defaults to `ANALYTICS_SYNC_OVERLAP_MINS`. */
  overlapMins?: number;
  /**
   * Rows per upstream page, capped at what upstream serves.
   *
   * A seam, in the same spirit as `flushNotifications()`: a page boundary is
   * where this walk's early exit and its overlap window are decided, and
   * expressing one in a test otherwise costs a hundred-row fixture per page.
   * Nothing in production passes it.
   */
  pageSize?: number;
}

export interface SyncResult {
  /** Rows that did not exist before this pass. */
  created: number;
  /** Rows that existed and were refreshed. */
  updated: number;
  /** Upstream rows carrying no call id, so nothing could key them. */
  skipped: number;
  /**
   * Upstream rows the dialer already owns, as `CallAttempt`.
   *
   * Reported rather than folded into `skipped`: on a busy platform this is
   * most of the listing, and an operator reading "0 created, 1,900 skipped"
   * should be able to tell "nothing new" from "everything was malformed".
   */
  campaignCalls: number;
  /** Upstream rows examined. */
  scanned: number;
  pagesRead: number;
  /** The budget ran out with the question still open — what was read is not all there was. */
  truncated: boolean;
  lastStartedAt: Date | null;
  coverageFrom: Date | null;
}

/**
 * The pass currently running, if any.
 *
 * Two concurrent walks would double the upstream cost to produce identical
 * rows, against a rate limit every workspace on the platform shares — so a
 * second caller joins the first rather than starting its own. The interval and
 * the manual refresh route are both callers, and they overlap by design.
 */
let inFlight: Promise<SyncResult> | null = null;

/**
 * One incremental pass over the platform's call listing.
 *
 * Returns the pass already in flight when there is one, so this is safe to call
 * from a timer and a request handler at the same time.
 */
export function runAnalyticsSync(options: SyncOptions = {}): Promise<SyncResult> {
  if (inFlight) return inFlight;

  inFlight = walk(options).finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/** Test seam: forget any in-flight pass. Never called in production. */
export function resetAnalyticsSyncState(): void {
  inFlight = null;
}

/** `started_at` as a timestamp, or null when upstream sent none. */
function startedAtMs(row: unknown): number | null {
  const at = readCallFacts(row)?.startedAt ?? null;
  return at === null ? null : at.getTime();
}

async function walk(options: SyncOptions): Promise<SyncResult> {
  const maxPages = options.maxPages ?? env.analyticsSyncMaxPages;
  const overlapMs = (options.overlapMins ?? env.analyticsSyncOverlapMins) * 60_000;
  const pageSize = Math.min(options.pageSize ?? UPSTREAM_PAGE_SIZE, UPSTREAM_PAGE_SIZE);

  const cursor = await prisma.analyticsCursor.findUnique({ where: { id: CURSOR_ID } });

  /**
   * The instant this pass may stop at.
   *
   * The high-water mark less the overlap window. The overlap is not paranoia:
   * upstream offsets are computed against a list that grows while it is being
   * walked, so a call placed mid-pass shifts every row down one and a page
   * boundary read after the shift skips the row that crossed it. Re-reading a
   * few minutes of already-ingested calls costs one page and closes that
   * window, and the unique key on `upstreamCallId` makes the re-read free of
   * consequence.
   */
  const floor = cursor?.lastStartedAt ? cursor.lastStartedAt.getTime() - overlapMs : null;

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let campaignCalls = 0;
  let scanned = 0;
  let pagesRead = 0;
  let exhausted = false;
  let reachedMark = false;

  let newest = cursor?.lastStartedAt ?? null;
  let oldest = cursor?.coverageFrom ?? null;

  /**
   * The listing's newest-first ordering is documented behaviour, not a promise
   * it makes never to change — and the cost of assuming it is silent rather
   * than loud: page one would fall below the mark, the walk would stop on it,
   * and every call placed after the first pass would be missed with nothing to
   * say so. So the order is checked against the rows in hand and the early exit
   * is taken only while it holds.
   *
   * Positive evidence, not the absence of a counterexample: a page whose rows
   * all carry the same instant is equally consistent with either order, and
   * under an oldest-first listing that page is exactly the one that would
   * trigger the exit. The exit therefore waits until some pair has actually
   * been seen to descend, and is abandoned for good the moment one ascends.
   */
  let sawDescent = false;
  let sawAscent = false;
  let previousStart = Infinity;

  while (pagesRead < maxPages) {
    // An upstream failure ends the pass and propagates. Swallowing it would let
    // the cursor advance past calls this pass never read, and nothing would
    // ever read them again — a permanent hole in the fact table, invisible.
    const batch = await listCalls({ limit: pageSize, offset: pagesRead * pageSize });
    pagesRead += 1;

    const rows = Array.isArray(batch.calls) ? batch.calls : [];
    scanned += rows.length;

    // The oldest dated row on this page. Under a descending listing everything
    // after it is older still, which is what makes it the exit test.
    let pageOldestStart: number | null = null;

    for (const row of rows) {
      const at = startedAtMs(row);
      // Undated rows say nothing about ordering and are skipped rather than
      // counted against it — one of them must not disable the optimisation.
      if (at === null) continue;

      /**
       * The mark moves over every row the pass **scanned**, not over the rows
       * it stored.
       *
       * These are not the same set, and on this platform they are barely
       * related: campaign calls are the traffic, and every one of them is
       * dropped before a row is written. Advancing the mark from what was
       * stored means a pass that reads two thousand campaign calls advances it
       * by nothing — so the next pass re-reads the same two thousand, forever,
       * spending the whole page budget against a rate limit the entire platform
       * shares to ingest nothing. Worse, the walk always restarts at offset 0:
       * an inbound call that sinks below the budget depth between two passes is
       * then never read by any pass, and nothing rewinds to find it.
       *
       * The mark answers "how far has the walk looked", which is a question
       * about the listing. `coverageFrom` below answers "how far back does the
       * table reach", which is a question about the rows — so that one is still
       * computed from what was written.
       */
      if (at <= Date.now() + CLOCK_SKEW_MS && (!newest || at > newest.getTime())) {
        newest = new Date(at);
      }

      if (previousStart !== Infinity) {
        if (at > previousStart) sawAscent = true;
        else if (at < previousStart) sawDescent = true;
      }

      previousStart = at;
      pageOldestStart = at;
    }

    const page = await ingestPage(rows);
    created += page.created;
    updated += page.updated;
    skipped += page.skipped;
    campaignCalls += page.campaignCalls;

    if (page.oldest && (!oldest || page.oldest < oldest)) oldest = page.oldest;

    if (rows.length < pageSize) {
      exhausted = true;
      break;
    }

    // Everything from here down is at or below the mark, so the pass has caught
    // up. Guarded on the order actually observed; if it has broken, the walk
    // continues and spends its budget, and a pass cut short by that is reported
    // truncated rather than complete.
    if (
      floor !== null &&
      sawDescent &&
      !sawAscent &&
      pageOldestStart !== null &&
      pageOldestStart <= floor
    ) {
      reachedMark = true;
      break;
    }
  }

  /**
   * Only when the budget ran out with the question still open.
   *
   * A pass that reached the end of history or caught up to its own mark
   * answered completely. Recording this is what lets the dashboard avoid
   * presenting a partial table as a whole one.
   */
  const truncated = !exhausted && !reachedMark && pagesRead >= maxPages;

  const state = {
    lastStartedAt: newest,
    coverageFrom: oldest,
    lastRunAt: new Date(),
    lastRunCount: created + updated,
    lastRunTruncated: truncated,
  };

  await prisma.analyticsCursor.upsert({
    where: { id: CURSOR_ID },
    create: { id: CURSOR_ID, ...state },
    update: state,
  });

  return {
    created,
    updated,
    skipped,
    campaignCalls,
    scanned,
    pagesRead,
    truncated,
    lastStartedAt: newest,
    coverageFrom: oldest,
  };
}

interface PageResult {
  created: number;
  updated: number;
  skipped: number;
  campaignCalls: number;
  /**
   * The oldest `startedAt` this page **wrote**.
   *
   * Deliberately computed from stored rows while the high-water mark is
   * computed from scanned ones: this feeds `coverageFrom`, which states how far
   * back the fact table reaches, and a campaign call the walk skipped is not in
   * the table to be reached.
   */
  oldest: Date | null;
}

/**
 * Writes one page of upstream rows.
 *
 * The pre-read of existing rows is what implements the attribution rule, and it
 * is here rather than in a database trigger so the rule is visible in the
 * service that holds it:
 *
 * | Stored      | Resolved now | Written                                |
 * |-------------|--------------|----------------------------------------|
 * | `NULL`      | a workspace  | **yes** — a quarantined row is repaired |
 * | `NULL`      | `NULL`       | no change                              |
 * | workspace A | workspace A  | no change                              |
 * | workspace A | workspace B  | **no** — kept as A                     |
 *
 * The first line is what makes quarantine safe rather than lossy: an agent
 * assigned to a workspace after its calls were ingested brings its history with
 * it on the next pass.
 *
 * The last is the one that matters. Staff reassignment is an UPDATE no
 * constraint can see, so without this rule the day an agent moves from A to B
 * is the day a late re-ingest of A's old calls silently moves them onto B's
 * charts. Attribution records who placed a call, which is a fact about the
 * past: it is written once and it does not move.
 *
 * The descriptive columns are different and are refreshed every pass — a call
 * first seen while it was ringing has to become a completed call with a
 * duration, or the table reports every call as whatever state it was caught in.
 */
async function ingestPage(rows: unknown[]): Promise<PageResult> {
  const empty: PageResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    campaignCalls: 0,
    oldest: null,
  };
  if (rows.length === 0) return empty;

  const usable: Array<{ facts: CallFacts; row: unknown }> = [];
  let skipped = 0;

  for (const row of rows) {
    const facts = readCallFacts(row);
    if (!facts) {
      skipped += 1;
      continue;
    }
    usable.push({ facts, row });
  }

  if (usable.length === 0) return { ...empty, skipped };

  const resolved = await resolveAttribution(usable.map(({ row }) => row));

  /**
   * Everything the dialer does not already own.
   *
   * Dropped here rather than filtered at the query, because the attribution is
   * what identifies them and it costs a database round trip either way.
   */
  const mine: Array<{ facts: CallFacts; attribution: CallAttribution }> = [];
  let campaignCalls = 0;

  for (const [index, { facts }] of usable.entries()) {
    const attribution = resolved[index];
    if (attribution.campaignCall) {
      campaignCalls += 1;
      continue;
    }
    mine.push({ facts, attribution });
  }

  if (mine.length === 0) return { ...empty, skipped, campaignCalls };

  const ids = mine.map(({ facts }) => facts.upstreamCallId);

  const existing = await prisma.callRecord.findMany({
    where: { upstreamCallId: { in: ids } },
    select: { upstreamCallId: true, workspaceId: true },
  });

  const known = new Set(existing.map((record) => record.upstreamCallId));
  // Rows that already name a workspace. Their attribution is settled.
  const settled = new Set(
    existing.filter((record) => record.workspaceId !== null).map((r) => r.upstreamCallId),
  );

  await prisma.$transaction(
    mine.map(({ facts, attribution }) => {
      const { upstreamCallId, ...descriptive } = facts;
      // `campaignCall` is a routing decision, not a column.
      const stored = { workspaceId: attribution.workspaceId, agentId: attribution.agentId };

      return prisma.callRecord.upsert({
        where: { upstreamCallId },
        create: { upstreamCallId, ...descriptive, ...stored },
        update: settled.has(upstreamCallId) ? descriptive : { ...descriptive, ...stored },
      });
    }),
  );

  let oldest: Date | null = null;

  for (const { facts } of mine) {
    if (!facts.startedAt) continue;
    if (!oldest || facts.startedAt < oldest) oldest = facts.startedAt;
  }

  const created = mine.filter(({ facts }) => !known.has(facts.upstreamCallId)).length;

  return { created, updated: mine.length - created, skipped, campaignCalls, oldest };
}
