import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { as, makeAccount, makeAgent, makePhoneNumber, makeWorkspace } from './helpers.js';
import { phoneNumberIsUsable } from '../src/lib/phoneNumberVisibility.js';

/**
 * `start` and `resume` now reach the voice platform to make the campaign's
 * caller number outbound-ready. Mocked here, as every upstream call in this
 * suite is: no test may place a call or build routing on a live account.
 */
vi.mock('../src/adapter/vocobase.js', () => ({
  voicelinkCallReady: vi.fn(async () => ({ ready: true, readiness: { state: 'READY', issues: [] } })),
  startCall: vi.fn(),
  getConcurrency: vi.fn(),
  getCall: vi.fn(),
  // The callback extraction key, ensured on every start and resume. Stubbed as
  // "already set up" so these cases exercise the transition rather than it.
  listExtractionSets: vi.fn(async () => ({
    extraction_sets: [{ id: 'set_cb', name: 'Campaign callbacks' }],
  })),
  createExtractionSet: vi.fn(),
  listAgentExtractionSets: vi.fn(async () => ({
    extraction_sets: [{ id: 'set_cb', name: 'Campaign callbacks' }],
  })),
  attachAgentExtractionSet: vi.fn(),
  getAgent: vi.fn(async () => ({ extraction_enabled: true })),
  updateAgent: vi.fn(),
}));


describe('phoneNumberIsUsable', () => {
  const ws = 'ws_1';

  it('accepts an assigned number in this workspace', () => {
    expect(phoneNumberIsUsable({ status: 'ASSIGNED', workspaceId: ws }, ws)).toBe(true);
  });

  // The enum's own comment settles this: a past-due DID still belongs to the
  // workspace and still rings. A campaign losing its caller id the moment a
  // card expired would be a billing state quietly editing a configuration.
  it('accepts a past-due number — it is still held and still rings', () => {
    expect(phoneNumberIsUsable({ status: 'PAST_DUE', workspaceId: ws }, ws)).toBe(true);
  });

  it('refuses a number held by another workspace', () => {
    expect(phoneNumberIsUsable({ status: 'ASSIGNED', workspaceId: 'ws_2' }, ws)).toBe(false);
  });

  it('refuses a pool number and one released for non-payment', () => {
    expect(phoneNumberIsUsable({ status: 'UNASSIGNED', workspaceId: null }, ws)).toBe(false);
    expect(phoneNumberIsUsable({ status: 'RELEASED_NONPAYMENT', workspaceId: ws }, ws)).toBe(
      false,
    );
  });

  it('refuses nothing at all', () => {
    expect(phoneNumberIsUsable(null, ws)).toBe(false);
    expect(phoneNumberIsUsable(undefined, ws)).toBe(false);
  });
});

const app = createApp();

beforeEach(async () => {
  await truncateAll();
});

const AUTH = as('user_alice', 'alice@ezo.test');

describe('the caller number on a campaign payload', () => {
  it('serializes the id and the DID, and nothing else about the number', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const number = await makePhoneNumber(ws, '+1415555');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', phoneNumberId: number.id },
    });

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...AUTH);

    expect(res.status).toBe(200);
    expect(res.body.data.phoneNumberId).toBe(number.id);
    // Two keys exactly. A summary that grew because the phone-numbers page
    // needed a field would quietly widen this payload too.
    expect(res.body.data.phoneNumber).toEqual({ id: number.id, did: number.did });
  });

  it('serializes a past-due number as usable', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const number = await makePhoneNumber(ws, '+1415555', 'PAST_DUE');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', phoneNumberId: number.id },
    });

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...AUTH);

    expect(res.body.data.phoneNumber).toEqual({ id: number.id, did: number.did });
  });

  it('keeps the pointer and withholds the summary once the number goes back to the pool', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const number = await makePhoneNumber(ws, '+1415555');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', phoneNumberId: number.id },
    });

    // A release, as the renewal sweep writes it.
    await prisma.phoneNumber.update({
      where: { id: number.id },
      data: { workspaceId: null, status: 'RELEASED_NONPAYMENT' },
    });

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...AUTH);

    // Both, not neither. Nulling the id too would make "unavailable"
    // indistinguishable from "not set" on the wire, and leave the dashboard
    // unable to say why the campaign points at nothing.
    expect(res.body.data.phoneNumberId).toBe(number.id);
    expect(res.body.data.phoneNumber).toBeNull();
  });

  it('never leaks the DID of a number that has moved to another workspace', async () => {
    const alice = await makeAccount('alice');
    const mine = await makeWorkspace(alice, 'A Co');
    const theirs = await makeWorkspace(alice, 'B Co');
    const number = await makePhoneNumber(mine, '+1415555');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: mine.id, name: 'Q3', phoneNumberId: number.id },
    });

    await prisma.phoneNumber.update({
      where: { id: number.id },
      data: { workspaceId: theirs.id },
    });

    const res = await request(app)
      .get(`/api/workspaces/${mine.id}/campaigns/${campaign.id}`)
      .set(...AUTH);

    expect(res.body.data.phoneNumber).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(number.did);
  });

  it('serializes both as null when no number has been chosen', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const campaign = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'Q3' } });

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...AUTH);

    expect(res.body.data.phoneNumberId).toBeNull();
    expect(res.body.data.phoneNumber).toBeNull();
  });

  it('carries the number on the list as well as the detail', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const number = await makePhoneNumber(ws, '+1415555');
    await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', phoneNumberId: number.id },
    });

    const res = await request(app).get(`/api/workspaces/${ws.id}/campaigns`).set(...AUTH);

    expect(res.body.data.campaigns[0].phoneNumber).toEqual({ id: number.id, did: number.did });
  });
});

describe('assigning a caller number to a campaign', () => {
  it('accepts a number this workspace holds', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const number = await makePhoneNumber(ws, '+1415555');
    const campaign = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'Q3' } });

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...AUTH)
      .send({ phoneNumberId: number.id });

    expect(res.status).toBe(200);
    expect(res.body.data.phoneNumberId).toBe(number.id);

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.phoneNumberId).toBe(number.id);
  });

  it('accepts a past-due number — it is still theirs', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const number = await makePhoneNumber(ws, '+1415555', 'PAST_DUE');
    const campaign = await prisma.campaign.create({ data: { workspaceId: ws.id, name: 'Q3' } });

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...AUTH)
      .send({ phoneNumberId: number.id });

    expect(res.status).toBe(200);
    expect(res.body.data.phoneNumberId).toBe(number.id);
  });

  it('422s a foreign, pooled, released and nonexistent number identically', async () => {
    const alice = await makeAccount('alice');
    const mine = await makeWorkspace(alice, 'A Co');
    const theirs = await makeWorkspace(alice, 'B Co');
    const foreign = await makePhoneNumber(theirs, '+1415555');
    const pooled = await makePhoneNumber(null, '+1415666', 'UNASSIGNED');
    const released = await makePhoneNumber(null, '+1415777', 'RELEASED_NONPAYMENT');
    const campaign = await prisma.campaign.create({ data: { workspaceId: mine.id, name: 'Q3' } });

    const patch = (phoneNumberId: string) =>
      request(app)
        .patch(`/api/workspaces/${mine.id}/campaigns/${campaign.id}`)
        .set(...AUTH)
        .send({ phoneNumberId });

    // Sequential rather than concurrent: these share one campaign row, and a
    // parallel write would make the "nothing was stored" assertion a race.
    const results = [
      await patch(foreign.id),
      await patch(pooled.id),
      await patch(released.id),
      await patch('phone_does_not_exist'),
    ];

    for (const res of results) {
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('CAMPAIGN_PHONE_NUMBER_NOT_FOUND');
    }

    // Byte-identical. A caller must not be able to sort ids into real and
    // unreal by comparing responses — and a DID is a real-world phone number,
    // which makes enumeration worth more here than it is anywhere else.
    expect(new Set(results.map((r) => JSON.stringify(r.body))).size).toBe(1);

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.phoneNumberId).toBeNull();
  });

  it('never names the foreign number in the refusal', async () => {
    const alice = await makeAccount('alice');
    const mine = await makeWorkspace(alice, 'A Co');
    const theirs = await makeWorkspace(alice, 'B Co');
    const foreign = await makePhoneNumber(theirs, '+1415555');
    const campaign = await prisma.campaign.create({ data: { workspaceId: mine.id, name: 'Q3' } });

    const res = await request(app)
      .patch(`/api/workspaces/${mine.id}/campaigns/${campaign.id}`)
      .set(...AUTH)
      .send({ phoneNumberId: foreign.id });

    expect(JSON.stringify(res.body)).not.toContain(foreign.did);
  });

  it('clears the number when sent null', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const number = await makePhoneNumber(ws, '+1415555');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', phoneNumberId: number.id },
    });

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...AUTH)
      .send({ phoneNumberId: null });

    expect(res.status).toBe(200);
    expect(res.body.data.phoneNumberId).toBeNull();
    expect(res.body.data.phoneNumber).toBeNull();
  });

  /**
   * A live campaign may be given a different number, through the legacy
   * single-value field as well as the rotation.
   *
   * `resolveDialRotation` re-reads the attachments on every dispatcher pass,
   * so the change lands on the next tick and contradicts nothing: what a call
   * already placed went out from is on its own attempt row.
   */
  it('lets a running campaign change the number it dials from', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const held = await makePhoneNumber(ws, '+1415555');
    const other = await makePhoneNumber(ws, '+1415666');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', phoneNumberId: held.id, status: 'RUNNING' },
    });

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...AUTH)
      .send({ phoneNumberId: other.id });

    expect(res.status).toBe(200);

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.phoneNumberId).toBe(other.id);
  });

  /**
   * The legacy field's own empty spelling, refused for the same reason the
   * empty rotation is: a live campaign left with nothing to dial from holds
   * its queue silently.
   */
  it('refuses to clear the number of a running campaign', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const held = await makePhoneNumber(ws, '+1415555');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', phoneNumberId: held.id, status: 'RUNNING' },
    });

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...AUTH)
      .send({ phoneNumberId: null });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAMPAIGN_NEEDS_PHONE_NUMBER');
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).phoneNumberId)
      .toBe(held.id);
  });

  it('lets a running campaign resubmit the number it already has', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const held = await makePhoneNumber(ws, '+1415555');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', phoneNumberId: held.id, status: 'RUNNING' },
    });

    // The dashboard sends the whole form. A field carrying the value it
    // already holds is not an edit, so it must not make the save fail.
    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...AUTH)
      .send({ phoneNumberId: held.id });

    expect(res.status).toBe(200);
    expect(res.body.data.phoneNumberId).toBe(held.id);
  });

  /** The same for a paused one — the gate reads one list of live statuses. */
  it('lets a paused campaign change the number it dials from', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const held = await makePhoneNumber(ws, '+1415555');
    const other = await makePhoneNumber(ws, '+1415666');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', phoneNumberId: held.id, status: 'PAUSED' },
    });

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...AUTH)
      .send({ phoneNumberId: other.id });

    expect(res.status).toBe(200);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).phoneNumberId)
      .toBe(other.id);
  });

  /**
   * The deferred decision, decided.
   *
   * This slice used to start a campaign with no caller number, on the grounds
   * that the dialer would decide whether one was required. It is: the platform
   * requires `from_number` to name a number active on the connection, so a
   * campaign without one would dial from whatever the connection defaults
   * to — some other customer's published business number.
   */
  it('refuses to start a campaign that has no caller number', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Sales');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', agentId: agent.id },
    });
    const contact = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+14155550001' },
    });
    await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });

    const res = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/start`)
      .set(...AUTH);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAMPAIGN_PHONE_NUMBER_REQUIRED');

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.status).toBe('DRAFT');
  });
});
