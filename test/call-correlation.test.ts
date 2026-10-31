import { describe, expect, it } from 'vitest';
import { formatCorrelationId, parseCorrelationId } from '../src/lib/callCorrelation.js';

describe('formatCorrelationId', () => {
  it('namespaces the campaign and contact into one key', () => {
    expect(formatCorrelationId('cmp_1', 'cc_9')).toBe('ezo:cmp_1:cc_9');
  });

  it('round-trips through the parser', () => {
    const key = formatCorrelationId('cmp_1', 'cc_9');

    expect(parseCorrelationId(key)).toEqual({
      campaignId: 'cmp_1',
      campaignContactId: 'cc_9',
      attemptId: null,
    });
  });

  it('round-trips the attempt too', () => {
    const key = formatCorrelationId('cmp_1', 'cc_9', 'att_3');

    expect(parseCorrelationId(key)).toEqual({
      campaignId: 'cmp_1',
      campaignContactId: 'cc_9',
      attemptId: 'att_3',
    });
  });
});

describe('parseCorrelationId', () => {
  it('reads back a key this platform stamped', () => {
    expect(parseCorrelationId('ezo:cmp_abc:cc_def')).toEqual({
      campaignId: 'cmp_abc',
      campaignContactId: 'cc_def',
      attemptId: null,
    });
  });

  it('ignores another integrator sharing the field', () => {
    // The partner account is shared, and this field is where every caller puts
    // its own correlation ids. Claiming one that is not ours would attribute a
    // stranger's call to one of our campaigns.
    expect(parseCorrelationId('crm:cmt47201h08c0pbf4ipn6yp8w:cmt905cif04yvpbantn47pwsp')).toBeNull();
  });

  it('ignores a bare reference with no namespace', () => {
    expect(parseCorrelationId('order-12345')).toBeNull();
  });

  it('rejects a key with the right prefix but the wrong shape', () => {
    // Partially parsing these would resolve a campaign from a key that does
    // not name one.
    expect(parseCorrelationId('ezo:cmp_1')).toBeNull();
    expect(parseCorrelationId('ezo:cmp_1:cc_1:att_1:extra')).toBeNull();
    expect(parseCorrelationId('ezo::cc_1')).toBeNull();
    expect(parseCorrelationId('ezo:cmp_1:')).toBeNull();
    // Present but empty is malformed, not three-segment. Reading it as three
    // would resolve an attempt-less correlation from a string that was trying
    // to name an attempt.
    expect(parseCorrelationId('ezo:cmp_1:cc_1:')).toBeNull();
  });

  /**
   * The dialer's own shape. The platform treats `client_reference_id` as a
   * per-account idempotency key, so a key repeated across two attempts replays
   * the first call rather than dialing again — which would make every retry a
   * no-op while the campaign reported three attempts.
   */
  it('reads the attempt out of a four-segment key', () => {
    expect(parseCorrelationId('ezo:cmp_1:cc_1:att_1')).toEqual({
      campaignId: 'cmp_1',
      campaignContactId: 'cc_1',
      attemptId: 'att_1',
    });
  });

  /**
   * The regression guard for the shipped calls surface. Calls placed before
   * attempts existed carry three segments and must keep resolving to their
   * campaign, or a workspace's history would lose them.
   */
  it('still reads a three-segment key, with no attempt', () => {
    expect(parseCorrelationId('ezo:cmp_1:cc_1')).toEqual({
      campaignId: 'cmp_1',
      campaignContactId: 'cc_1',
      attemptId: null,
    });
  });

  it('formats both shapes', () => {
    expect(formatCorrelationId('cmp_1', 'cc_1')).toBe('ezo:cmp_1:cc_1');
    expect(formatCorrelationId('cmp_1', 'cc_1', 'att_1')).toBe('ezo:cmp_1:cc_1:att_1');
  });

  it('is not fooled by a prefix that merely starts the same way', () => {
    expect(parseCorrelationId('ezo-legacy:cmp_1:cc_1')).toBeNull();
    expect(parseCorrelationId('YE:cmp_1:cc_1')).toBeNull();
  });

  it('treats an absent or non-string value as no correlation', () => {
    expect(parseCorrelationId(null)).toBeNull();
    expect(parseCorrelationId(undefined)).toBeNull();
    expect(parseCorrelationId('')).toBeNull();
    expect(parseCorrelationId(42)).toBeNull();
    expect(parseCorrelationId({ campaignId: 'cmp_1' })).toBeNull();
  });
});
