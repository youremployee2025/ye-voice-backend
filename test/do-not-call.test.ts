import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Account, Campaign, Workspace } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, as, makeAccount, makeWorkspace } from './helpers.js';

/**
 * One campaign's do-not-call list, read and unlisted.
 *
 * Rows are written automatically off a language model's verdict, are permanent
 * for the campaign, and auto-settle every matching contact `EXCLUDED`. Without
 * this surface one hallucinated `stop` barred a number for the life of the
 * campaign and the only remedy was SQL against production.
 *
 * The list is the CAMPAIGN's, deliberately: somebody who asked not to be called
 * about one campaign has not opted out of every conversation the workspace may
 * have with them, so a second campaign here keeps its own list and neither
 * reads nor is bound by this one.
 */

const app = createApp();

let alice: Account;
let mine: Workspace;
let theirs: Workspace;
/** Two campaigns in the SAME workspace: the scoping this route is about is
 *  campaign-to-campaign, not only workspace-to-workspace. */
let campaign: Campaign;
let sibling: Campaign;
let foreignCampaign: Campaign;

const AUTH = as('user_alice', 'alice@ezo.test');

async function makeCampaign(workspace: Workspace, name: string): Promise<Campaign> {
  return prisma.campaign.create({
    data: { workspaceId: workspace.id, name, status: 'RUNNING', retryCount: 2 },
  });
}

beforeEach(async () => {
  await truncateAll();

  alice = await makeAccount('alice');
  mine = await makeWorkspace(alice, 'A Co');

  const bob = await makeAccount('bob');
  theirs = await makeWorkspace(bob, 'B Co');

  campaign = await makeCampaign(mine, 'Q3');
  sibling = await makeCampaign(mine, 'Renewals');
  foreignCampaign = await makeCampaign(theirs, 'Theirs');
});

const list = (workspaceId: string, campaignId: string, query = '') =>
  request(app)
    .get(`/api/workspaces/${workspaceId}/campaigns/${campaignId}/do-not-call${query}`)
    .set(...AUTH);

const remove = (workspaceId: string, campaignId: string, id: string) =>
  request(app)
    .delete(`/api/workspaces/${workspaceId}/campaigns/${campaignId}/do-not-call/${id}`)
    .set(...AUTH);

let seq = 0;

/**
 * `createdAt` is stamped explicitly wherever the ORDER matters. Two rows
 * written in one millisecond share a timestamp, and the route's `id DESC`
 * tiebreaker — which is there so offset paging cannot show a row twice — then
 * decides between them off a uuid. That is the route behaving correctly and a
 * test asserting insertion order failing at random.
 */
async function listed(on: Campaign, phone?: string, createdAt?: Date) {
  seq += 1;

  return prisma.doNotCall.create({
    data: {
      campaignId: on.id,
      phone: phone ?? `+9198000${String(10000 + seq).slice(-5)}`,
      reason: 'Asked not to be called again during a campaign call.',
      ...(createdAt === undefined ? {} : { createdAt }),
    },
  });
}

const AGO = (minutes: number) => new Date(Date.now() - minutes * 60_000);

describe('reading the list', () => {
  it('returns this campaign’s rows, newest first', async () => {
    const first = await listed(campaign, undefined, AGO(10));
    const second = await listed(campaign, undefined, AGO(5));

    const res = await list(mine.id, campaign.id);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.numbers.map((row: { id: string }) => row.id))
      .toEqual([second.id, first.id]);
    expect(res.body.data.numbers[0]).toMatchObject({
      phone: second.phone,
      reason: 'Asked not to be called again during a campaign call.',
    });
  });

  /** The row is the campaign's policy; the whole point of the list is that a
   *  member can see why a number stopped being dialled. */
  it('is readable by a plain member', async () => {
    await listed(campaign);
    const carol = await makeAccount('carol');
    await addMember(mine, carol, 'MEMBER');

    const res = await request(app)
      .get(`/api/workspaces/${mine.id}/campaigns/${campaign.id}/do-not-call`)
      .set(...as(carol.clerkUserId, carol.email));

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
  });

  /**
   * The scoping decision, on the read side. The sibling campaign belongs to
   * the same workspace and the same operator; its opt-outs are still its own.
   */
  it('never shows another campaign’s rows, this workspace’s included', async () => {
    await listed(sibling);
    await listed(sibling);

    const res = await list(mine.id, campaign.id);

    expect(res.status).toBe(200);
    expect(res.body.data.numbers).toEqual([]);
    expect(res.body.data.total).toBe(0);
  });

  it('answers 403 for a workspace the caller is not a member of', async () => {
    await listed(foreignCampaign);

    expect((await list(theirs.id, foreignCampaign.id)).status).toBe(403);
  });

  /** The campaign is resolved against the workspace before a row is read, so
   *  another workspace's campaign id is a 404 and never a listing. */
  it('404s for a campaign that is not this workspace’s', async () => {
    await listed(foreignCampaign);

    expect((await list(mine.id, foreignCampaign.id)).status).toBe(404);
  });

  it('pages with limit and offset, and reports the whole total', async () => {
    for (let n = 0; n < 3; n += 1) await listed(campaign, undefined, AGO(n + 1));

    const page = await list(mine.id, campaign.id, '?limit=2&offset=2');

    expect(page.status).toBe(200);
    expect(page.body.data.numbers).toHaveLength(1);
    expect(page.body.data.total).toBe(3);
    expect(page.body.data.limit).toBe(2);
    expect(page.body.data.offset).toBe(2);
  });

  it('refuses a page size past the cap', async () => {
    expect((await list(mine.id, campaign.id, '?limit=500')).status).toBe(400);
  });

  it('searches by phone', async () => {
    const wanted = await listed(campaign, '+919812345678');
    await listed(campaign, '+919899999999');

    const res = await list(mine.id, campaign.id, '?search=81234');

    expect(res.body.data.numbers.map((row: { id: string }) => row.id)).toEqual([wanted.id]);
    expect(res.body.data.total).toBe(1);
  });
});

describe('unlisting a number', () => {
  it('removes the row', async () => {
    const row = await listed(campaign);

    const res = await remove(mine.id, campaign.id, row.id);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: row.id, phone: row.phone });
    expect(await prisma.doNotCall.findUnique({ where: { id: row.id } })).toBeNull();
  });

  it('is ADMIN-only', async () => {
    const row = await listed(campaign);
    const carol = await makeAccount('carol');
    await addMember(mine, carol, 'MEMBER');

    const res = await request(app)
      .delete(`/api/workspaces/${mine.id}/campaigns/${campaign.id}/do-not-call/${row.id}`)
      .set(...as(carol.clerkUserId, carol.email));

    expect(res.status).toBe(403);
    expect(await prisma.doNotCall.findUnique({ where: { id: row.id } })).not.toBeNull();
  });

  /**
   * Scoped in the lookup, never checked after the fact — and the refusal is
   * the same 404 an id that never existed gets, so the route cannot be used to
   * ask whether a number is on somebody else's list.
   */
  it('404s for another workspace’s row, and leaves it standing', async () => {
    const foreign = await listed(foreignCampaign);

    const res = await remove(mine.id, campaign.id, foreign.id);

    expect(res.status).toBe(404);
    expect(await prisma.doNotCall.findUnique({ where: { id: foreign.id } })).not.toBeNull();
  });

  /**
   * The scoping decision, on the write side: a sibling campaign's row is as
   * untouchable through this path as another workspace's, and answers the
   * same way. Unlisting a number is a decision about one campaign, taken on
   * that campaign.
   */
  it('404s for a sibling campaign’s row, and leaves it standing', async () => {
    const siblingRow = await listed(sibling);

    const res = await remove(mine.id, campaign.id, siblingRow.id);

    expect(res.status).toBe(404);
    expect(await prisma.doNotCall.findUnique({ where: { id: siblingRow.id } })).not.toBeNull();
    // And it is still invisible on the other campaign's listing.
    expect((await list(mine.id, campaign.id)).body.data.numbers).toEqual([]);
  });

  it('answers a foreign id and a nonexistent id identically', async () => {
    const foreign = await remove(mine.id, campaign.id, (await listed(sibling)).id);
    const missing = await remove(mine.id, campaign.id, '00000000-0000-4000-8000-000000000000');

    expect(foreign.status).toBe(missing.status);
    expect(foreign.body.error.code).toBe(missing.body.error.code);
    expect(foreign.body.error.message).toBe(missing.body.error.message);
  });

  it('404s a second time rather than reporting a phantom removal', async () => {
    const row = await listed(campaign);

    expect((await remove(mine.id, campaign.id, row.id)).status).toBe(200);
    expect((await remove(mine.id, campaign.id, row.id)).status).toBe(404);
  });

  /** The claim reads this table on every pass, so removing the row is what
   *  actually puts the number back in reach. */
  it('lets the number be dialled again', async () => {
    const row = await listed(campaign, '+919812345670');
    const { claimContacts } = await import('../src/services/dialerClaim.js');

    const contact = await prisma.contact.create({
      data: { workspaceId: mine.id, phone: '+919812345670' },
    });
    const link = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id, status: 'PENDING' },
    });

    const claim = () =>
      claimContacts(prisma, {
        campaignId: campaign.id,
        limit: 5,
        lane: 'any',
        retryCount: 2,
        maxTotalDials: null,
        // Not what this case is about: neither bounds anything here.
        maxGoalFollowUps: 5,
        maxDialsPerDay: 10,
        dayStart: new Date(0),
        now: new Date(),
      });

    expect(await claim()).toEqual([]);

    await remove(mine.id, campaign.id, row.id);

    expect((await claim()).map((claimed) => claimed.id)).toEqual([link.id]);
  });
});
