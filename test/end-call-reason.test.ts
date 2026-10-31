import { describe, expect, it } from 'vitest';
import {
  endReasonLabel,
  isNumberVerdict,
  isPlatformFault,
  normaliseEndCallReason,
} from '../src/lib/endCallReason.js';

describe('normaliseEndCallReason', () => {
  it.each([
    ['customer_hung_up', 'CUSTOMER_HUNG_UP'],
    ['  Completed ', 'COMPLETED'],
    ['SOMETHING_NEW', 'SOMETHING_NEW'],
  ])('upper-cases and trims %s', (raw, expected) => {
    expect(normaliseEndCallReason(raw)).toBe(expected);
  });

  it.each([null, undefined, '', '   '])('reads %s as not reported', (raw) => {
    expect(normaliseEndCallReason(raw)).toBeNull();
  });
});

describe('isNumberVerdict', () => {
  it.each(['INVALID_NUMBER', 'BLOCKED'])('%s says the number itself is bad', (r) => {
    expect(isNumberVerdict(r)).toBe(true);
  });
  it.each(['NO_ANSWER', 'BUSY', 'REJECTED', 'NETWORK_ERROR', 'NOT_CONNECTED', null])(
    '%s is about this call, not the number',
    (r) => expect(isNumberVerdict(r)).toBe(false),
  );
});

describe('isPlatformFault', () => {
  it('is SYSTEM_ERROR and nothing else', () => {
    expect(isPlatformFault('SYSTEM_ERROR')).toBe(true);
    expect(isPlatformFault('UNKNOWN')).toBe(false);
    expect(isPlatformFault(null)).toBe(false);
  });
});

describe('endReasonLabel', () => {
  it('names every documented value in customer words with no token in it', () => {
    for (const v of [
      'COMPLETED', 'CUSTOMER_HUNG_UP', 'TRANSFERRED', 'VOICEMAIL', 'SCREENER', 'SYSTEM_ERROR',
      'BUSY', 'NO_ANSWER', 'REJECTED', 'BLOCKED', 'INVALID_NUMBER', 'NETWORK_ERROR',
      'CANCELED', 'NOT_CONNECTED', 'UNKNOWN',
    ]) {
      const label = endReasonLabel(v);
      expect(label).not.toBeNull();
      expect(label).not.toMatch(/[A-Z]{3,}_/);
    }
  });

  it('returns null for a value it has no words for, and for absence', () => {
    expect(endReasonLabel('SOMETHING_NEW')).toBeNull();
    expect(endReasonLabel(null)).toBeNull();
  });

  it('attributes COMPLETED to the assistant, not to success', () => {
    expect(endReasonLabel('COMPLETED')).toBe('The assistant ended the call');
  });
});
