import type { Prisma } from '@prisma/client';

/**
 * A finished call's extraction results, bounded for storage.
 *
 * The platform returns whatever the agent's own extraction keys asked for, so
 * the keys are the customer's and the values are free text a language model
 * wrote. No allow-list here can name either. Stored verbatim, one call's
 * results could be a megabyte of prose in a row every campaign read joins
 * against — which puts the size of this database in a third party's hands.
 *
 * Bounded on the way IN rather than on the way out. A read-time bound still
 * stores the blob, and the reason to bound it at all is that it is stored.
 *
 * Structure is kept where it fits — an address key that nests means something,
 * and flattening it would cost the reader the shape of their own data. Only a
 * value too large to be anybody's real answer is replaced, and it is replaced
 * with a visibly truncated string rather than dropped, so the key still says
 * it was set.
 */

/**
 * At most this many keys are kept. `MAX_EXTRACTION_KEYS` is the ceiling the
 * agent editor enforces on the config that produces these, so a result wider
 * than this did not come from a config this service would have accepted.
 */
export const MAX_STORED_EXTRACTION_KEYS = 50;

/** Serialized characters kept per value, including the ellipsis. A lead bucket
 *  is a label and a note is a sentence; nothing legitimate comes near this. */
export const MAX_STORED_EXTRACTION_VALUE_CHARS = 2048;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `null` when there is nothing to store, which is deliberately NOT the same as
 * `{}`: an extraction that ran and matched none of its keys is a fact about
 * the call, and one that never ran at all is a fact about the agent.
 */
export function boundExtractionValues(raw: unknown): Prisma.JsonObject | null {
  if (!isPlainObject(raw)) return null;

  const out: Prisma.JsonObject = {};

  for (const [key, value] of Object.entries(raw).slice(0, MAX_STORED_EXTRACTION_KEYS)) {
    // `undefined` is not a JSON value and Prisma will not store one. It cannot
    // come from a parsed body, but this also runs over the reaper's call
    // detail, and a key present with no value is the same absence as a key
    // that is not there.
    if (value === undefined) continue;

    let text: string;

    try {
      text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
    } catch {
      // Circular, which upstream should never send and might. A blob that
      // cannot be written must not take the charge down with it.
      out[key] = '[unreadable]';
      continue;
    }

    out[key] =
      text.length <= MAX_STORED_EXTRACTION_VALUE_CHARS
        ? (value as Prisma.JsonValue)
        : `${text.slice(0, MAX_STORED_EXTRACTION_VALUE_CHARS - 1)}…`;
  }

  return out;
}
