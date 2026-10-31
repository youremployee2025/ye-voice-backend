import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { CampaignStatus } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, as, makeAccount, makeWorkspace } from './helpers.js';

/**
 * Adding contacts to a campaign that already exists.
 *
 * The rules that matter here are all about not surprising somebody: a stopped
 * campaign never takes more work, a finished one that gains contacts stops
 * short of dialing them, and every number this endpoint reports is the number
 * of rows that actually landed rather than the number the caller asked for.
 */

const app = createApp();
const AUTH = as('user_alice', 'alice@ezo.test');

beforeEach(async () => {
  await truncateAll();
});

async function setup(status: CampaignStatus = 'RUNNING') {
  const alice = await makeAccount('alice');
  const ws = await makeWorkspace(alice, 'A Co');
  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: ws.id,
      name: 'Q3',
      status,
      ...(status === 'STOPPED' ? { stoppedAt: new Date() } : {}),
    },
  });

  return { alice, ws, campaign };
}

async function library(
  workspaceId: string,
  count: number,
  overrides: (index: number) => Record<string, unknown> = () => ({}),
) {
  const ids: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const contact = await prisma.contact.create({
      data: {
        workspaceId,
        phone: `+9190000${index.toString().padStart(5, '0')}`,
        name: `Contact ${index}`,
        ...overrides(index),
      },
    });
    ids.push(contact.id);
  }

  return ids;
}

const topup = (ws: string, campaign: string, body: unknown) =>
  request(app)
    .post(`/api/workspaces/${ws}/campaigns/${campaign}/contacts`)
    .set(...AUTH)
    .send(body);

describe('choosing which contacts', () => {
  it('takes exactly one of the three branches', async () => {
    const { ws, campaign } = await setup();
    const [first] = await library(ws.id, 1);

    for (const body of [
      {},
      { contactIds: [first], selectAll: true },
      { tagFilter: ['vip'], selectAll: true },
    ]) {
      const res = await topup(ws.id, campaign.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.message).toContain('Provide contactIds, tagFilter or selectAll');
    }
  });

  it('adds the named contacts', async () => {
    const { ws, campaign } = await setup();
    const ids = await library(ws.id, 3);

    const res = await topup(ws.id, campaign.id, { contactIds: ids });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ added: 3, duplicates: 0, reopened: false });
    expect(await prisma.campaignContact.count({ where: { campaignId: campaign.id } })).toBe(3);
  });

  it('refuses more than ten thousand ids in one request', async () => {
    const { ws, campaign } = await setup();

    const res = await topup(ws.id, campaign.id, {
      contactIds: Array.from({ length: 10_001 }, (_, i) => `c_${i}`),
    });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('10000');
  });

  it('adds by tag, and refuses a tag that matches nothing', async () => {
    const { ws, campaign } = await setup();
    await library(ws.id, 3, (index) => ({ tags: index < 2 ? ['vip'] : ['lapsed'] }));

    const matched = await topup(ws.id, campaign.id, { tagFilter: ['vip'] });
    expect(matched.body.data).toMatchObject({ added: 2, duplicates: 0 });

    const empty = await topup(ws.id, campaign.id, { tagFilter: ['nobody'] });
    expect(empty.status).toBe(400);
    expect(empty.body.error.message).toContain('No matching contacts');
  });

  it('selects everything not already on the campaign, and searches within it', async () => {
    const { ws, campaign } = await setup();
    const ids = await library(ws.id, 3);
    await prisma.campaignContact.create({ data: { campaignId: campaign.id, contactId: ids[0]! } });

    const searched = await topup(ws.id, campaign.id, { selectAll: true, search: 'Contact 1' });
    expect(searched.body.data.added).toBe(1);

    const rest = await topup(ws.id, campaign.id, { selectAll: true });
    expect(rest.body.data.added).toBe(1);
  });

  /**
   * Pressing "select all" on a campaign that already holds everything is a
   * thing operators do, twice. Answering it with a 400 reads as a broken
   * button rather than as the no-op it is.
   */
  it('answers an empty selectAll with a zero, not an error', async () => {
    const { ws, campaign } = await setup();

    const res = await topup(ws.id, campaign.id, { selectAll: true });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ added: 0, duplicates: 0, reopened: false });
  });

  it('never reaches another workspace’s library', async () => {
    const { alice, ws, campaign } = await setup();
    const other = await makeWorkspace(alice, 'B Co');
    const theirs = await library(other.id, 2);

    const res = await topup(ws.id, campaign.id, { contactIds: theirs });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('No matching contacts');
    expect(await prisma.campaignContact.count()).toBe(0);
  });

  it('refuses a MEMBER', async () => {
    const { ws, campaign } = await setup();
    const bob = await makeAccount('bob');
    await addMember(ws, bob, 'MEMBER');
    const ids = await library(ws.id, 1);

    const res = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/contacts`)
      .set(...as('user_bob', 'bob@ezo.test'))
      .send({ contactIds: ids });

    expect(res.status).toBe(403);
  });
});

describe('what lands', () => {
  it('reports as duplicates everything it did not add', async () => {
    const { ws, campaign } = await setup();
    const ids = await library(ws.id, 2);
    await topup(ws.id, campaign.id, { contactIds: ids });

    // Both already on the list, and the id repeated in the request collapses
    // when it is resolved against the library rather than being counted twice.
    const res = await topup(ws.id, campaign.id, { contactIds: [...ids, ids[0]!] });

    expect(res.body.data).toMatchObject({ added: 0, duplicates: 2 });
    expect(await prisma.campaignContact.count({ where: { campaignId: campaign.id } })).toBe(2);
  });

  it('inserts more rows than fit in one statement', async () => {
    const { ws, campaign } = await setup();
    // Past the 1000-row chunk boundary, so the chunking is actually exercised
    // and `added` is proven to accumulate across chunks rather than report the
    // last one.
    const ids = await library(ws.id, 1200);

    const res = await topup(ws.id, campaign.id, { contactIds: ids });

    expect(res.body.data.added).toBe(1200);
    expect(await prisma.campaignContact.count({ where: { campaignId: campaign.id } })).toBe(1200);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).totalContacts)
      .toBe(1200);
  }, 30_000);

  it('keeps totalContacts in step across a top-up and an exclude', async () => {
    const { ws, campaign } = await setup();
    const ids = await library(ws.id, 3);
    await topup(ws.id, campaign.id, { contactIds: ids });

    const link = await prisma.campaignContact.findFirstOrThrow();
    const exclude = () =>
      request(app)
        .delete(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/contacts/${link.id}`)
        .set(...AUTH);

    await exclude();
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).totalContacts)
      .toBe(2);

    // Excluding the same row again is a no-op, not a second decrement. A
    // dashboard retry must not shrink the total.
    await exclude();
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).totalContacts)
      .toBe(2);
  });
});

describe('the campaign it lands on', () => {
  /**
   * A finished campaign that gains contacts stops at PAUSED.
   *
   * Start and resume are the only doors into RUNNING and both re-validate the
   * agent, the numbers and the balance. A top-up that flipped a campaign
   * straight back to dialing would be a third door with none of those checks
   * on it: adding contacts never starts dialing.
   */
  it('re-opens a completed campaign to PAUSED, never to RUNNING', async () => {
    const { ws, campaign } = await setup('COMPLETED');
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { completedAt: new Date() },
    });
    const ids = await library(ws.id, 1);

    const res = await topup(ws.id, campaign.id, { contactIds: ids });

    expect(res.body.data.reopened).toBe(true);

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.status).toBe('PAUSED');
    expect(stored.completedAt).toBeNull();
    expect(stored.pausedAt).not.toBeNull();
    // The page's answer to "why paused", written outright rather than left
    // as whatever the campaign last carried.
    expect(stored.haltReason).toContain('New contacts were added');
  });

  it('does not re-open a completed campaign that gained nothing', async () => {
    const { ws, campaign } = await setup('COMPLETED');
    const ids = await library(ws.id, 1);
    await prisma.campaignContact.create({ data: { campaignId: campaign.id, contactId: ids[0]! } });

    const res = await topup(ws.id, campaign.id, { contactIds: ids });

    expect(res.body.data).toMatchObject({ added: 0, duplicates: 1, reopened: false });
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status)
      .toBe('COMPLETED');
  });

  it('refuses a stopped campaign, and goes on refusing after it is marked complete', async () => {
    const { ws, campaign } = await setup('STOPPED');
    const ids = await library(ws.id, 1);

    const stopped = await topup(ws.id, campaign.id, { contactIds: ids });
    expect(stopped.status).toBe(400);
    expect(stopped.body.error.message).toBe(
      'This campaign was stopped, so the rest of its queue was skipped on purpose. ' +
        'Contacts cannot be added to it — create a new campaign for further calls.',
    );

    // The relabel `complete` does. Keyed on `stoppedAt` rather than the status
    // precisely so that relabel is not a two-click bypass of this refusal.
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'COMPLETED' } });

    const relabelled = await topup(ws.id, campaign.id, { contactIds: ids });
    expect(relabelled.status).toBe(400);
    expect(await prisma.campaignContact.count()).toBe(0);
  });

  it('accepts a top-up in every status that is still alive', async () => {
    for (const status of ['DRAFT', 'RUNNING', 'PAUSED', 'CREDIT_EXHAUSTED'] as const) {
      const { ws, campaign } = await setup(status);
      const ids = await library(ws.id, 1);

      const res = await topup(ws.id, campaign.id, { contactIds: ids });
      expect(res.status, status).toBe(200);
      // The dispatcher claims whatever is PENDING each pass, so a live campaign
      // simply keeps dialing — and its status does not move.
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status)
        .toBe(status);

      await truncateAll();
    }
  });
});

describe('the contact library', () => {
  it('lists, searches and pages by offset', async () => {
    const { ws } = await setup();
    await library(ws.id, 5);

    const base = `/api/workspaces/${ws.id}/contacts`;

    const page = await request(app).get(`${base}?limit=2`).set(...AUTH);
    expect(page.status).toBe(200);
    expect(page.body.data.contacts).toHaveLength(2);
    expect(page.body.data).toMatchObject({ total: 5, limit: 2, offset: 0 });

    const next = await request(app).get(`${base}?limit=2&offset=2`).set(...AUTH);
    expect(next.body.data.contacts[0].id).not.toBe(page.body.data.contacts[0].id);

    const searched = await request(app).get(`${base}?search=Contact 3`).set(...AUTH);
    expect(searched.body.data.total).toBe(1);
  });

  it('hides the contacts already on a campaign', async () => {
    const { ws, campaign } = await setup();
    const ids = await library(ws.id, 3);
    await prisma.campaignContact.create({ data: { campaignId: campaign.id, contactId: ids[0]! } });

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/contacts?excludeCampaignId=${campaign.id}`)
      .set(...AUTH);

    expect(res.body.data.total).toBe(2);
    expect(res.body.data.contacts.map((c: { id: string }) => c.id)).not.toContain(ids[0]);
  });

  it('lists every tag in use, once each', async () => {
    const { ws } = await setup();
    await library(ws.id, 3, (index) => ({ tags: index === 2 ? ['lapsed'] : ['vip', 'india'] }));

    const res = await request(app).get(`/api/workspaces/${ws.id}/contacts/tags`).set(...AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.tags).toEqual(['india', 'lapsed', 'vip']);
  });

  it('is readable by a MEMBER and never crosses a workspace', async () => {
    const { alice, ws } = await setup();
    const bob = await makeAccount('bob');
    await addMember(ws, bob, 'MEMBER');
    await library(ws.id, 2, () => ({ tags: ['vip'] }));

    const other = await makeWorkspace(alice, 'B Co');
    await library(other.id, 1, () => ({ tags: ['secret'] }));

    const ok = await request(app)
      .get(`/api/workspaces/${ws.id}/contacts`)
      .set(...as('user_bob', 'bob@ezo.test'));
    expect(ok.status).toBe(200);
    expect(ok.body.data.total).toBe(2);

    const tags = await request(app)
      .get(`/api/workspaces/${ws.id}/contacts/tags`)
      .set(...as('user_bob', 'bob@ezo.test'));
    expect(tags.body.data.tags).toEqual(['vip']);

    const crossed = await request(app)
      .get(`/api/workspaces/${other.id}/contacts`)
      .set(...as('user_bob', 'bob@ezo.test'));
    expect(crossed.status).toBe(403);
  });
});
