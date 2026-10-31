import { once } from 'node:events';
import { Router } from 'express';
import { parseAnalyticsRange, parseBoundaryDate } from '../lib/analyticsQuery.js';
import { env } from '../lib/env.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { requireMembership, workspaceOf } from '../middleware/workspace.js';
import { campaignAnalytics, workspaceOverview } from '../services/analytics.js';
import { leadActivity, leadOutcome, leadSpend } from '../services/leadAnalytics.js';
import { UnknownTimeZoneError } from '../lib/pgTimeZone.js';
import { campaignBucketReport } from '../services/campaignBucketReport.js';
import { streamWorkspaceCsv } from '../services/analyticsExport.js';
import { CURSOR_ID, runAnalyticsSync } from '../services/analyticsIngest.js';

/**
 * Analytics over the local fact table.
 *
 * Every read here is SQL against `CallRecord`. Nothing on this router calls the
 * voice platform — the one route that causes an upstream read is the refresh,
 * and it is a POST, ADMIN-only, and capped.
 *
 * The three reads are open to **any member**, following call history: nothing
 * in an aggregate over a workspace's own calls is sensitive to a MEMBER that an
 * ADMIN should see instead, and a MEMBER operating campaigns is exactly the
 * person who needs to know whether they are connecting.
 */
export const analyticsRoutes: Router = Router();

/**
 * A per-workspace ceiling on the manual refresh.
 *
 * A refresh is one workspace's page spending the partner account's ingest
 * budget on behalf of the whole platform, so this is the one control that stops
 * a reader holding the button from making that budget their own. Keyed on the
 * workspace rather than the caller, or its admins multiply it between them —
 * the same reasoning the call-history listing limiter carries.
 */
const refreshLimiter = createRateLimiter({
  limit: env.analyticsRefreshRateLimitMax,
  windowMs: 60_000,
  keyOf: (req) => workspaceOf(req).id,
});

/**
 * How far back the fact table goes, and whether the last pass finished.
 *
 * Emitted on the overview so the page can say it. A workspace with calls from
 * March, looking at a table seeded in August, is not a workspace with no calls
 * in March — and a page that renders "no calls in this range" there is stating
 * something false about the reader's own business. `null` means no pass has
 * ever run, which is a third thing again and must not read as "complete".
 *
 * Platform-wide rather than per workspace, because the ingest is: there is one
 * walk over one shared pool, and it is at one place in it.
 */
async function coverage() {
  const cursor = await prisma.analyticsCursor.findUnique({ where: { id: CURSOR_ID } });

  return {
    from: cursor?.coverageFrom ?? null,
    lastRunAt: cursor?.lastRunAt ?? null,
    /** The last pass spent its page budget with the question still open. */
    truncated: cursor?.lastRunTruncated ?? false,
  };
}


/**
 * The overview's optional campaign filter, resolved against the workspace.
 *
 * `undefined` for a request that names none — which is not the same as an empty
 * list, and the difference is the whole reason this returns one or the other
 * rather than an array. `?campaignId=` naming nothing selects nothing, and
 * answering that with the unfiltered workspace would hand a reader who narrowed
 * to zero campaigns every call the workspace has.
 *
 * Every id is checked for membership of this workspace *before* the aggregate
 * runs, and an unresolvable one is a 404 rather than a silent drop: dropping it
 * would answer a request for three campaigns with two, under a filter chip row
 * still showing three, and nothing on the page would say so. The same opaque
 * 404 a foreign id, an unmapped one and nonsense all get.
 */
async function campaignFilter(
  req: Parameters<typeof workspaceOf>[0],
  workspaceId: string,
): Promise<string[] | undefined> {
  const raw = (req as { query: Record<string, unknown> }).query.campaignId;
  if (raw === undefined) return undefined;

  const supplied = (Array.isArray(raw) ? raw : [raw]).map((value) => {
    if (typeof value !== 'string') {
      throw new ApiError(400, 'VALIDATION_ERROR', 'campaignId must be a string.');
    }
    return value.trim();
  });

  // De-duplicated, so a URL that repeats an id does not make the ownership
  // check do the same work twice.
  const ids = [...new Set(supplied.filter((value) => value !== ''))];
  if (ids.length === 0) return [];

  if (ids.length > MAX_CAMPAIGN_FILTER) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      `At most ${MAX_CAMPAIGN_FILTER} campaigns can be filtered at once.`,
    );
  }

  const owned = await prisma.campaign.findMany({
    where: { id: { in: ids }, workspaceId },
    select: { id: true },
  });

  if (owned.length !== ids.length) {
    throw new ApiError(404, 'NOT_FOUND', 'Campaign not found.');
  }

  return ids;
}

/**
 * How many campaigns one request may name.
 *
 * A bound on an `IN` list that arrives from a query string, on a route open to
 * any member. Comfortably above what the multi-select can produce and far below
 * what would make the planner give up on the index.
 */
const MAX_CAMPAIGN_FILTER = 100;


/** The campaign statuses a filter may name. */
const CAMPAIGN_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'STOPPED',
  'CREDIT_EXHAUSTED',
] as const;

/** The lead states a filter may name. */
const LEAD_STATES = [
  'PENDING',
  'QUEUED',
  'CALLING',
  'COMPLETED',
  'FAILED',
  'EXCLUDED',
  'SKIPPED',
] as const;

/**
 * A repeatable enum query parameter.
 *
 * An unknown value is a 400 rather than a silent drop, the rule
 * `campaignFilter` keeps: a request naming three states and answered over
 * two, under a control still showing three, is wrong in a way nothing on the
 * page reveals.
 */
function enumList<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  field: string,
): T[] | undefined {
  if (raw === undefined) return undefined;

  const values = (Array.isArray(raw) ? raw : [raw]).map((value) => {
    if (typeof value !== 'string') {
      throw new ApiError(400, 'VALIDATION_ERROR', `${field} must be a string.`);
    }
    return value.trim().toUpperCase();
  });

  const kept = [...new Set(values.filter((value) => value !== ''))];

  for (const value of kept) {
    if (!(allowed as readonly string[]).includes(value)) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        `${field} must be one of: ${allowed.join(', ')}.`,
      );
    }
  }

  return kept as T[];
}

/**
 * A lead-creation bound, which is a different clock from the range.
 *
 * A bare `YYYY-MM-DD` is a UTC day, matching `parseAnalyticsRange`. An
 * unparseable value is a 400 rather than being ignored — a creation window
 * silently dropped widens the answer under a control that says otherwise.
 */
function createdBound(raw: unknown, field: string, endOfDay: boolean): Date | undefined {
  if (raw === undefined) return undefined;

  // `parseBoundaryDate` rather than a parser of this route's own. It holds the
  // rule the range beside this one already keeps: a bare `YYYY-MM-DD` is a
  // whole UTC day, and which whole day depends on which END it is, so
  // `from=X&to=X` means that day rather than an empty instant. It also refuses
  // a timestamp with no zone, which `new Date()` would have resolved against
  // the SERVER's clock — a window whose meaning depends on where this service
  // is deployed.
  const at = parseBoundaryDate(field, raw, endOfDay);

  if (at === null) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} must be a date.`);
  }

  return at;
}

/** Every filter the lead surface shares, resolved once. */
async function leadFilters(
  req: Parameters<typeof workspaceOf>[0],
  workspaceId: string,
) {
  const query = (req as { query: Record<string, unknown> }).query;
  const from = createdBound(query.leadCreatedFrom, 'leadCreatedFrom', false);
  // End of day: "until 21 September" includes the leads that came in that day.
  const until = createdBound(query.leadCreatedUntil, 'leadCreatedUntil', true);

  if (from && until && from.getTime() > until.getTime()) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'leadCreatedFrom must not be after leadCreatedUntil.',
    );
  }

  return {
    campaigns: await campaignFilter(req, workspaceId),
    campaignStatuses: enumList(query.campaignStatus, CAMPAIGN_STATUSES, 'campaignStatus'),
    leadStates: enumList(query.leadState, LEAD_STATES, 'leadState'),
    leadCreatedFrom: from,
    leadCreatedUntil: until,
  };
}

analyticsRoutes.get(
  '/:workspaceId/analytics/overview',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const workspace = workspaceOf(req);
    const range = parseAnalyticsRange(req.query as Record<string, unknown>);
    const campaignIds = await campaignFilter(req, workspace.id);

    const [overview, cover] = await Promise.all([
      workspaceOverview(workspace.id, range, campaignIds),
      coverage(),
    ]);

    res.json({ success: true, data: { ...overview, coverage: cover } });
  }),
);

/**
 * The workspace's LEADS over a window, as opposed to its calls.
 *
 * A sibling of `/analytics/overview`, not a replacement: that one counts
 * dials and this one counts the people dialled, and the two answer different
 * questions over the same data. See `services/leadAnalytics.ts`.
 *
 * Registered before `/campaigns/:campaignId/analytics` for no routing reason
 * — the paths cannot collide — but beside the overview it belongs with.
 *
 * Any member, like every other read on this router.
 */
analyticsRoutes.get(
  '/:workspaceId/analytics/leads/outcome',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const workspace = workspaceOf(req);
    const range = parseAnalyticsRange(req.query as Record<string, unknown>);
    // The same helper the overview uses: it 404s an id from another
    // workspace rather than dropping it, so the filter cannot be turned into
    // an existence oracle over other tenants' campaign ids.
    // Passed through as-is, `undefined` included: the helper's two absences
    // mean different things and flattening them here would make this route
    // disagree with the overview about one filter control.
    const filters = await leadFilters(req, workspace.id);

    const outcome = await leadOutcome(workspace.id, { range, ...filters });

    res.json({ success: true, data: outcome });
  }),
);

/**
 * How the dialling itself went: connectivity, talk time, caller ids and the
 * weekly pattern.
 *
 * `?tz=` is an IANA zone for the weekly pattern only, defaulting to UTC. The
 * heatmap answers "what hour do people pick up", which a UTC bucket answers
 * wrongly for most of the world — so the caller names the zone and the
 * payload echoes the one actually used.
 */
analyticsRoutes.get(
  '/:workspaceId/analytics/leads/activity',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const workspace = workspaceOf(req);
    const range = parseAnalyticsRange(req.query as Record<string, unknown>);
    const filters = await leadFilters(req, workspace.id);

    const raw = (req.query as Record<string, unknown>).tz;
    if (raw !== undefined && typeof raw !== 'string') {
      throw new ApiError(400, 'VALIDATION_ERROR', 'tz must be a string.');
    }

    try {
      const activity = await leadActivity(workspace.id, {
        range,
        ...filters,
        timeZone: raw,
      });

      res.json({ success: true, data: activity });
    } catch (error) {
      // An unresolvable zone is the caller's input, not an outage. Answered
      // as a 400 naming the field rather than as the 500 an unmapped throw
      // would become — and without echoing the string back into the body.
      if (error instanceof UnknownTimeZoneError) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'tz must be a valid IANA time zone.');
      }
      throw error;
    }
  }),
);

/**
 * What the leads cost, and what each kind of lead cost.
 *
 * Every figure is summed from the ledger rather than from
 * `CallAttempt.costCredits`, which also records what was owed on a shortfall.
 */
analyticsRoutes.get(
  '/:workspaceId/analytics/leads/spend',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const workspace = workspaceOf(req);
    const range = parseAnalyticsRange(req.query as Record<string, unknown>);
    const filters = await leadFilters(req, workspace.id);

    const spend = await leadSpend(workspace.id, { range, ...filters });

    res.json({ success: true, data: spend });
  }),
);

analyticsRoutes.get(
  '/:workspaceId/campaigns/:campaignId/analytics',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const workspace = workspaceOf(req);
    const range = parseAnalyticsRange(req.query as Record<string, unknown>);

    const report = await campaignAnalytics(workspace.id, req.params.campaignId, range);

    if (!report) {
      // The same 404 a nonexistent id gets, with the same body. A campaign in
      // another workspace, an id that names nothing and pure nonsense are
      // indistinguishable on purpose: distinguishing them would let a caller
      // sort ids into real and unreal by watching the response.
      throw new ApiError(404, 'NOT_FOUND', 'Campaign not found.');
    }

    const cover = await coverage();

    res.json({ success: true, data: { ...report, coverage: cover } });
  }),
);

/**
 * Where one campaign's leads landed.
 *
 * **No range parameter, deliberately.** Every other read on this router is
 * range-scoped and this one is not: which bucket a lead is in is a fact about
 * the campaign's whole history, re-derived on every read from what each call
 * extracted. Slicing it by a window would answer "how did the leads we happened
 * to call this month divide" — a different question, and one nobody asks of a
 * campaign whose point is the leads it produced.
 *
 * Any member, like the three reads above: a MEMBER running the campaign is
 * exactly the person who needs to know how its leads sorted.
 */
analyticsRoutes.get(
  '/:workspaceId/campaigns/:campaignId/analytics/buckets',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const workspace = workspaceOf(req);

    const report = await campaignBucketReport(workspace.id, req.params.campaignId);

    if (!report) {
      // The same 404, body and all, that a nonexistent id gets — for the reason
      // the campaign report gives: distinguishing them would let a caller sort
      // ids into real and unreal by watching the response.
      throw new ApiError(404, 'NOT_FOUND', 'Campaign not found.');
    }

    res.json({ success: true, data: report });
  }),
);

/**
 * The workspace's call facts as a CSV download.
 *
 * The range is parsed **before** the first byte of the body. Once the header
 * row has gone out the status line has gone with it and there is no way left to
 * report a failure — a 400 has to happen while a 400 is still possible.
 */
analyticsRoutes.get(
  '/:workspaceId/analytics/export',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const workspace = workspaceOf(req);
    const range = parseAnalyticsRange(req.query as Record<string, unknown>);

    /**
     * An optional campaign filter, resolved against the workspace first.
     *
     * The same `findFirst({ where: { id, workspaceId } })` every campaign
     * surface runs, and the same 404 for a foreign id, an unmapped one and
     * nonsense alike. An unresolved filter must never fall through to "export
     * everything": a reader who asked for one campaign and received the whole
     * workspace would have no way to tell.
     */
    const requested = req.query.campaignId;
    if (requested !== undefined && typeof requested !== 'string') {
      throw new ApiError(400, 'VALIDATION_ERROR', 'campaignId must be given at most once.');
    }

    const campaignId = requested?.trim() ? requested.trim() : null;
    if (campaignId) {
      const campaign = await prisma.campaign.findFirst({
        where: { id: campaignId, workspaceId: workspace.id },
        select: { id: true },
      });
      if (!campaign) throw new ApiError(404, 'NOT_FOUND', 'Campaign not found.');
    }

    const day = (at: Date) => at.toISOString().slice(0, 10);
    // The workspace slug, not its name: a name may hold a quote, a comma or a
    // newline, and this value goes into a header some clients write to disk.
    const filename = `calls-${workspace.slug}-${day(range.from)}-to-${day(range.to)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // One customer's call log, leaving through a URL a shared cache has no way
    // to scope. Nothing about it belongs in one.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200);

    try {
      await streamWorkspaceCsv(
        workspace.id,
        range,
        {
          write: (chunk) => res.write(chunk),
          // Honoured, not ignored: without it a slow client would have the
          // whole export accumulate in this process's socket buffer, and "no
          // row cap" would mean an unbounded allocation rather than a long
          // download.
          //
          // Raced against `close`, because a reader who closes the tab
          // mid-download never drains — awaiting drain alone would leave this
          // walk suspended for the life of the process.
          drain: () => Promise.race([once(res, 'drain'), once(res, 'close')]).then(() => undefined),
          aborted: () => res.destroyed || res.writableEnded,
        },
        { campaignId },
      );
    } catch (error) {
      // The status line went out with the headers, so there is no way left to
      // report this. Destroying the connection is the only signal that the file
      // is short — ending it normally would hand the reader a truncated export
      // that opens perfectly well and is missing rows.
      res.destroy(error instanceof Error ? error : undefined);
      throw error;
    }

    res.end();
  }),
);

/**
 * Runs an ingest pass now.
 *
 * **ADMIN**, unlike everything else here, because this is not a read. It spends
 * the partner account's rate limit on behalf of every workspace on the
 * platform, from one workspace's page — so it is gated and capped, in the same
 * way and for the same reason a campaign write is.
 *
 * A pass already in flight is joined rather than queued: two concurrent walks
 * double the upstream cost to produce identical rows.
 *
 * It is deliberately **not** gated on `ANALYTICS_SYNC_ENABLED`. That flag says
 * whether the timer runs; an operator pressing this has asked for a pass, and
 * refusing them because the timer is off would leave a workspace with no way to
 * fill its own charts.
 */
analyticsRoutes.post(
  '/:workspaceId/analytics/refresh',
  requireAuth,
  // After membership: the limiter keys on the resolved workspace, and an
  // unauthenticated caller must not be able to spend a workspace's budget.
  requireMembership('ADMIN'),
  refreshLimiter,
  asyncHandler(async (_req, res) => {
    const result = await runAnalyticsSync();

    // What the pass did, not just that it happened. A refresh reporting only
    // "done" teaches the reader nothing about why the chart did not change.
    res.json({ success: true, data: result });
  }),
);
