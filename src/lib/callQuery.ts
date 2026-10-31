import { ApiError } from './errors.js';

/**
 * Query parsing for the call-history listing.
 *
 * Local to this surface rather than shared. Its page envelope is not the one
 * the staff listings answer with — there is no `total` here, deliberately, and
 * there is a `truncated` flag instead — so a single shared parser would have to
 * describe two different contracts and would quietly hand each the other's.
 */

const DEFAULT_LIMIT = 25;

/** One page must not be able to ask for the whole platform. */
const MAX_LIMIT = 100;

/** `YYYY-MM-DD` with no time part, which the two bounds interpret differently. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A timestamp, and only with an explicit zone.
 *
 * `new Date()` accepts a great deal more than ISO 8601 and resolves the
 * remainder against the *server's* clock: `2026-08-01T00:00` — precisely what
 * `<input type="datetime-local">` emits — means a different instant on a
 * machine set to UTC than on one set to IST. A filter whose meaning depends on
 * where it is deployed is worse than one that refuses, because nothing about
 * the answer says it was interpreted differently than intended.
 */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export interface CallQuery {
  page: number;
  limit: number;
  /** Matches to discard before collecting — an offset into the FILTERED stream. */
  skip: number;
  /** Matches to collect. */
  take: number;
  from: Date | null;
  to: Date | null;
  /** Case-folded for comparison. Free text: see `text()`. */
  status: string | null;
  disposition: string | null;
  agentId: string | null;
  campaignId: string | null;
}

function invalid(message: string): ApiError {
  return new ApiError(400, 'VALIDATION_ERROR', message);
}

/**
 * A single string, or nothing.
 *
 * Express turns `?agentId=a&agentId=b` into an array. Silently taking the
 * first would answer a question the caller did not ask, and taking the last is
 * no better — a request that names two agents has no correct answer.
 */
function single(name: string, raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;

  if (typeof raw !== 'string') {
    throw invalid(`${name} must be given at most once.`);
  }

  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * A whole number ≥ 1, or the fallback when absent.
 *
 * Bad input throws rather than falling back. Ignoring `?page=x` would answer
 * page 1's rows under page x's heading, and a listing that quietly shows the
 * wrong rows is worse than one that refuses.
 */
function positive(name: string, raw: unknown, fallback: number): number {
  const value = single(name, raw);
  if (value === null) return fallback;

  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw invalid(`${name} must be a whole number of at least 1.`);
  }

  return Number(value);
}

/**
 * One end of the range.
 *
 * A date with no time is a whole day, and which whole day depends on which end
 * it is: `from=2026-08-01&to=2026-08-01` must mean that day, not an empty
 * instant. Getting this wrong reports a day with calls in it as a day with
 * none, which reads as a fact about the workspace rather than a bug.
 *
 * A bare date is a **UTC** day. That is a real choice and not a neutral one —
 * for a reader in IST it starts five and a half hours into their previous day
 * — so a caller who means a local day sends the two instants that bound it
 * and does not rely on this. The dashboard does exactly that; the bare form
 * stays for links people write by hand.
 */
function bound(name: string, raw: unknown, endOfDay: boolean): Date | null {
  const value = single(name, raw);
  if (value === null) return null;

  if (!DATE_ONLY.test(value) && !TIMESTAMP.test(value)) {
    throw invalid(
      `${name} must be a date (YYYY-MM-DD) or an ISO 8601 timestamp with a timezone.`,
    );
  }

  const iso = DATE_ONLY.test(value)
    ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
    : value;

  // The shape can be right and the date still not exist — `2026-13-45` passes
  // the pattern and is not a day.
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    throw invalid(`${name} must be an ISO 8601 date or timestamp.`);
  }

  return at;
}

/**
 * A free-text filter, case-folded.
 *
 * Deliberately unvalidated. `status` and `disposition` follow whichever carrier
 * placed the call, and the published sets grow without this service deploying
 * anything. Gating on an enum copied from today's documentation would turn next
 * month's carrier disposition into a 400 — the filter would break rather than
 * return nothing, which is the wrong failure and the harder one to diagnose.
 */
function text(name: string, raw: unknown): string | null {
  return single(name, raw)?.toLowerCase() ?? null;
}

export function parseCallQuery(query: Record<string, unknown>): CallQuery {
  const page = positive('page', query.page, 1);
  // Clamped rather than rejected: asking for more than the cap is a reasonable
  // thing to want, and the cap is ours to enforce, not theirs to get right.
  const limit = Math.min(positive('limit', query.limit, DEFAULT_LIMIT), MAX_LIMIT);

  const from = bound('from', query.from, false);
  const to = bound('to', query.to, true);

  if (from && to && from.getTime() > to.getTime()) {
    throw invalid('from must not be later than to.');
  }

  return {
    page,
    limit,
    skip: (page - 1) * limit,
    take: limit,
    from,
    to,
    status: text('status', query.status),
    disposition: text('disposition', query.disposition),
    agentId: single('agentId', query.agentId),
    campaignId: single('campaignId', query.campaignId),
  };
}
