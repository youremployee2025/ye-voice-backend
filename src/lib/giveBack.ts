import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Hands a claimed contact back to the queue after a dial that was never a
 * test of the number — a launch the platform refused to take, or an attempt
 * the platform ended before the carrier heard it.
 *
 * **Never increments `attempts`**: that counts retries consumed, and a call
 * that never reached the number consumed nothing. **Never touches
 * `armKind`**: what the row was waiting for has not changed. And three
 * branches, because the armed-callback invariant (`nextEligibleAt ==
 * callbackAt`, both non-null) has to survive a backoff:
 *
 * 1. An armed promise the backoff would overrun — both columns move to the
 *    backoff, together. The `callbackAt` bound also excludes a null, so a
 *    CALLBACK row that somehow lost its time falls through to branch 3
 *    rather than being handed a promise instant here.
 * 2. An armed promise still ahead of the backoff — neither column moves.
 *    Pushing `nextEligibleAt` alone would break the pair and silently
 *    downgrade a promise to a plain retry.
 * 3. Everything else, a RESUME included — `nextEligibleAt` alone. Stamping
 *    `callbackAt` as well would manufacture a promise nobody made.
 *
 * `where` is the caller's guard — the launch path guards on `QUEUED`, the
 * resolution on its claimed-and-latest predicate — and it is ANDed onto each
 * branch, so a row the caller no longer owns is moved by none of them.
 *
 * **`where` MUST carry a status predicate that `PENDING` fails.** Branches 1
 * and 2 are disjoint on `callbackAt`; branch 3 has no `armKind` exclusion of
 * its own and is disjoint from them only because they flip the row to
 * `PENDING` first, out of the caller's guard. A `where` without that guard
 * would let branch 3 re-match a promise branch 2 just left untouched and push
 * its `nextEligibleAt` off the pair. Both callers today guard on status; a
 * third must too. The sum of the counts is whether the row moved at all.
 *
 * **There is no cap on how often a contact is given back**, deliberately. A
 * persistent platform fault — its transport down for hours — re-dials every
 * PENDING contact once per campaign cooldown, at zero seconds and zero
 * credits, until the fault clears or an operator pauses. That is the same
 * exposure `rollbackLaunch` has to a platform that 502s every launch. The
 * one code that never clears on its own, `TELEPHONY_CREDIT_EXHAUSTED`, pauses
 * the campaign instead. `attemptNo` climbs; the goal record's attempt log does
 * not, because `applyTerminalOutcome` records no entry for a platform fault,
 * so the log stays bounded by the dial budget as `dialBudget.ts` states.
 */
export async function giveBackWithBackoff(
  db: Db,
  where: Prisma.CampaignContactWhereInput,
  backoffAt: Date,
): Promise<number> {
  const overrun = await db.campaignContact.updateMany({
    where: { ...where, armKind: 'CALLBACK', callbackAt: { lte: backoffAt } },
    data: { status: 'PENDING', nextEligibleAt: backoffAt, callbackAt: backoffAt },
  });
  const ahead = await db.campaignContact.updateMany({
    where: { ...where, armKind: 'CALLBACK', callbackAt: { gt: backoffAt } },
    data: { status: 'PENDING' },
  });
  const rest = await db.campaignContact.updateMany({
    where,
    data: { status: 'PENDING', nextEligibleAt: backoffAt },
  });

  return overrun.count + ahead.count + rest.count;
}
