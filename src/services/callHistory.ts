import { getCall, listCalls, type UpstreamRecord } from '../adapter/vocobase.js';
import { parseCorrelationId } from '../lib/callCorrelation.js';
import type { TimelineAttempt } from '../lib/callTimeline.js';
import type { CallQuery } from '../lib/callQuery.js';
import { ApiError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import {
  serializeCallDetail,
  serializeCallSummary,
  type CallParties,
} from '../lib/serialize.js';
import { readString } from '../lib/upstream.js';

/**
 * Workspace-scoped call history, read straight from the voice platform.
 *
 * There is no local mirror. Calls are read often and briefly, never edited,
 * and a mirror would buy latency in exchange for staleness and a backfill
 * nobody has asked for. So every request fetches, filters, and shapes.
 *
 * The awkward part is that the platform holds **one** partner account. Every
 * workspace's calls sit in one undifferentiated pool, exactly as agents do,
 * and the listing cannot be asked to filter by agent, date, or campaign — it
 * accepts paging and nothing else this surface can use. Scoping a workspace to
 * its own calls is therefore a walk: fetch a page, drop what is not ours,
 * repeat.
 *
 * That walk is bounded. See `MAX_UPSTREAM_PAGES`.
 */

/** Upstream caps a page at 100, so asking for fewer only costs more requests. */
export const UPSTREAM_PAGE_SIZE = 100;

/**
 * How many upstream pages one request may read — 2,000 calls.
 *
 * A ceiling rather than a target. A workspace holding two agents out of a
 * platform-wide pool may need a deep walk to fill a page, and without a limit
 * one request could read an account's entire history while a rate limit every
 * workspace shares runs down.
 *
 * When the budget is spent before the page is filled the result says
 * `truncated: true` and the caller is told what was searched. An incomplete
 * list that reads as complete is the one outcome this surface must not
 * produce — the reader would conclude the calls do not exist.
 */
export const MAX_UPSTREAM_PAGES = 20;

export interface CallsPage {
  items: ReturnType<typeof serializeCallSummary>[];
  page: number;
  limit: number;
  /** At least one further match exists after this page. */
  hasMore: boolean;
  /** The walk hit its budget before it could answer completely. */
  truncated: boolean;
  /** Upstream rows examined, so the caller can say what it searched. */
  scanned: number;
}

/**
 * What this workspace is allowed to see, resolved once per request.
 *
 * Both maps are keyed by the identifier that appears on an upstream row, so
 * deciding a call is a `Map.get` rather than a query. A per-row lookup would
 * be up to 2,000 queries for one page.
 */
interface Scope {
  /** Upstream agent id → the local agent it mirrors. */
  agents: Map<string, { id: string; name: string }>;
  /** Local campaign id → the campaign. */
  campaigns: Map<string, { id: string; name: string }>;
}

async function resolveScope(workspaceId: string): Promise<Scope> {
  const [agents, campaigns] = await Promise.all([
    // No NOT_REMOVED here, deliberately. That predicate answers "may this
    // workspace start something with this agent", and a retired agent must not
    // take new work. This asks whether the workspace *placed* a call, and that
    // does not stop being true when the agent is retired — filtering history by
    // a start gate would erase a workspace's past on the day staff retire an
    // agent upstream.
    prisma.agent.findMany({
      where: { workspaceId },
      select: { id: true, name: true, externalId: true },
    }),
    prisma.campaign.findMany({ where: { workspaceId }, select: { id: true, name: true } }),
  ]);

  return {
    agents: new Map(agents.map((a) => [a.externalId, { id: a.id, name: a.name }])),
    campaigns: new Map(campaigns.map((c) => [c.id, { id: c.id, name: c.name }])),
  };
}

/**
 * Who a call belongs to, or `null` when it belongs to neither.
 *
 * Two independent legs, and either is enough. The agent leg covers everything
 * dialled with an agent this workspace holds. The campaign leg covers a call
 * correlated to one of its campaigns even when the agent is not its own — which
 * is what makes an agent reassignment not retroactively hide a campaign's
 * results.
 *
 * A call matching neither is invisible: not forbidden, absent. Answering 403
 * would confirm the call exists, which is the fact isolation withholds.
 */
function partiesOf(
  call: unknown,
  scope: Scope,
  contactCampaigns: Map<string, string>,
): CallParties | null {
  const externalId = readString(call, ['agent_id', 'agentId']);
  // Explicitly, rather than `?? ''`: `Agent.externalId` is non-nullable today,
  // but one blank row would turn every call upstream sent without an agent id
  // into a match for that workspace.
  const agent = externalId ? scope.agents.get(externalId) ?? null : null;

  const correlation = parseCorrelationId(
    readString(call, ['client_reference_id', 'clientReferenceId']),
  );
  // Both halves of the key, or neither. `contactCampaigns` holds only contacts
  // reached through one of this workspace's campaigns, so a contact that is
  // real elsewhere is absent here, and one that is real *here* still has to
  // name the campaign the key claims.
  const campaign =
    correlation && contactCampaigns.get(correlation.campaignContactId) === correlation.campaignId
      ? scope.campaigns.get(correlation.campaignId) ?? null
      : null;

  if (!agent && !campaign) return null;

  return { agent, campaign };
}

/**
 * The campaign each contact named on these rows actually belongs to.
 *
 * The campaign leg cannot rest on the correlation key alone.
 * `client_reference_id` is free text on a partner account every customer
 * shares, and a campaign id is an ordinary identifier every member of a
 * workspace can read — so a single-factor leg would let anyone able to place a
 * call on that account drop their own call into somebody's history, or pull a
 * row out of it, by writing one guessable id into a field nobody validates.
 *
 * Resolved per batch rather than per row: at most one query for a page of a
 * hundred, and none at all for the ordinary case where no row carries our key.
 * The `campaign` relation filter is what scopes it — a contact belonging to
 * another workspace's campaign simply does not come back.
 */
async function resolveCampaignContacts(
  workspaceId: string,
  rows: unknown[],
): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const row of rows) {
    const correlation = parseCorrelationId(
      readString(row, ['client_reference_id', 'clientReferenceId']),
    );
    if (correlation) ids.add(correlation.campaignContactId);
  }

  if (ids.size === 0) return new Map();

  const contacts = await prisma.campaignContact.findMany({
    where: { id: { in: [...ids] }, campaign: { workspaceId } },
    select: { id: true, campaignId: true },
  });

  return new Map(contacts.map((contact) => [contact.id, contact.campaignId]));
}

/** `started_at` as a timestamp, or null when upstream sent none. */
function startedAt(call: unknown): number | null {
  const raw = readString(call, ['started_at', 'startedAt']);
  if (!raw) return null;

  const at = new Date(raw).getTime();
  return Number.isNaN(at) ? null : at;
}

function matchesFilters(call: unknown, query: CallQuery, parties: CallParties): boolean {
  if (query.agentId && parties.agent?.id !== query.agentId) return false;
  if (query.campaignId && parties.campaign?.id !== query.campaignId) return false;

  if (query.status && readString(call, ['status'])?.toLowerCase() !== query.status) return false;
  if (
    query.disposition &&
    readString(call, ['disposition'])?.toLowerCase() !== query.disposition
  ) {
    return false;
  }

  if (query.from || query.to) {
    const at = startedAt(call);
    // A call with no start time cannot be shown to fall inside the range, and
    // a date filter that silently admits undated rows is not a date filter.
    if (at === null) return false;
    if (query.from && at < query.from.getTime()) return false;
    if (query.to && at > query.to.getTime()) return false;
  }

  return true;
}

export async function listWorkspaceCalls(
  workspaceId: string,
  query: CallQuery,
): Promise<CallsPage> {
  const scope = await resolveScope(workspaceId);

  const empty = {
    items: [],
    page: query.page,
    limit: query.limit,
    hasMore: false,
    truncated: false,
    scanned: 0,
  };

  // Nothing to match against means no call can be visible. Walking 2,000 rows
  // to establish that spends a rate limit every workspace shares.
  if (scope.agents.size === 0 && scope.campaigns.size === 0) return empty;

  const collected: ReturnType<typeof serializeCallSummary>[] = [];
  let matched = 0;
  let scanned = 0;
  let pagesRead = 0;
  let exhausted = false;
  let outOfRange = false;

  // The `?from` exit below is the one place upstream's ordering is
  // load-bearing, and newest-first is its documented behaviour rather than
  // something it promises not to change. The cost of being wrong is not a slow
  // query but a silent one: page one would fall entirely below the bound, the
  // walk would stop on it, and the answer would be an empty list marked
  // complete. So the order is checked against the rows in hand rather than
  // assumed, and the exit is taken only while it holds.
  // Positive evidence, not the absence of a counterexample: a first page whose
  // rows all carry the same instant is equally consistent with either order,
  // and under an oldest-first listing that page is exactly the one that would
  // trigger the exit. So the exit waits until some pair has actually been seen
  // to descend, and is abandoned for good the moment one ascends.
  let sawDescent = false;
  let sawAscent = false;
  let previousStart = Infinity;

  while (pagesRead < MAX_UPSTREAM_PAGES) {
    // An upstream failure ends the walk and propagates as UPSTREAM_ERROR.
    // Returning the rows gathered so far would be a page that reads as a
    // complete answer, and unlike a budget that ran out there is no honest
    // `truncated` to say otherwise with — we do not know what we did not read.
    const batch = await listCalls({
      limit: UPSTREAM_PAGE_SIZE,
      offset: pagesRead * UPSTREAM_PAGE_SIZE,
    });
    pagesRead += 1;

    const rows = Array.isArray(batch.calls) ? batch.calls : [];
    scanned += rows.length;

    // Undated rows say nothing about ordering and are skipped rather than
    // counted against it — one of them must not disable the optimisation.
    for (const row of rows) {
      const at = startedAt(row);
      if (at === null) continue;
      if (previousStart !== Infinity) {
        if (at > previousStart) sawAscent = true;
        else if (at < previousStart) sawDescent = true;
      }
      previousStart = at;
    }

    const contactCampaigns = await resolveCampaignContacts(workspaceId, rows);

    for (const row of rows) {
      const parties = partiesOf(row, scope, contactCampaigns);
      if (!parties) continue;
      if (!matchesFilters(row, query, parties)) continue;

      matched += 1;
      // Collect one past the page so `hasMore` is a fact rather than a guess —
      // this surface deliberately has no total to compare against.
      if (matched > query.skip && collected.length <= query.take) {
        collected.push(serializeCallSummary(row, parties));
      }
    }

    if (collected.length > query.take) break;

    if (rows.length < UPSTREAM_PAGE_SIZE) {
      exhausted = true;
      break;
    }

    // Once a whole batch falls before the requested start, every row after it
    // does too — which is why a date-bounded query is cheap where an unbounded
    // one is not. Guarded on the order actually observed: if it has broken,
    // the walk continues and spends its budget, and a page cut short by that
    // is reported `truncated` rather than complete.
    if (
      sawDescent &&
      !sawAscent &&
      query.from &&
      rows.every((row) => (startedAt(row) ?? Infinity) < query.from!.getTime())
    ) {
      outOfRange = true;
      break;
    }
  }

  const hasMore = collected.length > query.take;

  return {
    items: collected.slice(0, query.take),
    page: query.page,
    limit: query.limit,
    hasMore,
    // Only when the budget ran out with the question still open. A walk that
    // filled its page, reached the end of history, or ran past the date range
    // answered completely.
    truncated: !hasMore && !exhausted && !outOfRange && pagesRead >= MAX_UPSTREAM_PAGES,
    scanned,
  };
}

/**
 * One call, scoped to the workspace.
 *
 * Visibility is re-derived from the fetched call rather than trusted from the
 * caller — the id is an upstream identifier and nothing proves the caller got
 * it from us.
 *
 * Every failure is the same 404. A call in another workspace, an id that names
 * nothing, and an upstream that refused to say are indistinguishable on
 * purpose: distinguishing them would let a caller sort ids into real and unreal
 * by watching the status code.
 */
export async function getWorkspaceCall(
  workspaceId: string,
  callId: string,
): Promise<ReturnType<typeof serializeCallDetail>> {
  const { call, parties } = await visibleCall(workspaceId, callId, await resolveScope(workspaceId));

  return serializeCallDetail(call, parties, await attemptFor(workspaceId, callId));
}

/**
 * The local attempt this platform recorded when it dialled, if there is one.
 *
 * There is often not one, and that is the ordinary case rather than a defect:
 * an attempt row exists only for a call the dialer placed for a campaign. An
 * inbound call, one placed by hand, or one on an agent whose traffic never came
 * through the dialer has none — and the serializer says so with
 * `timelineSource: 'none'` rather than emitting an empty timeline that reads as
 * a call which did nothing.
 *
 * Scoped on the **workspace as well as the id**, though `upstreamCallId` is
 * already unique. Belt to the visibility check's braces: this is the one query
 * on the detail path that reads a local billing figure, the partner account is
 * shared, and `CallAttempt.workspaceId` is a dial-time snapshot that stays true
 * after an ownership change. It runs only after access has been granted, so it
 * can never widen what a caller sees — an attempt that does not match simply
 * adds nothing.
 */
async function attemptFor(
  workspaceId: string,
  callId: string,
): Promise<TimelineAttempt | null> {
  return prisma.callAttempt.findFirst({
    where: { upstreamCallId: callId, workspaceId },
    select: {
      attemptNo: true,
      status: true,
      upstreamStatus: true,
      disposition: true,
      hangupCause: true,
      endCallReason: true,
      startedAt: true,
      answeredAt: true,
      endedAt: true,
      resolvedAt: true,
      chargedAt: true,
      durationSecs: true,
      billedSecs: true,
      costCredits: true,
      shortfall: true,
    },
  });
}

/**
 * The upstream call, for the recording route, after the same visibility check.
 *
 * Returns the raw record rather than a serialized one because the caller needs
 * the recording URL — the single place that value is read, and it never leaves
 * this process.
 */
export async function findCallForRecording(
  workspaceId: string,
  callId: string,
): Promise<UpstreamRecord> {
  return (await visibleCall(workspaceId, callId, await resolveScope(workspaceId))).call;
}

/**
 * Fetches a call and refuses it unless this workspace may see it.
 *
 * Three routes to the same 404, all indistinguishable: upstream has no such
 * call, the call belongs to another workspace, or the id is nonsense.
 * Separating them would let a caller sort ids into real and unreal by watching
 * the status code.
 *
 * An **outage** is the one thing that is not folded in. `getCall` throws
 * `UPSTREAM_ERROR` when it could not ask, and that propagates: telling a reader
 * their call was not found when the platform was merely unreachable is a claim
 * about their data that we are in no position to make, and they act on it.
 */
async function visibleCall(
  workspaceId: string,
  callId: string,
  scope: Scope,
): Promise<{ call: UpstreamRecord; parties: CallParties }> {
  const call = await getCall(callId);

  const parties = call
    ? partiesOf(call, scope, await resolveCampaignContacts(workspaceId, [call]))
    : null;

  if (!call || !parties) {
    throw new ApiError(404, 'NOT_FOUND', 'Call not found.');
  }

  return { call, parties };
}
