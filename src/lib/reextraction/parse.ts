/**
 * Reading the model's reply back into the managed values an attempt stores —
 * six of them under contender H, seven under I; always `CALL_NOTE_KEYS.length`.
 *
 * Strict, all of it, and for a sharper reason than the live extraction path
 * has. A run in `--apply` mode replaces the attempt's whole `extraction`
 * column, so every way of half-understanding a reply here ends with a
 * contact re-armed from a verdict nobody wrote — or with the values it
 * already had blanked. A reply this module cannot read in full is no
 * extraction at all: the caller records the refusal's own reason beside the
 * row and leaves the contact exactly as it is.
 */
import { CALL_NOTE_KEYS, CALL_OUTCOME_KEY } from '../extractionConfig.js';

/**
 * The word the key descriptions ask for when there is nothing to say, matched
 * on the trimmed and case-folded value in full.
 *
 * Turned into a real null here rather than left for `readCallNote` — which
 * would also read it — because the parsed object is what gets **written** to
 * the attempt, and the word stored is a string every later reader has to
 * know about again.
 */
function nullWordToNull(value: unknown): unknown {
  return typeof value === 'string' && value.trim().toLowerCase() === 'null' ? null : value;
}

/**
 * The reading of one reply: the managed values, or the reason there are none.
 *
 * Three refusals rather than one `null`, because they are three different
 * things to tell an operator staring at a run report. `not_json` is a model
 * that answered in prose or was cut off mid-object — a request worth retrying.
 * `not_an_object` is well-formed JSON of the wrong shape, an array or a bare
 * scalar, which is a prompt problem and will not fix itself on a retry.
 * `no_managed_keys` is a reply about something else entirely. Collapsed into
 * one word, a run whose model quietly started answering in prose would read
 * exactly like a run whose contract keys were renamed.
 */
export type ParsedReply =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; reason: 'not_json' | 'not_an_object' | 'no_managed_keys' | 'partial_reply' };

/**
 * What fraction of the contract's keys a reply that names an outcome has to
 * carry, and the count that comes of it.
 *
 * Four of the original six, and the reason is the whole-column replace: a
 * reply of two keys stored as the attempt's extraction blanks the ones it has
 * held since the call — the memory the next dial reads out loud among them.
 * The instruction names every managed key and asks for `null` where there is
 * nothing to say, so a model answering with a fraction that small has lost
 * the format rather than found a short answer, and the cheapest thing to do
 * with it is refuse it and say so.
 *
 * Kept as a ratio rather than a fixed count so a change to the number of
 * managed keys (six under contender H, seven under I) does not silently
 * loosen or tighten this floor: `MIN_KEYS_WITH_OUTCOME` is recomputed from
 * whatever `CALL_NOTE_KEYS` currently holds.
 *
 * Only a reply that named an OUTCOME is judged this way: one that did not is
 * `no_verdict` a moment later, which writes nothing either, and calling it
 * broken would send an operator to retry a model that answered as it should.
 */
const MIN_KEYS_RATIO = 4 / 6;
const MIN_KEYS_WITH_OUTCOME = Math.ceil(CALL_NOTE_KEYS.length * MIN_KEYS_RATIO);

/**
 * The managed values from a model reply, or why the reply carries none.
 *
 * An object with none of them is refused rather than kept as an empty
 * one. It parses, so JSON alone cannot catch it — and written to the column,
 * an empty object is not "the model found nothing", it is the erasure of
 * whatever the attempt already held.
 */
export function parseCallNoteReply(text: string): ParsedReply {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  let parsed: unknown;

  try {
    parsed = JSON.parse(unfenced);
  } catch {
    return { ok: false, reason: 'not_json' };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'not_an_object' };
  }

  const record = parsed as Record<string, unknown>;
  const values: Record<string, unknown> = {};

  for (const key of CALL_NOTE_KEYS) {
    // `in` rather than a truthiness test: a key the model omitted stays
    // omitted, which is not the same claim as "the model answered null".
    if (key in record) values[key] = nullWordToNull(record[key]);
  }

  const answered = Object.keys(values).length;

  if (answered === 0) return { ok: false, reason: 'no_managed_keys' };

  if (CALL_OUTCOME_KEY in values && answered < MIN_KEYS_WITH_OUTCOME) {
    return { ok: false, reason: 'partial_reply' };
  }

  return { ok: true, values };
}
