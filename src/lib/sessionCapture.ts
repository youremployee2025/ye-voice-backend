import type { Prisma } from '@prisma/client';

/**
 * A finished call's conversation and the variables it was placed with, bounded
 * for storage.
 *
 * The sibling of `extractionCapture`, and it makes the same argument: this is
 * free text a third party produces, stored verbatim it puts the size of this
 * database in their hands, and it is bounded on the way **in** because the
 * reason to bound it at all is that it is stored.
 *
 * What is different here is that the transcript field **is not always a
 * transcript**. The documented shape is an array of turns; a call that never
 * connected arrives as an object — `{ error, provider, terminal_reason }` —
 * and one still being processed arrives as null. `normalizeTranscript` in
 * `serialize.ts` exists to stop a renderer presenting the second as speech,
 * and the same hazard applies one layer earlier: a diagnostic written into a
 * column named `transcript` is carrier internals filed as something the
 * customer said, and every later reader inherits the mistake.
 */

/** Turns kept. A long call is a few hundred; this is generous by an order of
 *  magnitude and exists to bound a runaway, not to trim a conversation. */
export const MAX_STORED_TRANSCRIPT_TURNS = 2000;

/** Characters kept in one turn, including the ellipsis. A turn is an
 *  utterance; nothing anybody actually said comes near this. */
export const MAX_STORED_TRANSCRIPT_CHARS = 4000;

/**
 * Characters kept across the whole conversation.
 *
 * The per-turn cap alone bounds one row at turns × chars, which is megabytes —
 * a ceiling that is not a ceiling. This is the real budget; the per-turn cap
 * stops one turn spending all of it.
 */
export const MAX_STORED_TRANSCRIPT_TOTAL_CHARS = 256_000;

/** One stored turn. Deliberately the same shape `normalizeTranscript` emits,
 *  so a stored transcript and a live one render through one path. */
export interface StoredTurn {
  role: string;
  content: string;
  timestamp: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The first of several spellings that carries a non-empty string. */
function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];

    if (typeof value === 'string' && value.trim() !== '') return value;
  }

  return null;
}

function truncate(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap - 1)}…`;
}

/**
 * The conversation, or `null` when there was not one.
 *
 * **`null` and `[]` are different facts, and both are real.** Null is no
 * conversation recorded — the field was absent, still processing, or an error
 * object describing a call that never connected. `[]` is a call that connected
 * and on which nobody said anything, which is a thing a call does.
 *
 * A turn is read under whichever names its row used, the way the re-extraction
 * dump reader already does: the platform spells a turn's side and its words
 * more than one way, and a reader that knows only one spelling silently stores
 * an empty conversation for a real one.
 */
export function boundTranscript(raw: unknown): Prisma.JsonArray | null {
  if (!Array.isArray(raw)) return null;

  const turns: StoredTurn[] = [];
  let spent = 0;
  let truncated = false;

  for (const turn of raw) {
    if (turns.length >= MAX_STORED_TRANSCRIPT_TURNS) {
      truncated = true;
      break;
    }

    // A turn that is not an object at all is dropped rather than coerced: the
    // alternative is `[object Object]` or a bare `null` stored as something
    // somebody said.
    if (!isPlainObject(turn)) continue;

    const content = firstString(turn, ['content', 'text', 'message']);

    // A turn with no words is not a turn. Kept, it reads as a silence
    // somebody recorded.
    if (content === null) continue;

    const bounded = truncate(content, MAX_STORED_TRANSCRIPT_CHARS);

    if (spent + bounded.length > MAX_STORED_TRANSCRIPT_TOTAL_CHARS) {
      truncated = true;
      break;
    }

    spent += bounded.length;

    turns.push({
      role: firstString(turn, ['role', 'speaker', 'type']) ?? 'unknown',
      content: bounded,
      timestamp: firstString(turn, ['timestamp', 'at']),
    });
  }

  // Said in the transcript rather than in a column beside it, because every
  // reader of this value is rendering a conversation and none of them would
  // think to check a flag. A stored transcript that is short must never read
  // as a call that was short.
  if (truncated) {
    turns.push({
      role: 'system',
      content: '[This transcript was truncated for storage; the call was longer than this.]',
      timestamp: null,
    });
  }

  return turns as unknown as Prisma.JsonArray;
}

/**
 * Variables kept on one attempt.
 *
 * Deliberately NOT `MAX_STORED_EXTRACTION_KEYS`, which is 50. That cap's whole
 * justification is specific to extraction — `MAX_EXTRACTION_KEYS` is the
 * ceiling the agent editor enforces on the config that produces those results,
 * so a wider one did not come from a config this service would have accepted.
 *
 * **Nothing bounds a variable payload that way.** They come from the
 * customer's own CSV through `Campaign.variableMap`, and production calls
 * measured on 2026-09-08 carry **101** of them: a hundred columns plus
 * `external_id` and the managed call-note key. Reusing the extraction's cap
 * stored the first fifty and dropped the rest alphabetically, with nothing on
 * the row saying so and every later column exporting blank.
 *
 * This is set well clear of that so a customer with a wider sheet is not
 * silently trimmed. It is still a bound rather than none: the payload is a
 * third party's to shape, and the reason to bound it is that it is stored.
 */
export const MAX_STORED_VARIABLES = 500;

/** Characters kept in one variable's value. A variable is a field from a
 *  spreadsheet; the widest seen in production is about 1,200. */
export const MAX_STORED_VARIABLE_CHARS = 4000;

/**
 * The variables a dial went out with, bounded for storage.
 *
 * `null` when there was nothing to store — the payload was absent or not an
 * object. `{}` is kept as itself: a campaign that maps no columns sends no
 * variables, and that is a thing it does rather than an absence.
 *
 * A value too long to be anybody's real field is truncated visibly rather than
 * dropped, so the key still says it was set — the rule `extractionCapture`
 * follows, and for the same reason.
 */
export function boundVariables(raw: unknown): Prisma.JsonObject | null {
  if (!isPlainObject(raw)) return null;

  const out: Prisma.JsonObject = {};

  for (const [key, value] of Object.entries(raw).slice(0, MAX_STORED_VARIABLES)) {
    // Not a JSON value and Prisma will not store one; a key present with no
    // value is the same absence as a key that is not there.
    if (value === undefined) continue;

    let text: string;

    try {
      text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
    } catch {
      out[key] = '[unreadable]';
      continue;
    }

    out[key] =
      text.length <= MAX_STORED_VARIABLE_CHARS
        ? (value as Prisma.JsonValue)
        : `${text.slice(0, MAX_STORED_VARIABLE_CHARS - 1)}…`;
  }

  return out;
}
