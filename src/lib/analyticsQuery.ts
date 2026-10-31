import { ApiError } from './errors.js';

/**
 * The date range every analytics route is asked for.
 *
 * The rules are the ones `src/lib/callQuery.ts` already holds — a bare date is
 * a whole UTC day, a timestamp needs an explicit zone, `from > to` is refused —
 * and this is a separate file rather than a shared parser because the two
 * describe different contracts. That one carries `page`, `limit`, `status`,
 * `disposition` and a filtered-stream offset; this one carries a resolved range
 * and nothing else. One parser covering both would have to answer for fields
 * neither caller sends, and would eventually hand each the other's defaults.
 */

/** The window a caller who names none is answered over. */
export const DEFAULT_RANGE_DAYS = 30;

/**
 * The widest window any analytics route will answer over.
 *
 * A cap is needed because the series is **dense**: a day with no calls is a
 * zero emitted from the range rather than from the rows, so the response grows
 * with the span the caller asked for and not with the data behind it. `from`
 * accepts any four-digit year, which is a request for roughly three million
 * day objects — measured at ~480MB resident before serialisation, on routes
 * open to any member and carrying no rate limit. That is one well-formed GET
 * away from taking the process down for every tenant on it.
 *
 * A year and a day, so the natural "last 12 months" is inside it and a leap
 * year does not land on the boundary. It is also about the widest span a daily
 * bucket describes usefully — past that the honest answer is a coarser bucket,
 * not a longer chart.
 */
export const MAX_RANGE_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` with no time part, which the two bounds interpret differently. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A timestamp, and only with an explicit zone.
 *
 * `new Date()` accepts far more than ISO 8601 and resolves the remainder
 * against the *server's* clock: `2026-08-01T00:00` — precisely what
 * `<input type="datetime-local">` emits — is a different instant on a machine
 * set to UTC than on one set to IST. A range whose meaning depends on where
 * this service is deployed is worse than one that refuses, because nothing
 * about the resulting chart says it was read differently than intended.
 */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export interface AnalyticsRange {
  from: Date;
  to: Date;
}

function invalid(message: string): ApiError {
  return new ApiError(400, 'VALIDATION_ERROR', message);
}

/**
 * A single string, or nothing.
 *
 * Express turns `?from=a&from=b` into an array. Taking the first would answer a
 * question the caller did not ask, and taking the last is no better — a request
 * naming two start dates has no correct answer.
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
 * One end of the range.
 *
 * A date with no time is a whole day, and which whole day depends on which end
 * it is: `from=2026-08-01&to=2026-08-01` must mean that day, not an empty
 * instant. Getting this wrong reports a day with calls in it as a day with
 * none, which reads as a fact about the workspace rather than a bug.
 *
 * A bare date is a **UTC** day — a real choice and not a neutral one, since for
 * a reader in IST it starts five and a half hours into their previous day. A
 * caller who means a local day sends the two instants that bound it; the
 * dashboard does exactly that, and the bare form stays for links people write
 * by hand.
 */
/**
 * One end of a date-bounded query parameter, for a caller outside this file.
 *
 * Exported so the lead surface's second date dimension — the lead-created
 * window — reads a bare date exactly as the range beside it does, rather than
 * carrying its own parser. It had one, with a single branch for both ends, so
 * `leadCreatedUntil=2026-09-21` meant `<= 2026-09-21T00:00:00Z` and excluded
 * every lead created that day; the dashboard's `<input type="date">` can emit
 * nothing but a bare date, so that was the only reachable reading. Two parsers
 * for one rule is how the two ends of one filter bar come to disagree.
 */
export function parseBoundaryDate(name: string, raw: unknown, endOfDay: boolean): Date | null {
  return bound(name, raw, endOfDay);
}

function bound(name: string, raw: unknown, endOfDay: boolean): Date | null {
  const value = single(name, raw);
  if (value === null) return null;

  if (!DATE_ONLY.test(value) && !TIMESTAMP.test(value)) {
    throw invalid(`${name} must be a date (YYYY-MM-DD) or an ISO 8601 timestamp with a timezone.`);
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
 * Both bounds, always resolved.
 *
 * Never null, so no aggregate downstream has to branch on an open range — an
 * unbounded scan is not something a caller should be able to ask for by
 * omitting a parameter.
 *
 * Each end defaults independently and relative to the *other* end, not to now:
 * a `to` with no `from` means the thirty days before it, which is what somebody
 * looking at last month expects, rather than the thirty days before today,
 * which would return a window that does not contain the date they named.
 *
 * The resolved bounds are echoed in every payload. A page rendering "1,204
 * calls" over a window the reader did not choose and cannot see is a number
 * with no question attached to it.
 */
export function parseAnalyticsRange(query: Record<string, unknown>): AnalyticsRange {
  const from = bound('from', query.from, false);
  const to = bound('to', query.to, true);

  if (from && to && from.getTime() > to.getTime()) {
    throw invalid('from must not be later than to.');
  }

  const resolvedTo = to ?? new Date();
  const resolvedFrom = from ?? new Date(resolvedTo.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);

  // Checked on the resolved pair rather than on what was sent, so a caller
  // cannot reach a span this refuses by naming only one end and letting the
  // other default.
  if (resolvedTo.getTime() - resolvedFrom.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    throw invalid(`The range must not be longer than ${MAX_RANGE_DAYS} days.`);
  }

  return { from: resolvedFrom, to: resolvedTo };
}
