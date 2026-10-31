import { describe, expect, it } from 'vitest';
import { computeLaneBudgets, splitPool } from '../src/lib/laneBudgets.js';

/**
 * Pure arithmetic, so this file is pure arithmetic too: no database, no clock,
 * no dispatcher. Every case below is a way a campaign quietly dials less — or
 * more — than it was configured to, which is the kind of fault nobody reports
 * because nothing looks broken.
 */

const budgets = (over: Partial<Parameters<typeof computeLaneBudgets>[0]> = {}) =>
  computeLaneBudgets({
    concurrencyLimit: 10,
    retryConcurrency: 0,
    activeFresh: 0,
    activeNonFresh: 0,
    accountRemaining: 100,
    ...over,
  });

describe('with no reservation', () => {
  it('offers the whole limit to both lanes', () => {
    const { totalSlots, nonFreshBudget, freshBudget } = budgets();

    expect(totalSlots).toBe(10);
    // `retryConcurrency: 0` is one shared pool. The dispatcher runs a single
    // FIFO pass in that case and never reads `nonFreshBudget`, but it must
    // not be some number that would silently reserve capacity if it ever did.
    expect(nonFreshBudget).toBe(0);
    expect(freshBudget).toBe(10);
  });

  it('subtracts what is already in flight', () => {
    expect(budgets({ activeFresh: 4 })).toMatchObject({ totalSlots: 6, freshBudget: 6 });
  });
});

describe('the reservation', () => {
  it('splits the limit between the lanes', () => {
    const { totalSlots, nonFreshBudget, freshBudget } = budgets({ retryConcurrency: 3 });

    expect(totalSlots).toBe(10);
    expect(nonFreshBudget).toBe(3);
    expect(freshBudget).toBe(7);
  });

  /**
   * The property that makes a reservation a reservation.
   *
   * Budgets subtract the **per-lane** in-flight count, so a retry lane that
   * spent its three slots last pass gets nothing this pass while those calls
   * are still up. Computed from the limit alone, the lane would be handed its
   * full reservation again every minute and would spend it several times over
   * — which is the same thing as having no reservation at all.
   */
  it('holds across passes rather than only within one', () => {
    const first = budgets({ retryConcurrency: 3 });
    expect(first.nonFreshBudget).toBe(3);

    // Those three retries are now ringing, and two fresh calls went out beside
    // them.
    const second = budgets({ retryConcurrency: 3, activeNonFresh: 3, activeFresh: 2 });

    expect(second.totalSlots).toBe(5);
    expect(second.nonFreshBudget).toBe(0);
    expect(second.freshBudget).toBe(5);
  });

  it('gives the fresh lane nothing once it has filled its share', () => {
    const { nonFreshBudget, freshBudget } = budgets({ retryConcurrency: 4, activeFresh: 6 });

    expect(freshBudget).toBe(0);
    // The retry lane still has its own share: that is what it was held for.
    expect(nonFreshBudget).toBe(4);
  });

  /**
   * `concurrencyLimit` can be lowered after `retryConcurrency` was set — by a
   * path that did not re-validate the pair, or by a row written before the
   * cross-field rule existed. Left unclamped, a reservation of 8 against a
   * limit of 2 makes `freshBudget` permanently 0: a fresh list that never
   * dials, for a setting nobody typed.
   */
  it('re-clamps a reservation that now exceeds the limit', () => {
    const { totalSlots, nonFreshBudget, freshBudget } = budgets({
      concurrencyLimit: 2,
      retryConcurrency: 8,
    });

    expect(totalSlots).toBe(2);
    expect(nonFreshBudget).toBe(2);
    // Reserved is clamped to the limit, so the fresh lane is legitimately
    // empty — but by the reservation, not by arithmetic that went negative.
    expect(freshBudget).toBe(0);
  });

  it('never lets a lane dial more than the pass has', () => {
    const { totalSlots, nonFreshBudget, freshBudget } = budgets({
      retryConcurrency: 6,
      accountRemaining: 2,
    });

    expect(totalSlots).toBe(2);
    expect(nonFreshBudget).toBe(2);
    expect(freshBudget).toBe(2);
  });
});

describe('the caps outside the campaign', () => {
  it('is bounded by what the account has left', () => {
    expect(budgets({ accountRemaining: 3 }).totalSlots).toBe(3);
  });

  it('is zero when the account has nothing left', () => {
    const { totalSlots, nonFreshBudget, freshBudget } = budgets({ accountRemaining: 0 });

    expect(totalSlots).toBe(0);
    expect(nonFreshBudget).toBe(0);
    expect(freshBudget).toBe(0);
  });

  /**
   * An account already over its allotment — staff lowered it, or another
   * workspace's campaign got there first — reports a negative remainder. The
   * pass must dial nothing, and must not report a negative budget that some
   * caller subtracts from.
   */
  it('floors a negative account remainder at zero', () => {
    expect(budgets({ accountRemaining: -4 })).toEqual({
      totalSlots: 0,
      nonFreshBudget: 0,
      freshBudget: 0,
    });
  });
});

/**
 * Lowering a limit below the live count is a legitimate operator action. It
 * stops the next dial; it never hangs up a call already connected, and it never
 * produces a negative number anywhere.
 */
describe('a limit lowered below what is already live', () => {
  it('yields no slots rather than a negative budget', () => {
    const { totalSlots, nonFreshBudget, freshBudget } = budgets({
      concurrencyLimit: 2,
      retryConcurrency: 1,
      activeFresh: 3,
      activeNonFresh: 2,
    });

    expect(totalSlots).toBe(0);
    expect(nonFreshBudget).toBe(0);
    expect(freshBudget).toBe(0);
  });

  it('never returns a negative number for any combination', () => {
    for (const concurrencyLimit of [0, 1, 5, 10]) {
      for (const retryConcurrency of [0, 1, 5, 20]) {
        for (const activeFresh of [0, 3, 12]) {
          for (const activeNonFresh of [0, 3, 12]) {
            for (const accountRemaining of [-5, 0, 1, 50]) {
              const result = computeLaneBudgets({
                concurrencyLimit,
                retryConcurrency,
                activeFresh,
                activeNonFresh,
                accountRemaining,
              });

              expect(result.totalSlots).toBeGreaterThanOrEqual(0);
              expect(result.nonFreshBudget).toBeGreaterThanOrEqual(0);
              expect(result.freshBudget).toBeGreaterThanOrEqual(0);
              // Neither lane may exceed the pass's own budget, whatever the
              // reservation says.
              expect(result.nonFreshBudget).toBeLessThanOrEqual(result.totalSlots);
              expect(result.freshBudget).toBeLessThanOrEqual(result.totalSlots);
            }
          }
        }
      }
    }
  });
});

/**
 * The share split, one level below the reservation: what the non-fresh lanes
 * do with the slots the reservation left them, between the urgent arms
 * (callback, resume) and the retries. Same house rules as the budgets above —
 * pure, and every case below is a way the split quietly stops splitting.
 */
describe('splitting a pool by share', () => {
  const split = (over: Partial<Parameters<typeof splitPool>[0]> = {}) =>
    splitPool({
      pool: 10,
      retrySharePercent: 50,
      activeRetry: 0,
      activeUrgent: 0,
      ...over,
    });

  /**
   * The two floors partition the pool exactly. The retry floor rounds down and
   * the urgent lane takes the remainder, because rounding both idles a slot the
   * account paid for on every odd division — once a pass, on a campaign that is
   * already short of them.
   */
  it('divides the whole pool, on an even division and an odd one', () => {
    expect(split({ pool: 10 })).toEqual({ retryFloor: 5, urgentFloor: 5 });
    expect(split({ pool: 11 })).toEqual({ retryFloor: 5, urgentFloor: 6 });
  });

  /**
   * The property the reservation itself has, and the one a share taken over
   * the pool alone cannot: a pool of one divided per pass rounds the retry
   * floor to zero every time and hands every marginal slot to the urgent lanes
   * for ever. Taken over in-flight + pool with in-flight subtracted, the ratio
   * holds across passes.
   */
  it('holds the ratio across passes rather than only within one', () => {
    expect(split({ pool: 11, retrySharePercent: 60 })).toEqual({
      retryFloor: 6,
      urgentFloor: 5,
    });

    // The next pass: seven of those eleven calls are still up — four retries
    // and three urgent — and four slots came free. 60% of eleven is still six
    // retries, four of which are already dialing, so the floor is two.
    expect(split({ pool: 4, retrySharePercent: 60, activeRetry: 4, activeUrgent: 3 })).toEqual({
      retryFloor: 2,
      urgentFloor: 2,
    });
  });

  it('offers the retry lane nothing at a share of zero', () => {
    expect(split({ pool: 7, retrySharePercent: 0 })).toEqual({ retryFloor: 0, urgentFloor: 7 });
  });
});
