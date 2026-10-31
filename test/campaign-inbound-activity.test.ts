import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, as, makeAccount, makePhoneNumber, makeWorkspace } from './helpers.js';

/**
 * When an inbound campaign's calls arrived, in fixed buckets.
 *
 * The Overview draws two charts off one response — today hour by hour, and the
 * last fortnight day by day — so the bucket has to be small enough to reassemble
 * into a LOCAL hour from a UTC grid. Fifteen minutes is that size: every IANA
 * offset is a whole multiple of 15, so an hour in any zone on earth is exactly
 * four of these, and the response never has to carry a time zone name.
 *
 * The payload is bounded by the WINDOW rather than by the call volume, which is
 * the point of aggregating here instead of shipping arrival timestamps: a DID
 * taking a thousand calls a day would otherwise send a megabyte to draw a
 * fortnight's bars.
 */

const app = createApp();
const auth = as('user_alice', 'alice@ezo.test');
const bob = as('user_bob', 'bob@ezo.test');

const SLOT_MS = 15 * 60 * 1000;

beforeEach(async () => {
  await truncateAll();
});

async function scenario(type: 'INBOUND' | 'OUTBOUND' = 'INBOUND') {
  const alice = await makeAccount('alice');
  const ws = await makeWorkspace(alice, 'A Co');
  const did = await makePhoneNumber(ws, '+919000000070', 'ASSIGNED');
  const campaign = await prisma.campaign.create({
    data: { workspaceId: ws.id, name: 'Support', type, status: 'RUNNING' },
  });
  const contact = await prisma.contact.create({
    data: { workspaceId: ws.id, phone: '+919876543210', name: 'Rahul' },
  });
  return { alice, ws, did, campaign, contact };
}

const url = (ws: string, campaign: string, query = '') =>
  `/api/workspaces/${ws}/campaigns/${campaign}/inbound-activity${query}`;

let seq = 0;

async function arrival(
  s: Awaited<ReturnType<typeof scenario>>,
  at: Date,
  opts: { outcome?: string | null; campaignId?: string; workspaceId?: string } = {},
) {
  seq += 1;
  return prisma.campaignInboundCall.create({
    data: {
      campaignId: opts.campaignId ?? s.campaign.id,
      workspaceId: opts.workspaceId ?? s.ws.id,
      phoneNumberId: s.did.id,
      fromNumber: s.contact.phone,
      upstreamCallId: `CA-act-${seq}`,
      upstreamPhoneCallId: `pc-act-${seq}`,
      arrivedAt: at,
      endedAt: new Date(at.getTime() + 60_000),
      durationSecs: 60,
      disposition: 'completed',
      extraction:
        opts.outcome === undefined
          ? { call_outcome_vocobaseplatform: 'completed' }
          : opts.outcome === null
            ? undefined
            : { call_outcome_vocobaseplatform: opts.outcome },
    },
  });
}

/** Which bucket an instant lands in, counted from the response's own start. */
function slotOf(since: string, at: Date): number {
  return Math.floor((at.getTime() - new Date(since).getTime()) / SLOT_MS);
}

describe('GET .../campaigns/:id/inbound-activity', () => {
  it('counts each call into the bucket its arrival falls in', async () => {
    const s = await scenario();
    const now = Date.now();
    const recent = new Date(now - 90 * 60 * 1000);
    const earlier = new Date(now - 26 * 60 * 60 * 1000);

    await arrival(s, recent);
    await arrival(s, recent);
    await arrival(s, earlier);

    const res = await request(app).get(url(s.ws.id, s.campaign.id)).set(...auth);

    expect(res.status).toBe(200);
    const { since, buckets, bucketMinutes } = res.body.data;
    expect(bucketMinutes).toBe(15);
    expect(buckets[slotOf(since, recent)]).toBe(2);
    expect(buckets[slotOf(since, earlier)]).toBe(1);
    expect(buckets.reduce((a: number, b: number) => a + b, 0)).toBe(3);
  });

  it('returns a dense window one day longer than the days asked for', async () => {
    const s = await scenario();

    const res = await request(app).get(url(s.ws.id, s.campaign.id, '?days=3')).set(...auth);

    expect(res.status).toBe(200);
    // The extra day is slack, not decoration: a caller assembling three whole
    // LOCAL days out of a UTC grid needs up to 14 hours either side of them.
    expect(res.body.data.days).toBe(3);
    expect(res.body.data.buckets).toHaveLength(4 * 24 * 4);
    expect(res.body.data.buckets.every((n: number) => n === 0)).toBe(true);
  });

  it('starts the window on a bucket boundary', async () => {
    const s = await scenario();

    const res = await request(app).get(url(s.ws.id, s.campaign.id)).set(...auth);

    const since = new Date(res.body.data.since).getTime();
    expect(since % SLOT_MS).toBe(0);
  });

  it('leaves out a call that arrived before the window', async () => {
    const s = await scenario();
    await arrival(s, new Date(Date.now() - 40 * 24 * 60 * 60 * 1000));

    const res = await request(app).get(url(s.ws.id, s.campaign.id, '?days=14')).set(...auth);

    expect(res.body.data.buckets.reduce((a: number, b: number) => a + b, 0)).toBe(0);
    // ...and the page still knows the campaign has answered somebody, which is
    // what stops an empty fortnight rendering as a line nobody has ever rung.
    expect(res.body.data.firstCallAt).not.toBeNull();
  });

  it('breaks the window down by the agent verdict, every bucket present', async () => {
    const s = await scenario();
    const at = new Date(Date.now() - 60 * 60 * 1000);
    await arrival(s, at, { outcome: 'completed' });
    await arrival(s, at, { outcome: 'completed' });
    await arrival(s, at, { outcome: 'stop' });
    await arrival(s, at, { outcome: null });
    // A verdict this build has no word for is not a new bucket — it joins the
    // calls that said nothing readable.
    await arrival(s, at, { outcome: 'transferred_to_a_human' });

    const res = await request(app).get(url(s.ws.id, s.campaign.id)).set(...auth);

    expect(res.body.data.outcomes).toEqual([
      { outcome: 'incomplete', count: 0 },
      { outcome: 'stop', count: 1 },
      { outcome: 'completed', count: 2 },
      { outcome: null, count: 2 },
    ]);
  });

  it('counts outcomes over the window, not over the campaign', async () => {
    const s = await scenario();
    await arrival(s, new Date(Date.now() - 60 * 60 * 1000), { outcome: 'completed' });
    await arrival(s, new Date(Date.now() - 40 * 24 * 60 * 60 * 1000), { outcome: 'completed' });

    const res = await request(app).get(url(s.ws.id, s.campaign.id, '?days=14')).set(...auth);

    const completed = res.body.data.outcomes.find(
      (o: { outcome: string | null }) => o.outcome === 'completed',
    );
    expect(completed.count).toBe(1);
  });

  it('counts outcomes over the days asked for, not over the slack day', async () => {
    const s = await scenario();
    // Inside the window everybody agrees on.
    await arrival(s, new Date(Date.now() - 60 * 60 * 1000), { outcome: 'completed' });
    // Inside the SLACK day: the grid carries it so a client can carve whole
    // local days out of a UTC grid, and no client ever draws it. Counted in
    // the verdict breakdown it put a figure on the card that the bars beside
    // it — same stated window — could not add up to.
    await arrival(s, new Date(Date.now() - 14.5 * 24 * 60 * 60 * 1000), {
      outcome: 'completed',
    });

    const res = await request(app).get(url(s.ws.id, s.campaign.id, '?days=14')).set(...auth);

    const completed = res.body.data.outcomes.find(
      (o: { outcome: string | null }) => o.outcome === 'completed',
    );
    expect(completed.count).toBe(1);
    // The grid still carries the slack call — that is what the extra day is
    // for, and narrowing the breakdown must not narrow the bars.
    expect(res.body.data.buckets.reduce((a: number, b: number) => a + b, 0)).toBe(2);
  });

  it('never reports another workspace\'s call as this line\'s first', async () => {
    const s = await scenario();
    const other = await makeAccount('dave');
    const otherWs = await makeWorkspace(other, 'D Co');

    // The ONLY row for this campaign is filed under another workspace, the
    // reassigned-DID shape again. `firstCallAt` is what tells "nobody rang
    // this fortnight" from "nobody has ever rung this number", so reading it
    // across the tenant boundary is the one absence that must not be filled.
    await arrival(s, new Date(Date.now() - 60 * 60 * 1000), { workspaceId: otherWs.id });

    const res = await request(app).get(url(s.ws.id, s.campaign.id)).set(...auth);

    expect(res.body.data.firstCallAt).toBeNull();
  });

  it('never counts a call filed under another workspace', async () => {
    const s = await scenario();
    const other = await makeAccount('carol');
    const otherWs = await makeWorkspace(other, 'C Co');
    const at = new Date(Date.now() - 60 * 60 * 1000);

    await arrival(s, at);
    // The shape a reassigned DID actually produces: the inbound writer stamps
    // the NUMBER's workspace while taking the campaign from the claim, so the
    // two disagree on a real row. Without this the workspace scope in the query
    // would be masked by the campaign scope and untestable.
    await arrival(s, at, { workspaceId: otherWs.id });

    const res = await request(app).get(url(s.ws.id, s.campaign.id)).set(...auth);

    expect(res.body.data.buckets.reduce((a: number, b: number) => a + b, 0)).toBe(1);
    expect(
      res.body.data.outcomes.find((o: { outcome: string | null }) => o.outcome === 'completed')
        .count,
    ).toBe(1);
  });

  it('never counts another campaign in the same workspace', async () => {
    const s = await scenario();
    const sibling = await prisma.campaign.create({
      data: { workspaceId: s.ws.id, name: 'Other line', type: 'INBOUND', status: 'RUNNING' },
    });
    const at = new Date(Date.now() - 60 * 60 * 1000);

    await arrival(s, at);
    await arrival(s, at, { campaignId: sibling.id });

    const res = await request(app).get(url(s.ws.id, s.campaign.id)).set(...auth);

    expect(res.body.data.buckets.reduce((a: number, b: number) => a + b, 0)).toBe(1);
  });

  it('clamps the window a caller asks for', async () => {
    const s = await scenario();

    const wide = await request(app).get(url(s.ws.id, s.campaign.id, '?days=9000')).set(...auth);
    const narrow = await request(app).get(url(s.ws.id, s.campaign.id, '?days=0')).set(...auth);
    const junk = await request(app).get(url(s.ws.id, s.campaign.id, '?days=soon')).set(...auth);

    expect(wide.body.data.days).toBe(90);
    expect(narrow.body.data.days).toBe(1);
    // Not a 400: this is a chart, and the shape of the URL is not something the
    // reader chose or can fix.
    expect(junk.body.data.days).toBe(14);
  });

  it('reads a bare ?days= as absent, not as the smallest window', async () => {
    const s = await scenario();

    // `Number('')` is 0, which is finite, so the empty parameter used to take
    // the clamp branch and answer with one day where the default is fourteen.
    // An empty query parameter reads as "absent" far more than as "minimum".
    const res = await request(app).get(url(s.ws.id, s.campaign.id, '?days=')).set(...auth);

    expect(res.body.data.days).toBe(14);
  });

  it('keeps the grid bucket-aligned when a caller asks for a fraction of a day', async () => {
    const s = await scenario();

    // `Math.trunc` is load-bearing and was pinned by nothing. Without it
    // `days=1.001` makes the window 172,886,400 ms, which is 192.096 buckets —
    // `since` stops landing on a boundary, the start index floors while the
    // length rounds, and every row lands one bucket off. `days=1.5` survives
    // by luck (half a day is exactly 48 buckets), which is why an eyeball
    // check misses this.
    const res = await request(app).get(url(s.ws.id, s.campaign.id, '?days=1.001')).set(...auth);

    expect(res.body.data.days).toBe(1);
    expect(new Date(res.body.data.since).getTime() % (15 * 60 * 1000)).toBe(0);
    expect(res.body.data.buckets).toHaveLength(2 * 24 * 4);
  });

  it('answers an outbound campaign with an empty window rather than a refusal', async () => {
    const s = await scenario('OUTBOUND');

    const res = await request(app).get(url(s.ws.id, s.campaign.id)).set(...auth);

    expect(res.status).toBe(200);
    expect(res.body.data.buckets.every((n: number) => n === 0)).toBe(true);
    expect(res.body.data.firstCallAt).toBeNull();
  });

  it('lets a member read it', async () => {
    const s = await scenario();
    const bobAccount = await makeAccount('bob');
    await addMember(s.ws, bobAccount, 'MEMBER');

    const res = await request(app).get(url(s.ws.id, s.campaign.id)).set(...bob);

    expect(res.status).toBe(200);
  });

  it('is a plain 404 for a campaign in somebody else’s workspace', async () => {
    const s = await scenario();
    const bobAccount = await makeAccount('bob');
    const theirs = await makeWorkspace(bobAccount, 'B Co');

    const res = await request(app).get(url(theirs.id, s.campaign.id)).set(...bob);

    expect(res.status).toBe(404);
  });
});
