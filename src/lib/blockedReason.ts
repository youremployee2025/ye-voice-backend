/**
 * Which cap is holding a campaign that placed no calls this pass.
 *
 * A campaign whose `totalSlots` came out at zero dials nothing and, until
 * this module existed, said nothing — so a campaign waiting on one stuck
 * attempt and a campaign nobody had started looked identical in the log. The
 * operator-visible symptom is the same either way: **the campaign looks
 * idle**, and there is no line anywhere to contradict that reading.
 *
 * Naming the cap is the whole point. "No slots" on its own sends a reader to
 * check all four things `sweepCampaign` weighs; naming the binding one sends
 * them to the single knob that can actually move.
 *
 * Pure arithmetic, no database and no clock, for the reason `laneBudgets.ts`
 * gives for the same choice: this is the part that has to be provable, and a
 * log line that names the wrong cap is worse than no log line at all — it
 * sends somebody to raise a limit that was never the one holding the campaign.
 */

/**
 * The caps that can actually be binding here.
 *
 * **Three, not four.** The per-sweep budget (`DIALER_MAX_CALLS_PER_SWEEP`) is
 * the fourth cap `sweepCampaign` weighs, and it can never be the answer: the
 * pass loop breaks on `budget <= 0` before a campaign is swept, so any
 * campaign that reaches the blocked branch was swept with at least one unit of
 * budget left — and a positive budget cannot be what drove `totalSlots` to
 * zero. Offering it as a possible reason would be offering an answer that is
 * always wrong.
 */
export type BlockingCap = 'platform_pool' | 'account_allotment' | 'campaign_concurrency';

export interface BlockedInput {
  /** The campaign's own ceiling on simultaneous calls. */
  concurrencyLimit: number;
  /** Its in-flight calls, including this pass's claims and earlier backlogs. */
  activeAll: number;
  /** The allotment YE sold the owning account. */
  accountLimit: number;
  /** That account's in-flight calls, claims and pending placements. */
  accountActive: number;
  /**
   * The shared platform pool's remaining capacity.
   *
   * `null` is the platform saying **uncapped**, never "could not read" — an
   * unreadable pool halts the whole pass with `pool_unreadable` long before
   * any campaign is swept. Treating null as zero here would name the pool for
   * every blocked campaign on an account with no ceiling.
   */
  platformRemaining: number | null;
}

/**
 * The outermost cap that is actually exhausted, or `null` if none is.
 *
 * **Exhausted, not smallest.** An earlier version took the numeric `Math.min`,
 * which is wrong the moment a cap goes negative — and negative is a state this
 * codebase deliberately supports. `laneBudgets.ts` says lowering
 * `concurrencyLimit` below what is already live is "a legitimate operator
 * action", and the staff route accepts the same for an account's allotment. A
 * campaign at `concurrencyLimit: 1` with 5 calls live sits at −4, so the
 * minimum names the campaign even when the account allotment is *also* spent —
 * hiding the account-wide fact behind one campaign's over-subscription, which
 * is exactly the moment an operator most needs the account named.
 *
 * Resolution is **outward**, in the order relief actually unblocks anything:
 * raising a campaign's limit while the account is also spent moves nothing,
 * and raising the account's while the shared pool is empty moves nothing
 * either. The reader is pointed at the only knob that can help.
 *
 * `null` rather than a confident guess when nothing is exhausted. The
 * precondition — that `computeLaneBudgets` already reduced `totalSlots` to
 * zero — lives in `sweepCampaign`, not here, and a pure function that answers
 * anyway would be the one thing this module's own docblock argues against:
 * naming a cap that is not holding anything.
 */
export function bindingCap({
  concurrencyLimit,
  activeAll,
  accountLimit,
  accountActive,
  platformRemaining,
}: BlockedInput): BlockingCap | null {
  if ((platformRemaining ?? Number.MAX_SAFE_INTEGER) <= 0) return 'platform_pool';
  if (accountLimit - accountActive <= 0) return 'account_allotment';
  if (concurrencyLimit - activeAll <= 0) return 'campaign_concurrency';

  return null;
}
