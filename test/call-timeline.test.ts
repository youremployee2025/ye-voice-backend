import { describe, expect, it } from 'vitest';
import { buildBilling, buildTimeline, type TimelineAttempt } from '../src/lib/callTimeline.js';

const at = (iso: string) => new Date(iso);

const SETTLED: TimelineAttempt = {
  attemptNo: 1,
  status: 'COMPLETED',
  upstreamStatus: 'completed',
  disposition: 'interested',
  hangupCause: 'NORMAL_CLEARING',
  endCallReason: null,
  startedAt: at('2026-08-20T10:00:00.000Z'),
  answeredAt: at('2026-08-20T10:00:06.000Z'),
  endedAt: at('2026-08-20T10:00:44.000Z'),
  resolvedAt: at('2026-08-20T10:00:45.000Z'),
  chargedAt: at('2026-08-20T10:00:46.000Z'),
  durationSecs: 38,
  billedSecs: 60,
  costCredits: 15000n,
  shortfall: false,
};

describe('buildTimeline', () => {
  it('emits every stamped event, oldest first', () => {
    expect(buildTimeline(SETTLED).map((event) => event.kind)).toEqual([
      'dialed',
      'answered',
      'ended',
      'resolved',
      'charged',
    ]);
  });

  it('stamps each event with the instant it actually happened', () => {
    const timeline = buildTimeline(SETTLED);

    expect(timeline[0]).toMatchObject({ kind: 'dialed', at: '2026-08-20T10:00:00.000Z' });
    expect(timeline[4]).toMatchObject({ kind: 'charged', at: '2026-08-20T10:00:46.000Z' });
  });

  it('is sorted by instant even when the stamps disagree with the field order', () => {
    // A reconciled attempt can be charged before its outcome is applied. The
    // order on the wire is chronological, never the order this file lists them.
    const timeline = buildTimeline({
      ...SETTLED,
      resolvedAt: at('2026-08-20T10:05:00.000Z'),
      chargedAt: at('2026-08-20T10:00:46.000Z'),
    });

    expect(timeline.map((event) => event.kind)).toEqual([
      'dialed',
      'answered',
      'ended',
      'charged',
      'resolved',
    ]);
  });

  it('omits an event whose stamp is null rather than dating it to the epoch', () => {
    // A live dial: never answered, never resolved, never charged. Those are
    // things that have not happened, not things that happened in 1970.
    const timeline = buildTimeline({
      ...SETTLED,
      answeredAt: null,
      endedAt: null,
      resolvedAt: null,
      chargedAt: null,
    });

    expect(timeline.map((event) => event.kind)).toEqual(['dialed']);
  });

  it('carries the hangup cause on the end, and the disposition on the resolution', () => {
    const timeline = buildTimeline(SETTLED);

    expect(timeline.find((event) => event.kind === 'ended')?.detail).toBe('NORMAL_CLEARING');
    expect(timeline.find((event) => event.kind === 'resolved')?.detail).toBe('interested');
  });

  it('says a charge was owed and not taken, never reporting a shortfall as a payment', () => {
    const timeline = buildTimeline({ ...SETTLED, shortfall: true });

    expect(timeline.find((event) => event.kind === 'charged')?.detail).toBe('shortfall');
  });

  it("carries the platform's end reason on the ended event, in words", () => {
    // The dashboard's timeline prints `detail` verbatim, so the token must
    // never be the detail: the label is, and the token stays on the row.
    const timeline = buildTimeline({ ...SETTLED, endCallReason: 'CUSTOMER_HUNG_UP' });

    expect(timeline.find((event) => event.kind === 'ended')?.detail).toBe('The customer hung up');
    expect(JSON.stringify(timeline)).not.toContain('CUSTOMER_HUNG_UP');
  });

  it('falls back to the raw cause for a reason it has no words for', () => {
    const timeline = buildTimeline({ ...SETTLED, endCallReason: 'SOMETHING_NEW' });

    expect(timeline.find((event) => event.kind === 'ended')?.detail).toBe('NORMAL_CLEARING');
  });

  it('falls back to the raw hangup cause for a row settled before the reason existed', () => {
    const timeline = buildTimeline({ ...SETTLED, endCallReason: null });

    expect(timeline.find((event) => event.kind === 'ended')?.detail).toBe('NORMAL_CLEARING');
  });

  it('leaves detail null when the field it would carry is unset', () => {
    const timeline = buildTimeline({
      ...SETTLED,
      hangupCause: null,
      endCallReason: null,
      disposition: null,
    });

    expect(timeline.find((event) => event.kind === 'ended')?.detail).toBeNull();
    expect(timeline.find((event) => event.kind === 'resolved')?.detail).toBeNull();
  });

  it('has no events at all for a call this platform holds no attempt for', () => {
    expect(buildTimeline(null)).toEqual([]);
  });
});

describe('buildBilling', () => {
  it('renders the charge in display units', () => {
    expect(buildBilling(SETTLED)).toMatchObject({ creditsCharged: '1.5' });
  });

  it('carries the billed seconds and the shortfall flag', () => {
    expect(buildBilling(SETTLED)).toMatchObject({ billedSeconds: 60, shortfall: false });
    expect(buildBilling({ ...SETTLED, shortfall: true })).toMatchObject({ shortfall: true });
  });

  it('reports an unrecorded billed duration as null, never as zero or as the duration', () => {
    // Null on every attempt settled before pulse billing existed. Zero would
    // assert a call that billed nothing; the duration would be a guess that is
    // right often enough to be trusted when it is wrong.
    expect(buildBilling({ ...SETTLED, billedSecs: null })).toMatchObject({
      billedSeconds: null,
    });
  });

  it('reports an uncharged attempt as null credits, never as zero', () => {
    expect(buildBilling({ ...SETTLED, costCredits: null })).toMatchObject({
      creditsCharged: null,
    });
  });

  it('is null for a call with no attempt, rather than a zeroed block', () => {
    // A zeroed block asserts this workspace was charged nothing. An inbound or
    // hand-placed call is not charged to the workspace at all, which is a
    // different fact and the only one we can support.
    expect(buildBilling(null)).toBeNull();
  });
});
