import { describe, expect, it } from 'vitest';
import {
  OUTCOMES,
  classifyAttempt,
  classifyOutcome,
  isConnected,
  isUnresolved,
  type CallOutcome,
} from '../src/lib/callOutcome.js';

describe('classifyOutcome', () => {
  it('maps every documented disposition to its bucket', () => {
    const cases: Array<[string, CallOutcome]> = [
      ['completed', 'answered'],
      ['transferred', 'answered'],
      ['user_hangup_no_speech', 'answered'],
      ['voicemail', 'voicemail'],
      ['no_answer', 'no_answer'],
      ['busy', 'busy'],
      ['failed', 'failed'],
      ['blocked', 'failed'],
      ['canceled', 'failed'],
    ];

    for (const [disposition, outcome] of cases) {
      expect(classifyOutcome(disposition, null)).toBe(outcome);
    }
  });

  it('matches case-insensitively and ignores surrounding space', () => {
    expect(classifyOutcome('  Voicemail ', null)).toBe('voicemail');
    expect(classifyOutcome('NO_ANSWER', null)).toBe('no_answer');
  });

  it('falls back to status when there is no disposition', () => {
    expect(classifyOutcome(null, 'no_answer')).toBe('no_answer');
    expect(classifyOutcome('', 'busy')).toBe('busy');
  });

  it('prefers the disposition when both are present', () => {
    // A voicemail's status is `completed` — the disposition is the finer fact,
    // and reading the status here would report every voicemail as answered.
    expect(classifyOutcome('voicemail', 'completed')).toBe('voicemail');
  });

  it('treats an in-flight status as answered', () => {
    expect(classifyOutcome(null, 'in_progress')).toBe('answered');
  });

  it('gives an abandoned attempt its own bucket, not `failed`', () => {
    // The dialer's reaper closes an attempt whose outcome was never learned.
    // "We never found out" and "the callee did not answer" are different facts,
    // and a report that conflates them misstates the campaign's own results.
    expect(classifyOutcome(null, 'abandoned')).toBe('abandoned');
    expect(classifyOutcome(null, 'ABANDONED')).toBe('abandoned');
  });

  it('is `other` when both are absent', () => {
    expect(classifyOutcome(null, null)).toBe('other');
  });

  it('puts an unrecognised value in `other`, never in `failed`', () => {
    // The published sets grow without this service deploying. Folding an
    // unknown value into `failed` would report a carrier's new outcome as a
    // failure; dropping it would shrink the denominator of every rate.
    expect(classifyOutcome('carrier_congestion', null)).toBe('other');
    expect(classifyOutcome(null, 'something_new')).toBe('other');
  });
});

describe('isConnected', () => {
  it('counts answered and voicemail — the call reached the far end', () => {
    expect(isConnected('answered')).toBe(true);
    expect(isConnected('voicemail')).toBe(true);
  });

  it('counts nothing else, including `other`', () => {
    // An unclassifiable outcome is not evidence of a connection.
    for (const outcome of ['no_answer', 'busy', 'failed', 'abandoned', 'other'] as CallOutcome[]) {
      expect(isConnected(outcome)).toBe(false);
    }
  });
});

describe('OUTCOMES', () => {
  it('lists every bucket exactly once, in reporting order', () => {
    expect(OUTCOMES).toEqual([
      'answered',
      'voicemail',
      'no_answer',
      'busy',
      'failed',
      'abandoned',
      'other',
    ]);
    expect(new Set(OUTCOMES).size).toBe(OUTCOMES.length);
  });

  it('covers everything classifyOutcome can return', () => {
    const samples = ['completed', 'voicemail', 'no_answer', 'busy', 'failed', 'zzz', null];
    for (const sample of samples) {
      expect(OUTCOMES).toContain(classifyOutcome(sample, null));
    }
  });
});

describe('classifyAttempt', () => {
  it('lets the reaper\'s verdict outrank a stale carrier value', () => {
    // ABANDONED is written over whatever the carrier last said, typically a
    // stale `ringing`. Reading the carrier field would report a call we know
    // nothing about as one we do.
    expect(classifyAttempt(null, 'ringing', 'ABANDONED')).toBe('abandoned');
  });

  it('otherwise prefers the carrier fields, which describe the call', () => {
    expect(classifyAttempt('voicemail', 'completed', 'COMPLETED')).toBe('voicemail');
    expect(classifyAttempt(null, 'no_answer', 'FAILED')).toBe('no_answer');
  });

  it('falls back to our own status when the carrier said nothing', () => {
    expect(classifyAttempt(null, null, 'COMPLETED')).toBe('answered');
    expect(classifyAttempt(null, null, 'FAILED')).toBe('failed');
    // Still in flight is not an outcome.
    expect(classifyAttempt(null, null, 'QUEUED')).toBe('other');
  });
});

/**
 * The platform has said Q.850 cause 16 — normal clearing, how a real
 * conversation usually ends — will map to `no_answer`. Answer detection heard
 * a person on those calls; the label is about the ending, the detector is
 * about the connection, and the detector wins.
 */
describe('classifyAttempt — a human on the line beats a never-connected label', () => {
  it.each([
    ['no_answer', 'no_answer'],
    ['busy', 'busy'],
    ['failed', 'failed'],
    [null, 'no_answer'],
  ])('files disposition %s / status %s with answered_by human as answered', (disposition, status) => {
    expect(classifyAttempt(disposition, status, 'FAILED', 'human')).toBe('answered');
    expect(classifyAttempt(disposition, status, 'FAILED', ' Human ')).toBe('answered');
  });

  it('leaves a voicemail a voicemail, whatever the detector said', () => {
    expect(classifyAttempt('voicemail', 'completed', 'COMPLETED', 'machine')).toBe('voicemail');
    expect(classifyAttempt('voicemail', 'completed', 'COMPLETED', 'human')).toBe('voicemail');
  });

  it('does not let the detector overturn a number the carrier refused', () => {
    // `blocked` collapses to `failed` for the breakdown, but it is a verdict on
    // the number, not on the ending; the dialer settles it permanent whatever
    // the detector said, and the report must not call it a conversation.
    expect(classifyAttempt('blocked', 'failed', 'FAILED', 'human')).toBe('failed');
    expect(classifyAttempt('canceled', 'failed', 'FAILED', 'human')).toBe('failed');
  });

  it('changes nothing for any other answered_by', () => {
    expect(classifyAttempt('no_answer', 'no_answer', 'FAILED', 'not_answered')).toBe('no_answer');
    expect(classifyAttempt('busy', 'busy', 'FAILED', null)).toBe('busy');
    expect(classifyAttempt('failed', 'failed', 'FAILED', undefined)).toBe('failed');
  });

  it('still lets the reaper outrank everything', () => {
    expect(classifyAttempt('no_answer', 'ringing', 'ABANDONED', 'human')).toBe('abandoned');
  });
});

describe('isUnresolved', () => {
  it('names the outcomes that are about our knowledge, not about the call', () => {
    expect(isUnresolved('abandoned')).toBe(true);
    expect(isUnresolved('other')).toBe(true);
    expect(isUnresolved('no_answer')).toBe(false);
    expect(isUnresolved('answered')).toBe(false);
  });
});
