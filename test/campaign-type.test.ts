import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { as, makeAccount, makeAgent, makeWorkspace } from './helpers.js';

// No upstream call is made by create/PATCH, but every suite mocks the adapter
// so a stray one can never reach the live account.
vi.mock('../src/adapter/vocobase.js', () => ({
  voicelinkCallReady: vi.fn(async () => ({ ready: true, readiness: { state: 'READY', issues: [] } })),
  startCall: vi.fn(),
  getConcurrency: vi.fn(),
  getCall: vi.fn(),
  getAgent: vi.fn(),
  updateAgent: vi.fn(),
}));

const app = createApp();

async function inboundAgent(workspace: Awaited<ReturnType<typeof makeWorkspace>>, name = 'Support') {
  const agent = await makeAgent(workspace, name);
  return prisma.agent.update({ where: { id: agent.id }, data: { inboundEnabled: true } });
}

beforeEach(async () => {
  await truncateAll();
});

describe('campaign type', () => {
  it('creates an INBOUND campaign against an inbound-enabled agent', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await inboundAgent(ws);

    const res = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ name: 'Inbound line', agentId: agent.id, type: 'INBOUND' });

    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe('INBOUND');
  });

  /**
   * It used to refuse this with 422 `CAMPAIGN_AGENT_INBOUND_NOT_ENABLED`, and
   * that refusal is what made the lazy face unreachable: the face is built
   * when the campaign STARTS, so a gate at save time meant the campaign that
   * would trigger it could never be written down. A uni-directional agent
   * answers as readily as it dials; whether a second upstream configuration
   * exists yet is plumbing, and `runInboundStart` is what builds it.
   */
  it('accepts an inbound campaign on an agent that has no face yet', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Plain'); // no inbound face

    const res = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ name: 'Inbound line', agentId: agent.id, type: 'BOTH' });

    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe('BOTH');
  });

  it('defaults to OUTBOUND and needs no inbound agent', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Plain');

    const res = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ name: 'Outbound', agentId: agent.id });

    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe('OUTBOUND');
  });

  it('rejects an unknown type value', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');

    const res = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ name: 'Bad', type: 'SIDEWAYS' });

    expect(res.status).toBe(400);
  });

  it('lets a DRAFT campaign change its type', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await inboundAgent(ws);
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'C', status: 'DRAFT', agentId: agent.id },
    });

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ type: 'BOTH' });

    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('BOTH');
  });

  it('locks type on a RUNNING campaign', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await inboundAgent(ws);
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'C', status: 'RUNNING', agentId: agent.id, type: 'OUTBOUND' },
    });

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ type: 'BOTH' });

    // The edit gate refuses it; type is not a mid-campaign-editable field.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CAMPAIGN_CONFIG_LOCKED');
  });
});
