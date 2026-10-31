/**
 * The kinds of dial a campaign can place, in one place — and, beside them, the
 * two readings of a finished call that the record write needs to name one.
 *
 * The vocabulary is shared by three layers — the claim stamps it onto the
 * attempt row, the placement job carries it, and the goal context record logs
 * it — so it lives in lib rather than in any one of them: the queue's job
 * types must not import a service to name a string.
 *
 * `deriveKind` and `callbackNoteFrom` moved down here when the context record
 * moved into `applyTerminalOutcome`'s transaction. They were the webhook
 * handler's, and the outcome module cannot import that handler — the handler
 * imports the outcome module — so a shared reading of "what kind of dial was
 * this" and "what time did this call promise" needs a home neither owns. A
 * second copy of either would eventually disagree with the first about the
 * same call.
 */

import type { ContactArmKind, Prisma } from '@prisma/client';
import { CALLBACK_AT_KEY, CALLBACK_REQUESTED_AT_KEY } from './extractionConfig.js';
import { readCallNote } from './goalRecord.js';

export const ATTEMPT_KINDS = ['fresh', 'retry', 'callback', 'follow_up', 'resume'] as const;

export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

const KINDS: ReadonlySet<string> = new Set(ATTEMPT_KINDS);

/**
 * The claim's lane, as the label the dial carries for the rest of its life.
 *
 * One entry per `ContactArmKind`, and a bijection on purpose: the arm is what
 * chose this contact out of the queue, so deriving the label from anything
 * else is how the order a batch was picked in and the name it later answers to
 * come apart. That is what happened when the label read `followUpCount > 0` —
 * a lifetime tally — while the retry lane had already stopped ordering on it.
 *
 * `FRESH` maps to `fresh` whatever the ordinal says. A contact still armed
 * FRESH on its second ordinal is one whose first launch never reached the
 * platform (`rollbackLaunch` gives the row back without moving `attempts`), so
 * nobody has been dialled yet and `retry` would be a claim about a call that
 * was never placed. The ordinal remains `deriveKind`'s fallback for rows
 * written before the stamp existed, where it is the only fact available.
 */
const KIND_OF_ARM = {
  FRESH: 'fresh',
  RETRY: 'retry',
  FOLLOW_UP: 'follow_up',
  RESUME: 'resume',
  CALLBACK: 'callback',
} as const satisfies Record<ContactArmKind, AttemptKind>;

/** The inverse, for a placement job that carries the label and needs the arm
 *  the claim read — see `dialerPlacement.ts`. */
const ARM_OF_KIND = {
  fresh: 'FRESH',
  retry: 'RETRY',
  follow_up: 'FOLLOW_UP',
  resume: 'RESUME',
  callback: 'CALLBACK',
} as const satisfies Record<AttemptKind, ContactArmKind>;

export function attemptKindOf(arm: ContactArmKind): AttemptKind {
  return KIND_OF_ARM[arm];
}

export function armKindOf(kind: AttemptKind): ContactArmKind {
  return ARM_OF_KIND[kind];
}

/** Whether a stored value is a kind this release recognises. A value outside
 *  the set — another release's vocabulary — is for the caller's fallback, not
 *  an error. */
export function isAttemptKind(value: string): value is AttemptKind {
  return KINDS.has(value);
}

/**
 * What kind of dial this attempt was.
 *
 * The attempt row's own stamp first: it was written at claim time, from the
 * contact's `armKind` as the claiming statement read it, and it is the only
 * answer that survives replay — the live contact columns mutate between
 * deliveries (a booking arms a callback, a settle leaves the arm behind as
 * history), so a redelivery reading them would call the same attempt two
 * different things. Legacy rows without a stamp fall back to the ordinal
 * alone: the first dial is fresh and everything else reads as a retry, which
 * under-reports callbacks, resumes and follow-ups but never flips between
 * deliveries. Every kind is stamped at claim time, so the normal flow never
 * needs the override — it stays as a seam for a caller that knows better than
 * the stamp.
 */
export function deriveKind(
  attempt: { kind: string | null; attemptNo: number },
  override?: AttemptKind,
): AttemptKind {
  if (override) return override;
  // A stamp outside the vocabulary — another release's — reads as unstamped
  // rather than throwing.
  if (attempt.kind !== null && isAttemptKind(attempt.kind)) return attempt.kind;

  return attempt.attemptNo === 1 ? 'fresh' : 'retry';
}

/**
 * The promised callback time as a note for the context record, or null when
 * the call promised nothing — or promised it in a shape that is not text.
 *
 * `callback_requested_at` is YE's own key, attached to the campaign's agent at
 * start. `callback_at` is read as a fallback only: the platform reserves that
 * name for itself and injects it on calls its own campaign product originates,
 * which ours are not — but an agent that already carries one is worth reading.
 *
 * A note, never a time: the booking parses the raw value in the campaign's own
 * zone, and this is only what the NEXT call is told the last one promised. So
 * it is deliberately verbatim ("Tuesday 4pm" as the person said it) rather
 * than a normalised instant.
 */
export function callbackNoteFrom(extraction: Prisma.JsonObject | null): string | null {
  if (extraction === null) return null;

  const raw = extraction[CALLBACK_REQUESTED_AT_KEY] ?? extraction[CALLBACK_AT_KEY] ?? null;

  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

/**
 * The raw value the callback booking parses.
 *
 * One reading since 2026-09-06, where there used to be two. Every campaign's
 * agent carries the call-note set now, so the time a person asked for arrives
 * in `callback_requested_time_vocobaseplatform`, and it is a promise only
 * when the same note says the call is `incomplete` and the callback was
 * `requested`. The key's own description tells the model to write "null" for
 * every other callback type, but a model that writes a time anyway —
 * "immediate" beside a guess at when — must not book a call nobody asked for,
 * so the type is the gate and the time alone is not enough.
 *
 * **The plain `callback_requested_at` key is deliberately NOT read as a
 * fallback**, which is the rule this had before the switch went away and the
 * reason for it is unchanged: agents are shared between campaigns, so a stale
 * key from some other campaign's set is routinely sitting in the same
 * extraction — and read as a promise it books a call on a conversation that
 * said `completed`. `callbackNoteFrom` above still reads it, because a note
 * describing what the last call said is a different claim from a time this
 * campaign undertook to keep.
 *
 * Both webhook delivery and the reaper's reconciliation pass through here,
 * so a promise heard late is read by the same rule as one heard on time.
 */
export function callbackRawFrom(extraction: unknown): unknown {
  const note = readCallNote(extraction);

  return note.outcome === 'incomplete' && note.callbackType === 'requested'
    ? note.callbackRequestedTime
    : null;
}
