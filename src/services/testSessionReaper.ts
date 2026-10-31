import type { TestSession } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { getSession } from '../adapter/vocobase.js';
import { readNumber, readString } from '../lib/upstream.js';
import { settleTestSession } from './testSessionOutcome.js';

/**
 * Browser test sessions whose completion never arrived.
 *
 * A webhook is a delivery, not a guarantee. Without this a session sits
 * unsettled forever — holding the workspace's one live slot, so the Test button
 * refuses with "already running" when nothing is, and holding a line from the
 * pool the dialer shares.
 *
 * **It does not guess.** It asks the platform, which is the only party that
 * knows when the audio stopped. A session the platform reports as still live is
 * left for the next tick rather than settled at the cap: settling it would
 * invent a duration, on the row that decides what a customer is charged. The
 * only thing closed without an answer is a session the platform has never heard
 * of, and that gets its own status rather than being filed as a failure.
 */

/** Bounded like every other pass here: a large stale set is a symptom, and
 *  working through all of it in one tick is not the fix. */
const BATCH = 50;

/**
 * How long an `ENDING` session waits before it is reconciled.
 *
 * Much shorter than the `ACTIVE` timeout, and deliberately: the browser has
 * already said it hung up, so the completion event is seconds away rather than
 * minutes. A minute is long enough for that event to land and short enough that
 * a lost one does not leave the charge outstanding for a quarter of an hour.
 */
const ENDING_TIMEOUT_MS = 60_000;

/** Terminal on the platform's own vocabulary. Anything else is still live. */
const TERMINAL_STATUSES = new Set(['completed', 'failed']);

export async function closeStaleTestSessions(now: Date): Promise<number> {
  const activeCutoff = new Date(now.getTime() - env.testSessionTimeoutMins * 60_000);
  const endingCutoff = new Date(now.getTime() - ENDING_TIMEOUT_MS);

  const stale = await prisma.testSession.findMany({
    where: {
      // `chargedAt` on both arms: charged is settled, whatever the status
      // column may say, and the charge path stamps it in the same statement
      // that moves the status.
      chargedAt: null,
      OR: [
        { status: 'ACTIVE', startedAt: { lte: activeCutoff } },
        { status: 'ENDING', startedAt: { lte: endingCutoff } },
      ],
    },
    orderBy: { startedAt: 'asc' },
    take: BATCH,
  });

  let closed = 0;

  for (const session of stale) {
    try {
      if (await reconcile(session, now)) closed += 1;
    } catch (err) {
      // One unreadable session must not stop the rest being closed; a slot held
      // open is the exact problem this function exists to solve.
      console.error(`[test-session] could not reconcile session ${session.id}:`, err);
    }
  }

  return closed;
}

async function reconcile(session: TestSession, now: Date): Promise<boolean> {
  // A session with no platform id is one whose start never confirmed — the
  // request went out and the answer was lost. There is nothing to ask about,
  // because the id we would ask with is the thing we never received.
  if (session.upstreamSessionId) {
    const upstream = await getSession(session.upstreamSessionId);

    if (upstream) {
      const status = readString(upstream, ['status']);

      if (status && TERMINAL_STATUSES.has(status.toLowerCase())) {
        const result = await settleTestSession({
          sessionId: session.id,
          // Deliberately not the webhook's key. The two paths must be able to
          // race without one silently consuming the other's marker — what
          // actually makes this exactly-once is the `chargedAt IS NULL` guard
          // inside the settlement's own `where`.
          eventKey: `testSession.reap:${session.id}`,
          durationSecs: readNumber(upstream, ['duration_seconds', 'durationSeconds']) ?? 0,
          upstreamStatus: status.toLowerCase(),
          endedAt: session.endedAt ?? now,
        });

        return result === 'charged';
      }

      // Still live upstream. Left exactly as it is for the next tick — the
      // alternative is inventing a duration, and only the platform knows.
      return false;
    }
  }

  return abandon(session, now);
}

/**
 * Closes a session the platform has no record of.
 *
 * `ABANDONED` rather than `FAILED`, on the same reasoning `CallAttemptStatus`
 * carries: "we never found out" and "it did not work" are different facts, and
 * filing the first as the second misreports what happened.
 *
 * Charged at nothing, because nothing can say otherwise — but `chargedAt` is
 * stamped all the same, so a delivery arriving later cannot charge a session
 * this pass has already closed.
 */
async function abandon(session: TestSession, now: Date): Promise<boolean> {
  const closed = await prisma.testSession.updateMany({
    where: { id: session.id, chargedAt: null },
    data: {
      status: 'ABANDONED',
      endedAt: session.endedAt ?? now,
      resolvedAt: now,
      chargedAt: now,
    },
  });

  if (closed.count === 0) return false;

  console.log(`[test-session] abandoned ${session.id}; the platform has no record of it.`);

  return true;
}
