import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/adapter/vocobase.js', () => ({
  startCall: vi.fn(),
  getConcurrency: vi.fn(),
  getCall: vi.fn(),
}));

const { scheduleCampaignCallback, bookCallbackFromExtraction, MAX_CALLBACKS_PER_CONTACT } =
  await import('../src/services/campaignCallback.js');
const { callbackRawFrom } = await import('../src/lib/attemptKind.js');
const { prisma } = await import('../src/lib/prisma.js');
const { flushNotifications } = await import('../src/lib/notify.js');
const { truncateAll } = await import('./setup.js');
const { makeAccount, makeAgent, makeWorkspace } = await import('./helpers.js');
const { evaluateWindow } = await import('../src/lib/dialingWindow.js');

import type { CampaignContactStatus, CampaignStatus } from '@prisma/client';

interface SeedOptions {
  campaignStatus?: CampaignStatus;
  contactStatus?: CampaignContactStatus;
  stoppedAt?: Date | null;
  callbackCount?: number;
  attempts?: number;
  completedCount?: number;
  failedCount?: number;
  callbackEnabled?: boolean;
  /** The goal switch. Absent is a plain campaign. */
  goalEnabled?: boolean;
  fromTime?: string | null;
  toTime?: string | null;
  timezone?: string | null;
  dialDays?: number[];
}

let seq = 0;

async function seed(options: SeedOptions = {}) {
  seq += 1;
  const account = await makeAccount(`cb${seq}${Math.random().toString(36).slice(2, 6)}`);
  const workspace = await makeWorkspace(account, 'Callbacks');
  const agent = await makeAgent(workspace, 'caller');

  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: workspace.id,
      name: 'Outreach',
      agentId: agent.id,
      status: options.campaignStatus ?? 'RUNNING',
      stoppedAt: options.stoppedAt ?? null,
      completedCount: options.completedCount ?? 0,
      failedCount: options.failedCount ?? 0,
      callbackEnabled: options.callbackEnabled ?? true,
      goalEnabled: options.goalEnabled ?? false,
      fromTime: options.fromTime === undefined ? null : options.fromTime,
      toTime: options.toTime === undefined ? null : options.toTime,
      timezone: options.timezone === undefined ? 'Asia/Kolkata' : options.timezone,
      dialDays: options.dialDays ?? [],
    },
  });

  const contact = await prisma.contact.create({
    data: { workspaceId: workspace.id, phone: `+91800000${1000 + seq}` },
  });

  const link = await prisma.campaignContact.create({
    data: {
      campaignId: campaign.id,
      contactId: contact.id,
      status: options.contactStatus ?? 'COMPLETED',
      attempts: options.attempts ?? 1,
      callbackCount: options.callbackCount ?? 0,
      lastSessionId: 'sess_before',
    },
  });

  return { workspaceId: workspace.id, campaignId: campaign.id, contactId: link.id };
}

const contactRow = (id: string) => prisma.campaignContact.findUniqueOrThrow({ where: { id } });
const campaignRow = (id: string) => prisma.campaign.findUniqueOrThrow({ where: { id } });

const TOMORROW = new Date(Date.now() + 24 * 3_600_000);

beforeEach(async () => {
  await truncateAll();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await flushNotifications();
  await truncateAll();
  vi.restoreAllMocks();
});

describe('booking a promised callback', () => {
  it('arms the contact with one instant in both columns', async () => {
    const { contactId } = await seed({ completedCount: 1 });

    await expect(
      scheduleCampaignCallback({ campaignContactId: contactId, callbackAt: TOMORROW, attemptNo: 1 }),
    ).resolves.toBe('SCHEDULED');

    const contact = await contactRow(contactId);
    expect(contact.status).toBe('PENDING');
    // The invariant: equal, both non-null, is the sole marker of an armed
    // callback, and one instant is written to both columns to make it.
    expect(contact.callbackAt?.getTime()).toBe(TOMORROW.getTime());
    expect(contact.nextEligibleAt?.getTime()).toBe(contact.callbackAt?.getTime());
    expect(contact.callbackCount).toBe(1);
  });

  /** A promise made to a person on the phone is not a retry. Budgeting it as
   *  one would let a lowered retry count cancel a call somebody expects. */
  it('spends no retry', async () => {
    const { contactId } = await seed({ attempts: 2, completedCount: 1 });

    await scheduleCampaignCallback({ campaignContactId: contactId, callbackAt: TOMORROW, attemptNo: 1 });

    expect((await contactRow(contactId)).attempts).toBe(2);
  });

  it('keeps the session the promise was made on', async () => {
    const { contactId } = await seed({ completedCount: 1 });

    await scheduleCampaignCallback({ campaignContactId: contactId, callbackAt: TOMORROW, attemptNo: 1 });

    expect((await contactRow(contactId)).lastSessionId).toBe('sess_before');
  });

  it('gives the terminal counter back, because the contact is no longer terminal', async () => {
    const completed = await seed({ contactStatus: 'COMPLETED', completedCount: 3, failedCount: 1 });
    await scheduleCampaignCallback({
      campaignContactId: completed.contactId,
      callbackAt: TOMORROW,
      attemptNo: 1,
    });

    const afterCompleted = await campaignRow(completed.campaignId);
    expect(afterCompleted.completedCount).toBe(2);
    expect(afterCompleted.failedCount).toBe(1);

    const failed = await seed({ contactStatus: 'FAILED', completedCount: 1, failedCount: 2 });
    await scheduleCampaignCallback({ campaignContactId: failed.contactId, callbackAt: TOMORROW, attemptNo: 1 });

    const afterFailed = await campaignRow(failed.campaignId);
    expect(afterFailed.failedCount).toBe(1);
    expect(afterFailed.completedCount).toBe(1);
  });

  it('never drives a counter below zero', async () => {
    const { contactId, campaignId } = await seed({ contactStatus: 'FAILED', failedCount: 0 });

    await scheduleCampaignCallback({ campaignContactId: contactId, callbackAt: TOMORROW, attemptNo: 1 });

    expect((await campaignRow(campaignId)).failedCount).toBe(0);
  });
});

describe('re-opening a campaign that had finished', () => {
  /**
   * A scheduled callback *is* pending work, and there is nobody to press
   * Resume at 3pm tomorrow. Deliberately asymmetric with a top-up, which
   * re-opens to PAUSED.
   */
  it('puts a completed campaign back to running', async () => {
    const { contactId, campaignId } = await seed({
      campaignStatus: 'COMPLETED',
      completedCount: 1,
    });
    await prisma.campaign.update({ where: { id: campaignId }, data: { completedAt: new Date() } });

    await expect(
      scheduleCampaignCallback({ campaignContactId: contactId, callbackAt: TOMORROW, attemptNo: 1 }),
    ).resolves.toBe('SCHEDULED');

    const campaign = await campaignRow(campaignId);
    expect(campaign.status).toBe('RUNNING');
    expect(campaign.completedAt).toBeNull();
  });

  it('leaves a running campaign alone', async () => {
    const { contactId, campaignId } = await seed({ campaignStatus: 'RUNNING', completedCount: 1 });

    await scheduleCampaignCallback({ campaignContactId: contactId, callbackAt: TOMORROW, attemptNo: 1 });

    expect((await campaignRow(campaignId)).status).toBe('RUNNING');
  });

  it('does not restart a paused campaign the operator paused', async () => {
    const { contactId, campaignId } = await seed({ campaignStatus: 'PAUSED', completedCount: 1 });

    await expect(
      scheduleCampaignCallback({ campaignContactId: contactId, callbackAt: TOMORROW, attemptNo: 1 }),
    ).resolves.toBe('SCHEDULED');

    expect((await campaignRow(campaignId)).status).toBe('PAUSED');
  });
});

describe('a dial the queue has moved past', () => {
  async function seedWithAttempts(attemptNos: number[]) {
    const seeded = await seed({ contactStatus: 'COMPLETED' });
    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: seeded.workspaceId },
      select: { ownerAccountId: true },
    });

    for (const attemptNo of attemptNos) {
      await prisma.callAttempt.create({
        data: {
          campaignId: seeded.campaignId,
          campaignContactId: seeded.contactId,
          workspaceId: seeded.workspaceId,
          accountId: workspace.ownerAccountId,
          attemptNo,
          status: 'COMPLETED',
          resolvedAt: new Date(),
        },
      });
    }

    return seeded;
  }

  /**
   * A late delivery for a superseded attempt is deliberately let through to
   * the charge — the minutes were real — but its promise died with the dial.
   * `attemptNo` is unique per contact and only ever increases, so "a row
   * numbered above mine exists" is exactly "the queue has dialled on".
   */
  it('refuses a promise extracted from a superseded attempt', async () => {
    const { contactId } = await seedWithAttempts([1, 2]);

    await expect(
      scheduleCampaignCallback({ campaignContactId: contactId, callbackAt: TOMORROW, attemptNo: 1 }),
    ).resolves.toBe('SUPERSEDED');

    const contact = await contactRow(contactId);
    expect(contact.status).toBe('COMPLETED');
    expect(contact.callbackAt).toBeNull();
    expect(contact.callbackCount).toBe(0);
  });

  it('books a promise from the contact’s latest attempt as usual', async () => {
    const { contactId } = await seedWithAttempts([1, 2]);

    await expect(
      scheduleCampaignCallback({ campaignContactId: contactId, callbackAt: TOMORROW, attemptNo: 2 }),
    ).resolves.toBe('SCHEDULED');
  });
});

describe('a campaign the operator killed', () => {
  it('refuses to book on a stopped campaign', async () => {
    const { contactId, campaignId } = await seed({
      campaignStatus: 'STOPPED',
      stoppedAt: new Date(),
    });

    await expect(
      scheduleCampaignCallback({ campaignContactId: contactId, callbackAt: TOMORROW, attemptNo: 1 }),
    ).resolves.toBe('CAMPAIGN_CANCELLED');

    const contact = await contactRow(contactId);
    expect(contact.status).toBe('COMPLETED');
    expect(contact.callbackAt).toBeNull();
    expect((await campaignRow(campaignId)).status).toBe('STOPPED');
  });

  /**
   * The regression this refusal is keyed on `stoppedAt` for: `complete`
   * relabels STOPPED to COMPLETED, so a status-only guard would let a lead in a
   * call that outlived the stop re-open a campaign the operator killed — and
   * the re-open above would put it straight back to RUNNING.
   */
  it('still refuses after the stopped campaign has been relabelled complete', async () => {
    const { contactId, campaignId } = await seed({
      campaignStatus: 'COMPLETED',
      stoppedAt: new Date(),
      completedCount: 1,
    });

    await expect(
      scheduleCampaignCallback({ campaignContactId: contactId, callbackAt: TOMORROW, attemptNo: 1 }),
    ).resolves.toBe('CAMPAIGN_CANCELLED');

    expect((await campaignRow(campaignId)).status).toBe('COMPLETED');
    expect((await contactRow(contactId)).callbackAt).toBeNull();
  });
});

describe('a contact that is not there to be re-armed', () => {
  it.each(['PENDING', 'QUEUED', 'SKIPPED', 'EXCLUDED'] as const)(
    'refuses a contact that is %s',
    async (contactStatus) => {
      const { contactId } = await seed({ contactStatus });

      await expect(
        scheduleCampaignCallback({ campaignContactId: contactId, callbackAt: TOMORROW, attemptNo: 1 }),
      ).resolves.toBe('NOT_RESOLVED');

      expect((await contactRow(contactId)).callbackAt).toBeNull();
    },
  );

  it('refuses a contact that no longer exists', async () => {
    await expect(
      scheduleCampaignCallback({ campaignContactId: 'gone', callbackAt: TOMORROW, attemptNo: 1 }),
    ).resolves.toBe('NOT_RESOLVED');
  });

  /** The dispatcher re-claimed the contact between the outcome and the
   *  booking. Nothing below the guard runs: no counter, no re-open. */
  it('changes no counter when it loses the race to a re-claim', async () => {
    const { contactId, campaignId } = await seed({ contactStatus: 'QUEUED', completedCount: 4 });

    await expect(
      scheduleCampaignCallback({ campaignContactId: contactId, callbackAt: TOMORROW, attemptNo: 1 }),
    ).resolves.toBe('NOT_RESOLVED');

    expect((await campaignRow(campaignId)).completedCount).toBe(4);
  });
});

describe('how many callbacks one contact may have', () => {
  it('refuses past the cap', async () => {
    const { contactId } = await seed({ callbackCount: MAX_CALLBACKS_PER_CONTACT });

    await expect(
      scheduleCampaignCallback({ campaignContactId: contactId, callbackAt: TOMORROW, attemptNo: 1 }),
    ).resolves.toBe('LIMIT_REACHED');

    expect((await contactRow(contactId)).status).toBe('COMPLETED');
  });

  it('allows the last one under the cap', async () => {
    const { contactId } = await seed({ callbackCount: MAX_CALLBACKS_PER_CONTACT - 1 });

    await expect(
      scheduleCampaignCallback({ campaignContactId: contactId, callbackAt: TOMORROW, attemptNo: 1 }),
    ).resolves.toBe('SCHEDULED');

    expect((await contactRow(contactId)).callbackCount).toBe(MAX_CALLBACKS_PER_CONTACT);
  });
});

/**
 * Both writers take the campaign row's lock first. Without that ordering the
 * dispatcher can count a campaign's remaining work, have this re-arm slip in
 * underneath, and complete the campaign on top of a contact it just put back on
 * the queue — a promise made to a person, cancelled by a campaign announcing
 * itself finished.
 */
describe('lock ordering against a campaign completing', () => {
  it('serialises a booking against a completion pass', async () => {
    const { contactId, campaignId } = await seed({ completedCount: 1 });

    // The completion pass, held open with the campaign locked, exactly as the
    // dispatcher takes it.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    let locked: () => void = () => {};
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });

    const completion = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${campaignId} FOR UPDATE`;
      locked();
      await held;

      const remaining = await tx.campaignContact.count({
        where: { campaignId, status: { in: ['PENDING', 'QUEUED', 'CALLING'] } },
      });

      if (remaining > 0) return 0;

      const moved = await tx.campaign.updateMany({
        where: { id: campaignId, status: 'RUNNING' },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });

      return moved.count;
    }, { timeout: 20_000 });

    await lockTaken;

    let released = false;
    let settledBeforeRelease = false;

    const booking = scheduleCampaignCallback({
      campaignContactId: contactId,
      callbackAt: TOMORROW,
      attemptNo: 1,
    }).then((result) => {
      settledBeforeRelease = !released;

      return result;
    });

    // The booking cannot get past the lock while the completion holds it.
    await new Promise((resolve) => setTimeout(resolve, 150));
    released = true;
    release();

    const [completed, outcome] = await Promise.all([completion, booking]);

    // The completion ran first and found nothing pending, so it completed the
    // campaign — and the booking, which could only start afterwards, re-opened
    // it rather than leaving its contact stranded on a finished campaign.
    expect(settledBeforeRelease).toBe(false);
    expect(completed).toBe(1);
    expect(outcome).toBe('SCHEDULED');
    expect((await campaignRow(campaignId)).status).toBe('RUNNING');
    expect((await contactRow(contactId)).status).toBe('PENDING');
  });
});

describe('booking from what the call extracted', () => {
  const iso = () => new Date(Date.now() + 26 * 3_600_000).toISOString();

  it('books a value the campaign’s window already allows', async () => {
    const { campaignId, contactId } = await seed({ completedCount: 1 });
    const raw = iso();

    await bookCallbackFromExtraction({ campaignId, campaignContactId: contactId, attemptNo: 1, raw });

    expect((await contactRow(contactId)).callbackAt?.toISOString()).toBe(
      new Date(raw).toISOString(),
    );
  });

  it('rolls a promise made outside the dialing hours into them', async () => {
    const { campaignId, contactId } = await seed({
      completedCount: 1,
      fromTime: '09:00',
      toTime: '21:00',
      timezone: 'Asia/Kolkata',
    });

    /**
     * 03:00 IST on a day well ahead — inside the promise horizon, outside the
     * window.
     *
     * Two days out rather than one, because 03:00 IST is 21:30 UTC on the
     * *previous* UTC day: stamping 03:00 IST onto tomorrow's UTC date names an
     * instant only hours away, and once the suite runs later than 21:30 UTC
     * that instant is already past and the booking is refused as `too_soon`.
     * The offset has to clear a whole UTC day, or the case passes or fails on
     * the hour it happens to be run at.
     */
    const local = new Date(Date.now() + 48 * 3_600_000).toISOString().slice(0, 10);
    await bookCallbackFromExtraction({
      campaignId,
      campaignContactId: contactId,
      attemptNo: 1,
      raw: `${local}T03:00:00+05:30`,
    });

    const contact = await contactRow(contactId);
    expect(contact.status).toBe('PENDING');
    // 09:00 IST is 03:30 UTC.
    expect(contact.callbackAt?.toISOString().slice(11, 16)).toBe('03:30');
    expect(contact.nextEligibleAt?.getTime()).toBe(contact.callbackAt?.getTime());
  });

  /**
   * A promise made for a day the campaign does not call on.
   *
   * The booking and the dispatcher's gate walk the same `nextOpening`, and
   * this is the assertion that says so from the outside: whatever instant
   * lands in `callbackAt`, the gate must call it open. A booking the gate
   * refuses is a `callbackAt` asserting a promise that was never kept — the
   * contact sits eligible and nothing dials.
   *
   * The Saturday is computed rather than written down, so this holds whichever
   * day the suite is run on.
   */
  it('books a promise for a closed day onto a day the campaign calls on', async () => {
    const window = {
      fromTime: '09:00',
      toTime: '21:00',
      timezone: 'Asia/Kolkata',
      dialDays: [1, 2, 3, 4, 5],
    };
    const { campaignId, contactId } = await seed({ completedCount: 1, ...window });

    const istDate = (ms: number) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(ms);
    const weekdayOf = (ymd: string) => {
      const [y, m, d] = ymd.split('-').map(Number);

      return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
    };

    // The first Saturday at least two days out — two, for the reason the test
    // above states: an IST wall time on tomorrow's date can already be past.
    let ymd = istDate(Date.now() + 48 * 3_600_000);
    for (let i = 0; i < 7 && weekdayOf(ymd) !== 6; i += 1) {
      const [y, m, d] = ymd.split('-').map(Number);
      ymd = istDate(Date.UTC(y!, m! - 1, d! + 1, 12));
    }
    expect(weekdayOf(ymd)).toBe(6);

    await bookCallbackFromExtraction({
      campaignId,
      campaignContactId: contactId,
      attemptNo: 1,
      raw: `${ymd}T15:00:00+05:30`,
    });

    const booked = (await contactRow(contactId)).callbackAt;
    expect(booked).not.toBeNull();
    expect([1, 2, 3, 4, 5]).toContain(weekdayOf(istDate(booked!.getTime())));
    // And the gate agrees, which is the claim that matters: the dispatcher
    // will actually dial at the instant the person was promised.
    expect(evaluateWindow(window, booked!).state).toBe('open');
  });

  /**
   * `callbackEnabled` no longer forbids a booking, and nothing is left that
   * could.
   *
   * The switch was already true on every row (the callbacks-always-on
   * migration), and its one remaining reader was an exception for goal
   * campaigns — whose agents ask for the callback time in the call note
   * whatever the switch says. Every campaign is a goal campaign since
   * 2026-09-06, so the exception swallowed the rule and the gate is gone.
   *
   * Asserted with the switch stored `false`, which is the only way to prove
   * a column is unread: a promise a person made on the telephone is booked.
   */
  it('books a promise even when the stored callback switch says false', async () => {
    const { campaignId, contactId } = await seed({
      completedCount: 1,
      callbackEnabled: false,
    });
    const raw = iso();

    await bookCallbackFromExtraction({ campaignId, campaignContactId: contactId, attemptNo: 1, raw });

    expect((await contactRow(contactId)).callbackAt?.toISOString()).toBe(
      new Date(raw).toISOString(),
    );
  });

  /**
   * The shape the call note's key description asks for: `YYYY-MM-DDTHH:mm±HH`,
   * a two-digit offset and no seconds. Read as `±HH:00`, so 17:00 at +05 is
   * 12:00 UTC — and then rolled into the campaign's window like any promise.
   */
  it('books the note’s YYYY-MM-DDTHH:mm±HH time, rolled into the window', async () => {
    const { campaignId, contactId } = await seed({
      completedCount: 1,
      goalEnabled: true,
      fromTime: '09:00',
      toTime: '18:00',
      timezone: 'Asia/Kolkata',
    });
    // The specification's example is 2026-09-08T17:00+05; the date is built
    // five days ahead so the case does not rot past the example's day.
    const ymd = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const raw = `${ymd}T17:00+05`;

    await bookCallbackFromExtraction({ campaignId, campaignContactId: contactId, attemptNo: 1, raw });

    const contact = await contactRow(contactId);
    // 17:00 at +05 is 12:00 UTC, which is 17:30 IST — inside the window, so
    // the promise stands at the instant it named.
    expect(contact.callbackAt?.toISOString()).toBe(`${ymd}T12:00:00.000Z`);
    expect(contact.nextEligibleAt?.getTime()).toBe(contact.callbackAt?.getTime());
    expect(contact.status).toBe('PENDING');
  });

  it.each([
    ['nothing at all', null],
    ['the literal word "null"', 'null'],
    ['a value that is not text', 42],
    ['prose', 'sometime next week'],
    ['a bare date', '2027-01-04'],
    ['an instant already past', '2020-01-01T10:00:00Z'],
  ])('books nothing for %s', async (_name, raw) => {
    const { campaignId, contactId } = await seed({ completedCount: 1 });

    await bookCallbackFromExtraction({ campaignId, campaignContactId: contactId, attemptNo: 1, raw });

    expect((await contactRow(contactId)).callbackAt).toBeNull();
    expect((await contactRow(contactId)).status).toBe('COMPLETED');
  });

  /** A callback failure must never break the charging that preceded it. */
  it('never throws, whatever it is handed', async () => {
    await expect(
      bookCallbackFromExtraction({
        campaignId: 'no-such-campaign',
        campaignContactId: 'no-such-contact',
        attemptNo: 1,
        raw: iso(),
      }),
    ).resolves.toBeUndefined();
  });

  it('says what it did, once, with the contact and the reason', async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      logged.push(args);
    });

    const { campaignId, contactId } = await seed({ completedCount: 1 });
    await bookCallbackFromExtraction({ campaignId, campaignContactId: contactId, attemptNo: 1, raw: iso() });

    const lines = logged.filter((line) => String(line[0]).includes('[callback]'));
    expect(lines).toHaveLength(1);
    expect(String(lines[0]![0])).toContain(contactId);
    expect(String(lines[0]![0])).toContain('SCHEDULED');
  });
});

/**
 * Which extracted value the booking parses.
 *
 * One reading since 2026-09-06: every agent answers the call note, and the
 * note names a time that is a promise only when it also says the callback was
 * requested. One helper, shared by the webhook and the reaper, so a promise
 * heard late is read by the same rule as one heard on time.
 */
describe('callbackRawFrom', () => {
  const NOTE_TIME = '2026-09-08T17:00+05';

  /**
   * `callbackType` is this helper's own convenience parameter — there is no
   * `callback_type` key any more. Contender I derives `CallNote.callbackType`
   * from `immediate_callback_needed` and `callback_requested_time`: a
   * `'requested'` here carries `time` (defaulting to `NOTE_TIME`) as the
   * requested-time key; every other value carries no time of its own,
   * because attaching a real time to any of them would itself derive
   * `'requested'` — see the precedence test below.
   */
  const note = (outcome: string, callbackType: string, time: string | null = null) => ({
    call_outcome_vocobaseplatform: outcome,
    immediate_callback_needed_vocobaseplatform: callbackType === 'immediate' ? 'yes' : 'no',
    callback_requested_time_vocobaseplatform:
      callbackType === 'requested' ? (time ?? NOTE_TIME) : (time ?? 'null'),
    next_call_instructions_vocobaseplatform: 'Resume from the budget question.',
  });

  it('reads the note’s time when the call is incomplete and a callback was requested', () => {
    expect(callbackRawFrom(note('incomplete', 'requested'))).toBe(NOTE_TIME);
    // Case and whitespace are the model's, not the decision's.
    expect(callbackRawFrom(note(' Incomplete ', 'requested'))).toBe(NOTE_TIME);
  });

  it('reads the literal word "null" as no time', () => {
    expect(callbackRawFrom(note('incomplete', 'requested', 'null'))).toBeNull();
    expect(callbackRawFrom(note('incomplete', 'requested', ' NULL '))).toBeNull();
  });

  /** No time at all books nothing, whatever `immediate_callback_needed` says
   *  — and the outcome gate still refuses a `completed` or `stop` call even
   *  when a time somehow rode along. */
  it('books nothing when there is no real time, and never off a completed or stop outcome', () => {
    expect(callbackRawFrom(note('incomplete', 'immediate'))).toBeNull();
    expect(callbackRawFrom(note('incomplete', 'flexible'))).toBeNull();
    expect(callbackRawFrom(note('completed', 'requested'))).toBeNull();
    expect(callbackRawFrom(note('stop', 'requested'))).toBeNull();
  });

  /**
   * The precedence rule, exercised through `callbackRawFrom`: a real,
   * parseable time beats `immediate_callback_needed = "yes"`, because the
   * time's own description tells the model to null it out when immediate is
   * "yes" — so a real time arriving anyway means the model disobeyed that
   * instruction, and the explicit promise wins.
   */
  it('books the note’s time even when immediate_callback_needed is "yes"', () => {
    expect(callbackRawFrom(note('incomplete', 'immediate', NOTE_TIME))).toBe(NOTE_TIME);
  });

  /**
   * The plain callbacks key is never a promise, and that is deliberate.
   *
   * Agents are shared between campaigns, so a stale `callback_requested_at`
   * from some other campaign's set is routinely sitting in the same
   * extraction — and read as a promise it books a call on a conversation that
   * said `completed`. The gate used to be the goal switch; there is no switch
   * any more, and the rule it protected stands on its own.
   */
  it('never books off the plain callbacks keys', () => {
    expect(
      callbackRawFrom({ callback_requested_at: NOTE_TIME, callback_at: NOTE_TIME }),
    ).toBeNull();
    // Beside a note that settles the conversation: the very case the refusal
    // exists for.
    expect(
      callbackRawFrom({ ...note('completed', 'flexible'), callback_requested_at: NOTE_TIME }),
    ).toBeNull();
  });

  it('is total over anything the envelope carried', () => {
    expect(callbackRawFrom(null)).toBeNull();
    expect(callbackRawFrom(undefined)).toBeNull();
    expect(callbackRawFrom('text')).toBeNull();
    expect(callbackRawFrom([NOTE_TIME])).toBeNull();
    expect(callbackRawFrom({})).toBeNull();
  });
});
