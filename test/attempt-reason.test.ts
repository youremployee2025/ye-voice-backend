import { describe, expect, it } from 'vitest';
import { attemptReason, type AttemptReasonInput } from '../src/lib/attemptReason.js';

const row = (over: Partial<AttemptReasonInput>): AttemptReasonInput => ({
  status: 'FAILED',
  disposition: 'failed',
  answeredBy: null,
  hangupCause: null,
  launchError: null,
  errorCode: null,
  endCallReason: null,
  answeredAt: null,
  upstreamCallId: 'c_1',
  ...over,
});

/**
 * The sentence a customer reads for a dial that produced nothing. Every case
 * here is a wording contract: the dashboard prints the string and nothing
 * else about the cause, so a code must never leak into it.
 */
describe('attemptReason', () => {
  it.each([
    ['PENDING_TIMEOUT', 'gave up on this call before it connected'],
    ['DIAL_TRANSPORT_FAILURE', 'could not reach the carrier'],
    ['ADMIN_DISMISSED', 'closed this call before it connected'],
    ['TELEPHONY_CREDIT_EXHAUSTED', 'its own calling account is out of credit'],
    ['SOMETHING_NEW', 'ended this call before the number was tested'],
  ])('explains a platform fault %s without naming the code', (errorCode, phrase) => {
    const reason = attemptReason(row({ errorCode }));

    expect(reason).toContain(phrase);
    expect(reason).toContain('not counted against this contact');
    expect(reason).not.toContain(errorCode);
  });

  it('says nothing about a platform code beside a person heard: that was a conversation', () => {
    expect(
      attemptReason(row({ status: 'COMPLETED', disposition: 'no_answer', answeredBy: 'human', errorCode: 'ADMIN_DISMISSED' })),
    ).toBeNull();
  });

  it('says the outcome is unknown on an abandoned attempt', () => {
    expect(attemptReason(row({ status: 'ABANDONED', disposition: null, launchError: 'No outcome was ever reported for this call.' })))
      .toBe('We never heard back about this call, so its outcome is unknown.');
  });

  /** The prefixes are the adapter's own codes, exactly as `rollbackLaunch`
   *  writes them: a 400 is `VALIDATION_ERROR`, a 404 `RESOURCE_NOT_FOUND`, a
   *  502 `UPSTREAM_ERROR`. */
  it.each([
    ['UPSTREAM_WRITE_UNCONFIRMED: the platform did not answer; awaiting reconciliation', 'could not confirm'],
    ['VALIDATION_ERROR: Invalid destination number', 'would not accept this number'],
    ['RESOURCE_NOT_FOUND: Not found.', 'agent this campaign dials with was missing'],
    ['UPSTREAM_RATE_LIMITED: Too many calls', 'too busy'],
    ['UPSTREAM_FORBIDDEN: Insufficient credits on partner account', 'refused this call for this account'],
    ['UPSTREAM_ERROR: The voice platform is unavailable', 'could not place this call. This contact went back'],
  ])('explains a launch that never became a call (%s) without the upstream wording', (launchError, phrase) => {
    const reason = attemptReason(row({ launchError, upstreamCallId: null }));

    expect(reason).toContain(phrase);
    expect(reason).not.toMatch(/UPSTREAM|VALIDATION|RESOURCE_NOT|partner|Invalid|unavailable/);
  });

  it('says a refused number will not be called again, and a transient failure that it went back', () => {
    expect(attemptReason(row({ launchError: 'VALIDATION_ERROR: bad', upstreamCallId: null }))).toContain('will not be called again');
    expect(attemptReason(row({ launchError: 'UPSTREAM_ERROR: down', upstreamCallId: null }))).toContain('went back on the queue');
    expect(attemptReason(row({ launchError: 'UPSTREAM_RATE_LIMITED: busy', upstreamCallId: null }))).not.toMatch(/was tried/);
  });

  it('reads the reaper’s own stamps as an unknown outcome, even on a dialled call', () => {
    expect(attemptReason(row({ launchError: 'No classified outcome was ever reported for this call.', disposition: null })))
      .toBe('We never heard back about this call, so its outcome is unknown.');
  });

  it('lets the reaper’s verdict outrank a platform code: that path spent a retry', () => {
    expect(attemptReason(row({ status: 'ABANDONED', errorCode: 'PENDING_TIMEOUT' }))).toBe(
      'We never heard back about this call, so its outcome is unknown.',
    );
  });

  it('does not read a launch error on a call the platform did place as a launch failure', () => {
    // `launchError` also carries an internal failure reason on a dialled call.
    expect(attemptReason(row({ launchError: 'internal: pipeline crashed', disposition: 'voicemail' }))).toBeNull();
  });

  it.each([
    ['1 - Unallocated (unassigned) number', 'not in service'],
    ['3 - No route to destination', 'no route to this number'],
    ['22 - Number changed', 'has changed'],
    ['28 - Invalid number format', 'not a valid phone number'],
  ])('names a bad number off the carrier cause %s and says it will not be called again', (hangupCause, phrase) => {
    const reason = attemptReason(row({ disposition: 'no_answer', hangupCause }));

    expect(reason).toContain(phrase);
    expect(reason).toContain('will not be called again');
    expect(reason).not.toMatch(/Q\.?850|\b(1|3|22|28) -/);
  });

  it('does not call the number bad when a person was heard on it, whatever the cause', () => {
    expect(attemptReason(row({ status: 'COMPLETED', disposition: 'no_answer', answeredBy: 'human', hangupCause: '1 - Unallocated' }))).toBeNull();
  });

  it('leaves an ordinary cause alone: 16 and 17 describe the call, not the number', () => {
    expect(attemptReason(row({ disposition: 'no_answer', hangupCause: '16 - Normal Clearing' }))).toBeNull();
    expect(attemptReason(row({ disposition: 'busy', hangupCause: '17 - User busy' }))).toBeNull();
  });

  it('explains a blocked number', () => {
    expect(attemptReason(row({ disposition: 'blocked' }))).toBe('This number is blocked. It will not be called again.');
  });

  it('is null when the disposition already says everything', () => {
    for (const disposition of ['completed', 'voicemail', 'no_answer', 'busy', 'user_hangup_no_speech', null]) {
      expect(attemptReason(row({ status: 'COMPLETED', disposition }))).toBeNull();
    }
  });
});

describe('end_call_reason', () => {
  it.each([
    ['INVALID_NUMBER', 'not a valid phone number'],
    ['BLOCKED', 'blocked'],
  ])('%s: the number will not be called again', (r, phrase) => {
    const s = attemptReason(row({ endCallReason: r, disposition: 'no_answer' }));
    expect(s?.toLowerCase()).toContain(phrase);
    expect(s).toContain('will not be called again');
  });

  it.each(['NETWORK_ERROR', 'REJECTED', 'CANCELED', 'NOT_CONNECTED'])('%s: one sentence, no token', (r) => {
    const s = attemptReason(row({ endCallReason: r, disposition: 'failed' }));
    expect(s).not.toBeNull();
    expect(s).not.toContain(r);
  });

  it('SYSTEM_ERROR nobody was heard on reads as a platform fault not counted against the contact', () => {
    expect(attemptReason(row({ endCallReason: 'SYSTEM_ERROR' }))).toContain('not counted');
  });

  it('SYSTEM_ERROR beside a person heard is a conversation and says nothing', () => {
    expect(attemptReason(row({ endCallReason: 'SYSTEM_ERROR', answeredBy: 'human', status: 'COMPLETED', disposition: 'completed' }))).toBeNull();
  });

  it.each(['NO_ANSWER', 'BUSY', 'VOICEMAIL', 'COMPLETED', 'CUSTOMER_HUNG_UP', 'UNKNOWN'])(
    '%s: the disposition already says it',
    (r) => expect(attemptReason(row({ endCallReason: r, disposition: 'no_answer' }))).toBeNull(),
  );

  it('the reaper\'s verdict still outranks a reason', () => {
    expect(attemptReason(row({ status: 'ABANDONED', endCallReason: 'INVALID_NUMBER' }))).toContain('outcome is unknown');
  });

  it('an error_code still outranks a reason', () => {
    expect(attemptReason(row({ errorCode: 'PENDING_TIMEOUT', endCallReason: 'INVALID_NUMBER' }))).toContain('gave up on this call');
  });

  /**
   * The platform sets `answered_by: human` on voicelink only when the bot's
   * own worker completes normally, so the teardown that yields SYSTEM_ERROR
   * leaves it null on a call a person answered. The answer stamp is the
   * proof the call connected, and a connected call was tested.
   */
  it('SYSTEM_ERROR on an answered call is not "not counted", whatever answered_by says', () => {
    const s = attemptReason(row({ endCallReason: 'SYSTEM_ERROR', answeredAt: new Date('2026-09-15T10:00:00Z'), disposition: 'failed', status: 'FAILED' }));
    expect(s).toBeNull();
  });

  it('a code on an answered call is a conversation too', () => {
    expect(attemptReason(row({ errorCode: 'ADMIN_DISMISSED', answeredAt: new Date('2026-09-15T10:00:00Z') }))).toBeNull();
  });

  /** The platform maps only Q.850 1 to a verdict and reports 22 as
   *  NOT_CONNECTED; the settle retires 22 off the cause, so the sentence
   *  must say the same rather than "did not connect". */
  it('a Q.850 number verdict outranks a carrier-moment reason', () => {
    const s = attemptReason(row({ hangupCause: '22 - Number changed', endCallReason: 'NOT_CONNECTED', disposition: 'failed', status: 'FAILED' }));
    expect(s).toContain('will not be called again');
    expect(s).not.toContain('did not connect');
  });

  it('a number verdict beside a person heard says nothing', () => {
    expect(attemptReason(row({ endCallReason: 'INVALID_NUMBER', answeredBy: 'human', status: 'COMPLETED', disposition: 'completed' }))).toBeNull();
  });
});
