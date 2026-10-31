import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Account, Workspace } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { flushNotifications } from '../src/lib/notify.js';
import { truncateAll } from './setup.js';
import { addMember, as, makeAccount, makeAgent, makeDialable, makeWorkspace } from './helpers.js';

// `start` and `resume` now make the campaign's caller number outbound-ready
// upstream. Mocked, as every upstream call in this suite is.
vi.mock('../src/adapter/vocobase.js', () => ({
  voicelinkCallReady: vi.fn(async () => ({ ready: true, readiness: { state: 'READY', issues: [] } })),
  startCall: vi.fn(),
  getConcurrency: vi.fn(),
  getCall: vi.fn(),
  // The call-note set, attached on every start and resume. Stubbed as
  // "already set up" so these cases exercise the transition rather than it —
  // a set the platform cannot supply raises an ADMINS_ONLY notification of
  // its own, which would land ahead of the lifecycle row these assert on.
  listExtractionSets: vi.fn(async () => ({
    extraction_sets: [
      { id: 'set_cb', name: 'Campaign callbacks' },
      { id: 'set_note', name: 'Campaign call note' },
    ],
  })),
  createExtractionSet: vi.fn(),
  listAgentExtractionSets: vi.fn(async () => ({
    extraction_sets: [
      { id: 'set_cb', name: 'Campaign callbacks' },
      { id: 'set_note', name: 'Campaign call note' },
    ],
  })),
  attachAgentExtractionSet: vi.fn(),
  getAgent: vi.fn(async () => ({ extraction_enabled: true, prompt: 'You are Asha.' })),
  updateAgent: vi.fn(),
}));


const app = createApp();

let alice: Account; // owner / ADMIN
let bob: Account;
let workspace: Workspace;

const asAlice = () => as('user_alice', 'alice@ezo.test');
const asBob = () => as('user_bob', 'bob@ezo.test');

beforeEach(async () => {
  await truncateAll();
  alice = await makeAccount('alice');
  bob = await makeAccount('bob');
  workspace = await makeWorkspace(alice, 'A Co');
});

afterEach(() => vi.restoreAllMocks());

/** The rows the emitters wrote, oldest first. */
async function recorded() {
  await flushNotifications();
  return prisma.notification.findMany({ orderBy: { createdAt: 'asc' } });
}

async function pendingInvite(email: string, role: 'ADMIN' | 'MEMBER' = 'MEMBER') {
  return prisma.workspaceInvite.create({
    data: { workspaceId: workspace.id, email, role, invitedById: alice.id },
  });
}

async function memberId(accountId: string) {
  const member = await prisma.workspaceMember.findUniqueOrThrow({
    where: { workspaceId_accountId: { workspaceId: workspace.id, accountId } },
  });
  return member.id;
}

describe('invite events', () => {
  it('records an accepted invite for admins only', async () => {
    const invite = await pendingInvite('bob@ezo.test');

    const res = await request(app).post(`/api/invites/${invite.id}/accept`).set(...asBob());
    expect(res.status).toBe(200);

    const [row, ...rest] = await recorded();
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      workspaceId: workspace.id,
      scope: 'ADMINS_ONLY',
      type: 'invite.accepted',
    });
    expect(row!.body).toContain('bob@ezo.test');
  });

  it('records a declined invite for admins only', async () => {
    const invite = await pendingInvite('bob@ezo.test');

    await request(app).post(`/api/invites/${invite.id}/decline`).set(...asBob());

    const [row] = await recorded();
    expect(row).toMatchObject({ scope: 'ADMINS_ONLY', type: 'invite.declined' });
    expect(row!.body).toContain('bob@ezo.test');
  });

  it('records nothing when the invite was not the caller’s to act on', async () => {
    const invite = await pendingInvite('carol@ezo.test');

    const res = await request(app).post(`/api/invites/${invite.id}/accept`).set(...asBob());

    expect(res.status).toBe(403);
    await expect(recorded()).resolves.toHaveLength(0);
  });
});

describe('member events', () => {
  it('records a role change for admins only', async () => {
    await addMember(workspace, bob, 'MEMBER');

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/members/${await memberId(bob.id)}`)
      .set(...asAlice())
      .send({ role: 'ADMIN' });
    expect(res.status).toBe(200);

    const [row] = await recorded();
    expect(row).toMatchObject({ scope: 'ADMINS_ONLY', type: 'member.role_changed' });
    expect(row!.body).toContain('bob@ezo.test');
    expect(row!.body).toContain('admin');
  });

  it('distinguishes being removed from leaving', async () => {
    await addMember(workspace, bob, 'MEMBER');

    await request(app)
      .delete(`/api/workspaces/${workspace.id}/members/${await memberId(bob.id)}`)
      .set(...asAlice());

    const [removed] = await recorded();
    expect(removed).toMatchObject({ type: 'member.removed', scope: 'ADMINS_ONLY' });

    // …and again, this time with Bob walking out on his own.
    await prisma.notification.deleteMany();
    await addMember(workspace, bob, 'MEMBER');

    await request(app)
      .delete(`/api/workspaces/${workspace.id}/members/${await memberId(bob.id)}`)
      .set(...asBob());

    const [left] = await recorded();
    expect(left).toMatchObject({ type: 'member.left', scope: 'ADMINS_ONLY' });
    expect(left!.body).not.toContain('removed');
  });

  it('records nothing when the role did not actually change', async () => {
    await addMember(workspace, bob, 'MEMBER');

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/members/${await memberId(bob.id)}`)
      .set(...asAlice())
      .send({ role: 'MEMBER' });

    // A successful no-op. The feed records things that happened, and nothing
    // did — a "role changed" here sends the reader looking for a change nobody
    // made.
    expect(res.status).toBe(200);
    await expect(recorded()).resolves.toHaveLength(0);
  });

  it('records nothing when the change was refused', async () => {
    const ownerMember = await memberId(alice.id);

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/members/${ownerMember}`)
      .set(...asAlice())
      .send({ role: 'MEMBER' });

    expect(res.status).toBe(400);
    await expect(recorded()).resolves.toHaveLength(0);
  });
});

describe('campaign lifecycle events', () => {
  async function readyCampaign(status: 'DRAFT' | 'RUNNING' | 'PAUSED') {
    const agent = await makeAgent(workspace, 'Winter caller');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'Winter outreach', status, agentId: agent.id },
    });
    const contact = await prisma.contact.create({
      data: { workspaceId: workspace.id, phone: '+919876543210' },
    });
    await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });
    // A caller number, a priced tier and a balance: `start` refuses a campaign
    // that could not actually place a call.
    await makeDialable(workspace, campaign, agent);
    return campaign;
  }

  const cases = [
    ['DRAFT', 'start', 'campaign.started'],
    ['RUNNING', 'pause', 'campaign.paused'],
    ['PAUSED', 'resume', 'campaign.resumed'],
    ['RUNNING', 'stop', 'campaign.stopped'],
  ] as const;

  for (const [from, action, type] of cases) {
    it(`records ${action} for every member`, async () => {
      const campaign = await readyCampaign(from);

      const res = await request(app)
        .post(`/api/workspaces/${workspace.id}/campaigns/${campaign.id}/${action}`)
        .set(...asAlice());
      expect(res.status).toBe(200);

      const [row] = await recorded();
      expect(row).toMatchObject({
        scope: 'ALL_MEMBERS',
        type,
        href: `/campaigns/${campaign.id}`,
      });
      expect(row!.title).toContain('Winter outreach');
    });
  }

  it('records nothing when the transition was refused', async () => {
    const campaign = await readyCampaign('DRAFT');

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/campaigns/${campaign.id}/pause`)
      .set(...asAlice());

    expect(res.status).toBe(409);
    await expect(recorded()).resolves.toHaveLength(0);
  });
});

describe('when the notification cannot be written', () => {
  it('does not fail the action that triggered it', async () => {
    const invite = await pendingInvite('bob@ezo.test');
    vi.spyOn(prisma.notification, 'create').mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).post(`/api/invites/${invite.id}/accept`).set(...asBob());

    // The action stands on its own: a notification is a side effect of
    // something that has already happened, never a step in making it happen.
    expect(res.status).toBe(200);
    await expect(
      prisma.workspaceMember.findUnique({
        where: { workspaceId_accountId: { workspaceId: workspace.id, accountId: bob.id } },
      }),
    ).resolves.not.toBeNull();
    await expect(
      prisma.workspaceInvite.findUniqueOrThrow({ where: { id: invite.id } }),
    ).resolves.toMatchObject({ status: 'ACCEPTED' });

    await expect(flushNotifications()).resolves.toBeUndefined();
  });

  it('does not fail a campaign transition either', async () => {
    const agent = await makeAgent(workspace, 'Q3 caller');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'Q3', status: 'RUNNING', agentId: agent.id },
    });
    vi.spyOn(prisma.notification, 'create').mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/campaigns/${campaign.id}/pause`)
      .set(...asAlice());

    expect(res.status).toBe(200);
    await expect(
      prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } }),
    ).resolves.toMatchObject({ status: 'PAUSED' });
  });
});
