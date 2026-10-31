import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, makeAccount, makeWorkspace } from './helpers.js';

const TOKEN = 'staff-token-for-tests';
process.env.ADMIN_STAFF_TOKEN = TOKEN;

const { createApp } = await import('../src/app.js');

const app = createApp();
const staff = () => ['X-Admin-Token', TOKEN] as [string, string];

beforeEach(async () => {
  await truncateAll();
});

describe('GET /api/admin/overview', () => {
  it('rejects a request without a staff token', async () => {
    const res = await request(app).get('/api/admin/overview');

    expect(res.status).toBe(401);
  });

  it('counts an empty platform as zeroes rather than as missing keys', async () => {
    const res = await request(app).get('/api/admin/overview').set(...staff());

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      accounts: 0,
      workspaces: 0,
      agents: { total: 0, assigned: 0, unassigned: 0 },
      credits_outstanding: '0',
    });
    // Every campaign status appears, at zero. A console that omitted an empty
    // bucket would read as if that state did not exist.
    expect(res.body.data.campaigns).toEqual({
      DRAFT: 0,
      SCHEDULED: 0,
      RUNNING: 0,
      PAUSED: 0,
      COMPLETED: 0,
      STOPPED: 0,
      CREDIT_EXHAUSTED: 0,
    });
  });

  it('counts accounts, workspaces and the agent pool', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const workspace = await makeWorkspace(alice, 'Acme');
    await addMember(workspace, bob, 'MEMBER');
    await prisma.agent.create({
      data: { externalId: 'ext-1', name: 'Assigned', workspaceId: workspace.id },
    });
    await prisma.agent.create({ data: { externalId: 'ext-2', name: 'Pooled' } });
    await prisma.agent.create({ data: { externalId: 'ext-3', name: 'Pooled two' } });

    const res = await request(app).get('/api/admin/overview').set(...staff());

    expect(res.body.data.accounts).toBe(2);
    expect(res.body.data.workspaces).toBe(1);
    expect(res.body.data.agents).toEqual({ total: 3, assigned: 1, unassigned: 2 });
  });

  it('groups campaigns by status', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Acme');
    await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'a' } });
    await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'b' } });
    await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'c', status: 'RUNNING' },
    });

    const res = await request(app).get('/api/admin/overview').set(...staff());

    expect(res.body.data.campaigns.DRAFT).toBe(2);
    expect(res.body.data.campaigns.RUNNING).toBe(1);
    expect(res.body.data.campaigns.PAUSED).toBe(0);
  });

  it('sums the balances as a display string', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    await prisma.account.update({ where: { id: alice.id }, data: { credits: 100_5000n } });
    await prisma.account.update({ where: { id: bob.id }, data: { credits: 25n } });

    const res = await request(app).get('/api/admin/overview').set(...staff());

    expect(res.body.data.credits_outstanding).toBe('100.5025');
  });
});
