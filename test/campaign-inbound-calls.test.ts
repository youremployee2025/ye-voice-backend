import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, as, makeAccount, makePhoneNumber, makeWorkspace } from './helpers.js';

/**
 * The inbound call listing: what a campaign that answers has received, one
 * row per call, newest first. Member-readable like every other campaign read;
 * a campaign in another workspace is a plain 404.
 */

const app = createApp();
const auth = as('user_alice', 'alice@ezo.test');

beforeEach(async () => {
  await truncateAll();
});

async function scenario(type: 'INBOUND' | 'OUTBOUND' = 'INBOUND') {
  const alice = await makeAccount('alice');
  const ws = await makeWorkspace(alice, 'A Co');
  const did = await makePhoneNumber(ws, '+919000000060', 'ASSIGNED');
  const campaign = await prisma.campaign.create({
    data: { workspaceId: ws.id, name: 'Support', type, status: 'RUNNING' },
  });
  const contact = await prisma.contact.create({
    data: { workspaceId: ws.id, phone: '+919876543210', name: 'Rahul' },
  });
  const cc = await prisma.campaignContact.create({
    data: { campaignId: campaign.id, contactId: contact.id, status: 'COMPLETED' },
  });
  return { alice, ws, did, campaign, contact, cc };
}

const url = (ws: string, campaign: string, query = '') =>
  `/api/workspaces/${ws}/campaigns/${campaign}/inbound-calls${query}`;

async function call(
  s: Awaited<ReturnType<typeof scenario>>,
  fields: { id: string; from?: string; known?: boolean; endedAt: Date; durationSecs?: number; extraction?: object; costCredits?: bigint },
) {
  return prisma.campaignInboundCall.create({
    data: {
      campaignId: s.campaign.id,
      campaignContactId: fields.known === false ? null : s.cc.id,
      contactId: fields.known === false ? null : s.contact.id,
      workspaceId: s.ws.id,
      phoneNumberId: s.did.id,
      fromNumber: fields.from ?? s.contact.phone,
      // A SETTLED call carries both id namespaces, as the settle leaves it:
      // the carrier's id from the policy callback, and Vocobase's own call id
      // learned at completion. They are different strings on purpose — the
      // wire's `upstreamCallId` must be the second one, because that is the
      // only one `GET /calls/:id` can resolve.
      upstreamCallId: `CA-${fields.id}`,
      upstreamPhoneCallId: fields.id,
      arrivedAt: new Date(fields.endedAt.getTime() - (fields.durationSecs ?? 0) * 1000),
      endedAt: fields.endedAt,
      durationSecs: fields.durationSecs ?? 0,
      disposition: 'completed',
      extraction: fields.extraction,
      costCredits: fields.costCredits ?? null,
    },
  });
}

describe('GET .../campaigns/:id/inbound-calls', () => {
  it('lists calls newest first with the caller resolved', async () => {
    const s = await scenario();
    await call(s, { id: 'c-old', endedAt: new Date('2026-09-10T10:00:00Z'), durationSecs: 30, costCredits: 5000n,
      extraction: { call_outcome_vocobaseplatform: 'completed' } });
    await call(s, { id: 'c-new', from: '+910000000009', known: false, endedAt: new Date('2026-09-10T12:00:00Z') });

    const res = await request(app).get(url(s.ws.id, s.campaign.id)).set(...auth);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ page: 1, limit: 25, total: 2 });
    const [newest, oldest] = res.body.data.items;
    expect(newest).toMatchObject({
      upstreamCallId: 'c-new',
      fromNumber: '+910000000009',
      contact: null,
      durationSecs: 0,
      callOutcome: null,
      costCredits: null,
    });
    expect(oldest).toMatchObject({
      upstreamCallId: 'c-old',
      fromNumber: '+919876543210',
      contact: { id: s.contact.id, name: 'Rahul' },
      durationSecs: 30,
      disposition: 'completed',
      callOutcome: 'completed',
      costCredits: '0.5',
      arrivedAt: '2026-09-10T09:59:30.000Z',
      endedAt: '2026-09-10T10:00:00.000Z',
    });
  });

  it('pages with ?page and ?limit', async () => {
    const s = await scenario();
    for (let i = 0; i < 5; i += 1) {
      await call(s, { id: `c-${i}`, endedAt: new Date(Date.UTC(2026, 8, 10, i)) });
    }

    const second = await request(app).get(url(s.ws.id, s.campaign.id, '?limit=2&page=2')).set(...auth);

    expect(second.body.data).toMatchObject({ page: 2, limit: 2, total: 5 });
    expect(second.body.data.items.map((c: { upstreamCallId: string }) => c.upstreamCallId)).toEqual(['c-2', 'c-1']);
  });

  it('is readable by a MEMBER and 404 across workspaces', async () => {
    const s = await scenario();
    const bob = await makeAccount('bob');
    await addMember(s.ws, bob, 'MEMBER');
    const other = await makeWorkspace(bob, 'B Co');

    const asMember = await request(app).get(url(s.ws.id, s.campaign.id)).set(...as('user_bob', 'bob@ezo.test'));
    expect(asMember.status).toBe(200);

    const foreign = await request(app).get(url(other.id, s.campaign.id)).set(...as('user_bob', 'bob@ezo.test'));
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('NOT_FOUND');
  });

  it('answers an empty page for an OUTBOUND campaign rather than refusing', async () => {
    const s = await scenario('OUTBOUND');
    const res = await request(app).get(url(s.ws.id, s.campaign.id)).set(...auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ items: [], total: 0 });
  });
});
