import { describe, expect, it } from 'vitest';
import { addOneMonth } from '../src/lib/billingCycle.js';

const iso = (d: Date) => d.toISOString();

describe('addOneMonth', () => {
  it('advances an ordinary date by one month', () => {
    expect(iso(addOneMonth(new Date('2026-03-15T10:30:00.000Z')))).toBe('2026-04-15T10:30:00.000Z');
  });

  it('clamps to the last day when the target month is shorter', () => {
    // Date.setMonth would overflow these into the following month, and a
    // rental that skips a month is a month of free service.
    expect(iso(addOneMonth(new Date('2026-01-31T00:00:00.000Z')))).toBe('2026-02-28T00:00:00.000Z');
    expect(iso(addOneMonth(new Date('2026-03-31T12:00:00.000Z')))).toBe('2026-04-30T12:00:00.000Z');
    expect(iso(addOneMonth(new Date('2026-05-31T00:00:00.000Z')))).toBe('2026-06-30T00:00:00.000Z');
  });

  it('clamps to 29 February in a leap year', () => {
    expect(iso(addOneMonth(new Date('2028-01-31T00:00:00.000Z')))).toBe('2028-02-29T00:00:00.000Z');
  });

  it('rolls the year over from December', () => {
    expect(iso(addOneMonth(new Date('2026-12-31T23:59:00.000Z')))).toBe('2027-01-31T23:59:00.000Z');
  });

  it('preserves the time of day to the millisecond', () => {
    expect(iso(addOneMonth(new Date('2026-05-10T07:08:09.010Z')))).toBe('2026-06-10T07:08:09.010Z');
  });

  it('does not mutate its argument', () => {
    const start = new Date('2026-03-15T10:30:00.000Z');
    addOneMonth(start);
    expect(iso(start)).toBe('2026-03-15T10:30:00.000Z');
  });

  it('steps month by month across a short month rather than sticking to it', () => {
    // A DID rented on the 31st renews on the 28th, and the month after that
    // on the 28th again. Clamping is per-step, so the day never grows back —
    // stated here because the alternative (remembering the original day) is a
    // defensible design this one deliberately is not.
    const feb = addOneMonth(new Date('2026-01-31T00:00:00.000Z'));
    expect(iso(addOneMonth(feb))).toBe('2026-03-28T00:00:00.000Z');
  });
});
