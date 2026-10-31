import { describe, expect, it } from 'vitest';
import { canonicalizeE164, isCountryCode } from '../src/lib/phone.js';

describe('canonicalizeE164', () => {
  it('keeps a number that carries its own country code', () => {
    expect(canonicalizeE164('+919876543210')).toBe('+919876543210');
    expect(canonicalizeE164('+1 (415) 555-0132')).toBe('+14155550132');
  });

  it('accepts the 00 international prefix', () => {
    expect(canonicalizeE164('00919876543210')).toBe('+919876543210');
  });

  it('accepts digits that already contain a country code but lost the plus', () => {
    expect(canonicalizeE164('919876543210')).toBe('+919876543210');
  });

  it('rejects an E.164-shaped number that is not a real one', () => {
    // +91 followed by an 8-digit stub. A regex check accepts this; it is not
    // a phone number, and it fails at dial time rather than at upload.
    expect(canonicalizeE164('9109518550')).toBeNull();
    expect(canonicalizeE164('+9109518550')).toBeNull();
  });

  it('rejects a bare national number when no country is supplied', () => {
    expect(canonicalizeE164('9876543210')).toBeNull();
  });

  it('interprets a bare national number against an explicit country', () => {
    expect(canonicalizeE164('9876543210', 'IN')).toBe('+919876543210');
  });

  it('never lets a default country override an explicit one', () => {
    expect(canonicalizeE164('+14155550132', 'IN')).toBe('+14155550132');
  });

  it('rejects junk rather than stripping it', () => {
    expect(canonicalizeE164('')).toBeNull();
    expect(canonicalizeE164('   ')).toBeNull();
    expect(canonicalizeE164('call me maybe')).toBeNull();
    expect(canonicalizeE164('+91 98765 43210 ext 12')).toBeNull();
  });
});

describe('isCountryCode', () => {
  it('accepts a real ISO-3166 alpha-2 and rejects anything else', () => {
    expect(isCountryCode('IN')).toBe(true);
    expect(isCountryCode('US')).toBe(true);
    expect(isCountryCode('XX')).toBe(false);
    expect(isCountryCode('india')).toBe(false);
    expect(isCountryCode('')).toBe(false);
  });
});
