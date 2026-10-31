import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContactArmKind } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { claimContacts, type ClaimLane } from '../src/services/dialerClaim.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';

/**
 * The claim, against a real Postgres.
 *
 * This is the one part of the dispatcher that cannot be tested against a mock:
 * its correctness *is* `FOR UPDATE … SKIP LOCKED`, an `UPDATE … FROM` that
 * selects and flips in one statement, and an `ORDER BY` over boolean
 * expressions that decides which of five lanes a row leaves in. A fake that
 * answered these queries would be asserting that the test's own idea of the
 * semantics is right.
 */

const NOW = new Date('2026-08-30T10:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

let campaignId: string;
let workspaceId: string;
let accountId: string;
let seq = 0;

/**
 * The campaign-local start of day the daily cap counts from. The campaign is
 * seeded in IST, and NOW is 10:00Z = 15:30 IST — the afternoon of 2026-08-30
 * local, whose midnight was 2026-08-29T18:30Z.
 */
const IST_TODAY = new Date('2026-08-29T18:30:00Z');
const IST_TOMORROW = new Date('2026-08-30T18:30:00Z');

async function addContact(
  data: {
    attempts?: number;
    status?: 'PENDING' | 'QUEUED' | 'FAILED' | 'COMPLETED' | 'SKIPPED' | 'EXCLUDED';
    /**
     * Why this row's clock is set. Defaults to `FRESH`, the column default,
     * which is what a contact nobody has dialled carries — so a case that says
     * nothing about the lane is describing an untouched import row.
     */
    armKind?: ContactArmKind;
    nextEligibleAt?: Date | null;
    callbackAt?: Date | null;
    createdAt?: Date;
    followUpCount?: number;
    name?: string;
  } = {},
): Promise<string> {
  seq += 1;
  const contact = await prisma.contact.create({
    data: {
      workspaceId,
      phone: `+9198765${String(10000 + seq).slice(-5)}`,
      name: data.name ?? `Contact ${seq}`,
      metadata: { city: 'Pune' },
    },
  });

  const link = await prisma.campaignContact.create({
    data: {
      campaignId,
      contactId: contact.id,
      status: data.status ?? 'PENDING',
      armKind: data.armKind ?? 'FRESH',
      attempts: data.attempts ?? 0,
      nextEligibleAt: data.nextEligibleAt ?? null,
      callbackAt: data.callbackAt ?? null,
      followUpCount: data.followUpCount ?? 0,
      // Bulk imports stamp one identical `createdAt` across every row, so the
      // ordering cases below have to set it explicitly to mean anything.
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    },
  });

  return link.id;
}

beforeEach(async () => {
  await truncateAll();
  seq = 0;

  const account = await makeAccount(`claim${Math.random().toString(36).slice(2, 7)}`);
  const workspace = await makeWorkspace(account, 'Claimers');
  workspaceId = workspace.id;

  accountId = account.id;

  const campaign = await prisma.campaign.create({
    data: {
      workspaceId,
      name: 'Outreach',
      status: 'RUNNING',
      retryCount: 2,
      // The daily cap is counted in the campaign's own zone; the cases below
      // pick day boundaries out of it rather than out of UTC.
      timezone: 'Asia/Kolkata',
      maxGoalFollowUps: 2,
      maxDialsPerDay: 2,
    },
  });
  campaignId = campaign.id;
});

afterEach(async () => {
  await truncateAll();
});

/**
 * A placed dial against a contact. `startedAt` is what the daily cap counts
 * over, and `kind` is what exempts a callback the person asked for.
 */
async function addAttempt(
  campaignContactId: string,
  data: {
    attemptNo: number;
    startedAt: Date;
    kind?: string;
    status?: 'QUEUED' | 'RINGING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'ABANDONED';
    launchError?: string | null;
    upstreamCallId?: string | null;
  },
): Promise<void> {
  seq += 1;
  await prisma.callAttempt.create({
    data: {
      campaignId,
      campaignContactId,
      workspaceId,
      accountId,
      attemptNo: data.attemptNo,
      startedAt: data.startedAt,
      status: data.status ?? 'COMPLETED',
      ...(data.kind === undefined ? {} : { kind: data.kind }),
      launchError: data.launchError ?? null,
      upstreamCallId:
        data.upstreamCallId === undefined ? `call_${seq}` : data.upstreamCallId,
    },
  });
}

/**
 * The three lane options default to values that bind nothing, so a case that
 * says nothing about the follow-up budget or the daily cap is unaffected by
 * either: a `dayStart` at the epoch counts every attempt ever placed, against
 * a cap of ten.
 */
const claimWith = (
  o: {
    limit?: number;
    lane?: ClaimLane;
    retryCount?: number;
    maxGoalFollowUps?: number;
    maxDialsPerDay?: number;
    dayStart?: Date;
  } = {},
) =>
  claimContacts(prisma, {
    campaignId,
    limit: o.limit ?? 5,
    lane: o.lane ?? 'any',
    retryCount: o.retryCount ?? 2,
    maxTotalDials: null,
    maxGoalFollowUps: o.maxGoalFollowUps ?? 2,
    maxDialsPerDay: o.maxDialsPerDay ?? 10,
    dayStart: o.dayStart ?? new Date(0),
    now: NOW,
  });

const claim = (limit: number, lane: ClaimLane = 'any', retryCount = 2) =>
  claimWith({ limit, lane, retryCount });

describe('what a claim does to the row', () => {
  it('flips PENDING to QUEUED and stamps the attempt time', async () => {
    const id = await addContact();

    const claimed = await claim(5);

    expect(claimed.map((row) => row.id)).toEqual([id]);

    const row = await prisma.campaignContact.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('QUEUED');
    expect(row.lastAttemptAt).toEqual(NOW);
    // The claim's durable record: until the placement worker writes the
    // attempt row, this stamp is the only thing that says Redis owes a dial
    // for this contact, and it is what releaseStaleClaims measures a lost
    // placement job against.
    expect(row.claimedAt).toEqual(NOW);
    // The claim no longer counts a dial: `attempts` is retries consumed, moved
    // only by the retry re-arm at resolution time.
    expect(row.attempts).toBe(0);
    // And the arm is left exactly as it was. The claim reads why this contact
    // was due; it does not decide it, and a claim given back unlaunched has to
    // land in the lane it came out of.
    expect(row.armKind).toBe('FRESH');
  });

  it('returns everything the launcher needs without a second query', async () => {
    await addContact({ name: 'Asha' });

    const [row] = await claim(1);

    expect(row).toMatchObject({ attempts: 0, name: 'Asha', metadata: { city: 'Pune' } });
    expect(row!.phone).toMatch(/^\+91/);
    expect(row!.contactId).toEqual(expect.any(String));
  });

  /**
   * The arm the claiming statement read, frozen into the batch.
   *
   * It is what the attempt row's `kind` is stamped from, so the lane a row was
   * chosen out of and the label it answers to months later are one fact rather
   * than two derivations free to drift apart.
   */
  it('carries the arm it claimed on back to the caller', async () => {
    await addContact({ armKind: 'RESUME', followUpCount: 1, nextEligibleAt: minutes(-1) });

    const [row] = await claim(1, 'resume');

    expect(row!.armKind).toBe('RESUME');
  });

  it('makes no query at all for a limit of zero', async () => {
    await addContact();

    expect(await claim(0)).toEqual([]);
    expect(await claim(-3)).toEqual([]);

    // Nothing was touched, which is the point: a zero budget must not cost a
    // round trip on the sweep's hot path.
    const row = await prisma.campaignContact.findFirstOrThrow({ where: { campaignId } });
    expect(row.status).toBe('PENDING');
  });

  it('claims at most the limit', async () => {
    await addContact();
    await addContact();
    await addContact();

    expect(await claim(2)).toHaveLength(2);
  });
});

describe('what is eligible', () => {
  it('ignores contacts that are not PENDING', async () => {
    await addContact({ status: 'QUEUED' });
    await addContact({ status: 'FAILED' });
    await addContact({ status: 'COMPLETED' });
    await addContact({ status: 'SKIPPED' });
    await addContact({ status: 'EXCLUDED' });

    expect(await claim(10)).toEqual([]);
  });

  it('ignores a contact that is not due yet', async () => {
    await addContact({ nextEligibleAt: minutes(1) });

    expect(await claim(10)).toEqual([]);
  });

  it('claims a contact whose wait has elapsed', async () => {
    const id = await addContact({ armKind: 'RETRY', attempts: 1, nextEligibleAt: minutes(-1) });

    expect((await claim(10)).map((row) => row.id)).toEqual([id]);
  });

  /**
   * `retryCount` is re-read every pass, so lowering it mid-campaign stops an
   * already-waiting retry here. Without this the setting is a control that
   * lies: the operator lowers it and the dialing carries on.
   */
  it('ignores a contact that has spent more retries than the campaign now allows', async () => {
    await addContact({ armKind: 'RETRY', attempts: 3 });

    expect(await claim(10, 'any', 2)).toEqual([]);
  });

  it('claims a contact exactly at its budget', async () => {
    const id = await addContact({ armKind: 'RETRY', attempts: 2 });

    expect((await claim(10, 'any', 2)).map((row) => row.id)).toEqual([id]);
  });
});

describe('the lanes', () => {
  it('claims only untouched contacts in the fresh lane', async () => {
    const fresh = await addContact({ attempts: 0 });
    await addContact({ armKind: 'RETRY', attempts: 1 });

    expect((await claim(10, 'fresh')).map((row) => row.id)).toEqual([fresh]);
  });

  it('claims retries and follow-ups together in the retry lane', async () => {
    await addContact({ attempts: 0 });
    const retry = await addContact({ armKind: 'RETRY', attempts: 2 });
    const followUp = await addContact({ armKind: 'FOLLOW_UP', followUpCount: 1 });

    expect((await claim(10, 'retry')).map((row) => row.id).sort()).toEqual(
      [retry, followUp].sort(),
    );
  });

  /**
   * The resume lane is its own thing, and the lanes beside it must not be able
   * to take from it. It is bounded by the retry reservation rather than by the
   * whole pass budget (`claimLanes`), and a row leaking into either neighbour
   * would spend a budget nobody meant it to.
   */
  it('claims only dropped conversations in the resume lane', async () => {
    const resume = await addContact({
      armKind: 'RESUME',
      followUpCount: 1,
      nextEligibleAt: minutes(-1),
    });
    await addContact({ armKind: 'RETRY', attempts: 1 });
    await addContact({ armKind: 'FOLLOW_UP', followUpCount: 1 });
    await addContact();

    expect((await claim(10, 'resume')).map((row) => row.id)).toEqual([resume]);

    // And it is in neither of the lanes beside it.
    expect((await claim(10, 'retry')).map((row) => row.id)).not.toContain(resume);
    expect((await claim(10, 'fresh')).map((row) => row.id)).not.toContain(resume);
  });

  it('claims every arm in the shared lane', async () => {
    const first = await addContact({
      armKind: 'RETRY',
      attempts: 1,
      createdAt: new Date('2026-08-01T00:00:00Z'),
    });
    const second = await addContact({ attempts: 0, createdAt: new Date('2026-08-02T00:00:00Z') });

    expect((await claim(10, 'any')).map((row) => row.id)).toEqual([first, second]);
  });
});

/**
 * The callback lane: `armKind = 'CALLBACK'`, and nothing else.
 *
 * It used to be `callbackAt IS NOT NULL AND nextEligibleAt = callbackAt`, and
 * every case here is a way that reading destroyed or manufactured a promise —
 * the last of them being the release that armed the same pair for a resume,
 * which put a call the engine chose to place into the lane that drains before
 * everything else and is exempt from the retry budget.
 */
describe('the callback lane', () => {
  const armed = (at: Date) => ({ armKind: 'CALLBACK' as const, callbackAt: at, nextEligibleAt: at });

  it('claims a due callback, soonest promise first', async () => {
    const later = await addContact(armed(minutes(-1)));
    const sooner = await addContact(armed(minutes(-30)));

    expect((await claim(10, 'callback')).map((row) => row.id)).toEqual([sooner, later]);
  });

  /**
   * The tiebreaker, and why it is not decoration.
   *
   * `rollIntoDialWindow` builds every booked instant through `instantOf`,
   * which zeroes seconds and milliseconds — so a window that closed on a bad
   * carrier hour rolls a whole batch of promises onto one identical minute. At
   * an identical sort key SQL leaves the order undefined, and the dispatcher
   * pairs the i-th claimed contact with the i-th number of the rotation.
   *
   * Claimed in two halves so the assertion is about the ORDER rather than the
   * set: a lane returning the same three rows shuffled would pass a
   * single-claim check every time.
   */
  it('breaks a tie on the identical promised instant by id', async () => {
    const same = minutes(-5);
    const ids = [
      await addContact(armed(same)),
      await addContact(armed(same)),
      await addContact(armed(same)),
    ];
    const expected = [...ids].sort();

    const first = await claim(2, 'callback');
    const second = await claim(2, 'callback');

    expect([...first, ...second].map((row) => row.id)).toEqual(expected);
  });

  /**
   * The armed predicate identifies the state; `nextEligibleAt <= now` gates the
   * time. A callback booked for tomorrow is never pulled forward — somebody was
   * told an hour, and ringing them early is worse than not ringing at all.
   */
  it('never pulls a future callback forward', async () => {
    await addContact(armed(minutes(60)));

    expect(await claim(10, 'callback')).toEqual([]);
    expect(await claim(10, 'any')).toEqual([]);
  });

  /**
   * A `callbackAt` left behind as history after the callback call completed,
   * with a later retry cooldown moving `nextEligibleAt` alone. The arm says
   * RETRY, so this contact is a plain retry — claimable, but only under the
   * retry budget, never under the callback lane's exemption from it.
   */
  it('treats a stale callback time as history, not as a promise', async () => {
    const id = await addContact({
      armKind: 'RETRY',
      attempts: 1,
      callbackAt: minutes(-120),
      nextEligibleAt: minutes(-1),
    });

    expect(await claim(10, 'callback')).toEqual([]);
    expect((await claim(10, 'retry')).map((row) => row.id)).toEqual([id]);
  });

  it('does not read a stale callback time as a promise once the budget is spent', async () => {
    await addContact({
      armKind: 'RETRY',
      attempts: 5,
      callbackAt: minutes(-120),
      nextEligibleAt: minutes(-1),
    });

    expect(await claim(10, 'any', 2)).toEqual([]);
  });

  /**
   * A callback spends no retries. Budgeting it as one would let a lowered retry
   * count silently cancel a call somebody was told to expect — which is the
   * one promise this queue makes to a human being.
   */
  it('claims an armed callback even for a contact that is out of retries', async () => {
    const id = await addContact({ attempts: 9, ...armed(minutes(-1)) });

    expect((await claim(10, 'callback', 2)).map((row) => row.id)).toEqual([id]);
  });

  /**
   * The other half of that rule, and the half the widened pair got wrong. A
   * resume is the engine's own choice, and the contact it re-arms spent every
   * retry that got it there — so the retry budget still bounds it, and a
   * lowered `retryCount` can still reach it.
   */
  it('does not exempt a resume from the retry budget', async () => {
    await addContact({
      armKind: 'RESUME',
      attempts: 9,
      followUpCount: 1,
      nextEligibleAt: minutes(-1),
    });

    expect(await claim(10, 'resume', 2)).toEqual([]);
    expect(await claim(10, 'any', 2)).toEqual([]);
  });

  it('cuts across every lane rather than filtering by retries spent', async () => {
    const untouched = await addContact({ attempts: 0, ...armed(minutes(-2)) });
    const retried = await addContact({ attempts: 1, ...armed(minutes(-1)) });

    expect((await claim(10, 'callback')).map((row) => row.id)).toEqual([untouched, retried]);
  });

  it('ignores a contact with no callback at all', async () => {
    await addContact({ nextEligibleAt: minutes(-1) });

    expect(await claim(10, 'callback')).toEqual([]);
  });
});

/**
 * The joint urgent lane: `CALLBACK` and `RESUME` drawn together.
 *
 * It exists for the give-back pass, which offers one side's unused slots to
 * the other — and a give-back that claimed callbacks and resumes in two
 * separate bounded claims would spend the slots on whichever it asked first,
 * however long the other side had been waiting.
 */
describe('the urgent lane', () => {
  it('claims callbacks and resumes together, promise first', async () => {
    const resume = await addContact({
      armKind: 'RESUME',
      followUpCount: 1,
      nextEligibleAt: minutes(-30),
    });
    const callback = await addContact({
      armKind: 'CALLBACK',
      callbackAt: minutes(-1),
      nextEligibleAt: minutes(-1),
    });

    const claimed = await claim(2, 'urgent');

    // The resume has waited half an hour and the promise one minute, and the
    // promise still goes first: a time a human was told beats a call the
    // engine chose to place.
    expect(claimed.map((row) => row.id)).toEqual([callback, resume]);
  });

  it('takes nothing but callbacks and resumes', async () => {
    await addContact({ nextEligibleAt: minutes(-1) });
    await addContact({ armKind: 'RETRY', attempts: 1, nextEligibleAt: minutes(-1) });
    await addContact({ armKind: 'FOLLOW_UP', followUpCount: 1, nextEligibleAt: minutes(-1) });

    expect(await claim(10, 'urgent')).toEqual([]);
  });
});

/**
 * The property the whole single-statement shape exists for. Selection and the
 * status flip happen in one statement under `FOR UPDATE … SKIP LOCKED`, so
 * there is no read-then-write window for a second dispatcher — or a second
 * pass of this one — to claim the same contact and dial somebody twice.
 */
describe('two dispatchers at once', () => {
  it('never hands the same contact to both', async () => {
    const ids = [await addContact(), await addContact(), await addContact()];

    const [first, second] = await Promise.all([
      prisma.$transaction((tx) =>
        claimContacts(tx, {
          campaignId,
          limit: 3,
          lane: 'any',
          retryCount: 2,
          maxTotalDials: null,
          maxGoalFollowUps: 2,
          maxDialsPerDay: 10,
          dayStart: new Date(0),
          now: NOW,
        }),
      ),
      prisma.$transaction((tx) =>
        claimContacts(tx, {
          campaignId,
          limit: 3,
          lane: 'any',
          retryCount: 2,
          maxTotalDials: null,
          maxGoalFollowUps: 2,
          maxDialsPerDay: 10,
          dayStart: new Date(0),
          now: NOW,
        }),
      ),
    ]);

    const claimed = [...first.map((r) => r.id), ...second.map((r) => r.id)];

    expect(new Set(claimed).size).toBe(claimed.length);
    expect(claimed).toHaveLength(3);
    expect([...claimed].sort()).toEqual([...ids].sort());
  });
});

describe('isolation between campaigns', () => {
  it("never claims another campaign's contacts", async () => {
    const other = await prisma.campaign.create({
      data: { workspaceId, name: 'Other', status: 'RUNNING' },
    });
    const mine = await addContact();

    const contact = await prisma.contact.create({
      data: { workspaceId, phone: '+919000000001' },
    });
    await prisma.campaignContact.create({
      data: { campaignId: other.id, contactId: contact.id },
    });

    expect((await claim(10)).map((row) => row.id)).toEqual([mine]);
  });
});

/**
 * The retry lane holds two different things, and they are not equally urgent.
 *
 * A retry is a number that did not pick up. A goal follow-up is a conversation
 * that happened and left the goal unmet, so somebody is waiting on the second
 * half of it. Ordered only by `createdAt` — which a bulk import stamps
 * identically across a whole list — the follow-up queued behind the import.
 *
 * The arm decides only among contacts dialled the same number of times: the
 * lane's first key is the dials already spent (`attempts + followUpCount +
 * callbackCount`), and `test/goal-claim.test.ts` proves that one. Every seed
 * here holds that sum equal so the arm is the only thing left to decide.
 */
describe('the retry lane orders follow-ups first among equal dial counts', () => {
  const OLD = new Date('2026-08-01T00:00:00.000Z');
  const NEW = new Date('2026-08-20T00:00:00.000Z');

  it('takes a follow-up before an older plain retry', async () => {
    const retry = await addContact({ armKind: 'RETRY', attempts: 1, createdAt: OLD });
    const followUp = await addContact({
      armKind: 'FOLLOW_UP',
      attempts: 0,
      followUpCount: 1,
      createdAt: NEW,
    });

    const claimed = await claim(5, 'retry');

    // The follow-up is newer and still goes first.
    expect(claimed.map((row) => row.id)).toEqual([followUp, retry]);
  });

  it('still orders by createdAt within each group', async () => {
    const laterFollowUp = await addContact({
      armKind: 'FOLLOW_UP',
      attempts: 1,
      followUpCount: 1,
      createdAt: NEW,
    });
    const earlyFollowUp = await addContact({
      armKind: 'FOLLOW_UP',
      attempts: 0,
      followUpCount: 2,
      createdAt: OLD,
    });
    const laterRetry = await addContact({ armKind: 'RETRY', attempts: 2, createdAt: NEW });
    const earlyRetry = await addContact({ armKind: 'RETRY', attempts: 2, createdAt: OLD });

    const claimed = await claim(5, 'retry');

    expect(claimed.map((row) => row.id)).toEqual([
      earlyFollowUp,
      laterFollowUp,
      earlyRetry,
      laterRetry,
    ]);
  });

  /**
   * The lifetime counter, in the lane it used to decide.
   *
   * `followUpCount` has no writer but an increment, so a contact followed up
   * once and then re-armed by the retry ladder kept follow-up priority for the
   * rest of its life — ahead of every genuine follow-up on the list, and
   * through the goal being cleared and `maxGoalFollowUps` set to 0. The arm is
   * rewritten by whichever path armed the row last, so it answers about now.
   */
  it('drops a followed-up contact behind the follow-ups once the ladder re-arms it', async () => {
    // Same two dials spent on each; the ladder-re-armed one carries the
    // larger follow-up tally, which is the very thing that must not count.
    const rearmedByLadder = await addContact({
      armKind: 'RETRY',
      attempts: 0,
      followUpCount: 2,
      createdAt: OLD,
    });
    const genuine = await addContact({
      armKind: 'FOLLOW_UP',
      attempts: 1,
      followUpCount: 1,
      createdAt: NEW,
    });

    const claimed = await claim(5, 'retry');

    expect(claimed.map((row) => row.id)).toEqual([genuine, rearmedByLadder]);
  });

  /** The fresh lane has no follow-ups in it by definition — a contact carrying
   *  one has been called. Its order must not have moved. */
  it('leaves the fresh lane ordered by createdAt alone', async () => {
    const later = await addContact({ createdAt: NEW });
    const early = await addContact({ createdAt: OLD });

    const claimed = await claim(5, 'fresh');

    expect(claimed.map((row) => row.id)).toEqual([early, later]);
  });
});

/**
 * The shared lane, which is where a campaign with `retryConcurrency = 0` — the
 * column default, and therefore most campaigns — does all of its dialing.
 *
 * It used to be a plain `ORDER BY createdAt`, so it was the one lane in which
 * none of the priorities above were ever consulted: on a default-configured
 * campaign a promise, a dropped conversation and a follow-up all queued behind
 * whatever the import stamped first, which on a bulk list is the whole list.
 */
describe('the shared lane carries the whole priority', () => {
  const OLD = new Date('2026-08-01T00:00:00.000Z');
  const NEW = new Date('2026-08-20T00:00:00.000Z');

  it('takes callback, then resume, then follow-up, then the rest by createdAt', async () => {
    // The urgent arms are stamped NEWEST and inserted last, so an accidental
    // fall-through to `createdAt` alone fails rather than passing by luck.
    const fresh = await addContact({ createdAt: OLD });
    const retry = await addContact({
      armKind: 'RETRY',
      attempts: 1,
      createdAt: new Date('2026-08-02T00:00:00.000Z'),
    });
    const followUp = await addContact({ armKind: 'FOLLOW_UP', followUpCount: 1, createdAt: NEW });
    const resume = await addContact({
      armKind: 'RESUME',
      followUpCount: 1,
      nextEligibleAt: minutes(-1),
      createdAt: NEW,
    });
    const callback = await addContact({
      armKind: 'CALLBACK',
      callbackAt: minutes(-1),
      nextEligibleAt: minutes(-1),
      createdAt: NEW,
    });

    const claimed = await claim(10, 'any');

    expect(claimed.map((row) => row.id)).toEqual([callback, resume, followUp, fresh, retry]);
  });

  it('breaks a tie by id when everything else is equal', async () => {
    const ids = [
      await addContact({ createdAt: OLD }),
      await addContact({ createdAt: OLD }),
      await addContact({ createdAt: OLD }),
    ];
    const expected = [...ids].sort();

    const first = await claim(2, 'any');
    const second = await claim(2, 'any');

    expect([...first, ...second].map((row) => row.id)).toEqual(expected);
  });
});

/**
 * The FOLLOW-UP budget, on the rows that spend it.
 *
 * The claim's second budget check, beside the retry one it has always had, and
 * for the same reason: lowering `maxGoalFollowUps` mid-campaign has to stop a
 * follow-up that is already waiting, or the setting is a control that lies.
 * The resolution's check stops one being ARMED; this one stops one already
 * armed from being dialled.
 */
describe('the follow-up budget', () => {
  it('claims a FOLLOW_UP row inside the budget', async () => {
    const id = await addContact({ armKind: 'FOLLOW_UP', followUpCount: 2 });

    expect((await claimWith({ lane: 'retry', maxGoalFollowUps: 2 })).map((c) => c.id)).toEqual([id]);
  });

  it('refuses a FOLLOW_UP row the budget no longer covers', async () => {
    await addContact({ armKind: 'FOLLOW_UP', followUpCount: 3 });

    expect(await claimWith({ lane: 'retry', maxGoalFollowUps: 2 })).toEqual([]);
  });

  /**
   * A reached contact is exempt from the RETRY clause: its retries were
   * forfeited the moment somebody answered, so `attempts` is frozen at
   * whatever it reached and must not be read as a budget it is over.
   */
  it('does not apply the retry budget to a reached contact', async () => {
    const id = await addContact({ armKind: 'FOLLOW_UP', attempts: 5, followUpCount: 0 });

    expect((await claimWith({ lane: 'retry', retryCount: 1 })).map((c) => c.id)).toEqual([id]);
  });

  /** The budget bounds only the arm that spends it. */
  it('leaves a RETRY row alone whatever the follow-up budget says', async () => {
    const id = await addContact({ armKind: 'RETRY', attempts: 1, followUpCount: 9 });

    expect((await claimWith({ lane: 'retry', maxGoalFollowUps: 0 })).map((c) => c.id)).toEqual([id]);
  });
});

/**
 * The DAILY CAP: how many placed dials one contact may take in one
 * campaign-local calendar day.
 *
 * Enforced by the claim and nowhere else, deliberately. A contact at the cap
 * has not run out of anything — it is simply not this contact's turn again
 * today — so nothing settles it and no sweep touches it; it waits for the next
 * local midnight and is claimable again.
 */
describe('the daily cap', () => {
  it('skips a contact already dialed the cap today', async () => {
    const id = await addContact({ armKind: 'RETRY', attempts: 2 });
    await addAttempt(id, { attemptNo: 1, startedAt: minutes(-300) });
    await addAttempt(id, { attemptNo: 2, startedAt: minutes(-60) });

    expect(await claimWith({ maxDialsPerDay: 2, dayStart: IST_TODAY })).toEqual([]);
  });

  it('claims it again once the day has turned', async () => {
    const id = await addContact({ armKind: 'RETRY', attempts: 2 });
    await addAttempt(id, { attemptNo: 1, startedAt: minutes(-300) });
    await addAttempt(id, { attemptNo: 2, startedAt: minutes(-60) });

    // The same two dials, counted against tomorrow's local midnight: they are
    // yesterday's now, and the cap is empty again.
    expect(
      (await claimWith({ maxDialsPerDay: 2, dayStart: IST_TOMORROW })).map((c) => c.id),
    ).toEqual([id]);
  });

  it('does not count yesterday', async () => {
    const id = await addContact({ armKind: 'RETRY', attempts: 2 });
    // ~16 hours back is before 2026-08-30 00:00 IST.
    await addAttempt(id, { attemptNo: 1, startedAt: minutes(-1000) });
    await addAttempt(id, { attemptNo: 2, startedAt: minutes(-60) });

    expect(
      (await claimWith({ maxDialsPerDay: 2, dayStart: IST_TODAY })).map((c) => c.id),
    ).toEqual([id]);
  });

  /** A callback the person asked for is exempt from the count as well as from
   *  the arm check: it is not a dial the campaign chose to place. */
  it('does not count a callback the person asked for', async () => {
    const id = await addContact({ armKind: 'RETRY', attempts: 2 });
    await addAttempt(id, { attemptNo: 1, startedAt: minutes(-300), kind: 'callback' });
    await addAttempt(id, { attemptNo: 2, startedAt: minutes(-60), kind: 'retry' });

    expect(
      (await claimWith({ maxDialsPerDay: 2, dayStart: IST_TODAY })).map((c) => c.id),
    ).toEqual([id]);
  });

  /** The same rule the dial budget holds: a launch the platform refused rang
   *  no telephone, so it is not one of the calls the person got today. */
  it('does not count an attempt that was never placed', async () => {
    const id = await addContact({ armKind: 'RETRY', attempts: 2 });
    await addAttempt(id, { attemptNo: 1, startedAt: minutes(-300) });
    await addAttempt(id, {
      attemptNo: 2,
      startedAt: minutes(-60),
      status: 'FAILED',
      upstreamCallId: null,
      launchError: 'upstream refused',
    });

    expect(
      (await claimWith({ maxDialsPerDay: 2, dayStart: IST_TODAY })).map((c) => c.id),
    ).toEqual([id]);
  });

  /**
   * An armed CALLBACK is exempt outright. A promise is a time a person named,
   * and a cap on how often the campaign rings them is not a reason to break
   * it — the cap bounds calls the campaign chose to place.
   */
  it('claims an armed CALLBACK whatever the count', async () => {
    const id = await addContact({
      armKind: 'CALLBACK',
      callbackAt: minutes(-5),
      nextEligibleAt: minutes(-5),
    });
    await addAttempt(id, { attemptNo: 1, startedAt: minutes(-300) });
    await addAttempt(id, { attemptNo: 2, startedAt: minutes(-200) });
    await addAttempt(id, { attemptNo: 3, startedAt: minutes(-60) });

    expect(
      (await claimWith({ maxDialsPerDay: 2, dayStart: IST_TODAY })).map((c) => c.id),
    ).toEqual([id]);
  });

  /** Under the cap is claimable, which is what stops the clause from being a
   *  refusal that happens to pass every case above by accident. */
  it('claims a contact still under the cap', async () => {
    const id = await addContact({ armKind: 'RETRY', attempts: 2 });
    await addAttempt(id, { attemptNo: 1, startedAt: minutes(-60) });

    expect(
      (await claimWith({ maxDialsPerDay: 2, dayStart: IST_TODAY })).map((c) => c.id),
    ).toEqual([id]);
  });
});
