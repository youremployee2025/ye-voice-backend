import { prisma } from './prisma.js';

/**
 * Resolve a caller's IANA time zone to one **this database** will accept.
 *
 * ## Why this is not `Intl`
 *
 * It looks like `Intl` should answer it, and `Intl` is wrong here in a way
 * that is invisible until a real browser asks. Chrome in India reports
 * `Asia/Calcutta` — the legacy alias — and:
 *
 * - `Intl` **accepts** `Asia/Calcutta`, so a validator built on it passes,
 *   and the statement then throws `time zone "Asia/Calcutta" not
 *   recognized`: a 500 on every Activity load for YE's largest market.
 * - Canonicalising through `Intl` makes it worse, not better. `Intl`
 *   resolves the pair the OTHER way — `Asia/Kolkata` → `Asia/Calcutta` —
 *   while this Postgres carries `Asia/Kolkata` and not the alias. The two
 *   libraries disagree about which spelling is primary, so neither can
 *   translate for the other on its own.
 *
 * So the database's own catalogue is the authority for *what exists*, and
 * `Intl` is used only for *what is equivalent to what* — comparing both
 * sides' canonical form, which is a question `Intl` can answer consistently
 * even when its answer is the name Postgres lacks.
 *
 * The same shape covers `US/Eastern` → `America/New_York` and
 * `Europe/Kiev` → `Europe/Kyiv` without a hand-written alias table, which
 * would go stale every time the tz database renames a city.
 *
 * ## Cost
 *
 * `pg_timezone_names` is a static catalogue of a few hundred rows, read
 * once per process and cached. The `Intl` pass over it is done once too.
 * A cold call is one query; every later call is a `Map` lookup.
 */

/**
 * A zone this database will not accept.
 *
 * A class rather than a message the route matches on. The route's `try` wraps
 * the WHOLE of `leadActivity` — the grouped contact reads, three raw
 * aggregates and the ledger — so the predicate separating a 400 from a 500
 * across all of it was `message.startsWith('Unknown time zone')`. Rewording
 * the string, or wrapping it, silently turns every bad-`tz` request into a
 * 500, and no test would fail.
 */
export class UnknownTimeZoneError extends Error {
  constructor(requested: string) {
    // The requested string is on the error for the log, and never on the
    // response: a 400 that echoes the caller's input reflects it.
    super(`Unknown time zone: ${requested}`);
    this.name = 'UnknownTimeZoneError';
  }
}

/** requested-name (lower-cased) → the name Postgres knows. */
let zones: Map<string, string> | null = null;
let loading: Promise<Map<string, string>> | null = null;

/** `Intl`'s own idea of a zone's primary name, or null if it rejects it. */
function canonical(zone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

async function build(): Promise<Map<string, string>> {
  const rows = await prisma.$queryRaw<{ name: string }[]>`
    SELECT name FROM pg_timezone_names
  `;

  const map = new Map<string, string>();

  for (const { name } of rows) {
    // The name itself, so an exact request never depends on the `Intl` pass.
    map.set(name.toLowerCase(), name);
  }

  for (const { name } of rows) {
    const key = canonical(name)?.toLowerCase();
    // An overwrite guard, not a plain `set`: several Postgres names can share
    // one canonical form, and any of them is a correct answer — they name the
    // same zone, so the first wins and the rest are skipped. The guard is what
    // protects the exact-name entries written above, since a request naming a
    // real Postgres zone must resolve to ITSELF rather than to a synonym.
    if (key && !map.has(key)) map.set(key, name);
  }

  return map;
}

/**
 * The Postgres spelling of `requested`, or **null** when no zone matches.
 *
 * Null is a refusal, never a fallback to UTC: a heatmap bucketed in UTC and
 * labelled with the zone the caller asked for is wrong in the one way
 * nothing on the page could reveal.
 */
export async function resolvePgTimeZone(requested: string): Promise<string | null> {
  // One in-flight build shared by concurrent callers, so a cold start under
  // load does not run the query once per request — and the slot is CLEARED on
  // failure rather than left holding the rejected promise.
  //
  // `zones ??= await (loading ??= build())` reads as a cache and is a latch: a
  // rejected build leaves `zones` null and `loading` holding the rejection, so
  // every later call re-awaits the same rejected promise and re-throws the
  // same error. One connection blip at cold start therefore 500d
  // `/leads/activity` for the life of the process, with no recovery short of a
  // restart and nothing in the response saying so — and it took requests that
  // named no zone with it, since the default still resolves through here.
  if (!zones) {
    loading ??= build().catch((error: unknown) => {
      loading = null;
      throw error;
    });

    zones = await loading;
  }

  const direct = zones.get(requested.trim().toLowerCase());
  if (direct) return direct;

  const viaIntl = canonical(requested.trim());

  return viaIntl ? (zones.get(viaIntl.toLowerCase()) ?? null) : null;
}

/** Test seam: drop the cache so a suite can rebuild it. */
export function resetPgTimeZoneCache(): void {
  zones = null;
  loading = null;
}
