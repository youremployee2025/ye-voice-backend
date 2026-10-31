import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Recovering the session facts for calls that settled before the columns
 * existed.
 *
 * Unlike the hangup-source walk, this one reads the DETAIL — the listing
 * carries no transcript, no variables and no recording — so it is one upstream
 * request per call rather than one per hundred. That cost is the whole reason
 * this is an operator script with a budget and a resume rather than a
 * background job.
 */
const { getCallMock } = vi.hoisted(() => ({ getCallMock: vi.fn() }));

vi.mock('../src/adapter/vocobase.js', () => ({ getCall: getCallMock }));

import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { backfillInboundSessionFacts, backfillSessionFacts } from '../src/services/sessionBackfill.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';

let seq = 0;

async function seed() {
  const account = await makeAccount(`sess-backfill-${(seq += 1)}`);
  const workspace = await makeWorkspace(account, 'Backfill');
  const campaign = await prisma.campaign.create({
    data: { workspaceId: workspace.id, name: 'Touchbase', status: 'COMPLETED' },
  });

  return { account, workspace, campaign };
}

async function attempt(
  ctx: Awaited<ReturnType<typeof seed>>,
  fields: Record<string, unknown> = {},
) {
  seq += 1;

  return prisma.callAttempt.create({
    data: {
      campaignId: ctx.campaign.id,
      workspaceId: ctx.workspace.id,
      accountId: ctx.account.id,
      attemptNo: seq,
      upstreamCallId: `c_${seq}`,
      status: 'COMPLETED',
      resolvedAt: new Date(),
      ...fields,
    } as never,
  });
}

/** One call detail, in the shape `GET /calls/:id` actually returns. */
const detail = (session: Record<string, unknown> | null, call: Record<string, unknown> = {}) => ({
  call_id: 'c',
  ...call,
  // Finished unless a case says otherwise: an unfinished call is deliberately
  // not captured, so every other case here has to be past that point.
  ...(session === null ? {} : { session: { processing_complete: true, ...session } }),
});

beforeEach(async () => {
  await truncateAll();
  getCallMock.mockReset();
});

describe('backfillSessionFacts', () => {
  it('recovers the conversation, the variables, the recording flag and the billed duration', async () => {
    const ctx = await seed();
    const row = await attempt(ctx);

    getCallMock.mockResolvedValue(
      detail(
        {
          transcript: [{ role: 'user', content: 'Yes, speaking.' }],
          variables: { tb_business_name: 'Petal Palace' },
          recording_url: 'https://storage.test/r.mp3?sig=x',
        },
        { bill_duration_seconds: 60 },
      ),
    );

    const result = await backfillSessionFacts({ campaignId: ctx.campaign.id });

    expect(result.filled).toBe(1);

    const after = await prisma.callAttempt.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.transcript).toEqual([{ role: 'user', content: 'Yes, speaking.', timestamp: null }]);
    expect(after.variables).toEqual({ tb_business_name: 'Petal Palace' });
    expect(after.recordingAvailable).toBe(true);
    expect(after.billDurationSeconds).toBe(60);
  });

  /** The presigned URL is a bearer credential for a customer's audio that
   *  outlives any membership check. Only the flag is kept. */
  it('never stores the recording url', async () => {
    const ctx = await seed();
    const row = await attempt(ctx);
    getCallMock.mockResolvedValue(detail({ recording_url: 'https://storage.test/r.mp3?sig=secret' }));

    await backfillSessionFacts({ campaignId: ctx.campaign.id });

    const after = await prisma.callAttempt.findUniqueOrThrow({ where: { id: row.id } });
    expect(
      JSON.stringify(after, (_k, v) => (typeof v === 'bigint' ? String(v) : v)),
    ).not.toContain('sig=secret');
  });

  /**
   * Safe to re-run, which for a walk costing one request per call is the
   * property that matters most: a run stopped halfway must not start over.
   */
  it('skips an attempt that already has its facts, without spending a request', async () => {
    const ctx = await seed();
    await attempt(ctx, {
      transcript: [{ role: 'user', content: 'Hi', timestamp: null }],
      recordingAvailable: true,
    });

    const result = await backfillSessionFacts({ campaignId: ctx.campaign.id });

    expect(getCallMock).not.toHaveBeenCalled();
    expect(result.filled).toBe(0);
  });

  /**
   * **`recordingAvailable` is the "already looked" marker, not `transcript`.**
   *
   * A call that never connected legitimately stores a null conversation, so
   * keyed on the transcript every silent dial in the campaign would be
   * re-fetched on every run, for ever — which on a campaign that is mostly
   * no-answers is nearly the whole walk. The boolean is written on every
   * successful recovery whatever the conversation turned out to be, so it is
   * the one column that means this row has been looked at.
   */
  it('does not re-fetch a silent call it has already recovered', async () => {
    const ctx = await seed();
    await attempt(ctx, { transcript: Prisma.DbNull, recordingAvailable: false });

    await backfillSessionFacts({ campaignId: ctx.campaign.id });

    expect(getCallMock).not.toHaveBeenCalled();
  });

  /** A dial that never reached the platform has no session to recover, and
   *  must not cost a request to discover that. */
  it('skips an attempt that never got an upstream call id', async () => {
    const ctx = await seed();
    await attempt(ctx, { upstreamCallId: null, launchError: 'refused' });

    await backfillSessionFacts({ campaignId: ctx.campaign.id });

    expect(getCallMock).not.toHaveBeenCalled();
  });

  /**
   * A call the platform no longer has is a fact, not a failure: transcripts
   * may be pruned upstream, and a run that stopped on the first pruned call
   * would never reach the ones still there.
   */
  it('counts a call upstream no longer knows about, and keeps going', async () => {
    const ctx = await seed();
    await attempt(ctx);
    await attempt(ctx);

    getCallMock.mockResolvedValueOnce(null).mockResolvedValueOnce(detail({ transcript: [] }));

    const result = await backfillSessionFacts({ campaignId: ctx.campaign.id });

    expect(result.gone).toBe(1);
    expect(result.filled).toBe(1);
  });

  /**
   * **A call still being processed is left alone, not recorded as empty.**
   *
   * The transcript and the recording arrive AFTER the call ends — that is what
   * `processing_complete` is for, and `serialize.ts` renders it so a surface
   * can say "still processing" rather than "none". Captured mid-processing,
   * a call yields a null transcript and no recording url, and writing those
   * would be bad twice over: the row would claim a call has no conversation
   * and no audio when it has both, and because `recordingAvailable` is the
   * "already looked" marker it would never be revisited to find out.
   *
   * The campaign this runs against is usually still RUNNING, so this is the
   * ordinary case at the head of the walk rather than an edge one.
   */
  it('leaves a call whose post-call processing has not finished', async () => {
    const ctx = await seed();
    const row = await attempt(ctx);

    getCallMock.mockResolvedValue(
      detail({ processing_complete: false, transcript: null, recording_url: null }),
    );

    const result = await backfillSessionFacts({ campaignId: ctx.campaign.id });

    expect(result.pending).toBe(1);
    expect(result.filled).toBe(0);

    // Untouched, so a later run picks it up rather than skipping it for ever.
    const after = await prisma.callAttempt.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.recordingAvailable).toBeNull();
    expect(after.transcript).toBeNull();
  });

  /** A finished call with genuinely no audio is a real answer and IS stored —
   *  `false` here means we looked and there is none, which is what stops the
   *  next run paying to look again. */
  it('records a finished call that simply has no recording', async () => {
    const ctx = await seed();
    const row = await attempt(ctx);

    getCallMock.mockResolvedValue(detail({ processing_complete: true, transcript: [], recording_url: null }));

    expect((await backfillSessionFacts({ campaignId: ctx.campaign.id })).filled).toBe(1);
    expect((await prisma.callAttempt.findUniqueOrThrow({ where: { id: row.id } })).recordingAvailable).toBe(false);
  });

  /** The walk is bounded, because it spends a rate limit every customer on the
   *  platform shares and the caller is a person running a script. */
  it('stops at the budget and says it was truncated', async () => {
    const ctx = await seed();
    await attempt(ctx);
    await attempt(ctx);
    await attempt(ctx);
    getCallMock.mockResolvedValue(detail({ transcript: [] }));

    const result = await backfillSessionFacts({ campaignId: ctx.campaign.id, maxCalls: 2 });

    expect(getCallMock).toHaveBeenCalledTimes(2);
    expect(result.truncated).toBe(true);
  });

  /** One campaign at a time. A walk this expensive must never be pointed at
   *  the whole platform by leaving an argument out. */
  it('refuses to run without a campaign', async () => {
    await expect(backfillSessionFacts({ campaignId: '' })).rejects.toThrow(/campaign/i);
  });
});

/**
 * The same walk over the inbound table, keyed on `upstreamPhoneCallId` — the
 * platform's own call id, learned at completion — since the policy's provider
 * id is not one `GET /calls/:id` accepts.
 */
describe('backfillInboundSessionFacts', () => {
  async function inboundCall(ctx: Awaited<ReturnType<typeof seed>>, fields: Record<string, unknown> = {}) {
    const did = await prisma.phoneNumber.create({
      data: { did: `+9180${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, workspaceId: ctx.workspace.id, status: 'ASSIGNED' },
    });

    return prisma.campaignInboundCall.create({
      data: {
        campaignId: ctx.campaign.id,
        workspaceId: ctx.workspace.id,
        phoneNumberId: did.id,
        fromNumber: '+919876543210',
        upstreamPhoneCallId: `pc_${Math.random().toString(36).slice(2)}`,
        ...fields,
      } as never,
    });
  }

  it('recovers the conversation and the recording flag, by the platform call id', async () => {
    const ctx = await seed();
    const row = await inboundCall(ctx);

    getCallMock.mockResolvedValue(
      detail({ transcript: [{ role: 'user', content: 'Billing question.' }], recording_url: 'https://storage.test/r.mp3' }),
    );

    const result = await backfillInboundSessionFacts({ campaignId: ctx.campaign.id });

    expect(result.filled).toBe(1);
    expect(getCallMock).toHaveBeenCalledWith(row.upstreamPhoneCallId);

    const after = await prisma.campaignInboundCall.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.transcript).toEqual([{ role: 'user', content: 'Billing question.', timestamp: null }]);
    expect(after.recordingAvailable).toBe(true);
    expect(JSON.stringify(after)).not.toContain('storage.test');
  });

  it('skips rows already looked at, rows with no platform id, and leaves unprocessed calls alone', async () => {
    const ctx = await seed();
    await inboundCall(ctx, { recordingAvailable: false });
    await inboundCall(ctx, { upstreamPhoneCallId: null });
    const waiting = await inboundCall(ctx);

    getCallMock.mockResolvedValue(detail({ transcript: null, processing_complete: false }));

    const result = await backfillInboundSessionFacts({ campaignId: ctx.campaign.id });

    expect(result.candidates).toBe(1);
    expect(result.fetched).toBe(1);
    expect(result.pending).toBe(1);
    expect((await prisma.campaignInboundCall.findUniqueOrThrow({ where: { id: waiting.id } })).recordingAvailable).toBeNull();
  });

  it('counts a call the platform no longer has and keeps going', async () => {
    const ctx = await seed();
    await inboundCall(ctx);
    await inboundCall(ctx);

    getCallMock.mockResolvedValueOnce(null).mockResolvedValueOnce(detail({ transcript: [] }));

    const result = await backfillInboundSessionFacts({ campaignId: ctx.campaign.id });

    expect(result.gone).toBe(1);
    expect(result.filled).toBe(1);
  });
});
