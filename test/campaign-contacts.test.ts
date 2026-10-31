import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, as, makeAccount, makeWorkspace } from './helpers.js';
import { inboundOutcomes } from '../src/lib/campaignInboundStats.js';

const app = createApp();

beforeEach(async () => {
  await truncateAll();
});

async function setup(status: 'DRAFT' | 'RUNNING' | 'PAUSED' = 'DRAFT') {
  const alice = await makeAccount('alice');
  const ws = await makeWorkspace(alice, 'A Co');
  const campaign = await prisma.campaign.create({
    data: { workspaceId: ws.id, name: 'Q3', status },
  });
  return { alice, ws, campaign };
}

const uploadUrl = (ws: string, campaign: string) =>
  `/api/workspaces/${ws}/campaigns/${campaign}/contacts:upload`;

const post = (url: string, csv: string, user = 'user_alice', email = 'alice@ezo.test') =>
  request(app)
    .post(url)
    .set(...as(user, email))
    .attach('file', Buffer.from(csv, 'utf8'), 'contacts.csv');

describe('POST .../contacts:upload', () => {
  it('loads contacts, mapping extra columns to metadata', async () => {
    const { ws, campaign } = await setup();

    const res = await post(
      uploadUrl(ws.id, campaign.id),
      'phone,name,city\n+919876543210,Asha,Pune\n+14155550132,Ravi,SF\n',
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ added: 2, duplicates: 0, invalid: [] });

    const contacts = await prisma.contact.findMany({ orderBy: { phone: 'asc' } });
    expect(contacts.map((c) => c.phone)).toEqual(['+14155550132', '+919876543210']);
    expect(contacts[1]!.metadata).toEqual({ city: 'Pune' });

    const links = await prisma.campaignContact.findMany();
    expect(links).toHaveLength(2);
    expect(links.every((l) => l.status === 'PENDING')).toBe(true);
  });

  it('reports malformed rows by row number without failing the file', async () => {
    const { ws, campaign } = await setup();

    const res = await post(
      uploadUrl(ws.id, campaign.id),
      'phone,name\n+919876543210,Asha\nnope,Bad\n,Blank\n',
    );

    expect(res.body.data.added).toBe(1);
    expect(res.body.data.invalid).toEqual([
      { row: 3, phone: 'nope', reason: expect.stringContaining('country code') },
      { row: 4, phone: '', reason: 'Phone number is required.' },
    ]);
  });

  it('counts a repeated phone as a duplicate, within a file and across uploads', async () => {
    const { ws, campaign } = await setup();
    const url = uploadUrl(ws.id, campaign.id);

    const first = await post(url, 'phone\n+919876543210\n+919876543210\n');
    expect(first.body.data).toMatchObject({ added: 1, duplicates: 1 });

    const second = await post(url, 'phone\n+919876543210\n+14155550132\n');
    expect(second.body.data).toMatchObject({ added: 1, duplicates: 1 });

    expect(await prisma.campaignContact.count()).toBe(2);
  });

  it('refreshes name and metadata when a known phone is re-uploaded', async () => {
    const { ws, campaign } = await setup();
    const url = uploadUrl(ws.id, campaign.id);

    await post(url, 'phone,name,city\n+919876543210,Asha,Pune\n');
    await post(url, 'phone,name,city\n+919876543210,Asha Rao,Mumbai\n');

    const contact = await prisma.contact.findFirstOrThrow();
    expect(contact.name).toBe('Asha Rao');
    expect(contact.metadata).toEqual({ city: 'Mumbai' });
  });

  it('keeps metadata a later upload does not mention', async () => {
    const { ws, campaign } = await setup();
    const url = uploadUrl(ws.id, campaign.id);

    await post(url, 'phone,name,city\n+919876543210,Asha,Pune\n');
    // A narrower file is an update to the columns it carries, not an
    // instruction to forget the rest: the dispatcher reads these as the
    // per-contact variables, and dropping them silently loses dialing data.
    await post(url, 'phone,plan\n+919876543210,Gold\n');

    const contact = await prisma.contact.findFirstOrThrow();
    expect(contact.metadata).toEqual({ city: 'Pune', plan: 'Gold' });
    expect(contact.name).toBe('Asha');
  });

  it('keeps the same phone separate in two workspaces', async () => {
    const alice = await makeAccount('alice');
    const a = await makeWorkspace(alice, 'A Co');
    const b = await makeWorkspace(alice, 'B Co');
    const ca = await prisma.campaign.create({ data: { workspaceId: a.id, name: 'A' } });
    const cb = await prisma.campaign.create({ data: { workspaceId: b.id, name: 'B' } });

    const first = await post(uploadUrl(a.id, ca.id), 'phone,name\n+919876543210,Asha\n');
    const second = await post(uploadUrl(b.id, cb.id), 'phone,name\n+919876543210,Asha\n');

    // Neither upload sees the other workspace's contact as a duplicate.
    expect(first.body.data).toMatchObject({ added: 1, duplicates: 0 });
    expect(second.body.data).toMatchObject({ added: 1, duplicates: 0 });
    expect(await prisma.contact.count()).toBe(2);
  });

  it('uses the campaign default country for bare national numbers', async () => {
    const { ws, campaign } = await setup();

    const withoutDefault = await post(uploadUrl(ws.id, campaign.id), 'phone\n9876543210\n');
    expect(withoutDefault.body.data.added).toBe(0);

    await prisma.campaign.update({ where: { id: campaign.id }, data: { defaultCountry: 'IN' } });

    const withDefault = await post(uploadUrl(ws.id, campaign.id), 'phone\n9876543210\n');
    expect(withDefault.body.data.added).toBe(1);
    expect((await prisma.contact.findFirstOrThrow()).phone).toBe('+919876543210');
  });

  it('rejects a file with no phone column', async () => {
    const { ws, campaign } = await setup();

    const res = await post(uploadUrl(ws.id, campaign.id), 'name,city\nAsha,Pune\n');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CSV_PHONE_COLUMN_MISSING');
  });

  it('requires a file', async () => {
    const { ws, campaign } = await setup();

    const res = await request(app)
      .post(uploadUrl(ws.id, campaign.id))
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CSV_FILE_REQUIRED');
  });

  /**
   * A running campaign takes an upload in place now.
   *
   * The dispatcher claims whatever is PENDING on every pass, so appending to a
   * live queue needs no concurrency story of its own — which was the reason
   * this used to be refused. What is still refused is a campaign somebody
   * stopped, and that is keyed on `stoppedAt` rather than the status.
   */
  it('accepts an upload into a running campaign, but not a stopped one', async () => {
    const running = await setup('RUNNING');
    const ok = await post(uploadUrl(running.ws.id, running.campaign.id), 'phone\n+919876543210\n');
    expect(ok.status).toBe(200);

    await truncateAll();

    const stopped = await setup('DRAFT');
    await prisma.campaign.update({
      where: { id: stopped.campaign.id },
      data: { status: 'STOPPED', stoppedAt: new Date() },
    });

    const res = await post(uploadUrl(stopped.ws.id, stopped.campaign.id), 'phone\n+919876543210\n');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CAMPAIGN_CONTACTS_LOCKED');
    expect(res.body.error.message).toContain('create a new campaign');
    // Refused before the file was turned into contacts nothing will dial.
    expect(await prisma.contact.count()).toBe(0);
  });

  it('keeps totalContacts in step with the queue it describes', async () => {
    const { ws, campaign } = await setup();
    const url = uploadUrl(ws.id, campaign.id);

    await post(url, 'phone\n+919876543210\n+14155550132\n');
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).totalContacts)
      .toBe(2);

    // A duplicate adds nothing, so it counts nothing.
    await post(url, 'phone\n+919876543210\n');
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).totalContacts)
      .toBe(2);
  });

  it('reads email and tags into the contact', async () => {
    const { ws, campaign } = await setup();

    await post(
      uploadUrl(ws.id, campaign.id),
      'phone,email,tags,city\n+919876543210,asha@example.com,vip;lapsed,Pune\n',
    );

    const contact = await prisma.contact.findFirstOrThrow();
    expect(contact.email).toBe('asha@example.com');
    expect(contact.tags).toEqual(['vip', 'lapsed']);
    // And not also into metadata: they have columns of their own.
    expect(contact.metadata).toEqual({ city: 'Pune' });
  });

  it('404s an upload aimed at another workspace campaign, writing nothing', async () => {
    const alice = await makeAccount('alice');
    const a = await makeWorkspace(alice, 'A Co');
    const b = await makeWorkspace(alice, 'B Co');
    const inB = await prisma.campaign.create({ data: { workspaceId: b.id, name: 'B' } });

    const res = await post(uploadUrl(a.id, inB.id), 'phone\n+919876543210\n');

    expect(res.status).toBe(404);
    // Our envelope, not Express's default HTML 404: this asserts the route
    // exists and scoped its lookup, rather than that it is simply absent.
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(await prisma.contact.count()).toBe(0);
  });

  it('refuses a MEMBER', async () => {
    const { ws, campaign } = await setup();
    const bob = await makeAccount('bob');
    await addMember(ws, bob, 'MEMBER');

    const res = await post(
      uploadUrl(ws.id, campaign.id),
      'phone\n+919876543210\n',
      'user_bob',
      'bob@ezo.test',
    );

    expect(res.status).toBe(403);
    expect(await prisma.contact.count()).toBe(0);
  });
});

describe('GET .../contacts', () => {
  it('paginates and filters by status', async () => {
    const { ws, campaign } = await setup();
    for (let i = 0; i < 5; i += 1) {
      const contact = await prisma.contact.create({
        data: { workspaceId: ws.id, phone: `+9198765432${10 + i}`, name: `C${i}` },
      });
      await prisma.campaignContact.create({
        data: {
          campaignId: campaign.id,
          contactId: contact.id,
          status: i === 0 ? 'EXCLUDED' : 'PENDING',
        },
      });
    }
    const base = `/api/workspaces/${ws.id}/campaigns/${campaign.id}/contacts`;
    const auth = as('user_alice', 'alice@ezo.test');

    const page = await request(app).get(`${base}?limit=2`).set(...auth);
    expect(page.status).toBe(200);
    expect(page.body.data.contacts).toHaveLength(2);
    expect(page.body.data.total).toBe(5);
    expect(page.body.data.contacts[0]).toMatchObject({ phone: expect.any(String) });

    const next = await request(app).get(`${base}?limit=2&offset=2`).set(...auth);
    expect(next.body.data.contacts).toHaveLength(2);
    expect(next.body.data.contacts[0].id).not.toBe(page.body.data.contacts[0].id);

    const last = await request(app).get(`${base}?limit=2&offset=4`).set(...auth);
    expect(last.body.data.contacts).toHaveLength(1);

    const filtered = await request(app).get(`${base}?status=EXCLUDED`).set(...auth);
    expect(filtered.body.data.contacts).toHaveLength(1);
    expect(filtered.body.data.total).toBe(1);
  });

  /**
   * `SKIPPED` is written by `stop` and by the retry-lowering sweep, so it is
   * the status a campaign's queue collapses into the moment an operator stops
   * one. A filter that refuses to name it makes the largest bucket on a stopped
   * campaign unreachable through the only list that shows contacts.
   */
  it('carries an inbound summary per contact on an INBOUND campaign, and none on OUTBOUND', async () => {
    const { ws, campaign } = await setup('RUNNING');
    await prisma.campaign.update({ where: { id: campaign.id }, data: { type: 'INBOUND' } });
    const did = await prisma.phoneNumber.create({
      data: { did: '+919000000061', workspaceId: ws.id, status: 'ASSIGNED' },
    });
    const contact = await prisma.contact.create({ data: { workspaceId: ws.id, phone: '+919876543210' } });
    const cc = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id, status: 'COMPLETED' },
    });
    const t1 = new Date('2026-09-10T10:00:00Z');
    const t2 = new Date('2026-09-10T12:00:00Z');
    for (const [id, endedAt, secs] of [['ic-a', t1, 30], ['ic-b', t2, 45]] as const) {
      await prisma.campaignInboundCall.create({
        data: {
          campaignId: campaign.id, campaignContactId: cc.id, contactId: contact.id, workspaceId: ws.id,
          phoneNumberId: did.id, fromNumber: contact.phone, upstreamCallId: id,
          arrivedAt: new Date(endedAt.getTime() - secs * 1000), endedAt, durationSecs: secs,
        },
      });
    }
    const base = `/api/workspaces/${ws.id}/campaigns/${campaign.id}/contacts`;
    const auth = as('user_alice', 'alice@ezo.test');

    const res = await request(app).get(base).set(...auth);
    expect(res.status).toBe(200);
    expect(res.body.data.contacts[0].inbound).toEqual({ calls: 2, talkSecs: 75, lastCallAt: t2.toISOString() });

    /**
     * A call still OPEN is the campaign's most recent activity, and this row
     * has to agree with the campaign tile above it.
     *
     * The regression this guards: reading `MAX(endedAt)` and `MAX(arrivedAt)`
     * as two independent aggregates and coalescing them afterwards takes the
     * two values off DIFFERENT rows — it answers 12:00 here (the last END)
     * while `inboundOutcomes` answers 14:00 (`MAX(COALESCE(endedAt,
     * arrivedAt))`), so the Callers tab shows an older last call than the
     * Overview for the same campaign. Both must be the open call's arrival.
     */
    const open = new Date('2026-09-10T14:00:00Z');
    await prisma.campaignInboundCall.create({
      data: {
        campaignId: campaign.id, campaignContactId: cc.id, contactId: contact.id, workspaceId: ws.id,
        phoneNumberId: did.id, fromNumber: contact.phone, upstreamCallId: 'ic-open',
        arrivedAt: open, endedAt: null, durationSecs: null,
      },
    });
    const withOpen = await request(app).get(base).set(...auth);
    expect(withOpen.body.data.contacts[0].inbound).toEqual({
      calls: 3,
      talkSecs: 75,
      lastCallAt: open.toISOString(),
    });
    expect((await inboundOutcomes([campaign.id]))[campaign.id]!.lastCallAt).toBe(
      withOpen.body.data.contacts[0].inbound.lastCallAt,
    );

    await prisma.campaign.update({ where: { id: campaign.id }, data: { type: 'OUTBOUND' } });
    const outbound = await request(app).get(base).set(...auth);
    expect(outbound.body.data.contacts[0]).not.toHaveProperty('inbound');
  });

  it('filters on SKIPPED, which stop and the retry sweep both write', async () => {
    const { ws, campaign } = await setup();
    const contact = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+919876543210' },
    });
    await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id, status: 'SKIPPED' },
    });

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/contacts?status=SKIPPED`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.contacts[0]).toMatchObject({ status: 'SKIPPED' });
  });

  /**
   * The roster's search box, which is a **phone** search first.
   *
   * A campaign's rows are mostly unnamed numbers, and the number an operator
   * has in hand came off a spreadsheet, a WhatsApp message or a caller ID — so
   * it arrives spaced, dashed, bracketed, with or without the country code and
   * sometimes with the national trunk zero in front. Matching the string as
   * typed against a stored E.164 answers "no contacts" for a number that is
   * plainly on the list, which reads as a broken list rather than a fussy box.
   */
  it('finds a number however the operator typed it', async () => {
    const { ws, campaign } = await setup();
    for (const phone of ['+919320333688', '+919876543210']) {
      const contact = await prisma.contact.create({ data: { workspaceId: ws.id, phone } });
      await prisma.campaignContact.create({
        data: { campaignId: campaign.id, contactId: contact.id },
      });
    }

    const base = `/api/workspaces/${ws.id}/campaigns/${campaign.id}/contacts`;
    const auth = as('user_alice', 'alice@ezo.test');

    for (const typed of [
      '9320333688',
      '93203 33688',
      '+91 93203-33688',
      '(93203) 33688',
      // The national form, trunk zero and all.
      '09320333688',
      // A fragment, which is what somebody reading a number off a screen types.
      '3336',
    ]) {
      const res = await request(app).get(`${base}?search=${encodeURIComponent(typed)}`).set(...auth);

      expect(res.status, typed).toBe(200);
      expect(res.body.data.total, typed).toBe(1);
      expect(res.body.data.contacts[0].phone, typed).toBe('+919320333688');
    }
  });

  it('finds a name whatever its case, and composes with the status filter', async () => {
    const { ws, campaign } = await setup();
    const asha = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+919320333688', name: 'Asha Menon' },
    });
    const ravi = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+919876543210', name: 'Ravi Kumar' },
    });
    await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: asha.id, status: 'COMPLETED' },
    });
    await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: ravi.id, status: 'PENDING' },
    });

    const base = `/api/workspaces/${ws.id}/campaigns/${campaign.id}/contacts`;
    const auth = as('user_alice', 'alice@ezo.test');

    const byName = await request(app).get(`${base}?search=asha`).set(...auth);
    expect(byName.body.data.total).toBe(1);
    expect(byName.body.data.contacts[0].name).toBe('Asha Menon');

    // ANDed with the status, never merged: a search inside a filtered view
    // narrows that view rather than escaping it.
    const filtered = await request(app).get(`${base}?search=asha&status=PENDING`).set(...auth);
    expect(filtered.body.data.total).toBe(0);
    expect(filtered.body.data.contacts).toEqual([]);
  });

  it('finds a trunk zero written after the country code, where a leading strip cannot reach', async () => {
    const { ws, campaign } = await setup();
    const contact = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+447911123456' },
    });
    await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });

    const base = `/api/workspaces/${ws.id}/campaigns/${campaign.id}/contacts`;
    const auth = as('user_alice', 'alice@ezo.test');

    /*
     * The commonest WRITTEN form of a trunk zero puts it after the country
     * code, not at the front of the string — so stripping leading zeros never
     * fires and the digits run `4407911123456`, which is not a substring of
     * the stored number. Every one of these is the same telephone.
     */
    for (const typed of ['+44 (0)7911 123456', '+44 7911 123456', '447911123456', '7911123456']) {
      const res = await request(app).get(`${base}?search=${encodeURIComponent(typed)}`).set(...auth);

      expect(res.status, typed).toBe(200);
      expect(res.body.data.total, typed).toBe(1);
      expect(res.body.data.contacts[0].phone, typed).toBe('+447911123456');
    }
  });

  it('does not answer one country\'s number with another\'s, nor a lone digit with the roster', async () => {
    const { ws, campaign } = await setup();
    for (const phone of ['+919876543210', '+919320333688']) {
      const contact = await prisma.contact.create({ data: { workspaceId: ws.id, phone } });
      await prisma.campaignContact.create({
        data: { campaignId: campaign.id, contactId: contact.id },
      });
    }

    const base = `/api/workspaces/${ws.id}/campaigns/${campaign.id}/contacts`;
    const auth = as('user_alice', 'alice@ezo.test');

    /*
     * `+919876543210` CONTAINS the US number `19876543210`, so an unanchored
     * substring answers an Indian contact for a search for somebody in another
     * country. A query that names its own country is matched whole.
     */
    const us = await request(app).get(`${base}?search=${encodeURIComponent('+1-987-654-3210')}`).set(...auth);
    expect(us.body.data).toMatchObject({ total: 0, contacts: [] });

    // And one digit is not a search: it is inside most stored numbers.
    const single = await request(app).get(`${base}?search=0`).set(...auth);
    expect(single.body.data.total).toBe(0);
  });

  it('treats a LIKE wildcard as text, not as a pattern matching the whole roster', async () => {
    const { ws, campaign } = await setup();
    for (const [phone, name] of [
      ['+919320333688', 'Asha Menon'],
      ['+919876543210', 'Ravi Kumar'],
    ] as const) {
      const contact = await prisma.contact.create({ data: { workspaceId: ws.id, phone, name } });
      await prisma.campaignContact.create({
        data: { campaignId: campaign.id, contactId: contact.id },
      });
    }
    const literal = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+919000000001', name: '100% Cotton Ltd' },
    });
    await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: literal.id },
    });

    const base = `/api/workspaces/${ws.id}/campaigns/${campaign.id}/contacts`;
    const auth = as('user_alice', 'alice@ezo.test');

    /*
     * Prisma does not escape LIKE's own metacharacters, so a lone `%` is
     * `ILIKE '%%%'` — every named contact, under a `total` that agrees with
     * it, presented as a search result rather than as the whole roster.
     */
    const wildcard = await request(app).get(`${base}?search=${encodeURIComponent('%')}`).set(...auth);
    expect(wildcard.body.data.total).toBe(1);
    expect(wildcard.body.data.contacts[0].name).toBe('100% Cotton Ltd');

    // `_` is the other one, and matches a single character unescaped.
    const underscore = await request(app).get(`${base}?search=${encodeURIComponent('Ash_')}`).set(...auth);
    expect(underscore.body.data).toMatchObject({ total: 0, contacts: [] });
  });

  it('answers an unmatched search with an empty page rather than the whole roster', async () => {
    const { ws, campaign } = await setup();
    const contact = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+919320333688' },
    });
    await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/contacts?search=%2B1415`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ total: 0, contacts: [] });
  });

  it('is readable by a MEMBER and 404s across workspaces', async () => {
    const { ws, campaign } = await setup();
    const bob = await makeAccount('bob');
    await addMember(ws, bob, 'MEMBER');

    const ok = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/contacts`)
      .set(...as('user_bob', 'bob@ezo.test'));
    expect(ok.status).toBe(200);

    const other = await makeWorkspace(bob, 'B Co');
    const crossed = await request(app)
      .get(`/api/workspaces/${other.id}/campaigns/${campaign.id}/contacts`)
      .set(...as('user_bob', 'bob@ezo.test'));
    expect(crossed.status).toBe(404);
    // Our envelope, not Express's default HTML 404: asserting the status alone
    // would pass just as well with this route deleted, which is the one thing
    // an isolation test must not do.
    expect(crossed.body.error.code).toBe('NOT_FOUND');
  });
});

describe('DELETE .../contacts/:ccid', () => {
  it('excludes rather than deletes', async () => {
    const { ws, campaign } = await setup();
    const contact = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+919876543210' },
    });
    const link = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });

    const res = await request(app)
      .delete(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/contacts/${link.id}`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('EXCLUDED');
    // The row survives: it records that this person was on this list, and
    // deleting it would let the next upload re-add and dial them.
    expect(await prisma.campaignContact.count()).toBe(1);
  });

  it('404s a contact row that belongs to another campaign', async () => {
    const { ws, campaign } = await setup();
    const other = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'Other' } });
    const contact = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+919876543210' },
    });
    const link = await prisma.campaignContact.create({
      data: { campaignId: other.id, contactId: contact.id },
    });

    const res = await request(app)
      .delete(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/contacts/${link.id}`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect((await prisma.campaignContact.findUniqueOrThrow({ where: { id: link.id } })).status)
      .toBe('PENDING');
  });

  it('refuses a MEMBER', async () => {
    const { ws, campaign } = await setup();
    const bob = await makeAccount('bob');
    await addMember(ws, bob, 'MEMBER');
    const contact = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+919876543210' },
    });
    const link = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });

    const res = await request(app)
      .delete(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/contacts/${link.id}`)
      .set(...as('user_bob', 'bob@ezo.test'));

    expect(res.status).toBe(403);
  });
});

describe('GET .../stats', () => {
  it('counts every status, including the ones at zero', async () => {
    const { ws, campaign } = await setup();
    // Deliberately no SKIPPED row: the zero-fill is the thing under test, and
    // a status that is present is counted by the groupBy whether it was seeded
    // at zero or not.
    const statuses = ['PENDING', 'PENDING', 'COMPLETED', 'EXCLUDED'] as const;

    for (const [i, status] of statuses.entries()) {
      const contact = await prisma.contact.create({
        data: { workspaceId: ws.id, phone: `+9198765432${10 + i}` },
      });
      await prisma.campaignContact.create({
        data: { campaignId: campaign.id, contactId: contact.id, status },
      });
    }

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/stats`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    // `toMatchObject`, because the dialer added a live `dialer` block beside
    // these counts. What this case is about is that every status is present
    // and the zeroes are real — `toEqual` would make it fail whenever the
    // payload grows, which is a different assertion from the one intended.
    expect(res.body.data).toMatchObject({
      total: 4,
      byStatus: {
        PENDING: 2,
        QUEUED: 0,
        CALLING: 0,
        COMPLETED: 1,
        FAILED: 0,
        EXCLUDED: 1,
        // Written by stop and by the retry-lowering sweep. Missing from the
        // zero-fill, a campaign that has skipped nothing yet simply loses the
        // row — and gains it the moment somebody presses Stop.
        SKIPPED: 0,
      },
    });
    // The counts themselves are still exact.
    expect(Object.keys(res.body.data.byStatus).sort()).toEqual([
      'CALLING',
      'COMPLETED',
      'EXCLUDED',
      'FAILED',
      'PENDING',
      'QUEUED',
      'SKIPPED',
    ]);
  });

  it('is readable by a MEMBER and 404s across workspaces', async () => {
    const { ws, campaign } = await setup();
    const bob = await makeAccount('bob');
    await addMember(ws, bob, 'MEMBER');

    const ok = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/stats`)
      .set(...as('user_bob', 'bob@ezo.test'));
    expect(ok.status).toBe(200);

    const other = await makeWorkspace(bob, 'B Co');
    const crossed = await request(app)
      .get(`/api/workspaces/${other.id}/campaigns/${campaign.id}/stats`)
      .set(...as('user_bob', 'bob@ezo.test'));
    expect(crossed.status).toBe(404);
    expect(crossed.body.error.code).toBe('NOT_FOUND');
  });
});
