import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { as, makeAccount, makeAgent,
  makeDialable, makeWorkspace } from './helpers.js';

/**
 * `start` and `resume` now reach the voice platform to make the campaign's
 * caller number outbound-ready. Mocked here, as every upstream call in this
 * suite is: no test may place a call or build routing on a live account.
 */
vi.mock('../src/adapter/vocobase.js', () => ({
  voicelinkCallReady: vi.fn(async () => ({ ready: true, readiness: { state: 'READY', issues: [] } })),
  startCall: vi.fn(),
  getConcurrency: vi.fn(),
  getCall: vi.fn(),
  // The callback extraction key, ensured on every start and resume. Stubbed as
  // "already set up" so these cases exercise the transition rather than it.
  listExtractionSets: vi.fn(async () => ({
    extraction_sets: [{ id: 'set_cb', name: 'Campaign callbacks' }],
  })),
  createExtractionSet: vi.fn(),
  listAgentExtractionSets: vi.fn(async () => ({
    extraction_sets: [{ id: 'set_cb', name: 'Campaign callbacks' }],
  })),
  attachAgentExtractionSet: vi.fn(),
  getAgent: vi.fn(async () => ({ extraction_enabled: true })),
  updateAgent: vi.fn(),
}));


const app = createApp();

beforeEach(async () => {
  await truncateAll();
});

const AUTH = as('user_alice', 'alice@ezo.test');

describe('assigning an agent to a campaign', () => {
  it('accepts an agent in the same workspace', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Sales');
    const campaign = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'Q3' } });

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...AUTH)
      .send({ agentId: agent.id });

    expect(res.status).toBe(200);
    expect(res.body.data.agentId).toBe(agent.id);

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.agentId).toBe(agent.id);
  });

  it('422s a foreign agent, an unassigned agent and a nonexistent id identically', async () => {
    const alice = await makeAccount('alice');
    const mine = await makeWorkspace(alice, 'A Co');
    const theirs = await makeWorkspace(alice, 'B Co');
    const foreign = await makeAgent(theirs, 'Theirs');
    const unassigned = await makeAgent(null, 'Pool');
    const campaign = await prisma.campaign.create({ data: { workspaceId: mine.id, name: 'Q3' } });

    const patch = (agentId: string) =>
      request(app)
        .patch(`/api/workspaces/${mine.id}/campaigns/${campaign.id}`)
        .set(...AUTH)
        .send({ agentId });

    // Sequential rather than concurrent: these share one campaign row, and a
    // parallel write would make the "nothing was stored" assertion a race.
    const results = [
      await patch(foreign.id),
      await patch(unassigned.id),
      await patch('agent_does_not_exist'),
    ];

    for (const res of results) {
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('CAMPAIGN_AGENT_NOT_FOUND');
    }

    // Byte-identical. A caller must not be able to sort ids into real and
    // unreal by comparing responses — that is id enumeration one request at a
    // time, and it is the whole reason these three share an answer.
    expect(new Set(results.map((r) => JSON.stringify(r.body))).size).toBe(1);

    // Nor may a refused write leave anything behind.
    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.agentId).toBeNull();
  });

  it('never names the foreign agent in the refusal', async () => {
    const alice = await makeAccount('alice');
    const mine = await makeWorkspace(alice, 'A Co');
    const theirs = await makeWorkspace(alice, 'B Co');
    const foreign = await makeAgent(theirs, 'Confidential Bot');
    const campaign = await prisma.campaign.create({ data: { workspaceId: mine.id, name: 'Q3' } });

    const res = await request(app)
      .patch(`/api/workspaces/${mine.id}/campaigns/${campaign.id}`)
      .set(...AUTH)
      .send({ agentId: foreign.id });

    expect(JSON.stringify(res.body)).not.toContain('Confidential Bot');
  });

  it('clears the agent when sent null', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Sales');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', agentId: agent.id },
    });

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...AUTH)
      .send({ agentId: null });

    expect(res.status).toBe(200);
    expect(res.body.data.agentId).toBeNull();
  });

  it('leaves an existing agent alone when the field is absent', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Sales');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', agentId: agent.id },
    });

    await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...AUTH)
      .send({ name: 'Q4' });

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.agentId).toBe(agent.id);
  });

  it('refuses a MEMBER outright, before the agent is ever resolved', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const ws = await makeWorkspace(alice, 'A Co');
    await prisma.workspaceMember.create({
      data: { workspaceId: ws.id, accountId: bob.id, role: 'MEMBER' },
    });
    const agent = await makeAgent(ws, 'Sales');
    const campaign = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'Q3' } });

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...as('user_bob', 'bob@ezo.test'))
      .send({ agentId: agent.id });

    expect(res.status).toBe(403);
  });
});

describe('starting a campaign whose agent left the workspace', () => {
  it('refuses start and resume with CAMPAIGN_AGENT_REQUIRED', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const contact = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+919876543210' },
    });

    for (const [status, action] of [
      ['DRAFT', 'start'],
      ['PAUSED', 'resume'],
    ] as const) {
      // One agent per iteration rather than one restored between them: a
      // failure in the first would otherwise leave the second running against
      // mutated state, reporting a cause that is not the real one.
      const agent = await makeAgent(ws, `Sales ${action}`);
      const campaign = await prisma.campaign.create({
        data: { workspaceId: ws.id, name: `${action} me`, agentId: agent.id, status },
      });
      await prisma.campaignContact.create({
        data: { campaignId: campaign.id, contactId: contact.id },
      });

      // Staff unassign with an UPDATE. The agent row survives, the foreign key
      // still holds, and a null check on agentId would wave this straight
      // through — which is the entire point of this case.
      await prisma.agent.update({ where: { id: agent.id }, data: { workspaceId: null } });

      const res = await request(app)
        .post(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/${action}`)
        .set(...AUTH);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CAMPAIGN_AGENT_REQUIRED');

      const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
      expect(stored.status).toBe(status);
    }
  });

  it('refuses when the agent was reassigned to another workspace', async () => {
    const alice = await makeAccount('alice');
    const mine = await makeWorkspace(alice, 'A Co');
    const theirs = await makeWorkspace(alice, 'B Co');
    const agent = await makeAgent(mine, 'Sales');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: mine.id, name: 'Q3', agentId: agent.id },
    });
    const contact = await prisma.contact.create({
      data: { workspaceId: mine.id, phone: '+919876543210' },
    });
    await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });

    await prisma.agent.update({ where: { id: agent.id }, data: { workspaceId: theirs.id } });

    const res = await request(app)
      .post(`/api/workspaces/${mine.id}/campaigns/${campaign.id}/start`)
      .set(...AUTH);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAMPAIGN_AGENT_REQUIRED');
  });

  it("starts when the agent is the workspace's", async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Sales');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', agentId: agent.id },
    });
    const contact = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+919876543210' },
    });
    await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });
    // A caller number, a price and a balance — the gates the dialer added.
    await makeDialable(ws, campaign, agent);

    const res = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/start`)
      .set(...AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('RUNNING');
  });

  it('still refuses a campaign that never had an agent', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const campaign = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'Q3' } });

    const res = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/start`)
      .set(...AUTH);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAMPAIGN_AGENT_REQUIRED');
  });
});

describe('campaign agent summary', () => {
  it('embeds id, name and status, and nothing else', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Sales', 'active');
    await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', agentId: agent.id },
    });

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns`)
      .set(...AUTH);

    const [row] = res.body.data.campaigns;
    expect(row.agent).toEqual({ id: agent.id, name: 'Sales', status: 'active' });

    // `workspaceId` is selected to decide visibility and must never be emitted;
    // neither may the rest of the mirror leak in through the relation.
    // `workspaceId` is the real assertion: it *is* selected, so only the
    // serializer keeps it off the wire. `externalId` and `rawConfig` are not in
    // `CAMPAIGN_INCLUDE` at all and could not appear whatever this code did —
    // asserting their absence tested nothing.
    expect(JSON.stringify(res.body)).not.toContain('workspaceId');
  });

  it('reports an unassigned agent as null while keeping agentId', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Sales');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', agentId: agent.id },
    });
    await prisma.agent.update({ where: { id: agent.id }, data: { workspaceId: null } });

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...AUTH);

    // "Not set" and "unavailable" are different states with different
    // explanations, so agentId survives while the name is withheld.
    expect(res.body.data.agent).toBeNull();
    expect(res.body.data.agentId).toBe(agent.id);
    expect(JSON.stringify(res.body)).not.toContain('Sales');
  });

  it("never names an agent that now belongs to another workspace", async () => {
    const alice = await makeAccount('alice');
    const mine = await makeWorkspace(alice, 'A Co');
    const theirs = await makeWorkspace(alice, 'B Co');
    const agent = await makeAgent(mine, 'Confidential Bot');
    await prisma.campaign.create({
      data: { workspaceId: mine.id, name: 'Q3', agentId: agent.id },
    });
    await prisma.agent.update({ where: { id: agent.id }, data: { workspaceId: theirs.id } });

    const res = await request(app)
      .get(`/api/workspaces/${mine.id}/campaigns`)
      .set(...AUTH);

    expect(res.body.data.campaigns[0].agent).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('Confidential Bot');
  });

  it('carries the summary through PATCH and the lifecycle actions', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Sales');
    const campaign = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'Q3' } });
    const contact = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+919876543210' },
    });
    await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });
    await makeDialable(ws, campaign, agent);

    const patched = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...AUTH)
      .send({ agentId: agent.id });
    expect(patched.body.data.agent).toEqual({ id: agent.id, name: 'Sales', status: 'active' });

    const started = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/start`)
      .set(...AUTH);
    expect(started.body.data.agent).toEqual({ id: agent.id, name: 'Sales', status: 'active' });
  });

  it('nulls the campaign agent when the agent row is deleted', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Sales');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', agentId: agent.id },
    });

    await prisma.agent.delete({ where: { id: agent.id } });

    // ON DELETE SET NULL: the campaign survives its agent.
    const still = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(still.agentId).toBeNull();
  });
});

describe('a removed agent is not a usable agent', () => {
  it('refuses to assign one, indistinguishably from the other refusals', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    // Sync retires an agent by setting `status`, leaving `workspaceId` intact.
    // So this row still resolves in its workspace and the foreign key is happy;
    // only the status says it is gone.
    const removed = await makeAgent(ws, 'Dead Bot', 'removed');
    const campaign = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'Q3' } });

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...AUTH)
      .send({ agentId: removed.id });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CAMPAIGN_AGENT_NOT_FOUND');
    expect(JSON.stringify(res.body)).not.toContain('Dead Bot');

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.agentId).toBeNull();
  });

  it('refuses to start a campaign whose agent was retired under it', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Sales');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', agentId: agent.id },
    });
    const contact = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+919876543210' },
    });
    await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });

    await prisma.agent.update({ where: { id: agent.id }, data: { status: 'removed' } });

    const res = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/start`)
      .set(...AUTH);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAMPAIGN_AGENT_REQUIRED');

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.status).toBe('DRAFT');
  });

  it('serializes as unavailable — agent null, agentId kept', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Sales');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', agentId: agent.id },
    });
    await prisma.agent.update({ where: { id: agent.id }, data: { status: 'removed' } });

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.agent).toBeNull();
    expect(res.body.data.agentId).toBe(agent.id);
    expect(JSON.stringify(res.body)).not.toContain('Sales');
  });

  it('still accepts an agent whose status never synced', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const campaign = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'Q3' } });
    const agent = await makeAgent(ws, 'Sales');
    await prisma.agent.update({ where: { id: agent.id }, data: { status: null } });

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...AUTH)
      .send({ agentId: agent.id });

    // The NULL-safety trap. `status <> 'removed'` is NULL for a NULL status and
    // matches nothing, which would exempt every unsynced agent from being
    // pickable at all. Upstream omits `status` often enough for that to matter.
    expect(res.status).toBe(200);
    expect(res.body.data.agent).toEqual({ id: agent.id, name: 'Sales', status: null });
  });
});

describe('a running campaign holds its agent', () => {
  const running = async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Sales');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', agentId: agent.id, status: 'RUNNING' },
    });
    return { ws, agent, campaign };
  };

  it('refuses to clear the agent mid-flight', async () => {
    const { ws, agent, campaign } = await running();

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...AUTH)
      .send({ agentId: null });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAMPAIGN_AGENT_LOCKED');

    // The invariant the relation exists to hold: a running campaign always
    // resolves an agent. A 200 here would void it through the same handler.
    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.agentId).toBe(agent.id);
  });

  it('refuses to swap the agent mid-flight', async () => {
    const { ws, agent, campaign } = await running();
    const other = await makeAgent(ws, 'Support');

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...AUTH)
      .send({ agentId: other.id });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAMPAIGN_AGENT_LOCKED');

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.agentId).toBe(agent.id);
  });

  /**
   * The rest of the form is locked too — a running campaign is read-only. What
   * this case is about is that the refusal *names* the fields rather than
   * saving nothing and reporting success. See `campaign-edit-gates.test.ts`.
   */
  it('refuses the rest of the form as well, naming it', async () => {
    const { ws, campaign } = await running();

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...AUTH)
      .send({ name: 'Q4', retryCount: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CAMPAIGN_CONFIG_LOCKED');
    expect(res.body.error.message).toContain('name');
    expect(res.body.error.message).toContain('retryCount');
  });

  it('accepts the same agent it already holds, so an unchanged resubmit is not a refusal', async () => {
    const { ws, agent, campaign } = await running();

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...AUTH)
      .send({ agentId: agent.id });

    expect(res.status).toBe(200);
    expect(res.body.data.agentId).toBe(agent.id);
  });

  /**
   * Nor may a paused one, any more.
   *
   * Pausing used to be the way to change the agent. It is not: a campaign that
   * dialed half its list with one agent and the rest with another is a report
   * nobody can read, and the calls already placed cannot be un-placed. The
   * remedy is a new campaign, and the refusal says so.
   */
  it('refuses a paused campaign the same change', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Sales');
    const other = await makeAgent(ws, 'Support');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', agentId: agent.id, status: 'PAUSED' },
    });

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...AUTH)
      .send({ agentId: other.id });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CAMPAIGN_CONFIG_LOCKED');
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).agentId)
      .toBe(agent.id);
  });
});

describe('the agent join costs one query, whatever the list length', () => {
  it('issues no per-row agent read when listing campaigns', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');

    for (let i = 0; i < 6; i += 1) {
      const agent = await makeAgent(ws, `Agent ${i}`);
      await prisma.campaign.create({
        data: { workspaceId: ws.id, name: `C${i}`, agentId: agent.id },
      });
    }

    // Counted at the ORM call, not by reading the code: the design promises the
    // agent arrives through the include, and a refactor that moved the lookup
    // into a `.map()` would serve byte-identical JSON and pass every other test
    // in this file.
    const reads = ['findFirst', 'findUnique', 'findMany'] as const;
    const spies = reads.map((method) => vi.spyOn(prisma.agent, method));

    const res = await request(app).get(`/api/workspaces/${ws.id}/campaigns`).set(...AUTH);

    const agentReads = spies.reduce((n, spy) => n + spy.mock.calls.length, 0);
    spies.forEach((spy) => spy.mockRestore());

    expect(res.status).toBe(200);
    expect(res.body.data.campaigns).toHaveLength(6);
    for (const row of res.body.data.campaigns) {
      expect(row.agent).not.toBeNull();
    }

    // Six campaigns, zero separate agent reads — the relation is joined.
    expect(agentReads).toBe(0);
  });
});
