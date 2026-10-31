import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Filling `CallAttempt.hangupSource` for dials that settled before the column
 * existed.
 *
 * The adapter is mocked, as everywhere in this suite: the partner account is
 * production and no test here may make a real network call.
 */
const { listCallsMock } = vi.hoisted(() => ({ listCallsMock: vi.fn() }));

vi.mock('../src/adapter/vocobase.js', () => ({ listCalls: listCallsMock }));

import { prisma } from '../src/lib/prisma.js';
import { backfillHangupSource } from '../src/services/hangupSourceBackfill.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';

let seq = 0;

async function attempt(fields: Record<string, unknown> = {}) {
  seq += 1;
  const account = await makeAccount(`backfill-${seq}`);
  const workspace = await makeWorkspace(account, 'Backfill');

  return prisma.callAttempt.create({
    data: {
      workspaceId: workspace.id,
      accountId: account.id,
      attemptNo: 1,
      upstreamCallId: `c_${seq}`,
      status: 'COMPLETED',
      ...fields,
    } as never,
  });
}

/** One page of the upstream listing. */
const page = (calls: Record<string, unknown>[]) => ({ calls });

beforeEach(async () => {
  await truncateAll();
  listCallsMock.mockReset();
});

describe('backfillHangupSource', () => {
  it('fills the column from the listing', async () => {
    const row = await attempt();
    listCallsMock.mockResolvedValueOnce(
      page([{ call_id: row.upstreamCallId, hangup_source: 'callee' }]),
    );

    const result = await backfillHangupSource({ pageSize: 100 });

    expect(result.filled).toBe(1);
    expect((await prisma.callAttempt.findUniqueOrThrow({ where: { id: row.id } })).hangupSource).toBe('callee');
  });

  /**
   * The webhook is the fresher source and it writes this column at settle
   * time. A backfill that overwrote it would churn every row on every re-run
   * and could put a stale listing value over a live one, so the walk fills
   * absences only — which is also what makes it safe to re-run.
   */
  it('never overwrites a source the webhook already recorded', async () => {
    const row = await attempt({ hangupSource: 'agent' });
    listCallsMock.mockResolvedValueOnce(
      page([{ call_id: row.upstreamCallId, hangup_source: 'callee' }]),
    );

    const result = await backfillHangupSource({ pageSize: 100 });

    expect(result.filled).toBe(0);
    expect((await prisma.callAttempt.findUniqueOrThrow({ where: { id: row.id } })).hangupSource).toBe('agent');
  });

  /**
   * The upstream pool is partner-wide, so most of what this walk reads belongs
   * to other integrators. A call matching no attempt of ours is skipped and
   * counted, never stored and never logged with its payload.
   */
  it('skips a call that matches no attempt of ours', async () => {
    listCallsMock.mockResolvedValueOnce(page([{ call_id: 'someone-elses', hangup_source: 'callee' }]));

    const result = await backfillHangupSource({ pageSize: 100 });

    expect(result.filled).toBe(0);
    expect(result.scanned).toBe(1);
  });

  /** A row upstream reports with no source leaves the column null. Writing an
   *  empty string would turn an absence into an attribution. */
  it('leaves the column null when the listing carries no source', async () => {
    const row = await attempt();
    listCallsMock.mockResolvedValueOnce(page([{ call_id: row.upstreamCallId }]));

    const result = await backfillHangupSource({ pageSize: 100 });

    expect(result.filled).toBe(0);
    expect((await prisma.callAttempt.findUniqueOrThrow({ where: { id: row.id } })).hangupSource).toBeNull();
  });

  it('walks on while pages come back full, and stops on a short one', async () => {
    const first = await attempt();
    const second = await attempt();

    listCallsMock
      .mockResolvedValueOnce(page([{ call_id: first.upstreamCallId, hangup_source: 'callee' }]))
      .mockResolvedValueOnce(page([{ call_id: second.upstreamCallId, hangup_source: 'agent' }]))
      .mockResolvedValueOnce(page([]));

    const result = await backfillHangupSource({ pageSize: 1 });

    // Three requests for two rows, and that is correct rather than wasteful: a
    // page that comes back FULL is indistinguishable from the last page of a
    // listing whose length is an exact multiple of the page size, so the walk
    // has to see a short one to know it is done.
    expect(listCallsMock).toHaveBeenCalledTimes(3);
    expect(result.filled).toBe(2);
    expect(result.truncated).toBe(false);
  });

  /**
   * Bounded, like every other walk over this listing. An unbounded one spends
   * a rate limit every customer on the platform shares, and the caller is a
   * script somebody runs by hand.
   */
  it('stops at the page budget and says it was truncated', async () => {
    listCallsMock.mockResolvedValue(page([{ call_id: 'x', hangup_source: 'callee' }]));

    const result = await backfillHangupSource({ pageSize: 1, maxPages: 3, outstanding: async () => 1 });

    expect(listCallsMock).toHaveBeenCalledTimes(3);
    expect(result.truncated).toBe(true);
    // ...and says where the next run should pick up, so the oldest calls are
    // reachable without re-reading everything in front of them.
    expect(result.nextOffset).toBe(3);
  });

  it('resumes from --start-offset rather than the head of the listing', async () => {
    listCallsMock.mockResolvedValueOnce(page([]));

    await backfillHangupSource({ pageSize: 100, startOffset: 700 });

    expect(listCallsMock).toHaveBeenCalledWith({ limit: 100, offset: 700 });
  });

  /** A walk with nothing left to fill stops spending the shared rate limit.
   *  Checked every ten pages, so a full budget of empty reads never happens. */
  it('stops once no attempt is left to fill, before the listing ends', async () => {
    listCallsMock.mockResolvedValue(page([{ call_id: 'x', hangup_source: 'callee' }]));

    const result = await backfillHangupSource({ pageSize: 1, maxPages: 50, outstanding: async () => 0 });

    expect(listCallsMock).toHaveBeenCalledTimes(10);
    expect(result.complete).toBe(true);
    expect(result.truncated).toBe(false);
  });

  /** A failure propagates. Swallowing it would report a complete backfill over
   *  a walk that stopped early, which is the one outcome forbidden here. */
  it('propagates an upstream failure rather than reporting a short walk as complete', async () => {
    listCallsMock.mockRejectedValueOnce(new Error('upstream down'));

    await expect(backfillHangupSource({ pageSize: 100 })).rejects.toThrow('upstream down');
  });
});
