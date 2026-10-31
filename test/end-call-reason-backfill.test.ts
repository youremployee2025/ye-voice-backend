import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Filling `CallAttempt.endCallReason` for dials that settled before the
 * webhooks and the reaper wrote it. The platform derives `end_call_reason` on
 * read, so every historical listing row carries one.
 *
 * The adapter is mocked, as everywhere in this suite: the partner account is
 * production and no test here may make a real network call.
 */
const { listCallsMock } = vi.hoisted(() => ({ listCallsMock: vi.fn() }));

vi.mock('../src/adapter/vocobase.js', () => ({ listCalls: listCallsMock }));

import { prisma } from '../src/lib/prisma.js';
import { backfillEndCallReason } from '../src/services/endCallReasonBackfill.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';

let seq = 0;

async function attempt(fields: Record<string, unknown> = {}) {
  seq += 1;
  const account = await makeAccount(`reason-backfill-${seq}`);
  const workspace = await makeWorkspace(account, 'Backfill');

  return prisma.callAttempt.create({
    data: {
      workspaceId: workspace.id,
      accountId: account.id,
      attemptNo: 1,
      upstreamCallId: `r_${seq}`,
      status: 'COMPLETED',
      ...fields,
    } as never,
  });
}

/** One page of the upstream listing. */
const page = (calls: Record<string, unknown>[]) => ({ calls });

const reasonOf = async (id: string) =>
  (await prisma.callAttempt.findUniqueOrThrow({ where: { id } })).endCallReason;

beforeEach(async () => {
  await truncateAll();
  listCallsMock.mockReset();
});

describe('backfillEndCallReason', () => {
  /** Stored the way every other writer stores it: upper-cased and trimmed,
   *  so a listing-filled row reads the same as a webhook-filled one. */
  it('fills a null column from the listing, normalised', async () => {
    const row = await attempt();
    listCallsMock.mockResolvedValueOnce(
      page([{ call_id: row.upstreamCallId, end_call_reason: 'customer_hung_up' }]),
    );

    const result = await backfillEndCallReason({ pageSize: 100 });

    expect(result.filled).toBe(1);
    expect(await reasonOf(row.id)).toBe('CUSTOMER_HUNG_UP');
  });

  it('reads the camel-cased spelling too', async () => {
    const row = await attempt();
    listCallsMock.mockResolvedValueOnce(page([{ callId: row.upstreamCallId, endCallReason: 'completed' }]));

    const result = await backfillEndCallReason({ pageSize: 100 });

    expect(result.filled).toBe(1);
    expect(await reasonOf(row.id)).toBe('COMPLETED');
  });

  /**
   * The webhook and the reaper are the fresher sources and write this column
   * at settle time. The walk fills absences only — which is also what makes it
   * safe to re-run.
   */
  it('never overwrites a reason the webhook already recorded', async () => {
    const row = await attempt({ endCallReason: 'AGENT_HUNG_UP' });
    listCallsMock.mockResolvedValueOnce(
      page([{ call_id: row.upstreamCallId, end_call_reason: 'customer_hung_up' }]),
    );

    const result = await backfillEndCallReason({ pageSize: 100 });

    expect(result.filled).toBe(0);
    expect(await reasonOf(row.id)).toBe('AGENT_HUNG_UP');
  });

  /** A listing row without the field leaves the column null. Writing an empty
   *  string would turn "the platform did not say" into a reason nobody gave. */
  it('leaves the column null when the listing carries no reason', async () => {
    const row = await attempt();
    listCallsMock.mockResolvedValueOnce(page([{ call_id: row.upstreamCallId }]));

    const result = await backfillEndCallReason({ pageSize: 100 });

    expect(result.filled).toBe(0);
    expect(await reasonOf(row.id)).toBeNull();
  });

  it('leaves the column null when the listing carries a blank reason', async () => {
    const row = await attempt();
    listCallsMock.mockResolvedValueOnce(page([{ call_id: row.upstreamCallId, end_call_reason: '   ' }]));

    const result = await backfillEndCallReason({ pageSize: 100 });

    expect(result.filled).toBe(0);
    expect(await reasonOf(row.id)).toBeNull();
  });

  /**
   * Two values the walk never writes. SYSTEM_ERROR decides a budget, and a
   * historical settle already spent or spared the retry under its own rule;
   * UNKNOWN is what the listing derives for every connected call before the
   * platform stored the bot's report, and says nothing the row does not.
   */
  it.each(['SYSTEM_ERROR', 'UNKNOWN', 'unknown'])('leaves the column null on a listed %s', async (reason) => {
    const row = await attempt();
    listCallsMock.mockResolvedValueOnce(page([{ call_id: row.upstreamCallId, end_call_reason: reason }]));

    const result = await backfillEndCallReason({ pageSize: 100 });

    expect(result.filled).toBe(0);
    expect(await reasonOf(row.id)).toBeNull();
  });

  /** The pool is partner-wide: a call matching no attempt of ours is counted
   *  and skipped, never stored. */
  it('skips a call that matches no attempt of ours', async () => {
    listCallsMock.mockResolvedValueOnce(page([{ call_id: 'someone-elses', end_call_reason: 'COMPLETED' }]));

    const result = await backfillEndCallReason({ pageSize: 100 });

    expect(result.filled).toBe(0);
    expect(result.scanned).toBe(1);
  });

  /** The sibling column's filled state must not count as this one's: an
   *  attempt with a source and no reason is still outstanding here. */
  it('counts outstanding rows on this column, not the source column', async () => {
    await attempt({ hangupSource: 'callee' });
    listCallsMock.mockResolvedValue(page([{ call_id: 'x', end_call_reason: 'COMPLETED' }]));

    // With one attempt still lacking a reason the ten-page check must not stop
    // the walk, so it runs to its budget.
    const result = await backfillEndCallReason({ pageSize: 1, maxPages: 12 });

    expect(listCallsMock).toHaveBeenCalledTimes(12);
    expect(result.complete).toBe(false);
    expect(result.truncated).toBe(true);
  });

  /** A walk with nothing left to fill stops spending the shared rate limit. */
  it('stops once no attempt is left to fill, before the listing ends', async () => {
    listCallsMock.mockResolvedValue(page([{ call_id: 'x', end_call_reason: 'COMPLETED' }]));

    const result = await backfillEndCallReason({ pageSize: 1, maxPages: 50, outstanding: async () => 0 });

    expect(listCallsMock).toHaveBeenCalledTimes(10);
    expect(result.complete).toBe(true);
    expect(result.truncated).toBe(false);
  });

  /** A failure propagates rather than reporting a short walk as complete. */
  it('propagates an upstream failure', async () => {
    listCallsMock.mockRejectedValueOnce(new Error('upstream down'));

    await expect(backfillEndCallReason({ pageSize: 100 })).rejects.toThrow('upstream down');
  });
});
