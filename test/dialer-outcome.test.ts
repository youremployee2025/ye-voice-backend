import type { ContactArmKind, Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/adapter/vocobase.js', () => ({
  startCall: vi.fn(),
  getConcurrency: vi.fn(),
  getCall: vi.fn(),
}));

const { applyTerminalOutcome, resolveContact } = await import('../src/services/dialerOutcome.js');
const { dialBudgetSpent } = await import('../src/lib/dialBudget.js');
const { prisma } = await import('../src/lib/prisma.js');
const { flushNotifications } = await import('../src/lib/notify.js');
const { toInternalCredits } = await import('../src/lib/credits.js');
const { truncateAll } = await import('./setup.js');
const { makeAccount, makeAgent, makeWorkspace } = await import('./helpers.js');

interface SeedOptions {
  retryCount?: number;
  cooldownMinutes?: number;
  retryDelaysMinutes?: number[];
  /** Retries already consumed by this contact. */
  attempts?: number;
  /** Why the row's clock was set when this dial was claimed. */
  armKind?: ContactArmKind;
  callbackAt?: Date | null;
  nextEligibleAt?: Date | null;
  contactStatus?: 'PENDING' | 'QUEUED' | 'COMPLETED' | 'FAILED';
  credits?: string;
  attemptNo?: number;
  /** The FOLLOW-UP lane's budget. Zero by default here: this file is about the
   *  retry lane and the charge, and a campaign that follows people up would
   *  re-arm most of its cases instead of settling them. Cases about the
   *  follow-up lane itself live in `goal-resolution.test.ts`. */
  maxGoalFollowUps?: number;
  /** The increment snapshotted onto the attempt at dial time. `undefined`
   *  leaves the column NULL, which is an attempt launched before pulse
   *  billing existed. */
  incrementSecs?: number | null;
}

interface Seeded {
  accountId: string;
  workspaceId: string;
  campaignId: string;
  contactId: string;
  attemptId: string;
  sessionId: string;
}

let seq = 0;

async function seed(options: SeedOptions = {}): Promise<Seeded> {
  seq += 1;
  const account = await makeAccount(`o${seq}${Math.random().toString(36).slice(2, 6)}`);
  await prisma.account.update({
    where: { id: account.id },
    data: { credits: toInternalCredits(options.credits ?? '100') },
  });

  const workspace = await makeWorkspace(account, 'Resolvers');
  const agent = await makeAgent(workspace, 'caller');

  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: workspace.id,
      name: 'Outreach',
      agentId: agent.id,
      status: 'RUNNING',
      retryCount: options.retryCount ?? 2,
      cooldownMinutes: options.cooldownMinutes ?? 30,
      retryDelaysMinutes: options.retryDelaysMinutes ?? [],
      maxGoalFollowUps: options.maxGoalFollowUps ?? 0,
      followUpDelayHours: 24,
      // Retired, at values that would change these answers if read.
      goalEnabled: false,
      maxTotalDials: 99,
      immediateCallbackMinutes: 90,
    },
  });

  const contact = await prisma.contact.create({
    data: { workspaceId: workspace.id, phone: `+91900000${1000 + seq}` },
  });

  const link = await prisma.campaignContact.create({
    data: {
      campaignId: campaign.id,
      contactId: contact.id,
      status: options.contactStatus ?? 'QUEUED',
      armKind: options.armKind ?? 'FRESH',
      attempts: options.attempts ?? 0,
      callbackAt: options.callbackAt ?? null,
      nextEligibleAt: options.nextEligibleAt ?? null,
    },
  });

  const attempt = await prisma.callAttempt.create({
    data: {
      campaignId: campaign.id,
      campaignContactId: link.id,
      workspaceId: workspace.id,
      accountId: account.id,
      attemptNo: options.attemptNo ?? (options.attempts ?? 0) + 1,
      status: 'IN_PROGRESS',
      upstreamCallId: `c_${seq}`,
      upstreamSessionId: `s_${seq}`,
      rateCreditsPerMin: toInternalCredits('1.00'),
      billingIncrementSecs: options.incrementSecs ?? null,
    },
  });

  return {
    accountId: account.id,
    workspaceId: workspace.id,
    campaignId: campaign.id,
    contactId: link.id,
    attemptId: attempt.id,
    sessionId: attempt.upstreamSessionId!,
  };
}

/**
 * The bot's note on a conversation that finished.
 *
 * Every campaign follows an unfinished conversation up since 2026-09-06, so a
 * connected call carrying NO note is a follow-up rather than a settle: "no
 * outcome" is one more call, never a judgement. The cases below that are
 * about charging, locking and disarming want a call that settles, so they say
 * so — which is also the honest reading of the fixture, since a real dial of
 * a real campaign always carries the call-note keys.
 */
const COMPLETED = {
  call_outcome_vocobaseplatform: 'completed',
  call_outcome_reason_vocobaseplatform: 'null',
  immediate_callback_needed_vocobaseplatform: 'no',
  callback_requested_time_vocobaseplatform: 'null',
  next_call_instructions_vocobaseplatform: 'null',
};

/** One completion, with everything a platform sends and nothing more. */
function outcome(
  attemptId: string,
  over: {
    status?: string;
    disposition?: string | null;
    answeredBy?: string | null;
    durationSecs?: number;
    failureReason?: string;
    extraction?: unknown;
    hangupCause?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    endCallReason?: string | null;
    answeredAt?: Date | string | null;
  } = {},
) {
  return {
    attemptId,
    ...(over.answeredAt === undefined ? {} : { answeredAt: over.answeredAt }),
    ...(over.errorCode === undefined ? {} : { errorCode: over.errorCode }),
    ...(over.endCallReason === undefined ? {} : { endCallReason: over.endCallReason }),
    ...(over.errorMessage === undefined ? {} : { errorMessage: over.errorMessage }),
    status: over.status ?? 'completed',
    disposition: over.disposition === undefined ? 'completed' : over.disposition,
    answeredBy: over.answeredBy === undefined ? 'human' : over.answeredBy,
    hangupCause: over.hangupCause ?? null,
    durationSecs: over.durationSecs ?? 60,
    endedAt: new Date(),
    eventKey: `session.completed:s_${attemptId}`,
    ...(over.failureReason ? { failureReason: over.failureReason } : {}),
    ...(over.extraction === undefined ? {} : { extraction: over.extraction }),
  };
}

/** The same completion, carrying the note that ends the conversation. */
const settling = (attemptId: string, over: Parameters<typeof outcome>[1] = {}) =>
  outcome(attemptId, { extraction: COMPLETED, ...over });

const contactRow = (id: string) => prisma.campaignContact.findUniqueOrThrow({ where: { id } });
const campaignRow = (id: string) => prisma.campaign.findUniqueOrThrow({ where: { id } });

/** Minutes from now until an instant, rounded — the write happens on the
 *  service's own clock, so the assertion cannot pin the second. */
function minutesAway(at: Date | null): number {
  if (at === null) throw new Error('expected an instant');

  return Math.round((at.getTime() - Date.now()) / 60_000);
}

beforeEach(async () => {
  await truncateAll();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await flushNotifications();
  await truncateAll();
  vi.restoreAllMocks();
});

/**
 * Pulse billing on the charge path.
 *
 * The rate is 1.00 credits (10000 internal units) per minute throughout, and
 * every expected figure below is hand-computed from that. A charge derived
 * from the implementation's own arithmetic asserts nothing.
 */
describe('billing a call in increments', () => {
  it('bills a part-minute call as a whole minute on a sixty-second increment', async () => {
    const { attemptId, accountId } = await seed({ incrementSecs: 60 });

    expect(await applyTerminalOutcome(outcome(attemptId, { durationSecs: 47 }))).toBe('applied');

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });

    // Both figures, so the row can answer "why is this a minute".
    expect(attempt.durationSecs).toBe(47);
    expect(attempt.billedSecs).toBe(60);
    expect(attempt.billingIncrementSecs).toBe(60);
    expect(attempt.costCredits).toBe(toInternalCredits('1.00'));

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.credits).toBe(toInternalCredits('99'));
  });

  /** The ledger is what the money actually did, so it must carry the pulsed
   *  amount and not the pro-rata one it would have been. */
  it('writes the pulsed amount to the ledger, not the pro-rata one', async () => {
    const { attemptId } = await seed({ incrementSecs: 60 });

    await applyTerminalOutcome(outcome(attemptId, { durationSecs: 61 }));

    const row = await prisma.creditTransaction.findFirstOrThrow({
      where: { callAttemptId: attemptId, type: 'CALL_USAGE' },
    });

    // 61s rounds to 120s: two full minutes, not 1.0166.
    expect(row.amount).toBe(-toInternalCredits('2.00'));
  });

  it('bills to the second when the account is deliberately on an increment of one', async () => {
    const { attemptId } = await seed({ incrementSecs: 1 });

    await applyTerminalOutcome(outcome(attemptId, { durationSecs: 61 }));

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });

    expect(attempt.billedSecs).toBe(61);
    // 10000 × 61 / 60 = 10166.66…, truncated.
    expect(attempt.costCredits).toBe(10_166n);
  });

  /**
   * An attempt launched before this column existed. Those calls were billed
   * per second, and reading the null as anything else would charge a customer
   * a pulse they were never on — in the only window where the snapshot and
   * the current plan can legitimately disagree.
   */
  it('bills an attempt with no snapshot per second', async () => {
    const { attemptId } = await seed();

    await applyTerminalOutcome(outcome(attemptId, { durationSecs: 47 }));

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });

    expect(attempt.billingIncrementSecs).toBeNull();
    expect(attempt.billedSecs).toBe(47);
    // 10000 × 47 / 60 = 7833.33…, truncated.
    expect(attempt.costCredits).toBe(7_833n);
  });

  /** Unchanged by increments: `ceil(0 / n) * n` is 0 for every n, so there is
   *  nothing to charge and no ledger row to write — but `chargedAt` still
   *  stands, so a late delivery cannot charge it afterwards. */
  it('leaves a zero-duration call free and unledgered at any increment', async () => {
    const { attemptId, accountId } = await seed({ incrementSecs: 60 });

    await applyTerminalOutcome(outcome(attemptId, { durationSecs: 0 }));

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });

    expect(attempt.billedSecs).toBe(0);
    expect(attempt.costCredits).toBe(0n);
    expect(attempt.chargedAt).not.toBeNull();
    expect(
      await prisma.creditTransaction.count({ where: { callAttemptId: attemptId } }),
    ).toBe(0);
    expect(
      (await prisma.account.findUniqueOrThrow({ where: { id: accountId } })).credits,
    ).toBe(toInternalCredits('100'));
  });

  /**
   * A shortfall records what was OWED, and the pulse decides that figure too.
   * Nothing is debited, so the balance is untouched.
   */
  it('records the pulsed amount as what was owed on a shortfall', async () => {
    const { attemptId, accountId } = await seed({ incrementSecs: 60, credits: '0.5' });

    await applyTerminalOutcome(outcome(attemptId, { durationSecs: 47 }));

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });

    expect(attempt.shortfall).toBe(true);
    expect(attempt.billedSecs).toBe(60);
    expect(attempt.costCredits).toBe(toInternalCredits('1.00'));
    expect(
      (await prisma.account.findUniqueOrThrow({ where: { id: accountId } })).credits,
    ).toBe(toInternalCredits('0.5'));
  });

  /** The invariants the design states, on a row the service actually wrote. */
  it('leaves every charge row billing at least the call, in whole pulses', async () => {
    for (const [increment, duration] of [[15, 7], [30, 31], [60, 60], [600, 601]] as const) {
      const { attemptId } = await seed({ incrementSecs: increment });

      await applyTerminalOutcome(outcome(attemptId, { durationSecs: duration }));

      const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });

      expect(attempt.billedSecs).toBeGreaterThanOrEqual(attempt.durationSecs!);
      expect(attempt.billedSecs! % attempt.billingIncrementSecs!).toBe(0);
    }
  });
});

describe('an outcome that means nobody was spoken to', () => {
  it.each([
    ['no_answer', { status: 'no_answer', disposition: 'no_answer', answeredBy: 'not_answered' }],
    ['busy', { status: 'busy', disposition: 'busy', answeredBy: null }],
    ['voicemail', { status: 'completed', disposition: 'voicemail', answeredBy: 'machine' }],
    [
      'a hangup with no speech',
      { status: 'completed', disposition: 'user_hangup_no_speech', answeredBy: 'human' },
    ],
    ['an answering machine', { status: 'completed', disposition: 'completed', answeredBy: 'machine' }],
  ])('puts the contact back on the queue after %s', async (_name, over) => {
    const { attemptId, contactId } = await seed({ retryCount: 2, attempts: 0 });

    await applyTerminalOutcome(outcome(attemptId, over));

    const contact = await contactRow(contactId);
    expect(contact.status).toBe('PENDING');
    expect(contact.attempts).toBe(1);
  });
});

describe('the retry ladder', () => {
  it('waits the first ladder entry before the first retry', async () => {
    const { attemptId, contactId } = await seed({
      retryCount: 3,
      cooldownMinutes: 30,
      retryDelaysMinutes: [5, 45],
      attempts: 0,
    });

    await applyTerminalOutcome(outcome(attemptId, { status: 'no_answer', disposition: 'no_answer', answeredBy: 'not_answered' }));

    expect(minutesAway((await contactRow(contactId)).nextEligibleAt)).toBe(5);
  });

  it('waits the second entry before the second retry', async () => {
    const { attemptId, contactId } = await seed({
      retryCount: 3,
      cooldownMinutes: 30,
      retryDelaysMinutes: [5, 45],
      attempts: 1,
    });

    await applyTerminalOutcome(outcome(attemptId, { status: 'busy', disposition: 'busy', answeredBy: null }));

    expect(minutesAway((await contactRow(contactId)).nextEligibleAt)).toBe(45);
    expect((await contactRow(contactId)).attempts).toBe(2);
  });

  /** A ladder shorter than the retry budget is normal — the entries that run
   *  out fall back to the campaign's cooldown. */
  it('falls back to the cooldown once the ladder runs out', async () => {
    const { attemptId, contactId } = await seed({
      retryCount: 3,
      cooldownMinutes: 30,
      retryDelaysMinutes: [5, 45],
      attempts: 2,
    });

    await applyTerminalOutcome(outcome(attemptId, { status: 'busy', disposition: 'busy', answeredBy: null }));

    expect(minutesAway((await contactRow(contactId)).nextEligibleAt)).toBe(30);
  });

  it('reads the budget off the campaign as it is now, not as it was at dial time', async () => {
    const { attemptId, contactId, campaignId } = await seed({ retryCount: 5, attempts: 1 });

    // The operator lowers the budget while the call is still up.
    await prisma.campaign.update({ where: { id: campaignId }, data: { retryCount: 1 } });

    await applyTerminalOutcome(outcome(attemptId, { status: 'no_answer', disposition: 'no_answer', answeredBy: 'not_answered' }));

    const contact = await contactRow(contactId);
    expect(contact.status).toBe('FAILED');
    expect(contact.attempts).toBe(1);
  });

  it('settles the contact when the last retry is spent', async () => {
    const { attemptId, contactId, campaignId } = await seed({ retryCount: 2, attempts: 2 });

    await applyTerminalOutcome(outcome(attemptId, { status: 'no_answer', disposition: 'no_answer', answeredBy: 'not_answered' }));

    const contact = await contactRow(contactId);
    expect(contact.status).toBe('FAILED');
    expect((await campaignRow(campaignId)).failedCount).toBe(1);
  });

  it('never retries a campaign that allows none', async () => {
    const { attemptId, contactId } = await seed({ retryCount: 0, attempts: 0 });

    await applyTerminalOutcome(outcome(attemptId, { status: 'busy', disposition: 'busy', answeredBy: null }));

    expect((await contactRow(contactId)).status).toBe('FAILED');
  });
});

describe('outcomes that are never retried', () => {
  it('settles a blocked call however it was answered', async () => {
    const { attemptId, contactId, campaignId } = await seed({ retryCount: 5, attempts: 0 });

    await applyTerminalOutcome(
      outcome(attemptId, { status: 'completed', disposition: 'blocked', answeredBy: 'machine' }),
    );

    const contact = await contactRow(contactId);
    expect(contact.status).toBe('FAILED');
    expect(contact.attempts).toBe(0);
    expect((await campaignRow(campaignId)).failedCount).toBe(1);
  });

  it('settles a failed call the carrier blames on the number', async () => {
    const { attemptId, contactId, campaignId } = await seed({ retryCount: 5, attempts: 0 });

    await applyTerminalOutcome(
      outcome(attemptId, {
        status: 'failed',
        disposition: 'failed',
        answeredBy: null,
        // Q.850 1 — unallocated number. It will not complete on a later try.
        hangupCause: '1 - Unallocated number',
      }),
    );

    const contact = await contactRow(contactId);
    expect(contact.status).toBe('FAILED');
    expect(contact.attempts).toBe(0);
    expect((await campaignRow(campaignId)).failedCount).toBe(1);
  });

  /**
   * The regression this rule was rewritten for. An unstable platform returns
   * `failed` with a normal-clearing cause, and settling on that took live
   * contacts off the list at attempt 1 of 21.
   */
  it('keeps a failed call on the ladder when the carrier cleared it normally', async () => {
    const { attemptId, contactId, campaignId } = await seed({ retryCount: 5, attempts: 0 });

    await applyTerminalOutcome(
      outcome(attemptId, {
        status: 'failed',
        disposition: 'failed',
        answeredBy: null,
        hangupCause: '16 - Normal Clearing',
      }),
    );

    const contact = await contactRow(contactId);
    expect(contact.status).toBe('PENDING');
    expect(contact.attempts).toBe(1);
    expect((await campaignRow(campaignId)).failedCount).toBe(0);
  });

  it('keeps a failed call on the ladder when no cause was reported at all', async () => {
    const { attemptId, contactId } = await seed({ retryCount: 5, attempts: 0 });

    await applyTerminalOutcome(
      outcome(attemptId, { status: 'failed', disposition: 'failed', answeredBy: null }),
    );

    expect((await contactRow(contactId)).status).toBe('PENDING');
  });
});

describe('a real conversation', () => {
  it('completes the contact and counts it', async () => {
    const { attemptId, contactId, campaignId } = await seed({ retryCount: 5 });

    await applyTerminalOutcome(settling(attemptId));

    const contact = await contactRow(contactId);
    expect(contact.status).toBe('COMPLETED');
    expect(contact.attempts).toBe(0);

    const campaign = await campaignRow(campaignId);
    expect(campaign.completedCount).toBe(1);
    expect(campaign.failedCount).toBe(0);
  });
});

describe('what the contact carries away from the call', () => {
  it('copies the disposition and answered-by, lowercased', async () => {
    const { attemptId, contactId } = await seed();

    await applyTerminalOutcome(
      outcome(attemptId, { status: 'completed', disposition: 'Transferred', answeredBy: 'HUMAN' }),
    );

    const contact = await contactRow(contactId);
    expect(contact.disposition).toBe('transferred');
    expect(contact.answeredBy).toBe('human');
  });

  /** The attempt row is the record of what the platform actually said. */
  it('keeps the platform’s own wording on the attempt', async () => {
    const { attemptId } = await seed();

    await applyTerminalOutcome(outcome(attemptId, { disposition: 'Carrier_Rejected_XYZ' }));

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.disposition).toBe('Carrier_Rejected_XYZ');
    expect(attempt.resolvedAt).not.toBeNull();
  });

  it('records the session the outcome came from', async () => {
    const { attemptId, contactId, sessionId } = await seed();

    await applyTerminalOutcome(outcome(attemptId));

    expect((await contactRow(contactId)).lastSessionId).toBe(sessionId);
  });
});

describe('a promised callback the retry must not destroy', () => {
  /**
   * A retry moves the clock and leaves `callbackAt` standing as history —
   * moving it too would honour a promise at the cooldown, and clearing it
   * would erase that one was ever made. The arm moves the other way: this
   * contact is on the ladder now, whatever it was waiting for before.
   */
  it('moves the eligibility and leaves the promise behind as history', async () => {
    const promised = new Date(Date.now() + 3 * 3_600_000);
    const { attemptId, contactId } = await seed({
      retryCount: 3,
      cooldownMinutes: 30,
      attempts: 0,
      armKind: 'CALLBACK',
      callbackAt: promised,
      nextEligibleAt: promised,
    });

    await applyTerminalOutcome(outcome(attemptId, { status: 'no_answer', disposition: 'no_answer', answeredBy: 'not_answered' }));

    const contact = await contactRow(contactId);
    expect(contact.callbackAt?.toISOString()).toBe(promised.toISOString());
    expect(minutesAway(contact.nextEligibleAt)).toBe(30);
    expect(contact.armKind).toBe('RETRY');
  });

  /**
   * INVERTED on 2026-09-09, and the inversion is the whole of the two-lane
   * change in one case.
   *
   * A contact the engine followed up has been ANSWERED, and a follow-up that
   * goes to voicemail is a MISSED FOLLOW-UP, not a retry: it stays in the
   * follow-up lane, spends a follow-up, and waits `followUpDelayHours`. Its
   * three retries are not spendable — they were forfeited by the first answer
   * — so `attempts` does not move either.
   *
   * It used to be taken back onto the retry ladder, on the argument that the
   * ladder set the clock. That was right while there was one budget; it is
   * wrong now, and it was the shape of the complaint this wave answers, since
   * a person who had a partial conversation was then redialled on the same
   * minutes ladder as a number that never picked up.
   */
  it('keeps a followed-up contact in the follow-up lane when the follow-up goes unanswered', async () => {
    const { attemptId, contactId } = await seed({
      retryCount: 3,
      cooldownMinutes: 30,
      attempts: 0,
      armKind: 'FOLLOW_UP',
      maxGoalFollowUps: 3,
      // The dial under test is #3: the conversation on #1 is an EARLIER
      // attempt, which is what the lane is decided from.
      attemptNo: 3,
    });
    await prisma.campaignContact.update({
      where: { id: contactId },
      data: { followUpCount: 2 },
    });
    // The evidence that somebody answered: an earlier dial that was a
    // conversation. The lane is decided by this, never by `followUpCount`.
    await prisma.campaignContactGoal.create({
      data: {
        campaignContactId: contactId,
        attemptLog: [
          { attemptNo: 1, kind: 'fresh', status: 'completed', disposition: 'completed', answeredBy: 'human' },
        ] as unknown as Prisma.InputJsonValue,
      },
    });

    await applyTerminalOutcome(outcome(attemptId, { status: 'no_answer', disposition: 'no_answer', answeredBy: 'not_answered' }));

    const contact = await contactRow(contactId);
    expect(contact.armKind).toBe('FOLLOW_UP');
    // The missed follow-up spends a follow-up, and no retry.
    expect(contact.followUpCount).toBe(3);
    expect(contact.attempts).toBe(0);
    expect(minutesAway(contact.nextEligibleAt)).toBe(24 * 60);
  });
});

/**
 * The other half of the rule. A retry must not destroy a promise, and a
 * *settlement* must not leave one live: the promise has been kept, or it has
 * definitively failed, and either way nobody is owed a call any more.
 *
 * Clearing the clock is what ends it. The arm is deliberately left standing —
 * every reader of it pairs it with `status = 'PENDING'`, which a settle has
 * just made false, so a settled row carrying `CALLBACK` is history rather than
 * a promise the journey, the contacts list or the stats tile could act on.
 */
describe('a callback dial that settles', () => {
  it('disarms the promise it just kept', async () => {
    const promised = new Date(Date.now() - 60_000);
    const { attemptId, contactId } = await seed({
      retryCount: 3,
      attempts: 0,
      armKind: 'CALLBACK',
      callbackAt: promised,
      nextEligibleAt: promised,
    });

    await applyTerminalOutcome(settling(attemptId));

    const contact = await contactRow(contactId);
    expect(contact.status).toBe('COMPLETED');
    expect(contact.nextEligibleAt).toBeNull();
    // The promise itself stays, as history: it was made, and it was kept.
    expect(contact.callbackAt?.toISOString()).toBe(promised.toISOString());
  });

  it('disarms it when the call definitively failed as well', async () => {
    const promised = new Date(Date.now() - 60_000);
    const { attemptId, contactId } = await seed({
      retryCount: 5,
      attempts: 0,
      armKind: 'CALLBACK',
      callbackAt: promised,
      nextEligibleAt: promised,
    });

    await applyTerminalOutcome(outcome(attemptId, { disposition: 'blocked' }));

    const contact = await contactRow(contactId);
    expect(contact.status).toBe('FAILED');
    expect(contact.nextEligibleAt).toBeNull();
    expect(contact.callbackAt?.toISOString()).toBe(promised.toISOString());
  });
});

describe('a race this resolution lost', () => {
  it('writes nothing when the contact has already left the queue', async () => {
    const { attemptId, contactId, campaignId } = await seed({
      retryCount: 3,
      attempts: 1,
      contactStatus: 'PENDING',
    });

    await applyTerminalOutcome(outcome(attemptId, { status: 'no_answer', disposition: 'no_answer', answeredBy: 'not_answered' }));

    const contact = await contactRow(contactId);
    expect(contact.status).toBe('PENDING');
    // Neither the retry nor the counters: a lost race must not deflate either.
    expect(contact.attempts).toBe(1);
    expect(contact.nextEligibleAt).toBeNull();

    const campaign = await campaignRow(campaignId);
    expect(campaign.completedCount).toBe(0);
    expect(campaign.failedCount).toBe(0);
  });

  /**
   * A late delivery for a call that has already been superseded: the contact
   * was given back, re-claimed, and is being dialled again right now.
   */
  it('writes nothing when a newer dial has already been placed', async () => {
    const { attemptId, contactId, campaignId } = await seed({ retryCount: 3, attempts: 1 });

    const contact = await contactRow(contactId);
    await prisma.callAttempt.create({
      data: {
        campaignId,
        campaignContactId: contact.id,
        workspaceId: (await campaignRow(campaignId)).workspaceId,
        accountId: (await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
          .accountId,
        attemptNo: contact.attempts + 5,
        status: 'IN_PROGRESS',
      },
    });

    await applyTerminalOutcome(outcome(attemptId, { status: 'no_answer', disposition: 'no_answer', answeredBy: 'not_answered' }));

    const after = await contactRow(contactId);
    expect(after.status).toBe('QUEUED');
    expect(after.attempts).toBe(1);
    expect((await campaignRow(campaignId)).failedCount).toBe(0);
  });

  it('still charges for the minutes it lost the race over', async () => {
    const { attemptId, accountId } = await seed({ contactStatus: 'PENDING' });

    await applyTerminalOutcome(outcome(attemptId, { durationSecs: 60 }));

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.credits).toBe(toInternalCredits('99'));
  });
});

describe('an outcome we never heard from the platform', () => {
  /** A reaper timeout or a launch that failed. It is not a disposition, and it
   *  is retried like any other silence — but it can never be a success. */
  it('retries an internal failure while the budget lasts', async () => {
    const { attemptId, contactId } = await seed({ retryCount: 2, attempts: 0 });

    await applyTerminalOutcome(
      outcome(attemptId, {
        status: 'completed',
        disposition: null,
        answeredBy: null,
        failureReason: 'No outcome was ever reported for this call.',
      }),
    );

    expect((await contactRow(contactId)).status).toBe('PENDING');
  });

  it('fails the contact once the budget is gone', async () => {
    const { attemptId, contactId, campaignId } = await seed({ retryCount: 1, attempts: 1 });

    await applyTerminalOutcome(
      outcome(attemptId, {
        status: 'completed',
        disposition: null,
        answeredBy: null,
        failureReason: 'No outcome was ever reported for this call.',
      }),
    );

    expect((await contactRow(contactId)).status).toBe('FAILED');
    expect((await campaignRow(campaignId)).failedCount).toBe(1);
  });
});

describe('a balance that cannot cover the call', () => {
  /**
   * Its own status rather than PAUSED: the operator did not stop this campaign,
   * the balance did, and `resume` has to know to re-run the estimate.
   */
  it('leaves the campaign credit-exhausted', async () => {
    const { attemptId, campaignId } = await seed({ credits: '0.5' });

    await applyTerminalOutcome(outcome(attemptId, { durationSecs: 120 }));

    const campaign = await campaignRow(campaignId);
    expect(campaign.status).toBe('CREDIT_EXHAUSTED');
    expect(campaign.pausedAt).not.toBeNull();
  });
});

describe('a campaign deleted while the call was still up', () => {
  it('charges for the minutes and moves no queue entry', async () => {
    const { attemptId, accountId, campaignId } = await seed();

    await prisma.campaign.delete({ where: { id: campaignId } });

    await expect(applyTerminalOutcome(outcome(attemptId, { durationSecs: 60 }))).resolves.toBe(
      'applied',
    );

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.credits).toBe(toInternalCredits('99'));
  });
});

/**
 * The window the two existing guards leave open.
 *
 * The contact is pinned on being claimed (`QUEUED`) and on no attempt being
 * numbered above this one — which together read as "nothing has been dialled
 * since". Between a re-claim and the insert of that dial's attempt row, both
 * are true of the *previous* dial as well: the contact is `QUEUED` again, and
 * the row that would outrank this one does not exist yet. A delivery arriving
 * in those milliseconds would apply an outcome that belongs to a call already
 * over onto the call replacing it.
 *
 * The attempt row is the thing that is unique per dial, so it carries the pin:
 * `resolvedAt` is stamped when an outcome is applied, and an attempt already
 * carrying one has had its say about the contact.
 */
describe('a delivery for a dial whose outcome was already applied', () => {
  it('never moves the contact that a later dial has since claimed', async () => {
    const { attemptId, contactId, campaignId, accountId } = await seed({
      retryCount: 3,
      attempts: 0,
    });

    // The reaper got there first: it closed this attempt and put the contact
    // back on the queue.
    await prisma.callAttempt.update({
      where: { id: attemptId },
      data: { status: 'ABANDONED', endedAt: new Date(), resolvedAt: new Date() },
    });
    // The contact has since been re-claimed, and the attempt row for that new
    // dial has not been written yet. This is the window.
    await prisma.campaignContact.update({
      where: { id: contactId },
      data: { status: 'QUEUED', attempts: 1, lastAttemptAt: new Date() },
    });

    // The platform's own webhook for the *old* call, arriving late.
    await expect(applyTerminalOutcome(outcome(attemptId, { durationSecs: 60 }))).resolves.toBe(
      'applied',
    );

    const contact = await contactRow(contactId);
    expect(contact.status).toBe('QUEUED');
    expect(contact.attempts).toBe(1);
    expect((await campaignRow(campaignId)).completedCount).toBe(0);

    // The minutes were real, and are billed either way. Refusing the queue
    // move is not refusing the bill.
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.credits).toBe(toInternalCredits('99'));
    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.chargedAt).not.toBeNull();
  });

  /** The ordinary case is untouched: an unresolved attempt still resolves. */
  it('still moves the contact for the dial that is actually live', async () => {
    const { attemptId, contactId } = await seed({ retryCount: 3, attempts: 0 });

    await applyTerminalOutcome(settling(attemptId));

    expect((await contactRow(contactId)).status).toBe('COMPLETED');
  });
});

/**
 * ## The lock order, asserted rather than reasoned about
 *
 * Every writer that touches a campaign and its contacts in one transaction
 * takes the **campaign row first**: stop, complete, delete, top-up, the
 * retry-budget sweep, the dispatcher's completion pass, the callback re-arm.
 * A resolution that wrote the contact first and then the campaign held those
 * two locks in the opposite order, and two transactions holding one lock each
 * while waiting for the other is a deadlock — Postgres resolves it by killing
 * one of them, which here means a webhook 500ing and a charge rolled back.
 *
 * The interleaving below is that deadlock, disarmed: the probe asks for the
 * contact row with `NOWAIT` instead of waiting, so "the resolver is already
 * holding the contact row while it waits for the campaign" comes back as an
 * immediate error rather than as a killed transaction a second later.
 */
describe('the order this resolution takes its locks in', () => {
  const settle = (tx: Prisma.TransactionClient, s: Seeded) =>
    resolveContact(tx, {
      campaignId: s.campaignId,
      campaignContactId: s.contactId,
      attemptNo: 1,
      sessionId: s.sessionId,
      disposition: 'completed',
      answeredBy: 'human',
      retryable: false,
      permanent: false,
      // The note that ends the conversation: without one this settle is a
      // follow-up, which re-arms the contact rather than settling it — and
      // this describe is about the ORDER of the two writes, not about which
      // branch takes them.
      extraction: COMPLETED as unknown as Prisma.JsonObject,
      now: new Date(),
    });

  /** Waits until some backend on this database is parked on a lock. */
  async function untilSomethingBlocks(): Promise<void> {
    const deadline = Date.now() + 5_000;

    while (Date.now() < deadline) {
      const [row] = await prisma.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*)::bigint AS waiting FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND datname = current_database()`;

      if (Number(row?.waiting ?? 0) > 0) return;

      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it('takes the campaign lock before it writes the contact', async () => {
    const s = await seed();

    let lockTaken!: () => void;
    const holding = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });

    let probeNow!: () => void;
    const probeGate = new Promise<void>((resolve) => {
      probeNow = resolve;
    });

    const probe: { ok: boolean; error: unknown } = { ok: false, error: null };

    // Somebody else — a delete, a stop, the completion pass — holding the
    // campaign row.
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${s.campaignId} FOR UPDATE`;
        lockTaken();
        await probeGate;

        try {
          await tx.$queryRaw`SELECT id FROM "CampaignContact" WHERE id = ${s.contactId} FOR UPDATE NOWAIT`;
          probe.ok = true;
        } catch (err) {
          probe.error = err;
        }
      },
      { timeout: 30_000, maxWait: 30_000 },
    );

    await holding;

    const resolver = prisma.$transaction((tx) => settle(tx, s), {
      timeout: 30_000,
      maxWait: 30_000,
    });

    await untilSomethingBlocks();
    probeNow();

    await holder;
    await resolver;

    // The resolver must be parked on the *campaign* lock with the contact row
    // still free. Holding the contact row here is the wrong order, and the
    // deadlock this test exists to refuse.
    expect(probe.error).toBeNull();
    expect(probe.ok).toBe(true);

    // And it still settles once the campaign row is released.
    expect((await contactRow(s.contactId)).status).toBe('COMPLETED');
    expect((await campaignRow(s.campaignId)).completedCount).toBe(1);
  });

  /** The lock is re-entrant within one transaction, so the callers that
   *  already hold it — every one of them, today — are unaffected. */
  it('settles inside a transaction that already holds the campaign lock', async () => {
    const s = await seed();

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${s.campaignId} FOR UPDATE`;

      await expect(settle(tx, s)).resolves.toBe('completed');
    });

    expect((await contactRow(s.contactId)).status).toBe('COMPLETED');
    expect((await campaignRow(s.campaignId)).completedCount).toBe(1);
  });
});

/**
 * An outcome the PLATFORM decided, carried on `error_code`.
 *
 * `hangup_cause` set and `error_code` null means the carrier decided and the
 * disposition is to be trusted. `error_code` set and `hangup_cause` null means
 * the platform ended the attempt before the carrier ever tested the number —
 * reaped pre-connect, never handed to the carrier, dismissed by an operator.
 * Not the contact's fault, so it is handed back exactly as a launch that never
 * left is: back on the queue, the ladder untouched, the arming preserved.
 */
describe('an outcome the platform decided, not the carrier', () => {
  const platformFault = (attemptId: string, errorCode = 'PENDING_TIMEOUT') =>
    outcome(attemptId, {
      status: 'failed',
      disposition: 'failed',
      answeredBy: null,
      durationSecs: 0,
      errorCode,
      errorMessage: 'Session reaped before connect',
    });

  it('returns the contact to the queue without spending a retry', async () => {
    const { attemptId, contactId } = await seed({
      retryCount: 2,
      cooldownMinutes: 30,
      attempts: 1,
      armKind: 'RETRY',
    });

    expect(await applyTerminalOutcome(platformFault(attemptId))).toBe('applied');

    const contact = await contactRow(contactId);
    expect(contact.status).toBe('PENDING');
    expect(contact.attempts).toBe(1);
    expect(contact.armKind).toBe('RETRY');
    expect(minutesAway(contact.nextEligibleAt)).toBe(30);
  });

  it('keeps the code and the message on the attempt, so the journey can say why', async () => {
    const { attemptId } = await seed();

    await applyTerminalOutcome(platformFault(attemptId, 'DIAL_TRANSPORT_FAILURE'));

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.errorCode).toBe('DIAL_TRANSPORT_FAILURE');
    expect(attempt.errorMessage).toBe('Session reaped before connect');
    expect(attempt.status).toBe('FAILED');
    expect(attempt.resolvedAt).not.toBeNull();
    expect(attempt.chargedAt).not.toBeNull();
  });

  it('never settles the contact, even when a stray cause blames the number', async () => {
    const { attemptId, contactId, campaignId } = await seed({ retryCount: 2, attempts: 0 });

    await applyTerminalOutcome(
      outcome(attemptId, {
        status: 'failed',
        disposition: 'failed',
        answeredBy: null,
        hangupCause: '1 - Unallocated (unassigned) number',
        errorCode: 'ADMIN_DISMISSED',
      }),
    );

    expect((await contactRow(contactId)).status).toBe('PENDING');
    expect((await campaignRow(campaignId)).failedCount).toBe(0);
  });

  it('never settles the contact at the end of the ladder either', async () => {
    // Every retry consumed and this dial at the ceiling: a silence here would
    // settle. A platform fault is not a silence — the number was not tested.
    const { attemptId, contactId, campaignId } = await seed({ retryCount: 1, attempts: 1, attemptNo: 2 });

    await applyTerminalOutcome(platformFault(attemptId));

    const contact = await contactRow(contactId);
    expect(contact.status).toBe('PENDING');
    expect(contact.attempts).toBe(1);
    expect((await campaignRow(campaignId)).failedCount).toBe(0);
  });

  it('does not count against the dial budget', async () => {
    const { attemptId, contactId } = await seed({ retryCount: 1, attempts: 1, attemptNo: 2 });

    await applyTerminalOutcome(platformFault(attemptId));

    expect(await dialBudgetSpent(prisma, contactId, 2)).toBe(false);
  });

  it('counts a dial the platform ended AFTER a person was on the line: that one was placed', async () => {
    // `ADMIN_DISMISSED` on a session that hung after the conversation. The
    // classifier reads it as a conversation, and the budget must agree, or the
    // contact gets one dial more than the retry panel allows.
    const { attemptId, contactId } = await seed({ retryCount: 1, attempts: 1, attemptNo: 2 });

    await applyTerminalOutcome(
      outcome(attemptId, {
        status: 'completed',
        disposition: 'no_answer',
        answeredBy: 'human',
        durationSecs: 90,
        errorCode: 'ADMIN_DISMISSED',
      }),
    );

    expect(await dialBudgetSpent(prisma, contactId, 2)).toBe(true);
  });

  it('leaves the goal record alone: the last-call line still describes the last real call', async () => {
    const { attemptId, contactId } = await seed({ retryCount: 2, attempts: 1, attemptNo: 2 });
    await prisma.campaignContactGoal.create({
      data: {
        campaignContactId: contactId,
        lastCallNote: 'spoke, worth calling again',
        memory: 'Asked about pricing',
        memoryAttempt: 1,
        attemptLog: [{ attemptNo: 1, kind: 'fresh', status: 'completed', disposition: 'completed', answeredBy: 'human', outcome: 'incomplete', reason: null, callbackType: null, callbackRequestedTime: null, immediateCallbackNeeded: null, immediateCallbackReason: null }],
      },
    });

    await applyTerminalOutcome(platformFault(attemptId));

    const goal = await prisma.campaignContactGoal.findUniqueOrThrow({ where: { campaignContactId: contactId } });
    expect(goal.lastCallNote).toBe('spoke, worth calling again');
    expect(goal.attemptLog).toHaveLength(1);
  });

  it('treats an unrecognised code as a platform fault, never as permanent', async () => {
    const { attemptId, contactId } = await seed({ retryCount: 0, attempts: 0 });

    await applyTerminalOutcome(platformFault(attemptId, 'SOMETHING_NEW'));

    expect((await contactRow(contactId)).status).toBe('PENDING');
  });

  it('leaves an armed promise ahead of the backoff untouched', async () => {
    const promised = new Date(Date.now() + 3 * 60 * 60_000);
    const { attemptId, contactId } = await seed({
      cooldownMinutes: 30,
      armKind: 'CALLBACK',
      callbackAt: promised,
      nextEligibleAt: promised,
    });

    await applyTerminalOutcome(platformFault(attemptId));

    const contact = await contactRow(contactId);
    expect(contact.status).toBe('PENDING');
    expect(contact.armKind).toBe('CALLBACK');
    expect(contact.callbackAt).toEqual(promised);
    expect(contact.nextEligibleAt).toEqual(promised);
  });

  it('moves a promise the backoff would overrun, both columns together', async () => {
    const promised = new Date(Date.now() + 5 * 60_000);
    const { attemptId, contactId } = await seed({
      cooldownMinutes: 30,
      armKind: 'CALLBACK',
      callbackAt: promised,
      nextEligibleAt: promised,
    });

    await applyTerminalOutcome(platformFault(attemptId));

    const contact = await contactRow(contactId);
    expect(contact.status).toBe('PENDING');
    expect(contact.armKind).toBe('CALLBACK');
    expect(minutesAway(contact.nextEligibleAt)).toBe(30);
    expect(contact.callbackAt).toEqual(contact.nextEligibleAt);
  });

  it('still trusts the carrier when no code is carried', async () => {
    const { attemptId, contactId } = await seed({ retryCount: 2, attempts: 0 });

    await applyTerminalOutcome(
      outcome(attemptId, {
        status: 'failed',
        disposition: 'failed',
        answeredBy: null,
        hangupCause: '1 - Unallocated (unassigned) number',
        errorCode: null,
      }),
    );

    expect((await contactRow(contactId)).status).toBe('FAILED');
  });
});

/**
 * `TELEPHONY_CREDIT_EXHAUSTED`: the platform's OWN carrier account is dry.
 * Account-wide, never clears on its own, and nothing about this campaign or
 * this contact. The first occurrence pauses the campaign — no threshold, no
 * auto-resume — and the contact goes back whole.
 */
/**
 * The platform's `end_call_reason` reports the same fact `error_code` does,
 * through the field it actually emits: SYSTEM_ERROR beside nobody heard is the
 * platform ending a call the carrier never tested. The budget reads the two
 * signals as one, or a contact whose last ordinal was a platform fault is
 * handed back by the resolution and then refused by the claim forever.
 */
describe('a SYSTEM_ERROR silence in the dial budget', () => {
  const settled = (attemptId: string, over: Parameters<typeof outcome>[1] = {}) =>
    outcome(attemptId, {
      status: 'failed',
      disposition: 'failed',
      answeredBy: null,
      hangupCause: null,
      errorCode: null,
      durationSecs: 0,
      ...over,
    });

  it('is not counted: the number was never tested', async () => {
    const { attemptId, contactId } = await seed({ retryCount: 1, attempts: 1, attemptNo: 2 });

    await applyTerminalOutcome(settled(attemptId, { endCallReason: 'SYSTEM_ERROR' }));

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.endCallReason).toBe('SYSTEM_ERROR');
    expect(attempt.errorCode).toBeNull();
    expect(await dialBudgetSpent(prisma, contactId, 2)).toBe(false);
  });

  /**
   * Voicelink stamps `answered_by: human` only when the bot's worker completes
   * normally, so the teardown that yields SYSTEM_ERROR leaves it null on a
   * call a person answered. The completion's `answered_at` — or the row's
   * stamp from the IN_PROGRESS event — is the proof the number was tested.
   */
  it('IS counted when the carrier says the call was answered, whatever answered_by says', async () => {
    const { attemptId, contactId } = await seed({ retryCount: 1, attempts: 1, attemptNo: 2 });

    await applyTerminalOutcome(
      settled(attemptId, { endCallReason: 'SYSTEM_ERROR', answeredAt: '2026-09-15T10:00:00.000Z' }),
    );

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    // Persisted off the payload, so the budget reads the same evidence the settle did.
    expect(attempt.answeredAt).not.toBeNull();
    expect(await dialBudgetSpent(prisma, contactId, 2)).toBe(true);
  });

  it("IS counted off the row's own answer stamp when the payload carries none", async () => {
    const { attemptId, contactId } = await seed({ retryCount: 1, attempts: 1, attemptNo: 2 });
    await prisma.callAttempt.update({ where: { id: attemptId }, data: { answeredAt: new Date() } });

    await applyTerminalOutcome(settled(attemptId, { endCallReason: 'SYSTEM_ERROR' }));

    expect(await dialBudgetSpent(prisma, contactId, 2)).toBe(true);
  });

  it('IS counted when a person was on the line before the platform failed', async () => {
    const { attemptId, contactId } = await seed({ retryCount: 1, attempts: 1, attemptNo: 2 });

    await applyTerminalOutcome(
      settled(attemptId, {
        status: 'completed',
        disposition: 'completed',
        answeredBy: 'human',
        durationSecs: 90,
        endCallReason: 'SYSTEM_ERROR',
      }),
    );

    expect(await dialBudgetSpent(prisma, contactId, 2)).toBe(true);
  });

  /**
   * The row every pre-release silence left, and every reaper reconcile off a
   * detail without the field still leaves: no code, no reason, nobody
   * answered. It IS a dial — the carrier rang the number — and a clause that
   * negates a bare nullable equality would drop it from the count, re-arming
   * a retry past the cap.
   */
  it('counts an ordinary silence with neither signal on it', async () => {
    const { attemptId, contactId } = await seed({ retryCount: 1, attempts: 1, attemptNo: 2 });

    await applyTerminalOutcome(settled(attemptId, { status: 'no_answer', disposition: 'no_answer' }));

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.endCallReason).toBeNull();
    expect(attempt.errorCode).toBeNull();
    expect(attempt.answeredBy).toBeNull();
    expect(await dialBudgetSpent(prisma, contactId, 2)).toBe(true);
  });

  it('counts any other reason: NO_ANSWER is the carrier testing the number', async () => {
    const { attemptId, contactId } = await seed({ retryCount: 1, attempts: 1, attemptNo: 2 });

    await applyTerminalOutcome(settled(attemptId, { status: 'no_answer', disposition: 'no_answer', endCallReason: 'NO_ANSWER' }));

    expect(await dialBudgetSpent(prisma, contactId, 2)).toBe(true);
  });
});

describe('the platform out of telephony credit', () => {
  const dry = (attemptId: string) =>
    outcome(attemptId, {
      status: 'failed',
      disposition: 'failed',
      answeredBy: null,
      durationSecs: 0,
      errorCode: 'TELEPHONY_CREDIT_EXHAUSTED',
      errorMessage: 'Telephony credit exhausted',
    });

  it('pauses the campaign on the first occurrence and hands the contact back whole', async () => {
    const { attemptId, contactId, campaignId } = await seed({ attempts: 1 });

    await applyTerminalOutcome(dry(attemptId));

    const campaign = await campaignRow(campaignId);
    // PAUSED, never CREDIT_EXHAUSTED: that status means the CUSTOMER is out of
    // credit, and its page would send them to top up somebody else's bill.
    expect(campaign.status).toBe('PAUSED');
    expect(campaign.pausedAt).not.toBeNull();
    expect(campaign.haltReason).toContain('its own telephony account is out of credit');

    const contact = await contactRow(contactId);
    expect(contact.status).toBe('PENDING');
    expect(contact.attempts).toBe(1);
  });

  it('tells the admins why, in their own words, once', async () => {
    const first = await seed();
    await applyTerminalOutcome(dry(first.attemptId));
    await flushNotifications();

    const notes = await prisma.notification.findMany({
      where: { workspaceId: first.workspaceId, type: 'campaign.paused_platform_credit_exhausted' },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.scope).toBe('ADMINS_ONLY');
    expect(notes[0]!.body).toContain('voice platform');
    expect(notes[0]!.body).not.toContain('Vocobase');
    expect(notes[0]!.body).not.toContain('TELEPHONY_CREDIT_EXHAUSTED');
  });

  it('does not notify again for a second dial that hits the same wall', async () => {
    const { attemptId, campaignId, workspaceId, contactId } = await seed();
    await applyTerminalOutcome(dry(attemptId));

    // A second call of the same campaign, already in flight when the first
    // came back, ends the same way.
    const second = await prisma.callAttempt.create({
      data: {
        campaignId,
        campaignContactId: contactId,
        workspaceId,
        accountId: (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId }, include: { workspace: true } })).workspace.ownerAccountId,
        attemptNo: 2,
        status: 'IN_PROGRESS',
        upstreamCallId: `c_second_${attemptId}`,
        upstreamSessionId: `s_second_${attemptId}`,
      },
    });
    await prisma.campaignContact.update({ where: { id: contactId }, data: { status: 'QUEUED' } });
    await applyTerminalOutcome(dry(second.id));
    await flushNotifications();

    const notes = await prisma.notification.findMany({
      where: { workspaceId, type: 'campaign.paused_platform_credit_exhausted' },
    });
    expect(notes).toHaveLength(1);
    expect((await campaignRow(campaignId)).status).toBe('PAUSED');
  });
});

/**
 * The copy of the disposition on the CONTACT drives the outcome bar, the
 * `/stats` disposition groups and the contact-list badge. A cause-16
 * conversation labelled `no_answer` is settled as a conversation, and the
 * contact must say so, or the reached count and the outcome bar disagree on
 * exactly the population this rule exists for.
 */
describe('a never-connected label with a human on the line, on the contact', () => {
  it('carries `completed`, not the label the platform put on a conversation', async () => {
    const { attemptId, contactId } = await seed({ retryCount: 0 });

    await applyTerminalOutcome(
      outcome(attemptId, {
        status: 'no_answer',
        disposition: 'no_answer',
        answeredBy: 'human',
        hangupCause: '16 - Normal Clearing',
        durationSecs: 90,
      }),
    );

    const contact = await contactRow(contactId);
    expect(contact.status).toBe('COMPLETED');
    expect(contact.disposition).toBe('completed');
  });

  it('keeps the platform’s own label on the attempt row', async () => {
    const { attemptId } = await seed({ retryCount: 0 });

    await applyTerminalOutcome(
      outcome(attemptId, { status: 'no_answer', disposition: 'no_answer', answeredBy: 'human', durationSecs: 90 }),
    );

    expect((await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } })).disposition).toBe('no_answer');
  });
});
