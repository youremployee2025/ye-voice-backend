import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Account, Campaign, CampaignContact, Workspace } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { campaignOutcomes } from '../src/lib/campaignOutcomes.js';
import { as, makeAccount, makeWorkspace } from './helpers.js';

/**
 * What a campaign adds up to.
 *
 * Two surfaces, one arithmetic: the stats page reads one campaign in detail,
 * and the list reads a page of them in one grouped query. Both have to be
 * honest about the rows they cannot classify — a segment that silently comes up
 * short is worse than one labelled "unknown".
 */

const app = createApp();

beforeEach(async () => {
  await truncateAll();
});

const auth = as('user_alice', 'alice@ezo.test');

// `armMidRead` spies on the shared client, and its callers restore in a
// `finally` — this is the backstop for a failure that escapes before the
// `try`, so one broken test cannot leave the next one reading through a gate.
afterEach(() => {
  vi.restoreAllMocks();
});

async function setup(fields: Partial<Campaign> = {}) {
  const alice = await makeAccount('alice');
  const ws = await makeWorkspace(alice, 'A Co');
  const campaign = await prisma.campaign.create({
    data: { workspaceId: ws.id, name: 'Q3', status: 'RUNNING', ...fields },
  });

  return { alice, ws, campaign };
}

let seq = 0;

async function addContact(
  ws: Workspace,
  campaign: Campaign,
  fields: Partial<CampaignContact> = {},
) {
  seq += 1;
  const contact = await prisma.contact.create({
    data: { workspaceId: ws.id, phone: `+9198765${String(43000 + seq).padStart(5, '0')}` },
  });

  return prisma.campaignContact.create({
    data: { campaignId: campaign.id, contactId: contact.id, ...fields },
  });
}

let attemptSeq = 0;

async function addAttempt(
  ws: Workspace,
  owner: Account,
  campaign: Campaign,
  link: CampaignContact,
  fields: {
    durationSecs?: number | null;
    costCredits?: bigint | null;
    /** The dial's OWN outcome, which is what `reached` counts over. Distinct
     *  from the copy the resolution leaves on the join row: that one is
     *  overwritten by the next dial, and this one never is. */
    disposition?: string | null;
    answeredBy?: string | null;
  } = {},
) {
  attemptSeq += 1;

  return prisma.callAttempt.create({
    data: {
      campaignId: campaign.id,
      campaignContactId: link.id,
      workspaceId: ws.id,
      accountId: owner.id,
      attemptNo: attemptSeq,
      status: 'COMPLETED',
      resolvedAt: new Date(),
      durationSecs: fields.durationSecs ?? null,
      costCredits: fields.costCredits ?? null,
      disposition: fields.disposition ?? null,
      answeredBy: fields.answeredBy ?? null,
    },
  });
}

const statsUrl = (ws: Workspace, campaign: Campaign) =>
  `/api/workspaces/${ws.id}/campaigns/${campaign.id}/stats`;

/** The nine the platform can report, and the only nine this page ever shows. */
const CANONICAL = [
  'blocked',
  'busy',
  'canceled',
  'completed',
  'failed',
  'no_answer',
  'transferred',
  'user_hangup_no_speech',
  'voicemail',
];

/**
 * Force the race a single statement is supposed to be immune to.
 *
 * The first statement of the read under test is allowed through, the re-arm
 * then lands, and **every statement issued after it is held until that re-arm
 * has committed** — so any second statement is by construction reading the
 * later snapshot. Read from one statement there is no second snapshot to hold,
 * the re-arm is simply outside the instant being reported, and the numbers
 * still agree; read from two, the second one sees a row the first could not and
 * the payload's own arithmetic breaks.
 *
 * Every read path the routes under test use is wrapped, `count` included:
 * spying on `$queryRaw` alone leaves a Prisma-builder statement free to run
 * before the arm, which is a gate that never closes and a test that cannot
 * fail.
 *
 * Returns a `restore` the caller must run — the spies are installed on the
 * shared client.
 */
function armMidRead(land: () => Promise<unknown>) {
  const raw = prisma.$queryRaw.bind(prisma);
  const count = prisma.campaignContact.count.bind(prisma.campaignContact);
  const groupBy = prisma.campaignContact.groupBy.bind(prisma.campaignContact);
  const aggregate = prisma.callAttempt.aggregate.bind(prisma.callAttempt);
  const attemptCount = prisma.callAttempt.count.bind(prisma.callAttempt);

  const statements: string[] = [];
  let openGate = () => {};
  const armed = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  let taken = false;

  const observe = async <T>(run: () => Promise<T>): Promise<T> => {
    if (taken) {
      await armed;
      return run();
    }

    taken = true;
    const rows = await run();

    try {
      await land();
    } finally {
      // In the `finally`, so a re-arm that throws fails this test through the
      // assertion it breaks rather than by parking every sibling statement on
      // a gate that never opens — a hung request and a timeout say nothing
      // about the property under test.
      openGate();
    }

    return rows;
  };

  vi.spyOn(prisma, '$queryRaw').mockImplementation((async (...args: never[]) => {
    // The statement text, for the structural half of the claim: one fold, not
    // two statements that happen to agree today.
    const [strings] = args as unknown as [TemplateStringsArray];
    statements.push(Array.isArray(strings) ? [...strings].join('?') : String(strings));

    return observe(() => raw(...(args as Parameters<typeof raw>)));
  }) as never);
  vi.spyOn(prisma.campaignContact, 'count').mockImplementation((async (args: never) =>
    observe(() => count(args))) as never);
  vi.spyOn(prisma.campaignContact, 'groupBy').mockImplementation((async (args: never) =>
    observe(() => groupBy(args))) as never);
  vi.spyOn(prisma.callAttempt, 'aggregate').mockImplementation((async (args: never) =>
    observe(() => aggregate(args))) as never);
  vi.spyOn(prisma.callAttempt, 'count').mockImplementation((async (args: never) =>
    observe(() => attemptCount(args))) as never);

  return { statements, restore: () => vi.restoreAllMocks() };
}

describe('GET .../stats', () => {
  it('zero-fills every status and every disposition on a campaign with nothing in it', async () => {
    const { ws, campaign } = await setup();

    const res = await request(app).get(statsUrl(ws, campaign)).set(...auth);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data.byStatus).sort()).toEqual([
      'CALLING',
      'COMPLETED',
      'EXCLUDED',
      'FAILED',
      'PENDING',
      'QUEUED',
      'SKIPPED',
    ]);
    expect(Object.keys(res.body.data.dispositions).sort()).toEqual(CANONICAL);
    expect(Object.values(res.body.data.dispositions)).toEqual(CANONICAL.map(() => 0));
    expect(res.body.data).toMatchObject({
      total: 0,
      settledUnknown: 0,
      callbacksPending: 0,
      // Both halves present and zero. This is the first payload a dashboard
      // ever renders, and an absent `waiting` is not the same thing as an
      // empty one — the first reads as a backend that did not answer.
      waiting: { neverCalled: 0, betweenCalls: 0 },
      avgDuration: null,
      totalCredits: '0',
    });
  });

  it('counts a disposition nobody has heard of rather than dropping it', async () => {
    const { ws, campaign } = await setup();

    await addContact(ws, campaign, { status: 'COMPLETED', disposition: 'completed' });
    await addContact(ws, campaign, { status: 'FAILED', disposition: 'no_answer' });
    // A carrier value that postdates this deployment. The set is the platform's
    // and it grows; a page that silently discarded these would report a
    // campaign as having reached fewer people than it did.
    await addContact(ws, campaign, { status: 'FAILED', disposition: 'carrier_shrugged' });

    const res = await request(app).get(statsUrl(ws, campaign)).set(...auth);

    expect(res.body.data.dispositions).toMatchObject({ completed: 1, no_answer: 1, voicemail: 0 });
    expect(Object.keys(res.body.data.dispositions).sort()).toEqual(CANONICAL);
    expect(res.body.data.settledUnknown).toBe(1);
  });

  it('counts only promises still ahead as pending callbacks', async () => {
    const { ws, campaign } = await setup();
    const future = new Date(Date.now() + 60 * 60_000);
    const past = new Date(Date.now() - 60 * 60_000);

    await addContact(ws, campaign, {
      status: 'PENDING',
      armKind: 'CALLBACK',
      nextEligibleAt: future,
      callbackAt: future,
    });
    // Due, and the dispatcher has not reached it yet. It is a backlog item, not
    // a future commitment.
    await addContact(ws, campaign, {
      status: 'PENDING',
      armKind: 'CALLBACK',
      nextEligibleAt: past,
      callbackAt: past,
    });
    // Settled: whatever its history says, nobody is waiting on it.
    await addContact(ws, campaign, { status: 'COMPLETED', armKind: 'CALLBACK', callbackAt: future });
    /**
     * A promise already kept, on a contact the ladder has re-armed since.
     * `callbackAt` is the only record that a promise was ever made, so it
     * stays — and a tile counting the column alone read this waiting retry as
     * a commitment the campaign still owes, for a call that was placed days
     * ago.
     */
    await addContact(ws, campaign, {
      status: 'PENDING',
      armKind: 'RETRY',
      attempts: 1,
      nextEligibleAt: new Date(Date.now() + 30 * 60_000),
      callbackAt: future,
    });
    // And the resume of a dropped call, which nobody asked for.
    await addContact(ws, campaign, {
      status: 'PENDING',
      armKind: 'RESUME',
      followUpCount: 1,
      nextEligibleAt: new Date(Date.now() + 5 * 60_000),
      callbackAt: future,
    });

    const res = await request(app).get(statsUrl(ws, campaign)).set(...auth);

    expect(res.body.data.callbacksPending).toBe(1);
  });

  it('averages the minutes of the calls that reached somebody', async () => {
    const { alice, ws, campaign } = await setup();
    const completed = await addContact(ws, campaign, { status: 'COMPLETED' });
    const failed = await addContact(ws, campaign, { status: 'FAILED' });

    await addAttempt(ws, alice, campaign, completed, { durationSecs: 60 });
    await addAttempt(ws, alice, campaign, completed, { durationSecs: 120 });
    // A contact that never got through must not drag the average down: the
    // number is about how long a conversation lasts.
    await addAttempt(ws, alice, campaign, failed, { durationSecs: 0 });

    const res = await request(app).get(statsUrl(ws, campaign)).set(...auth);

    expect(res.body.data.avgDuration).toBe(90);
  });

  it('spends what the ledger says, not what the attempts owed', async () => {
    const { alice, ws, campaign } = await setup();
    const link = await addContact(ws, campaign, { status: 'COMPLETED' });

    const charged = await addAttempt(ws, alice, campaign, link, { costCredits: 30_000n });
    // A shortfall records what was **owed and never taken**. Counting it would
    // show a workspace spending credits it still holds.
    const owed = await addAttempt(ws, alice, campaign, link, { costCredits: 50_000n });

    await prisma.creditTransaction.create({
      data: {
        accountId: alice.id,
        workspaceId: ws.id,
        callAttemptId: charged.id,
        reference: charged.id,
        amount: -30_000n,
        type: 'CALL_USAGE',
      },
    });
    await prisma.creditTransaction.create({
      data: {
        accountId: alice.id,
        workspaceId: ws.id,
        callAttemptId: owed.id,
        reference: owed.id,
        amount: 0n,
        type: 'CALL_USAGE_SHORTFALL',
      },
    });

    const res = await request(app).get(statsUrl(ws, campaign)).set(...auth);

    expect(res.body.data.totalCredits).toBe('3');
  });

  /**
   * "Waiting" is two different situations, and the page draws them apart.
   *
   * All three counters are asked, because each moves on its own path and any
   * one of them proves a dial happened. The follow-up is the arm the older
   * two-counter test missed: the goal re-arm moves `followUpCount` alone, so a
   * contact that had a full conversation and is queued to be rung again read
   * as somebody nobody had ever called.
   */
  it('splits pending on the claim stamp, whatever the dial counters say', async () => {
    const { ws, campaign } = await setup();
    const dialed = new Date();

    // Never called: nothing ever claimed this contact.
    await addContact(ws, campaign, { status: 'PENDING' });
    // Between calls, one row per re-arm the engine writes — a spent retry, a
    // booked callback, a goal follow-up. Each carries the claim's stamp,
    // because each of those counters is only ever moved by a dial that set it.
    await addContact(ws, campaign, { status: 'PENDING', attempts: 1, lastAttemptAt: dialed });
    await addContact(ws, campaign, { status: 'PENDING', callbackCount: 1, lastAttemptAt: dialed });
    await addContact(ws, campaign, {
      status: 'PENDING',
      followUpCount: 1,
      disposition: 'completed',
      lastAttemptAt: dialed,
    });
    // Settled, so in neither half: the split partitions PENDING and nothing
    // else.
    await addContact(ws, campaign, {
      status: 'COMPLETED',
      attempts: 1,
      lastAttemptAt: dialed,
    });

    const res = await request(app).get(statsUrl(ws, campaign)).set(...auth);

    expect(res.body.data.waiting).toEqual({ neverCalled: 1, betweenCalls: 3 });
  });

  /**
   * The property the payload actually claims: the split partitions the number
   * it splits.
   *
   * Asserted across the payload rather than inside `waiting` alone, because
   * `byStatus.PENDING` is the figure a reader compares the two halves against
   * — three keys apart in one object. Both come from one statement and one
   * snapshot, so this holds by construction; read from two, the pair could
   * overflow the total it describes, and a goal campaign re-arming contacts
   * `CALLING → PENDING` produces exactly that divergence continuously.
   */
  it('splits pending into halves that add back up to the pending count', async () => {
    const { ws, campaign } = await setup();

    const dialed = new Date();

    await addContact(ws, campaign, { status: 'PENDING' });
    await addContact(ws, campaign, { status: 'PENDING' });
    await addContact(ws, campaign, { status: 'PENDING', attempts: 2, lastAttemptAt: dialed });
    await addContact(ws, campaign, { status: 'PENDING', callbackCount: 1, lastAttemptAt: dialed });
    await addContact(ws, campaign, { status: 'PENDING', followUpCount: 1, lastAttemptAt: dialed });
    // Not PENDING, so outside the split entirely — it must not leak into
    // either half.
    await addContact(ws, campaign, { status: 'COMPLETED', attempts: 1, lastAttemptAt: dialed });
    await addContact(ws, campaign, { status: 'QUEUED', lastAttemptAt: dialed });

    const { waiting, byStatus } = (await request(app).get(statsUrl(ws, campaign)).set(...auth))
      .body.data;

    expect(waiting).toEqual({ neverCalled: 2, betweenCalls: 3 });
    expect(waiting.neverCalled + waiting.betweenCalls).toBe(byStatus.PENDING);
  });

  /**
   * The other property the payload claims: **`callbacksPending` is a subset of
   * `waiting.betweenCalls`**, so it may never exceed it.
   *
   * True within one snapshot and worth nothing across two. A callback is booked
   * by a call that stamped `lastAttemptAt`, so the moment a booking re-arms a
   * contact `CALLING → PENDING` it enters *both* counts — and read from two
   * statements on two connections under READ COMMITTED, it can enter the later
   * one alone. That is the same transition the `waiting` split was folded into
   * one statement for, and the docstring beside it asserts the subset relation
   * as a property, which two snapshots cannot deliver.
   *
   * The race is forced rather than hoped for: the booking lands after the
   * first statement of the request has read, and `armMidRead` then holds every
   * later statement — `$queryRaw`, `count`, `groupBy`, `aggregate` — until it
   * has committed. A second statement reading the callbacks would therefore see
   * the arm the split could not, and ship a subset of size one out of a set of
   * size zero. With the fold there is no second statement to see it: the whole
   * payload is one instant, which is the property, and the structural
   * assertion below pins that it stays one statement.
   */
  it('never ships more callbacks pending than the split that contains them', async () => {
    const { ws, campaign } = await setup();
    const soon = new Date(Date.now() + 60 * 60_000);

    // On the telephone right now: in neither half of `waiting`, owed nothing.
    const live = await addContact(ws, campaign, { status: 'CALLING' });
    await addContact(ws, campaign, { status: 'PENDING' });

    // The call ends and the lead asks to be rung back tomorrow.
    const { statements, restore } = armMidRead(() =>
      prisma.campaignContact.update({
        where: { id: live.id },
        data: {
          status: 'PENDING',
          armKind: 'CALLBACK',
          callbackAt: soon,
          nextEligibleAt: soon,
          callbackCount: 1,
          lastAttemptAt: new Date(),
        },
      }),
    );

    try {
      const { callbacksPending, waiting, byStatus } = (
        await request(app).get(statsUrl(ws, campaign)).set(...auth)
      ).body.data;

      expect(callbacksPending).toBeLessThanOrEqual(waiting.betweenCalls);
      expect(waiting.neverCalled + waiting.betweenCalls).toBe(byStatus.PENDING);
      // One instant, so the whole payload predates the booking rather than
      // half of it doing so.
      expect(byStatus.CALLING).toBe(1);
      expect(callbacksPending).toBe(0);

      // And structurally: the three figures come from one statement. A second
      // statement carrying any of them is the two-snapshot shape this was
      // folded out of, whatever it happens to report on the day.
      const carrying = statements.filter((sql) => sql.includes('"callbacksPending"'));
      expect(carrying).toHaveLength(1);
      expect(carrying[0]).toContain('"betweenCalls"');
      expect(carrying[0]).toContain('GROUP BY cc.status');
    } finally {
      restore();
    }
  });

  /**
   * The shape four give-back paths leave behind, and the one the counters
   * cannot see.
   *
   * A claim stamps `lastAttemptAt` in the same `UPDATE` that flips a contact
   * `PENDING → QUEUED`, and four paths then hand that contact back to PENDING
   * without moving a counter: the attempt-row insert failing and
   * `rollbackLaunch` (`dialer.ts`), `releaseStaleClaims` (`dialerReaper.ts`)
   * and the placement worker's `giveBack` (`dialerPlacement.ts`). After a
   * rate-limited sweep that is not one row, it is the sweep.
   *
   * Counted off the three dial counters this reads as somebody nobody has ever
   * rung, while the analytics funnel's `attempted` and the bucket panel's
   * `unreached` — both `lastAttemptAt` — count the same contact as dialled.
   * Two pages of the same dashboard disagreeing about one row is the bug.
   */
  it('counts a contact given back after a claim as between calls, not never called', async () => {
    const { ws, campaign } = await setup();

    // The give-back shape exactly: stamped by the claim, every counter still
    // at zero, waiting again.
    await addContact(ws, campaign, {
      status: 'PENDING',
      lastAttemptAt: new Date(),
      attempts: 0,
      callbackCount: 0,
      followUpCount: 0,
    });

    const res = await request(app).get(statsUrl(ws, campaign)).set(...auth);

    expect(res.body.data.waiting).toEqual({ neverCalled: 0, betweenCalls: 1 });
  });

  it('keeps the shape the campaigns tab already reads', async () => {
    const { ws, campaign } = await setup();
    await addContact(ws, campaign, { status: 'PENDING' });

    const res = await request(app).get(statsUrl(ws, campaign)).set(...auth);

    expect(res.body.data).toMatchObject({
      total: 1,
      byStatus: { PENDING: 1 },
      dialer: { enabled: expect.any(Boolean), inFlight: 0 },
    });
  });
});

describe('GET .../campaigns list outcomes', () => {
  const listUrl = (ws: Workspace) => `/api/workspaces/${ws.id}/campaigns`;

  /** An inbound call on the campaign's number, settled. `contact` null = a stranger. */
  async function inboundCall(
    ws: Workspace,
    campaign: Campaign,
    fields: { from: string; contactId?: string | null; durationSecs: number; endedAt: Date; costCredits?: bigint },
  ) {
    const did =
      (await prisma.phoneNumber.findFirst({ where: { workspaceId: ws.id } })) ??
      (await prisma.phoneNumber.create({
        data: { did: `+9194${String(seq++).padStart(8, '0')}`, workspaceId: ws.id, status: 'ASSIGNED' },
      }));
    return prisma.campaignInboundCall.create({
      data: {
        campaignId: campaign.id,
        campaignContactId: fields.contactId ?? null,
        workspaceId: ws.id,
        phoneNumberId: did.id,
        fromNumber: fields.from,
        arrivedAt: new Date(fields.endedAt.getTime() - fields.durationSecs * 1000),
        endedAt: fields.endedAt,
        durationSecs: fields.durationSecs,
        disposition: 'completed',
        costCredits: fields.costCredits ?? null,
      },
    });
  }

  it('an INBOUND campaign carries outcomes.inbound: calls, callers, strangers, talk time', async () => {
    const { ws, campaign } = await setup({ type: 'INBOUND' });
    const rahul = await addContact(ws, campaign, { status: 'COMPLETED', disposition: 'completed' });
    const t0 = new Date('2026-09-10T10:00:00Z');
    const t1 = new Date('2026-09-10T11:00:00Z');
    const t2 = new Date('2026-09-10T12:00:00Z');
    await inboundCall(ws, campaign, { from: '+919876500001', contactId: rahul.id, durationSecs: 30, endedAt: t0 });
    await inboundCall(ws, campaign, { from: '+919876500001', contactId: rahul.id, durationSecs: 45, endedAt: t1 });
    await inboundCall(ws, campaign, { from: '+910000000009', contactId: null, durationSecs: 0, endedAt: t2 });

    const res = await request(app).get(listUrl(ws)).set(...auth);

    expect(res.status).toBe(200);
    const [row] = res.body.data.campaigns;
    expect(row.outcomes.inbound).toEqual({
      calls: 3,
      callers: 2,
      unknownCalls: 1,
      talkSecs: 75,
      lastCallAt: t2.toISOString(),
    });
  });

  it('an INBOUND campaign with no calls yet carries a zeroed outcomes.inbound', async () => {
    const { ws } = await setup({ type: 'INBOUND' });
    const res = await request(app).get(listUrl(ws)).set(...auth);
    expect(res.body.data.campaigns[0].outcomes.inbound).toEqual({
      calls: 0, callers: 0, unknownCalls: 0, talkSecs: 0, lastCallAt: null,
    });
  });

  it('an OUTBOUND campaign carries no outcomes.inbound', async () => {
    const { ws } = await setup();
    const res = await request(app).get(listUrl(ws)).set(...auth);
    expect(res.body.data.campaigns[0].outcomes).not.toHaveProperty('inbound');
  });

  it('/stats on an INBOUND campaign carries inbound with credits summed from the ledger', async () => {
    const { alice, ws, campaign } = await setup({ type: 'INBOUND' });
    const call = await inboundCall(ws, campaign, {
      from: '+919876500002', durationSecs: 60, endedAt: new Date(), costCredits: 5000n,
    });
    await prisma.creditTransaction.create({
      data: { accountId: alice.id, workspaceId: ws.id, reference: call.id, amount: -5000n, type: 'CALL_USAGE' },
    });
    // A shortfall row records what was owed and never taken; it must not count.
    const short = await inboundCall(ws, campaign, { from: '+919876500003', durationSecs: 60, endedAt: new Date() });
    await prisma.creditTransaction.create({
      data: { accountId: alice.id, workspaceId: ws.id, reference: short.id, amount: 0n, type: 'CALL_USAGE_SHORTFALL' },
    });

    const res = await request(app).get(statsUrl(ws, campaign)).set(...auth);

    expect(res.status).toBe(200);
    expect(res.body.data.inbound).toMatchObject({ calls: 2, callers: 2, credits: '0.5' });
  });

  /**
   * The denominator behind the credits figure.
   *
   * `Dhandha Support Inbound` reads `137 calls · 5h 8m talk time · 25.9
   * credits`, which at any plausible rate is not 25.9 credits — so the tile
   * reads as broken while being exactly right. 135 of those calls were billed
   * on the Vocobase platform before YE ever saw them and imported as history;
   * only the two YE took are charged here. The tile needs to be able to say
   * so, and the count has to come off the same ledger join the credits already
   * run rather than be derived in a browser that cannot see the ledger.
   *
   * A shortfall is NOT billed here: it recorded what was owed and took
   * nothing, so it is excluded by the same `CALL_USAGE` filter that keeps it
   * out of the credits.
   */
  it('/stats says how many of the calls were billed by YE at all', async () => {
    const { alice, ws, campaign } = await setup({ type: 'INBOUND' });
    const billed = await inboundCall(ws, campaign, {
      from: '+919876500002', durationSecs: 60, endedAt: new Date(), costCredits: 5000n,
    });
    await prisma.creditTransaction.create({
      data: { accountId: alice.id, workspaceId: ws.id, reference: billed.id, amount: -5000n, type: 'CALL_USAGE' },
    });
    // Imported history: charged on the platform, no ledger row here at all.
    await inboundCall(ws, campaign, { from: '+919876500003', durationSecs: 90, endedAt: new Date() });
    await inboundCall(ws, campaign, { from: '+919876500004', durationSecs: 30, endedAt: new Date() });

    const res = await request(app).get(statsUrl(ws, campaign)).set(...auth);

    expect(res.body.data.inbound).toMatchObject({ calls: 3, credits: '0.5', billedCalls: 1 });
  });

  it('reports no billed calls on a campaign that is entirely imported history', async () => {
    const { ws, campaign } = await setup({ type: 'INBOUND' });
    await inboundCall(ws, campaign, { from: '+919876500005', durationSecs: 60, endedAt: new Date() });

    const res = await request(app).get(statsUrl(ws, campaign)).set(...auth);

    expect(res.body.data.inbound).toMatchObject({ calls: 1, credits: '0', billedCalls: 0 });
  });

  it('/stats on an OUTBOUND campaign carries no inbound block', async () => {
    const { ws, campaign } = await setup();
    const res = await request(app).get(statsUrl(ws, campaign)).set(...auth);
    expect(res.body.data).not.toHaveProperty('inbound');
  });

  it('partitions every contact on the list into exactly one bucket', async () => {
    const { ws, campaign } = await setup();
    const soon = new Date(Date.now() + 60 * 60_000);
    const dialed = new Date();

    // Settled, with an outcome.
    await addContact(ws, campaign, {
      status: 'COMPLETED',
      disposition: 'completed',
      lastAttemptAt: dialed,
    });
    await addContact(ws, campaign, {
      status: 'FAILED',
      disposition: 'no_answer',
      lastAttemptAt: dialed,
    });
    // Settled, with nothing recorded — swept out when the campaign was stopped,
    // or resolved before the column existed.
    await addContact(ws, campaign, { status: 'SKIPPED' });
    // Mid-journey, one row per re-arm: a spent retry, a booked callback, a
    // goal follow-up. All three are dialled contacts and all three carry the
    // claim's stamp — the counters differ, and the predicate must not.
    await addContact(ws, campaign, { status: 'PENDING', attempts: 1, lastAttemptAt: dialed });
    await addContact(ws, campaign, {
      status: 'PENDING',
      attempts: 0,
      callbackCount: 1,
      nextEligibleAt: soon,
      callbackAt: soon,
      lastAttemptAt: dialed,
    });
    await addContact(ws, campaign, {
      status: 'PENDING',
      attempts: 0,
      callbackCount: 0,
      followUpCount: 1,
      disposition: 'completed',
      lastAttemptAt: dialed,
    });
    // On the phone right now.
    await addContact(ws, campaign, { status: 'QUEUED', lastAttemptAt: dialed });
    // Untouched.
    await addContact(ws, campaign, { status: 'PENDING' });
    await addContact(ws, campaign, { status: 'PENDING' });

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { totalContacts: 9 },
    });

    const res = await request(app).get(listUrl(ws)).set(...auth);

    expect(res.status).toBe(200);
    const [row] = res.body.data.campaigns;
    const outcomes = row.outcomes;

    expect(outcomes.dispositions).toMatchObject({ completed: 1, no_answer: 1 });
    expect(outcomes.settledUnknown).toBe(1);
    expect(outcomes.inFlight).toBe(4);
    expect(outcomes.undialed).toBe(2);

    const dispositionTotal = Object.values(outcomes.dispositions as Record<string, number>).reduce(
      (sum, count) => sum + count,
      0,
    );

    // The property the dashboard's bar depends on: four numbers, one contact
    // each, adding up to the campaign's own total.
    expect(dispositionTotal + outcomes.inFlight + outcomes.undialed + outcomes.settledUnknown).toBe(
      row.totalContacts,
    );
  });

  /**
   * The third counter, and the one the bar was blind to.
   *
   * A goal campaign re-arms a contact the moment a conversation goes well, and
   * that re-arm moves `followUpCount` alone — `attempts` and `callbackCount`
   * stay where they were. Read on two counters, the campaign's most successful
   * contacts were drawn on the bar as people nobody had ever rung: success
   * removed itself from its own success rate.
   */
  it('counts a contact re-armed for a goal follow-up as in flight, not undialed', async () => {
    const { ws, campaign } = await setup();

    await addContact(ws, campaign, {
      status: 'PENDING',
      attempts: 0,
      callbackCount: 0,
      followUpCount: 1,
      disposition: 'completed',
      lastAttemptAt: new Date(),
    });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { totalContacts: 1 } });

    const res = await request(app).get(listUrl(ws)).set(...auth);

    expect(res.body.data.campaigns[0].outcomes).toMatchObject({ inFlight: 1, undialed: 0 });
  });

  /**
   * The bar's four numbers are a **partition**, and a partition read across
   * snapshots is not one.
   *
   * The transition is the ordinary one: a call ends and the goal re-arm moves
   * the contact `CALLING → PENDING`, stamped by the dial that produced it —
   * steady state on a goal campaign, not an exotic race. Landing between the
   * status read and the worked read, that contact is counted twice: once as a
   * live call in the first, once as PENDING-with-work in the second, with the
   * `Math.max` floor swallowing the subtraction that would have taken it back
   * out. The four numbers then overflow the campaign they describe and the bar
   * is drawn longer than the list it draws.
   *
   * `armMidRead` forces that rather than hoping for it: the first statement
   * reads, the re-arm commits, and every later statement — `count` included,
   * which is the one an earlier version of this test left free to run before
   * the arm and so could never fail on — is held until it has. One statement
   * has no later statement to hold, so the re-arm falls outside the instant
   * being reported, which is the property.
   *
   * Asserted against the campaign's own contact rows rather than against three
   * hand-counted expectations, because it is the sum that is the claim, and
   * against the statement count, because one snapshot is what makes the sum
   * true.
   */
  it('partitions the contacts even when a re-arm lands mid-read', async () => {
    const { ws, campaign } = await setup();

    // One contact, on the telephone. The whole campaign.
    const live = await addContact(ws, campaign, { status: 'CALLING' });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { totalContacts: 1 } });

    const { statements, restore } = armMidRead(() =>
      prisma.campaignContact.update({
        where: { id: live.id },
        data: {
          status: 'PENDING',
          armKind: 'FOLLOW_UP',
          followUpCount: 1,
          disposition: 'completed',
          lastAttemptAt: new Date(),
        },
      }),
    );

    try {
      const outcomes = (await campaignOutcomes([campaign.id]))[campaign.id]!;

      const dispositionTotal = Object.values(outcomes.dispositions).reduce(
        (sum, count) => sum + count,
        0,
      );

      expect(
        dispositionTotal + outcomes.inFlight + outcomes.undialed + outcomes.settledUnknown,
      ).toBe(1);
      // One statement, so one snapshot: the statuses, the worked filter and the
      // dispositions cannot come from three different instants again.
      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain('GROUP BY cc."campaignId", cc.status, cc.disposition');
    } finally {
      restore();
    }
  });

  /**
   * The same give-back shape as `/stats`' `waiting` split, on the other
   * surface that reads the same predicate. One rule, so one answer: a contact
   * the dialer has claimed and handed back is work in hand on both bars.
   */
  it('counts a contact given back after a claim as in flight, not undialed', async () => {
    const { ws, campaign } = await setup();

    await addContact(ws, campaign, {
      status: 'PENDING',
      lastAttemptAt: new Date(),
      attempts: 0,
      callbackCount: 0,
      followUpCount: 0,
    });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { totalContacts: 1 } });

    const res = await request(app).get(listUrl(ws)).set(...auth);

    expect(res.body.data.campaigns[0].outcomes).toMatchObject({ inFlight: 1, undialed: 0 });
  });

  it('leaves a contact an operator removed out of the arithmetic', async () => {
    const { ws, campaign } = await setup();

    await addContact(ws, campaign, { status: 'PENDING' });
    await addContact(ws, campaign, { status: 'EXCLUDED' });
    // `totalContacts` is decremented when somebody is excluded, so the removed
    // contact must not appear in the buckets either.
    await prisma.campaign.update({ where: { id: campaign.id }, data: { totalContacts: 1 } });

    const res = await request(app).get(listUrl(ws)).set(...auth);
    const outcomes = res.body.data.campaigns[0].outcomes;

    expect(outcomes).toMatchObject({ inFlight: 0, undialed: 1, settledUnknown: 0 });
    expect(outcomes.dispositions).toEqual({});
  });

  it('reports every campaign on the page without a query per row', async () => {
    const { ws, campaign } = await setup();
    const second = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q4', totalContacts: 1 },
    });

    await addContact(ws, campaign, { status: 'COMPLETED', disposition: 'completed' });
    await addContact(ws, second, { status: 'PENDING' });

    const res = await request(app).get(listUrl(ws)).set(...auth);
    const byName = Object.fromEntries(
      res.body.data.campaigns.map((row: { name: string; outcomes: unknown }) => [
        row.name,
        row.outcomes,
      ]),
    );

    expect(byName.Q3).toMatchObject({ dispositions: { completed: 1 }, undialed: 0 });
    expect(byName.Q4).toMatchObject({ dispositions: {}, undialed: 1 });
  });
});

/**
 * The detail page reads the same aggregate the list does.
 *
 * It used to derive its own from `/stats`, which groups dispositions over
 * **every** contact rather than the settled ones: a contact cooling down
 * between retries still carries the outcome of its last dial, so it landed in
 * a disposition bucket *and* in the undialed remainder, and the page reported
 * more outcomes than the campaign has contacts. `/stats` is documented as a
 * set of counts that deliberately do not partition, so the fix is to stop
 * partitioning it — not to change it.
 */
describe('GET .../campaigns/:cid outcomes', () => {
  const detailUrl = (ws: Workspace, campaign: Campaign) =>
    `/api/workspaces/${ws.id}/campaigns/${campaign.id}`;
  const listUrl = (ws: Workspace) => `/api/workspaces/${ws.id}/campaigns`;

  it('counts a cooling-down retry once, as in flight rather than as an outcome', async () => {
    const { ws, campaign } = await setup();
    const soon = new Date(Date.now() + 60 * 60_000);

    // The row the derivation double-counted: PENDING, so it is not settled,
    // but carrying the disposition of the dial that failed.
    await addContact(ws, campaign, {
      status: 'PENDING',
      attempts: 1,
      disposition: 'no_answer',
      nextEligibleAt: soon,
      lastAttemptAt: new Date(),
    });
    await addContact(ws, campaign, {
      status: 'COMPLETED',
      disposition: 'completed',
      lastAttemptAt: new Date(),
    });
    await addContact(ws, campaign, { status: 'PENDING' });

    await prisma.campaign.update({ where: { id: campaign.id }, data: { totalContacts: 3 } });

    const res = await request(app).get(detailUrl(ws, campaign)).set(...auth);

    expect(res.status).toBe(200);
    const { outcomes } = res.body.data;

    expect(outcomes.dispositions).toEqual({ completed: 1 });
    expect(outcomes.inFlight).toBe(1);
    expect(outcomes.undialed).toBe(1);
    expect(outcomes.settledUnknown).toBe(0);

    const dispositionTotal = Object.values(outcomes.dispositions as Record<string, number>).reduce(
      (sum, count) => sum + count,
      0,
    );

    expect(dispositionTotal + outcomes.inFlight + outcomes.undialed + outcomes.settledUnknown).toBe(
      res.body.data.totalContacts,
    );
  });

  it('reports exactly what the list reports for the same campaign', async () => {
    const { ws, campaign } = await setup();

    await addContact(ws, campaign, { status: 'COMPLETED', disposition: 'completed' });
    await addContact(ws, campaign, { status: 'SKIPPED' });
    await addContact(ws, campaign, { status: 'PENDING', attempts: 2 });
    await addContact(ws, campaign, { status: 'PENDING' });

    const detail = await request(app).get(detailUrl(ws, campaign)).set(...auth);
    const list = await request(app).get(listUrl(ws)).set(...auth);

    expect(detail.body.data.outcomes).toEqual(list.body.data.campaigns[0].outcomes);
  });

  /**
   * `settledUnknown` means opposite things on the two aggregates: here it is a
   * settled contact with no outcome recorded, on `/stats` it is an outcome
   * outside the canonical nine. Keeping both is fine as long as the page reads
   * the one it draws its bar from.
   */
  it('leaves /stats alone', async () => {
    const { ws, campaign } = await setup();
    await addContact(ws, campaign, { status: 'PENDING' });

    const res = await request(app).get(statsUrl(ws, campaign)).set(...auth);

    expect(res.body.data).toMatchObject({ total: 1, byStatus: { PENDING: 1 } });
    expect(res.body.data.outcomes).toBeUndefined();
  });
});

describe('campaign serialization', () => {
  it('emits the counters and the clocks the lifecycle wrote', async () => {
    const started = new Date('2026-08-01T09:00:00.000Z');
    const paused = new Date('2026-08-01T10:00:00.000Z');
    const stopped = new Date('2026-08-01T11:00:00.000Z');
    const { ws, campaign } = await setup({
      totalContacts: 9,
      completedCount: 4,
      failedCount: 2,
      skippedCount: 3,
      startedAt: started,
      pausedAt: paused,
      completedAt: stopped,
      stoppedAt: stopped,
    });

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...auth);

    expect(res.body.data).toMatchObject({
      totalContacts: 9,
      completedCount: 4,
      failedCount: 2,
      skippedCount: 3,
      startedAt: started.toISOString(),
      pausedAt: paused.toISOString(),
      completedAt: stopped.toISOString(),
      stoppedAt: stopped.toISOString(),
    });
  });
});

/**
 * Where a campaign's leads landed, on the three surfaces that draw them.
 *
 * The arithmetic itself is pinned in `campaign-buckets.test.ts`. What is
 * asserted here is that each surface actually carries it — and that a campaign
 * which does not bucket says so rather than omitting the block, because a
 * dashboard cannot tell a missing field from a campaign with no leads.
 */
describe('lead buckets on the read surfaces', () => {
  async function bucketed() {
    const { alice, ws, campaign } = await setup({
      leadBucketKey: 'lead_stage',
      wonBuckets: ['Hot'],
    });

    for (const stage of ['Hot', 'Hot', 'Cold']) {
      const link = await addContact(ws, campaign, { status: 'COMPLETED' });
      const attempt = await addAttempt(ws, alice, campaign, link);
      // `disposition` as well as the extraction: a bucket is read only off a
      // call that reached a person, so an attempt left unclassified here would
      // assert these three surfaces carry a readout while every one of them
      // legitimately reported nothing.
      await prisma.callAttempt.update({
        where: { id: attempt.id },
        data: { disposition: 'completed', extraction: { lead_stage: stage } },
      });
    }

    return { alice, ws, campaign };
  }

  const expected = {
    key: 'lead_stage',
    buckets: [{ name: 'Hot', count: 2 }, { name: 'Cold', count: 1 }],
    bucketed: 3,
    won: 2,
    truncated: false,
  };

  it('reports them on /stats', async () => {
    const { ws, campaign } = await bucketed();

    const res = await request(app).get(statsUrl(ws, campaign)).set(...auth);

    expect(res.body.data.leadBuckets).toEqual(expected);
  });

  it('reports them on the campaign detail', async () => {
    const { ws, campaign } = await bucketed();

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...auth);

    expect(res.body.data.leadBuckets).toEqual(expected);
  });

  it('reports them per row on the campaign list', async () => {
    const { ws, campaign } = await bucketed();

    const res = await request(app).get(`/api/workspaces/${ws.id}/campaigns`).set(...auth);

    const row = res.body.data.campaigns.find((c: { id: string }) => c.id === campaign.id);
    expect(row.leadBuckets).toEqual(expected);
  });

  /** Present and empty, never absent: a dashboard cannot tell a field that was
   *  omitted from a campaign whose leads nobody sorted. */
  it('carries an empty block on a campaign that does not bucket', async () => {
    const { ws, campaign } = await setup();

    const res = await request(app).get(statsUrl(ws, campaign)).set(...auth);

    expect(res.body.data.leadBuckets)
      .toEqual({ key: null, buckets: [], bucketed: 0, won: 0, truncated: false });
  });
});

/**
 * The goal block on the stats page.
 *
 * `goal: null` when the switch is off, so the tab can tell "no goal" from "no
 * data"; a verdict fold over the SETTLED contacts when it is on. One aggregate
 * and nothing else — the per-key distribution went with the key list it
 * counted, and the goal's own words went with the column: what counts as a
 * finished conversation is written in the agent's prompt, so a campaign-shaped
 * goal string here would be a caption for a rule this campaign does not hold.
 */
describe('the goal block', () => {
  const goalOf = async (ws: Workspace, campaign: Campaign) =>
    (await request(app).get(statsUrl(ws, campaign)).set(...auth)).body.data.goal;

  /** The fold is on every campaign now, the stored switch included. Zeroes
   *  rather than null: nothing has settled yet, which is a different fact
   *  from "this campaign has no verdict to give" — and there is no campaign
   *  left for that null to describe. */
  it('is a zeroed fold on a campaign whose stored switch is off', async () => {
    const { ws, campaign } = await setup();

    expect(await goalOf(ws, campaign)).toEqual({
      achieved: { achieved: 0, notAchieved: 0, pending: 0 },
    });
  });

  /** The fold, and nothing beside it. Pinned as an exact shape rather than a
   *  subset: a `goal` string reappearing here is a dashboard being told the
   *  campaign owns wording that lives in the agent's prompt. */
  it('carries the verdict fold and no wording', async () => {
    const { ws, campaign } = await setup({ goalEnabled: true });

    await addContact(ws, campaign, { status: 'COMPLETED', goalAchieved: true });

    expect(await goalOf(ws, campaign)).toEqual({
      achieved: { achieved: 1, notAchieved: 0, pending: 0 },
    });
  });

  it('folds the verdicts of settled contacts into achieved, not achieved and pending', async () => {
    const { ws, campaign } = await setup({ goalEnabled: true });

    await addContact(ws, campaign, { status: 'COMPLETED', goalAchieved: true });
    await addContact(ws, campaign, { status: 'COMPLETED', goalAchieved: true });
    await addContact(ws, campaign, { status: 'COMPLETED', goalAchieved: false });
    // Settled without a verdict: excluded, swept, or failed without connecting.
    await addContact(ws, campaign, { status: 'EXCLUDED', goalAchieved: null });
    // Unfinished, so in neither column: the dispatcher's own definition.
    await addContact(ws, campaign, { status: 'PENDING', goalAchieved: null });
    await addContact(ws, campaign, { status: 'QUEUED', goalAchieved: null });

    expect((await goalOf(ws, campaign)).achieved)
      .toEqual({ achieved: 2, notAchieved: 1, pending: 1 });
  });

  it('never counts another campaign’s contacts', async () => {
    const { ws, campaign } = await setup({ goalEnabled: true });
    const other = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Other', status: 'RUNNING', goalEnabled: true },
    });

    await addContact(ws, other, { status: 'COMPLETED', goalAchieved: true });

    expect((await goalOf(ws, campaign)).achieved)
      .toEqual({ achieved: 0, notAchieved: 0, pending: 0 });
  });

  /** The distribution is gone, and its absence is pinned: a dashboard that
   *  still drew field bars would draw them off `undefined`. */
  it('carries no collected-fields distribution', async () => {
    const { ws, campaign } = await setup({ goalEnabled: true });

    const goal = await goalOf(ws, campaign);

    expect(goal.collectedFields).toBeUndefined();
    expect(goal.keys).toBeUndefined();
  });
});

/**
 * Dials placed, over the campaign's life.
 *
 * Attempt ROWS rather than `CampaignContact.attempts`, which counts retries
 * CONSUMED: the first dial does not increment it and neither does a callback,
 * so a sum of that column undercounts every contact by at least one.
 */
/**
 * The figure the Overview strip draws, and the reason it is not the reached
 * tier of `dispositions` summed.
 *
 * Those groups read `CampaignContact.disposition` — the LAST dial's outcome —
 * so they partition the roster by where each contact stands now. That is right
 * for a bar and wrong for "how many leads did we talk to", which no later
 * voicemail can reduce. `/stats` publishes both, and they are expected to
 * disagree on any campaign that follows people up.
 */
describe('the reached count', () => {
  it('counts a lead once however many of its calls connected', async () => {
    const { alice, ws, campaign } = await setup();
    const lead = await addContact(ws, campaign, { status: 'COMPLETED', attempts: 1 });

    await addAttempt(ws, alice, campaign, lead, { disposition: 'completed' });
    await addAttempt(ws, alice, campaign, lead, { disposition: 'transferred' });

    const res = await request(app).get(statsUrl(ws, campaign)).set(...auth);

    expect(res.status).toBe(200);
    expect(res.body.data.reached).toBe(1);
  });

  it('keeps a lead whose last dial was a voicemail, which the tier drops', async () => {
    const { alice, ws, campaign } = await setup();
    // Spoke, was followed up, the follow-up hit the machine — so the join row
    // now carries `voicemail` and the disposition groups have moved them out
    // of the reached tier.
    const lead = await addContact(ws, campaign, {
      status: 'COMPLETED',
      attempts: 1,
      disposition: 'voicemail',
    });

    await addAttempt(ws, alice, campaign, lead, { disposition: 'completed' });
    await addAttempt(ws, alice, campaign, lead, { disposition: 'voicemail' });

    const res = await request(app).get(statsUrl(ws, campaign)).set(...auth);

    expect(res.body.data.reached).toBe(1);
    // The two readouts, disagreeing on purpose and both in the same payload.
    expect(res.body.data.dispositions.completed).toBe(0);
    expect(res.body.data.dispositions.voicemail).toBe(1);
  });

  it('counts a lead still mid-journey after it spoke', async () => {
    const { alice, ws, campaign } = await setup();
    const booked = await addContact(ws, campaign, {
      status: 'PENDING',
      attempts: 1,
      disposition: 'completed',
    });

    await addAttempt(ws, alice, campaign, booked, { disposition: 'completed' });

    const res = await request(app).get(statsUrl(ws, campaign)).set(...auth);

    expect(res.body.data.reached).toBe(1);
  });

  it('does not count an answering machine as a person', async () => {
    const { alice, ws, campaign } = await setup();
    const machine = await addContact(ws, campaign, { status: 'COMPLETED', attempts: 2 });

    await addAttempt(ws, alice, campaign, machine, { disposition: 'voicemail' });
    await addAttempt(ws, alice, campaign, machine, { disposition: 'no_answer' });

    const res = await request(app).get(statsUrl(ws, campaign)).set(...auth);

    expect(res.body.data.reached).toBe(0);
  });

  /** The platform may label a cause-16 conversation `no_answer`; its own answer
   *  detection heard the person, and that is the evidence this counts. */
  it('counts a lead the platform labelled no_answer with a human on the line', async () => {
    const { alice, ws, campaign } = await setup();
    const spoke = await addContact(ws, campaign, { status: 'COMPLETED', attempts: 1 });
    const silent = await addContact(ws, campaign, { status: 'FAILED', attempts: 1 });

    await addAttempt(ws, alice, campaign, spoke, { disposition: 'no_answer', answeredBy: 'Human' });
    await addAttempt(ws, alice, campaign, silent, { disposition: 'no_answer', answeredBy: 'not_answered' });

    const res = await request(app).get(statsUrl(ws, campaign)).set(...auth);

    expect(res.body.data.reached).toBe(1);
  });

  /** A voicemail beside `answered_by: human` is the detector disagreeing with
   *  itself, and the disposition is the later, more specific verdict — the
   *  same reading `classifyAttempt` gives it. A pick-up in which nobody spoke
   *  is not a conversation either. Neither is a lead the campaign reached. */
  it('does not count a voicemail or a no-speech pick-up, whatever the detector heard', async () => {
    const { alice, ws, campaign } = await setup();
    const machine = await addContact(ws, campaign, { status: 'FAILED', attempts: 1 });
    const mute = await addContact(ws, campaign, { status: 'FAILED', attempts: 1 });

    await addAttempt(ws, alice, campaign, machine, { disposition: 'voicemail', answeredBy: 'human' });
    await addAttempt(ws, alice, campaign, mute, { disposition: 'user_hangup_no_speech', answeredBy: 'human' });

    const res = await request(app).get(statsUrl(ws, campaign)).set(...auth);

    expect(res.body.data.reached).toBe(0);
  });

  it('is zero on a campaign nobody has dialled, never absent', async () => {
    const { ws, campaign } = await setup();
    await addContact(ws, campaign);

    const res = await request(app).get(statsUrl(ws, campaign)).set(...auth);

    expect(res.body.data.reached).toBe(0);
  });
});

describe('the attempt count', () => {
  it('counts every dial placed, including the first and any callback', async () => {
    const { alice, ws, campaign } = await setup();
    const link = await addContact(ws, campaign, { status: 'COMPLETED', attempts: 1 });

    // Three dials of one contact. `attempts` on the join row reads 1.
    await addAttempt(ws, alice, campaign, link);
    await addAttempt(ws, alice, campaign, link);
    await addAttempt(ws, alice, campaign, link);

    const res = await request(app).get(statsUrl(ws, campaign)).set(...auth);

    expect(res.status).toBe(200);
    expect(res.body.data.totalAttempts).toBe(3);
  });

  it('is zero on a campaign nobody has dialled, never absent', async () => {
    const { ws, campaign } = await setup();
    await addContact(ws, campaign);

    const res = await request(app).get(statsUrl(ws, campaign)).set(...auth);

    expect(res.body.data.totalAttempts).toBe(0);
  });
});

/**
 * Whether a campaign has ever spoken to a lead, as a partition of its roster.
 *
 * The bar this replaces answered a different question and was read as this
 * one. Its `reached` tier counts a **settled** contact whose **last**
 * disposition was a conversation — so a lead that talked to us on Tuesday and
 * was re-armed for a Thursday follow-up left the tier the moment the follow-up
 * was armed, and reappeared as "in flight". On the two September Touchbase
 * campaigns that put "450 reached a person" on a row whose own lead chips
 * summed to 1114, and an operator reading the two side by side had no way to
 * tell which one was lying.
 *
 * `connect` answers the question the row is actually scanned for: have we
 * spoken to this person, ever. It is evidenced by an attempt the dialer wrote
 * rather than asserted by a column a re-arm rewrites, which is the same
 * argument `reachedContactsFilter` already makes for the strip — the two now
 * agree by construction.
 *
 * Three buckets and not two, and `notDialed` is why. "Not connected" has to
 * mean *we rang and nobody picked up*; folding in a contact nobody has dialled
 * yet would report a campaign on its first morning as one that a thousand
 * people had refused.
 */
describe('campaign connect partition', () => {
  const listUrl = (ws: Workspace) => `/api/workspaces/${ws.id}/campaigns`;

  /** An attempt the dialer would have written, on this contact. */
  function attempt(
    owner: { alice: Account; ws: Workspace; campaign: Campaign },
    contact: CampaignContact,
    disposition: string | null,
    attemptNo = 1,
    fields: Record<string, unknown> = {},
  ) {
    return prisma.callAttempt.create({
      data: {
        workspaceId: owner.ws.id,
        accountId: owner.alice.id,
        campaignId: owner.campaign.id,
        campaignContactId: contact.id,
        attemptNo,
        disposition,
        ...fields,
      },
    });
  }

  /**
   * The bug, stated as a test.
   *
   * A conversation happened, the goal re-armed the contact for a follow-up, and
   * the contact is now PENDING mid-journey. The old tier dropped it; `connect`
   * keeps it, because the call it took is a fact and the state it is passing
   * through is not.
   */
  it('counts a lead re-armed after a conversation as connected', async () => {
    const owner = await setup();
    const { ws, campaign } = owner;

    const talked = await addContact(ws, campaign, {
      status: 'PENDING',
      armKind: 'FOLLOW_UP',
      followUpCount: 1,
      // The follow-up dial has not happened yet, so the column still carries
      // the conversation — but on the next voicemail it will not, and that is
      // exactly why the count may not come from here.
      disposition: 'completed',
      lastAttemptAt: new Date(),
    });
    await attempt(owner, talked, 'completed');
    await prisma.campaign.update({ where: { id: campaign.id }, data: { totalContacts: 1 } });

    const res = await request(app).get(listUrl(ws)).set(...auth);

    expect(res.body.data.campaigns[0].outcomes.connect).toEqual({
      connected: 1,
      notConnected: 0,
      notDialed: 0,
    });
  });

  /**
   * The half of the same fact that the `CampaignContact.disposition` column
   * gets wrong in the other direction: a real conversation, then a follow-up
   * into an answering machine, which overwrites the column with `voicemail`.
   * The lead is still somebody we have spoken to.
   */
  it('keeps a lead connected after a later dial lands in voicemail', async () => {
    const owner = await setup();
    const { ws, campaign } = owner;

    const talked = await addContact(ws, campaign, {
      status: 'COMPLETED',
      disposition: 'voicemail',
      lastAttemptAt: new Date(),
    });
    await attempt(owner, talked, 'completed', 1);
    await attempt(owner, talked, 'voicemail', 2);
    await prisma.campaign.update({ where: { id: campaign.id }, data: { totalContacts: 1 } });

    const res = await request(app).get(listUrl(ws)).set(...auth);

    expect(res.body.data.campaigns[0].outcomes.connect).toMatchObject({
      connected: 1,
      notConnected: 0,
    });
  });

  it('counts a lead rung four times and never reached as not connected', async () => {
    const owner = await setup();
    const { ws, campaign } = owner;

    const missed = await addContact(ws, campaign, {
      status: 'FAILED',
      disposition: 'no_answer',
      lastAttemptAt: new Date(),
    });
    for (const no of [1, 2, 3, 4]) await attempt(owner, missed, 'no_answer', no);
    await prisma.campaign.update({ where: { id: campaign.id }, data: { totalContacts: 1 } });

    const res = await request(app).get(listUrl(ws)).set(...auth);

    expect(res.body.data.campaigns[0].outcomes.connect).toEqual({
      connected: 0,
      notConnected: 1,
      notDialed: 0,
    });
  });

  /**
   * A campaign on its first morning. Nobody has refused anything, and the
   * readout must not say they have — the whole reason there is a third bucket.
   *
   * The contact the dispatcher has already claimed belongs here too: QUEUED
   * with no attempt behind it is a telephone about to ring, not one that rang.
   * `undialed` gets this one wrong on purpose (it is scoped to PENDING, so a
   * claimed row lands in `inFlight`), which is why `notDialed` is its own
   * count rather than a rename.
   */
  it('counts a contact nobody has rung as not dialled, claimed or not', async () => {
    const owner = await setup();
    const { ws, campaign } = owner;

    await addContact(ws, campaign, { status: 'PENDING' });
    await addContact(ws, campaign, { status: 'QUEUED', claimedAt: new Date() });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { totalContacts: 2 } });

    const res = await request(app).get(listUrl(ws)).set(...auth);

    expect(res.body.data.campaigns[0].outcomes.connect).toEqual({
      connected: 0,
      notConnected: 0,
      notDialed: 2,
    });
  });

  /**
   * An attempt that never reached the platform is not a dial.
   *
   * `launchError` is the dialer's record of a claim it could not place, and
   * the give-back paths hand the contact straight back to PENDING. Counting it
   * as "rung and nobody picked up" would report our own outage as the lead's
   * refusal.
   */
  it('does not count a failed launch as a dial nobody answered', async () => {
    const owner = await setup();
    const { ws, campaign } = owner;

    const contact = await addContact(ws, campaign, { status: 'PENDING' });
    await attempt(owner, contact, null, 1, { launchError: 'platform refused the call' });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { totalContacts: 1 } });

    const res = await request(app).get(listUrl(ws)).set(...auth);

    expect(res.body.data.campaigns[0].outcomes.connect).toMatchObject({ notDialed: 1 });
  });

  it('leaves a contact an operator removed out of the connect partition', async () => {
    const owner = await setup();
    const { ws, campaign } = owner;

    const kept = await addContact(ws, campaign, { status: 'COMPLETED', lastAttemptAt: new Date() });
    await attempt(owner, kept, 'completed');

    const removed = await addContact(ws, campaign, {
      status: 'EXCLUDED',
      lastAttemptAt: new Date(),
    });
    await attempt(owner, removed, 'completed');

    await prisma.campaign.update({ where: { id: campaign.id }, data: { totalContacts: 1 } });

    const res = await request(app).get(listUrl(ws)).set(...auth);

    expect(res.body.data.campaigns[0].outcomes.connect).toEqual({
      connected: 1,
      notConnected: 0,
      notDialed: 0,
    });
  });

  /**
   * The property the ring is drawn from: three counts, one roster, no contact
   * in two of them and none in none of them.
   *
   * Asserted against `totalContacts` rather than against hand-counted numbers,
   * because it is the sum that the drawing depends on — a ring whose segments
   * over-run its circumference paints one over another.
   */
  it('partitions totalContacts across the three connect buckets', async () => {
    const owner = await setup();
    const { ws, campaign } = owner;

    const talked = await addContact(ws, campaign, { status: 'COMPLETED', lastAttemptAt: new Date() });
    await attempt(owner, talked, 'transferred');

    const missed = await addContact(ws, campaign, { status: 'PENDING', lastAttemptAt: new Date() });
    await attempt(owner, missed, 'busy');

    await addContact(ws, campaign, { status: 'PENDING' });
    await addContact(ws, campaign, { status: 'EXCLUDED' });

    await prisma.campaign.update({ where: { id: campaign.id }, data: { totalContacts: 3 } });

    const res = await request(app).get(listUrl(ws)).set(...auth);
    const { connect } = res.body.data.campaigns[0].outcomes;

    expect(connect.connected + connect.notConnected + connect.notDialed).toBe(
      res.body.data.campaigns[0].totalContacts,
    );
    expect(connect).toEqual({ connected: 1, notConnected: 1, notDialed: 1 });
  });

  /**
   * Still one statement. The connect counts join an aggregate of the attempts
   * into the grouped read rather than running beside it, for the reason the
   * four numbers above are already one statement: a partition assembled from
   * two READ COMMITTED snapshots is not a partition, and the re-arm that
   * breaks it runs continuously on every goal campaign.
   */
  it('reads the connect counts from the same snapshot as the rest', async () => {
    const owner = await setup();
    const { ws, campaign } = owner;
    await addContact(ws, campaign, { status: 'PENDING' });

    const seen: string[] = [];
    const raw = prisma.$queryRaw.bind(prisma);
    const spy = vi.spyOn(prisma, '$queryRaw').mockImplementation(((...args: never[]) => {
      seen.push(String((args[0] as { strings?: string[] })?.strings?.join('?') ?? ''));
      return raw(...(args as Parameters<typeof raw>));
    }) as never);

    try {
      const outcomes = (await campaignOutcomes([campaign.id]))[campaign.id]!;
      expect(outcomes.connect).toEqual({ connected: 0, notConnected: 0, notDialed: 1 });
      expect(seen).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('reports the same connect partition on the detail route as on the list', async () => {
    const owner = await setup();
    const { ws, campaign } = owner;
    const talked = await addContact(ws, campaign, { status: 'COMPLETED', lastAttemptAt: new Date() });
    await attempt(owner, talked, 'completed');
    await prisma.campaign.update({ where: { id: campaign.id }, data: { totalContacts: 1 } });

    const detail = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...auth);
    const list = await request(app).get(listUrl(ws)).set(...auth);

    expect(detail.body.data.outcomes.connect).toEqual({
      connected: 1,
      notConnected: 0,
      notDialed: 0,
    });
    expect(detail.body.data.outcomes.connect).toEqual(
      list.body.data.campaigns[0].outcomes.connect,
    );
  });
});
