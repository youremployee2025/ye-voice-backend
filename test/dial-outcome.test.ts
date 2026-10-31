import { describe, expect, it } from 'vitest';
import { classifyOutcome, exhaustsPlatformCredit, reachedAPerson } from '../src/lib/dialOutcome.js';

/**
 * The dialer's own rule: whether the phone rings again.
 *
 * The cases below are drawn from a real incident. While the voice platform was
 * unstable it returned `disposition: failed` with `duration 0` and a hangup
 * cause that was either absent or Q.850 16 / 32 — normal clearing. Filed as
 * permanent, those settled live contacts at attempt 1 of 21 for good.
 */
const failedCall = (hangupCause: string | null) => ({
  status: 'failed',
  disposition: 'failed',
  answeredBy: null,
  hangupCause,
});

describe('classifyOutcome — a failed call is not a wall by itself', () => {
  it.each([
    ['16 - Normal Clearing', 'a normal clearing with its label'],
    ['16', 'a bare normal clearing'],
    ['32', 'normal, unspecified'],
    [null, 'no cause reported at all'],
    ['', 'an empty cause'],
    ['NORMAL_CLEARING', 'a cause with no number in it'],
  ])('retries a failed call reported with %s (%s)', (hangupCause) => {
    const outcome = classifyOutcome(failedCall(hangupCause));

    expect(outcome.permanent).toBe(false);
    expect(outcome.retryable).toBe(true);
  });

  it.each([
    ['1', 'unallocated number'],
    ['3 - No route to destination', 'no route'],
    ['22', 'number changed'],
    ['28 - Invalid number format', 'invalid format'],
  ])('still settles a failed call the carrier blames on the number (%s)', (hangupCause) => {
    expect(classifyOutcome(failedCall(hangupCause)).permanent).toBe(true);
  });

  it('never counts a failed call as having reached a person', () => {
    expect(reachedAPerson(classifyOutcome(failedCall('16')))).toBe(false);
    expect(reachedAPerson(classifyOutcome(failedCall('1')))).toBe(false);
  });
});

/**
 * The platform labels an unallocated number `no_answer`, not `failed` — its
 * own cause-to-disposition mapping does not read the Q.850 code. So the cause
 * has to be read on every silence, not only on a `failed` one, or a dead
 * number is redialled for the whole ladder.
 */
describe('classifyOutcome — a dead number is dead whatever the disposition says', () => {
  it.each([
    ['no_answer', '1 - Unallocated (unassigned) number'],
    ['no_answer', '22 - Number changed'],
    ['busy', '28 - Invalid number format'],
    ['voicemail', '3 - No route to destination'],
  ])('settles a %s labelled call whose cause names the number (%s)', (disposition, hangupCause) => {
    const outcome = classifyOutcome({
      status: 'no_answer',
      disposition,
      answeredBy: null,
      hangupCause,
    });

    expect(outcome.permanent).toBe(true);
  });

  it('never settles a conversation on a stray cause', () => {
    const outcome = classifyOutcome({
      status: 'completed',
      disposition: 'completed',
      answeredBy: 'human',
      hangupCause: '1 - Unallocated (unassigned) number',
    });

    expect(outcome.permanent).toBe(false);
    expect(reachedAPerson(outcome)).toBe(true);
  });

  it('keeps a normally-cleared silence retryable', () => {
    // 1,839 calls in one production week: cause 16, never answered.
    const outcome = classifyOutcome({
      status: 'no_answer',
      disposition: 'no_answer',
      answeredBy: null,
      hangupCause: '16 - Normal Clearing',
    });

    expect(outcome.permanent).toBe(false);
    expect(outcome.retryable).toBe(true);
  });
});

describe('classifyOutcome — the rules a failed call must not disturb', () => {
  it('keeps a blocked number permanent whatever the carrier said', () => {
    for (const hangupCause of ['16', '1', null]) {
      const outcome = classifyOutcome({
        status: 'completed',
        disposition: 'blocked',
        answeredBy: null,
        hangupCause,
      });

      expect(outcome.permanent).toBe(true);
    }
  });

  it('leaves a completed conversation reaching a person', () => {
    const outcome = classifyOutcome({
      status: 'completed',
      disposition: 'completed',
      answeredBy: 'human',
      hangupCause: '16 - Normal Clearing',
    });

    expect(outcome.permanent).toBe(false);
    expect(outcome.retryable).toBe(false);
    expect(reachedAPerson(outcome)).toBe(true);
  });

  it('still treats the documented silences as retryable and never permanent', () => {
    const silences = [
      { status: 'no_answer', disposition: null, answeredBy: null },
      { status: 'busy', disposition: null, answeredBy: null },
      { status: 'completed', disposition: 'voicemail', answeredBy: null },
      { status: 'completed', disposition: 'user_hangup_no_speech', answeredBy: null },
      { status: 'completed', disposition: null, answeredBy: 'machine' },
    ];

    for (const silence of silences) {
      const outcome = classifyOutcome({ ...silence, hangupCause: '16' });

      expect(outcome.retryable).toBe(true);
      expect(outcome.permanent).toBe(false);
      expect(reachedAPerson(outcome)).toBe(false);
    }
  });

  it('reads a failureReason as retryable with no carrier fields at all', () => {
    const outcome = classifyOutcome({
      status: null,
      disposition: null,
      answeredBy: null,
      failureReason: 'the platform did not answer',
    });

    expect(outcome.retryable).toBe(true);
    expect(outcome.permanent).toBe(false);
  });

  it('is callable without a hangup cause, and withholds permanent when it is', () => {
    // `hasSpokenAttempt` reads a stored log that never carried the column.
    const outcome = classifyOutcome({
      status: 'failed',
      disposition: 'failed',
      answeredBy: null,
    });

    expect(outcome.permanent).toBe(false);
    expect(reachedAPerson(outcome)).toBe(false);
  });
});

/**
 * The platform's own verdict, carried on `error_code`. A non-null code means
 * the platform ended the attempt before the carrier ever tested the number —
 * reaped pre-connect, never reached the carrier, dismissed by an operator, or
 * the platform's own telephony account was dry. None of that is the contact's
 * fault, so none of it may settle the contact or spend a rung of the ladder.
 */
describe('classifyOutcome — a platform error code is never the number', () => {
  it.each([
    'PENDING_TIMEOUT',
    'DIAL_TRANSPORT_FAILURE',
    'ADMIN_DISMISSED',
    'TELEPHONY_CREDIT_EXHAUSTED',
    'SOME_CODE_SHIPPED_NEXT_QUARTER',
  ])('reads %s as a platform fault: retryable, never permanent', (errorCode) => {
    const outcome = classifyOutcome({
      status: 'failed',
      disposition: 'failed',
      answeredBy: null,
      hangupCause: null,
      errorCode,
    });

    expect(outcome).toEqual({ retryable: true, permanent: false, platformFault: true });
  });

  it('outranks a cause that names the number, because the number was never tested', () => {
    const outcome = classifyOutcome({
      status: 'failed',
      disposition: 'failed',
      answeredBy: null,
      hangupCause: '1 - Unallocated (unassigned) number',
      errorCode: 'DIAL_TRANSPORT_FAILURE',
    });

    expect(outcome.permanent).toBe(false);
    expect(outcome.platformFault).toBe(true);
  });

  it('outranks a blocked disposition for the same reason', () => {
    const outcome = classifyOutcome({
      status: 'failed',
      disposition: 'blocked',
      answeredBy: null,
      errorCode: 'PENDING_TIMEOUT',
    });

    expect(outcome.permanent).toBe(false);
    expect(outcome.platformFault).toBe(true);
  });

  it('is not a platform fault when a person was actually reached', () => {
    // An operator dismissing a session that had already connected is a
    // conversation that ended oddly, not a number that was never tested.
    const outcome = classifyOutcome({
      status: 'completed',
      disposition: 'completed',
      answeredBy: 'human',
      errorCode: 'ADMIN_DISMISSED',
    });

    expect(outcome.platformFault).toBe(false);
    expect(reachedAPerson(outcome)).toBe(true);
  });

  it.each([null, undefined, '', '   '])('leaves the carrier verdict alone on %s', (errorCode) => {
    const outcome = classifyOutcome({
      status: 'failed',
      disposition: 'failed',
      answeredBy: null,
      hangupCause: '1',
      errorCode,
    });

    expect(outcome.platformFault).toBe(false);
    expect(outcome.permanent).toBe(true);
  });

  it('never counts a platform fault as having reached a person', () => {
    expect(
      reachedAPerson(
        classifyOutcome({ status: 'failed', disposition: null, answeredBy: null, errorCode: 'PENDING_TIMEOUT' }),
      ),
    ).toBe(false);
  });
});

describe('exhaustsPlatformCredit', () => {
  it('names the one code that is account-wide and never clears on its own', () => {
    expect(exhaustsPlatformCredit('TELEPHONY_CREDIT_EXHAUSTED')).toBe(true);
    expect(exhaustsPlatformCredit('PENDING_TIMEOUT')).toBe(false);
    expect(exhaustsPlatformCredit(null)).toBe(false);
    expect(exhaustsPlatformCredit(undefined)).toBe(false);
  });
});

/**
 * The platform has said cause 16 (normal clearing) will map to `no_answer`.
 * Almost four thousand calls a week carry cause 16 AND `answered_by: human`
 * with a minute and a half of talk: real conversations. Whatever the label
 * says, a call the platform's own answer detection heard a person on is a
 * call that connected, and redialling that person is the bug this whole
 * module exists to prevent.
 */
describe('classifyOutcome — a never-connected label loses to a human on the line', () => {
  it.each([
    ['no_answer', 'no_answer'],
    ['busy', 'busy'],
    ['failed', 'failed'],
  ])('treats status %s / disposition %s with answered_by human as a conversation', (status, disposition) => {
    const outcome = classifyOutcome({
      status,
      disposition,
      answeredBy: 'human',
      hangupCause: '16 - Normal Clearing',
    });

    expect(reachedAPerson(outcome)).toBe(true);
  });

  it('reads the detector case-insensitively, as every report classifier does', () => {
    // `hasSpokenAttempt` feeds this the goal log, and re-extraction writes
    // that log verbatim off the attempt row.
    const outcome = classifyOutcome({ status: 'no_answer', disposition: 'no_answer', answeredBy: ' Human ' });

    expect(reachedAPerson(outcome)).toBe(true);
  });

  it('still retries a pick-up in which nobody spoke', () => {
    const outcome = classifyOutcome({
      status: 'completed',
      disposition: 'user_hangup_no_speech',
      answeredBy: 'human',
    });

    expect(outcome.retryable).toBe(true);
  });

  it('still retries a voicemail whatever the machine detection says', () => {
    const outcome = classifyOutcome({
      status: 'completed',
      disposition: 'voicemail',
      answeredBy: 'machine',
    });

    expect(outcome.retryable).toBe(true);
  });
});

/**
 * The supplier's own wallet running dry, reported as free text.
 *
 * On 2026-09-07 the telephony provider began refusing every dial with
 * `VoiceLink add_lead error (402): {"message":"Insufficient wallet balance…"}`.
 * The platform surfaced that as `error_message` with **`error_code: null`** —
 * 2,593 attempts across 1,407 contacts, and not one carried a code.
 *
 * `exhaustsPlatformCredit` keyed only on the code, so none of it was read as a
 * platform fault: each refusal settled as an ordinary `failed`, spent a retry
 * the number never deserved, and the campaigns went on dialing into a dead
 * wallet. The number was never tested, so the contact must come back whole and
 * the campaign must stop — exactly what `TELEPHONY_CREDIT_EXHAUSTED` already
 * does when the code is present.
 */
describe('a supplier wallet reported only in the message', () => {
  const MESSAGE =
    'VoiceLink add_lead error (402): {"status":false,"message":"Insufficient wallet balance. Please top-up to continue."}';

  it('reads it as the platform running dry', () => {
    expect(exhaustsPlatformCredit(null, MESSAGE)).toBe(true);
  });

  it('still reads the code when the platform sends one', () => {
    expect(exhaustsPlatformCredit('TELEPHONY_CREDIT_EXHAUSTED', null)).toBe(true);
  });

  it('classifies the attempt as a platform fault, so the contact is handed back', () => {
    expect(
      classifyOutcome({
        status: 'failed',
        disposition: 'failed',
        answeredBy: null,
        errorCode: null,
        errorMessage: MESSAGE,
      }),
    ).toEqual({ retryable: true, permanent: false, platformFault: true });
  });

  /**
   * The narrow reading is the point. This pauses a customer's campaign, so it
   * must not fire on an ordinary carrier failure — a 402 from the supplier and
   * a number that does not answer are opposite facts.
   */
  it('does not fire on an unrelated failure message', () => {
    expect(exhaustsPlatformCredit(null, 'The operation was aborted due to timeout')).toBe(false);
    expect(exhaustsPlatformCredit(null, 'VoiceLink add_lead error (401): {"message":"Unauthenticated."}')).toBe(false);
    expect(exhaustsPlatformCredit(null, null)).toBe(false);
  });

  /** A person who spoke is a connection whatever the platform says afterwards —
   *  the rule the error-code branch already holds. */
  it('does not hand back a call somebody actually answered', () => {
    expect(
      classifyOutcome({
        status: 'completed',
        disposition: 'completed',
        answeredBy: 'human',
        errorCode: null,
        errorMessage: MESSAGE,
      }).platformFault,
    ).toBe(false);
  });
});

/**
 * The platform's `end_call_reason`, read beside the Q.850 cause it replaces.
 * Two readings only: a verdict on the number settles a silence permanently,
 * and a SYSTEM_ERROR nobody was heard on is a platform fault. Everything else
 * in the vocabulary restates the disposition, which stays the retry driver.
 */
describe('end_call_reason', () => {
  const silence = (endCallReason: string | null) => ({
    status: 'no_answer',
    disposition: 'no_answer',
    answeredBy: null,
    hangupCause: '16 - Normal Clearing',
    endCallReason,
  });

  it.each(['INVALID_NUMBER', 'BLOCKED', 'invalid_number'])(
    'settles a silence the platform blames on the number (%s) permanently',
    (r) => expect(classifyOutcome(silence(r)).permanent).toBe(true),
  );

  // Every value the platform documents that is neither a number verdict nor
  // SYSTEM_ERROR, plus absent: the reason is an allow-list, and an unlisted
  // value restates the disposition rather than overriding it.
  it.each([
    'NO_ANSWER',
    'BUSY',
    'REJECTED',
    'NETWORK_ERROR',
    'NOT_CONNECTED',
    'CANCELED',
    'UNKNOWN',
    'COMPLETED',
    'CUSTOMER_HUNG_UP',
    'TRANSFERRED',
    'VOICEMAIL',
    'SCREENER',
    null,
  ])(
    'keeps a %s silence on the ladder',
    (r) => {
      const c = classifyOutcome(silence(r));
      expect(c.retryable).toBe(true);
      expect(c.permanent).toBe(false);
      expect(c.platformFault).toBe(false);
    },
  );

  it('hands back a SYSTEM_ERROR nobody was heard on at no cost', () => {
    expect(classifyOutcome(silence('SYSTEM_ERROR'))).toEqual({
      retryable: true,
      permanent: false,
      platformFault: true,
    });
  });

  it.each(['SYSTEM_ERROR', 'INVALID_NUMBER'])('a person heard beats %s', (r) => {
    const c = classifyOutcome({ ...silence(r), status: 'completed', disposition: 'completed', answeredBy: 'human' });
    expect(c).toEqual({ retryable: false, permanent: false, platformFault: false });
  });

  it('a voicemail with a human detected and a number verdict is still a silence, and still retired', () => {
    // The ladder treats voicemail and user_hangup_no_speech as silences even
    // when the detector says human (the detector disagreeing with itself),
    // so the `retryable` gate is open and the number verdict lands. That is
    // intended: nobody was spoken to, and the carrier says the line is bad.
    const c = classifyOutcome({ ...silence('BLOCKED'), status: 'completed', disposition: 'voicemail', answeredBy: 'human' });
    expect(c.retryable).toBe(true);
    expect(c.permanent).toBe(true);
  });

  it('hands back a SYSTEM_ERROR on a completed label nobody was detected on', () => {
    // The guard is the detector's verdict, not the disposition. A `completed`
    // label with `answered_by` null is a call the platform says ended
    // normally but cannot say anybody was on; erring toward handing it back
    // is the cheap mistake (one redial), and settling it is the dear one
    // (a lead burned on the platform's own restart).
    const c = classifyOutcome({ status: 'completed', disposition: 'completed', answeredBy: null, endCallReason: 'SYSTEM_ERROR' });
    expect(c.platformFault).toBe(true);
  });

  it.each([
    ['a blocked disposition', { ...silence('SYSTEM_ERROR'), disposition: 'blocked' }],
    ['an unallocated Q.850 cause', { ...silence('SYSTEM_ERROR'), hangupCause: '1 - Unallocated (unassigned) number' }],
  ])('SYSTEM_ERROR outranks %s, because the number was never tested', (_label, outcome) => {
    const c = classifyOutcome(outcome);
    expect(c.platformFault).toBe(true);
    expect(c.permanent).toBe(false);
  });

  /**
   * The answer stamp outranks a null detector: voicelink writes
   * `answered_by: human` only on a normal bot completion, so the very
   * teardown that produces SYSTEM_ERROR leaves it null on an answered call.
   */
  it('a SYSTEM_ERROR on an ANSWERED call is that conversation, not a free redial', () => {
    const c = classifyOutcome({ status: 'failed', disposition: 'failed', answeredBy: null, endCallReason: 'SYSTEM_ERROR', answeredAt: new Date() });
    expect(c.platformFault).toBe(false);
  });

  it('an error_code on an answered call is a conversation for the same reason', () => {
    const c = classifyOutcome({ status: 'failed', disposition: 'failed', answeredBy: null, errorCode: 'ADMIN_DISMISSED', answeredAt: '2026-09-15T10:00:00.000Z' });
    expect(c.platformFault).toBe(false);
  });

  it('never makes a conversation permanent off a stray reason', () => {
    const c = classifyOutcome({ status: 'completed', disposition: 'completed', answeredBy: null, endCallReason: 'BLOCKED' });
    expect(c.permanent).toBe(false);
  });
});
