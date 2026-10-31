import { describe, expect, it } from 'vitest';
import type { CallAttempt } from '@prisma/client';
import {
  normalizeTranscript,
  serializeCallAttempt,
  serializeCallDetail,
  serializeCallSummary,
} from '../src/lib/serialize.js';
import type { TimelineAttempt } from '../src/lib/callTimeline.js';

const ATTEMPT: TimelineAttempt = {
  attemptNo: 2,
  status: 'COMPLETED',
  upstreamStatus: 'completed',
  disposition: 'interested',
  hangupCause: 'NORMAL_CLEARING',
  endCallReason: null,
  startedAt: new Date('2026-08-20T10:00:00.000Z'),
  answeredAt: new Date('2026-08-20T10:00:06.000Z'),
  endedAt: new Date('2026-08-20T10:00:44.000Z'),
  resolvedAt: new Date('2026-08-20T10:00:45.000Z'),
  chargedAt: new Date('2026-08-20T10:00:46.000Z'),
  durationSecs: 38,
  billedSecs: 60,
  costCredits: 15000n,
  shortfall: false,
};

const AGENT = { id: 'agt_local', name: 'Support Bot' };
const CAMPAIGN = { id: 'cmp_local', name: 'August outreach' };

const LIST_ROW = {
  call_id: 'call-1',
  agent_id: 'upstream-agent-uuid',
  session_id: 'sess-1',
  client_reference_id: 'crm:someone-elses-automation:someone-elses-job',
  direction: 'outbound',
  from_number: '+919876543200',
  to_number: '+919876543210',
  status: 'completed',
  disposition: 'voicemail',
  answered_by: 'machine',
  hangup_cause: 'NORMAL_CLEARING',
  hangup_source: 'callee',
  bill_duration_seconds: 42,
  provider: 'mcube',
  connection_id: 'conn-uuid',
  duration_seconds: 38,
  error_message: null,
  started_at: '2026-08-20T10:00:00.000Z',
  ended_at: '2026-08-20T10:00:38.000Z',
  created_at: '2026-08-20T09:59:59.000Z',
};

describe('serializeCallSummary', () => {
  it('projects the fields a list row needs', () => {
    const row = serializeCallSummary(LIST_ROW, { agent: AGENT, campaign: CAMPAIGN });

    expect(row).toMatchObject({
      id: 'call-1',
      direction: 'outbound',
      fromNumber: '+919876543200',
      toNumber: '+919876543210',
      status: 'completed',
      disposition: 'voicemail',
      answeredBy: 'machine',
      durationSeconds: 38,
      startedAt: '2026-08-20T10:00:00.000Z',
      endedAt: '2026-08-20T10:00:38.000Z',
      agent: AGENT,
      campaign: CAMPAIGN,
    });
  });

  it('emits a name or null, never a bare upstream agent id', () => {
    const row = serializeCallSummary(LIST_ROW, { agent: null, campaign: null });

    expect(row.agent).toBeNull();
    expect(row.campaign).toBeNull();
    expect(JSON.stringify(row)).not.toContain('upstream-agent-uuid');
  });

  it("never emits another integrator's correlation id", () => {
    // The partner account is shared. client_reference_id is where every caller
    // puts its own internal ids, so echoing it verbatim would hand one
    // customer a fragment of another's CRM.
    const row = serializeCallSummary(LIST_ROW, { agent: AGENT, campaign: null });

    expect(JSON.stringify(row)).not.toContain('someone-elses');
    expect(JSON.stringify(row)).not.toContain('client_reference_id');
  });

  it('never emits the upstream session id or the carrier behind the call', () => {
    const row = serializeCallSummary(LIST_ROW, { agent: AGENT, campaign: null });
    const json = JSON.stringify(row);

    expect(json).not.toContain('sess-1');
    expect(json).not.toContain('mcube');
    expect(json).not.toContain('conn-uuid');
  });

  it('reports an absent duration as null rather than zero', () => {
    // Zero seconds is a call that connected and said nothing. Unknown is not
    // that, and rendering it as that is a claim.
    const row = serializeCallSummary(
      { ...LIST_ROW, duration_seconds: null },
      { agent: null, campaign: null },
    );

    expect(row.durationSeconds).toBeNull();
  });

  it('survives a row missing every optional field', () => {
    const row = serializeCallSummary({ call_id: 'call-2' }, { agent: null, campaign: null });

    expect(row.id).toBe('call-2');
    expect(row.status).toBeNull();
    expect(row.disposition).toBeNull();
    expect(row.startedAt).toBeNull();
  });
});

describe('normalizeTranscript', () => {
  it('reads the documented array of turns', () => {
    const transcript = normalizeTranscript([
      { role: 'bot', content: 'Hello?', timestamp: '2026-08-20T10:00:01.000Z' },
      { role: 'user', content: 'Yes, speaking.', timestamp: '2026-08-20T10:00:04.000Z' },
    ]);

    expect(transcript).toEqual({
      kind: 'turns',
      turns: [
        { role: 'bot', content: 'Hello?', timestamp: '2026-08-20T10:00:01.000Z' },
        { role: 'user', content: 'Yes, speaking.', timestamp: '2026-08-20T10:00:04.000Z' },
      ],
    });
  });

  it('keeps a turn whose timestamp is missing', () => {
    const transcript = normalizeTranscript([{ role: 'bot', content: 'Hello?' }]);

    expect(transcript).toEqual({
      kind: 'turns',
      turns: [{ role: 'bot', content: 'Hello?', timestamp: null }],
    });
  });

  it('drops a turn with no content rather than rendering an empty bubble', () => {
    const transcript = normalizeTranscript([
      { role: 'bot', content: 'Hello?' },
      { role: 'user' },
    ]);

    expect(transcript).toEqual({
      kind: 'turns',
      turns: [{ role: 'bot', content: 'Hello?', timestamp: null }],
    });
  });

  it('reports the failure object real payloads send instead of a transcript', () => {
    // Observed on a call that never connected. This is the case that must
    // never reach the renderer looking like a conversation.
    const transcript = normalizeTranscript({
      error: 'MCube did not connect WebSocket within 60s',
      provider: 'mcube',
      terminal_reason: 'mcube_ws_connect_timeout',
      provider_call_id: '9876543200178768',
    });

    expect(transcript.kind).toBe('unavailable');
  });

  it('does not leak the carrier or its error text into the reason', () => {
    const transcript = normalizeTranscript({
      error: 'MCube did not connect WebSocket within 60s',
      provider: 'mcube',
      terminal_reason: 'mcube_ws_connect_timeout',
    });

    expect(JSON.stringify(transcript)).not.toMatch(/mcube/i);
    expect(JSON.stringify(transcript)).not.toContain('WebSocket');
  });

  it('marks a call that did not connect as such', () => {
    const transcript = normalizeTranscript({ terminal_reason: 'mcube_ws_connect_timeout' });

    expect(transcript).toEqual({ kind: 'unavailable', reason: 'not_connected' });
  });

  it('reports no reason when upstream gave none', () => {
    for (const value of [null, undefined, [], 'oops', 42, {}]) {
      expect(normalizeTranscript(value)).toEqual({ kind: 'unavailable', reason: null });
    }
  });
});

describe('serializeCallDetail', () => {
  const DETAIL = {
    ...LIST_ROW,
    session: {
      session_id: 'sess-1',
      duration_seconds: 38,
      credits_used: 1.5,
      transcript: [{ role: 'bot', content: 'Hello?', timestamp: '2026-08-20T10:00:01.000Z' }],
      recording_url: 'https://storage.test/signed.wav?sig=secret',
      variables: { brand_name: 'University Of Mumbai' },
      extraction: { status: 'success', values: { interested: true } },
      processing_complete: true,
      started_at: '2026-08-20T10:00:00.000Z',
      ended_at: '2026-08-20T10:00:38.000Z',
    },
  };

  it('keeps the shape of an extraction that nests', () => {
    // Structure is meaningful here and flattening it would cost the reader the
    // shape of their own data. Bounding is about size, not about depth.
    const detail = serializeCallDetail(
      { call_id: 'call-1', session: { extraction: { status: 'ok', values: { interested: true } } } },
      { agent: null, campaign: null },
    );

    expect(detail.extraction).toEqual({ status: 'ok', values: { interested: true } });
  });

  it('carries the billing block and the timeline from the recorded attempt', () => {
    const detail = serializeCallDetail(DETAIL, { agent: AGENT, campaign: CAMPAIGN }, ATTEMPT);

    expect(detail.billing).toEqual({
      creditsCharged: '1.5',
      billedSeconds: 60,
      shortfall: false,
    });
    expect(detail.timelineSource).toBe('attempt');
    expect(detail.timeline.map((event) => event.kind)).toEqual([
      'dialed',
      'answered',
      'ended',
      'resolved',
      'charged',
    ]);
  });

  it('says the timeline was not recorded rather than sending an empty one silently', () => {
    // A call this platform did not dial for a campaign has no attempt row, so
    // it has no timeline. `none` is what lets the surface say that instead of
    // rendering an empty list, which reads as a rendering fault.
    const detail = serializeCallDetail(DETAIL, { agent: AGENT, campaign: null });

    expect(detail.timeline).toEqual([]);
    expect(detail.timelineSource).toBe('none');
    expect(detail.billing).toBeNull();
  });

  it('never emits the credits upstream billed this platform, even beside our own charge', () => {
    // `credits_used` is on the session and is the supplier's figure. Emitting
    // it beside `billing.creditsCharged` would publish the margin as a
    // subtraction anyone could do.
    const detail = serializeCallDetail(DETAIL, { agent: AGENT, campaign: CAMPAIGN }, ATTEMPT);

    expect(JSON.stringify(detail)).not.toContain('credits_used');
    expect(JSON.stringify(detail)).not.toContain('creditsUsed');
    expect(detail.billing?.creditsCharged).toBe('1.5');
  });

  it('bounds how much of an upstream blob reaches the browser', () => {
    // These two are the only fields projected wholesale rather than named, so
    // they are the only ones whose size upstream decides. A page that renders
    // a key/value list must not be handed an unbounded one.
    const detail = serializeCallDetail(
      {
        call_id: 'call-1',
        session: {
          variables: Object.fromEntries(
            Array.from({ length: 500 }, (_, i) => [`k${i}`, 'x'.repeat(50_000)]),
          ),
        },
      },
      { agent: null, campaign: null },
    );

    const keys = Object.keys(detail.variables);
    expect(keys.length).toBeLessThanOrEqual(100);
    for (const key of keys) {
      expect(String(detail.variables[key]).length).toBeLessThanOrEqual(4096);
    }
  });

  it('carries the transcript, variables and extraction', () => {
    const detail = serializeCallDetail(DETAIL, { agent: AGENT, campaign: CAMPAIGN });

    expect(detail.transcript).toEqual({
      kind: 'turns',
      turns: [{ role: 'bot', content: 'Hello?', timestamp: '2026-08-20T10:00:01.000Z' }],
    });
    expect(detail.variables).toEqual({ brand_name: 'University Of Mumbai' });
    expect(detail.extraction).toEqual({ status: 'success', values: { interested: true } });
  });

  it('reports that a recording exists without handing over its url', () => {
    const detail = serializeCallDetail(DETAIL, { agent: AGENT, campaign: null });

    expect(detail.recordingAvailable).toBe(true);
    expect(JSON.stringify(detail)).not.toContain('storage.test');
    expect(JSON.stringify(detail)).not.toContain('signed.wav');
    expect(JSON.stringify(detail)).not.toContain('recordingUrl');
  });

  it('never emits what the call cost upstream', () => {
    // credits_used is what this platform was billed, not what the workspace
    // pays. Putting it on a customer's screen publishes the margin.
    const detail = serializeCallDetail(DETAIL, { agent: AGENT, campaign: null });

    expect(JSON.stringify(detail)).not.toContain('credits');
    expect(JSON.stringify(detail)).not.toContain('1.5');
  });

  it('says a call with no session has no recording and no transcript', () => {
    const detail = serializeCallDetail(LIST_ROW, { agent: AGENT, campaign: null });

    expect(detail.recordingAvailable).toBe(false);
    expect(detail.transcript).toEqual({ kind: 'unavailable', reason: null });
    expect(detail.variables).toEqual({});
    expect(detail.extraction).toBeNull();
  });

  it('reports whether post-call processing has finished', () => {
    expect(serializeCallDetail(DETAIL, { agent: null, campaign: null }).processingComplete).toBe(
      true,
    );
    expect(serializeCallDetail(LIST_ROW, { agent: null, campaign: null }).processingComplete).toBe(
      false,
    );
  });

  it("explains a failed call with the platform's own message, not the carrier's", () => {
    const detail = serializeCallDetail(
      { ...LIST_ROW, status: 'failed', error_message: 'MCube rejected the leg' },
      { agent: null, campaign: null },
    );

    expect(detail.status).toBe('failed');
    expect(JSON.stringify(detail)).not.toMatch(/mcube/i);
  });

  /**
   * The platform's `end_call_reason`, live off the detail like the two
   * deprecated hangup fields, plus the sentence the screen prints. The words
   * are authored here and nowhere else: the dashboard shows the row only when
   * `endReason` is a string, so a token this service has no words for yet
   * travels raw and stays invisible.
   */
  describe('end_call_reason', () => {
    const withReason = (end_call_reason: string) =>
      serializeCallDetail({ ...DETAIL, end_call_reason }, { agent: AGENT, campaign: null });

    it('carries the token and its label', () => {
      const detail = withReason('CUSTOMER_HUNG_UP');

      expect(detail.endCallReason).toBe('CUSTOMER_HUNG_UP');
      expect(detail.endReason).toBe('The customer hung up');
    });

    it('is null on both when the platform sent none (a live call, or an old row)', () => {
      const detail = serializeCallDetail(DETAIL, { agent: AGENT, campaign: null });

      expect(detail.endCallReason).toBeNull();
      expect(detail.endReason).toBeNull();
    });

    it('passes an unknown value through raw with no words for it', () => {
      const detail = withReason('SOMETHING_NEW');

      expect(detail.endCallReason).toBe('SOMETHING_NEW');
      expect(detail.endReason).toBeNull();
    });

    it('normalises the token before labelling it', () => {
      const detail = withReason('customer_hung_up');

      expect(detail.endCallReason).toBe('CUSTOMER_HUNG_UP');
      expect(detail.endReason).toBe('The customer hung up');
    });
  });
});

describe('serializeCallAttempt', () => {
  const ROW = {
    id: 'att_1',
    attemptNo: 1,
    status: 'COMPLETED',
    disposition: 'interested',
    upstreamStatus: 'completed',
    answeredBy: 'human',
    hangupCause: 'NORMAL_CLEARING',
    endCallReason: null,
    startedAt: new Date('2026-08-20T10:00:00.000Z'),
    answeredAt: new Date('2026-08-20T10:00:06.000Z'),
    endedAt: new Date('2026-08-20T10:00:44.000Z'),
    durationSecs: 38,
    billedSecs: 60,
    billingIncrementSecs: 60,
    costCredits: 15000n,
    shortfall: false,
    launchError: null,
    errorCode: null,
    errorMessage: null,
    upstreamCallId: 'call-1',
  } as unknown as CallAttempt;

  const withReason = (endCallReason: string | null) =>
    serializeCallAttempt({ ...ROW, endCallReason });

  it('emits the end reason token and its label beside the raw hangup cause', () => {
    const row = withReason('CUSTOMER_HUNG_UP');

    expect(row.hangup_cause).toBe('NORMAL_CLEARING');
    expect(row.end_call_reason).toBe('CUSTOMER_HUNG_UP');
    expect(row.end_reason).toBe('The customer hung up');
  });

  it('is null on both for an attempt settled before the column existed', () => {
    const row = withReason(null);

    expect(row.end_call_reason).toBeNull();
    expect(row.end_reason).toBeNull();
  });

  it('passes an unknown value through raw with no words for it', () => {
    const row = withReason('SOMETHING_NEW');

    expect(row.end_call_reason).toBe('SOMETHING_NEW');
    expect(row.end_reason).toBeNull();
  });

  it('labels a lower-case token the same as its upper-case form', () => {
    expect(withReason('customer_hung_up').end_reason).toBe('The customer hung up');
  });
});
