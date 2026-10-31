import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { MAX_CONCURRENCY_LIMIT } from '../src/lib/campaignConfig.js';
import {
  addMember,
  as,
  makeAccount,
  makeAgent,
  makePhoneNumber,
  makeWorkspace,
} from './helpers.js';

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
  // Deleting a goal campaign takes the managed block off its agent: one read
  // and one write upstream, both mocked here as every upstream call is.
  getAgent: vi.fn(),
  updateAgent: vi.fn(),
}));

import { getAgent, updateAgent } from '../src/adapter/vocobase.js';
import { withGoalBlock } from '../src/lib/goalPromptBlock.js';


const app = createApp();

beforeEach(async () => {
  await truncateAll();
});

describe('campaign isolation', () => {
  it('404s a campaign that belongs to another workspace', async () => {
    const alice = await makeAccount('alice');
    const a = await makeWorkspace(alice, 'A Co');
    const b = await makeWorkspace(alice, 'B Co');
    const inB = await prisma.campaign.create({ data: { workspaceId: b.id, name: 'B campaign' } });

    // Alice is a member of BOTH, so this is not a permission failure: the
    // campaign simply does not exist in workspace A.
    const res = await request(app)
      .get(`/api/workspaces/${a.id}/campaigns/${inB.id}`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('403s a workspace the caller is not a member of', async () => {
    await makeAccount('alice');
    const bob = await makeAccount('bob');
    const b = await makeWorkspace(bob, 'B Co');

    const res = await request(app)
      .get(`/api/workspaces/${b.id}/campaigns`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(403);
  });

  it('never lists another workspace campaign', async () => {
    const alice = await makeAccount('alice');
    const a = await makeWorkspace(alice, 'A Co');
    const b = await makeWorkspace(alice, 'B Co');
    await prisma.campaign.create({ data: { workspaceId: a.id, name: 'Mine' } });
    await prisma.campaign.create({ data: { workspaceId: b.id, name: 'Theirs' } });

    const res = await request(app)
      .get(`/api/workspaces/${a.id}/campaigns`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data.campaigns).toHaveLength(1);
    expect(res.body.data.campaigns[0].name).toBe('Mine');
  });

  it('404s a PATCH and a DELETE across the boundary, leaving the row alone', async () => {
    const alice = await makeAccount('alice');
    const a = await makeWorkspace(alice, 'A Co');
    const b = await makeWorkspace(alice, 'B Co');
    const inB = await prisma.campaign.create({ data: { workspaceId: b.id, name: 'B campaign' } });
    const auth = as('user_alice', 'alice@ezo.test');

    const patch = await request(app)
      .patch(`/api/workspaces/${a.id}/campaigns/${inB.id}`)
      .set(...auth)
      .send({ name: 'hijacked' });
    expect(patch.status).toBe(404);
    // Our envelope, not Express's default HTML 404 — this asserts the route
    // exists and scoped the lookup, rather than that it is simply absent.
    expect(patch.body.error.code).toBe('NOT_FOUND');

    const del = await request(app)
      .delete(`/api/workspaces/${a.id}/campaigns/${inB.id}`)
      .set(...auth);
    expect(del.status).toBe(404);
    expect(del.body.error.code).toBe('NOT_FOUND');

    const still = await prisma.campaign.findUniqueOrThrow({ where: { id: inB.id } });
    expect(still.name).toBe('B campaign');
  });
});

describe('campaign role gating', () => {
  it('lets a MEMBER read but not create', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const ws = await makeWorkspace(alice, 'A Co');
    await addMember(ws, bob, 'MEMBER');
    await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'Q3 outreach' } });

    const read = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns`)
      .set(...as('user_bob', 'bob@ezo.test'));
    expect(read.status).toBe(200);
    expect(read.body.data.campaigns).toHaveLength(1);

    const write = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns`)
      .set(...as('user_bob', 'bob@ezo.test'))
      .send({ name: 'Nope' });
    expect(write.status).toBe(403);
  });

  it('refuses a MEMBER on PATCH and DELETE', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const ws = await makeWorkspace(alice, 'A Co');
    await addMember(ws, bob, 'MEMBER');
    const c = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'C' } });
    const auth = as('user_bob', 'bob@ezo.test');

    const patch = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${c.id}`)
      .set(...auth)
      .send({ name: 'x' });
    expect(patch.status).toBe(403);

    const del = await request(app)
      .delete(`/api/workspaces/${ws.id}/campaigns/${c.id}`)
      .set(...auth);
    expect(del.status).toBe(403);
  });
});

describe('POST /api/workspaces/:id/campaigns', () => {
  it('creates a DRAFT campaign', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');

    const res = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ name: 'Q3 outreach' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'Q3 outreach',
      status: 'DRAFT',
      agentId: null,
      contactCount: 0,
      // Two RETRIES after the first call, not three dials.
      retryCount: 2,
      cooldownMinutes: 120,
    });
  });

  it('rejects a blank name', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');

    const res = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ name: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/workspaces/:id/campaigns', () => {
  it('filters by status and reports contact counts', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const draft = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'Draft one' } });
    await prisma.campaign.create({
      data: {
        workspaceId: ws.id,
        name: 'Running one',
        status: 'RUNNING',
        agentId: (await makeAgent(ws, 'Sales')).id,
      },
    });
    const contact = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+919876543210' },
    });
    await prisma.campaignContact.create({ data: { campaignId: draft.id, contactId: contact.id } });

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns?status=DRAFT`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data.campaigns).toHaveLength(1);
    expect(res.body.data.campaigns[0]).toMatchObject({ name: 'Draft one', contactCount: 1 });
  });

  /**
   * The filter has to accept every status the dispatcher can write, not only
   * the ones a person can choose. `CREDIT_EXHAUSTED` is written by the
   * dispatcher when the owner's balance runs out, the campaigns page offers it
   * as the "Out of credits" tab, and an enum that omits it turns that tab into
   * a 400.
   */
  it('filters by a status only the dispatcher writes', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Out of credits', status: 'CREDIT_EXHAUSTED' },
    });
    await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Still running', status: 'RUNNING' },
    });

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns?status=CREDIT_EXHAUSTED`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data.campaigns.map((c: { name: string }) => c.name)).toEqual([
      'Out of credits',
    ]);
  });

  it('rejects an unknown status filter', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns?status=BANANA`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/workspaces/:id/campaigns/:cid', () => {
  /**
   * An admin who learned another workspace's agent id must not be able to
   * point their own campaign at it. Foreign, retired and nonexistent ids all
   * share one 422 `CAMPAIGN_AGENT_NOT_FOUND`, so the status cannot be used to
   * sort ids into real and unreal.
   */
  it('refuses an agent that belongs to another workspace', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'A Co');
    const theirs = await makeWorkspace(bob, 'B Co');
    const hidden = await prisma.agent.create({
      data: { externalId: 'ext-theirs', name: 'Theirs', workspaceId: theirs.id },
    });
    const c = await prisma.campaign.create({ data: { workspaceId: mine.id, name: 'Mine' } });

    const res = await request(app)
      .patch(`/api/workspaces/${mine.id}/campaigns/${c.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ agentId: hidden.id });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CAMPAIGN_AGENT_NOT_FOUND');
    // Unchanged, not partially applied.
    expect((await prisma.campaign.findUnique({ where: { id: c.id } }))?.agentId).toBeNull();
  });

  it('refuses an agent id that names nothing at all, the same way', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const c = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'Mine' } });

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${c.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ agentId: 'agt_does_not_exist' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CAMPAIGN_AGENT_NOT_FOUND');
  });

  it('still allows clearing the agent', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await prisma.agent.create({
      data: { externalId: 'ext-a', name: 'Reception', workspaceId: ws.id },
    });
    const c = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Mine', agentId: agent.id },
    });

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${c.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ agentId: null });

    expect(res.status).toBe(200);
    expect(res.body.data.agentId).toBeNull();
  });

  it('updates name, agent and dialing config', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const c = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'Old' } });
    const agent = await makeAgent(ws, 'Sales');

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${c.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({
        name: 'New',
        agentId: agent.id,
        fromTime: '09:00',
        toTime: '18:00',
        timezone: 'Asia/Kolkata',
        defaultCountry: 'IN',
        retryCount: 5,
        cooldownMinutes: 45,
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'New',
      agentId: agent.id,
      fromTime: '09:00',
      toTime: '18:00',
      timezone: 'Asia/Kolkata',
      defaultCountry: 'IN',
      retryCount: 5,
      cooldownMinutes: 45,
    });
  });

  it('rejects a malformed window, timezone, country or retry setting', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const c = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'C' } });
    const url = `/api/workspaces/${ws.id}/campaigns/${c.id}`;
    const auth = as('user_alice', 'alice@ezo.test');

    for (const body of [
      { fromTime: '9am' },
      { fromTime: '25:00' },
      { toTime: '18:60' },
      { timezone: 'Mars/Olympus' },
      { defaultCountry: 'XX' },
      // 0 retries is legal — it means "call once". 21 is not.
      { retryCount: 21 },
      // 0 minutes is not: it is the dispatcher re-dialing a number the moment
      // it hung up.
      { cooldownMinutes: 0 },
    ]) {
      const res = await request(app).patch(url).set(...auth).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('normalizes a lowercase country code', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const c = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'C' } });

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${c.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ defaultCountry: 'in' });

    expect(res.body.data.defaultCountry).toBe('IN');
  });

  it('clears the agent and the window when sent null', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const c = await prisma.campaign.create({
      data: {
        workspaceId: ws.id,
        name: 'C',
        agentId: (await makeAgent(ws, 'Sales')).id,
        fromTime: '09:00',
      },
    });

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${c.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ agentId: null, fromTime: null });

    expect(res.body.data.agentId).toBeNull();
    expect(res.body.data.fromTime).toBeNull();
  });
});

describe('DELETE /api/workspaces/:id/campaigns/:cid', () => {
  it('deletes a DRAFT campaign and its membership rows, keeping the contacts', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const c = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'C' } });
    const contact = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+919876543210' },
    });
    await prisma.campaignContact.create({ data: { campaignId: c.id, contactId: contact.id } });

    const res = await request(app)
      .delete(`/api/workspaces/${ws.id}/campaigns/${c.id}`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(await prisma.campaignContact.count()).toBe(0);
    // The contact belongs to the workspace, not to the campaign.
    expect(await prisma.contact.count()).toBe(1);
  });

  it('deletes from STOPPED and COMPLETED too', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');

    for (const status of ['STOPPED', 'COMPLETED'] as const) {
      const c = await prisma.campaign.create({
        data: { workspaceId: ws.id, name: status, status },
      });
      const res = await request(app)
        .delete(`/api/workspaces/${ws.id}/campaigns/${c.id}`)
        .set(...as('user_alice', 'alice@ezo.test'));
      expect(res.status, status).toBe(200);
    }
  });

  /**
   * Deleting a live campaign used to be refused. It no longer is: the call
   * history survives the delete with its campaign pointers nulled, so nothing
   * is destroyed that anybody is billed for, and the queue behind it goes with
   * the campaign. The refusal was asking an operator to stop a campaign before
   * they were allowed to remove it, which is two clicks for one intention.
   */
  it('deletes from RUNNING and PAUSED too', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');

    for (const status of ['RUNNING', 'PAUSED'] as const) {
      const c = await prisma.campaign.create({
        data: { workspaceId: ws.id, name: status, status },
      });
      const res = await request(app)
        .delete(`/api/workspaces/${ws.id}/campaigns/${c.id}`)
        .set(...as('user_alice', 'alice@ezo.test'));

      expect(res.status, status).toBe(200);
    }

    expect(await prisma.campaign.count()).toBe(0);
  });

  /**
   * A delete is an end like a stop or a completion, and the managed goal
   * block comes off the agent the same way — gated inside the release on no
   * other live goal campaign sharing the agent. The row is already gone by
   * the time the release counts, which is exactly right: a campaign that no
   * longer exists is not a reason for its agent to carry the block.
   */
  it('takes the managed goal block off the agent when a goal campaign is deleted', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'caller');
    const c = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'G', agentId: agent.id, status: 'RUNNING', goalEnabled: true },
    });
    vi.mocked(getAgent).mockResolvedValue({ prompt: withGoalBlock('You are Asha.') });
    vi.mocked(updateAgent).mockClear();

    const res = await request(app)
      .delete(`/api/workspaces/${ws.id}/campaigns/${c.id}`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(updateAgent).toHaveBeenCalledWith(agent.externalId, { prompt: 'You are Asha.' });
  });

  /** The release is per AGENT, not per campaign: a second live campaign on
   *  the same agent keeps the block, because that campaign still needs it. */
  it('leaves the agent alone while another live campaign still points at it', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'caller');
    const c = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'P', agentId: agent.id, status: 'RUNNING' },
    });
    await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q', agentId: agent.id, status: 'RUNNING' },
    });
    vi.mocked(getAgent).mockClear();
    vi.mocked(updateAgent).mockClear();

    const res = await request(app)
      .delete(`/api/workspaces/${ws.id}/campaigns/${c.id}`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(getAgent).not.toHaveBeenCalled();
    expect(updateAgent).not.toHaveBeenCalled();
  });
});

/**
 * The parity configuration, on both write paths.
 *
 * Create and update take the same field set through the same validators, so
 * the two cannot drift into accepting different things — which is how a
 * campaign ends up holding a value one endpoint refuses and the other stores.
 */
describe('campaign parity configuration', () => {
  const AUTH = as('user_alice', 'alice@ezo.test');

  async function workspace() {
    const alice = await makeAccount('alice');

    return makeWorkspace(alice, 'A Co');
  }

  const create = (wsId: string, body: Record<string, unknown>) =>
    request(app).post(`/api/workspaces/${wsId}/campaigns`).set(...AUTH).send(body);

  const patch = (wsId: string, id: string, body: Record<string, unknown>) =>
    request(app).patch(`/api/workspaces/${wsId}/campaigns/${id}`).set(...AUTH).send(body);

  /**
   * A campaign with no window dials around the clock, and "around the clock"
   * is not a thing anybody chose. The default is a working day in the
   * campaign's own timezone, which the operator can then widen deliberately.
   */
  it('gives a new campaign a working-day window in a real timezone', async () => {
    const ws = await workspace();

    const res = await create(ws.id, { name: 'Q3' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      fromTime: '09:00',
      toTime: '21:00',
      timezone: 'Asia/Kolkata',
    });
  });

  it('keeps a window the caller supplied', async () => {
    const ws = await workspace();

    const res = await create(ws.id, {
      name: 'Q3',
      fromTime: '11:00',
      toTime: '13:00',
      timezone: 'Europe/Berlin',
    });

    expect(res.body.data).toMatchObject({
      fromTime: '11:00',
      toTime: '13:00',
      timezone: 'Europe/Berlin',
    });
  });

  it('accepts the whole configuration at create', async () => {
    const ws = await workspace();

    const res = await create(ws.id, {
      name: 'Q3',
      description: '  Winter outreach  ',
      retryCount: 4,
      cooldownMinutes: 15,
      retryDelaysMinutes: [5, 10, 0],
      concurrencyLimit: 6,
      retryConcurrency: 2,
      callbackEnabled: false,
      variableMap: { 'First Name': 'first_name' },
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      description: 'Winter outreach',
      retryCount: 4,
      cooldownMinutes: 15,
      retryDelaysMinutes: [5, 10, 0],
      concurrencyLimit: 6,
      retryConcurrency: 2,
      variableMap: { 'First Name': 'first_name' },
    });
    // Accepted and ignored: callbacks are on for every campaign, and the
    // `false` in that body is a stale dashboard's, not an operator's — there
    // is no control that produces it any more.
    expect(res.body.data.callbackEnabled).toBe(true);
  });

  /**
   * Callbacks cannot be turned off, on any path.
   *
   * The switch is gone from every screen and the stored `false`s were
   * backfilled, so the only remaining source of one is a dashboard from before
   * this release. A 400 would fail a save the operator did make; storing it
   * would leave a campaign refusing callbacks with nothing left anywhere able
   * to turn them back on. Accepted and ignored is the only door that is
   * neither.
   */
  it('creates with callbacks on however the body spells it', async () => {
    const ws = await workspace();

    const res = await create(ws.id, { name: 'Quiet', callbackEnabled: false });

    expect(res.status).toBe(201);
    expect(res.body.data.callbackEnabled).toBe(true);
  });

  /** And the same on the edit path, where a stale form posts the whole body
   *  back: a no-op rather than the 409 a locked field would earn. */
  it('leaves callbacks on when a paused campaign is patched with false', async () => {
    const ws = await workspace();
    const c = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Paused', status: 'PAUSED' },
    });

    const res = await patch(ws.id, c.id, { callbackEnabled: false });

    expect(res.status).toBe(200);
    expect(res.body.data.callbackEnabled).toBe(true);
    expect((await prisma.campaign.findUnique({ where: { id: c.id } }))!.callbackEnabled).toBe(true);
  });

  /** The type is still refused, because a body carrying `"false"` was built by
   *  something that believes the switch is still there. */
  it('still refuses a non-boolean callbackEnabled', async () => {
    const ws = await workspace();
    const c = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'C' } });

    expect((await patch(ws.id, c.id, { callbackEnabled: 'false' })).status).toBe(400);
    expect((await create(ws.id, { name: 'X', callbackEnabled: 0 })).status).toBe(400);
  });

  /** `null` is the fourth window field's spelling of "no restriction", the
   *  same as `[]`, so a form clearing the whole window is not a 400 on one of
   *  the four. */
  it('creates with a null dialDays as every day', async () => {
    const ws = await workspace();

    const res = await create(ws.id, { name: 'Always', dialDays: null });

    expect(res.status).toBe(201);
    expect(res.body.data.dialDays).toEqual([]);
  });

  it('stores an all-whitespace description as no description', async () => {
    const ws = await workspace();

    const res = await create(ws.id, { name: 'Q3', description: '   ' });

    expect(res.body.data.description).toBeNull();
  });

  it('updates the whole configuration', async () => {
    const ws = await workspace();
    const c = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'Old' } });

    const res = await patch(ws.id, c.id, {
      description: 'New note',
      retryCount: 0,
      cooldownMinutes: 10080,
      retryDelaysMinutes: [],
      concurrencyLimit: 3,
      retryConcurrency: 3,
      callbackEnabled: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      description: 'New note',
      retryCount: 0,
      cooldownMinutes: 10080,
      retryDelaysMinutes: [],
      concurrencyLimit: 3,
      retryConcurrency: 3,
      callbackEnabled: true,
    });
  });

  it('refuses every out-of-range setting, on create and on update', async () => {
    const ws = await workspace();
    const c = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'C' } });

    for (const body of [
      { retryCount: 21 },
      { retryCount: -1 },
      { retryCount: '2' },
      { cooldownMinutes: 0 },
      { cooldownMinutes: 10081 },
      { retryDelaysMinutes: 5 },
      { retryDelaysMinutes: [10081] },
      { retryDelaysMinutes: Array.from({ length: 21 }, () => 1) },
      { concurrencyLimit: 2.5 },
      { retryConcurrency: -1 },
      { callbackEnabled: 'false' },
      { variableMap: [] },
      { variableMap: { Name: '1st' } },
    ]) {
      const label = JSON.stringify(body);

      expect((await patch(ws.id, c.id, body)).status, `PATCH ${label}`).toBe(400);
      expect((await create(ws.id, { name: 'X', ...body })).status, `POST ${label}`).toBe(400);
    }
  });

  /**
   * The one field that clamps, asserted so the exception stays deliberate.
   */
  it('clamps an absurd concurrency limit instead of refusing it', async () => {
    const ws = await workspace();

    const res = await create(ws.id, { name: 'Q3', concurrencyLimit: 999 });

    expect(res.status).toBe(201);
    expect(res.body.data.concurrencyLimit).toBe(MAX_CONCURRENCY_LIMIT);
  });

  it('validates the retry reservation against the limit the same request sets', async () => {
    const ws = await workspace();
    const c = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'C', concurrencyLimit: 2, retryConcurrency: 0 },
    });

    // Raising both at once is fine; raising the reservation alone is not.
    expect((await patch(ws.id, c.id, { concurrencyLimit: 8, retryConcurrency: 7 })).status).toBe(
      200,
    );
    const res = await patch(ws.id, c.id, { retryConcurrency: 9 });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('retryConcurrency');
  });

  it('refuses lowering the limit under a reservation the body leaves alone', async () => {
    const ws = await workspace();
    const c = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'C', concurrencyLimit: 8, retryConcurrency: 6 },
    });

    const res = await patch(ws.id, c.id, { concurrencyLimit: 4 });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('retryConcurrency (6)');

    // ...and accepts it when both come down together.
    expect((await patch(ws.id, c.id, { concurrencyLimit: 4, retryConcurrency: 3 })).status).toBe(
      200,
    );
  });

  /**
   * SQL NULL, not JSON null: the dispatcher's "is there a mapping" test is
   * `variableMap IS NULL`, and the two are indistinguishable in a response
   * body.
   */
  it('clears a variable map to SQL NULL', async () => {
    const ws = await workspace();
    const c = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'C', variableMap: { A: 'a' } },
    });

    const res = await patch(ws.id, c.id, { variableMap: null });

    expect(res.status).toBe(200);
    expect(res.body.data.variableMap).toBeNull();

    const rows = await prisma.$queryRaw<{ isNull: boolean }[]>`
      SELECT "variableMap" IS NULL AS "isNull" FROM "Campaign" WHERE id = ${c.id}
    `;
    expect(rows[0]!.isNull).toBe(true);
  });
});

describe('the campaign dialing rotation', () => {
  const AUTH = as('user_alice', 'alice@ezo.test');

  async function seed() {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const first = await makePhoneNumber(ws, '+1415111');
    const second = await makePhoneNumber(ws, '+1415222');
    const third = await makePhoneNumber(ws, '+1415333');

    return { ws, first, second, third };
  }

  const patch = (wsId: string, id: string, body: Record<string, unknown>) =>
    request(app).patch(`/api/workspaces/${wsId}/campaigns/${id}`).set(...AUTH).send(body);

  it('attaches numbers in the order given and points the legacy field at the first', async () => {
    const { ws, first, second } = await seed();
    const c = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'C' } });

    const res = await patch(ws.id, c.id, { phoneNumberIds: [second.id, first.id] });

    expect(res.status).toBe(200);
    expect(res.body.data.phoneNumberIds).toEqual([second.id, first.id]);
    // The order the operator gave IS the rotation order.
    expect(res.body.data.phoneNumberId).toBe(second.id);

    const rows = await prisma.campaignPhoneNumber.findMany({
      where: { campaignId: c.id },
      orderBy: { position: 'asc' },
    });
    expect(rows.map((r) => [r.position, r.phoneNumberId])).toEqual([
      [0, second.id],
      [1, first.id],
    ]);
  });

  it('replaces the whole rotation rather than appending to it', async () => {
    const { ws, first, second, third } = await seed();
    const c = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'C' } });

    await patch(ws.id, c.id, { phoneNumberIds: [first.id, second.id] });
    const res = await patch(ws.id, c.id, { phoneNumberIds: [third.id] });

    expect(res.body.data.phoneNumberIds).toEqual([third.id]);
    expect(res.body.data.phoneNumberId).toBe(third.id);
    expect(await prisma.campaignPhoneNumber.count({ where: { campaignId: c.id } })).toBe(1);
  });

  it('clears the rotation and the legacy pointer with an empty list', async () => {
    const { ws, first } = await seed();
    const c = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'C' } });

    await patch(ws.id, c.id, { phoneNumberIds: [first.id] });
    const res = await patch(ws.id, c.id, { phoneNumberIds: [] });

    expect(res.body.data.phoneNumberIds).toEqual([]);
    expect(res.body.data.phoneNumberId).toBeNull();
  });

  /**
   * A duplicate is refused rather than de-duplicated: the list is a rotation
   * order, and silently collapsing it would make the campaign dial from a
   * pattern the operator did not describe.
   */
  it('refuses a duplicated number', async () => {
    const { ws, first } = await seed();
    const c = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'C' } });

    const res = await patch(ws.id, c.id, { phoneNumberIds: [first.id, first.id] });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('once');
  });

  it('refuses more than twenty numbers', async () => {
    const { ws, first } = await seed();
    const c = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'C' } });

    const res = await patch(ws.id, c.id, {
      phoneNumberIds: Array.from({ length: 21 }, (_, i) => `${first.id}${i}`),
    });

    expect(res.status).toBe(400);
  });

  /**
   * Every id is re-resolved against this workspace, exactly as the single
   * number always was. One 422 for a number that does not exist, one that is
   * back in the pool, and one that belongs to somebody else — telling them
   * apart would let a caller sort real phone numbers from invented ones one
   * request at a time.
   */
  it('refuses a number this workspace cannot use, whatever the reason', async () => {
    const { ws, first } = await seed();
    const c = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'C' } });
    const pooled = await makePhoneNumber(null, '+1415999', 'UNASSIGNED');
    const bob = await makeAccount('bob');
    const theirs = await makePhoneNumber(await makeWorkspace(bob, 'B Co'), '+1415888');

    for (const bad of ['pn_nope', pooled.id, theirs.id]) {
      const res = await patch(ws.id, c.id, { phoneNumberIds: [first.id, bad] });

      expect(res.status, bad).toBe(422);
      expect(res.body.error.code).toBe('CAMPAIGN_PHONE_NUMBER_NOT_FOUND');
    }

    // Nothing was written: the whole list is validated before any of it lands.
    expect(await prisma.campaignPhoneNumber.count({ where: { campaignId: c.id } })).toBe(0);
  });

  /**
   * Swapping the rotation mid-dial is allowed, and emptying it is not: the
   * dispatcher re-reads the attachments every pass, so a new list lands on the
   * next tick, while a list with nothing in it leaves the campaign holding its
   * queue with nothing on screen to say why.
   */
  it('rotates a RUNNING campaign onto a different number', async () => {
    const { ws, first, second } = await seed();
    const c = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'C', phoneNumberId: first.id, status: 'DRAFT' },
    });
    await patch(ws.id, c.id, { phoneNumberIds: [first.id] });
    await prisma.campaign.update({ where: { id: c.id }, data: { status: 'RUNNING' } });

    const res = await patch(ws.id, c.id, { phoneNumberIds: [second.id] });

    expect(res.status).toBe(200);
    expect(
      (
        await prisma.campaignPhoneNumber.findMany({
          where: { campaignId: c.id },
          orderBy: { position: 'asc' },
        })
      ).map((row) => row.phoneNumberId),
    ).toEqual([second.id]);

    const emptied = await patch(ws.id, c.id, { phoneNumberIds: [] });
    expect(emptied.status).toBe(409);
    expect(emptied.body.error.code).toBe('CAMPAIGN_NEEDS_PHONE_NUMBER');
  });

  /**
   * The dashboard sends the whole form. Resubmitting the rotation a campaign
   * already has is not a change, so it must not make every other edit on the
   * page fail — on a running campaign, where nothing else is editable either,
   * and on a paused one, where the retry policy still is.
   */
  it('accepts the rotation a campaign already has', async () => {
    const { ws, first, second } = await seed();
    const c = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'C' } });
    await patch(ws.id, c.id, { phoneNumberIds: [first.id, second.id] });
    await prisma.campaign.update({ where: { id: c.id }, data: { status: 'RUNNING' } });

    const running = await patch(ws.id, c.id, { phoneNumberIds: [first.id, second.id] });
    expect(running.status).toBe(200);

    await prisma.campaign.update({ where: { id: c.id }, data: { status: 'PAUSED' } });

    const paused = await patch(ws.id, c.id, {
      phoneNumberIds: [first.id, second.id],
      retryCount: 4,
    });

    expect(paused.status).toBe(200);
    expect(paused.body.data.retryCount).toBe(4);
  });

  it('takes a rotation at create', async () => {
    const { ws, first, second } = await seed();

    const res = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns`)
      .set(...AUTH)
      .send({ name: 'Q3', phoneNumberIds: [first.id, second.id] });

    expect(res.status).toBe(201);
    expect(res.body.data.phoneNumberIds).toEqual([first.id, second.id]);
    expect(res.body.data.phoneNumberId).toBe(first.id);
  });

  /**
   * A campaign that predates the rotation still has its single number, and
   * `phoneNumberIds` must describe what it will actually dial from rather than
   * reporting an empty rotation beside a populated legacy pointer.
   */
  it('reports the legacy pointer as the rotation when no join rows exist', async () => {
    const { ws, first } = await seed();
    const c = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'C', phoneNumberId: first.id },
    });

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${c.id}`)
      .set(...AUTH);

    expect(res.body.data.phoneNumberIds).toEqual([first.id]);
  });
});

/**
 * The goal on create and on PATCH.
 *
 * A switch now — the objective itself lives in the agent's own prompt — so it
 * is a fact about the campaign alone. Nothing on the agent constrains it,
 * moving the agent underneath cannot invalidate it, and clearing the agent is
 * not a reason to refuse a campaign its goal.
 */
describe('the goal on the wire', () => {
  const AUTH = as('user_alice', 'alice@ezo.test');

  async function seedGoal(goalEnabled = true) {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Sales');

    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', status: 'DRAFT', agentId: agent.id, goalEnabled },
    });

    return { ws, agent, campaign };
  }

  const patch = (wsId: string, id: string, body: Record<string, unknown>) =>
    request(app).patch(`/api/workspaces/${wsId}/campaigns/${id}`).set(...AUTH).send(body);

  const create = (wsId: string, body: Record<string, unknown>) =>
    request(app).post(`/api/workspaces/${wsId}/campaigns`).set(...AUTH).send(body);

  it('round-trips the switch given at create time', async () => {
    const { ws } = await seedGoal();

    const res = await create(ws.id, { name: 'Renewals', goalEnabled: true });

    expect(res.status).toBe(201);
    expect(res.body.data.goalEnabled).toBe(true);
  });

  /** Nothing to say about the switch is the ordinary case, and the ordinary
   *  case follows people up: the payload reports what the engine does. */
  it('creates following up when the caller says nothing', async () => {
    const { ws } = await seedGoal();

    const res = await create(ws.id, { name: 'Renewals' });

    expect(res.status).toBe(201);
    expect(res.body.data.goalEnabled).toBe(true);
  });

  /** A caller who explicitly turns it OFF is accepted, stored — and still
   *  answered `true`, because the engine does not read the column. */
  it('accepts the switch off, stores it, and still answers true', async () => {
    const { ws } = await seedGoal();

    const res = await create(ws.id, { name: 'Renewals', goalEnabled: false });

    expect(res.status).toBe(201);
    expect(res.body.data.goalEnabled).toBe(true);
    expect(
      (await prisma.campaign.findUniqueOrThrow({ where: { id: res.body.data.id } })).goalEnabled,
    ).toBe(false);
  });

  /**
   * The deprecated prose column, accepted and ignored for one release.
   *
   * Only the dashboard ever sent it and no V2 partner surface exposes it, but
   * the two deploy independently: a dashboard still carrying the textarea must
   * not have its saves refused by a backend that has stopped reading it. It is
   * not stored either — the response carries the switch and no wording, and
   * the column stays at its default.
   */
  it('accepts and ignores a goal in a create body', async () => {
    const { ws } = await seedGoal();

    const res = await create(ws.id, { name: 'Renewals', goal: 'Confirm they are still looking' });

    expect(res.status).toBe(201);
    expect(res.body.data.goal).toBeUndefined();
    expect(res.body.data.goalEnabled).toBe(true);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: res.body.data.id } })).goal)
      .toBeNull();
  });

  /** The same on the way in through PATCH, and on a campaign that has left
   *  DRAFT: the skew is not confined to campaigns nobody has started. */
  it('accepts and ignores a goal in a patch body', async () => {
    const { ws, campaign } = await seedGoal();
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'PAUSED' } });

    const res = await patch(ws.id, campaign.id, { goal: 'Book a demo instead' });

    expect(res.status).toBe(200);
    expect(res.body.data.goal).toBeUndefined();
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).goal)
      .toBeNull();
  });

  /**
   * A body carrying the retired key list is not an error — the create schema
   * strips every field it does not name, so the old shape reaches no column —
   * and the response says so by carrying the prose goal alone.
   *
   * Asserted through an unknown field rather than by naming the dead one: the
   * wave's verification grep is "no source or test mentions the old names",
   * and a test written to prove the name is gone would be the one hit that
   * makes the grep unreadable.
   */
  it('ignores a retired field in a create body', async () => {
    const { ws } = await seedGoal();

    const res = await create(ws.id, { name: 'Renewals', someRetiredField: ['city'] });

    expect(res.status).toBe(201);
    expect(res.body.data.goalEnabled).toBe(true);
    expect(res.body.data.someRetiredField).toBeUndefined();
  });

  /**
   * The behaviour the old key list could not have: moving the agent under a
   * campaign whose goal switch is on is now an ordinary edit. The switch says
   * to follow up until the conversation is finished, not which keys that agent
   * extracts, so there is nothing to re-judge and nothing to refuse.
   */
  it('leaves the switch standing when the agent moves', async () => {
    const { ws, campaign } = await seedGoal();
    const other = await makeAgent(ws, 'Support');

    const res = await patch(ws.id, campaign.id, { agentId: other.id });

    expect(res.status).toBe(200);
    expect(res.body.data.goalEnabled).toBe(true);
  });

  it('lets the agent be cleared while the switch is on', async () => {
    const { ws, campaign } = await seedGoal();

    const res = await patch(ws.id, campaign.id, { agentId: null });

    expect(res.status).toBe(200);
    expect(res.body.data.agentId).toBeNull();
    expect(res.body.data.goalEnabled).toBe(true);
  });
});

/**
 * The `goal` block on each row of the contacts list.
 *
 * The three prose fields the goal record carries, drawn from one `IN` query
 * over the page — never one query per row — and `null` rather than an empty
 * record on a campaign with no goal, so the dashboard can tell "this campaign
 * does not have a goal" from "nothing learned yet". Those are different rows.
 */
describe('the goal context on the contacts list', () => {
  const AUTH = as('user_alice', 'alice@ezo.test');

  let seq = 0;

  async function seedList(goalEnabled: boolean) {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', status: 'RUNNING', goalEnabled },
    });

    return { ws, campaign };
  }

  async function addContact(
    ctx: Awaited<ReturnType<typeof seedList>>,
    record?: { memory?: string; lastCallNote?: string; goalMissing?: string },
  ) {
    seq += 1;
    const contact = await prisma.contact.create({
      data: {
        workspaceId: ctx.ws.id,
        phone: `+9198765${String(51000 + seq).slice(-5)}`,
        name: `C${seq}`,
      },
    });
    const link = await prisma.campaignContact.create({
      data: { campaignId: ctx.campaign.id, contactId: contact.id },
    });

    if (record) {
      await prisma.campaignContactGoal.create({
        data: { campaignContactId: link.id, ...record },
      });
    }

    return link;
  }

  const list = (ctx: Awaited<ReturnType<typeof seedList>>) =>
    request(app)
      .get(`/api/workspaces/${ctx.ws.id}/campaigns/${ctx.campaign.id}/contacts`)
      .set(...AUTH);

  /** Present on every campaign now, the stored switch included. An empty
   *  block is "nothing learned yet", which is a different fact from the null
   *  this used to carry — and there is no campaign left for that null to
   *  describe. */
  it('is an empty block on a campaign whose stored switch is off', async () => {
    const ctx = await seedList(false);
    await addContact(ctx);

    const res = await list(ctx);

    expect(res.status).toBe(200);
    expect(res.body.data.contacts[0].goal).toEqual({
      memory: null,
      lastCallNote: '',
      goalMissing: null,
    });
  });

  it('carries the call note, the last-call line, and a missing line a previous release left', async () => {
    const ctx = await seedList(true);
    await addContact(ctx, {
      memory: 'Asha, looking in Baner, 2BHK.',
      lastCallNote: 'spoke, worth calling again: wants to check with her husband',
      goalMissing: 'the budget and the move-in month',
    });

    expect((await list(ctx)).body.data.contacts[0].goal).toEqual({
      memory: 'Asha, looking in Baner, 2BHK.',
      lastCallNote: 'spoke, worth calling again: wants to check with her husband',
      goalMissing: 'the budget and the move-in month',
    });
  });

  /**
   * No record yet is "nothing learned yet", and is not the same as `null`,
   * which means the campaign has no goal. The note is `''` rather than null
   * because YE writes it on every recorded attempt — so an empty one means
   * no attempt has resolved, and the row never has to guess. `goalMissing`
   * is in the shape and null: nothing writes it under the call-note contract.
   */
  it('falls back to the empty context for a contact with no record', async () => {
    const ctx = await seedList(true);
    await addContact(ctx);

    expect((await list(ctx)).body.data.contacts[0].goal)
      .toEqual({ memory: null, lastCallNote: '', goalMissing: null });
  });

  it('draws every row of a page, recorded or not', async () => {
    const ctx = await seedList(true);
    await addContact(ctx, { memory: 'Asha, Baner.', lastCallNote: 'reached voicemail' });
    await addContact(ctx);

    const notes = (await list(ctx)).body.data.contacts.map(
      (row: { goal: { lastCallNote: string } }) => row.goal.lastCallNote,
    );

    expect(notes.sort()).toEqual(['', 'reached voicemail']);
  });
});
