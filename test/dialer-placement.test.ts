import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The placement job, and the one thing it must never do.
 *
 * A placement job may be lost, delayed, run late or run twice. Three of those
 * are survivable — the contact stays claimed and the cleanup sweep gives it
 * back — and the fourth is a second telephone call to somebody who has already
 * been called. Everything in this file is about the fourth.
 *
 * The property under test is not "the job is never retried". It is retried,
 * three times, on purpose: a request that went out and whose answer was lost is
 * the exact case a retry is *for*, because the platform can tell us what became
 * of it. The property is that a retry can never mint a second dial identity —
 * it re-finds the attempt row its first run wrote, and therefore dials under
 * the reference the platform already de-duplicates on.
 */
vi.mock('../src/adapter/vocobase.js', () => ({
  startCall: vi.fn(),
  getConcurrency: vi.fn(),
  getCall: vi.fn(),
}));

const { getCall, getConcurrency, startCall } = await import('../src/adapter/vocobase.js');
const { runDialerSweep } = await import('../src/services/dialer.js');
const { placeClaimedCall } = await import('../src/services/dialerPlacement.js');
const { callPlacementQueue } = await import('../src/lib/queue/queues.js');
const { clearPlacements, closePlacementQueue } = await import('./dialer-pass.js');
const { prisma } = await import('../src/lib/prisma.js');
const { ApiError } = await import('../src/lib/errors.js');
const { flushNotifications } = await import('../src/lib/notify.js');
const { toInternalCredits } = await import('../src/lib/credits.js');
const { truncateAll } = await import('./setup.js');
const { makeAccount, makeAgent, makeWorkspace, makePhoneNumber } = await import('./helpers.js');

const mockedStartCall = vi.mocked(startCall);
const mockedGetConcurrency = vi.mocked(getConcurrency);
const mockedGetCall = vi.mocked(getCall);

const NOW = new Date('2026-08-30T10:00:00Z');

let seeded = 0;

async function seed(contacts = 1, concurrencyLimit = 5) {
  seeded += 1;
  const account = await makeAccount(`p${Math.random().toString(36).slice(2, 7)}`);
  await prisma.account.update({
    where: { id: account.id },
    data: { credits: toInternalCredits('100'), concurrencyLimit: 10 },
  });

  const workspace = await makeWorkspace(account, 'Placers');
  const agent = await makeAgent(workspace, 'caller');
  await prisma.agent.update({ where: { id: agent.id }, data: { voiceTierSlug: 'va-pro' } });
  await prisma.tier.upsert({
    where: { slug: 'va-pro' },
    update: {},
    create: {
      slug: 'va-pro',
      name: 'Pro',
      defaultPriceCreditsPerMin: toInternalCredits('1.00'),
      isDefault: true,
    },
  });
  const did = await makePhoneNumber(workspace, `+9180119900${String(10 + seeded).slice(-2)}`, 'ASSIGNED');

  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: workspace.id,
      name: 'Outreach',
      agentId: agent.id,
      phoneNumberId: did.id,
      status: 'RUNNING',
      concurrencyLimit,
      retryCount: 2,
      cooldownMinutes: 30,
    },
  });

  const links: string[] = [];

  for (let i = 0; i < contacts; i += 1) {
    const contact = await prisma.contact.create({
      data: { workspaceId: workspace.id, phone: `+91987655${String(3000 + i).slice(-4)}` },
    });
    const link = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });
    links.push(link.id);
  }

  return { campaignId: campaign.id, links };
}

/** The jobs one tick posted, oldest first — the payloads a worker would get. */
async function postedJobs() {
  const jobs = await callPlacementQueue.getJobs(['waiting', 'delayed', 'prioritized'], 0, -1);
  jobs.sort((a, b) => Number(a.id) - Number(b.id));

  return jobs.map((job) => job.data);
}

const call = (id: string) => ({ call_id: `c_${id}`, session_id: `s_${id}`, status: 'pending' });

const references = () => mockedStartCall.mock.calls.map((args) => args[0]!.client_reference_id);

beforeEach(async () => {
  await truncateAll();
  await clearPlacements();
  vi.clearAllMocks();
  mockedGetConcurrency.mockResolvedValue({ limit: 100, active: 0, remaining: 100 });
  mockedGetCall.mockResolvedValue(null);
  mockedStartCall.mockImplementation(async () => call(Math.random().toString(36).slice(2, 8)));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  await flushNotifications();
  await truncateAll();
  vi.restoreAllMocks();
});

afterAll(closePlacementQueue);

describe('a retried placement job', () => {
  /**
   * The headline. A job that ran to completion and came back — a stall, a
   * redelivery, a worker killed between the dial and the acknowledgement — must
   * not place a second call.
   */
  it('cannot dial twice', async () => {
    const { links } = await seed(1);
    await runDialerSweep({ now: NOW });
    const [job] = await postedJobs();

    const first = await placeClaimedCall(job!);
    const second = await placeClaimedCall(job!);

    expect(first.disposition).toBe('launched');
    // Not a launch and not a failure. The call is on the phone; saying so
    // twice would double every figure the campaign reports.
    expect(second.disposition).toBe('already-placed');
    expect(mockedStartCall).toHaveBeenCalledTimes(1);

    const attempts = await prisma.callAttempt.findMany({
      where: { campaignContactId: links[0] },
    });
    expect(attempts).toHaveLength(1);
  });

  /**
   * The case the retry policy exists for, and the one that would be a second
   * call under a derived attempt number.
   *
   * The request went out and the answer never came back, so the attempt row is
   * open and carries no upstream id. The retry has to ask again — that is the
   * only way to learn what happened — and it must ask under **the same
   * reference**, which the platform answers with the call it already placed
   * rather than by dialing again.
   */
  it('does not redial after dying with the dial-attempt row already inserted', async () => {
    const { links } = await seed(1);
    await runDialerSweep({ now: NOW });
    const [job] = await postedJobs();

    mockedStartCall.mockRejectedValueOnce(
      new ApiError(502, 'UPSTREAM_WRITE_UNCONFIRMED', 'the platform did not answer'),
    );

    const first = await placeClaimedCall(job!);
    const second = await placeClaimedCall(job!);

    expect(first.disposition).toBe('launch-failed');
    expect(second.disposition).toBe('launched');

    // One row, reused. Two rows would be two references, and two references is
    // two calls: the platform de-duplicates on the reference and nothing else.
    const attempts = await prisma.callAttempt.findMany({
      where: { campaignContactId: links[0] },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.attemptNo).toBe(1);

    const [firstRef, secondRef] = references();
    expect(mockedStartCall).toHaveBeenCalledTimes(2);
    expect(secondRef).toBe(firstRef);
    expect(firstRef).toContain(attempts[0]!.id);
  });

  /**
   * The contact moved on while the job sat in the queue — a stop, the cleanup
   * sweep, an operator, a webhook. The job is the continuation of a decision
   * Postgres has since unmade, so there is nothing to continue, and above all
   * nothing to take back.
   */
  it('exits without dialing when the contact is no longer claimed', async () => {
    const { links } = await seed(1);
    await runDialerSweep({ now: NOW });
    const [job] = await postedJobs();

    await prisma.campaignContact.update({
      where: { id: links[0]! },
      data: { status: 'COMPLETED' },
    });

    const result = await placeClaimedCall(job!);

    expect(result.disposition).toBe('not-claimed');
    expect(mockedStartCall).not.toHaveBeenCalled();
    // Left exactly as the owner wrote it.
    const row = await prisma.campaignContact.findUniqueOrThrow({ where: { id: links[0]! } });
    expect(row.status).toBe('COMPLETED');
  });
});

describe('a halted batch', () => {
  /**
   * The `break` the sequential loop had, reconstructed.
   *
   * The first contact's dial is rate limited, which is account-wide: every
   * remaining contact in the batch would meet the identical wall. The rest of
   * the batch is given back **untouched** — no cooldown, no consumed attempt,
   * no timestamp moved — because nothing was attempted for them.
   */
  it('releases its remainder untouched and never dials it', async () => {
    const { links } = await seed(3);
    await runDialerSweep({ now: NOW });
    const jobs = await postedJobs();
    expect(jobs).toHaveLength(3);

    mockedStartCall.mockRejectedValueOnce(
      new ApiError(429, 'UPSTREAM_RATE_LIMITED', 'too many requests'),
    );

    const first = await placeClaimedCall(jobs[0]!);
    expect(first.halt).toBe('rate_limited');

    for (const job of jobs.slice(1)) {
      expect((await placeClaimedCall(job)).disposition).toBe('batch-halted');
    }

    // One request, for the contact that met the wall. The other two cost a
    // Redis read each.
    expect(mockedStartCall).toHaveBeenCalledTimes(1);

    const remainder = await prisma.campaignContact.findMany({
      where: { id: { in: links.slice(1) } },
    });
    for (const row of remainder) {
      expect(row.status).toBe('PENDING');
      expect(row.attempts).toBe(0);
      expect(row.nextEligibleAt).toBeNull();
      expect(row.callbackAt).toBeNull();
    }
    // And no attempt row, so there is nothing for the reaper to reconcile.
    expect(
      await prisma.callAttempt.count({ where: { campaignContactId: { in: links.slice(1) } } }),
    ).toBe(0);
  });

  /**
   * A halt is per batch, not per campaign and not global. The next tick claims
   * again, and its jobs must not inherit the last one's refusal — otherwise a
   * single 429 would stop a campaign until a key expired.
   */
  it('does not hold over into the next pass', async () => {
    await seed(2, 1);
    await runDialerSweep({ now: NOW });
    const [firstJob] = await postedJobs();

    mockedStartCall.mockRejectedValueOnce(
      new ApiError(429, 'UPSTREAM_RATE_LIMITED', 'too many requests'),
    );
    await placeClaimedCall(firstJob!);
    await callPlacementQueue.obliterate({ force: true });

    // A minute later, past the give-back's cooldown.
    const later = new Date(NOW.getTime() + 60 * 60_000);
    await runDialerSweep({ now: later });
    const [nextJob] = await postedJobs();

    expect(nextJob!.batchId).not.toBe(firstJob!.batchId);
    expect((await placeClaimedCall(nextJob!)).disposition).toBe('launched');
  });
});

describe("the attempt row's clock", () => {
  /**
   * The release sweep and the pending-placement counts both decide "this
   * claim's placement ran" by `startedAt >= claimedAt`, and `claimedAt` is
   * stamped from the injected sweep clock. A database-default `startedAt` is
   * a different clock: the moment the sweep clock is ahead of the database's
   * — which is every tick of the virtual-clock harnesses — a placed dial
   * reads as a claim whose job never ran, so it is released mid-call and
   * counted as backlog against every cap.
   */
  it('stamps startedAt from the tick clock, not the database clock', async () => {
    const { links } = await seed(1);
    await runDialerSweep({ now: NOW });
    const [job] = await postedJobs();

    await placeClaimedCall(job!);

    const attempt = await prisma.callAttempt.findFirstOrThrow({
      where: { campaignContactId: links[0] },
    });
    expect(attempt.startedAt.getTime()).toBe(NOW.getTime());
  });
});
