import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Campaign, CampaignContactStatus, ContactArmKind, Workspace } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { as, makeAccount, makeWorkspace } from './helpers.js';

/**
 * The queue views the dashboard reads.
 *
 * All five turn on `armKind` — the column every re-arm path writes to say why
 * this contact's clock is set — paired with `status = 'PENDING'`, because a
 * settled row keeps the arm it last waited under and is waiting for nothing.
 *
 * The cases here are mostly about what the two readings that came before could
 * not say. `nextEligibleAt == callbackAt` meant "a promise" until the resume of
 * a dropped call started arming the same pair; `followUpCount > 0` meant "on a
 * follow-up" for the rest of a contact's life, because nothing ever decrements
 * it. Both left `callbackAt` as history that the tabs kept reading as news, so
 * several cases below deliberately leave a stale one standing.
 */

const app = createApp();

beforeEach(async () => {
  await truncateAll();
});

const auth = as('user_alice', 'alice@ezo.test');

async function setup() {
  const alice = await makeAccount('alice');
  const ws = await makeWorkspace(alice, 'A Co');
  const campaign = await prisma.campaign.create({
    data: { workspaceId: ws.id, name: 'Q3', status: 'RUNNING' },
  });

  return { ws, campaign };
}

let seq = 0;

/** One contact on the campaign, in whatever queue state the case needs. */
async function addContact(
  ws: Workspace,
  campaign: Campaign,
  fields: {
    name: string;
    status?: CampaignContactStatus;
    armKind?: ContactArmKind;
    attempts?: number;
    followUpCount?: number;
    nextEligibleAt?: Date | null;
    callbackAt?: Date | null;
    callbackCount?: number;
    disposition?: string | null;
  },
) {
  seq += 1;
  const contact = await prisma.contact.create({
    data: {
      workspaceId: ws.id,
      phone: `+9198765${String(43000 + seq).padStart(5, '0')}`,
      name: fields.name,
      email: `${fields.name}@example.com`,
      tags: ['vip'],
      metadata: { city: 'Pune' },
    },
  });

  return prisma.campaignContact.create({
    data: {
      campaignId: campaign.id,
      contactId: contact.id,
      status: fields.status ?? 'PENDING',
      // The column default, so a case that does not care about the lane reads
      // as a contact nobody has dialled — which is what the default means.
      armKind: fields.armKind ?? 'FRESH',
      attempts: fields.attempts ?? 0,
      followUpCount: fields.followUpCount ?? 0,
      nextEligibleAt: fields.nextEligibleAt ?? null,
      callbackAt: fields.callbackAt ?? null,
      callbackCount: fields.callbackCount ?? 0,
      disposition: fields.disposition ?? null,
    },
  });
}

const url = (ws: Workspace, campaign: Campaign, query = '') =>
  `/api/workspaces/${ws.id}/campaigns/${campaign.id}/contacts${query}`;

const names = (body: { data: { contacts: { name: string }[] } }) =>
  body.data.contacts.map((row) => row.name);

describe('GET .../contacts?queue=', () => {
  it('rejects a queue nobody defined, naming the ones that exist', async () => {
    const { ws, campaign } = await setup();

    const res = await request(app).get(url(ws, campaign, '?queue=overdue')).set(...auth);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('callback');
    expect(res.body.error.message).toContain('callback_overdue');
    expect(res.body.error.message).toContain('resume');
    expect(res.body.error.message).toContain('retry');
  });

  it('splits armed callbacks into due and still-ahead', async () => {
    const { ws, campaign } = await setup();
    const past = new Date(Date.now() - 60 * 60_000);
    const future = new Date(Date.now() + 60 * 60_000);

    await addContact(ws, campaign, {
      name: 'overdue',
      armKind: 'CALLBACK',
      nextEligibleAt: past,
      callbackAt: past,
    });
    await addContact(ws, campaign, {
      name: 'ahead',
      armKind: 'CALLBACK',
      nextEligibleAt: future,
      callbackAt: future,
    });
    // A promise already kept: the callback call ran, the retry ladder re-armed
    // the contact, and `callbackAt` stayed behind as history. It is in neither
    // callback queue — and the arm says so even though the timestamps could
    // still be read as a promise still ahead.
    await addContact(ws, campaign, {
      name: 'stale',
      armKind: 'RETRY',
      attempts: 1,
      nextEligibleAt: future,
      callbackAt: past,
    });

    const overdue = await request(app)
      .get(url(ws, campaign, '?queue=callback_overdue'))
      .set(...auth);
    expect(names(overdue.body)).toEqual(['overdue']);
    expect(overdue.body.data.total).toBe(1);

    const ahead = await request(app).get(url(ws, campaign, '?queue=callback')).set(...auth);
    expect(names(ahead.body)).toEqual(['ahead']);
  });

  it('shows every cooling-down retry, whatever timestamps it happens to carry', async () => {
    const { ws, campaign } = await setup();
    const past = new Date(Date.now() - 60 * 60_000);
    const soon = new Date(Date.now() + 10 * 60_000);

    // The shapes the old negation lost. `NOT ("nextEligibleAt" =
    // "callbackAt")` is NULL whenever either column is null, and a NULL
    // predicate excludes the row — so the first three are exactly the contacts
    // a retry tab defined by the timestamps could not show.
    await addContact(ws, campaign, {
      name: 'never-promised',
      armKind: 'RETRY',
      attempts: 1,
      nextEligibleAt: soon,
    });
    await addContact(ws, campaign, {
      name: 'no-cooldown',
      armKind: 'RETRY',
      attempts: 2,
      callbackAt: past,
    });
    await addContact(ws, campaign, { name: 'bare', armKind: 'RETRY', attempts: 1 });
    await addContact(ws, campaign, {
      name: 'kept-a-promise',
      armKind: 'RETRY',
      attempts: 1,
      nextEligibleAt: soon,
      callbackAt: past,
    });
    // Armed: exempt from the retry budget, and not a retry.
    await addContact(ws, campaign, {
      name: 'armed',
      armKind: 'CALLBACK',
      attempts: 2,
      nextEligibleAt: soon,
      callbackAt: soon,
    });
    // Never dialled: a fresh contact is not a retry.
    await addContact(ws, campaign, { name: 'fresh' });
    // Settled: out of the queue entirely, and the arm it kept is history.
    await addContact(ws, campaign, {
      name: 'done',
      status: 'COMPLETED',
      armKind: 'RETRY',
      attempts: 1,
    });

    const res = await request(app).get(url(ws, campaign, '?queue=retry')).set(...auth);

    expect(res.status).toBe(200);
    expect(names(res.body).sort()).toEqual([
      'bare',
      'kept-a-promise',
      'never-promised',
      'no-cooldown',
    ]);
    expect(res.body.data.total).toBe(4);
  });

  it('orders each queue by the clock that queue is about', async () => {
    const { ws, campaign } = await setup();
    const at = (minutes: number) => new Date(Date.now() + minutes * 60_000);

    // Inserted in the reverse of the order they must come back in, so an
    // accidental fall-through to `createdAt` fails rather than passing.
    await addContact(ws, campaign, {
      name: 'retry-late',
      armKind: 'RETRY',
      attempts: 1,
      nextEligibleAt: at(90),
    });
    await addContact(ws, campaign, {
      name: 'retry-soon',
      armKind: 'RETRY',
      attempts: 1,
      nextEligibleAt: at(10),
    });
    await addContact(ws, campaign, {
      name: 'callback-late',
      armKind: 'CALLBACK',
      nextEligibleAt: at(120),
      callbackAt: at(120),
    });
    await addContact(ws, campaign, {
      name: 'callback-soon',
      armKind: 'CALLBACK',
      nextEligibleAt: at(30),
      callbackAt: at(30),
    });

    const retries = await request(app).get(url(ws, campaign, '?queue=retry')).set(...auth);
    expect(names(retries.body)).toEqual(['retry-soon', 'retry-late']);

    const callbacks = await request(app).get(url(ws, campaign, '?queue=callback')).set(...auth);
    expect(names(callbacks.body)).toEqual(['callback-soon', 'callback-late']);
  });

  it('narrows with ?status= rather than replacing it', async () => {
    const { ws, campaign } = await setup();
    const soon = new Date(Date.now() + 10 * 60_000);

    await addContact(ws, campaign, {
      name: 'waiting',
      armKind: 'RETRY',
      attempts: 1,
      nextEligibleAt: soon,
    });

    // A queue already implies PENDING, so a second status can only narrow —
    // and here it narrows to nothing, which is the honest answer.
    const conflicting = await request(app)
      .get(url(ws, campaign, '?queue=retry&status=COMPLETED'))
      .set(...auth);
    expect(conflicting.status).toBe(200);
    expect(conflicting.body.data.contacts).toEqual([]);
    expect(conflicting.body.data.total).toBe(0);

    const agreeing = await request(app)
      .get(url(ws, campaign, '?queue=retry&status=PENDING'))
      .set(...auth);
    expect(names(agreeing.body)).toEqual(['waiting']);
  });

  it('carries the queue state and the contact identity on every row', async () => {
    const { ws, campaign } = await setup();
    const soon = new Date(Date.now() + 10 * 60_000);
    await addContact(ws, campaign, {
      name: 'asha',
      armKind: 'CALLBACK',
      attempts: 2,
      nextEligibleAt: soon,
      callbackAt: soon,
      callbackCount: 1,
      disposition: 'no_answer',
    });

    const res = await request(app).get(url(ws, campaign)).set(...auth);

    expect(res.body.data.contacts[0]).toMatchObject({
      name: 'asha',
      email: 'asha@example.com',
      tags: ['vip'],
      metadata: { city: 'Pune' },
      attempts: 2,
      callbackCount: 1,
      disposition: 'no_answer',
      nextEligibleAt: soon.toISOString(),
      callbackAt: soon.toISOString(),
      // The arm travels raw beside the derived flag, so the page can name what
      // every other waiting contact is waiting for too.
      armKind: 'CALLBACK',
    });
    expect(res.body.data.contacts[0]).toHaveProperty('answeredBy', null);
    expect(res.body.data.contacts[0]).toHaveProperty('lastSessionId', null);
    // Still waiting, so still owed.
    expect(res.body.data.contacts[0]).toHaveProperty('callbackPending', true);
  });

  /**
   * A promise is owed by a contact that is **waiting**. A settled one is not,
   * whatever arm it is carrying — and the list is where an operator would read
   * "callback pending" beside a contact that has already been called back.
   */
  it('reports no pending promise on a contact that has already settled', async () => {
    const { ws, campaign } = await setup();
    const soon = new Date(Date.now() + 10 * 60_000);
    await addContact(ws, campaign, {
      name: 'asha',
      status: 'COMPLETED',
      armKind: 'CALLBACK',
      attempts: 1,
      callbackCount: 1,
      nextEligibleAt: soon,
      callbackAt: soon,
    });

    const res = await request(app).get(url(ws, campaign)).set(...auth);

    expect(res.body.data.contacts[0]).toHaveProperty('callbackPending', false);
  });

  /**
   * The distinction the whole column exists for, on the surface a person
   * reads. A resume is the engine going back to a call that cut out; saying
   * "callback pending" beside it tells an operator their lead asked to be rung
   * at an instant the lead never heard of.
   */
  it('reports no pending promise on a contact the engine re-armed for a resume', async () => {
    const { ws, campaign } = await setup();
    const soon = new Date(Date.now() + 5 * 60_000);
    await addContact(ws, campaign, {
      name: 'dropped',
      armKind: 'RESUME',
      followUpCount: 1,
      nextEligibleAt: soon,
      // A promise kept two weeks ago, still on the row as history. Read off
      // the timestamps this is not a promise either — but a resume of a
      // contact whose old promise happened to land on the same instant was,
      // and that is the shape the arm makes impossible.
      callbackAt: new Date(Date.now() - 14 * 24 * 60 * 60_000),
    });

    const res = await request(app).get(url(ws, campaign)).set(...auth);

    expect(res.body.data.contacts[0]).toMatchObject({
      name: 'dropped',
      callbackPending: false,
      armKind: 'RESUME',
    });
  });

  it('pages with an offset, over the queue it was asked for', async () => {
    const { ws, campaign } = await setup();
    const at = (minutes: number) => new Date(Date.now() + minutes * 60_000);

    for (const minutes of [10, 20, 30]) {
      await addContact(ws, campaign, {
        name: `r${minutes}`,
        armKind: 'RETRY',
        attempts: 1,
        nextEligibleAt: at(minutes),
      });
    }

    const page = await request(app)
      .get(url(ws, campaign, '?queue=retry&limit=2'))
      .set(...auth);
    expect(names(page.body)).toEqual(['r10', 'r20']);
    // The total is the whole queue, not the page.
    expect(page.body.data.total).toBe(3);

    const next = await request(app)
      .get(url(ws, campaign, '?queue=retry&limit=2&offset=2'))
      .set(...auth);
    expect(names(next.body)).toEqual(['r30']);
  });

  it('refuses a page larger than the cap', async () => {
    const { ws, campaign } = await setup();

    const res = await request(app).get(url(ws, campaign, '?limit=500')).set(...auth);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('never reaches another campaign, whatever the queue', async () => {
    const { ws, campaign } = await setup();
    const other = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Other' },
    });
    const soon = new Date(Date.now() + 10 * 60_000);
    await addContact(ws, other, {
      name: 'theirs',
      armKind: 'RETRY',
      attempts: 1,
      nextEligibleAt: soon,
    });

    const res = await request(app).get(url(ws, campaign, '?queue=retry')).set(...auth);

    expect(res.body.data.contacts).toEqual([]);
    expect(res.body.data.total).toBe(0);
  });
});

/**
 * The follow-up queue.
 *
 * A goal follow-up re-arm moves `followUpCount` and deliberately touches
 * neither `attempts` (which counts retries consumed) nor `callbackAt` (which
 * is history of a promise). So a followed-up contact whose first dial actually
 * connected carries `attempts = 0` and matched no queue at all — invisible on
 * the tab whose whole job is saying what every waiting contact is waiting for,
 * and that is the ORDINARY case for a goal campaign, not an edge of one. One
 * that had also spent a retry showed up under "Retry cooldowns", which is the
 * wrong answer to "why is this person waiting".
 */
describe('GET .../contacts?queue=follow_up', () => {
  const at = (minutes: number) => new Date(Date.now() + minutes * 60_000);

  it('shows a follow-up whose first dial connected, attempts still zero', async () => {
    const { ws, campaign } = await setup();
    await addContact(ws, campaign, {
      name: 'partial',
      armKind: 'FOLLOW_UP',
      attempts: 0,
      followUpCount: 1,
      nextEligibleAt: at(60),
    });

    const res = await request(app).get(url(ws, campaign, '?queue=follow_up')).set(...auth);

    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual(['partial']);
    expect(res.body.data.total).toBe(1);
  });

  it('shows a follow-up that had also spent a retry, and keeps it out of retry', async () => {
    const { ws, campaign } = await setup();
    await addContact(ws, campaign, {
      name: 'partial-after-voicemail',
      armKind: 'FOLLOW_UP',
      attempts: 2,
      followUpCount: 1,
      nextEligibleAt: at(60),
    });

    const followUps = await request(app).get(url(ws, campaign, '?queue=follow_up')).set(...auth);
    expect(names(followUps.body)).toEqual(['partial-after-voicemail']);

    const retries = await request(app).get(url(ws, campaign, '?queue=retry')).set(...auth);
    expect(names(retries.body)).toEqual([]);
    expect(retries.body.data.total).toBe(0);
  });

  it('leaves a plain retry in the retry queue', async () => {
    const { ws, campaign } = await setup();
    await addContact(ws, campaign, {
      name: 'cooling',
      armKind: 'RETRY',
      attempts: 1,
      nextEligibleAt: at(30),
    });

    expect(names((await request(app).get(url(ws, campaign, '?queue=retry')).set(...auth)).body))
      .toEqual(['cooling']);
    expect(names((await request(app).get(url(ws, campaign, '?queue=follow_up')).set(...auth)).body))
      .toEqual([]);
  });

  /**
   * The retry ladder re-arming a contact that was once followed up.
   *
   * `followUpCount` never comes back down, so a tab keyed on it reported this
   * contact as waiting on a conversation for the rest of its life — through
   * the goal being cleared, and through `maxGoalFollowUps: 0`. The arm is
   * rewritten by whichever path re-armed the row last, so it answers about
   * now: this contact is cooling down between silences.
   */
  it('moves a followed-up contact to retry once the ladder re-arms it', async () => {
    const { ws, campaign } = await setup();
    await addContact(ws, campaign, {
      name: 'followed-up-then-voicemail',
      armKind: 'RETRY',
      attempts: 1,
      followUpCount: 3,
      nextEligibleAt: at(30),
    });

    expect(names((await request(app).get(url(ws, campaign, '?queue=retry')).set(...auth)).body))
      .toEqual(['followed-up-then-voicemail']);
    expect(names((await request(app).get(url(ws, campaign, '?queue=follow_up')).set(...auth)).body))
      .toEqual([]);
  });

  /** An armed promise is a promise whatever else the contact has done: the
   *  callback lane claims first, so it is the honest answer to "waiting for
   *  what". The booking rewrites the arm the follow-up re-arm just wrote. */
  it('yields to an armed callback', async () => {
    const { ws, campaign } = await setup();
    const soon = at(45);
    await addContact(ws, campaign, {
      name: 'promised',
      armKind: 'CALLBACK',
      followUpCount: 1,
      nextEligibleAt: soon,
      callbackAt: soon,
    });

    expect(names((await request(app).get(url(ws, campaign, '?queue=follow_up')).set(...auth)).body))
      .toEqual([]);
    expect(names((await request(app).get(url(ws, campaign, '?queue=callback')).set(...auth)).body))
      .toEqual(['promised']);
  });

  /** A promise kept long ago leaves `callbackAt` standing beside a lapsed
   *  cooldown. It is not news, and the follow-up tab keeps the contact. */
  it('keeps a follow-up whose promise history stands beside a lapsed cooldown', async () => {
    const { ws, campaign } = await setup();
    await addContact(ws, campaign, {
      name: 'kept-a-promise',
      armKind: 'FOLLOW_UP',
      followUpCount: 2,
      nextEligibleAt: null,
      callbackAt: at(-90),
    });

    expect(names((await request(app).get(url(ws, campaign, '?queue=follow_up')).set(...auth)).body))
      .toEqual(['kept-a-promise']);
  });

  it('orders by the clock it is about, soonest first', async () => {
    const { ws, campaign } = await setup();
    await addContact(ws, campaign, {
      name: 'late',
      armKind: 'FOLLOW_UP',
      followUpCount: 1,
      nextEligibleAt: at(90),
    });
    await addContact(ws, campaign, {
      name: 'soon',
      armKind: 'FOLLOW_UP',
      followUpCount: 1,
      nextEligibleAt: at(10),
    });

    const res = await request(app).get(url(ws, campaign, '?queue=follow_up')).set(...auth);

    expect(names(res.body)).toEqual(['soon', 'late']);
  });

  it('is named in the refusal that lists the queues that exist', async () => {
    const { ws, campaign } = await setup();

    const res = await request(app).get(url(ws, campaign, '?queue=followup')).set(...auth);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('follow_up');
  });

  /**
   * The property that makes the tab add up: every waiting contact is in
   * exactly one of the five groups, and none is in two.
   */
  it('partitions the waiting contacts with the other queues', async () => {
    const { ws, campaign } = await setup();
    const soon = at(20);

    await addContact(ws, campaign, { name: 'fresh' });
    await addContact(ws, campaign, {
      name: 'retrying',
      armKind: 'RETRY',
      attempts: 1,
      nextEligibleAt: at(40),
    });
    await addContact(ws, campaign, {
      name: 'following-up',
      armKind: 'FOLLOW_UP',
      followUpCount: 1,
      nextEligibleAt: at(50),
    });
    await addContact(ws, campaign, {
      name: 'following-up-after-retry',
      armKind: 'FOLLOW_UP',
      attempts: 3,
      followUpCount: 2,
      nextEligibleAt: at(70),
    });
    await addContact(ws, campaign, {
      name: 'resuming',
      armKind: 'RESUME',
      followUpCount: 1,
      nextEligibleAt: at(5),
    });
    await addContact(ws, campaign, {
      name: 'promised',
      armKind: 'CALLBACK',
      nextEligibleAt: soon,
      callbackAt: soon,
    });
    await addContact(ws, campaign, {
      name: 'overdue',
      armKind: 'CALLBACK',
      nextEligibleAt: at(-30),
      callbackAt: at(-30),
    });

    const of = async (queue: string) =>
      names((await request(app).get(url(ws, campaign, `?queue=${queue}`)).set(...auth)).body).sort();

    const groups = {
      callback: await of('callback'),
      callback_overdue: await of('callback_overdue'),
      resume: await of('resume'),
      retry: await of('retry'),
      follow_up: await of('follow_up'),
    };

    expect(groups).toEqual({
      callback: ['promised'],
      callback_overdue: ['overdue'],
      resume: ['resuming'],
      retry: ['retrying'],
      follow_up: ['following-up', 'following-up-after-retry'],
    });

    // No contact in two groups, and only the never-called one in none.
    const all = Object.values(groups).flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain('fresh');
  });
});

/**
 * The resume queue.
 *
 * A conversation that cut out mid-call, which the engine goes back to at
 * `immediateCallbackMinutes`. It used to be arm-less: the re-arm set
 * `nextEligibleAt == callbackAt` to reach the dispatcher's callback lane, so
 * this contact appeared under "Callbacks due" — a promise, on the tab an
 * operator reads before ringing somebody back to apologise for a call the
 * lead never asked for.
 */
describe('GET .../contacts?queue=resume', () => {
  const at = (minutes: number) => new Date(Date.now() + minutes * 60_000);

  it('shows a dropped conversation, and keeps it out of the callback queues', async () => {
    const { ws, campaign } = await setup();
    await addContact(ws, campaign, {
      name: 'dropped',
      armKind: 'RESUME',
      followUpCount: 1,
      nextEligibleAt: at(5),
    });

    const resumes = await request(app).get(url(ws, campaign, '?queue=resume')).set(...auth);
    expect(resumes.status).toBe(200);
    expect(names(resumes.body)).toEqual(['dropped']);
    expect(resumes.body.data.total).toBe(1);

    for (const queue of ['callback', 'callback_overdue', 'retry', 'follow_up']) {
      const other = await request(app).get(url(ws, campaign, `?queue=${queue}`)).set(...auth);
      expect(names(other.body)).toEqual([]);
    }
  });

  it('orders by the clock the resume itself wrote, soonest first', async () => {
    const { ws, campaign } = await setup();
    await addContact(ws, campaign, {
      name: 'late',
      armKind: 'RESUME',
      followUpCount: 1,
      nextEligibleAt: at(9),
    });
    await addContact(ws, campaign, {
      name: 'soon',
      armKind: 'RESUME',
      followUpCount: 1,
      nextEligibleAt: at(2),
    });

    const res = await request(app).get(url(ws, campaign, '?queue=resume')).set(...auth);

    expect(names(res.body)).toEqual(['soon', 'late']);
  });
});
