import type { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The decision table in `resolveContact`, row by row, against the real
 * database.
 *
 * TWO LANES since 2026-09-09, and which one a contact is in is decided by
 * HISTORY rather than by this call: whether any attempt in the goal log ever
 * reached a person (`hasSpokenAttempt`). A number nobody has answered walks
 * the retry ladder on `retryCount`; a contact who HAS answered spends
 * `maxGoalFollowUps` and waits `followUpDelayHours`, and the retries it had
 * left are forfeited. So `seed` always writes a goal log — the caller records
 * this dial's own entry before resolving — and a case about the retry lane
 * says so by seeding a log with no conversation in it.
 *
 * The seeds still write the RETIRED columns, at deliberately misleading
 * values, because that is the only way to assert what the engine ignores: a
 * campaign stored `goalEnabled: false` follows up, a `maxTotalDials: 99` does
 * not buy a dial past `retryCount + maxGoalFollowUps + 1`, and an
 * `immediateCallbackMinutes: 90` does not move the fixed three-minute resume.
 */
vi.mock('../src/adapter/vocobase.js', () => ({
  startCall: vi.fn(),
  getConcurrency: vi.fn(),
  getCall: vi.fn(),
}));

const { resolveContact } = await import('../src/services/dialerOutcome.js');
const { prisma } = await import('../src/lib/prisma.js');
const { truncateAll } = await import('./setup.js');
const { makeAccount, makeAgent, makeWorkspace } = await import('./helpers.js');
const { env } = await import('../src/lib/env.js');

// The resume lane is off by default (`IMMEDIATE_RESUME_ENABLED`), because the
// model over-reports drops. Every test in this file that expects a RESUME is
// exercising the lane as designed, so it is switched on here; the block at
// the bottom pins what the default does instead.
env.immediateResumeEnabled = true;

const NOW = new Date('2026-08-30T10:00:00Z');
const HOUR = 3_600_000;

interface SeedOptions {
  /** The retired switch, written to the column and read by nothing. Set it to
   *  prove the engine ignores it. */
  goalEnabled?: boolean;
  /** Retired too: the absolute ceiling is derived, never read off this. */
  maxTotalDials?: number;
  /** The FOLLOW-UP lane's budget and wait — live again since 2026-09-09, and
   *  spent only by a contact somebody has already answered. */
  maxGoalFollowUps?: number;
  followUpDelayHours?: number;
  /** The RETRY lane's budget, spent only by a number nobody has reached, and
   *  the ladder that times it. */
  retryCount?: number;
  cooldownMinutes?: number;
  retryDelaysMinutes?: number[];
  /** The arm the contact is waiting under; the claim and the journey read it
   *  beside `status = 'PENDING'`. */
  armKind?: 'FRESH' | 'RETRY' | 'FOLLOW_UP' | 'RESUME' | 'CALLBACK';
  window?: { fromTime: string; toTime: string; timezone: string };
  followUpCount?: number;
  attempts?: number;
  attemptNo?: number;
  callbackAt?: Date | null;
  /** The context record earlier attempts left behind. */
  memory?: string;
  lastCallNote?: string;
  goalMissing?: string;
  attemptLog?: Record<string, unknown>[];
}

interface Seeded {
  accountId: string;
  workspaceId: string;
  campaignId: string;
  contactId: string;
  phone: string;
  /** The ordinal of the dial the resolution under test belongs to. */
  attemptNo: number;
}

let seq = 0;

async function seed(options: SeedOptions = {}): Promise<Seeded> {
  seq += 1;
  const account = await makeAccount(`gres${seq}${Math.random().toString(36).slice(2, 6)}`);
  const workspace = await makeWorkspace(account, 'Resolvers');
  const agent = await makeAgent(workspace, 'caller');

  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: workspace.id,
      name: 'Goals',
      agentId: agent.id,
      status: 'RUNNING',
      retryCount: options.retryCount ?? 2,
      cooldownMinutes: options.cooldownMinutes ?? 30,
      ...(options.retryDelaysMinutes === undefined
        ? {}
        : { retryDelaysMinutes: options.retryDelaysMinutes }),
      maxGoalFollowUps: options.maxGoalFollowUps ?? 2,
      followUpDelayHours: options.followUpDelayHours ?? 24,
      // Retired, and set to values that would change the answer of nearly
      // every case below if anything still read them.
      goalEnabled: options.goalEnabled ?? false,
      maxTotalDials: options.maxTotalDials ?? 99,
      immediateCallbackMinutes: 90,
      ...(options.window ?? {}),
    },
  });

  const phone = `+91900001${String(1000 + seq)}`;
  const contact = await prisma.contact.create({ data: { workspaceId: workspace.id, phone } });
  const link = await prisma.campaignContact.create({
    data: {
      campaignId: campaign.id,
      contactId: contact.id,
      status: 'QUEUED',
      attempts: options.attempts ?? 0,
      followUpCount: options.followUpCount ?? 0,
      callbackAt: options.callbackAt ?? null,
      ...(options.armKind === undefined ? {} : { armKind: options.armKind }),
    },
  });

  const attemptNo = options.attemptNo ?? 1;
  for (let n = 1; n <= attemptNo; n++) {
    await prisma.callAttempt.create({
      data: {
        campaignId: campaign.id,
        campaignContactId: link.id,
        workspaceId: workspace.id,
        accountId: account.id,
        attemptNo: n,
        status: n === attemptNo ? 'IN_PROGRESS' : 'COMPLETED',
      },
    });
  }

  /**
   * ALWAYS written, unlike before, because the log is now what decides the
   * lane and an absent row would put every case in the retry lane by default.
   * The caller records this dial's own entry before resolving, so the honest
   * default is a first call somebody answered — which is what all but the
   * retry-lane cases below are resolving. A case about a number nobody has
   * reached passes `attemptLog` with no conversation in it.
   */
  await prisma.campaignContactGoal.create({
    data: {
      campaignContactId: link.id,
      ...(options.memory === undefined ? {} : { memory: options.memory, memoryAttempt: 1 }),
      ...(options.lastCallNote === undefined ? {} : { lastCallNote: options.lastCallNote }),
      ...(options.goalMissing === undefined ? {} : { goalMissing: options.goalMissing }),
      attemptLog: (options.attemptLog ?? [
        { attemptNo: 1, kind: 'fresh', disposition: 'completed', answeredBy: 'human' },
      ]) as unknown as Prisma.InputJsonValue,
    },
  });

  return {
    accountId: account.id,
    workspaceId: workspace.id,
    campaignId: campaign.id,
    contactId: link.id,
    phone,
    attemptNo,
  };
}

/** The resolution every case starts from: this contact's latest dial, a
 *  connected conversation, carrying whatever the call extracted. */
function base(s: Seeded) {
  return {
    campaignId: s.campaignId,
    campaignContactId: s.contactId,
    attemptNo: s.attemptNo,
    sessionId: 's_1',
    disposition: 'completed' as string | null,
    answeredBy: 'human' as string | null,
    retryable: false,
    permanent: false,
    extraction: null as Prisma.JsonObject | null,
    now: NOW,
  };
}

function conversation(
  s: Seeded,
  extraction: Record<string, unknown> | null,
  over: Partial<Parameters<typeof resolveContact>[1]> = {},
) {
  return resolveContact(prisma, {
    ...base(s),
    extraction: extraction as Prisma.JsonObject | null,
    ...over,
  });
}

/**
 * The seven keys as the bot answers them; a case names only the fields it is
 * about, the rest are the "nothing to say" answers the descriptions ask for.
 *
 * `callbackType` is this helper's own convenience parameter, not a key any
 * more: contender I derives `CallNote.callbackType` from
 * `immediate_callback_needed` and `callback_requested_time`, so `'immediate'`
 * here writes `immediate_callback_needed_vocobaseplatform: 'yes'` and
 * `'requested'` writes a real, parseable `callback_requested_time`
 * (overridable through `over`, which is applied last).
 */
const said = (
  outcome: string | null,
  callbackType: 'requested' | 'immediate' | 'flexible' | 'null' | null = null,
  over: Record<string, unknown> = {},
) => ({
  call_outcome_vocobaseplatform: outcome ?? 'null',
  call_outcome_reason_vocobaseplatform: 'null',
  immediate_callback_needed_vocobaseplatform: callbackType === 'immediate' ? 'yes' : 'no',
  immediate_callback_needed_reason_vocobaseplatform: 'null',
  callback_requested_time_vocobaseplatform:
    callbackType === 'requested' ? '2026-09-08T17:00+05' : 'null',
  next_call_instructions_vocobaseplatform: 'Resume from where the call left off.',
  ...over,
});

const REASON = 'call_outcome_reason_vocobaseplatform';
const TIME = 'callback_requested_time_vocobaseplatform';

/** A dial nobody picked up: the classification the carrier's silence gets. */
const resolveSilence = (s: Seeded) =>
  conversation(s, null, {
    disposition: 'no_answer',
    answeredBy: null,
    retryable: true,
    permanent: false,
  });

/** A conversation that did not finish, at the callback type given. */
const resolveIncomplete = (s: Seeded, type: 'requested' | 'immediate' | 'flexible' | 'null') =>
  conversation(s, said('incomplete', type));

/**
 * Log entries as `recordAttempt` writes them: `status` is the UPSTREAM status,
 * which is where `no_answer` lives — as a disposition it means nothing to
 * `classifyOutcome` and a silence written that way reads as a conversation.
 */
const spoke = (attemptNo: number, kind: string) => ({
  attemptNo,
  kind,
  status: 'completed',
  disposition: 'completed',
  answeredBy: 'human',
});
const silent = (attemptNo: number, kind: string) => ({
  attemptNo,
  kind,
  status: 'no_answer',
  disposition: null,
  answeredBy: 'not_answered',
});

const contactRow = (id: string) => prisma.campaignContact.findUniqueOrThrow({ where: { id } });
const campaignRow = (id: string) => prisma.campaign.findUniqueOrThrow({ where: { id } });
const dncRow = (campaignId: string, phone: string) =>
  prisma.doNotCall.findUnique({ where: { campaignId_phone: { campaignId, phone } } });

beforeEach(async () => {
  await truncateAll();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await truncateAll();
  vi.restoreAllMocks();
});

/**
 * The two lanes.
 *
 * A contact is in exactly one of them and history decides which: a number
 * nobody has answered walks the RETRY ladder; a contact somebody has answered
 * is in the FOLLOW-UP lane for good, and the retries it had left are
 * forfeited. Nothing here reads `goalEnabled`, `maxTotalDials` or
 * `immediateCallbackMinutes`, all of which the seed sets to values that would
 * change these answers.
 */
describe('the two lanes', () => {
  const link = (s: Seeded) => contactRow(s.contactId);

  it('a silence on a contact nobody reached spends a retry on the ladder', async () => {
    const s = await seed({
      retryCount: 2,
      cooldownMinutes: 30,
      maxGoalFollowUps: 3,
      attemptLog: [silent(1, 'fresh')],
    });

    await resolveSilence(s);

    const row = await link(s);
    expect(row).toMatchObject({
      status: 'PENDING',
      armKind: 'RETRY',
      attempts: 1,
      followUpCount: 0,
    });
    // The ladder, not the follow-up hours: nobody has answered this number.
    expect(row.nextEligibleAt).toEqual(new Date(NOW.getTime() + 30 * 60_000));
  });

  it('an incomplete conversation spends a follow-up and waits the follow-up hours', async () => {
    const s = await seed({
      retryCount: 2,
      cooldownMinutes: 30,
      maxGoalFollowUps: 2,
      followUpDelayHours: 24,
    });

    await resolveIncomplete(s, 'flexible');

    const row = await link(s);
    expect(row).toMatchObject({
      status: 'PENDING',
      armKind: 'FOLLOW_UP',
      attempts: 0,
      followUpCount: 1,
    });
    expect(row.nextEligibleAt).toEqual(new Date(NOW.getTime() + 24 * HOUR));
  });

  it('a silence on a contact already reached is a follow-up, not a retry', async () => {
    const s = await seed({
      retryCount: 5,
      cooldownMinutes: 30,
      maxGoalFollowUps: 2,
      followUpDelayHours: 6,
      followUpCount: 1,
      armKind: 'FOLLOW_UP',
      attemptNo: 2,
      attemptLog: [spoke(1, 'fresh'), silent(2, 'follow_up')],
    });

    await resolveSilence(s);

    const row = await link(s);
    expect(row).toMatchObject({
      status: 'PENDING',
      armKind: 'FOLLOW_UP',
      // The retry counter is untouched: a missed follow-up spends a follow-up.
      attempts: 0,
      followUpCount: 2,
    });
    expect(row.nextEligibleAt).toEqual(new Date(NOW.getTime() + 6 * HOUR));
  });

  it('forfeits the retries once someone has answered: the follow-up budget alone bounds them', async () => {
    const s = await seed({
      retryCount: 5,
      maxGoalFollowUps: 1,
      followUpCount: 1,
      armKind: 'FOLLOW_UP',
      attemptNo: 2,
      attemptLog: [spoke(1, 'fresh'), silent(2, 'follow_up')],
    });

    await resolveSilence(s);

    // Five retries still on the campaign and not one of them is spendable.
    expect(await link(s)).toMatchObject({
      status: 'FAILED',
      goalAchieved: false,
      nextEligibleAt: null,
    });
  });

  it('zero follow-ups settles an incomplete conversation at once, not achieved', async () => {
    const s = await seed({ retryCount: 3, maxGoalFollowUps: 0 });

    await resolveIncomplete(s, 'flexible');

    expect(await link(s)).toMatchObject({
      status: 'COMPLETED',
      goalAchieved: false,
      followUpCount: 0,
    });
  });

  it('the last follow-up that is still incomplete settles COMPLETED, not achieved', async () => {
    const s = await seed({
      retryCount: 3,
      maxGoalFollowUps: 2,
      followUpCount: 2,
      armKind: 'FOLLOW_UP',
      attemptNo: 3,
      attemptLog: [spoke(1, 'fresh'), spoke(2, 'follow_up'), spoke(3, 'follow_up')],
    });

    await resolveIncomplete(s, 'flexible');

    // COMPLETED and not FAILED: they did talk to us, and the last dial was a
    // conversation.
    expect(await link(s)).toMatchObject({ status: 'COMPLETED', goalAchieved: false });
  });

  it('reads the follow-up budget off the campaign as it is now', async () => {
    const s = await seed({
      retryCount: 3,
      maxGoalFollowUps: 3,
      followUpCount: 1,
      armKind: 'FOLLOW_UP',
      attemptNo: 2,
      attemptLog: [spoke(1, 'fresh'), spoke(2, 'follow_up')],
    });

    // Lowering it mid-campaign has to stop a follow-up that has not been armed
    // yet, exactly as lowering `retryCount` stops a retry.
    await prisma.campaign.update({
      where: { id: s.campaignId },
      data: { maxGoalFollowUps: 1 },
    });

    await resolveIncomplete(s, 'flexible');

    expect(await link(s)).toMatchObject({ status: 'COMPLETED', goalAchieved: false });
  });

  it('a follow-up rolls into the dialing window', async () => {
    // Six hours after 10:00 UTC is 21:30 IST, outside a 09:00-18:00 IST
    // window: the re-arm lands at the next opening, not at night.
    const s = await seed({
      followUpDelayHours: 6,
      window: { fromTime: '09:00', toTime: '18:00', timezone: 'Asia/Kolkata' },
    });

    await resolveIncomplete(s, 'flexible');

    // 2026-08-31 09:00 IST = 03:30 UTC.
    expect((await link(s)).nextEligibleAt).toEqual(new Date('2026-08-31T03:30:00Z'));
  });
});

describe('the goal decision table', () => {
  it('completed settles COMPLETED, achieved, whatever the callback type says', async () => {
    for (const v of [said('completed'), said('completed', 'requested', { [TIME]: '2026-09-08T17:00+05' })]) {
      const s = await seed();

      expect(await conversation(s, v)).toBe('completed');

      const c = await contactRow(s.contactId);
      expect(c.status).toBe('COMPLETED');
      expect(c.goalAchieved).toBe(true);
      expect(c.followUpCount).toBe(0);
      expect(c.nextEligibleAt).toBeNull();
      expect(await dncRow(s.campaignId, s.phone)).toBeNull();
    }
  });

  it('stop settles COMPLETED, lists the number for this campaign only, and records not achieved', async () => {
    const s = await seed();
    // A second campaign in the same workspace, on the same number: the list is
    // the campaign's, so this one may still dial it.
    const other = await prisma.campaign.create({
      data: {
        workspaceId: s.workspaceId,
        name: 'Other',
        status: 'RUNNING',
        goalEnabled: true,
      },
    });

    expect(await conversation(s, said('stop'))).toBe('completed');

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('COMPLETED');
    expect(c.goalAchieved).toBe(false);
    expect(c.followUpCount).toBe(0);

    const listed = await dncRow(s.campaignId, s.phone);
    expect(listed).not.toBeNull();
    expect(listed!.sourceCampaignContactId).toBe(s.contactId);
    expect(listed!.reason).toBe('Asked not to be called again during a campaign call.');
    expect(await dncRow(other.id, s.phone)).toBeNull();
  });

  it('keeps the bot’s reason on the do-not-call row', async () => {
    const s = await seed();

    await conversation(s, said('stop', null, { [REASON]: 'already bought elsewhere' }));

    expect((await dncRow(s.campaignId, s.phone))!.reason).toBe('already bought elsewhere');
  });

  /** A stop is a stop whatever the callback type beside it says — a model
   *  that writes "requested" next to "stop" has still said stop. */
  it('a stop beside a requested callback still stops', async () => {
    const s = await seed();

    expect(await conversation(s, said('stop', 'requested', { [TIME]: '2026-09-08T17:00+05' }))).toBe(
      'completed',
    );

    expect((await contactRow(s.contactId)).status).toBe('COMPLETED');
    expect(await dncRow(s.campaignId, s.phone)).not.toBeNull();
  });

  it('incomplete + flexible re-arms on the follow-up wait and moves followUpCount only', async () => {
    const history = new Date('2026-08-29T15:00:00Z');
    const s = await seed({
      // The follow-up lane's own clock. The 30-minute cooldown beside it is
      // the RETRY ladder's, and this contact has answered: if the engine ever
      // times a follow-up off the ladder again, this case fails.
      followUpDelayHours: 4,
      cooldownMinutes: 30,
      callbackAt: history,
      window: { fromTime: '09:00', toTime: '18:00', timezone: 'Asia/Kolkata' },
    });

    expect(await conversation(s, said('incomplete', 'flexible', { [REASON]: 'busy' }))).toBe(
      'following_up',
    );

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('PENDING');
    expect(c.followUpCount).toBe(1);
    // A conversation waiting on its second half is still a FOLLOW_UP, whatever
    // clock set the wait — the queue tabs and the journey read the arm, and it
    // is what puts the contact ahead of the plain retries it shares a lane
    // with.
    expect(c.armKind).toBe('FOLLOW_UP');
    // The retry counter and the promise history are not this branch's to move.
    // `attempts` staying 0 is the forfeit made visible: the retries this
    // contact still had are unspendable now that somebody has answered.
    expect(c.attempts).toBe(0);
    expect(c.callbackAt).toEqual(history);
    expect(c.goalAchieved).toBeNull();
    // Four hours on: 14:00 UTC = 19:30 IST is outside 09:00-18:00, so the roll
    // takes it to the next opening rather than to the raw instant.
    expect(c.nextEligibleAt).toEqual(new Date('2026-08-31T03:30:00Z'));

    // Not settled: no counter moves.
    const campaign = await campaignRow(s.campaignId);
    expect(campaign.completedCount).toBe(0);
    expect(campaign.failedCount).toBe(0);
  });

  it('rolls a follow-up that would land outside dialing hours to the next opening', async () => {
    // A one-hour follow-up wait lands at 11:00 UTC = 16:30 IST, outside a
    // 09:00-11:00 IST window — the re-arm must land at the NEXT opening, not
    // mid-afternoon.
    const s = await seed({
      followUpDelayHours: 1,
      window: { fromTime: '09:00', toTime: '11:00', timezone: 'Asia/Kolkata' },
    });

    expect(await conversation(s, said('incomplete', 'flexible'))).toBe('following_up');

    // Next opening: 2026-08-31 09:00 IST = 03:30 UTC.
    expect((await contactRow(s.contactId)).nextEligibleAt).toEqual(
      new Date('2026-08-31T03:30:00Z'),
    );
  });

  it('incomplete + "null" callback type waits the follow-up hours like flexible', async () => {
    const s = await seed({ followUpDelayHours: 6 });

    expect(await conversation(s, said('incomplete', 'null'))).toBe('following_up');

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('PENDING');
    expect(c.followUpCount).toBe(1);
    expect(c.nextEligibleAt).toEqual(new Date(NOW.getTime() + 6 * HOUR));
  });

  /**
   * The ladder is the RETRY lane's clock and not the follow-up's, which is the
   * single sharpest difference this wave makes.
   *
   * It used to time both, indexed by the retry counter — which a follow-up
   * never moves, so a contact followed up four times waited the same rung
   * every time, and that rung is sized for a number that did not pick up. The
   * seed's ladder is [5, 90] and its cooldown 30, all three deliberately
   * unequal to the follow-up wait: none of them may appear in the answer.
   */
  it('a follow-up ignores the retry ladder however far up it the contact is', async () => {
    for (const attempts of [0, 1, 2]) {
      const s = await seed({
        retryDelaysMinutes: [5, 90],
        cooldownMinutes: 30,
        retryCount: 3,
        followUpDelayHours: 8,
        attempts,
        attemptNo: attempts + 1,
      });

      expect(await conversation(s, said('incomplete', 'flexible'))).toBe('following_up');
      expect((await contactRow(s.contactId)).nextEligibleAt).toEqual(
        new Date(NOW.getTime() + 8 * HOUR),
      );
    }
  });

  it('incomplete + requested re-arms at the follow-up wait; the booking moves it afterwards', async () => {
    const s = await seed({ followUpDelayHours: 12 });

    expect(
      await conversation(s, said('incomplete', 'requested', { [TIME]: '2026-09-08T17:00+05' })),
    ).toBe('following_up');

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('PENDING');
    expect(c.followUpCount).toBe(1);
    // Nothing here books the promise — the caller does, after this returns —
    // so the pair stays disarmed and the follow-up wait stands until it does.
    expect(c.callbackAt).toBeNull();
    expect(c.nextEligibleAt).toEqual(new Date(NOW.getTime() + 12 * HOUR));
  });

  /**
   * There is no `callback_type` key any more, so "requested but no time" is
   * no longer a shape the model can produce: `callbackType` is `'requested'`
   * only when `callback_requested_time` is itself a real, parseable value.
   * A time that does not parse — the model wrote something, but not a real
   * instant — reads as no time at all, `callbackType` derives `'flexible'`,
   * and the ladder's wait stands exactly as it does for a flexible note.
   */
  it('an unparseable requested time is read as flexible, and the follow-up wait stands', async () => {
    const s = await seed({ followUpDelayHours: 9 });

    expect(
      await conversation(s, said('incomplete', null, { [TIME]: 'sometime next week' })),
    ).toBe('following_up');

    const c = await contactRow(s.contactId);
    expect(c.callbackAt).toBeNull();
    expect(c.nextEligibleAt).toEqual(new Date(NOW.getTime() + 9 * HOUR));
  });

  /**
   * A drop mid-conversation resumes after the fixed three-minute gap, not the
   * follow-up hours every other re-arm waits — and it is armed `RESUME`,
   * which is what puts it in the resume lane.
   *
   * The lane is the point twice over. A dropped conversation is the most
   * time-sensitive dial the engine places — the person is still sitting there
   * — so it must not sort on `createdAt` behind whatever an import stamped
   * first. But it must not reach the front by pretending to be a promise
   * either: that lane draws from the whole pass budget, so a window of drops
   * claimed every slot a campaign had.
   *
   * And nothing writes `callbackAt`. That column is the record of a time a
   * person named, and every consumer of it — the journey's `callback_due`, the
   * contacts list's `callbackPending`, the stats tile — reads it as one.
   */
  it('incomplete + immediate re-arms on its own gap, in the resume lane', async () => {
    const s = await seed();

    expect(await conversation(s, said('incomplete', 'immediate'))).toBe('following_up');

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('PENDING');
    // The fixed three minutes — not the 30-minute cooldown a flexible waits,
    // and not the seed's stored `immediateCallbackMinutes` either.
    expect(c.nextEligibleAt).toEqual(new Date(NOW.getTime() + 3 * 60_000));
    expect(c.followUpCount).toBe(1);
    expect(c.attempts).toBe(0);
    expect(c.armKind).toBe('RESUME');
    // Nobody promised this call, so no promise is recorded.
    expect(c.callbackAt).toBeNull();
    expect(c.goalAchieved).toBeNull();

    const campaign = await campaignRow(s.campaignId);
    expect(campaign.completedCount).toBe(0);
    expect(campaign.failedCount).toBe(0);
  });

  /**
   * The same write, on a contact that was promised a call once and has since
   * been called back. `callbackAt` stands as the only record that a promise
   * was ever made, and the resume must not rewrite it — which is exactly what
   * arming the pair did.
   */
  it('leaves a kept promise standing when it re-arms a resume over it', async () => {
    const s = await seed();
    const kept = new Date(NOW.getTime() - 3 * HOUR);
    await prisma.campaignContact.update({
      where: { id: s.contactId },
      data: { callbackAt: kept, callbackCount: 1 },
    });

    expect(await conversation(s, said('incomplete', 'immediate'))).toBe('following_up');

    const c = await contactRow(s.contactId);
    expect(c.armKind).toBe('RESUME');
    expect(c.nextEligibleAt).toEqual(new Date(NOW.getTime() + 3 * 60_000));
    expect(c.callbackAt).toEqual(kept);
  });

  it('an immediate re-arm rolls into the dial window like any follow-up', async () => {
    // Three minutes after 10:00 UTC is 15:33 IST, outside a 09:00-11:00 IST
    // window: the next opening, not a call after hours.
    const s = await seed({ window: { fromTime: '09:00', toTime: '11:00', timezone: 'Asia/Kolkata' } });

    expect(await conversation(s, said('incomplete', 'immediate'))).toBe('following_up');

    expect((await contactRow(s.contactId)).nextEligibleAt).toEqual(
      new Date('2026-08-31T03:30:00Z'),
    );
  });

  it('no outcome is a follow-up on the follow-up wait, as flexible', async () => {
    const s = await seed({ followUpDelayHours: 3 });
    expect(await conversation(s, null)).toBe('following_up');
    const c = await contactRow(s.contactId);
    expect(c.followUpCount).toBe(1);
    expect(c.nextEligibleAt).toEqual(new Date(NOW.getTime() + 3 * HOUR));

    // An answer outside the pinned vocabulary reads as no outcome, not as a
    // guess at what the model might have meant.
    const t = await seed({ followUpDelayHours: 3 });
    expect(await conversation(t, { call_outcome_vocobaseplatform: 'ring me' })).toBe('following_up');
    expect((await contactRow(t.contactId)).nextEligibleAt).toEqual(
      new Date(NOW.getTime() + 3 * HOUR),
    );

    // The literal word "null" for the outcome is the same fact.
    const u = await seed();
    expect(await conversation(u, said(null))).toBe('following_up');
  });

  /**
   * The FOLLOW-UP budget is what bounds a contact somebody answered.
   * `maxGoalFollowUps: 1` with one already spent has nothing left, and the
   * five retries beside it are unspendable — they were forfeited by the first
   * answer.
   *
   * The stored `maxTotalDials: 99` is the point of the seed: a campaign whose
   * retired ceiling would allow ninety-nine dials still settles here.
   */
  it('incomplete past the follow-up budget settles not achieved', async () => {
    const s = await seed({
      retryCount: 5,
      maxGoalFollowUps: 1,
      followUpCount: 1,
      armKind: 'FOLLOW_UP',
      maxTotalDials: 99,
      attemptNo: 2,
      attemptLog: [spoke(1, 'fresh'), spoke(2, 'follow_up')],
    });

    expect(await conversation(s, said('incomplete', 'flexible'))).toBe('completed');
    const c = await contactRow(s.contactId);
    expect(c.status).toBe('COMPLETED');
    expect(c.goalAchieved).toBe(false);
    expect(c.nextEligibleAt).toBeNull();
  });

  /**
   * The follow-up budget is real again, and the retries do not extend it.
   *
   * `retryCount: 5` would once have bought this contact six dials of any kind;
   * it has answered, so `maxGoalFollowUps: 1` is the only budget it has and it
   * has spent five. Under the always-on rule this re-armed a sixth time.
   */
  it('stops following up once the follow-up budget is spent', async () => {
    const s = await seed({
      retryCount: 5,
      maxGoalFollowUps: 1,
      followUpCount: 5,
      armKind: 'FOLLOW_UP',
      attemptNo: 2,
      attemptLog: [spoke(1, 'fresh'), spoke(2, 'follow_up')],
    });

    expect(await conversation(s, said('incomplete', 'flexible'))).toBe('completed');
    const c = await contactRow(s.contactId);
    expect(c.status).toBe('COMPLETED');
    expect(c.goalAchieved).toBe(false);
    expect(c.followUpCount).toBe(5);
  });

  /**
   * `maxGoalFollowUps = 2` is three dials for a contact that keeps coming back
   *  incomplete — the first conversation plus two follow-ups. The retries are
   *  irrelevant once somebody has answered, which is why `retryCount: 5` here
   *  buys nothing.
   */
  it('maxGoalFollowUps = 2 yields exactly three dials for a repeatedly incomplete contact', async () => {
    const rounds = [
      [0, 'following_up'],
      [1, 'following_up'],
      [2, 'completed'],
    ] as const;

    for (const [followUpCount, expected] of rounds) {
      const s = await seed({
        retryCount: 5,
        maxGoalFollowUps: 2,
        followUpCount,
        armKind: followUpCount === 0 ? 'FRESH' : 'FOLLOW_UP',
        attemptNo: followUpCount + 1,
      });

      expect(await conversation(s, said('incomplete', 'flexible'))).toBe(expected);
    }
  });

  /** The budget wins over every callback type: a drop at the ceiling is not a
   *  reason to ring once more, and neither is a promise. */
  it('the follow-up budget beats immediate and requested alike', async () => {
    const spent = {
      retryCount: 5,
      maxGoalFollowUps: 1,
      followUpCount: 1,
      armKind: 'FOLLOW_UP' as const,
      attemptNo: 2,
      attemptLog: [spoke(1, 'fresh'), spoke(2, 'follow_up')],
    };

    const a = await seed(spent);
    expect(await conversation(a, said('incomplete', 'immediate'))).toBe('completed');
    expect((await contactRow(a.contactId)).goalAchieved).toBe(false);

    const b = await seed(spent);
    expect(
      await conversation(b, said('incomplete', 'requested', { [TIME]: '2026-09-08T17:00+05' })),
    ).toBe('completed');
    const rowB = await contactRow(b.contactId);
    expect(rowB.goalAchieved).toBe(false);
    expect(rowB.nextEligibleAt).toBeNull();
  });

  it('a silence on a number nobody answered keeps the retry ladder, whatever the stored record says', async () => {
    // The memory is a stored record and not a conversation: the LOG is what
    // decides the lane, and this one holds a single unanswered dial.
    const s = await seed({ memory: 'Priya', attemptLog: [silent(1, 'fresh')] });

    expect(
      await conversation(s, null, {
        disposition: 'voicemail',
        answeredBy: 'machine',
        retryable: true,
        permanent: false,
      }),
    ).toBe('retrying');

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('PENDING');
    expect(c.attempts).toBe(1);
    expect(c.followUpCount).toBe(0);
    expect(c.goalAchieved).toBeNull();
  });

  it('a stop stops a retryable outcome from re-arming, and settles COMPLETED', async () => {
    // A "stop" spoken to a call the carrier still classified as a voicemail.
    // Nobody gets another dial, and the settle is a conversation's, not a
    // failure's.
    const s = await seed();

    expect(
      await conversation(
        s,
        said('stop'),
        { disposition: 'voicemail', answeredBy: 'machine', retryable: true, permanent: false },
      ),
    ).toBe('completed');

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('COMPLETED');
    expect(c.attempts).toBe(0); // no retry was consumed — none was armed
    expect(await dncRow(s.campaignId, s.phone)).not.toBeNull();
  });

  it('writes the list from a permanent outcome too, but that settle stays FAILED', async () => {
    const s = await seed();

    expect(
      await conversation(
        s,
        said('stop'),
        { disposition: 'blocked', answeredBy: null, retryable: false, permanent: true },
      ),
    ).toBe('failed');

    expect((await contactRow(s.contactId)).status).toBe('FAILED');
    expect(await dncRow(s.campaignId, s.phone)).not.toBeNull();
  });

  it('a lost race writes nothing', async () => {
    const s = await seed({ attemptNo: 1 });
    // The queue has dialled past this call: a second attempt exists.
    await prisma.callAttempt.create({
      data: {
        campaignId: s.campaignId,
        campaignContactId: s.contactId,
        workspaceId: s.workspaceId,
        accountId: s.accountId,
        attemptNo: 2,
        status: 'IN_PROGRESS',
      },
    });

    expect(await conversation(s, said('completed'))).toBe('race_lost');

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('QUEUED');
    expect(c.followUpCount).toBe(0);
    expect(c.goalAchieved).toBeNull();

    const campaign = await campaignRow(s.campaignId);
    expect(campaign.completedCount).toBe(0);
    expect(campaign.failedCount).toBe(0);
  });

  /**
   * The opt-out is deliberately OUTSIDE the race guard: a resolution that
   * loses its race still heard the person ask to be left alone.
   */
  it('lists a stop even on a resolution that lost its race', async () => {
    const s = await seed({ attemptNo: 1 });
    await prisma.callAttempt.create({
      data: {
        campaignId: s.campaignId,
        campaignContactId: s.contactId,
        workspaceId: s.workspaceId,
        accountId: s.accountId,
        attemptNo: 2,
        status: 'IN_PROGRESS',
      },
    });

    expect(await conversation(s, said('stop'))).toBe('race_lost');
    expect(await dncRow(s.campaignId, s.phone)).not.toBeNull();
  });
});

/**
 * A campaign whose stored switch is `false`.
 *
 * There is no such thing as a campaign without a goal any more. The column
 * survives, the API still writes it, and the engine reads none of it — so a
 * row left at `false` by a save from an older dashboard build behaves exactly
 * like every other campaign. Asserted rather than reasoned about: "the column
 * is ignored" and "the column still turns it off" are both plausible readings
 * of a deprecation, and only one of them is what the code does.
 */
describe('a campaign whose stored goal switch is false', () => {
  it('still follows up an incomplete conversation', async () => {
    const s = await seed({ goalEnabled: false, followUpDelayHours: 7 });

    expect(await conversation(s, said('incomplete', 'flexible', { [REASON]: 'busy' }))).toBe(
      'following_up',
    );

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('PENDING');
    expect(c.followUpCount).toBe(1);
    expect(c.armKind).toBe('FOLLOW_UP');
    expect(c.nextEligibleAt).toEqual(new Date(NOW.getTime() + 7 * HOUR));
    expect(c.goalAchieved).toBeNull();
  });

  it('still resumes a dropped call on the fixed gap', async () => {
    const s = await seed({ goalEnabled: false });

    expect(await conversation(s, said('incomplete', 'immediate'))).toBe('following_up');

    const c = await contactRow(s.contactId);
    expect(c.armKind).toBe('RESUME');
    expect(c.nextEligibleAt).toEqual(new Date(NOW.getTime() + 3 * 60_000));
  });

  it('still records a verdict on a completed conversation', async () => {
    const s = await seed({ goalEnabled: false });

    expect(await conversation(s, said('completed'))).toBe('completed');

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('COMPLETED');
    expect(c.goalAchieved).toBe(true);
  });

  it('still settles a stop as an opt-out', async () => {
    const s = await seed({ goalEnabled: false });

    expect(await conversation(s, said('stop', null, { [REASON]: 'asked' }))).toBe('completed');

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('COMPLETED');
    expect(c.goalAchieved).toBe(false);
    expect((await dncRow(s.campaignId, s.phone))?.reason).toBe('asked');
  });

  /** A silence on a number nobody has answered walks the retry ladder,
   *  whatever the stored switch says. */
  it('still retries a plain silence exactly as before', async () => {
    const s = await seed({ goalEnabled: false, attemptLog: [silent(1, 'fresh')] });

    expect(
      await conversation(s, null, {
        disposition: 'voicemail',
        answeredBy: 'machine',
        retryable: true,
        permanent: false,
      }),
    ).toBe('retrying');

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('PENDING');
    expect(c.attempts).toBe(1);
    expect(c.armKind).toBe('RETRY');
    expect(c.goalAchieved).toBeNull();
  });
});

/**
 * What a FAILED settle records.
 *
 * The verdict branch runs only on a COMPLETED settle, on the premise that a
 * FAILED settle means nobody was spoken to — which is false for a contact
 * whose EARLIER dial was a conversation. Left null, those contacts drop out of
 * BOTH sides of the stats page's `groupBy(['goalAchieved'])`, so the
 * goal-achieved percentage silently counts only the contacts whose LAST dial
 * connected — the ones most likely to have finished.
 */
describe('a FAILED settle', () => {
  /** A blocked number after a real conversation: permanent, so FAILED. */
  const blocked = { disposition: 'blocked', answeredBy: null, retryable: false, permanent: true };

  it('records the outcome when an earlier dial was a conversation', async () => {
    const s = await seed({ attemptNo: 2, memory: 'Priya, wants a 2BHK.' });

    expect(await conversation(s, null, blocked)).toBe('failed');

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('FAILED');
    // No outcome on this failed call, and we did speak to them: counted, not
    // dropped, and counted as not achieved.
    expect(c.goalAchieved).toBe(false);
  });

  it('records an achieved goal a later dial failed after', async () => {
    const s = await seed({ attemptNo: 2, memory: 'Priya, 50L.' });

    expect(await conversation(s, said('completed'), blocked)).toBe('failed');

    expect((await contactRow(s.contactId)).goalAchieved).toBe(true);
  });

  /**
   * The rule is "a conversation", not "an attempt": every attempt is recorded,
   * silences included, so a contact whose retries were two busy signals has a
   * record full of entries and was never spoken to. An outcome there would
   * count somebody nobody reached as a goal not achieved.
   */
  it('leaves the outcome null when every recorded attempt was a silence', async () => {
    const s = await seed({
      attemptNo: 2,
      // Silences as the platform reports them: `busy` and `no_answer` by
      // status alone, the disposition null.
      attemptLog: [
        { attemptNo: 1, kind: 'fresh', status: 'busy', disposition: null, answeredBy: null },
        { attemptNo: 2, kind: 'retry', status: 'no_answer', disposition: null, answeredBy: 'not_answered' },
      ],
    });

    expect(await conversation(s, null, blocked)).toBe('failed');
    expect((await contactRow(s.contactId)).goalAchieved).toBeNull();
  });

  it('leaves the outcome null when no attempt ever reached a person', async () => {
    // Two busy signals and no conversation: a log full of entries, none of
    // them somebody we spoke to.
    const s = await seed({ attemptLog: [silent(1, 'fresh')] });

    expect(await conversation(s, null, blocked)).toBe('failed');

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('FAILED');
    expect(c.goalAchieved).toBeNull();
  });

  /** The stored switch buys no exemption here either: an earlier conversation
   *  is an earlier conversation, and the verdict is recorded. */
  it('records the outcome on a campaign whose stored switch is false', async () => {
    const s = await seed({ goalEnabled: false, attemptNo: 2, memory: 'Priya' });

    expect(await conversation(s, null, blocked)).toBe('failed');

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('FAILED');
    expect(c.goalAchieved).toBe(false);
    expect((await campaignRow(s.campaignId)).failedCount).toBe(1);
  });
});

describe('with IMMEDIATE_RESUME_ENABLED off, the default', () => {
  beforeEach(() => {
    env.immediateResumeEnabled = false;
  });
  afterEach(() => {
    env.immediateResumeEnabled = true;
  });

  /**
   * A drop the model reported is a plain follow-up: the follow-up lane's own
   * wait, the FOLLOW_UP arm, and no resume anchor. Nothing rings sooner than
   * any other follow-up would, whatever the note says.
   */
  it('follows up a dropped call on the follow-up wait instead of resuming it', async () => {
    const s = await seed({ followUpDelayHours: 5 });

    expect(await conversation(s, said('incomplete', 'immediate'))).toBe('following_up');

    const c = await contactRow(s.contactId);
    expect(c.status).toBe('PENDING');
    expect(c.armKind).toBe('FOLLOW_UP');
    expect(c.nextEligibleAt).toEqual(new Date(NOW.getTime() + 5 * HOUR));
    expect(c.lastImmediateAt).toBeNull();
    expect(c.followUpCount).toBe(1);
    expect(c.attempts).toBe(0);
    expect(c.callbackAt).toBeNull();
  });

  /** The flag beside an unbookable time used to reclaim the resume lane; off,
   *  it reclaims nothing and the unkept promise is a follow-up. */
  it('follows up an unbookable requested time the note also flagged as immediate', async () => {
    const s = await seed({ followUpDelayHours: 5 });

    expect(
      await conversation(
        s,
        said('incomplete', 'immediate', { [TIME]: '2026-08-20T10:00+05:30' }),
      ),
    ).toBe('following_up');

    const c = await contactRow(s.contactId);
    expect(c.armKind).toBe('FOLLOW_UP');
    expect(c.nextEligibleAt).toEqual(new Date(NOW.getTime() + 5 * HOUR));
    expect(c.lastImmediateAt).toBeNull();
  });
});
