import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/adapter/vocobase.js', () => ({
  startCall: vi.fn(),
  getConcurrency: vi.fn(),
  getCall: vi.fn(),
}));

const { getCall } = await import('../src/adapter/vocobase.js');
const { closeStaleAttempts, releaseStaleClaims } = await import('../src/services/dialerReaper.js');
const { prisma } = await import('../src/lib/prisma.js');
const { flushNotifications } = await import('../src/lib/notify.js');
const { toInternalCredits } = await import('../src/lib/credits.js');
const { truncateAll } = await import('./setup.js');
const { makeAccount, makeAgent, makeWorkspace } = await import('./helpers.js');

const mockedGetCall = vi.mocked(getCall);

const NOW = new Date('2026-08-30T10:00:00Z');
/** Older than DIALER_ATTEMPT_TIMEOUT_MINS (60) before NOW. */
const STALE = new Date(NOW.getTime() - 120 * 60_000);
const FRESH = new Date(NOW.getTime() - 60_000);

async function seedAttempt(options: {
  startedAt: Date;
  upstreamCallId?: string | null;
  /** The goal switch. Absent is a plain campaign. */
  goalEnabled?: boolean;
}) {
  // `upstreamCallId` is @unique, so each fixture gets its own unless a case
  // needs to name it. `null` is a real value here — the unconfirmed launch —
  // so absence is tested with `in` rather than with `??`.
  const account = await makeAccount(`r${Math.random().toString(36).slice(2, 7)}`);
  await prisma.account.update({
    where: { id: account.id },
    data: { credits: toInternalCredits('100') },
  });

  const workspace = await makeWorkspace(account, 'Reapers');
  const agent = await makeAgent(workspace, 'caller');

  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: workspace.id,
      name: 'Outreach',
      agentId: agent.id,
      status: 'RUNNING',
      retryCount: 2,
      goalEnabled: options.goalEnabled ?? false,
    },
  });

  const contact = await prisma.contact.create({
    data: { workspaceId: workspace.id, phone: `+9198765${Math.floor(Math.random() * 100000)}` },
  });
  const link = await prisma.campaignContact.create({
    data: { campaignId: campaign.id, contactId: contact.id, status: 'QUEUED', attempts: 1 },
  });

  const attempt = await prisma.callAttempt.create({
    data: {
      campaignId: campaign.id,
      campaignContactId: link.id,
      workspaceId: workspace.id,
      accountId: account.id,
      attemptNo: 1,
      status: 'QUEUED',
      startedAt: options.startedAt,
      upstreamCallId:
        'upstreamCallId' in options
          ? options.upstreamCallId
          : `c_${Math.random().toString(36).slice(2, 10)}`,
      rateCreditsPerMin: toInternalCredits('1.00'),
    },
  });

  return { accountId: account.id, campaignId: campaign.id, linkId: link.id, attemptId: attempt.id };
}

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  mockedGetCall.mockResolvedValue(null);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await flushNotifications();
  await truncateAll();
  vi.restoreAllMocks();
});

describe('what the reaper leaves alone', () => {
  it('does not touch an attempt that is still young', async () => {
    const { attemptId } = await seedAttempt({ startedAt: FRESH });

    await expect(closeStaleAttempts(NOW)).resolves.toBe(0);

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.status).toBe('QUEUED');
    // A call in progress is not a problem to be solved.
    expect(mockedGetCall).not.toHaveBeenCalled();
  });

  it('does not touch an attempt that already reached a terminal status', async () => {
    const { attemptId } = await seedAttempt({ startedAt: STALE });
    await prisma.callAttempt.update({
      where: { id: attemptId },
      data: { status: 'COMPLETED', chargedAt: NOW },
    });

    await expect(closeStaleAttempts(NOW)).resolves.toBe(0);
  });
});

/**
 * The reaper does not guess. It asks the platform, which is the only party
 * that knows what happened on the call.
 */
describe('reconciling against the platform', () => {
  it('closes and charges an attempt the platform reports as completed', async () => {
    const { attemptId, accountId, linkId } = await seedAttempt({
      startedAt: STALE,
      upstreamCallId: 'c_stale',
    });

    mockedGetCall.mockResolvedValue({
      call_id: 'c_stale',
      status: 'completed',
      disposition: 'completed',
      answered_by: 'human',
      session: {
        duration_seconds: 120,
        credits_used: 2,
        // The note that ends the conversation. Without one this settle is a
        // follow-up — every campaign follows an unfinished conversation up —
        // and the contact goes back on the queue rather than settling.
        extraction: { values: { call_outcome_vocobaseplatform: 'completed' } },
      },
    });

    await expect(closeStaleAttempts(NOW)).resolves.toBe(1);

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.status).toBe('COMPLETED');
    expect(attempt.durationSecs).toBe(120);
    expect(attempt.disposition).toBe('completed');
    // Two minutes at 1.00/min. A missed webhook must not change what a call
    // cost — the recovery path bills exactly as the webhook would.
    expect(attempt.costCredits).toBe(toInternalCredits('2.00'));

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.credits).toBe(toInternalCredits('98.00'));

    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: linkId } });
    expect(contact.status).toBe('COMPLETED');
  });

  /**
   * The plain `callback_requested_at` key is never a promise any more.
   *
   * Every agent answers the call note now, and agents are shared between
   * campaigns — so a stale key from some other campaign's set routinely rides
   * along in the extraction, and reading it would book a call on a
   * conversation that named no time. See `callbackRawFrom`.
   */
  it('books nothing off the plain callbacks key', async () => {
    const { linkId } = await seedAttempt({ startedAt: STALE, upstreamCallId: 'c_stale' });
    const promised = new Date(NOW.getTime() + 30 * 3_600_000);

    mockedGetCall.mockResolvedValue({
      call_id: 'c_stale',
      status: 'completed',
      disposition: 'completed',
      answered_by: 'human',
      session: {
        duration_seconds: 120,
        extraction: { values: { callback_requested_at: promised.toISOString() } },
      },
    });

    await expect(closeStaleAttempts(NOW)).resolves.toBe(1);

    expect(
      (await prisma.campaignContact.findUniqueOrThrow({ where: { id: linkId } })).callbackAt,
    ).toBeNull();
  });

  /**
   * The promise lives in the call note, and only counts when the note says a
   * callback was requested. The reaper reads it through the same helper as the
   * webhook, so a promise heard late is read by the same rule as one heard on
   * time.
   */
  it('books the note’s time the missed webhook would have carried', async () => {
    const { linkId } = await seedAttempt({
      startedAt: STALE,
      upstreamCallId: 'c_stale',
      goalEnabled: true,
    });
    const promised = new Date(NOW.getTime() + 30 * 3_600_000);

    mockedGetCall.mockResolvedValue({
      call_id: 'c_stale',
      status: 'completed',
      disposition: 'completed',
      answered_by: 'human',
      session: {
        duration_seconds: 120,
        extraction: {
          values: {
            call_outcome_vocobaseplatform: 'incomplete',
            immediate_callback_needed_vocobaseplatform: 'no',
            callback_requested_time_vocobaseplatform: promised.toISOString(),
            next_call_instructions_vocobaseplatform: 'Resume from the budget question.',
          },
        },
      },
    });

    await expect(closeStaleAttempts(NOW)).resolves.toBe(1);

    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: linkId } });
    expect(contact.status).toBe('PENDING');
    expect(contact.callbackAt?.toISOString()).toBe(promised.toISOString());
    expect(contact.nextEligibleAt?.getTime()).toBe(contact.callbackAt?.getTime());
  });

  /** A goal campaign's agent may still carry the plain callbacks key from a
   *  campaign it shares the agent with; that key is not this campaign's. */
  it('ignores the plain callbacks key on a goal campaign', async () => {
    const { linkId } = await seedAttempt({
      startedAt: STALE,
      upstreamCallId: 'c_stale',
      goalEnabled: true,
    });
    const promised = new Date(NOW.getTime() + 30 * 3_600_000);

    mockedGetCall.mockResolvedValue({
      call_id: 'c_stale',
      status: 'completed',
      disposition: 'completed',
      answered_by: 'human',
      session: {
        duration_seconds: 120,
        extraction: {
          values: {
            callback_requested_at: promised.toISOString(),
            call_outcome_vocobaseplatform: 'incomplete',
            immediate_callback_needed_vocobaseplatform: 'no',
          },
        },
      },
    });

    await expect(closeStaleAttempts(NOW)).resolves.toBe(1);

    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: linkId } });
    // Re-armed as a follow-up at the delay, not booked at the promise.
    expect(contact.status).toBe('PENDING');
    expect(contact.callbackAt).toBeNull();
  });

  /**
   * Reconciliation and the webhook must leave the same row behind: a call
   * whose answers reached us late is not a call with no answers. Lead buckets
   * are computed from this column, and a campaign whose webhook endpoint was
   * down for an hour must not read as a campaign whose leads said nothing.
   */
  it('stores the extraction the missed webhook would have carried', async () => {
    const { attemptId } = await seedAttempt({ startedAt: STALE, upstreamCallId: 'c_stale' });

    mockedGetCall.mockResolvedValue({
      call_id: 'c_stale',
      status: 'completed',
      disposition: 'completed',
      answered_by: 'human',
      session: {
        duration_seconds: 120,
        extraction: { values: { lead_stage: 'hot' } },
      },
    });

    await closeStaleAttempts(NOW);

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.extraction).toEqual({ lead_stage: 'hot' });
  });

  it('closes an unanswered call without charging for it', async () => {
    const { attemptId, accountId, linkId } = await seedAttempt({
      startedAt: STALE,
      upstreamCallId: 'c_stale',
    });

    mockedGetCall.mockResolvedValue({
      call_id: 'c_stale',
      status: 'no_answer',
      disposition: 'no_answer',
      session: { duration_seconds: 0 },
    });

    await expect(closeStaleAttempts(NOW)).resolves.toBe(1);

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.status).toBe('FAILED');
    expect(attempt.costCredits).toBe(0n);
    // chargedAt is set even at zero, so a late delivery cannot charge it again.
    expect(attempt.chargedAt).not.toBeNull();

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.credits).toBe(toInternalCredits('100'));

    // No ledger row for a zero charge: it would carry nothing the attempt does
    // not already say.
    expect(await prisma.creditTransaction.count()).toBe(0);

    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: linkId } });
    // Back on the queue with one more retry consumed: a reconciled outcome
    // resolves exactly as the webhook's would, cooldown included.
    expect(contact.status).toBe('PENDING');
    expect(contact.attempts).toBe(2);
    expect(contact.nextEligibleAt).not.toBeNull();
  });

  /**
   * The one-vocabulary ending. `GET /calls/:id` derives `end_call_reason` on
   * read, so a reconciliation must record the same answer the lost webhook
   * would have — or the export and the dial budget read a reconciled call
   * differently from a delivered one.
   */
  it('records the end_call_reason the missed webhook would have carried', async () => {
    const { attemptId } = await seedAttempt({ startedAt: STALE, upstreamCallId: 'c_stale' });

    mockedGetCall.mockResolvedValue({
      call_id: 'c_stale',
      status: 'no_answer',
      disposition: 'no_answer',
      end_call_reason: 'NO_ANSWER',
      session: { duration_seconds: 0 },
    });

    await expect(closeStaleAttempts(NOW)).resolves.toBe(1);

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.status).toBe('FAILED');
    expect(attempt.endCallReason).toBe('NO_ANSWER');
  });

  it('writes no end_call_reason off a detail that predates the field', async () => {
    const { attemptId, linkId } = await seedAttempt({ startedAt: STALE, upstreamCallId: 'c_stale' });

    mockedGetCall.mockResolvedValue({
      call_id: 'c_stale',
      status: 'no_answer',
      disposition: 'no_answer',
      session: { duration_seconds: 0 },
    });

    await expect(closeStaleAttempts(NOW)).resolves.toBe(1);

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.status).toBe('FAILED');
    expect(attempt.endCallReason).toBeNull();
    // Still an ordinary silence: the retry is consumed as before.
    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: linkId } });
    expect(contact.status).toBe('PENDING');
    expect(contact.attempts).toBe(2);
  });

  /**
   * Unlike `error_code`, the detail DOES carry the reason — so a platform
   * fault whose webhook was lost is handed back here exactly as the webhook
   * path hands it back: no charge, no retry spent, the contact back on the
   * queue after the cooldown.
   */
  it('hands back a SYSTEM_ERROR nobody was heard on without spending a retry', async () => {
    const { attemptId, accountId, linkId } = await seedAttempt({
      startedAt: STALE,
      upstreamCallId: 'c_stale',
    });

    mockedGetCall.mockResolvedValue({
      call_id: 'c_stale',
      status: 'failed',
      disposition: 'failed',
      end_call_reason: 'SYSTEM_ERROR',
      session: { duration_seconds: 0 },
    });

    await expect(closeStaleAttempts(NOW)).resolves.toBe(1);

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.status).toBe('FAILED');
    expect(attempt.endCallReason).toBe('SYSTEM_ERROR');
    expect(attempt.errorCode).toBeNull();
    expect(attempt.costCredits).toBe(0n);
    expect(attempt.resolvedAt).not.toBeNull();
    expect(attempt.chargedAt).not.toBeNull();

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.credits).toBe(toInternalCredits('100'));

    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: linkId } });
    expect(contact.status).toBe('PENDING');
    // The ladder untouched: the number was never tested.
    expect(contact.attempts).toBe(1);
    expect(contact.nextEligibleAt).not.toBeNull();
  });
});

describe('a SYSTEM_ERROR the detail says was answered', () => {
  /** The detail carries `answered_at`; a connected call was tested, so the
   *  retry is spent as on any silence, whatever `answered_by` says. */
  it('spends the retry rather than handing the contact back', async () => {
    const { attemptId, linkId } = await seedAttempt({ startedAt: STALE, upstreamCallId: 'c_stale' });

    mockedGetCall.mockResolvedValue({
      call_id: 'c_stale',
      status: 'failed',
      disposition: 'failed',
      answered_at: '2026-09-15T10:00:05.000Z',
      end_call_reason: 'SYSTEM_ERROR',
      session: { duration_seconds: 0 },
    });

    await expect(closeStaleAttempts(NOW)).resolves.toBe(1);

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.endCallReason).toBe('SYSTEM_ERROR');
    expect(attempt.answeredAt).not.toBeNull();

    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: linkId } });
    expect(contact.attempts).toBe(2);
  });
});

describe('when the platform cannot answer either', () => {
  /**
   * ABANDONED, and deliberately not FAILED. "We never found out" and "the
   * callee did not answer" are different facts, and filing the first as the
   * second puts people on a customer's did-not-answer report who may well have
   * picked up.
   */
  it('abandons an attempt the platform has never heard of', async () => {
    mockedGetCall.mockResolvedValue(null);
    const { attemptId, linkId } = await seedAttempt({ startedAt: STALE });

    await expect(closeStaleAttempts(NOW)).resolves.toBe(1);

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.status).toBe('ABANDONED');
    expect(attempt.chargedAt).toBeNull();
    expect(attempt.launchError).toMatch(/no outcome was ever reported/i);
    // An outcome *was* applied to the contact here, so the attempt is resolved.
    // That is the mark a late delivery for this same dial reads to know the
    // queue has already moved on without it — and it is also what stops the
    // journey drawing an abandoned attempt as a telephone still ringing.
    expect(attempt.resolvedAt).not.toBeNull();

    // The contact goes back on the queue with a retry spent — the abandoned
    // call may well have happened, so this is the ordinary retry, not a free
    // one — and settles as FAILED once the budget is gone.
    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: linkId } });
    expect(contact.status).toBe('PENDING');
    expect(contact.attempts).toBe(2);
  });

  /**
   * The record moves on the same transaction that re-arms the contact, as it
   * does for every other resolver: an abandoned attempt is still one the next
   * call is told about, and the line says what is true — nothing was reported.
   * The previous conversation's note is left standing for that call to use.
   */
  it('writes an abandoned goal attempt its own last-call line and leaves the note alone', async () => {
    mockedGetCall.mockResolvedValue(null);
    const { attemptId, linkId } = await seedAttempt({ startedAt: STALE, goalEnabled: true });
    // Call one was a conversation; this abandoned dial is call two.
    await prisma.callAttempt.update({ where: { id: attemptId }, data: { attemptNo: 2, kind: 'follow_up' } });
    await prisma.campaignContactGoal.create({
      data: {
        campaignContactId: linkId,
        memory: 'Nikhil, on the road.',
        memoryAttempt: 1,
        lastCallNote: 'spoke, worth calling again',
        attemptLog: [{ attemptNo: 1, kind: 'fresh', status: 'completed', disposition: 'completed', answeredBy: 'human', outcome: 'incomplete', reason: null, callbackType: 'flexible', callbackRequestedTime: null }],
      },
    });

    await expect(closeStaleAttempts(NOW)).resolves.toBe(1);

    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: linkId } });
    expect(contact.status).toBe('PENDING');

    const record = await prisma.campaignContactGoal.findUniqueOrThrow({ where: { campaignContactId: linkId } });
    expect(record.lastCallNote).toBe('no outcome was reported for the call');
    expect(record.memory).toBe('Nikhil, on the road.');
    expect(record.memoryAttempt).toBe(1);
    expect((record.attemptLog as { attemptNo: number; kind: string; outcome: unknown }[]).at(-1)).toMatchObject({
      attemptNo: 2,
      kind: 'follow_up',
      outcome: null,
    });
  });

  /** The record is written for every campaign now, the stored switch
   *  included: the next call has to be told what happened to this one, and a
   *  silence is something that happened. */
  it('writes the record even when the stored switch says false', async () => {
    mockedGetCall.mockResolvedValue(null);
    const { linkId } = await seedAttempt({ startedAt: STALE, goalEnabled: false });

    await expect(closeStaleAttempts(NOW)).resolves.toBe(1);

    const record = await prisma.campaignContactGoal.findUniqueOrThrow({
      where: { campaignContactId: linkId },
    });
    expect(record.lastCallNote).toBe('no outcome was reported for the call');
  });

  it('settles a contact whose retries an abandoned attempt has now spent', async () => {
    mockedGetCall.mockResolvedValue(null);
    const { linkId, campaignId } = await seedAttempt({ startedAt: STALE });
    await prisma.campaignContact.update({ where: { id: linkId }, data: { attempts: 2 } });

    await expect(closeStaleAttempts(NOW)).resolves.toBe(1);

    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: linkId } });
    expect(contact.status).toBe('FAILED');
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.failedCount).toBe(1);
  });

  it('abandons an attempt still live upstream long past any plausible call', async () => {
    mockedGetCall.mockResolvedValue({ call_id: 'c_stale', status: 'in_progress' });
    const { attemptId } = await seedAttempt({ startedAt: STALE, upstreamCallId: 'c_stale' });

    await expect(closeStaleAttempts(NOW)).resolves.toBe(1);

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.status).toBe('ABANDONED');
  });

  /**
   * The launch whose response was lost. There is no id to ask with, because
   * the id is precisely what never arrived.
   */
  it('abandons an unconfirmed launch without asking the platform', async () => {
    const { attemptId } = await seedAttempt({ startedAt: STALE, upstreamCallId: null });

    await expect(closeStaleAttempts(NOW)).resolves.toBe(1);

    expect(mockedGetCall).not.toHaveBeenCalled();
    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.status).toBe('ABANDONED');
  });

  it('frees the line, so the campaign can dial again', async () => {
    const { campaignId } = await seedAttempt({ startedAt: STALE });

    await closeStaleAttempts(NOW);

    const stillHolding = await prisma.callAttempt.count({
      where: { campaignId, status: { in: ['QUEUED', 'RINGING', 'IN_PROGRESS'] } },
    });
    expect(stillHolding).toBe(0);
  });

  it('keeps closing the rest when one attempt cannot be read', async () => {
    mockedGetCall
      .mockRejectedValueOnce(new Error('upstream down'))
      .mockResolvedValue(null);

    await seedAttempt({ startedAt: STALE });
    await seedAttempt({ startedAt: new Date(STALE.getTime() + 1_000) });

    // One failure must not hold every other line open — that is the exact
    // problem this function exists to solve.
    await expect(closeStaleAttempts(NOW)).resolves.toBe(1);
  });
});

/**
 * The second way an attempt goes stale. An unclassified pacing event closes
 * the attempt to free the line and deliberately leaves `resolvedAt` null,
 * deferring the queue move to the completion event — and the completion never
 * arrives. The reaper is the fallback for exactly that silence.
 */
describe('an attempt whose resolution was deferred and whose completion was lost', () => {
  async function seedDeferred(callId: string) {
    const seeded = await seedAttempt({ startedAt: STALE, upstreamCallId: callId });

    await prisma.callAttempt.update({
      where: { id: seeded.attemptId },
      data: { status: 'COMPLETED', endedAt: STALE },
    });

    return seeded;
  }

  it('resolves and charges it from the call detail, exactly as the webhook would have', async () => {
    const { attemptId, accountId, linkId } = await seedDeferred('c_deferred');

    mockedGetCall.mockResolvedValue({
      call_id: 'c_deferred',
      status: 'completed',
      disposition: 'voicemail',
      answered_by: 'machine',
      session: { duration_seconds: 120 },
    });

    await expect(closeStaleAttempts(NOW)).resolves.toBe(1);

    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.resolvedAt).not.toBeNull();
    expect(attempt.costCredits).toBe(toInternalCredits('2.00'));

    // The detail knows it was a voicemail: the ladder arms rather than the
    // contact settling as a conversation that never happened.
    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: linkId } });
    expect(contact.status).toBe('PENDING');
    expect(contact.attempts).toBe(2);
    expect(contact.disposition).toBe('voicemail');

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.credits).toBe(toInternalCredits('98.00'));
  });

  it('settles it as a silence when the platform cannot answer either', async () => {
    const { attemptId, linkId } = await seedDeferred('c_deferred_unknown');

    mockedGetCall.mockResolvedValue(null);

    await expect(closeStaleAttempts(NOW)).resolves.toBe(1);

    // The status stays what the carrier said — the call did end — and the
    // stamp takes it out of the sweep. Only the resolution is invented, the
    // same way an abandoned call's is: a retryable silence.
    const attempt = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(attempt.status).toBe('COMPLETED');
    expect(attempt.resolvedAt).not.toBeNull();
    expect(attempt.chargedAt).toBeNull();

    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: linkId } });
    expect(contact.status).toBe('PENDING');
    expect(contact.attempts).toBe(2);

    // Stamped, it is no longer stale: the next pass leaves it alone.
    await expect(closeStaleAttempts(NOW)).resolves.toBe(0);
  });
});

/**
 * The claim-side reaper.
 *
 * Between the claim (`PENDING -> QUEUED`) and the placement worker's
 * attempt-row insert, the contact's only durable record is `claimedAt` — no
 * `CallAttempt` exists yet, so `closeStaleAttempts` cannot see it, and
 * `claimContacts` selects only `PENDING` so it can never be re-claimed. A
 * placement job lost in that window (a second stall, a Redis flush, a
 * shutdown cutting the failed-handler's release) stranded the contact in
 * `QUEUED` forever, and `UNFINISHED_CONTACT_STATUSES` counts `QUEUED`, so its
 * campaign could never complete — stop, complete and auto-complete were all
 * dead ends. `releaseStaleClaims` is the recovery the design doc promised:
 * a `QUEUED` row whose lease expired with no attempt started since the claim
 * goes back to `PENDING`, timestamps untouched.
 */
describe('releasing stale claims', () => {
  const LEASE_EXPIRED = new Date(NOW.getTime() - 10 * 60_000);

  async function seedClaim(options: {
    claimedAt: Date | null;
    attempt?: { startedAt: Date; status?: 'QUEUED' | 'COMPLETED' };
    callback?: { at: Date };
  }) {
    const account = await makeAccount(`l${Math.random().toString(36).slice(2, 7)}`);
    const workspace = await makeWorkspace(account, 'Leases');
    const agent = await makeAgent(workspace, 'caller');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'Outreach', agentId: agent.id, status: 'RUNNING' },
    });
    const contact = await prisma.contact.create({
      data: { workspaceId: workspace.id, phone: `+9198765${Math.floor(Math.random() * 100000)}` },
    });
    const link = await prisma.campaignContact.create({
      data: {
        campaignId: campaign.id,
        contactId: contact.id,
        status: 'QUEUED',
        attempts: 1,
        claimedAt: options.claimedAt,
        lastAttemptAt: options.claimedAt,
        ...(options.callback
          ? { callbackAt: options.callback.at, nextEligibleAt: options.callback.at }
          : {}),
      },
    });

    if (options.attempt) {
      await prisma.callAttempt.create({
        data: {
          campaignId: campaign.id,
          campaignContactId: link.id,
          workspaceId: workspace.id,
          accountId: account.id,
          attemptNo: 1,
          status: options.attempt.status ?? 'QUEUED',
          startedAt: options.attempt.startedAt,
          upstreamCallId: `c_${Math.random().toString(36).slice(2, 10)}`,
          rateCreditsPerMin: toInternalCredits('1.00'),
        },
      });
    }

    return { linkId: link.id };
  }

  it('gives back a claim past its lease with no attempt started since', async () => {
    const { linkId } = await seedClaim({ claimedAt: LEASE_EXPIRED });

    await expect(releaseStaleClaims(NOW)).resolves.toBe(1);

    const row = await prisma.campaignContact.findUniqueOrThrow({ where: { id: linkId } });
    expect(row.status).toBe('PENDING');
    expect(row.claimedAt).toBeNull();
    // A give-back never counts a dial that never left.
    expect(row.attempts).toBe(1);
  });

  it('leaves a claim inside its lease alone', async () => {
    const { linkId } = await seedClaim({ claimedAt: new Date(NOW.getTime() - 60_000) });

    await expect(releaseStaleClaims(NOW)).resolves.toBe(0);

    const row = await prisma.campaignContact.findUniqueOrThrow({ where: { id: linkId } });
    expect(row.status).toBe('QUEUED');
  });

  it('leaves a claim whose dial is in flight alone', async () => {
    // The placement worker ran: an attempt started at the claim's own instant
    // exists, and closeStaleAttempts owns that row's fate, not this sweep.
    const { linkId } = await seedClaim({
      claimedAt: LEASE_EXPIRED,
      attempt: { startedAt: LEASE_EXPIRED },
    });

    await expect(releaseStaleClaims(NOW)).resolves.toBe(0);

    const row = await prisma.campaignContact.findUniqueOrThrow({ where: { id: linkId } });
    expect(row.status).toBe('QUEUED');
  });

  it('releases a claim whose only attempts predate it', async () => {
    // Earlier dials settled; this claim's own placement never ran. The stale
    // history must not shadow the lost job.
    const { linkId } = await seedClaim({
      claimedAt: LEASE_EXPIRED,
      attempt: { startedAt: new Date(LEASE_EXPIRED.getTime() - 60 * 60_000), status: 'COMPLETED' },
    });

    await expect(releaseStaleClaims(NOW)).resolves.toBe(1);

    const row = await prisma.campaignContact.findUniqueOrThrow({ where: { id: linkId } });
    expect(row.status).toBe('PENDING');
  });

  it('keeps an armed callback armed through the release', async () => {
    const promised = new Date(NOW.getTime() + 24 * 60 * 60_000);
    const { linkId } = await seedClaim({ claimedAt: LEASE_EXPIRED, callback: { at: promised } });

    await expect(releaseStaleClaims(NOW)).resolves.toBe(1);

    const row = await prisma.campaignContact.findUniqueOrThrow({ where: { id: linkId } });
    expect(row.status).toBe('PENDING');
    // The invariant: nextEligibleAt == callbackAt, both non-null, is the sole
    // marker of an armed callback. The release moves neither column.
    expect(row.callbackAt).toEqual(promised);
    expect(row.nextEligibleAt).toEqual(promised);
  });

  it('leaves a row claimed before the column existed alone', async () => {
    const { linkId } = await seedClaim({ claimedAt: null });

    await expect(releaseStaleClaims(NOW)).resolves.toBe(0);

    const row = await prisma.campaignContact.findUniqueOrThrow({ where: { id: linkId } });
    expect(row.status).toBe('QUEUED');
  });
});
