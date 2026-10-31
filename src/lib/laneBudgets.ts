/**
 * How one campaign's slots are split between fresh contacts and everything it
 * has already dialled.
 *
 * `Campaign.retryConcurrency` reserves part of `concurrencyLimit` for contacts
 * this campaign has called before — a retry, a follow-up, a resume and a
 * promised callback all draw on it. The column name is the customer's and
 * stays; the names in here say what it actually holds, because a reservation
 * described as "retries" is one a later reader computes from the retry lane
 * alone, and the other three lanes then spend a reservation nothing subtracts
 * them from.
 *
 * Without a reservation the two sides compete in one FIFO pool, and whichever
 * is larger starves the other: a long tail of retries stops a fresh list ever
 * being reached, or a fresh list of ten thousand rows means a retry promised
 * for twenty minutes ago waits for hours.
 *
 * The whole rule is arithmetic and lives here, with no database access and no
 * clock, because it is the one part of the dispatcher that has to be provable.
 * Every subtlety below is a way this function can be got wrong in a way that
 * only shows up as a campaign quietly dialing less than it was told to.
 */

export interface LaneBudgetInput {
  /** The campaign's own ceiling on simultaneous calls. */
  concurrencyLimit: number;
  /** Slots held for everything already dialled. 0 means one shared pool. */
  retryConcurrency: number;
  /** This campaign's in-flight calls claimed by the fresh lane. */
  activeFresh: number;
  /**
   * This campaign's in-flight calls claimed by every other lane — retry,
   * follow-up, resume and callback together. They all draw on the reservation
   * below, which is why they are counted as one number here.
   */
  activeNonFresh: number;
  /**
   * Everything outside this campaign that also caps it, already narrowed to one
   * number: the account's remaining allotment, the shared platform pool's
   * remaining capacity, and the per-sweep blast radius.
   */
  accountRemaining: number;
}

export interface LaneBudgets {
  /** The pass's whole budget. Every lane draws from this, none adds to it. */
  totalSlots: number;
  /** What the reservation leaves for every lane that is not fresh. */
  nonFreshBudget: number;
  freshBudget: number;
}

export function computeLaneBudgets({
  concurrencyLimit,
  retryConcurrency,
  activeFresh,
  activeNonFresh,
  accountRemaining,
}: LaneBudgetInput): LaneBudgets {
  const activeAll = activeFresh + activeNonFresh;

  // Floored at 0 rather than allowed negative. Lowering `concurrencyLimit`
  // below what is already live is a legitimate operator action — it must stop
  // the *next* dial, and it must never read as a negative budget somewhere
  // downstream, and it must certainly never hang up a call already connected.
  const totalSlots = Math.max(0, Math.min(accountRemaining, concurrencyLimit - activeAll));

  // Re-clamped here, not trusted from the row. The validators reject a
  // `retryConcurrency` above the limit at write time, but the limit can be
  // lowered afterwards by a path that did not re-check, and a reservation
  // larger than the whole cap would leave `freshBudget` permanently 0 — a fresh
  // list that never dials, for a setting nobody typed.
  const reserved = Math.max(0, Math.min(retryConcurrency, concurrencyLimit));

  // Both budgets subtract that side's *own* in-flight count, which is what
  // makes the reservation hold across passes rather than only within one. A
  // budget computed from the limit alone would hand the non-fresh side its
  // full reservation again on every pass while the previous pass's calls were
  // still ringing, and the reservation would be spent several times over.
  //
  // Both are capped by `totalSlots`: a side may never dial more than the pass
  // has, however much of the limit is nominally reserved for it.
  const nonFreshBudget = Math.min(totalSlots, Math.max(0, reserved - activeNonFresh));
  const freshBudget = Math.min(totalSlots, Math.max(0, concurrencyLimit - reserved - activeFresh));

  return { totalSlots, nonFreshBudget, freshBudget };
}

/**
 * One pool, two lanes drawing on it, and a percentage saying how it divides.
 *
 * The reservation above answers how many slots the non-fresh side gets. This
 * answers what that side does with them, between the **urgent** lanes — a
 * callback somebody was promised, a resume of a call that cut out — and plain
 * **retries**. Both were competing for one number, first-asked-first-served,
 * which is only a policy while both sides are short: a campaign whose queue is
 * mostly one kind spent the whole reservation on it and the other waited out
 * the pass.
 */
export interface SplitInput {
  /** The slots being divided. Whatever the reservation left this pass. */
  pool: number;
  /** The share of the non-fresh side the retry lane is owed, 0–100. */
  retrySharePercent: number;
  /** This campaign's live retry-lane calls. */
  activeRetry: number;
  /** This campaign's live callback and resume calls. */
  activeUrgent: number;
}

/** The two floors, which always sum to exactly `pool`. */
export interface PoolSplit {
  retryFloor: number;
  urgentFloor: number;
}

/**
 * Three properties, each of which is a way to get this wrong.
 *
 * **Floors, not ceilings.** Neither number caps a lane. The caller offers each
 * lane its floor and then offers the remainder to whichever lane still has
 * rows to claim, so a split costs nothing when only one side has work — which
 * is the ordinary case. The division binds only when both sides are contended,
 * which is the only case it was written for.
 *
 * **Computed against in-flight, not against the pool alone.** A share taken
 * over `pool` by itself is re-granted whole every pass and rounds to nothing on
 * a small one: a pool of one at 40% floors the retry lane at zero on every
 * pass for ever, and every marginal slot goes to the urgent lanes. Taking the
 * share over `activeRetry + activeUrgent + pool` and subtracting what the retry
 * lane already holds makes the ratio a property of the campaign's live calls
 * rather than of one pass's leftovers — the same thing that makes the
 * reservation above hold across passes rather than only within one.
 *
 * **The retry floor rounds down and the urgent lane takes the remainder**, so
 * the two sum to exactly `pool`. Rounding both idles a slot the account paid
 * for on every odd division. The remainder going to the urgent side is the
 * safe direction of that asymmetry: those are the two lanes carrying a person
 * who is owed a call now.
 *
 * `retrySharePercent` is re-clamped rather than trusted from the row, for the
 * reason `retryConcurrency` is above: a validator bounds it at write time, and
 * a value from a row written before that validator — or by a path that did not
 * re-check — must not be able to produce a floor outside the pool.
 */
export function splitPool({
  pool,
  retrySharePercent,
  activeRetry,
  activeUrgent,
}: SplitInput): PoolSplit {
  if (pool <= 0) return { retryFloor: 0, urgentFloor: 0 };

  const share = Math.max(0, Math.min(100, retrySharePercent));
  const wanted = Math.floor(((activeRetry + activeUrgent + pool) * share) / 100);
  const retryFloor = Math.max(0, Math.min(pool, wanted - activeRetry));

  return { retryFloor, urgentFloor: pool - retryFloor };
}
