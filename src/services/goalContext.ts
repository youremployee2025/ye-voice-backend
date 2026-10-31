import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { boundExtractionValues } from '../lib/extractionCapture.js';

/**
 * The goal context record: what a goal campaign's calls to one contact have
 * left behind, as the bot itself wrote it — the call note for the next call
 * (held in `memory`, the column's name from the contract it replaced), YE's
 * own one-line note about the last call — plus a per-attempt log of what
 * each call was and what it decided.
 *
 * `goalMissing` is no longer written. The column stays, and reads null, so a
 * record from the previous release keeps its line until a later migration
 * decides what to do with it; nothing in this release renders it.
 *
 * ## The idempotency story
 *
 * The record is written inside `applyTerminalOutcome`'s transaction, and the
 * queue redelivers on failure, so this must be safe to replay. It is, by
 * construction rather than by marker:
 *
 * - `attemptLog` is keyed by `attemptNo` — recording an attempt REPLACES its
 *   own entry, so a replay rewrites the entry it already wrote.
 * - `memory` moves only on a non-empty note from an attempt at least as late
 *   as the one on record (`memoryAttempt`), so replaying attempt N's note
 *   after attempt N+1 has written its own leaves the newer one standing, and
 *   replaying it against itself writes the same bytes back.
 * - `lastCallNote` follows the highest attempt ordinal the log knows about,
 *   never the delivery order, for the same reason.
 *
 * "Later" therefore always means a later ATTEMPT and never a later delivery.
 * That is the whole of it: there is no key-by-key merge left to be stale
 * about, only a note the bot rewrites in full on every conversation.
 */

import type { AttemptKind } from '../lib/attemptKind.js';
import { deriveLastCallNote, readCallNote } from '../lib/goalRecord.js';
import { classifyOutcome, reachedAPerson } from '../lib/dialOutcome.js';
import type { CallOutcome, CallbackType } from '../lib/extractionConfig.js';
import type { GoalRecordSnapshot } from '../lib/goalVariables.js';

type Db = PrismaClient | Prisma.TransactionClient;

// Re-exported for callers of this record; the vocabulary itself lives in lib
// (`attemptKind.ts`) because the claim and the queue's job types share it.
export type { AttemptKind };

// The pure record-shape logic lives in lib (`goalRecord.ts`) so read surfaces
// need not import a service module; re-exported here because the write path's
// callers have always found the whole record vocabulary in this module.
export {
  deriveLastCallNote,
  hasSpokenAttempt,
  nextActionOf,
  readCallNote,
  readGoalLog,
  type CallNote,
  type LoggedAttempt,
} from '../lib/goalRecord.js';

export interface RecordAttemptInput {
  campaignContactId: string;
  /** This dial's ordinal — the log's key, which is what makes replay a no-op. */
  attemptNo: number;
  kind: AttemptKind;
  /** The platform's terminal status, normalised. The note needs it: a
   *  `no_answer` or `busy` arrives with neither of the two fields below. */
  status: string | null;
  disposition: string | null;
  answeredBy: string | null;
  /** The session's extraction values, raw off the envelope. Bounded here the
   *  same way the attempt row bounds them, so the two records cannot disagree
   *  about what a stored answer may be. */
  extraction: unknown;
  callbackNote?: string | null;
  durationSecs?: number | null;
}

interface AttemptLogEntry {
  attemptNo: number;
  kind: AttemptKind;
  /** The platform's terminal status, kept because `no_answer` and `busy`
   *  arrive with neither of the two fields below, and the settle's "was
   *  there ever a conversation" reads all three the way the dialer does. */
  status: string | null;
  disposition: string | null;
  answeredBy: string | null;
  /** What the bot decided about this one call, as the call note said it.
   *  Every field null for a silence, and for a conversation whose extraction
   *  never arrived or could not be read — which is a fact worth keeping on
   *  the entry rather than a gap to guess at. The raw callback time is kept
   *  as the model wrote it; what the booking made of it is not stored here. */
  outcome: CallOutcome | null;
  reason: string | null;
  callbackType: CallbackType | null;
  callbackRequestedTime: string | null;
  /** `immediate_callback_needed_vocobaseplatform` and its reason, recorded
   *  beside the derived `callbackType` so an operator reading the attempt
   *  log back can see which of the two plain questions the model answered,
   *  not only what YE derived from them. */
  immediateCallbackNeeded: boolean | null;
  immediateCallbackReason: string | null;
  /** When the bot said this call happened, raw. Kept on the entry rather
   *  than in a column of its own because it belongs to one attempt, and the
   *  dial reads it back from the attempt that wrote the memory — so a record
   *  can never play one call's memory back under another call's clock. */
  callTimestamp?: string | null;
  callbackNote?: string;
  durationSecs?: number;
}

/**
 * The stored Json read back as the array it was written as; anything else —
 * including the column's `[]` default — is an empty log.
 *
 * Deliberately NOT `readGoalLog`, the defensive parser the read surfaces use:
 * this is the write path's reader, and normalising an entry here — dropping a
 * kind another release stamped, an extra field — would silently rewrite it on
 * the next write. What was stored is what is kept.
 */
function readLog(stored: Prisma.JsonValue | undefined): AttemptLogEntry[] {
  return Array.isArray(stored) ? (stored as unknown as AttemptLogEntry[]) : [];
}

/**
 * The timestamp of the call whose memory the record is carrying: the
 * `callTimestamp` of the attempt named by `memoryAttempt`.
 *
 * Read by attempt rather than by taking the last entry's, because the two
 * move on different rules — a silence after a conversation records an
 * attempt but never touches `memory`, and pairing that attempt's clock with
 * the earlier call's account would tell the next dial the conversation
 * happened at a time nobody spoke. A record written before this field
 * existed, or by a call whose extraction had no readable timestamp, simply
 * has none, and the dial then carries the memory without a time.
 */
export function memoryCallTimestamp(row: {
  memoryAttempt: number | null;
  attemptLog: Prisma.JsonValue;
}): string | null {
  if (row.memoryAttempt === null) return null;
  const entry = readLog(row.attemptLog).find((e) => e.attemptNo === row.memoryAttempt);
  const stamp = entry?.callTimestamp;
  return typeof stamp === 'string' && stamp.trim() !== '' ? stamp : null;
}

/**
 * Folds one attempt into the contact's context record, creating it on first
 * touch. Safe to replay — see the module comment — and safe to race: the row
 * is locked for the read-write, so two deliveries recording different attempts
 * of one contact cannot lose each other's writes.
 */
export async function recordAttempt(input: RecordAttemptInput, db: Db = prisma): Promise<void> {
  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    // Ensure the row exists, then lock it. The create is what makes the FOR
    // UPDATE below always find something; a lost create race is a unique
    // violation the retry of this whole call resolves.
    await tx.campaignContactGoal.upsert({
      where: { campaignContactId: input.campaignContactId },
      create: { campaignContactId: input.campaignContactId },
      update: {},
    });

    await tx.$queryRaw`
      SELECT id FROM "CampaignContactGoal"
      WHERE "campaignContactId" = ${input.campaignContactId} FOR UPDATE`;

    const row = await tx.campaignContactGoal.findUniqueOrThrow({
      where: { campaignContactId: input.campaignContactId },
      select: { memoryAttempt: true, attemptLog: true },
    });

    // Bounded exactly as the attempt row's copy is, before anything reads it.
    const extraction = boundExtractionValues(input.extraction);
    const note = readCallNote(extraction);
    const log = readLog(row.attemptLog);

    // A later ATTEMPT's note wins; an empty one never erases; a stale
    // redelivery (an older ordinal than the writer on record) is ignored.
    // "Empty never erases" is what keeps a silence — a voicemail after a real
    // conversation — from wiping the note the next conversation needs.
    //
    // And a silence never WRITES, whatever its extraction says. The post-call
    // model fills in every key it is given whether or not anybody spoke (PR
    // #48: 27 of 843 contacts carried confident answers off a voicemail
    // greeting), so "the note is non-empty" is not evidence of a conversation.
    // Judged by the dialer's own rule — the one that decides whether the phone
    // rings again — so the memory and the retry ladder agree about what a
    // conversation is. The attempt-log entry still records the note the model
    // wrote, for the operator reading the journey back.
    const reached = reachedAPerson(
      classifyOutcome({
        status: input.status,
        disposition: input.disposition,
        answeredBy: input.answeredBy,
      }),
    );
    const later = row.memoryAttempt === null || input.attemptNo >= row.memoryAttempt;
    const memoryMoves = reached && note.note !== null && later;

    // The note follows the LATEST attempt by ordinal, whatever the delivery
    // order: a replay of attempt 1 after attempt 2 recorded must not turn
    // "reached voicemail" back into "spoke, worth calling again".
    const latest = Math.max(input.attemptNo, ...log.map((e) => e.attemptNo));
    const noteMoves = input.attemptNo === latest;

    const entry: AttemptLogEntry = {
      attemptNo: input.attemptNo,
      kind: input.kind,
      status: input.status,
      disposition: input.disposition,
      answeredBy: input.answeredBy,
      outcome: note.outcome,
      reason: note.reason,
      callbackType: note.callbackType,
      callbackRequestedTime: note.callbackRequestedTime,
      immediateCallbackNeeded: note.immediateCallbackNeeded,
      immediateCallbackReason: note.immediateCallbackReason,
      callTimestamp: note.callTimestamp,
      ...(input.callbackNote ? { callbackNote: input.callbackNote } : {}),
      ...(input.durationSecs == null ? {} : { durationSecs: input.durationSecs }),
    };

    const nextLog = [...log.filter((e) => e.attemptNo !== input.attemptNo), entry].sort(
      (a, b) => a.attemptNo - b.attemptNo,
    );

    await tx.campaignContactGoal.update({
      where: { campaignContactId: input.campaignContactId },
      data: {
        attemptLog: nextLog as unknown as Prisma.InputJsonValue,
        ...(memoryMoves ? { memory: note.note, memoryAttempt: input.attemptNo } : {}),
        ...(noteMoves
          ? {
              lastCallNote: deriveLastCallNote({
                status: input.status,
                disposition: input.disposition,
                answeredBy: input.answeredBy,
                callbackNote: input.callbackNote ?? null,
                note,
              }),
            }
          : {}),
      },
    });
  };

  // Callers already inside a transaction pass their client; everyone else
  // gets one here, because the lock above only means something inside one.
  if ('$transaction' in db) await db.$transaction(run);
  else await run(db);
}

/**
 * What the call-note overlay renders from: the memory the last conversation
 * left, and the timestamp of the very call that left it.
 *
 * One indexed read (the `campaignContactId` unique). `attemptLog` rides along
 * because the timestamp lives on the attempt that wrote the memory rather
 * than in a column — the log is bounded by the dial ceiling (26 at both
 * budgets' maxima), so it costs
 * nothing to carry. A null row is the first dial's normal state: the record
 * is created lazily by the first recorded attempt.
 */
export async function goalSnapshot(campaignContactId: string): Promise<GoalRecordSnapshot | null> {
  const row = await prisma.campaignContactGoal.findUnique({
    where: { campaignContactId },
    select: { memory: true, memoryAttempt: true, attemptLog: true },
  });
  if (row === null) return null;
  return { memory: row.memory, callTimestamp: memoryCallTimestamp(row) };
}
