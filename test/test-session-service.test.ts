import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Account, Agent, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { toInternalCredits } from '../src/lib/credits.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeAgent, makeWorkspace } from './helpers.js';

// No test may reach the real partner API.
vi.mock('../src/adapter/vocobase.js', () => ({
  startWebSession: vi.fn(),
  getSession: vi.fn(),
}));

const client = await import('../src/adapter/vocobase.js');
const { startTestSession, endTestSession } = await import('../src/services/testSession.js');

const price = (display: string) => toInternalCredits(display);

/** A session the platform accepted. */
function accepted(sessionId = 'sess-1') {
  return {
    session_id: sessionId,
    daily_room_url: `https://daily.test/room/${sessionId}`,
    daily_token: `tok-${sessionId}`,
  };
}

let owner: Account;
let workspace: Workspace;
let agent: Agent;

beforeEach(async () => {
  await truncateAll();
  vi.mocked(client.startWebSession).mockReset();

  await prisma.tier.create({
    data: {
      slug: 'va-pro',
      name: 'VA-PRO',
      defaultPriceCreditsPerMin: price('2.00'),
      billingIncrementSecs: 60,
      isDefault: true,
    },
  });

  owner = await makeAccount('ts-owner');
  // Ten credits is exactly the 300-second cap at 2.00/min, so the gate passes
  // on the nose rather than by a margin that would hide an off-by-one.
  await prisma.account.update({ where: { id: owner.id }, data: { credits: price('10.00') } });
  workspace = await makeWorkspace(owner, 'Test Sessions');
  agent = await makeAgent(workspace, 'Pratibha');
  await prisma.agent.update({ where: { id: agent.id }, data: { voiceTierSlug: 'va-pro' } });
  agent = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
});

afterEach(truncateAll);

function start(overrides: { variables?: Record<string, string> } = {}) {
  return startTestSession({
    workspace: { id: workspace.id, ownerAccountId: owner.id },
    agent,
    startedByAccountId: owner.id,
    ...overrides,
  });
}

describe('startTestSession', () => {
  it('holds a slot, opens the session, and stamps the platform id on it', async () => {
    vi.mocked(client.startWebSession).mockResolvedValue(accepted());

    const started = await start();

    expect(started.roomUrl).toBe('https://daily.test/room/sess-1');
    expect(started.token).toBe('tok-sess-1');
    expect(started.maxDurationSecs).toBe(300);

    const row = await prisma.testSession.findUniqueOrThrow({ where: { id: started.id } });
    expect(row.status).toBe('ACTIVE');
    expect(row.upstreamSessionId).toBe('sess-1');
    expect(row.workspaceId).toBe(workspace.id);
    expect(row.accountId).toBe(owner.id);
    expect(row.agentId).toBe(agent.id);
    expect(row.startedByAccountId).toBe(owner.id);
    // The plan, snapshotted — staff may re-price the tier while somebody talks.
    expect(row.tierSlug).toBe('va-pro');
    expect(row.rateCreditsPerMin).toBe(price('2.00'));
    expect(row.billingIncrementSecs).toBe(60);
    expect(row.chargedAt).toBeNull();

    expect(client.startWebSession).toHaveBeenCalledWith({ agent_id: agent.externalId });
  });

  it('forwards the pre-call variables it was given', async () => {
    vi.mocked(client.startWebSession).mockResolvedValue(accepted());

    await start({ variables: { contact_name_hi: 'आशा' } });

    expect(client.startWebSession).toHaveBeenCalledWith({
      agent_id: agent.externalId,
      variables: { contact_name_hi: 'आशा' },
    });
  });

  it('sends no variables key when none were given', async () => {
    vi.mocked(client.startWebSession).mockResolvedValue(accepted());

    await start({ variables: {} });

    expect(client.startWebSession).toHaveBeenCalledWith({ agent_id: agent.externalId });
  });

  /**
   * The per-workspace cap, and it is asserted as a RACE rather than as a
   * sequential second call. A counted check would pass both of these; only the
   * partial unique index refuses the second insert.
   */
  it('lets exactly one of two simultaneous starts through', async () => {
    vi.mocked(client.startWebSession).mockImplementation(async () => accepted(`s-${Math.random()}`));

    const results = await Promise.allSettled([start(), start()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      status: 409,
      code: 'TEST_SESSION_IN_PROGRESS',
    });
  });

  it('refuses a second session in the same workspace while one is live', async () => {
    vi.mocked(client.startWebSession).mockResolvedValue(accepted());
    await start();

    await expect(start()).rejects.toMatchObject({
      status: 409,
      code: 'TEST_SESSION_IN_PROGRESS',
    });
  });

  /**
   * The ceiling that actually protects the dialer: every test takes a line from
   * the same pool campaigns dial on, so the per-workspace cap of one bounds
   * nothing on a platform with many workspaces.
   */
  it('refuses when the platform-wide ceiling is already reached elsewhere', async () => {
    process.env.TEST_SESSION_MAX_CONCURRENT = '1';
    vi.resetModules();
    const { startTestSession: start2 } = await import('../src/services/testSession.js');

    const other = await makeAccount('ts-other');
    const otherWorkspace = await makeWorkspace(other, 'Elsewhere');
    await prisma.testSession.create({
      data: {
        workspaceId: otherWorkspace.id,
        accountId: other.id,
        agentId: agent.id,
        startedByAccountId: other.id,
        status: 'ACTIVE',
      },
    });

    await expect(
      start2({
        workspace: { id: workspace.id, ownerAccountId: owner.id },
        agent,
        startedByAccountId: owner.id,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'TEST_SESSION_UNAVAILABLE' });

    delete process.env.TEST_SESSION_MAX_CONCURRENT;
    vi.resetModules();
  });

  it('refuses a balance that cannot cover the whole cap', async () => {
    await prisma.account.update({
      where: { id: owner.id },
      data: { credits: price('9.99') },
    });

    await expect(start()).rejects.toMatchObject({
      status: 402,
      code: 'INSUFFICIENT_CREDITS',
    });
    expect(client.startWebSession).not.toHaveBeenCalled();
    expect(await prisma.testSession.count()).toBe(0);
  });

  it('refuses a retired agent, and never reaches the platform', async () => {
    const retired = await makeAgent(workspace, 'Retired', 'removed');

    await expect(
      startTestSession({
        workspace: { id: workspace.id, ownerAccountId: owner.id },
        agent: retired,
        startedByAccountId: owner.id,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'AGENT_NOT_USABLE' });
    expect(client.startWebSession).not.toHaveBeenCalled();
  });

  it("refuses an agent that is not this workspace's", async () => {
    const foreign = await makeAgent(null, 'Pooled');

    await expect(
      startTestSession({
        workspace: { id: workspace.id, ownerAccountId: owner.id },
        agent: foreign,
        startedByAccountId: owner.id,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'AGENT_NOT_USABLE' });
  });

  /** The slot must not survive a refusal, or one outage locks the workspace out. */
  it('frees the slot when the platform refuses', async () => {
    vi.mocked(client.startWebSession).mockRejectedValueOnce(new Error('upstream is down'));

    await expect(start()).rejects.toThrow();

    const failed = await prisma.testSession.findFirstOrThrow({});
    expect(failed.status).toBe('FAILED');

    vi.mocked(client.startWebSession).mockResolvedValue(accepted('sess-2'));
    await expect(start()).resolves.toMatchObject({ token: 'tok-sess-2' });
  });

  /**
   * A 201 with no session id is not a success. We can never settle a session we
   * cannot name, so it is reported rather than returned — the same shape
   * `AGENT_CREATED_UNASSIGNED` has.
   */
  it('refuses a session the platform did not name', async () => {
    vi.mocked(client.startWebSession).mockResolvedValue({
      daily_room_url: 'https://daily.test/room/x',
      daily_token: 'tok-x',
    });

    await expect(start()).rejects.toMatchObject({
      status: 502,
      code: 'TEST_SESSION_STARTED_UNTRACKED',
    });

    const row = await prisma.testSession.findFirstOrThrow({});
    expect(row.status).toBe('FAILED');
  });

  it('refuses a session with no room to connect to', async () => {
    vi.mocked(client.startWebSession).mockResolvedValue({ session_id: 'sess-9' });

    await expect(start()).rejects.toMatchObject({ code: 'TEST_SESSION_STARTED_UNTRACKED' });
  });
});

describe('endTestSession', () => {
  it('releases the slot without charging anything', async () => {
    vi.mocked(client.startWebSession).mockResolvedValue(accepted());
    const started = await start();

    await endTestSession(workspace.id, started.id);

    const row = await prisma.testSession.findUniqueOrThrow({ where: { id: started.id } });
    expect(row.status).toBe('ENDING');
    expect(row.endedAt).not.toBeNull();
    // What the session cost is the platform's to report, never the browser's to
    // claim, so this route settles nothing.
    expect(row.chargedAt).toBeNull();
    expect(row.costCredits).toBeNull();
    expect(await prisma.creditTransaction.count()).toBe(0);
  });

  it('frees the workspace to start another immediately', async () => {
    vi.mocked(client.startWebSession).mockResolvedValue(accepted());
    const started = await start();
    await endTestSession(workspace.id, started.id);

    vi.mocked(client.startWebSession).mockResolvedValue(accepted('sess-2'));
    await expect(start()).resolves.toMatchObject({ token: 'tok-sess-2' });
  });

  it("404s another workspace's session exactly as it 404s a nonexistent one", async () => {
    vi.mocked(client.startWebSession).mockResolvedValue(accepted());
    const started = await start();

    const stranger = await makeAccount('ts-stranger');
    const strangerWorkspace = await makeWorkspace(stranger, 'Stranger');

    await expect(endTestSession(strangerWorkspace.id, started.id)).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    await expect(endTestSession(workspace.id, 'nope')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  it('is not a second way to end an already ended session', async () => {
    vi.mocked(client.startWebSession).mockResolvedValue(accepted());
    const started = await start();
    await endTestSession(workspace.id, started.id);

    await expect(endTestSession(workspace.id, started.id)).rejects.toMatchObject({ status: 404 });
  });
});
