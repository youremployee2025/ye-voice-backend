import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';

/** Set before the app is imported, because `src/lib/env.ts` snapshots the
 *  environment when it loads — assigned after the import, this suite would be
 *  authenticating against an empty token, which refuses every request. */
const TOKEN = 'staff-token-for-tests';
process.env.ADMIN_STAFF_TOKEN = TOKEN;

const { createApp } = await import('../src/app.js');
const { adminCampaignRoutes } = await import('../src/routes/admin/campaigns.routes.js');
const { errorHandler } = await import('../src/lib/errors.js');

const app = createApp();
const staff = () => ['X-Admin-Token', TOKEN] as [string, string];

/**
 * The router mounted BARE, with nothing guarding it from above.
 *
 * Through `createApp` the mount in `index.ts` answers an unauthenticated
 * request first, so a router that had lost its own `requireStaffToken` would
 * still 401 there and nothing would say so — which is exactly the mistake the
 * repeated guard exists to make impossible. This is the only mount that can
 * observe it.
 */
const unguarded = express();
unguarded.use(express.json());
unguarded.use('/api/admin', adminCampaignRoutes);
unguarded.use(errorHandler);

beforeEach(async () => {
  await truncateAll();
});

/** A DRAFT campaign, deliberately not a PAUSED one: the transfer lands a
 *  campaign PAUSED, and starting it there would make that assertion true
 *  before the code under test ran. */
async function scene() {
  const account = await makeAccount('owner');
  const source = await makeWorkspace(account, 'Source');
  const target = await makeWorkspace(account, 'Target');
  const campaign = await prisma.campaign.create({
    data: { workspaceId: source.id, name: 'Q3 outreach', status: 'DRAFT' },
  });
  return { account, source, target, campaign };
}

const reread = (id: string) => prisma.campaign.findUniqueOrThrow({ where: { id } });

describe('staff authentication', () => {
  it.each([
    ['the preview', 'get' as const, '/api/admin/campaigns/any/transfer-preview?target=any'],
    ['the transfer', 'post' as const, '/api/admin/campaigns/any/transfer'],
  ])('carries its own guard on %s, mounted with nothing above it', async (_what, method, path) => {
    const res = await request(unguarded)[method](path);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('refuses the preview without the staff token', async () => {
    const res = await request(app).get('/api/admin/campaigns/any/transfer-preview?target=any');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('refuses the transfer without the staff token, and writes nothing', async () => {
    const { source, target, campaign } = await scene();

    const res = await request(app)
      .post(`/api/admin/campaigns/${campaign.id}/transfer`)
      .send({ targetWorkspaceId: target.id, expectedContactCount: 0 });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(await reread(campaign.id)).toMatchObject({ workspaceId: source.id });
  });
});

describe('GET /api/admin/campaigns/:campaignId/transfer-preview', () => {
  it('returns the plan for a campaign and a target', async () => {
    const { source, target, campaign } = await scene();

    const res = await request(app)
      .get(`/api/admin/campaigns/${campaign.id}/transfer-preview?target=${target.id}`)
      .set(...staff());

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      campaign: { id: campaign.id, name: 'Q3 outreach', status: 'DRAFT' },
      source: { id: source.id, name: 'Source' },
      target: { id: target.id, name: 'Target' },
      counts: { contacts: 0, contactsExisting: 0, attemptsStaying: 0 },
    });
    // A preview writes nothing, whatever it reports.
    expect(await reread(campaign.id)).toMatchObject({ workspaceId: source.id });
  });

  it('maps a RUNNING campaign to 409 CAMPAIGN_NOT_TRANSFERABLE', async () => {
    const { target, campaign } = await scene();
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'RUNNING' } });

    const res = await request(app)
      .get(`/api/admin/campaigns/${campaign.id}/transfer-preview?target=${target.id}`)
      .set(...staff());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAMPAIGN_NOT_TRANSFERABLE');
    // The service's own sentence, not one rewritten here.
    expect(res.body.error.message).toContain('Stop it before moving it.');
  });

  it('maps a deleted target to 409 CAMPAIGN_NOT_TRANSFERABLE', async () => {
    const { target, campaign } = await scene();
    await prisma.workspace.update({
      where: { id: target.id },
      data: { deletedAt: new Date() },
    });

    const res = await request(app)
      .get(`/api/admin/campaigns/${campaign.id}/transfer-preview?target=${target.id}`)
      .set(...staff());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAMPAIGN_NOT_TRANSFERABLE');
  });

  it('maps a campaign that does not exist to 404', async () => {
    const { target } = await scene();

    const res = await request(app)
      .get(`/api/admin/campaigns/nope/transfer-preview?target=${target.id}`)
      .set(...staff());

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('maps a target that does not exist to 404', async () => {
    const { campaign } = await scene();

    const res = await request(app)
      .get(`/api/admin/campaigns/${campaign.id}/transfer-preview?target=nope`)
      .set(...staff());

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('400s with no target named', async () => {
    const { campaign } = await scene();

    const res = await request(app)
      .get(`/api/admin/campaigns/${campaign.id}/transfer-preview`)
      .set(...staff());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/admin/campaigns/:campaignId/transfer', () => {
  it('moves the campaign and lands it inert', async () => {
    const { target, campaign } = await scene();

    const res = await request(app)
      .post(`/api/admin/campaigns/${campaign.id}/transfer`)
      .set(...staff())
      .send({ targetWorkspaceId: target.id, expectedContactCount: 0 });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ target: { id: target.id, name: 'Target' } });
    expect(await reread(campaign.id)).toMatchObject({
      workspaceId: target.id,
      status: 'PAUSED',
    });
  });

  it('maps contact drift to 409 CONCURRENT_MODIFICATION and writes nothing', async () => {
    const { source, target, campaign } = await scene();
    const contact = await prisma.contact.create({
      data: { workspaceId: source.id, phone: '+919000000001' },
    });
    await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });

    const res = await request(app)
      .post(`/api/admin/campaigns/${campaign.id}/transfer`)
      .set(...staff())
      .send({ targetWorkspaceId: target.id, expectedContactCount: 0 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONCURRENT_MODIFICATION');
    expect(await reread(campaign.id)).toMatchObject({
      workspaceId: source.id,
      status: 'DRAFT',
    });
    // The contact is still the source's, and the target gained nothing.
    expect(await prisma.contact.count({ where: { workspaceId: target.id } })).toBe(0);
  });

  it('maps a RUNNING campaign to 409 CAMPAIGN_NOT_TRANSFERABLE', async () => {
    const { source, target, campaign } = await scene();
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'RUNNING' } });

    const res = await request(app)
      .post(`/api/admin/campaigns/${campaign.id}/transfer`)
      .set(...staff())
      .send({ targetWorkspaceId: target.id, expectedContactCount: 0 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAMPAIGN_NOT_TRANSFERABLE');
    expect(await reread(campaign.id)).toMatchObject({ workspaceId: source.id });
  });

  it('400s without expectedContactCount, and moves nothing', async () => {
    const { source, target, campaign } = await scene();

    const res = await request(app)
      .post(`/api/admin/campaigns/${campaign.id}/transfer`)
      .set(...staff())
      .send({ targetWorkspaceId: target.id });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await reread(campaign.id)).toMatchObject({ workspaceId: source.id });
  });

  it.each([
    ['a fraction', 1.5],
    ['a negative', -1],
    ['a string', '0'],
  ])('400s when expectedContactCount is %s', async (_label, value) => {
    const { source, target, campaign } = await scene();

    const res = await request(app)
      .post(`/api/admin/campaigns/${campaign.id}/transfer`)
      .set(...staff())
      .send({ targetWorkspaceId: target.id, expectedContactCount: value });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await reread(campaign.id)).toMatchObject({ workspaceId: source.id });
  });

  it('400s without a target workspace', async () => {
    const { campaign } = await scene();

    const res = await request(app)
      .post(`/api/admin/campaigns/${campaign.id}/transfer`)
      .set(...staff())
      .send({ expectedContactCount: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
