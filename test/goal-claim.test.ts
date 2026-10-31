import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContactArmKind } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import {
  claimContacts,
  excludeDoNotCallContacts,
  settleContactsOverDialBudget,
} from '../src/services/dialerClaim.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';

/**
 * The goal predicates in the claim, against a real Postgres: the absolute
 * dial cap (which beats even an armed callback) and the do-not-call
 * exclusion (which is scoped to the campaign the person said it on, and
 * settles the refused contact out of the queue rather than leaving it PENDING
 * forever).
 */

const NOW = new Date('2026-08-30T10:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

let workspaceId: string;
let accountId: string;
let campaignId: string;
let seq = 0;

async function makeCampaign(name = 'Outreach'): Promise<string> {
  const campaign = await prisma.campaign.create({
    data: { workspaceId, name, status: 'RUNNING', retryCount: 5, goalEnabled: true },
  });
  return campaign.id;
}

async function addContact(
  data: {
    campaignId?: string;
    phone?: string;
    attempts?: number;
    followUpCount?: number;
    callbackCount?: number;
    /** Import instant. Set explicitly where a test needs import order to
     *  disagree with the order under test; the column otherwise defaults to
     *  the transaction timestamp, one identical value across a seed. */
    createdAt?: Date;
    /** Closed attempt rows to create, so MAX(attemptNo) is real history. */
    dialsMade?: number;
    /** Attempt rows a launch failure closed without ever placing a call:
     *  FAILED, no upstream id, a launch error. */
    launchesFailed?: number;
    status?: 'PENDING' | 'QUEUED';
    /** Why this row's clock is set. `FRESH` is the column default — a contact
     *  nobody has dialled. */
    armKind?: ContactArmKind;
    nextEligibleAt?: Date | null;
    callbackAt?: Date | null;
  } = {},
): Promise<{ id: string; phone: string }> {
  seq += 1;
  const phone = data.phone ?? `+9198777${String(10000 + seq).slice(-5)}`;
  const contact = await prisma.contact.upsert({
    where: { workspaceId_phone: { workspaceId, phone } },
    update: {},
    create: { workspaceId, phone, name: `Contact ${seq}` },
  });

  const owner = data.campaignId ?? campaignId;
  const link = await prisma.campaignContact.create({
    data: {
      campaignId: owner,
      contactId: contact.id,
      status: data.status ?? 'PENDING',
      armKind: data.armKind ?? 'FRESH',
      attempts: data.attempts ?? 0,
      followUpCount: data.followUpCount ?? 0,
      callbackCount: data.callbackCount ?? 0,
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
      nextEligibleAt: data.nextEligibleAt ?? null,
      callbackAt: data.callbackAt ?? null,
    },
  });

  let ordinal = 0;

  for (let n = 1; n <= (data.launchesFailed ?? 0); n++) {
    ordinal += 1;
    await prisma.callAttempt.create({
      data: {
        campaignId: owner,
        campaignContactId: link.id,
        workspaceId,
        accountId,
        attemptNo: ordinal,
        // Exactly what `rollbackLaunch` writes for a transient upstream
        // failure: closed, never placed, no platform id of any kind.
        status: 'FAILED',
        endedAt: NOW,
        resolvedAt: NOW,
        launchError: 'UPSTREAM_ERROR: the platform returned 502',
      },
    });
  }

  for (let n = 1; n <= (data.dialsMade ?? 0); n++) {
    ordinal += 1;
    await prisma.callAttempt.create({
      data: {
        campaignId: owner,
        campaignContactId: link.id,
        workspaceId,
        accountId,
        attemptNo: ordinal,
        status: 'COMPLETED',
        endedAt: NOW,
        resolvedAt: NOW,
        upstreamCallId: `call_${link.id}_${ordinal}`,
      },
    });
  }

  return { id: link.id, phone };
}

const claim = (
  opts: Partial<Parameters<typeof claimContacts>[1]> = {},
) =>
  claimContacts(prisma, {
    campaignId,
    limit: 10,
    lane: 'any',
    retryCount: 5,
    maxTotalDials: null,
    // Defaults that bind nothing: this file is about the dial cap, the
    // do-not-call exclusion and the lanes, not about the follow-up budget or
    // the daily cap. A `dayStart` at the epoch counts every attempt ever
    // placed, against a cap of ten.
    maxGoalFollowUps: 5,
    maxDialsPerDay: 10,
    dayStart: new Date(0),
    now: NOW,
    ...opts,
  });

beforeEach(async () => {
  await truncateAll();
  seq = 0;

  const account = await makeAccount(`gclaim${Math.random().toString(36).slice(2, 7)}`);
  accountId = account.id;
  const workspace = await makeWorkspace(account, 'Claimers');
  workspaceId = workspace.id;
  campaignId = await makeCampaign();
});

afterEach(async () => {
  await truncateAll();
});

describe('the absolute dial cap', () => {
  it('refuses a contact whose dials have reached the cap', async () => {
    await addContact({ attempts: 3, dialsMade: 3, nextEligibleAt: minutes(-1) });

    expect(await claim({ maxTotalDials: 3 })).toEqual([]);
  });

  it('claims a contact one dial short of it', async () => {
    const { id } = await addContact({ attempts: 2, dialsMade: 2, nextEligibleAt: minutes(-1) });

    expect((await claim({ maxTotalDials: 3 })).map((row) => row.id)).toEqual([id]);
  });

  /**
   * The cap beats even an armed callback: a promise extracted on the last
   * allowed dial must not buy a dial past it. The callback lane is exempt
   * from the RETRY budget, deliberately — not from this one.
   */
  it('refuses an armed callback past the cap, in every lane', async () => {
    await addContact({
      attempts: 1,
      dialsMade: 3,
      callbackAt: minutes(-5),
      nextEligibleAt: minutes(-5),
    });

    expect(await claim({ maxTotalDials: 3, lane: 'callback' })).toEqual([]);
    expect(await claim({ maxTotalDials: 3, lane: 'any' })).toEqual([]);
  });

  /**
   * A launch that never placed a call must not spend a dial.
   *
   * `attemptNo` is `MAX(attemptNo) + 1` over ALL attempt rows, and
   * `rollbackLaunch` closes a row for every transient upstream failure — six
   * 502s leave ordinals 1..6 with `attempts` still 0. Counted, the claim
   * refuses the contact in every lane forever: nothing settles it (the
   * do-not-call sweep only touches listed numbers, `releaseStaleClaims` only
   * QUEUED), so it sits PENDING, the completion pass counts it as unfinished,
   * and the campaign never completes — with the person never dialled once.
   */
  it('does not count a launch that never placed a call', async () => {
    const { id } = await addContact({ launchesFailed: 6, nextEligibleAt: minutes(-1) });

    expect((await claim({ maxTotalDials: 6 })).map((row) => row.id)).toEqual([id]);
  });

  it('still counts the real dials among them', async () => {
    await addContact({ launchesFailed: 4, dialsMade: 3, attempts: 2, nextEligibleAt: minutes(-1) });

    expect(await claim({ maxTotalDials: 3 })).toEqual([]);
  });

  /**
   * The platform accepted the launch and then ended the attempt itself — an
   * `error_code`, the number never tested. It carries a call id, so the
   * three-column never-placed rule cannot see it; the code is what does.
   */
  it('does not count a dial the platform ended before the carrier tested the number', async () => {
    const { id } = await addContact({ dialsMade: 2, attempts: 2, nextEligibleAt: minutes(-1) });
    await prisma.callAttempt.create({
      data: {
        campaignId,
        campaignContactId: id,
        workspaceId,
        accountId,
        attemptNo: 3,
        status: 'FAILED',
        endedAt: NOW,
        resolvedAt: NOW,
        upstreamCallId: `call_${id}_platform_fault`,
        errorCode: 'PENDING_TIMEOUT',
        errorMessage: 'Session reaped before connect',
      },
    });

    expect((await claim({ maxTotalDials: 3 })).map((row) => row.id)).toEqual([id]);
  });

  /**
   * The same fact through the field the platform actually emits: a
   * `SYSTEM_ERROR` ending beside nobody heard. The SQL half of the rule,
   * exercised through the real claim rather than the Prisma count.
   */
  it('does not count a SYSTEM_ERROR silence either', async () => {
    const { id } = await addContact({ dialsMade: 2, attempts: 2, nextEligibleAt: minutes(-1) });
    await prisma.callAttempt.create({
      data: {
        campaignId,
        campaignContactId: id,
        workspaceId,
        accountId,
        attemptNo: 3,
        status: 'FAILED',
        endedAt: NOW,
        resolvedAt: NOW,
        upstreamCallId: `call_${id}_system_error`,
        endCallReason: 'SYSTEM_ERROR',
      },
    });

    expect((await claim({ maxTotalDials: 3 })).map((row) => row.id)).toEqual([id]);
  });

  it('still counts a SYSTEM_ERROR that ended a call a person had answered', async () => {
    const { id } = await addContact({ dialsMade: 2, attempts: 2, nextEligibleAt: minutes(-1) });
    await prisma.callAttempt.create({
      data: {
        campaignId,
        campaignContactId: id,
        workspaceId,
        accountId,
        attemptNo: 3,
        status: 'COMPLETED',
        disposition: 'completed',
        answeredBy: 'human',
        endedAt: NOW,
        resolvedAt: NOW,
        upstreamCallId: `call_${id}_system_error_human`,
        endCallReason: 'SYSTEM_ERROR',
      },
    });

    expect(await claim({ maxTotalDials: 3 })).toEqual([]);
  });

  /**
   * `UPSTREAM_WRITE_UNCONFIRMED` is deliberately NOT excluded: the platform
   * never answered, the call may be ringing right now, and the row stays
   * QUEUED for the reaper to reconcile against the platform's own record.
   * Treating it as never placed would dial somebody twice.
   */
  it('keeps an unconfirmed write counted', async () => {
    const { id } = await addContact({ nextEligibleAt: minutes(-1) });

    await prisma.callAttempt.create({
      data: {
        campaignId,
        campaignContactId: id,
        workspaceId,
        accountId,
        attemptNo: 1,
        // Exactly what `rollbackLaunch` leaves behind: still QUEUED, an error
        // recorded, no upstream id.
        status: 'QUEUED',
        launchError: 'UPSTREAM_WRITE_UNCONFIRMED: the platform did not answer; awaiting reconciliation',
      },
    });

    expect(await claim({ maxTotalDials: 1 })).toEqual([]);
  });

  it('keeps the predicate out of the SQL entirely for a non-goal campaign', async () => {
    const { id } = await addContact({ attempts: 4, dialsMade: 9, nextEligibleAt: minutes(-1) });

    // null = no cap: nine dials of history claim fine under the retry budget.
    expect((await claim({ maxTotalDials: null })).map((row) => row.id)).toEqual([id]);
  });
});

describe('the do-not-call exclusion', () => {
  it('refuses a number this campaign has listed, in every lane', async () => {
    const source = await addContact({ phone: '+919877700001' });
    await prisma.doNotCall.create({
      data: {
        campaignId,
        phone: '+919877700001',
        reason: 'Asked not to be called again during a campaign call.',
        sourceCampaignContactId: source.id,
      },
    });

    // Never claimed, in the shared pool or the fresh lane.
    expect(await claim()).toEqual([]);
    expect(await claim({ lane: 'fresh' })).toEqual([]);

    // Even as an armed callback: the opt-out beats the promise.
    await prisma.campaignContact.deleteMany({ where: { campaignId } });
    await addContact({ phone: '+919877700001', callbackAt: minutes(-1), nextEligibleAt: minutes(-1) });
    expect(await claim({ lane: 'callback' })).toEqual([]);
    expect(await claim({ lane: 'any' })).toEqual([]);
  });

  /**
   * The design's decision, and the case that makes the scoping visible.
   *
   * "Stop calling me about this" is said about a campaign. A second campaign
   * the same workspace runs — a different conversation, for a different
   * reason — asks its own list and still dials the number.
   */
  it('leaves the same phone dialable by a second campaign in the workspace', async () => {
    const listedHere = await addContact({ phone: '+919877700008' });
    await prisma.doNotCall.create({
      data: { campaignId, phone: '+919877700008', reason: 'opted out', sourceCampaignContactId: listedHere.id },
    });

    const otherCampaign = await makeCampaign('Other');
    const elsewhere = await addContact({ campaignId: otherCampaign, phone: '+919877700008' });

    expect(await claim()).toEqual([]);
    expect(
      (await claim({ campaignId: otherCampaign })).map((row) => row.id),
    ).toEqual([elsewhere.id]);
  });

  it('does not overreach to other phones', async () => {
    await prisma.doNotCall.create({
      data: { campaignId, phone: '+919877700002', reason: 'opted out' },
    });
    const clean = await addContact({ phone: '+919877700003' });

    expect((await claim()).map((row) => row.id)).toEqual([clean.id]);
  });
});

describe('excludeDoNotCallContacts', () => {
  it('settles listed PENDING contacts EXCLUDED and floors the denominator', async () => {
    await prisma.doNotCall.create({
      data: { campaignId, phone: '+919877700004', reason: 'opted out' },
    });
    const listed = await addContact({ phone: '+919877700004' });
    const clean = await addContact({ phone: '+919877700005' });
    await prisma.campaign.update({ where: { id: campaignId }, data: { totalContacts: 2 } });

    expect(await excludeDoNotCallContacts(prisma, { campaignId, now: NOW })).toBe(1);

    expect((await prisma.campaignContact.findUniqueOrThrow({ where: { id: listed.id } })).status).toBe(
      'EXCLUDED',
    );
    expect((await prisma.campaignContact.findUniqueOrThrow({ where: { id: clean.id } })).status).toBe(
      'PENDING',
    );
    expect(
      (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).totalContacts,
    ).toBe(1);

    // A repeated sweep moves nothing twice.
    expect(await excludeDoNotCallContacts(prisma, { campaignId, now: NOW })).toBe(0);
  });

  /** The sweep is scoped the way the claim is: another campaign's list neither
   *  settles this campaign's contacts nor is read at all. */
  it('never settles a contact off another campaign’s list', async () => {
    const otherCampaign = await makeCampaign('Other');
    const source = await addContact({ campaignId: otherCampaign, phone: '+919877700009' });
    await prisma.doNotCall.create({
      data: { campaignId: otherCampaign, phone: '+919877700009', reason: 'opted out', sourceCampaignContactId: source.id },
    });
    const here = await addContact({ phone: '+919877700009' });

    expect(await excludeDoNotCallContacts(prisma, { campaignId, now: NOW })).toBe(0);
    expect(
      (await prisma.campaignContact.findUniqueOrThrow({ where: { id: here.id } })).status,
    ).toBe('PENDING');
  });

  it('never drives a drifted denominator negative', async () => {
    await prisma.doNotCall.create({
      data: { campaignId, phone: '+919877700006', reason: 'opted out' },
    });
    await addContact({ phone: '+919877700006' });
    await prisma.campaign.update({ where: { id: campaignId }, data: { totalContacts: 0 } });

    await excludeDoNotCallContacts(prisma, { campaignId, now: NOW });

    expect(
      (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).totalContacts,
    ).toBe(0);
  });

  it('leaves a mid-call contact for the ordinary resolution', async () => {
    await prisma.doNotCall.create({
      data: { campaignId, phone: '+919877700007', reason: 'opted out' },
    });
    const midCall = await addContact({ phone: '+919877700007', status: 'QUEUED' });

    expect(await excludeDoNotCallContacts(prisma, { campaignId, now: NOW })).toBe(0);
    expect(
      (await prisma.campaignContact.findUniqueOrThrow({ where: { id: midCall.id } })).status,
    ).toBe('QUEUED');
  });

  it('costs one probe and touches nothing when the campaign has no list', async () => {
    const clean = await addContact();

    expect(await excludeDoNotCallContacts(prisma, { campaignId, now: NOW })).toBe(0);
    expect(
      (await prisma.campaignContact.findUniqueOrThrow({ where: { id: clean.id } })).status,
    ).toBe('PENDING');
  });
});

/**
 * Which lane a goal follow-up is claimed in.
 *
 * The follow-up re-arm deliberately moves neither `attempts` (retries
 * consumed) nor `callbackAt` (history of a promise), so a contact whose first
 * dial was a real conversation comes back with `attempts = 0`. Split on the
 * counters, it landed in the lane the campaign reserved for people nobody has
 * called yet — spending a fresh contact's slot on a second conversation with
 * somebody already spoken to. The re-arm writes `armKind`, and the lanes read
 * that.
 */
describe('the lane a follow-up falls in', () => {
  it('keeps a follow-up out of the fresh lane', async () => {
    await addContact({
      armKind: 'FOLLOW_UP',
      attempts: 0,
      followUpCount: 1,
      dialsMade: 1,
      nextEligibleAt: minutes(-1),
    });

    expect(await claim({ lane: 'fresh' })).toEqual([]);
  });

  it('claims it in the retry lane instead', async () => {
    const { id } = await addContact({
      armKind: 'FOLLOW_UP',
      attempts: 0,
      followUpCount: 1,
      dialsMade: 1,
      nextEligibleAt: minutes(-1),
    });

    expect((await claim({ lane: 'retry' })).map((row) => row.id)).toEqual([id]);
    // And in the shared pool, which reserves nothing.
    await prisma.campaignContact.update({ where: { id }, data: { status: 'PENDING' } });
    expect((await claim({ lane: 'any' })).map((row) => row.id)).toEqual([id]);
  });

  /**
   * A resume is a follow-up too — it spends one — but it is not claimed
   * alongside them: its lane is bounded by the retry reservation on its own,
   * so a burst of dropped calls cannot spend the whole pass.
   */
  it('keeps a resume in its own lane, out of both the others', async () => {
    const { id } = await addContact({
      armKind: 'RESUME',
      attempts: 0,
      followUpCount: 1,
      dialsMade: 1,
      nextEligibleAt: minutes(-1),
    });

    expect(await claim({ lane: 'fresh' })).toEqual([]);
    expect(await claim({ lane: 'retry' })).toEqual([]);
    expect((await claim({ lane: 'resume' })).map((row) => row.id)).toEqual([id]);
  });

  it('still claims a never-called contact in the fresh lane', async () => {
    const { id } = await addContact({ attempts: 0, followUpCount: 0 });

    expect((await claim({ lane: 'fresh' })).map((row) => row.id)).toEqual([id]);
  });
});

/**
 * The order the retry lane hands contacts out in.
 *
 * Ordered by age alone, the lane re-dials whatever the import stamped first —
 * and a bulk import stamps the whole list at once, so the same few contacts
 * at the head of it took every retry slot while the tail sat at one dial.
 * Fewest dials spent goes first; a goal follow-up beats a plain retry only
 * among contacts that have been dialled the same number of times.
 */
describe('the retry lane order', () => {
  it('claims the contact dialled the fewest times first, import order notwithstanding', async () => {
    const dialled3 = await addContact({
      armKind: 'RETRY',
      attempts: 3,
      dialsMade: 4,
      createdAt: minutes(-30),
      nextEligibleAt: minutes(-1),
    });
    const dialled1 = await addContact({
      armKind: 'RETRY',
      attempts: 1,
      dialsMade: 2,
      createdAt: minutes(-20),
      nextEligibleAt: minutes(-1),
    });
    const dialled2 = await addContact({
      armKind: 'RETRY',
      attempts: 2,
      dialsMade: 3,
      createdAt: minutes(-10),
      nextEligibleAt: minutes(-1),
    });
    // Two dials spent, none of them a retry: ties with `dialled2` on the
    // count and wins the tie as the follow-up, despite being imported last.
    const followUp = await addContact({
      armKind: 'FOLLOW_UP',
      attempts: 0,
      followUpCount: 2,
      dialsMade: 3,
      createdAt: minutes(-5),
      nextEligibleAt: minutes(-1),
    });

    expect((await claim({ lane: 'retry' })).map((row) => row.id)).toEqual([
      dialled1.id,
      followUp.id,
      dialled2.id,
      dialled3.id,
    ]);
  });

  /**
   * A callback is a dial too. A contact that booked two callbacks and never
   * spent a retry has been rung three times; a contact on its first retry,
   * twice. `callbackCount` is the third term of the sort key, and the only
   * one no other test moves — every seed above leaves it at 0.
   */
  it('counts callbacks booked as dials spent', async () => {
    const twoCallbacks = await addContact({
      armKind: 'RETRY',
      attempts: 0,
      callbackCount: 2,
      dialsMade: 3,
      createdAt: minutes(-30),
      nextEligibleAt: minutes(-1),
    });
    const oneRetry = await addContact({
      armKind: 'RETRY',
      attempts: 1,
      dialsMade: 2,
      createdAt: minutes(-10),
      nextEligibleAt: minutes(-1),
    });
    // One retry and one callback: ties with `twoCallbacks` on the count, and
    // the older import wins the tie.
    const oneEach = await addContact({
      armKind: 'RETRY',
      attempts: 1,
      callbackCount: 1,
      dialsMade: 3,
      createdAt: minutes(-20),
      nextEligibleAt: minutes(-1),
    });

    expect((await claim({ lane: 'retry' })).map((row) => row.id)).toEqual([
      oneRetry.id,
      twoCallbacks.id,
      oneEach.id,
    ]);
  });
});

/**
 * The settle for a contact the dial cap has put out of reach.
 *
 * The claim refusing a contact is only half an answer: refused and left
 * PENDING, it is never dialled, never settles, is counted as remaining work by
 * the completion pass, and holds its campaign open for ever. Nothing else
 * settles it — the do-not-call sweep only touches listed numbers,
 * `releaseStaleClaims` only QUEUED — so this does, on every pass, whatever put
 * the contact past the cap: a lowered `maxTotalDials`, or upstream weather that
 * spent its ordinals on launches that never placed a call.
 */
describe('settleContactsOverDialBudget', () => {
  const settle = (maxTotalDials: number, maxGoalFollowUps = 99) =>
    settleContactsOverDialBudget(prisma, { campaignId, maxTotalDials, maxGoalFollowUps, now: NOW });

  it('settles a PENDING contact the cap has put out of reach', async () => {
    const spent = await addContact({ dialsMade: 3, nextEligibleAt: minutes(-1) });
    const reachable = await addContact({ dialsMade: 1, nextEligibleAt: minutes(-1) });
    await prisma.campaign.update({ where: { id: campaignId }, data: { totalContacts: 2 } });

    expect(await settle(3)).toBe(1);

    expect((await prisma.campaignContact.findUniqueOrThrow({ where: { id: spent.id } })).status)
      .toBe('SKIPPED');
    expect((await prisma.campaignContact.findUniqueOrThrow({ where: { id: reachable.id } })).status)
      .toBe('PENDING');

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    // SKIPPED is something the campaign did, so the contact stays in the
    // denominator and moves to the skipped pile — the retry sweep's rule.
    expect(campaign.skippedCount).toBe(1);
    expect(campaign.totalContacts).toBe(2);
  });

  /** The whole point of the exclusion: an unreachable contact is one the
   *  platform actually dialled, never one it refused to dial. */
  it('leaves a contact whose ordinals are launches that never placed a call', async () => {
    const stranded = await addContact({ launchesFailed: 6, nextEligibleAt: minutes(-1) });

    expect(await settle(6)).toBe(0);
    expect((await prisma.campaignContact.findUniqueOrThrow({ where: { id: stranded.id } })).status)
      .toBe('PENDING');
  });

  /** An armed callback past the cap is unreachable too — the cap counts dials
   *  of every kind, and the claim refuses it in the callback lane as well. */
  it('settles an armed callback the cap has put out of reach', async () => {
    const promised = await addContact({
      dialsMade: 3,
      callbackAt: minutes(-5),
      nextEligibleAt: minutes(-5),
    });

    expect(await settle(3)).toBe(1);
    expect((await prisma.campaignContact.findUniqueOrThrow({ where: { id: promised.id } })).status)
      .toBe('SKIPPED');
  });

  it('leaves a mid-call contact for the ordinary resolution', async () => {
    const midCall = await addContact({ dialsMade: 3, status: 'QUEUED' });

    expect(await settle(3)).toBe(0);
    expect((await prisma.campaignContact.findUniqueOrThrow({ where: { id: midCall.id } })).status)
      .toBe('QUEUED');
  });

  it('moves nothing twice', async () => {
    await addContact({ dialsMade: 3, nextEligibleAt: minutes(-1) });

    expect(await settle(3)).toBe(1);
    expect(await settle(3)).toBe(0);
  });

  /**
   * The follow-up budget, on the same pass. A `FOLLOW_UP` row whose count is
   * already past the budget is refused by the claim and, well inside the dial
   * ceiling, never reached by the sweep above — so without this it would sit
   * PENDING for ever. The rows exist: before the two lanes were split the
   * resolver spent follow-ups bounded only by the dial ceiling, so a RUNNING
   * campaign carries contacts at three, four, five follow-ups against a stored
   * budget of two, and the first pass after deploy must settle them rather
   * than wait for somebody to edit the budget.
   */
  it('settles a waiting follow-up the budget no longer covers', async () => {
    const over = await addContact({
      dialsMade: 4,
      followUpCount: 4,
      armKind: 'FOLLOW_UP',
      nextEligibleAt: minutes(-1),
    });
    const inside = await addContact({
      dialsMade: 2,
      followUpCount: 2,
      armKind: 'FOLLOW_UP',
      nextEligibleAt: minutes(-1),
    });
    // A retry row carrying an old follow-up tally from a lane it has left.
    const retry = await addContact({
      dialsMade: 4,
      followUpCount: 4,
      armKind: 'RETRY',
      nextEligibleAt: minutes(-1),
    });

    // Ceiling of 10 (retryCount 7 + 2 + 1): none of the three is near it.
    expect(await settle(10, 2)).toBe(1);

    expect((await prisma.campaignContact.findUniqueOrThrow({ where: { id: over.id } })).status)
      .toBe('SKIPPED');
    expect((await prisma.campaignContact.findUniqueOrThrow({ where: { id: inside.id } })).status)
      .toBe('PENDING');
    expect((await prisma.campaignContact.findUniqueOrThrow({ where: { id: retry.id } })).status)
      .toBe('PENDING');

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.skippedCount).toBe(1);
  });

  it('counts both sweeps into one skipped tally', async () => {
    await addContact({ dialsMade: 3, nextEligibleAt: minutes(-1) });
    await addContact({
      dialsMade: 1,
      followUpCount: 3,
      armKind: 'FOLLOW_UP',
      nextEligibleAt: minutes(-1),
    });

    expect(await settle(3, 2)).toBe(2);

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.skippedCount).toBe(2);
  });
});
