import { describe, expect, it } from 'vitest';
import { bindingCap } from '../src/lib/blockedReason.js';

/**
 * Pure arithmetic, so this file is pure arithmetic too — the same shape as
 * `lane-budgets.test.ts`, and for the same reason: this is the half of the
 * blocked-sweep line that has to be provable. Naming the wrong cap sends an
 * operator to raise a limit that was never the one holding the campaign.
 */

const cap = (over: Partial<Parameters<typeof bindingCap>[0]> = {}) =>
  bindingCap({
    concurrencyLimit: 10,
    activeAll: 0,
    accountLimit: 100,
    accountActive: 0,
    platformRemaining: 1000,
    ...over,
  });

describe('the cap that is actually binding', () => {
  it('names the campaign when its own ceiling is full', () => {
    expect(cap({ activeAll: 10 })).toBe('campaign_concurrency');
  });

  it('names the account when its allotment is spent', () => {
    expect(cap({ accountLimit: 4, accountActive: 4 })).toBe('account_allotment');
  });

  it('names the shared pool when the platform has no room', () => {
    expect(cap({ platformRemaining: 0 })).toBe('platform_pool');
  });
});

describe('an uncapped platform', () => {
  it('is never the binding cap', () => {
    // `null` is the platform saying "no ceiling", not "could not read" — an
    // unreadable pool halts the whole pass before any campaign is swept. A
    // `?? 0` here would name the pool for every blocked campaign on an
    // unlimited account.
    expect(cap({ platformRemaining: null, activeAll: 10 })).toBe('campaign_concurrency');
  });
});

describe('nothing exhausted', () => {
  /**
   * The precondition — that `computeLaneBudgets` already reduced `totalSlots`
   * to zero — lives in the caller. Answering anyway would be the one thing
   * this module argues against: naming a cap that is holding nothing.
   */
  it('is null rather than a confident guess', () => {
    expect(cap()).toBeNull();
  });

  it('is null when every cap has room to spare', () => {
    expect(cap({ concurrencyLimit: 10, activeAll: 9, accountLimit: 5, accountActive: 4 })).toBeNull();
  });
});

describe('a cap lowered below what is already live', () => {
  /**
   * Negative remaining is a supported state, not a corruption: `laneBudgets.ts`
   * calls lowering `concurrencyLimit` under the live count "a legitimate
   * operator action", and staff may do the same to an account's allotment.
   *
   * These are the cases a numeric `Math.min` got wrong — it would name
   * whichever cap was most negative, hiding an account-wide or platform-wide
   * fact behind one campaign's over-subscription, at exactly the moment an
   * operator most needs the outer one named.
   */
  it('does not let an over-subscribed campaign mask a spent allotment', () => {
    expect(cap({ concurrencyLimit: 1, activeAll: 5, accountLimit: 10, accountActive: 10 })).toBe(
      'account_allotment',
    );
  });

  it('does not let an over-spent allotment mask an empty pool', () => {
    expect(cap({ accountLimit: 5, accountActive: 8, platformRemaining: 0 })).toBe('platform_pool');
  });

  it('still names the campaign when it is the only one exhausted', () => {
    expect(cap({ concurrencyLimit: 1, activeAll: 5 })).toBe('campaign_concurrency');
  });

  it('treats an over-spent allotment the same as an exactly-spent one', () => {
    expect(cap({ accountLimit: 2, accountActive: 5 })).toBe('account_allotment');
  });
});

describe('when more than one cap is exhausted', () => {
  /**
   * Outermost first, because that is the order in which relief actually
   * unblocks anything. Raising a campaign's limit while the account allotment
   * is also spent moves nothing, so naming the campaign there would send the
   * reader to the one knob that cannot help.
   */
  it('prefers the platform pool over the account', () => {
    expect(cap({ platformRemaining: 0, accountLimit: 4, accountActive: 4 })).toBe('platform_pool');
  });

  it('prefers the account over the campaign', () => {
    expect(cap({ accountLimit: 4, accountActive: 4, activeAll: 10 })).toBe('account_allotment');
  });

  it('prefers the platform pool over everything', () => {
    expect(cap({ platformRemaining: 0, accountLimit: 4, accountActive: 4, activeAll: 10 })).toBe(
      'platform_pool',
    );
  });

  /**
   * The shipped defaults put an ordinary busy campaign here: `Campaign
   * .concurrencyLimit` defaults to 2 and `DIALER_DEFAULT_ACCOUNT_CONCURRENCY`
   * to 2, so both hit zero on the same pass. The account wins, which is why
   * the account arm needs the same wedged-age gate the campaign arm has —
   * otherwise the commonest healthy state is the loudest thing in the log.
   */
  it('names the account on the default 2-and-2 collision', () => {
    expect(cap({ concurrencyLimit: 2, activeAll: 2, accountLimit: 2, accountActive: 2 })).toBe(
      'account_allotment',
    );
  });
});
