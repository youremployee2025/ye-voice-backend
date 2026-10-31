import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Account, Agent, TestSessionStatus, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { toInternalCredits } from '../src/lib/credits.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeAgent, makeWorkspace } from './helpers.js';

vi.mock('../src/adapter/vocobase.js', () => ({
  getSession: vi.fn(),
}));

const client = await import('../src/adapter/vocobase.js');
const { closeStaleTestSessions } = await import('../src/services/testSessionReaper.js');

const price = (display: string) => toInternalCredits(display);
const MINUTE = 60_000;

let owner: Account;
let workspace: Workspace;
let agent: Agent;
let now: Date;

beforeEach(async () => {
  await truncateAll();
  vi.mocked(client.getSession).mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});

  now = new Date('2026-09-01T12:00:00.000Z');
  owner = await makeAccount('reap-owner');
  await prisma.account.update({ where: { id: owner.id }, data: { credits: price('100.00') } });
  workspace = await makeWorkspace(owner, 'Reaped');
  agent = await makeAgent(workspace, 'Pratibha');
});

afterEach(async () => {
  await truncateAll();
  vi.restoreAllMocks();
});

async function session(opts: {
  status: TestSessionStatus;
  ageMins: number;
  upstreamSessionId?: string | null;
  workspaceId?: string;
}) {
  const startedAt = new Date(now.getTime() - opts.ageMins * MINUTE);

  return prisma.testSession.create({
    data: {
      workspaceId: opts.workspaceId ?? workspace.id,
      accountId: owner.id,
      agentId: agent.id,
      startedByAccountId: owner.id,
      upstreamSessionId:
        opts.upstreamSessionId === undefined
          ? `sess-${Math.random().toString(36).slice(2, 10)}`
          : opts.upstreamSessionId,
      status: opts.status,
      startedAt,
      endedAt: opts.status === 'ENDING' ? startedAt : null,
      rateCreditsPerMin: price('2.00'),
      billingIncrementSecs: 60,
    },
  });
}

const completed = (durationSecs: number) => ({
  session_id: 's',
  status: 'completed',
  duration_seconds: durationSecs,
});

const balance = async () =>
  (await prisma.account.findUniqueOrThrow({ where: { id: owner.id } })).credits;

describe('closeStaleTestSessions', () => {
  it('reconciles an ENDING session a minute after the browser let go', async () => {
    const row = await session({ status: 'ENDING', ageMins: 2 });
    vi.mocked(client.getSession).mockResolvedValue(completed(90));

    expect(await closeStaleTestSessions(now)).toBe(1);

    const settled = await prisma.testSession.findUniqueOrThrow({ where: { id: row.id } });
    expect(settled.status).toBe('COMPLETED');
    expect(settled.durationSecs).toBe(90);
    expect(settled.billedSecs).toBe(120);
    expect(await balance()).toBe(price('96.00'));
  });

  it('leaves a freshly ended session for the completion event to settle', async () => {
    await session({ status: 'ENDING', ageMins: 0 });

    expect(await closeStaleTestSessions(now)).toBe(0);
    expect(client.getSession).not.toHaveBeenCalled();
  });

  it('leaves an ACTIVE session alone until it is past the timeout', async () => {
    await session({ status: 'ACTIVE', ageMins: 5 });

    expect(await closeStaleTestSessions(now)).toBe(0);
    expect(client.getSession).not.toHaveBeenCalled();
  });

  it('reconciles an ACTIVE session once it is past the timeout', async () => {
    // Its own workspace: the first row above holds this one's live slot, and
    // the partial unique index is real rather than decorative.
    const elsewhere = await makeWorkspace(owner, 'Elsewhere');
    await session({ status: 'ACTIVE', ageMins: 5 });
    const stale = await session({ status: 'ACTIVE', ageMins: 20, workspaceId: elsewhere.id });

    vi.mocked(client.getSession).mockResolvedValue(completed(60));

    expect(await closeStaleTestSessions(now)).toBe(1);

    const settled = await prisma.testSession.findUniqueOrThrow({ where: { id: stale.id } });
    expect(settled.status).toBe('COMPLETED');
    expect(settled.costCredits).toBe(price('2.00'));
  });

  /**
   * The platform has never heard of it. Its own status rather than FAILED —
   * "we never found out" and "it did not work" are different facts, and the
   * charge is zero because nothing can say otherwise.
   */
  it('abandons a session the platform has no record of', async () => {
    const row = await session({ status: 'ACTIVE', ageMins: 30 });
    vi.mocked(client.getSession).mockResolvedValue(null);

    expect(await closeStaleTestSessions(now)).toBe(1);

    const settled = await prisma.testSession.findUniqueOrThrow({ where: { id: row.id } });
    expect(settled.status).toBe('ABANDONED');
    expect(settled.costCredits).toBeNull();
    // Stamped, so a late delivery cannot charge it afterwards.
    expect(settled.chargedAt).not.toBeNull();
    expect(settled.resolvedAt).not.toBeNull();
    expect(await prisma.creditTransaction.count()).toBe(0);
    expect(await balance()).toBe(price('100.00'));
  });

  /**
   * The reaper does not guess a duration. Ever. Only the platform knows when
   * the audio stopped, so a session it still reports as live is left for the
   * next tick rather than settled at the cap.
   */
  it('leaves a session the platform still reports as live', async () => {
    const row = await session({ status: 'ACTIVE', ageMins: 30 });
    vi.mocked(client.getSession).mockResolvedValue({ session_id: 's', status: 'active' });

    expect(await closeStaleTestSessions(now)).toBe(0);

    const untouched = await prisma.testSession.findUniqueOrThrow({ where: { id: row.id } });
    expect(untouched.status).toBe('ACTIVE');
    expect(untouched.chargedAt).toBeNull();
  });

  /** A session we cannot name is one we can never settle. */
  it('abandons an unnamed session without asking the platform', async () => {
    const row = await session({ status: 'ACTIVE', ageMins: 30, upstreamSessionId: null });

    expect(await closeStaleTestSessions(now)).toBe(1);
    expect(client.getSession).not.toHaveBeenCalled();

    const settled = await prisma.testSession.findUniqueOrThrow({ where: { id: row.id } });
    expect(settled.status).toBe('ABANDONED');
  });

  it('never re-settles a session that is already charged', async () => {
    const row = await session({ status: 'ACTIVE', ageMins: 30 });
    await prisma.testSession.update({
      where: { id: row.id },
      data: { status: 'COMPLETED', chargedAt: now, costCredits: price('2.00') },
    });

    expect(await closeStaleTestSessions(now)).toBe(0);
    expect(client.getSession).not.toHaveBeenCalled();
  });

  /** One unreadable row must not stop the rest being closed. */
  it('works through the batch when one session cannot be read', async () => {
    const others = await Promise.all([
      makeWorkspace(owner, 'W2'),
      makeWorkspace(owner, 'W3'),
    ]);
    await session({ status: 'ACTIVE', ageMins: 30 });
    await session({ status: 'ACTIVE', ageMins: 29, workspaceId: others[0]!.id });
    await session({ status: 'ACTIVE', ageMins: 28, workspaceId: others[1]!.id });

    vi.mocked(client.getSession)
      .mockRejectedValueOnce(new Error('upstream is down'))
      .mockResolvedValue(completed(60));

    expect(await closeStaleTestSessions(now)).toBe(2);
  });
});
