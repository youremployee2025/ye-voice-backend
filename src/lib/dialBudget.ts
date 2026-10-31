import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * What counts against a contact's dial budget, in one place — and, since
 * 2026-09-06, what that budget IS.
 *
 * The cap is "MAX(attemptNo) has reached the ceiling", and `attemptNo` is
 * `MAX(attemptNo) + 1` over **every** `CallAttempt` row — including the rows
 * `rollbackLaunch` closes when the platform refused to take the call at all.
 * Six transient 502s leave a contact with ordinals 1..6 and `attempts` still
 * 0, and counted whole they spend the entire dial budget of somebody whose
 * phone never rang once. The claim then refuses them in every lane forever;
 * nothing settles them (the do-not-call sweep only touches listed numbers,
 * `releaseStaleClaims` only QUEUED), so they sit PENDING, the completion pass
 * counts them as unfinished, and the campaign never completes either.
 *
 * ## What "never placed" is, exactly
 *
 * The three columns `rollbackLaunch` leaves on a non-permanent launch failure,
 * together: the row is `FAILED`, it carries no platform call id, and it
 * records why the launch failed. All three, because each alone is a state a
 * real call can reach — a dialled call that failed carries a `launchError`
 * from the outcome's failure reason, and a row still in flight has no
 * `upstreamCallId` yet.
 *
 * **A platform fault is never placed either.** An attempt the platform ended
 * before the carrier tested the number — reaped pre-connect, never handed to
 * the carrier, dismissed by an operator, its telephony account dry, the bot
 * process torn down — has a call id, because the platform did accept the
 * launch, so the three-column rule above cannot see it. The platform reports
 * that fact through **two fields read as one**: `errorCode` (the documented
 * contract, which the platform's call surfaces do not actually emit as of
 * 2026-09-15) and `endCallReason = 'SYSTEM_ERROR'` (the field it does emit,
 * on every call ending). Either is the fourth column, and `classifyOutcome`
 * hands the contact back on either; a budget that read only the code would
 * hand the contact back and then refuse its next claim forever. The reason is
 * compared as the upper-case literal because the column stores it normalised.
 *
 * **Both spellings guard the reason against NULL, and neither may negate the
 * bare equality.** All five callers apply this predicate under `NOT` — the
 * claim and its daily cap (`dialerClaim.ts`), the over-budget settle
 * (`campaignLifecycle.ts`), the ladder analytics (`analytics.ts`),
 * `dialBudgetSpent` below, and the re-extraction selection
 * (`reextraction.service.ts`) — and the column is null on every ordinary
 * dial. Under three-valued logic a bare `"endCallReason" = 'SYSTEM_ERROR'`
 * on a null column is NULL rather than false, `NOT NULL` is still NULL, and
 * a NULL predicate excludes the row from a count and an `EXISTS` alike — so
 * the bare form counted no dial whose reason was null, the claim took
 * contacts at their cap, and the resolution re-armed retries past it. The
 * SQL half uses `COALESCE(...) = 'SYSTEM_ERROR'`; the Prisma half writes
 * `IS NOT NULL AND = 'SYSTEM_ERROR'`, because Prisma generates the bare `=`
 * with no guard of its own. The Prisma shape was verified against its
 * generated SQL (`$on('query')`, Prisma 6.19, 2026-09-15) and
 * `test/dial-budget-equivalence.test.ts` holds the two in step on every row
 * shape; re-capture the generated SQL whenever either spelling changes.
 *
 * **Unless the call was answered.** An `ADMIN_DISMISSED` or a `SYSTEM_ERROR`
 * on a session that hung after the conversation carries the signal AND either
 * `answered_by: human` or an `answeredAt` stamp; `classifyOutcome` settles
 * that as the conversation it was, and the budget reads the same evidence, or
 * the contact gets one dial more than the retry panel allows. The stamp is
 * read as well as the detector because on voicelink the platform writes
 * `answered_by: human` only when the bot's own worker completes normally —
 * the teardown that produces `SYSTEM_ERROR` leaves it null on a call a person
 * had answered. `platformFaultOnRow` in `dialOutcome.ts` is the same rule for
 * a row already in hand.
 *
 * `UPSTREAM_WRITE_UNCONFIRMED` is deliberately **kept**. It writes a
 * `launchError` too, but leaves the row `QUEUED` for the reaper to reconcile
 * against the platform's own record: the call may be ringing right now, and
 * reading it as never placed would dial the same person twice.
 *
 * ## One rule, two spellings
 *
 * The claim needs it as SQL inside a `NOT EXISTS`; the resolution and the
 * callback booking need it as a Prisma filter. Both are generated from this
 * module so the gate that refuses a dial and the gate that arms the next one
 * cannot come to disagree about what a dial is.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** The SQL half, against a `CallAttempt` alias the caller names. */
export function neverPlacedSql(alias: string): Prisma.Sql {
  const a = Prisma.raw(`"${alias}"`);

  return Prisma.sql`((${a}.status = 'FAILED' AND ${a}."upstreamCallId" IS NULL AND ${a}."launchError" IS NOT NULL) OR ((${a}."errorCode" IS NOT NULL OR COALESCE(${a}."endCallReason", '') = 'SYSTEM_ERROR') AND LOWER(COALESCE(${a}."answeredBy", '')) <> 'human' AND ${a}."answeredAt" IS NULL))`;
}

/** The Prisma half, as a `CallAttempt` where-filter. */
export const NEVER_PLACED: Prisma.CallAttemptWhereInput = {
  OR: [
    { status: 'FAILED', upstreamCallId: null, launchError: { not: null } },
    {
      AND: [
        {
          OR: [
            { errorCode: { not: null } },
            { AND: [{ endCallReason: { not: null } }, { endCallReason: 'SYSTEM_ERROR' }] },
          ],
        },
        { OR: [{ answeredBy: null }, { answeredBy: { not: 'human', mode: 'insensitive' } }] },
        { answeredAt: null },
      ],
    },
  ],
};

/**
 * A contact's total dials: the first call, plus BOTH lane budgets.
 *
 * There are two of those since 2026-09-09 and they are spent by different
 * contacts, never by the same one. `retryCount` times a number nobody has
 * reached; `maxGoalFollowUps` times a contact who has ANSWERED, and the first
 * answer forfeits whatever retries were left. So no contact can actually reach
 * this sum — it is the ceiling over both lanes, not a budget of its own, and
 * it is what the API reports as `maxTotalDials`.
 *
 * DERIVED, never read off `Campaign.maxTotalDials`. That column stopped being
 * read on 2026-09-06, when the goal's separate budget was removed because two
 * ceilings over one telephone is one too many: whichever bound first, the
 * other was a control that did nothing. What came back on 2026-09-09 is not
 * that second ceiling — it is a per-lane budget, and this is still the one
 * absolute cap, spent by every kind of dial with the single exemption the
 * claim has always made for a callback time a person actually asked for.
 *
 * `retryCount` is capped at `MAX_RETRY_COUNT` (20) and `maxGoalFollowUps` at
 * `MAX_GOAL_FOLLOW_UPS_CEILING` (15), so the total is at most 36, comfortably
 * inside the fifty entries the Json attempt log is sized for.
 *
 * The stored column is still accepted and still written for compatibility; no
 * caller in the engine reads it.
 */
export function totalDialsFor(campaign: { retryCount: number; maxGoalFollowUps: number }): number {
  return campaign.retryCount + 1 + campaign.maxGoalFollowUps;
}

/**
 * Whether this contact has already spent its dial budget: a **placed** attempt
 * at or past the cap.
 *
 * The same shape as the claim's `NOT EXISTS`, and asked the same way — one
 * probe of the `(campaignContactId, attemptNo)` unique — so a resolution that
 * refuses to re-arm and a claim that refuses to take the contact are refusing
 * on identical grounds. Callers hold the campaign lock, and both of them have
 * already established that no attempt outranks the one in hand.
 */
export async function dialBudgetSpent(
  db: Db,
  campaignContactId: string,
  maxTotalDials: number,
): Promise<boolean> {
  const placed = await db.callAttempt.count({
    where: {
      campaignContactId,
      attemptNo: { gte: maxTotalDials },
      NOT: NEVER_PLACED,
    },
  });

  return placed > 0;
}
