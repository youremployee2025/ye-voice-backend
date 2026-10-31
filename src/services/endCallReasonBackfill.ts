import { normaliseEndCallReason } from '../lib/endCallReason.js';
import {
  backfillFromListing,
  type BackfillOptions,
  type BackfillResult,
  type ListingColumn,
} from './hangupSourceBackfill.js';

/**
 * Filling `CallAttempt.endCallReason` for dials that settled before the
 * webhooks and the reaper wrote it (2026-09-15). The platform derives
 * `end_call_reason` on read, so every historical listing row carries one and
 * the same listing walk that filled `hangupSource` fills this.
 *
 * Normalised the way every other writer normalises it — upper-cased and
 * trimmed — so a listing-filled row reads the same as a webhook-filled one,
 * and a blank reason is no reason rather than an empty string.
 *
 * Two values are never written by the WALK, only by a live settle:
 *
 * - `SYSTEM_ERROR` decides a budget. Every never-placed reader — the claim's
 *   caps, the over-budget sweep, re-extraction, the ladder — excludes a row
 *   carrying it, and the settle of a historical row already spent (or did
 *   not spend) the retry under the rule of its day. Writing it now would
 *   re-decide that retroactively: re-arm contacts past their cap and print
 *   "not counted against this contact's retries" on dials that were.
 * - `UNKNOWN` is what the platform derives, in authoritative mode, for every
 *   connected call whose session predates its stored bot report (platform
 *   migration 2026-09-14) — which is every historical YE conversation. It
 *   says nothing the row does not already say, and a value on the column
 *   would shadow the cause on the timeline for all of history.
 *
 * Both stay null, which every reader treats as "not carried" and falls
 * through from. The webhooks and the reaper still write them on live calls.
 */
const NOT_FROM_THE_LISTING: ReadonlySet<string> = new Set(['SYSTEM_ERROR', 'UNKNOWN']);

export function normaliseListedEndCallReason(raw: string): string | null {
  const reason = normaliseEndCallReason(raw);
  return reason !== null && NOT_FROM_THE_LISTING.has(reason) ? null : reason;
}

const END_CALL_REASON: ListingColumn = {
  upstreamKeys: ['end_call_reason', 'endCallReason'],
  column: 'endCallReason',
  normalise: normaliseListedEndCallReason,
};

export function backfillEndCallReason(options: BackfillOptions = {}): Promise<BackfillResult> {
  return backfillFromListing(END_CALL_REASON, options);
}
