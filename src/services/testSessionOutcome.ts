import { prisma } from '../lib/prisma.js';
import { chargeFor } from '../lib/dialerPricing.js';

/**
 * Charging a browser test session.
 *
 * This is `applyTerminalOutcome` with every campaign concern removed. What is
 * kept is exactly the part that handles money: the exactly-once marker, the
 * `chargedAt` guard inside the update's own `where`, the conditional debit, and
 * the fail-closed shortfall. A test session is a call without a carrier, and it
 * must not be able to cost a different amount than a call of the same length
 * simply because a different function charged it.
 *
 * What is **not** here, and deliberately:
 *
 * - **No campaign row lock.** There is no campaign, so the lock-ordering hazard
 *   `applyTerminalOutcome` documents at length — its transaction locks an
 *   attempt row while the campaign delete locks the campaign and then nulls
 *   every attempt row, the same pair in the opposite order — cannot arise. Do
 *   not add a lock here to match; there is nothing to order against.
 * - **No contact resolution, no retry ladder, no callback booking.** Nobody is
 *   waiting for a call back from a test.
 */

export interface TestSessionOutcome {
  /** The LOCAL row id. */
  sessionId: string;
  /**
   * The exactly-once key. The webhook's and the reaper's are deliberately
   * different, which is precisely why the `chargedAt` guard below carries the
   * real weight rather than this marker.
   */
  eventKey: string;
  /**
   * The platform's `duration_seconds`, and never anything else. The completion
   * event carries only this one, so billing on another field would make the
   * same session cost a different amount depending on how we heard of it.
   */
  durationSecs: number;
  upstreamStatus: string | null;
  endedAt: Date | null;
}

export type TestSessionOutcomeResult = 'charged' | 'already_closed' | 'unknown';

/** The upstream statuses that mean the session ran to a normal end. Anything
 *  else is recorded as a failure — and charged all the same, because the
 *  minutes were real. */
const COMPLETED = new Set(['completed']);

export async function settleTestSession(
  outcome: TestSessionOutcome,
): Promise<TestSessionOutcomeResult> {
  const session = await prisma.testSession.findUnique({ where: { id: outcome.sessionId } });

  if (!session) return 'unknown';
  if (session.chargedAt !== null) return 'already_closed';

  const now = new Date();
  const rate = session.rateCreditsPerMin ?? 0n;

  /**
   * `?? 1` is not a default anybody chose. It is the honest reading of a row
   * written before the increment column existed, which was billed per second;
   * erring the other way would charge a customer a pulse they were never on.
   */
  const increment = session.billingIncrementSecs ?? 1;
  const { billedSecs, cost } = chargeFor(rate, outcome.durationSecs, increment);

  const status = COMPLETED.has((outcome.upstreamStatus ?? '').toLowerCase().trim())
    ? 'COMPLETED'
    : 'FAILED';

  let alreadyCharged = false;

  await prisma.$transaction(async (tx) => {
    // The marker, inside the transaction. A duplicate delivery violates the
    // unique index and the whole transaction rolls back — which is the entire
    // exactly-once guarantee, rather than a check somebody could reorder.
    await tx.webhookEvent.create({
      data: { eventKey: outcome.eventKey, event: outcome.eventKey.split(':')[0]! },
    });

    /**
     * The `chargedAt` check again, this time as a `where` rather than a read.
     *
     * The read above is taken before the transaction opens, so two settlements
     * for one session through different event keys — the webhook and the
     * reaper's reconciliation are exactly that pair — can both see a null and
     * both proceed. The ledger's `@@unique([accountId, reference])` refuses the
     * second charge, but only when there *is* a charge: a zero-duration session
     * writes no ledger row at all. Guarded here, the second one matches nothing
     * and everything below it is skipped.
     */
    const closed = await tx.testSession.updateMany({
      where: { id: outcome.sessionId, chargedAt: null },
      data: {
        status,
        upstreamStatus: outcome.upstreamStatus,
        durationSecs: outcome.durationSecs,
        // Beside the duration and never instead of it. A row carrying only the
        // billed figure cannot answer "why is this a minute when the session
        // was forty-seven seconds".
        billedSecs,
        endedAt: outcome.endedAt ?? session.endedAt ?? now,
        resolvedAt: now,
        costCredits: cost,
        chargedAt: now,
      },
    });

    if (closed.count === 0) {
      alreadyCharged = true;

      return;
    }

    // A session nobody spoke on costs nothing, at every increment:
    // `ceil(0 / n) * n` is 0 for every n. No ledger row is written for it — a
    // zero-credit charge carries nothing the session row does not already say —
    // and `chargedAt` is set regardless, so a late delivery cannot charge it.
    if (cost === 0n) return;

    // The same conditional debit the dialer and the DID renewal use: the
    // sufficiency test is in the `where`, so there is no window between reading
    // the balance and spending it, and a negative balance is unreachable rather
    // than unlikely.
    const debited = await tx.account.updateMany({
      where: { id: session.accountId, credits: { gte: cost } },
      data: { credits: { decrement: cost } },
    });

    if (debited.count === 0) {
      await tx.testSession.update({
        where: { id: outcome.sessionId },
        data: { shortfall: true },
      });

      await tx.creditTransaction.create({
        data: {
          accountId: session.accountId,
          workspaceId: session.workspaceId,
          testSessionId: session.id,
          reference: session.id,
          amount: 0n,
          type: 'TEST_SESSION_SHORTFALL',
        },
      });

      return;
    }

    await tx.creditTransaction.create({
      data: {
        accountId: session.accountId,
        workspaceId: session.workspaceId,
        testSessionId: session.id,
        reference: session.id,
        amount: -cost,
        type: 'TEST_SESSION_USAGE',
      },
    });
  });

  return alreadyCharged ? 'already_closed' : 'charged';
}
