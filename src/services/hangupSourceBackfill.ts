import { listCalls } from '../adapter/vocobase.js';
import { prisma } from '../lib/prisma.js';
import { readString } from '../lib/upstream.js';

/**
 * Filling `CallAttempt.hangupSource` for dials that settled before the column
 * existed — and, through `backfillFromListing`, any other column the listing
 * carries a value for. `endCallReason` is filled by the same walk from
 * `src/services/endCallReasonBackfill.ts`; only the key, the column and the
 * normaliser differ, so the walk is generalised rather than copied.
 *
 * The forward half of this fact is read from the completion webhook and from
 * the reaper's reconcile. This is the other half: every attempt already on the
 * table when the column landed carries null, and those are exactly the
 * campaigns an operator wants to export today.
 *
 * **It reads the LISTING, not one call at a time.** `GET /calls` carries
 * `hangup_cause`, `hangup_source`, `disposition`, `answered_by`, the durations
 * and the timestamps — the call-history design records this, and the
 * call-detail serializer has read the field off exactly this payload since that
 * slice shipped. So the whole backfill costs one request per hundred calls
 * rather than one per call, which is the difference between a walk somebody can
 * run against a shared rate limit and one they cannot.
 *
 * The pool is **partner-wide**, so most of what this reads belongs to other
 * integrators. Matching is on `upstreamCallId`, which is unique on our side, so
 * a call that is not ours simply matches nothing — no heuristic, and nothing of
 * theirs is stored or logged.
 *
 * Safe to re-run, and that is a property rather than a hope: it fills
 * **absences only**. The webhook is the fresher source and writes the same
 * column at settle time, so overwriting would churn every row on each pass and
 * could put a stale listing value over a live one.
 */

/** Upstream caps a page at 100, so asking for fewer only costs more requests. */
export const BACKFILL_PAGE_SIZE = 100;

/** Pages one run will read before giving up and saying so. */
export const BACKFILL_MAX_PAGES = 200;

export interface BackfillOptions {
  pageSize?: number;
  maxPages?: number;
  /**
   * Where in the listing to begin. A run that stopped at its page budget
   * reports the offset it reached, and the next run starts there rather than
   * re-reading everything in front of it — which is what makes the oldest
   * calls reachable at all on a listing longer than one budget.
   */
  startOffset?: number;
  /**
   * How many attempts still lack the value, re-read every ten pages. When it
   * reaches zero the walk stops: every page after that spends the shared rate
   * limit to fill nothing. Defaults to a count over `CallAttempt`.
   */
  outstanding?: () => Promise<number>;
  /** Called after each page, so a long run says something while it runs. */
  onPage?: (progress: { pages: number; scanned: number; filled: number }) => void;
}

export interface BackfillResult {
  /** Upstream rows read, ours and everybody else's. */
  scanned: number;
  /** Attempt rows this run gave a value to. */
  filled: number;
  pages: number;
  /** The budget ran out before the listing did. */
  truncated: boolean;
  /** Nothing was left to fill, so the walk stopped before the listing ended. */
  complete: boolean;
  /** The listing offset the next page would have started at. */
  nextOffset: number;
}

/** One `(listing key → CallAttempt column)` pair the walk can fill. */
export interface ListingColumn {
  /** Keys the listing row may spell the value under, first match wins. */
  upstreamKeys: string[];
  /** The `CallAttempt` column to fill. */
  column: 'hangupSource' | 'endCallReason';
  /** Applied before the write; returning null skips the row. */
  normalise?: (raw: string) => string | null;
}

/** `hangupSource` is stored as the listing spells it: the export reads it as
 *  free text and the webhook writes it the same way. */
const HANGUP_SOURCE: ListingColumn = {
  upstreamKeys: ['hangup_source', 'hangupSource'],
  column: 'hangupSource',
};

export function backfillHangupSource(options: BackfillOptions = {}): Promise<BackfillResult> {
  return backfillFromListing(HANGUP_SOURCE, options);
}

export async function backfillFromListing(
  col: ListingColumn,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const pageSize = Math.max(1, options.pageSize ?? BACKFILL_PAGE_SIZE);
  const maxPages = Math.max(1, options.maxPages ?? BACKFILL_MAX_PAGES);
  const outstanding =
    options.outstanding ??
    (() => prisma.callAttempt.count({ where: { [col.column]: null, upstreamCallId: { not: null } } }));

  let scanned = 0;
  let filled = 0;
  let pages = 0;
  let offset = Math.max(0, options.startOffset ?? 0);

  for (; pages < maxPages; offset += pageSize) {
    // No try/catch. A failure propagates: swallowing it would report a
    // complete backfill over a walk that stopped early, and the operator would
    // have no reason to run it again.
    const response = await listCalls({ limit: pageSize, offset });
    const calls = response.calls ?? [];

    pages += 1;
    scanned += calls.length;

    // Only the rows that carry a value are worth a write, so the pairs are
    // collected first and an empty page costs no query at all.
    const sourced = new Map<string, string>();

    for (const call of calls) {
      const callId = readString(call, ['call_id', 'callId']);
      const raw = readString(call, col.upstreamKeys);

      // An absent value stays absent. Writing an empty string would turn "the
      // platform did not say" into an attribution nobody made — the same
      // distinction the column's own comment draws. The normaliser may say the
      // same of a blank one.
      const value = raw ? (col.normalise ? col.normalise(raw) : raw) : null;

      if (callId && value) sourced.set(callId, value);
    }

    for (const [callId, value] of sourced) {
      // `updateMany` with the null guard in the WHERE, rather than a read
      // followed by a write: the webhook may be writing this very row while
      // the walk is in flight, and a conditional write is what makes the
      // fresher value win without this needing to know it happened.
      const written = await prisma.callAttempt.updateMany({
        where: { upstreamCallId: callId, [col.column]: null },
        data: { [col.column]: value },
      });

      filled += written.count;
    }

    options.onPage?.({ pages, scanned, filled });

    // A short page is the end of the listing. Checked on the page rather than
    // on a total, because upstream's own `total` counts every workspace's
    // calls on the shared account.
    if (calls.length < pageSize) {
      return { scanned, filled, pages, truncated: false, complete: false, nextOffset: offset + calls.length };
    }

    // Nothing left to fill means nothing left to read for. Every ten pages
    // rather than every page: the count is a scan of our own table, and a
    // thousand calls is a reasonable unit of work between two looks.
    if (pages % 10 === 0 && (await outstanding()) === 0) {
      return { scanned, filled, pages, truncated: false, complete: true, nextOffset: offset + pageSize };
    }
  }

  return { scanned, filled, pages, truncated: true, complete: false, nextOffset: offset };
}
