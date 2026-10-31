import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Account, Agent, Workspace } from '@prisma/client';

// No test may reach the real partner API.
vi.mock('../src/adapter/vocobase.js', () => ({
  startWebSession: vi.fn(),
  getSession: vi.fn(),
}));

const client = await import('../src/adapter/vocobase.js');
const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { toInternalCredits } = await import('../src/lib/credits.js');
const { truncateAll } = await import('./setup.js');
const { addMember, as, makeAccount, makeAgent, makeWorkspace } = await import('./helpers.js');

const app = createApp();
const price = (display: string) => toInternalCredits(display);

const OWNER = as('user_owner', 'owner@ezo.test');
const MEMBER = as('user_member', 'member@ezo.test');
const STRANGER = as('user_stranger', 'stranger@ezo.test');

let owner: Account;
let workspace: Workspace;
let agent: Agent;

/**
 * The room and the token deliberately do NOT embed the session id — upstream's
 * do not either, and a fixture that made them look derived would make the
 * "never on the wire" assertion below unsatisfiable for the wrong reason.
 */
const accepted = (sessionId = 'sess-1', room = 'room-a') => ({
  session_id: sessionId,
  daily_room_url: `https://daily.test/${room}`,
  daily_token: `tok-${room}`,
});

beforeEach(async () => {
  await truncateAll();
  vi.mocked(client.startWebSession).mockReset().mockResolvedValue(accepted());

  await prisma.tier.create({
    data: {
      slug: 'va-pro',
      name: 'VA-PRO',
      defaultPriceCreditsPerMin: price('2.00'),
      billingIncrementSecs: 60,
      isDefault: true,
    },
  });

  owner = await prisma.account.create({
    data: { clerkUserId: 'user_owner', email: 'owner@ezo.test', name: 'owner', credits: price('100.00') },
  });
  workspace = await makeWorkspace(owner, 'Testing');
  agent = await makeAgent(workspace, 'Pratibha');
  await prisma.agent.update({ where: { id: agent.id }, data: { voiceTierSlug: 'va-pro' } });
});

afterEach(truncateAll);

const startUrl = (agentId = agent.id) =>
  `/api/workspaces/${workspace.id}/agents/${agentId}/test-session`;

describe('POST .../agents/:agentId/test-session', () => {
  /**
   * A MEMBER, deliberately. The permission matrix already grants members "use
   * agents, campaigns and sessions", and testing an agent you are allowed to
   * edit is not a larger act than editing it. This test is what keeps somebody
   * from "fixing" it into an ADMIN gate.
   */
  it('is open to any member of the workspace', async () => {
    const member = await makeAccount('member');
    await prisma.account.update({
      where: { id: member.id },
      data: { clerkUserId: 'user_member', email: 'member@ezo.test' },
    });
    await addMember(workspace, member, 'MEMBER');

    const res = await request(app).post(startUrl()).set(...MEMBER).send({});

    expect(res.status).toBe(201);
  });

  it('hands back a room, a token and the cap the browser must honour', async () => {
    const res = await request(app).post(startUrl()).set(...OWNER).send({});

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      id: expect.any(String),
      room_url: 'https://daily.test/room-a',
      token: 'tok-room-a',
      max_duration_secs: 300,
    });
  });

  /**
   * The platform's session id is an upstream handle on an account every
   * workspace shares — the same class of value `serialize.ts` already keeps off
   * the wire. Asserted on the whole body rather than on one absent key, so a
   * later widening of this payload has to come back through this test.
   */
  it("never puts the platform's own session id on the wire", async () => {
    const res = await request(app).post(startUrl()).set(...OWNER).send({});

    expect(Object.keys(res.body.data).sort()).toEqual([
      'id',
      'max_duration_secs',
      'room_url',
      'token',
    ]);
    expect(JSON.stringify(res.body)).not.toContain('sess-1');
  });

  it('forwards the pre-call variables it was given', async () => {
    await request(app)
      .post(startUrl())
      .set(...OWNER)
      .send({ variables: { contact_name_hi: 'आशा' } });

    expect(client.startWebSession).toHaveBeenCalledWith({
      agent_id: agent.externalId,
      variables: { contact_name_hi: 'आशा' },
    });
  });

  it('refuses a variable value that is not a string', async () => {
    const res = await request(app)
      .post(startUrl())
      .set(...OWNER)
      .send({ variables: { count: 3 } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(client.startWebSession).not.toHaveBeenCalled();
  });

  it('refuses more variables than any agent declares', async () => {
    const variables = Object.fromEntries(
      Array.from({ length: 51 }, (_, i) => [`v${i}`, 'x']),
    );

    const res = await request(app).post(startUrl()).set(...OWNER).send({ variables });

    expect(res.status).toBe(400);
    expect(client.startWebSession).not.toHaveBeenCalled();
  });

  it('403s a caller who is not a member', async () => {
    await makeAccount('stranger');
    await prisma.account.updateMany({
      where: { email: 'stranger@ezo.test' },
      data: { clerkUserId: 'user_stranger' },
    });

    const res = await request(app).post(startUrl()).set(...STRANGER).send({});

    expect(res.status).toBe(403);
  });

  /**
   * An agent in another workspace and a nonexistent id answer identically — a
   * 403 would confirm the id names something real.
   */
  it("404s another workspace's agent exactly as it 404s a nonexistent one", async () => {
    const other = await makeAccount('other');
    const otherWorkspace = await makeWorkspace(other, 'Elsewhere');
    const foreign = await makeAgent(otherWorkspace, 'Theirs');

    const theirs = await request(app).post(startUrl(foreign.id)).set(...OWNER).send({});
    const nothing = await request(app).post(startUrl('does-not-exist')).set(...OWNER).send({});

    expect(theirs.status).toBe(404);
    expect(nothing.status).toBe(404);
    expect(theirs.body.error).toEqual(nothing.body.error);
  });

  it('refuses a retired agent by name', async () => {
    const retired = await makeAgent(workspace, 'Retired', 'removed');

    const res = await request(app).post(startUrl(retired.id)).set(...OWNER).send({});

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AGENT_NOT_USABLE');
  });

  it('refuses a workspace whose balance cannot cover the cap', async () => {
    await prisma.account.update({ where: { id: owner.id }, data: { credits: price('9.99') } });

    const res = await request(app).post(startUrl()).set(...OWNER).send({});

    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('INSUFFICIENT_CREDITS');
  });

  it('refuses a second test while one is running', async () => {
    await request(app).post(startUrl()).set(...OWNER).send({});
    vi.mocked(client.startWebSession).mockResolvedValue(accepted('sess-2', 'room-b'));

    const res = await request(app).post(startUrl()).set(...OWNER).send({});

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TEST_SESSION_IN_PROGRESS');
  });

  /**
   * Six a minute per workspace, under the platform's documented ten starts a
   * minute per key — which is account-wide, so every workspace shares it.
   */
  it('caps how fast one workspace may start them', async () => {
    let last = 0;

    for (let i = 0; i < 7; i += 1) {
      vi.mocked(client.startWebSession).mockResolvedValue(accepted(`sess-${i}`, `room-${i}`));
      // End each one so the per-workspace concurrency cap is not what refuses.
      const res = await request(app).post(startUrl()).set(...OWNER).send({});
      last = res.status;
      if (res.status === 201) {
        await request(app)
          .post(`/api/workspaces/${workspace.id}/test-sessions/${res.body.data.id}/end`)
          .set(...OWNER)
          .send({});
      }
    }

    expect(last).toBe(429);
  });
});

describe('POST .../test-sessions/:sessionId/end', () => {
  async function start() {
    const res = await request(app).post(startUrl()).set(...OWNER).send({});
    return res.body.data.id as string;
  }

  const endUrl = (id: string, workspaceId = workspace.id) =>
    `/api/workspaces/${workspaceId}/test-sessions/${id}/end`;

  it('releases the session and charges nothing', async () => {
    const id = await start();

    const res = await request(app).post(endUrl(id)).set(...OWNER).send({});

    expect(res.status).toBe(204);
    const row = await prisma.testSession.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('ENDING');
    expect(row.chargedAt).toBeNull();
    expect(await prisma.creditTransaction.count()).toBe(0);
  });

  it("404s a session that is not this workspace's", async () => {
    const id = await start();
    const other = await makeAccount('ender');
    const otherWorkspace = await makeWorkspace(other, 'Elsewhere');
    await addMember(otherWorkspace, owner, 'ADMIN');

    const res = await request(app).post(endUrl(id, otherWorkspace.id)).set(...OWNER).send({});

    expect(res.status).toBe(404);
  });

  it('404s a nonexistent session', async () => {
    const res = await request(app).post(endUrl('nope')).set(...OWNER).send({});

    expect(res.status).toBe(404);
  });
});
