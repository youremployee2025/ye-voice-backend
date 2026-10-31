import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, as, makeAccount, makeWorkspace } from './helpers.js';

const { createApp } = await import('../src/app.js');
const app = createApp();

let seq = 0;

async function seed() {
  const account = await makeAccount(`export-route-${(seq += 1)}`);
  const workspace = await makeWorkspace(account, 'Exports');
  const campaign = await prisma.campaign.create({
    data: { workspaceId: workspace.id, name: 'September, Touchbase', status: 'RUNNING' },
  });

  return { account, workspace, campaign };
}

const member = (account: { clerkUserId: string; email: string | null }) =>
  as(account.clerkUserId, account.email ?? 'x@example.com');

beforeEach(async () => {
  await truncateAll();
});

describe.each([
  ['leads', 'leads'],
  ['calls', 'calls'],
])('GET /campaigns/:id/export/%s', (_label, kind) => {
  const url = (workspaceId: string, campaignId: string) =>
    `/api/workspaces/${workspaceId}/campaigns/${campaignId}/export/${kind}`;

  it('answers 401 without authentication', async () => {
    const { workspace, campaign } = await seed();

    await request(app).get(url(workspace.id, campaign.id)).expect(401);
  });

  it('answers 403 to somebody who is not a member', async () => {
    const { workspace, campaign } = await seed();
    const stranger = await makeAccount(`stranger-${(seq += 1)}`);

    await request(app).get(url(workspace.id, campaign.id)).set(...member(stranger)).expect(403);
  });

  /**
   * A campaign in another workspace is a 404 with the same body a nonsense id
   * gets. A 403 would confirm the id names something real, which is what turns
   * a scoped lookup into an existence oracle.
   */
  it('answers 404 for a campaign in another workspace', async () => {
    const mine = await seed();
    const theirs = await seed();

    await request(app)
      .get(url(mine.workspace.id, theirs.campaign.id))
      .set(...member(mine.account))
      .expect(404);
  });

  it('answers 404 for an id that names nothing', async () => {
    const { workspace, account } = await seed();

    await request(app)
      .get(url(workspace.id, 'not-a-campaign'))
      .set(...member(account))
      .expect(404);
  });

  /** A member, not an ADMIN: this is a read over the workspace's own calls,
   *  which the analytics export and every other read here is open to. */
  it('serves a member', async () => {
    const { workspace, campaign, account } = await seed();
    const other = await makeAccount(`member-${(seq += 1)}`);
    await addMember(workspace, other, 'MEMBER');
    void account;

    await request(app).get(url(workspace.id, campaign.id)).set(...member(other)).expect(200);
  });

  it('sends CSV that no shared cache may keep, under a filename built from the campaign', async () => {
    const { workspace, campaign, account } = await seed();

    const res = await request(app)
      .get(url(workspace.id, campaign.id))
      .set(...member(account))
      .expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // The name is the customer's and may hold a comma, a quote or a newline —
    // none of which belongs in a header a client writes to disk.
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="[\w.-]+\.csv"$/);
  });

  it('writes a header row even when the campaign has no rows at all', async () => {
    const { workspace, campaign, account } = await seed();

    const res = await request(app)
      .get(url(workspace.id, campaign.id))
      .set(...member(account))
      .expect(200);

    // An empty file and a file of headers say different things, and only the
    // second reads as an answer rather than as a download that failed.
    expect(res.text.replace(/^﻿/, '').trim().split('\r\n')).toHaveLength(1);
  });

  /**
   * The regression the empty-campaign case above cannot see. Node emits
   * 'drain' only after a write has returned false; a page of rows too small to
   * fill the socket buffer never does, and an export that awaited it
   * unconditionally streamed every row and then never ended. One lead and one
   * dial is exactly that page, on both routes.
   */
  it('ends the response for a campaign with rows that fit in one small page', async () => {
    const { workspace, campaign, account } = await seed();
    const contact = await prisma.contact.create({
      data: { workspaceId: workspace.id, phone: '+919900000001', name: 'One Lead' },
    });
    const lead = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id, status: 'COMPLETED' },
    });
    await prisma.callAttempt.create({
      data: {
        campaignId: campaign.id,
        campaignContactId: lead.id,
        workspaceId: workspace.id,
        accountId: account.id,
        attemptNo: 1,
        upstreamCallId: `c_route_${(seq += 1)}`,
        status: 'COMPLETED',
        disposition: 'completed',
        startedAt: new Date('2026-09-01T10:00:00.000Z'),
      },
    });

    const res = await request(app)
      .get(url(workspace.id, campaign.id))
      .set(...member(account))
      .timeout({ response: 3000, deadline: 3000 })
      .expect(200);

    // Header plus exactly one row, and the response actually completed.
    expect(res.text.replace(/^\ufeff/, '').trim().split('\r\n')).toHaveLength(2);
  });
});

describe('GET /campaigns/:id/export/custom', () => {
  const url = (workspaceId: string, campaignId: string, query = 'fields=attempts') =>
    `/api/workspaces/${workspaceId}/campaigns/${campaignId}/export/custom?${query}`;

  it('answers 401 without authentication', async () => {
    const { workspace, campaign } = await seed();

    await request(app).get(url(workspace.id, campaign.id)).expect(401);
  });

  it('answers 403 to somebody who is not a member', async () => {
    const { workspace, campaign } = await seed();
    const stranger = await makeAccount(`stranger-${(seq += 1)}`);

    await request(app).get(url(workspace.id, campaign.id)).set(...member(stranger)).expect(403);
  });

  it('answers 404 for a campaign in another workspace', async () => {
    const mine = await seed();
    const theirs = await seed();

    await request(app)
      .get(url(mine.workspace.id, theirs.campaign.id))
      .set(...member(mine.account))
      .expect(404);
  });

  /** Refused BEFORE the header row goes out, while a status line is still possible. */
  it('answers 400 for an unknown field group, an empty list, and a bad range', async () => {
    const { workspace, campaign, account } = await seed();

    const unknown = await request(app)
      .get(url(workspace.id, campaign.id, 'fields=attempts,bogus'))
      .set(...member(account))
      .expect(400);
    expect(unknown.body.error.message).toMatch(/bogus/);

    await request(app).get(url(workspace.id, campaign.id, 'fields=')).set(...member(account)).expect(400);
    await request(app).get(url(workspace.id, campaign.id, '')).set(...member(account)).expect(400);
    await request(app)
      .get(url(workspace.id, campaign.id, 'fields=attempts&from=2026-09-10&to=2026-09-01'))
      .set(...member(account))
      .expect(400);
  });

  it('serves a member the chosen groups under a campaign-named filename', async () => {
    const { workspace, campaign, account } = await seed();

    const res = await request(app)
      .get(url(workspace.id, campaign.id, 'fields=transcript,credits'))
      .set(...member(account))
      .expect(200);

    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="September_Touchbase_custom_\d{8}_\d{6}\.csv"$/);
    expect(res.headers['cache-control']).toBe('private, no-store');

    const header = res.text.replace(/^﻿/, '').trim();
    expect(header).toBe(
      'Lead ID,Lead Name,Phone,Attempt ID,Attempt No,Started At,Direction,Cost Credits,Billed Seconds,Rate Credits Per Minute,Tier,Charged At,Transcript',
    );
  });
});
