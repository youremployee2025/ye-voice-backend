import { describe, expect, it } from 'vitest';
import {
  CREDIT_MULTIPLIER,
  parseSignedCredits,
  toDisplayCredits,
  toInternalCredits,
} from '../src/lib/credits.js';

describe('credit units', () => {
  it('scales display credits by the multiplier', () => {
    expect(CREDIT_MULTIPLIER).toBe(10_000n);
    expect(toInternalCredits('1')).toBe(10_000n);
    expect(toInternalCredits('500')).toBe(5_000_000n);
    expect(toInternalCredits('0')).toBe(0n);
  });

  it('keeps two decimal places exactly', () => {
    expect(toInternalCredits('0.01')).toBe(100n);
    expect(toInternalCredits('12.34')).toBe(123_400n);
    // Through Number this is 699.9999999999999 — the precision loss the
    // multiplier exists to prevent.
    expect(toInternalCredits('0.07')).toBe(700n);
  });

  it('rejects more precision than the multiplier can hold', () => {
    expect(() => toInternalCredits('0.00001')).toThrow();
  });

  it('rejects values that are not plain decimal numbers', () => {
    for (const bad of ['', ' ', 'abc', '1e3', '1.2.3', 'NaN', 'Infinity', '+1', '1 000']) {
      expect(() => toInternalCredits(bad), bad).toThrow();
    }
  });

  it('rejects a negative price', () => {
    expect(() => toInternalCredits('-1')).toThrow();
  });

  it('renders internal credits as a decimal string, never a float', () => {
    expect(toDisplayCredits(10_000n)).toBe('1');
    expect(toDisplayCredits(100n)).toBe('0.01');
    expect(toDisplayCredits(0n)).toBe('0');
    expect(toDisplayCredits(123_400n)).toBe('12.34');
    expect(toDisplayCredits(1n)).toBe('0.0001');
  });

  it('renders a negative amount with the sign outside the digits', () => {
    expect(toDisplayCredits(-5_000_000n)).toBe('-500');
    expect(toDisplayCredits(-100n)).toBe('-0.01');
    expect(toDisplayCredits(-1n)).toBe('-0.0001');
  });

  it('round-trips a balance too large for a double', () => {
    // Past Number.MAX_SAFE_INTEGER (9007199254740991) in INTERNAL units, so a
    // float would already have lost the last digit, and still inside int8 —
    // which is what the column is, and therefore what may round-trip.
    const huge = 9_007_199_254_740_993n;
    expect(toInternalCredits(toDisplayCredits(huge))).toBe(huge);
  });

  it('refuses an amount the credits column could not hold', () => {
    // int8 max is 9223372036854775807; one more must fail here rather than at
    // the write, where it arrives as an unhandled Prisma error and a 500 on a
    // field the route already promised to validate.
    expect(() => toInternalCredits('922337203685477.5808')).toThrow(/out of range/i);
    expect(toInternalCredits('922337203685477.5807')).toBe(9_223_372_036_854_775_807n);
  });
});

describe('parseSignedCredits', () => {
  it('reads a grant', () => {
    expect(parseSignedCredits('25')).toBe(25n * CREDIT_MULTIPLIER);
  });

  it('reads a deduction', () => {
    expect(parseSignedCredits('-25')).toBe(-25n * CREDIT_MULTIPLIER);
  });

  it('reads a signed fraction', () => {
    expect(parseSignedCredits('-0.5')).toBe(-5000n);
  });

  it('rejects zero, which would write a ledger row that changes nothing', () => {
    expect(() => parseSignedCredits('0')).toThrow();
    expect(() => parseSignedCredits('-0')).toThrow();
  });

  it.each(['--1', '1-', '+1', 'abc', ''])('rejects %j', (input) => {
    expect(() => parseSignedCredits(input)).toThrow();
  });
});
