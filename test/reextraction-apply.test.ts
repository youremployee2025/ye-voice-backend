import { beforeEach, describe, expect, it } from 'vitest';
import type { Campaign, CampaignContact, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';
import { applyRearm, selectConversations } from '../src/services/reextraction.service.js';
import type { Conversation } from '../src/services/reextraction.service.js';
import type { RearmPlan } from '../src/lib/reextraction/plan.js';
import { readCallNote, readGoalLog } from '../src/lib/goalRecord.js';
import { ReextractionRefused } from '../src/lib/reextraction/skip.js';

/**
 * Turning a re-judged call into the row a dispatcher will read.
 *
 * This is the half of the run that has consequences a person can hear: a
 * contact armed here gets a telephone call, and one settled here does not. So
 * every plan kind has a case, and so do the three things that are only true of
 * a re-arm and never of a live resolution — that it may touch a contact that
 * has already settled, that it may take a number back OFF the do-not-call
 * list, and that it will be run twice by an operator who is not sure whether
 * the first run finished.
 */

beforeEach(async () => {
  await truncateAll();
});

const RUN_ID = 'run_2026_09_05';
const NOW = new Date('2026-09-05T06:00:00Z');
/** Any instant a plan books at; the arithmetic that produced it is Task 3's. */
const AT = new Date('2026-09-08T04:30:00Z');

/** A re-judged call, as the model answers it under contender I: no
 *  `callback_type` key any more — `callbackType: 'requested'` derives off
 *  the real, parseable `callback_requested_time` alone. */
const INCOMPLETE = {
  call_outcome_vocobaseplatform: 'incomplete',
  call_outcome_reason_vocobaseplatform: 'wants a call after the board meeting',
  immediate_callback_needed_vocobaseplatform: 'no',
  callback_requested_time_vocobaseplatform: '2026-09-08T10:00+05:30',
  next_call_instructions_vocobaseplatform: 'Open by asking how the board meeting went.',
  call_end_timestamp_vocobaseplatform: '2026-09-04T10:04+05:30',
};

const STOP = {
  call_outcome_vocobaseplatform: 'stop',
  call_outcome_reason_vocobaseplatform: 'asked not to be called again',
};

const COMPLETED = { call_outcome_vocobaseplatform: 'completed' };

let seq = 0;

/**
 * A campaign with one contact that spoke to somebody, and the conversation
 * `selectConversations` makes of it — built through the real selection so the
 * shape under test is the shape the run actually hands over.
 */
async function setup(
  contactFields: Partial<CampaignContact> = {},
  campaignFields: Partial<Campaign> = {},
): Promise<{
  ws: Workspace;
  campaign: Campaign;
  link: CampaignContact;
  conversation: Conversation;
}> {
  seq += 1;
  const owner = await makeAccount(`owner${seq}`);
  const ws = await makeWorkspace(owner, `Co ${seq}`);
  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: ws.id,
      name: 'Touchbase September',
      status: 'PAUSED',
      goalEnabled: true,
      ...campaignFields,
    },
  });
  const contact = await prisma.contact.create({
    data: { workspaceId: ws.id, phone: `+9198765${String(43000 + seq).padStart(5, '0')}` },
  });
  const link = await prisma.campaignContact.create({
    data: {
      campaignId: campaign.id,
      contactId: contact.id,
      followUpCount: 2,
      ...contactFields,
    },
  });

  await prisma.callAttempt.create({
    data: {
      campaignId: campaign.id,
      campaignContactId: link.id,
      workspaceId: ws.id,
      accountId: owner.id,
      attemptNo: 2,
      kind: 'follow_up',
      status: 'COMPLETED',
      upstreamStatus: 'completed',
      disposition: 'completed',
      answeredBy: 'human',
      durationSecs: 96,
      upstreamCallId: `call_${seq}`,
      upstreamSessionId: `sess_${seq}`,
      resolvedAt: new Date('2026-09-04T04:34:00Z'),
      extraction: { call_outcome_vocobaseplatform: 'incomplete' },
    },
  });

  const { conversations } = await selectConversations(campaign.id);

  return { ws, campaign, link, conversation: conversations[0]! };
}

const apply = (conversation: Conversation, values: object, plan: RearmPlan) =>
  applyRearm({
    conversation,
    values: values as Record<string, unknown>,
    plan,
    runId: RUN_ID,
    now: NOW,
  });

const reload = (link: CampaignContact) =>
  prisma.campaignContact.findUniqueOrThrow({ where: { id: link.id } });

const counters = (campaign: Campaign) =>
  prisma.campaign.findUniqueOrThrow({
    where: { id: campaign.id },
    select: { completedCount: true, failedCount: true, skippedCount: true },
  });

describe('what each plan does to the contact', () => {
  it('settles a stop and lists the number', async () => {
    const { campaign, link, conversation } = await setup();

    await apply(conversation, STOP, { kind: 'stop', reason: 'asked not to be called again' });

    expect(await reload(link)).toMatchObject({
      status: 'COMPLETED',
      goalAchieved: false,
      nextEligibleAt: null,
      callbackAt: null,
      armKind: 'FRESH',
      followUpCount: 0,
    });
    expect(
      await prisma.doNotCall.findUnique({
        where: { campaignId_phone: { campaignId: campaign.id, phone: conversation.phone } },
      }),
    ).toMatchObject({
      reason: 'asked not to be called again',
      sourceCampaignContactId: link.id,
    });
  });

  it('settles a completed call as the goal met', async () => {
    const { link, conversation } = await setup();

    await apply(conversation, COMPLETED, { kind: 'completed' });

    expect(await reload(link)).toMatchObject({
      status: 'COMPLETED',
      goalAchieved: true,
      nextEligibleAt: null,
      callbackAt: null,
      armKind: 'FRESH',
      followUpCount: 0,
    });
  });

  /** A promise is the one arm that writes `callbackAt`, because it is the one
   *  arm a person on the phone asked for. */
  it('books a promise at the time it was made for', async () => {
    const { link, conversation } = await setup({ status: 'COMPLETED' });

    await apply(conversation, INCOMPLETE, { kind: 'callback', at: AT });

    expect(await reload(link)).toMatchObject({
      status: 'PENDING',
      goalAchieved: null,
      nextEligibleAt: AT,
      callbackAt: AT,
      armKind: 'CALLBACK',
      followUpCount: 0,
    });
  });

  it.each([
    ['resume', 'RESUME'],
    ['follow_up', 'FOLLOW_UP'],
  ] as const)('arms a %s in its own lane and promises nothing', async (kind, armKind) => {
    const { link, conversation } = await setup({ status: 'COMPLETED', callbackAt: NOW });

    await apply(conversation, INCOMPLETE, { kind, at: AT });

    expect(await reload(link)).toMatchObject({
      status: 'PENDING',
      goalAchieved: null,
      nextEligibleAt: AT,
      // Cleared, not left behind: this contact is waiting on an arm the engine
      // chose, and a leftover `callbackAt` would draw it as a promise.
      callbackAt: null,
      armKind,
      followUpCount: 0,
    });
  });

  /**
   * No outcome is not a verdict, and a run that wrote anything here would be
   * acting on a reply that did not answer the question it was asked. In
   * particular the extraction column is NOT replaced: a one-key reply would
   * blank the five values the attempt already holds.
   */
  it('writes nothing at all when the reply carries no verdict', async () => {
    const { campaign, link, conversation } = await setup({ status: 'COMPLETED' });
    const before = await reload(link);

    await apply(conversation, { call_outcome_reason_vocobaseplatform: 'unclear' }, {
      kind: 'no_verdict',
    });

    expect(await reload(link)).toEqual(before);
    expect(
      (await prisma.callAttempt.findUniqueOrThrow({ where: { id: conversation.attemptId } }))
        .extraction,
    ).toEqual({ call_outcome_vocobaseplatform: 'incomplete' });
    expect(await counters(campaign)).toEqual({
      completedCount: 0,
      failedCount: 0,
      skippedCount: 0,
    });
    expect(await prisma.campaignContactGoal.findUnique({ where: { campaignContactId: link.id } }))
      .toBeNull();
  });

  /**
   * A contact the dispatcher would never dial again is left exactly as it is,
   * for the same reason `no_verdict` is: an arm nothing will ever take is worse
   * than the settled row it replaced, because nothing else will ever settle it.
   */
  it('writes nothing at all for a contact that is over budget', async () => {
    const { campaign, link, conversation } = await setup({ status: 'COMPLETED' });
    const before = await reload(link);

    await apply(conversation, INCOMPLETE, { kind: 'over_budget', reason: 'follow_up_budget' });

    expect(await reload(link)).toEqual(before);
    expect(
      (await prisma.callAttempt.findUniqueOrThrow({ where: { id: conversation.attemptId } }))
        .extraction,
    ).toEqual({ call_outcome_vocobaseplatform: 'incomplete' });
    expect(await counters(campaign)).toEqual({
      completedCount: 0,
      failedCount: 0,
      skippedCount: 0,
    });
  });
});

describe('the verdict written onto the attempt', () => {
  /** The marker is what makes a re-run resumable, and it must not cost the
   *  column its readability: production reads a note by key name, so the two
   *  underscore keys are invisible to it. */
  it('stores the new values beside a marker production ignores', async () => {
    const { conversation } = await setup();

    await apply(conversation, INCOMPLETE, { kind: 'callback', at: AT });

    const attempt = await prisma.callAttempt.findUniqueOrThrow({
      where: { id: conversation.attemptId },
    });

    expect(attempt.extraction).toMatchObject({
      ...INCOMPLETE,
      _reextractedBy: RUN_ID,
      _reextractedAt: NOW.toISOString(),
    });
    expect(readCallNote(attempt.extraction)).toMatchObject({
      outcome: 'incomplete',
      callbackType: 'requested',
      note: 'Open by asking how the board meeting went.',
    });
  });

  /**
   * The goal record's log is keyed by attempt number, so recording this
   * attempt again REPLACES its entry — which is exactly what a re-judged call
   * needs. The next dial's memory and the journey then read H's note rather
   * than the verdict the campaign no longer trusts.
   */
  it('replaces the entry this attempt already had in the goal record', async () => {
    const { link, conversation } = await setup();

    await apply(conversation, INCOMPLETE, { kind: 'callback', at: AT });

    const record = await prisma.campaignContactGoal.findUniqueOrThrow({
      where: { campaignContactId: link.id },
    });
    const log = readGoalLog(record.attemptLog);

    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      attemptNo: 2,
      kind: 'follow_up',
      status: 'completed',
      disposition: 'completed',
      answeredBy: 'human',
      outcome: 'incomplete',
      callbackType: 'requested',
      durationSecs: 96,
    });
    expect(record.memory).toBe('Open by asking how the board meeting went.');
    expect(record.lastCallNote).toContain('asked to be called back');
  });

  /**
   * The promised time is read from the call note and from nowhere else,
   * exactly as `bookCallbackFromExtraction` and the reaper read it. The plain
   * `callback_requested_at` key is not a promise: agents are shared between
   * campaigns, so one routinely rides along from another campaign's set, and
   * logged as this call's promise it would tell the next dial the person asked
   * for a time they never named. Asserted with the stored switch off, which is
   * where the old rule read the plain key.
   */
  it('reads the promised time from the note and never from the plain key', async () => {
    const { link, conversation } = await setup({}, { goalEnabled: false });

    await apply(
      conversation,
      {
        callback_requested_at: '2026-09-08T10:00',
        call_outcome_vocobaseplatform: 'incomplete',
        immediate_callback_needed_vocobaseplatform: 'no',
        callback_requested_time_vocobaseplatform: '2026-09-09T11:00+05:30',
      },
      { kind: 'callback', at: AT },
    );

    const log = readGoalLog(
      (
        await prisma.campaignContactGoal.findUniqueOrThrow({
          where: { campaignContactId: link.id },
        })
      ).attemptLog,
    );

    expect(log[0]).toMatchObject({ callbackNote: '2026-09-09T11:00+05:30' });
  });
});

/**
 * H's verdict wins even over an old `stop`, which is the whole reason this
 * run exists — and a `stop` that is reopened has to take its own do-not-call
 * row with it, or the contact is armed for a dial the claim will refuse.
 */
describe('reopening a stop', () => {
  it('deletes the row created by this contact own old verdict', async () => {
    const { campaign, conversation, link } = await setup({ status: 'COMPLETED' });
    await prisma.doNotCall.create({
      data: {
        campaignId: campaign.id,
        phone: conversation.phone,
        reason: 'G said stop',
        sourceCampaignContactId: link.id,
      },
    });

    await apply(conversation, INCOMPLETE, { kind: 'follow_up', at: AT });

    expect(await prisma.doNotCall.count({ where: { campaignId: campaign.id } })).toBe(0);
  });

  /**
   * A row somebody else put there stays. An import's opt-out list, or another
   * contact on the same number, is not this run's to overrule: all this run
   * knows is that ITS verdict about ITS call was wrong.
   */
  it('leaves a row another source put there alone', async () => {
    const { campaign, conversation } = await setup({ status: 'COMPLETED' });
    await prisma.doNotCall.create({
      data: {
        campaignId: campaign.id,
        phone: conversation.phone,
        reason: 'uploaded opt-out list',
        sourceCampaignContactId: null,
      },
    });

    await apply(conversation, INCOMPLETE, { kind: 'follow_up', at: AT });

    expect(
      await prisma.doNotCall.findUniqueOrThrow({
        where: { campaignId_phone: { campaignId: campaign.id, phone: conversation.phone } },
      }),
    ).toMatchObject({ reason: 'uploaded opt-out list' });
  });
});

/**
 * The campaign's counters are what the list page draws, and a re-arm moves
 * contacts between settled and waiting in both directions. Left alone they
 * would report more settled contacts than the campaign has.
 */
describe('the campaign counters', () => {
  it.each([
    ['COMPLETED', 'completedCount'],
    ['FAILED', 'failedCount'],
    ['SKIPPED', 'skippedCount'],
  ] as const)('gives back the %s a re-armed contact was counted under', async (status, counter) => {
    const { campaign, conversation } = await setup({ status }, { [counter]: 1 });

    await apply(conversation, INCOMPLETE, { kind: 'follow_up', at: AT });

    expect(await counters(campaign)).toMatchObject({ [counter]: 0 });
  });

  it('counts a contact that settles for the first time', async () => {
    const { campaign, conversation } = await setup({ status: 'PENDING' });

    await apply(conversation, COMPLETED, { kind: 'completed' });

    expect(await counters(campaign)).toMatchObject({ completedCount: 1 });
  });

  it('moves a contact that settles a different way', async () => {
    const { campaign, conversation } = await setup({ status: 'FAILED' }, { failedCount: 1 });

    await apply(conversation, STOP, { kind: 'stop', reason: null });

    expect(await counters(campaign)).toMatchObject({ completedCount: 1, failedCount: 0 });
  });

  it('leaves a contact that settles the same way where it was', async () => {
    const { campaign, conversation } = await setup({ status: 'COMPLETED' }, { completedCount: 1 });

    await apply(conversation, COMPLETED, { kind: 'completed' });

    expect(await counters(campaign)).toMatchObject({ completedCount: 1 });
  });

  /** A counter that is already wrong — a campaign whose history predates a
   *  fix, a row somebody moved by hand — must not be driven negative by a
   *  correction. A count below zero is a number no page can draw. */
  it('never takes a counter below zero', async () => {
    const { campaign, conversation } = await setup({ status: 'COMPLETED' });

    await apply(conversation, INCOMPLETE, { kind: 'follow_up', at: AT });

    expect(await counters(campaign)).toMatchObject({ completedCount: 0 });
  });
});

/**
 * An operator whose run died halfway through re-runs it. Every row it already
 * applied is applied again, and the second pass must land on the state the
 * first one did — the counters above all, which are increments and would
 * otherwise drift by one per re-run.
 */
describe('running the same re-arm twice', () => {
  /**
   * Seeded at three, and asserted to land on two.
   *
   * Seeded at one it would pass against a broken implementation: a second
   * decrement keyed off the status captured at SELECTION time would take the
   * counter to zero on the first apply and then be refused by the `> 0` guard
   * on the second, so the guard would hide the very bug this case exists to
   * catch. Three leaves the guard out of it — a stale-status second decrement
   * lands on one and the case fails, which is what it is for.
   */
  it('lands on the same state, counters included', async () => {
    const { campaign, link, conversation } = await setup({ status: 'COMPLETED' }, {
      completedCount: 3,
    });

    await apply(conversation, INCOMPLETE, { kind: 'callback', at: AT });
    const once = await reload(link);
    const onceCounters = await counters(campaign);

    await apply(conversation, INCOMPLETE, { kind: 'callback', at: AT });

    expect(await reload(link)).toEqual({ ...once, updatedAt: expect.any(Date) });
    expect(onceCounters).toMatchObject({ completedCount: 2 });
    expect(await counters(campaign)).toEqual(onceCounters);
    expect(
      readGoalLog(
        (
          await prisma.campaignContactGoal.findUniqueOrThrow({
            where: { campaignContactId: link.id },
          })
        ).attemptLog,
      ),
    ).toHaveLength(1);
  });

  it('does not list a number twice, nor overwrite the reason first given', async () => {
    const { campaign, conversation } = await setup();

    await apply(conversation, STOP, { kind: 'stop', reason: 'asked not to be called again' });
    await apply(conversation, STOP, { kind: 'stop', reason: 'a later wording' });

    const rows = await prisma.doNotCall.findMany({ where: { campaignId: campaign.id } });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'asked not to be called again' });
  });
});

/**
 * The whole re-arm is one transaction, and the goal record is part of it.
 *
 * `recordAttempt` opens a transaction of its own when it is handed a client
 * that can open one, which is exactly the trap here: given the outer client
 * instead of the outer transaction, its write would COMMIT independently and
 * survive a rollback of everything around it. The contact would then keep the
 * arm the withdrawn verdict gave it while its goal record — the memory the
 * next dial reads out loud — carried H's note about a re-arm that never
 * happened.
 */
describe('when the transaction rolls back', () => {
  it('takes the goal record with it', async () => {
    const { link, conversation } = await setup();

    /** The real client, with a failure wrapped around the whole body: every
     *  write the re-arm makes is issued, and then none of them stands. */
    const failing = {
      $transaction: (run: (tx: unknown) => Promise<void>) =>
        prisma.$transaction(async (tx) => {
          await run(tx);

          throw new Error('rolled back');
        }),
    } as unknown as Parameters<typeof applyRearm>[1];

    await expect(
      applyRearm(
        { conversation, values: INCOMPLETE, plan: { kind: 'callback', at: AT }, runId: RUN_ID, now: NOW },
        failing,
      ),
    ).rejects.toThrow('rolled back');

    expect(await prisma.campaignContactGoal.findUnique({ where: { campaignContactId: link.id } }))
      .toBeNull();
    expect(await reload(link)).toMatchObject({ status: 'PENDING', armKind: 'FRESH' });
    expect(
      (await prisma.callAttempt.findUniqueOrThrow({ where: { id: conversation.attemptId } }))
        .extraction,
    ).toEqual({ call_outcome_vocobaseplatform: 'incomplete' });
  });
});

/**
 * The campaign is checked again, under the lock, on every contact.
 *
 * `selectConversations` refuses a live campaign, but a run of a thousand
 * contacts pauses between batches for an operator to confirm, so the window
 * between that refusal and this write is as long as somebody's lunch. An
 * operator who unpauses the campaign in the middle of it must not have the
 * rest of the run rewriting `armKind` and `nextEligibleAt` underneath a
 * dispatcher that is dialing from them.
 */
describe('a campaign that went live mid-run', () => {
  it('refuses the write and leaves the contact alone', async () => {
    const { campaign, link, conversation } = await setup({ status: 'COMPLETED' });
    const before = await reload(link);

    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'RUNNING' } });

    await expect(
      apply(conversation, INCOMPLETE, { kind: 'callback', at: AT }),
    ).rejects.toBeInstanceOf(ReextractionRefused);

    expect(await reload(link)).toEqual(before);
    expect(
      (await prisma.callAttempt.findUniqueOrThrow({ where: { id: conversation.attemptId } }))
        .extraction,
    ).toEqual({ call_outcome_vocobaseplatform: 'incomplete' });
  });
});
