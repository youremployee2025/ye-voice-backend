import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sweep, and above all the things it refuses to do.
 *
 * The adapter is mocked in every case: this suite must never place a call, and
 * it must pass with the real client unloaded. That is not a convenience — it
 * is the reason the suite may be run at all.
 */
vi.mock('../src/adapter/vocobase.js', () => ({
  startCall: vi.fn(),
  getConcurrency: vi.fn(),
  getCall: vi.fn(),
  clearPhoneNumberAgent: vi.fn(async () => undefined),
}));

const { getCall, getConcurrency, startCall } = await import('../src/adapter/vocobase.js');
const { runDialerPass, drainPlacements, clearPlacements, closePlacementQueue } =
  await import('./dialer-pass.js');
const { runDialerSweep } = await import('../src/services/dialer.js');
const { prisma } = await import('../src/lib/prisma.js');
const { flushNotifications } = await import('../src/lib/notify.js');
const { toInternalCredits } = await import('../src/lib/credits.js');
const { env } = await import('../src/lib/env.js');
const { truncateAll } = await import('./setup.js');
const { makeAccount, makeAgent, makeWorkspace, makePhoneNumber } = await import('./helpers.js');

const mockedStartCall = vi.mocked(startCall);
const mockedGetConcurrency = vi.mocked(getConcurrency);
const mockedGetCall = vi.mocked(getCall);

const NOW = new Date('2026-08-30T10:00:00Z');

interface Fixture {
  accountId: string;
  workspaceId: string;
  campaignId: string;
  contactIds: string[];
  didId: string | null;
  agentId: string;
}

async function seed(
  options: {
    contacts?: number;
    concurrencyLimit?: number;
    accountConcurrency?: number | null;
    credits?: string;
    window?: {
      fromTime: string | null;
      toTime: string | null;
      timezone: string | null;
      dialDays?: number[];
    };
    phones?: string[];
    withNumber?: boolean;
    agentStatus?: string;
    type?: 'OUTBOUND' | 'INBOUND' | 'BOTH';
  } = {},
): Promise<Fixture> {
  const {
    contacts = 1,
    concurrencyLimit = 2,
    accountConcurrency = 10,
    credits = '100',
    window = { fromTime: null, toTime: null, timezone: null },
    phones,
    withNumber = true,
    agentStatus = 'active',
    type = 'OUTBOUND',
  } = options;

  const account = await makeAccount(`dial${Math.random().toString(36).slice(2, 7)}`);
  await prisma.account.update({
    where: { id: account.id },
    data: { credits: toInternalCredits(credits), concurrencyLimit: accountConcurrency },
  });

  const workspace = await makeWorkspace(account, 'Dialers');
  const agent = await makeAgent(workspace, 'caller', agentStatus);
  await prisma.agent.update({
    where: { id: agent.id },
    data: { voiceTierSlug: 'va-pro', variables: ['name', 'city'] },
  });

  await prisma.tier.create({
    data: {
      slug: 'va-pro',
      name: 'Pro',
      defaultPriceCreditsPerMin: toInternalCredits('1.00'),
      isDefault: true,
    },
  });

  const did = withNumber ? await makePhoneNumber(workspace, '+918011223344', 'ASSIGNED') : null;

  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: workspace.id,
      name: 'Outreach',
      agentId: agent.id,
      phoneNumberId: did?.id ?? null,
      status: 'RUNNING',
      type,
      concurrencyLimit,
      ...window,
    },
  });

  const contactIds: string[] = [];

  for (let i = 0; i < contacts; i += 1) {
    const phone = phones?.[i] ?? `+91987650${String(1000 + i).slice(-4)}`;
    const contact = await prisma.contact.create({
      data: { workspaceId: workspace.id, phone, name: `Contact ${i}`, metadata: { city: 'Pune' } },
    });
    const link = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });
    contactIds.push(link.id);
  }

  return {
    accountId: account.id,
    workspaceId: workspace.id,
    campaignId: campaign.id,
    contactIds,
    didId: did?.id ?? null,
    agentId: agent.id,
  };
}

/** The claim a RUNNING inbound-facing campaign holds on its DID. */
async function claimDid(f: Fixture) {
  await prisma.campaignInboundClaim.create({
    data: { phoneNumberId: f.didId!, campaignId: f.campaignId, agentId: f.agentId },
  });
}

const call = (id: string) => ({ call_id: `c_${id}`, session_id: `s_${id}`, status: 'pending' });

beforeEach(async () => {
  await truncateAll();
  await clearPlacements();
  vi.clearAllMocks();
  process.env.DIALER_ENABLED = 'true';
  mockedGetConcurrency.mockResolvedValue({ limit: 100, active: 0, remaining: 100 });
  mockedStartCall.mockImplementation(async () => call(Math.random().toString(36).slice(2, 8)));
  mockedGetCall.mockResolvedValue(null);
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

describe('the master switch', () => {
  /**
   * The headline safety property. Everything else in this file assumes the
   * dialer is on; this is the case that says it does not have to be.
   */
  it('places no call and makes no upstream request at all when disabled', async () => {
    vi.resetModules();
    process.env.DIALER_ENABLED = 'false';
    const { runDialerSweep: disabled } = await import('../src/services/dialer.js');

    await seed({ contacts: 3 });

    const result = await disabled({ now: NOW });

    expect(result.launched).toBe(0);
    expect(mockedStartCall).not.toHaveBeenCalled();
    // Not even the pool read: an inert module makes no requests of any kind.
    expect(mockedGetConcurrency).not.toHaveBeenCalled();

    vi.resetModules();
    process.env.DIALER_ENABLED = 'true';
  });
});

describe('the shared call pool', () => {
  it('launches nothing when the pool cannot be read', async () => {
    mockedGetConcurrency.mockRejectedValue(new Error('pool down'));
    await seed({ contacts: 2 });

    const result = await runDialerPass({ now: NOW });

    // Fail closed. A skipped pass self-heals in a minute; guessing at the
    // headroom of a shared account does not.
    expect(result.halted).toBe('pool_unreadable');
    expect(mockedStartCall).not.toHaveBeenCalled();
  });

  it('does not pause anything when the pool cannot be read', async () => {
    mockedGetConcurrency.mockRejectedValue(new Error('pool down'));
    const { campaignId } = await seed({ contacts: 2 });

    await runDialerPass({ now: NOW });

    // A supplier outage is not the customer's fault and must not stop their
    // campaign; the next pass simply picks it up.
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe('RUNNING');
  });

  /**
   * `remaining: null` means the partner account is uncapped. A `?? 0` anywhere
   * on this path would stop an unlimited platform placing a single call — a
   * failure that looks exactly like a dialer that is switched off.
   */
  it('treats an unlimited pool as unlimited rather than as zero', async () => {
    mockedGetConcurrency.mockResolvedValue({
      limit: null,
      active: 7,
      remaining: null,
      limit_source: 'partner_unlimited',
    });
    await seed({ contacts: 2 });

    const result = await runDialerPass({ now: NOW });

    expect(result.launched).toBe(2);
  });

  it('never launches more than the pool has left', async () => {
    mockedGetConcurrency.mockResolvedValue({ limit: 100, active: 99, remaining: 1 });
    await seed({ contacts: 5, concurrencyLimit: 5 });

    const result = await runDialerPass({ now: NOW });

    expect(result.launched).toBe(1);
  });
});

describe('the caps', () => {
  it("respects the campaign's own concurrency", async () => {
    await seed({ contacts: 5, concurrencyLimit: 2 });

    const result = await runDialerPass({ now: NOW });

    expect(result.launched).toBe(2);
  });

  it("respects the account's allotment across its campaigns", async () => {
    await seed({ contacts: 5, concurrencyLimit: 5, accountConcurrency: 3 });

    const result = await runDialerPass({ now: NOW });

    expect(result.launched).toBe(3);
  });

  it('counts calls already in flight against both caps', async () => {
    const { campaignId, workspaceId, accountId, contactIds } = await seed({
      contacts: 5,
      concurrencyLimit: 3,
    });

    await prisma.callAttempt.create({
      data: {
        campaignId,
        campaignContactId: contactIds[0]!,
        workspaceId,
        accountId,
        attemptNo: 1,
        status: 'IN_PROGRESS',
        // Explicit, and recent relative to `NOW`. Left at the column default
        // this row is stamped with the real clock, which is far enough behind
        // the injected `now` that the reaper closes it as stale and frees the
        // very slot this case exists to prove is occupied.
        startedAt: new Date(NOW.getTime() - 30_000),
      },
    });

    const result = await runDialerPass({ now: NOW });

    expect(result.launched).toBe(2);
  });

  /**
   * Zero is a limit somebody set. An account staff have deliberately stopped
   * must stay stopped.
   */
  it('dials nothing for an account allotted zero lines', async () => {
    await seed({ contacts: 3, accountConcurrency: 0 });

    const result = await runDialerPass({ now: NOW });

    expect(result.launched).toBe(0);
    expect(mockedStartCall).not.toHaveBeenCalled();
  });

  it('never launches more than the per-sweep blast radius', async () => {
    vi.resetModules();
    process.env.DIALER_MAX_CALLS_PER_SWEEP = '2';
    const { runDialerSweep: capped } = await import('../src/services/dialer.js');

    await seed({ contacts: 10, concurrencyLimit: 10, accountConcurrency: 10 });

    const result = await capped({ now: NOW });

    // The blast radius is a *claim* budget now: the pass commits to two dials
    // and posts them. It is the same ceiling asserted one step earlier, which
    // is where the pass now stops.
    expect(result.posted).toBe(2);
    await drainPlacements(result);
    expect(result.launched).toBe(2);

    vi.resetModules();
    delete process.env.DIALER_MAX_CALLS_PER_SWEEP;
  });
});

/**
 * Two lanes out of one limit.
 *
 * Without a reservation the fresh list and the retry queue compete in one FIFO
 * pool, and whichever is larger starves the other: a long tail of retries stops
 * a fresh list ever being reached, and a fresh list of ten thousand rows means
 * a retry promised twenty minutes ago waits for hours.
 */
describe('the reserved retry lane', () => {
  /** The first `retries` contacts become due retries; the rest stay fresh. */
  async function withLanes(options: {
    contacts: number;
    retries: number;
    concurrencyLimit: number;
    retryConcurrency: number;
  }): Promise<Fixture> {
    const fixture = await seed({
      contacts: options.contacts,
      concurrencyLimit: options.concurrencyLimit,
    });

    await prisma.campaign.update({
      where: { id: fixture.campaignId },
      data: { retryConcurrency: options.retryConcurrency },
    });

    await prisma.campaignContact.updateMany({
      where: { id: { in: fixture.contactIds.slice(0, options.retries) } },
      data: { armKind: 'RETRY', attempts: 1, nextEligibleAt: new Date(NOW.getTime() - 60_000) },
    });

    return fixture;
  }

  const claimed = async (campaignId: string) =>
    (
      await prisma.campaignContact.findMany({
        where: { campaignId, status: 'QUEUED' },
        orderBy: { createdAt: 'asc' },
      })
    ).map((row) => row.id);

  it('holds slots for retries and gives the rest to the fresh list', async () => {
    const { campaignId, contactIds } = await withLanes({
      contacts: 6,
      retries: 3,
      concurrencyLimit: 3,
      retryConcurrency: 1,
    });

    const result = await runDialerPass({ now: NOW });

    expect(result.launched).toBe(3);
    // One retry — its reserved slot — and two fresh, which is the rest of the
    // limit. The two lanes together never exceed it.
    expect(await claimed(campaignId)).toEqual([contactIds[0], contactIds[3], contactIds[4]]);
  });

  /**
   * The same queue with no reservation, to show what the reservation is for:
   * the retries are older, so a single FIFO pool hands them every slot and the
   * fresh list is not reached at all.
   */
  it('is what stops the older lane taking everything', async () => {
    const { campaignId, contactIds } = await withLanes({
      contacts: 6,
      retries: 3,
      concurrencyLimit: 3,
      retryConcurrency: 0,
    });

    await runDialerPass({ now: NOW });

    expect(await claimed(campaignId)).toEqual(contactIds.slice(0, 3));
  });

  /**
   * A reservation costs no throughput when only one lane has work. The borrow
   * pass lends the empty lane's slots to the other rather than leaving them
   * idle beside a queue.
   */
  it('lends an empty lane’s slots to the other', async () => {
    const { campaignId } = await withLanes({
      contacts: 6,
      retries: 0,
      concurrencyLimit: 3,
      retryConcurrency: 1,
    });

    const result = await runDialerPass({ now: NOW });

    // Two from the fresh lane's own budget and one borrowed from the retry
    // lane, which had nothing to spend it on.
    expect(result.launched).toBe(3);
    expect(await claimed(campaignId)).toHaveLength(3);
  });

  /**
   * A callback is the only entry in this queue carrying a time a human being
   * was told. It goes first, and out of the same budget as everything else
   * rather than an extra allowance.
   */
  it('serves a due callback before anything else', async () => {
    const { campaignId, contactIds } = await seed({ contacts: 4, concurrencyLimit: 1 });
    const promised = new Date(NOW.getTime() - 60_000);
    // The newest contact in the list, so FIFO alone would reach it last.
    await prisma.campaignContact.update({
      where: { id: contactIds[3]! },
      data: { armKind: 'CALLBACK', callbackAt: promised, nextEligibleAt: promised },
    });

    const result = await runDialerPass({ now: NOW });

    expect(result.launched).toBe(1);
    const queued = await prisma.campaignContact.findMany({ where: { campaignId, status: 'QUEUED' } });
    expect(queued.map((row) => row.id)).toEqual([contactIds[3]]);
  });
});

/**
 * A herd of promises coming due at once, on a campaign with no fresh list.
 *
 * This is the report the split exists for. `rollIntoDialWindow` builds every
 * booked instant through `instantOf`, which zeroes seconds, so every promise
 * booked while the dial window was shut lands on the opening minute together.
 * Production, 2026-09-07: two campaigns on `concurrencyLimit = 11` with a
 * `10:00–20:00 Asia/Kolkata` window and 64 promises stacked on one instant
 * placed 192 and then 260 callbacks in two quarter-hours and dialled ZERO
 * retries, with ~880 of them eligible the whole time.
 *
 * Both halves of the old shape are in this fixture: the callback lane drew
 * from the whole pass budget before any reservation existed, and the borrow
 * pass that was meant to give the slots back was one unfiltered claim ordered
 * with `CALLBACK` first — so it handed them straight back to the herd. With
 * the fresh list empty, the borrow is where every slot is spent.
 */
describe('a callback herd', () => {
  /** Ten promises all due on the same instant, ten retries that have waited
   *  far longer, and nothing left in the fresh lane. */
  async function withHerd(retrySharePercent: number): Promise<Fixture> {
    const fixture = await seed({ contacts: 20, concurrencyLimit: 11, accountConcurrency: 22 });

    await prisma.campaign.update({
      where: { id: fixture.campaignId },
      data: { retryConcurrency: 3, retrySharePercent },
    });

    const due = new Date(NOW.getTime() - 60_000);

    await prisma.campaignContact.updateMany({
      where: { id: { in: fixture.contactIds.slice(0, 10) } },
      data: { armKind: 'CALLBACK', attempts: 1, callbackAt: due, nextEligibleAt: due },
    });

    await prisma.campaignContact.updateMany({
      where: { id: { in: fixture.contactIds.slice(10) } },
      data: { armKind: 'RETRY', attempts: 1, nextEligibleAt: due },
    });

    return fixture;
  }

  const dialed = async (campaignId: string): Promise<Record<string, number>> => {
    const rows = await prisma.callAttempt.groupBy({
      by: ['kind'],
      where: { campaignId },
      _count: { _all: true },
    });

    return Object.fromEntries(rows.map((row) => [row.kind, row._count._all]));
  };

  it('does not stop the retry lane dialing', async () => {
    const { campaignId } = await withHerd(60);

    const result = await runDialerPass({ now: NOW });

    expect(result.launched).toBe(11);
    // The share is taken over the whole occupancy the pass produces, not over
    // each pool in turn: `floor(11 * 0.6) = 6` for retries, and the herd takes
    // the five the split did not hold. Divided pool by pool the floors would
    // round down twice and retries would get five.
    expect(await dialed(campaignId)).toEqual({ retry: 6, callback: 5 });
  });

  /**
   * The column default, and the whole safety story of the migration: at 0 the
   * pass must place exactly what it placed before the split existed. The herd
   * takes every line and the retry queue gets the one slot left over.
   */
  it('at a share of 0 still lets the herd take the pass', async () => {
    const { campaignId } = await withHerd(0);

    await runDialerPass({ now: NOW });

    expect(await dialed(campaignId)).toEqual({ callback: 10, retry: 1 });
  });

  /**
   * The same default, on a campaign that still has a fresh list. Before the
   * split a promise drew from the WHOLE pass budget and beat every list
   * position; the reservation was never a ceiling on it. At the column default
   * that has to stay exactly so, or the migration re-paces every importing
   * campaign with a reservation — the ten promises go out and the fresh list
   * gets the one slot left, not the other way round.
   */
  it('at a share of 0 still runs the herd ahead of the fresh list', async () => {
    const fixture = await seed({ contacts: 20, concurrencyLimit: 11, accountConcurrency: 22 });

    await prisma.campaign.update({
      where: { id: fixture.campaignId },
      data: { retryConcurrency: 3, retrySharePercent: 0 },
    });

    const due = new Date(NOW.getTime() - 60_000);

    await prisma.campaignContact.updateMany({
      where: { id: { in: fixture.contactIds.slice(0, 10) } },
      data: { armKind: 'CALLBACK', attempts: 1, callbackAt: due, nextEligibleAt: due },
    });

    const result = await runDialerPass({ now: NOW });

    expect(result.launched).toBe(11);
    expect(await dialed(fixture.campaignId)).toEqual({ callback: 10, fresh: 1 });
  });

  /**
   * No reservation — the column default nearly every campaign runs on — and
   * a share set. The urgent lanes are held to their share first, and what the
   * routine lane then leaves must go back to them: a slot held open for a
   * fresh contact that does not exist is a promise not kept, and on the next
   * pass the urgent count is unchanged so the same slot idles again, for ever.
   */
  it('with no reservation hands the slots the routine lane left back to the herd', async () => {
    const fixture = await seed({ contacts: 17, concurrencyLimit: 11, accountConcurrency: 22 });

    await prisma.campaign.update({
      where: { id: fixture.campaignId },
      data: { retryConcurrency: 0, retrySharePercent: 60 },
    });

    const due = new Date(NOW.getTime() - 60_000);

    await prisma.campaignContact.updateMany({
      where: { id: { in: fixture.contactIds.slice(0, 15) } },
      data: { armKind: 'CALLBACK', attempts: 1, callbackAt: due, nextEligibleAt: due },
    });

    const result = await runDialerPass({ now: NOW });

    // Five promises at their share, both fresh contacts, then the four slots
    // nothing else could use go to the promises still waiting.
    expect(result.launched).toBe(11);
    expect(await dialed(fixture.campaignId)).toEqual({ callback: 9, fresh: 2 });
  });
});

/**
 * The resume lane, and the reservation it shares with retries.
 *
 * A dropped conversation is the most time-sensitive dial the engine places, so
 * it used to reach the front by arming the pair the callback lane read — and
 * that lane draws from the whole pass budget. A bad minute upstream therefore
 * turned every drop into a claim on every slot the campaign had: ten drops on
 * `concurrencyLimit = 10, retryConcurrency = 2` claimed all ten and dialled
 * nobody off the fresh list. The lane is now bounded by `nonFreshBudget`.
 */
describe('the resume lane', () => {
  /** The first `resumes` contacts become dropped conversations the engine is
   *  going back to; the rest stay fresh. */
  async function withResumes(options: {
    contacts: number;
    resumes: number;
    concurrencyLimit: number;
    retryConcurrency: number;
  }): Promise<Fixture> {
    const fixture = await seed({
      contacts: options.contacts,
      concurrencyLimit: options.concurrencyLimit,
    });

    await prisma.campaign.update({
      where: { id: fixture.campaignId },
      data: { retryConcurrency: options.retryConcurrency },
    });

    await prisma.campaignContact.updateMany({
      where: { id: { in: fixture.contactIds.slice(0, options.resumes) } },
      data: {
        armKind: 'RESUME',
        followUpCount: 1,
        nextEligibleAt: new Date(NOW.getTime() - 60_000),
      },
    });

    return fixture;
  }

  const claimedRows = (campaignId: string) =>
    prisma.campaignContact.findMany({
      where: { campaignId, status: 'QUEUED' },
      orderBy: { createdAt: 'asc' },
    });

  it('takes no more than the retry reservation, whatever the burst', async () => {
    // The reviewed shape, to the number: ten conversations drop inside one
    // window on a campaign whose limit is ten and whose reservation is two.
    const { campaignId, contactIds } = await withResumes({
      contacts: 18,
      resumes: 10,
      concurrencyLimit: 10,
      retryConcurrency: 2,
    });

    const result = await runDialerPass({ now: NOW });

    expect(result.launched).toBe(10);

    const queued = new Set((await claimedRows(campaignId)).map((row) => row.id));
    const resumesTaken = contactIds.slice(0, 10).filter((id) => queued.has(id));
    const freshTaken = contactIds.slice(10).filter((id) => queued.has(id));

    // Two resumes, which is the reservation — and the whole fresh list, which
    // is what the burst used to swallow: every one of the ten slots went to a
    // resume, and the campaign dialled nobody it had not already spoken to.
    expect(resumesTaken).toHaveLength(2);
    expect(freshTaken).toHaveLength(8);
  });

  /**
   * The reservation is one budget spent by two lanes, and the resume takes it
   * first: somebody is sitting on the other end of a call that cut out, which
   * nothing in the retry lane can say.
   */
  it('takes the shared reservation ahead of a plain retry', async () => {
    const { campaignId, contactIds } = await seed({ contacts: 4, concurrencyLimit: 2 });
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { retryConcurrency: 1 },
    });
    const due = new Date(NOW.getTime() - 60_000);
    // The oldest contact is the retry, so `createdAt` alone would take it.
    await prisma.campaignContact.update({
      where: { id: contactIds[0]! },
      data: { armKind: 'RETRY', attempts: 1, nextEligibleAt: due },
    });
    await prisma.campaignContact.update({
      where: { id: contactIds[1]! },
      data: { armKind: 'RESUME', followUpCount: 1, nextEligibleAt: due },
    });

    await runDialerPass({ now: NOW });

    const queued = (await claimedRows(campaignId)).map((row) => row.id);
    expect(queued).toContain(contactIds[1]);
    expect(queued).not.toContain(contactIds[0]);
  });

  /**
   * The borrow pass is what stops the bound from costing throughput: slots the
   * fresh lane cannot use are lent back, so a campaign with nothing but
   * resumes left still dials at its full limit.
   */
  it('borrows the fresh lane’s idle slots when there is nothing else to dial', async () => {
    const { campaignId } = await withResumes({
      contacts: 3,
      resumes: 3,
      concurrencyLimit: 3,
      retryConcurrency: 1,
    });

    const result = await runDialerPass({ now: NOW });

    expect(result.launched).toBe(3);
    expect(await claimedRows(campaignId)).toHaveLength(3);
  });

  /**
   * The label a dial answers to for the rest of its life is the lane it was
   * chosen out of.
   *
   * It used to be reconstructed at post time — a callback from the armed
   * timestamp pair, a follow-up from `followUpCount > 0` — and both readings
   * had drifted from the lane that actually picked the row. A contact the goal
   * engine followed up once and the retry ladder has re-armed since is dialled
   * as a retry and must say so: `followUpCount` never comes back down, so the
   * old derivation labelled every remaining dial of that contact's life a
   * follow-up.
   */
  it('stamps the attempt with the lane that claimed it', async () => {
    const { campaignId, contactIds } = await seed({ contacts: 2, concurrencyLimit: 2 });
    const due = new Date(NOW.getTime() - 60_000);
    await prisma.campaignContact.update({
      where: { id: contactIds[0]! },
      data: { armKind: 'RESUME', followUpCount: 1, nextEligibleAt: due },
    });
    await prisma.campaignContact.update({
      where: { id: contactIds[1]! },
      data: { armKind: 'RETRY', attempts: 1, followUpCount: 3, nextEligibleAt: due },
    });

    await runDialerPass({ now: NOW });

    const attempts = await prisma.callAttempt.findMany({ where: { campaignId } });
    const kindOf = (contactId: string) =>
      attempts.find((row) => row.campaignContactId === contactId)?.kind;

    expect(kindOf(contactIds[0]!)).toBe('resume');
    expect(kindOf(contactIds[1]!)).toBe('retry');
  });

  /**
   * `retryConcurrency` defaults to 0, so the shared lane is where most
   * campaigns do all of their dialing — and it was the one lane whose ordering
   * never consulted any of this. A resume queued behind the whole imported
   * list, on `createdAt`.
   */
  it('goes first in the shared lane a default-configured campaign uses', async () => {
    const { campaignId, contactIds } = await seed({ contacts: 4, concurrencyLimit: 1 });
    // The newest contact in the list, so FIFO alone would reach it last.
    await prisma.campaignContact.update({
      where: { id: contactIds[3]! },
      data: {
        armKind: 'RESUME',
        followUpCount: 1,
        nextEligibleAt: new Date(NOW.getTime() - 60_000),
      },
    });

    const result = await runDialerPass({ now: NOW });

    expect(result.launched).toBe(1);
    expect((await claimedRows(campaignId)).map((row) => row.id)).toEqual([contactIds[3]]);
  });
});

describe('the test allowlist', () => {
  it('dials only numbers on it, and skips the rest without marking them', async () => {
    vi.resetModules();
    process.env.DIALER_TEST_ALLOWLIST = '+919876501001';
    const { runDialerSweep: bounded } = await import('../src/services/dialer.js');

    const { contactIds } = await seed({
      contacts: 3,
      concurrencyLimit: 5,
      phones: ['+919876501000', '+919876501001', '+919876501002'],
    });

    const result = await bounded({ now: NOW });
    await drainPlacements(result);

    expect(result.launched).toBe(1);
    expect(result.skippedNotAllowlisted).toBe(2);
    expect(mockedStartCall).toHaveBeenCalledTimes(1);
    expect(mockedStartCall.mock.calls[0]![0]!.to_number).toBe('+919876501001');

    // Skipped contacts are left exactly as they were. Marking them EXCLUDED
    // would be an irreversible edit to the customer's own list, made by a test
    // switch.
    const untouched = await prisma.campaignContact.findMany({
      where: { id: { in: [contactIds[0]!, contactIds[2]!] } },
    });
    for (const row of untouched) {
      expect(row.status).toBe('PENDING');
      expect(row.attempts).toBe(0);
      expect(row.lastAttemptAt).toBeNull();
    }

    vi.resetModules();
    delete process.env.DIALER_TEST_ALLOWLIST;
  });
});

describe('what pauses a campaign', () => {
  it('pauses when the agent has left the workspace', async () => {
    const { campaignId } = await seed({ contacts: 1 });
    await prisma.agent.updateMany({ where: {}, data: { workspaceId: null } });

    const result = await runDialerPass({ now: NOW });

    expect(result.paused).toBe(1);
    expect(mockedStartCall).not.toHaveBeenCalled();
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe('PAUSED');
  });

  it('pauses when the agent has been retired upstream', async () => {
    await seed({ contacts: 1, agentStatus: 'removed' });

    const result = await runDialerPass({ now: NOW });

    expect(result.paused).toBe(1);
    expect(mockedStartCall).not.toHaveBeenCalled();
  });

  it('pauses when the campaign has no caller number', async () => {
    await seed({ contacts: 1, withNumber: false });

    const result = await runDialerPass({ now: NOW });

    expect(result.paused).toBe(1);
    expect(mockedStartCall).not.toHaveBeenCalled();
  });

  it('pauses when the number has gone back to the pool', async () => {
    await seed({ contacts: 1 });
    await prisma.phoneNumber.updateMany({
      where: {},
      data: { workspaceId: null, status: 'UNASSIGNED' },
    });

    const result = await runDialerPass({ now: NOW });

    expect(result.paused).toBe(1);
  });

  it("pauses when the owner's balance has fallen below the float", async () => {
    const { workspaceId, campaignId } = await seed({ contacts: 1, credits: '0' });

    const result = await runDialerPass({ now: NOW });

    expect(result.paused).toBe(1);
    expect(mockedStartCall).not.toHaveBeenCalled();

    // Its own status, not PAUSED. The operator did not stop this campaign, the
    // balance did — `resume` has to know to re-run the estimate, and the page
    // has to be able to say which of the two happened.
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe('CREDIT_EXHAUSTED');
    expect(campaign.pausedAt).toEqual(NOW);

    await flushNotifications();
    const notification = await prisma.notification.findFirst({
      where: { workspaceId, type: 'campaign.paused_insufficient_credits' },
    });
    // Credits are ADMIN-only data everywhere else in this service, and a
    // notification is not a place to make an exception to that.
    expect(notification?.scope).toBe('ADMINS_ONLY');
    expect(notification?.href).toBe('/settings/billing');
  });

  it('pauses when calling is not priced for the account', async () => {
    await seed({ contacts: 1 });
    await prisma.tier.updateMany({ where: {}, data: { defaultPriceCreditsPerMin: null } });

    const result = await runDialerPass({ now: NOW });

    // Unpriced is not free. A call placed at an unknown price is a call whose
    // cost is decided after the money is spent.
    expect(result.paused).toBe(1);
    expect(mockedStartCall).not.toHaveBeenCalled();
  });

  /**
   * The fail-closed window case. An operator who set one end was expressing a
   * restriction; reading it as "any hour" is how a campaign rings somebody at
   * 3am.
   */
  it('pauses on a half-configured dialing window', async () => {
    const { workspaceId } = await seed({
      contacts: 1,
      window: { fromTime: '09:00', toTime: null, timezone: 'Asia/Kolkata' },
    });

    const result = await runDialerPass({ now: NOW });

    expect(result.paused).toBe(1);
    expect(mockedStartCall).not.toHaveBeenCalled();

    await flushNotifications();
    const notification = await prisma.notification.findFirst({
      where: { workspaceId, type: 'campaign.paused_window_incomplete' },
    });
    expect(notification?.body).toMatch(/end time/i);
  });

  it('emits one notification when two runners pause the same campaign', async () => {
    const { workspaceId } = await seed({ contacts: 1, credits: '0' });

    await Promise.all([runDialerPass({ now: NOW }), runDialerPass({ now: NOW })]);
    await flushNotifications();

    const notifications = await prisma.notification.count({
      where: { workspaceId, type: 'campaign.paused_insufficient_credits' },
    });
    expect(notifications).toBe(1);
  });
});

describe('inbound-facing campaigns', () => {
  /**
   * A pure INBOUND campaign answers; it never dials. And an inbound-facing
   * campaign has no "done" the dispatcher can decide — it is still answering
   * when its list is empty — so it never auto-completes either: every exit
   * from RUNNING releases the DID claim (design §5.2), and an exit nobody
   * asked for would silently stop the campaign answering.
   */
  it('never dials a contact on a pure INBOUND campaign', async () => {
    const f = await seed({ contacts: 2, type: 'INBOUND' });
    await claimDid(f);

    const result = await runDialerPass({ now: NOW });

    expect(result.launched).toBe(0);
    expect(mockedStartCall).not.toHaveBeenCalled();
    const contacts = await prisma.campaignContact.findMany({ where: { campaignId: f.campaignId } });
    expect(contacts.every((c) => c.status === 'PENDING')).toBe(true);
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: f.campaignId } });
    expect(campaign.status).toBe('RUNNING');
  });

  it('does not auto-complete an INBOUND campaign that has no contacts', async () => {
    const f = await seed({ contacts: 0, type: 'INBOUND' });
    await claimDid(f);

    await runDialerPass({ now: NOW });

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: f.campaignId } });
    expect(campaign.status).toBe('RUNNING');
    expect(await prisma.campaignInboundClaim.count({ where: { campaignId: f.campaignId } })).toBe(1);
  });

  it('does not auto-complete a BOTH campaign whose list has run out — it is still answering', async () => {
    const f = await seed({ contacts: 0, type: 'BOTH' });
    await claimDid(f);

    await runDialerPass({ now: NOW });

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: f.campaignId } });
    expect(campaign.status).toBe('RUNNING');
    expect(await prisma.campaignInboundClaim.count({ where: { campaignId: f.campaignId } })).toBe(1);
  });

  it('still dials the outbound half of a BOTH campaign', async () => {
    const f = await seed({ contacts: 1, type: 'BOTH' });
    await claimDid(f);

    const result = await runDialerPass({ now: NOW });

    expect(result.launched).toBe(1);
  });

  it('releases the DID claim when the dispatcher pauses a BOTH campaign', async () => {
    const f = await seed({ contacts: 1, type: 'BOTH', agentStatus: 'removed' });
    await claimDid(f);

    const result = await runDialerPass({ now: NOW });

    expect(result.paused).toBe(1);
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: f.campaignId } });
    expect(campaign.status).toBe('PAUSED');
    expect(await prisma.campaignInboundClaim.count({ where: { campaignId: f.campaignId } })).toBe(0);
  });
});

describe('the dialing window', () => {
  /**
   * A closed window is the campaign working exactly as configured. Nothing is
   * wrong, so nothing is paused and nobody is told.
   */
  it('skips a closed window without pausing or notifying', async () => {
    const { campaignId, workspaceId } = await seed({
      contacts: 1,
      // 10:00 UTC is 15:30 IST, outside 09:00–12:00.
      window: { fromTime: '09:00', toTime: '12:00', timezone: 'Asia/Kolkata' },
    });

    const result = await runDialerPass({ now: NOW });

    expect(result.launched).toBe(0);
    expect(result.paused).toBe(0);
    expect(mockedStartCall).not.toHaveBeenCalled();

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe('RUNNING');

    await flushNotifications();
    expect(await prisma.notification.count({ where: { workspaceId } })).toBe(0);
  });

  it('dials inside an open window', async () => {
    await seed({
      contacts: 1,
      // 10:00 UTC is 15:30 IST.
      window: { fromTime: '09:00', toTime: '18:00', timezone: 'Asia/Kolkata' },
    });

    const result = await runDialerPass({ now: NOW });

    expect(result.launched).toBe(1);
  });

  /**
   * The days half of the same gate, exercised through the dispatcher rather
   * than through `evaluateWindow` alone: 2026-08-30 is a **Sunday**, and
   * 15:30 IST is squarely inside the hours, so only the day list can be what
   * stops this dial. A closed day is the campaign working as configured — no
   * pause, no notification — exactly as a closed hour is.
   */
  it('does not dial on a Sunday when the campaign calls on weekdays', async () => {
    const { campaignId, workspaceId } = await seed({
      contacts: 1,
      window: {
        fromTime: '09:00',
        toTime: '18:00',
        timezone: 'Asia/Kolkata',
        dialDays: [1, 2, 3, 4, 5],
      },
    });

    // Sunday 2026-08-30, 15:30 IST.
    const result = await runDialerPass({ now: NOW });

    expect(result.launched).toBe(0);
    expect(result.paused).toBe(0);
    expect(mockedStartCall).not.toHaveBeenCalled();
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status)
      .toBe('RUNNING');
    await flushNotifications();
    expect(await prisma.notification.count({ where: { workspaceId } })).toBe(0);
  });

  it('dials the next day, when the campaign does call', async () => {
    await seed({
      contacts: 1,
      window: {
        fromTime: '09:00',
        toTime: '18:00',
        timezone: 'Asia/Kolkata',
        dialDays: [1, 2, 3, 4, 5],
      },
    });

    // Monday 2026-08-31, 15:30 IST — the same hour, one day on.
    const result = await runDialerPass({ now: new Date('2026-08-31T10:00:00Z') });

    expect(result.launched).toBe(1);
  });
});

describe('fairness between campaigns', () => {
  /**
   * Without an ordering, one busy campaign holds every line its account was
   * allotted and a campaign started later never dials at all.
   */
  it('serves the least recently dialed campaign first', async () => {
    const account = await makeAccount('fair');
    await prisma.account.update({
      where: { id: account.id },
      data: { credits: toInternalCredits('100'), concurrencyLimit: 1 },
    });

    const workspace = await makeWorkspace(account, 'Fair');
    const agent = await makeAgent(workspace, 'caller');
    await prisma.agent.update({ where: { id: agent.id }, data: { voiceTierSlug: 'va-pro' } });
    await prisma.tier.create({
      data: {
        slug: 'va-pro',
        name: 'Pro',
        defaultPriceCreditsPerMin: toInternalCredits('1.00'),
        isDefault: true,
      },
    });
    const did = await makePhoneNumber(workspace, '+918011223355', 'ASSIGNED');

    const make = async (name: string) => {
      const campaign = await prisma.campaign.create({
        data: {
          workspaceId: workspace.id,
          name,
          agentId: agent.id,
          phoneNumberId: did.id,
          status: 'RUNNING',
          concurrencyLimit: 5,
        },
      });
      const contact = await prisma.contact.create({
        data: { workspaceId: workspace.id, phone: `+9198765${name.length}1234` },
      });
      await prisma.campaignContact.create({
        data: { campaignId: campaign.id, contactId: contact.id },
      });
      return campaign;
    };

    const busy = await make('Busy');
    const starved = await make('Waiting');

    // The busy campaign dialed a minute ago; the other never has.
    await prisma.callAttempt.create({
      data: {
        campaignId: busy.id,
        campaignContactId: (await prisma.campaignContact.findFirstOrThrow({
          where: { campaignId: busy.id },
        })).id,
        workspaceId: workspace.id,
        accountId: account.id,
        attemptNo: 1,
        status: 'COMPLETED',
        startedAt: new Date(NOW.getTime() - 60_000),
        chargedAt: NOW,
      },
    });

    // One line for the whole account, so exactly one campaign gets it.
    const result = await runDialerPass({ now: NOW });

    expect(result.launched).toBe(1);
    const attempts = await prisma.callAttempt.findMany({
      where: { campaignId: starved.id, status: 'QUEUED' },
    });
    expect(attempts).toHaveLength(1);
  });
});

/**
 * The tick's claim-side reaping.
 *
 * `releaseStaleClaims` runs beside `closeStaleAttempts` at the top of every
 * pass: a claim whose placement job is gone must go back to `PENDING`, or the
 * contact is never dialed and — `QUEUED` counting as unfinished work — its
 * campaign can never complete. The campaign here is PAUSED, which is the
 * point: the release is platform-wide reconciliation, not part of any one
 * campaign's dial, and it must reach a claim whose campaign is no longer
 * being swept.
 */
describe('stale claims', () => {
  it('gives back a claim whose placement job is gone', async () => {
    mockedGetConcurrency.mockResolvedValue({ limit: 100, active: 0, remaining: 100 });
    const { campaignId } = await seed({ contacts: 1 });

    await prisma.campaignContact.updateMany({
      where: { campaignId },
      data: { status: 'QUEUED', claimedAt: new Date(NOW.getTime() - 10 * 60_000) },
    });
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'PAUSED' } });

    await runDialerPass({ now: NOW });

    const row = await prisma.campaignContact.findFirstOrThrow({ where: { campaignId } });
    expect(row.status).toBe('PENDING');
    expect(row.claimedAt).toBeNull();
  });
});

/**
 * Claims posted by an earlier tick count against every cap.
 *
 * In-flight is counted from attempt rows, and a claim has no attempt row
 * until its placement job runs. The pass carries its own claims forward
 * (`accountClaimed`), but a backlog that outlives the tick period — placement
 * is concurrency 1 — was counted by nothing: the next tick re-read the same
 * headroom from attempt rows alone and re-spent it, so simultaneous calls
 * could reach a multiple of the sold limit, and `placeClaimedCall`
 * deliberately re-checks no caps. A `QUEUED` contact claimed before this
 * tick, with no attempt started since its claim, is a committed dial and
 * counts as one.
 */
describe('claims from an earlier tick', () => {
  const EARLIER_TICK = new Date(NOW.getTime() - 60_000);

  it('counts a queued backlog against the campaign cap', async () => {
    mockedGetConcurrency.mockResolvedValue({ limit: 100, active: 0, remaining: 100 });
    const { campaignId, contactIds } = await seed({ contacts: 4, concurrencyLimit: 2 });

    // Two contacts claimed by the previous tick, still waiting on placement.
    await prisma.campaignContact.updateMany({
      where: { id: { in: contactIds.slice(0, 2) } },
      data: { status: 'QUEUED', claimedAt: EARLIER_TICK },
    });

    await runDialerSweep({ now: NOW });

    // The campaign's whole limit is already committed; this tick claims none.
    const queued = await prisma.campaignContact.count({
      where: { campaignId, status: 'QUEUED' },
    });
    expect(queued).toBe(2);
  });

  it('counts a queued backlog against the account allotment', async () => {
    mockedGetConcurrency.mockResolvedValue({ limit: 100, active: 0, remaining: 100 });
    const first = await seed({ contacts: 2, concurrencyLimit: 5, accountConcurrency: 2 });

    // A second campaign in the same workspace, so it shares the allotment.
    const second = await prisma.campaign.create({
      data: {
        workspaceId: first.workspaceId,
        name: 'Second',
        agentId: (await prisma.campaign.findUniqueOrThrow({
          where: { id: first.campaignId },
          select: { agentId: true },
        })).agentId,
        phoneNumberId: (await prisma.campaign.findUniqueOrThrow({
          where: { id: first.campaignId },
          select: { phoneNumberId: true },
        })).phoneNumberId,
        status: 'RUNNING',
        concurrencyLimit: 5,
      },
    });
    const contact = await prisma.contact.create({
      data: { workspaceId: first.workspaceId, phone: '+919876540123' },
    });
    await prisma.campaignContact.create({
      data: { campaignId: second.id, contactId: contact.id, status: 'PENDING' },
    });

    // The first campaign's earlier-tick backlog fills the whole allotment.
    await prisma.campaignContact.updateMany({
      where: { campaignId: first.campaignId },
      data: { status: 'QUEUED', claimedAt: EARLIER_TICK },
    });

    await runDialerSweep({ now: NOW });

    const queued = await prisma.campaignContact.count({
      where: { campaignId: second.id, status: 'QUEUED' },
    });
    expect(queued).toBe(0);
  });
});

/**
 * A contact past the absolute dial cap does not sit in the queue.
 *
 * The claim refuses it in every lane, and a refusal alone would leave it
 * PENDING for ever: never dialled, never settled, counted as remaining work by
 * the completion pass — so the campaign could never complete either. The pass
 * settles it before it counts anything, which is what lets a campaign whose
 * whole remaining queue is out of reach finish on that very pass.
 */
describe('the dial-cap settle', () => {
  async function pastTheCap(placed: boolean) {
    const fixture = await seed({ contacts: 1 });

    // `retryCount: 1` with no follow-ups is a ceiling of two, which the two
    // dials below spend. The stored `maxTotalDials: 9` beside it is the
    // assertion that the retired column is not what the pass reads.
    await prisma.campaign.update({
      where: { id: fixture.campaignId },
      data: { retryCount: 1, maxGoalFollowUps: 0, maxTotalDials: 9, totalContacts: 1 },
    });

    for (const attemptNo of [1, 2]) {
      await prisma.callAttempt.create({
        data: {
          campaignId: fixture.campaignId,
          campaignContactId: fixture.contactIds[0]!,
          workspaceId: fixture.workspaceId,
          accountId: fixture.accountId,
          attemptNo,
          ...(placed
            ? { status: 'COMPLETED', upstreamCallId: `c_placed_${attemptNo}`, resolvedAt: NOW }
            : {
                // What `rollbackLaunch` writes for a transient upstream
                // failure: closed, never placed, no platform id at all.
                status: 'FAILED',
                launchError: 'UPSTREAM_ERROR: the platform returned 502',
                resolvedAt: NOW,
              }),
        },
      });
    }

    return fixture;
  }

  const statusOf = async (id: string) =>
    (await prisma.campaignContact.findUniqueOrThrow({ where: { id } })).status;

  it('settles the contact and lets the campaign complete', async () => {
    const fixture = await pastTheCap(true);

    await runDialerPass({ now: NOW });

    expect(await statusOf(fixture.contactIds[0]!)).toBe('SKIPPED');

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: fixture.campaignId } });
    expect(campaign.skippedCount).toBe(1);
    expect(campaign.status).toBe('COMPLETED');
    expect(mockedStartCall).not.toHaveBeenCalled();
  });

  /**
   * The other half, and the reason the settle counts PLACED dials only: six
   * transient 502s must not settle somebody whose phone never rang. The
   * contact is dialled on this very pass instead.
   */
  it('dials a contact whose ordinals were launches that never placed a call', async () => {
    const fixture = await pastTheCap(false);

    await runDialerPass({ now: NOW });

    expect(await statusOf(fixture.contactIds[0]!)).not.toBe('SKIPPED');
    expect(mockedStartCall).toHaveBeenCalledTimes(1);
  });
});

/**
 * The line that tells "waiting on a stuck call" apart from "nobody started
 * it".
 *
 * Both used to log nothing at all, so the only symptom either produced was an
 * operator saying a running campaign looked idle — and no line anywhere could
 * confirm or deny that. These cases pin the trade the line is built on: quiet
 * about a campaign whose calls are turning over, loud about one that is wedged
 * or held by capacity somebody bought.
 */
describe('the blocked-sweep line', () => {
  /**
   * Derived, never hard-coded. `test/setup.ts` does not pin
   * `DIALER_ATTEMPT_TIMEOUT_MINS`, so dotenv will happily take it from a
   * developer's `.env` — and a literal 45 here would silently change meaning
   * at any timeout below that, because the reaper would close the fixture row
   * and free the very slot these cases need occupied.
   */
  const WEDGED_MINS = Math.max(1, Math.floor(env.dialerAttemptTimeoutMins / 2));
  const MINUTE = 60_000;

  /** Every `no slots` line this pass emitted about our own fixture.
   *
   *  Scoped to the fixture's own ids rather than asserting on the whole set:
   *  the sweep walks every RUNNING campaign in the database, and this suite
   *  shares `TEST_DATABASE_URL` with any parallel session, so a stray campaign
   *  would otherwise fail cases it has nothing to do with. */
  const blockedFor = (fixture: Fixture) =>
    vi
      .mocked(console.warn)
      .mock.calls.map((args) => String(args[0]))
      .filter(
        (line) =>
          line.includes('no slots') &&
          (line.includes(fixture.campaignId) || line.includes(fixture.accountId)),
      );

  /** Lines about the shared pool, which name no campaign and no account. */
  const poolLines = () =>
    vi
      .mocked(console.warn)
      .mock.calls.map((args) => String(args[0]))
      .filter((line) => line.includes('shared platform pool'));

  /** One in-flight call, `startedAt` however long ago the case needs.
   *
   *  Always explicit: left at the column default the row is stamped with the
   *  real clock, which runs *ahead* of the injected `NOW`, giving a negative
   *  age that silently fails the wedged gate. */
  const occupy = async (
    fixture: Fixture,
    agoMs: number,
    status: 'IN_PROGRESS' | 'RINGING',
    contact = 0,
  ) =>
    prisma.callAttempt.create({
      data: {
        campaignId: fixture.campaignId,
        campaignContactId: fixture.contactIds[contact]!,
        workspaceId: fixture.workspaceId,
        accountId: fixture.accountId,
        attemptNo: 1,
        status,
        startedAt: new Date(NOW.getTime() - agoMs),
      },
    });

  it('says nothing about a campaign whose calls are turning over', async () => {
    // A `concurrencyLimit` of 1 working a list is at its ceiling essentially
    // always. That is the dialer working, and a line a minute saying so would
    // bury every line that means something.
    const fixture = await seed({ contacts: 5, concurrencyLimit: 1 });
    await occupy(fixture, 30_000, 'IN_PROGRESS');

    await runDialerPass({ now: NOW });

    expect(blockedFor(fixture)).toEqual([]);
  });

  /**
   * The two cases that actually pin the threshold. Without a pair straddling
   * it, any value in the whole open interval passes — including one thirty
   * times more eager, which is the per-campaign-per-minute flood the gate
   * exists to prevent.
   */
  it('is still quiet one minute before the wedged threshold', async () => {
    const fixture = await seed({ contacts: 5, concurrencyLimit: 1 });
    await occupy(fixture, (WEDGED_MINS - 1) * MINUTE, 'IN_PROGRESS');

    await runDialerPass({ now: NOW });

    expect(blockedFor(fixture)).toEqual([]);
  });

  it('names the campaign and the attempt one minute after it', async () => {
    const fixture = await seed({ contacts: 5, concurrencyLimit: 1 });
    const attempt = await occupy(fixture, (WEDGED_MINS + 1) * MINUTE, 'RINGING');

    await runDialerPass({ now: NOW });

    const [line, ...rest] = blockedFor(fixture);

    expect(rest).toEqual([]);
    expect(line).toContain('at its own ceiling');
    expect(line).toContain('(1/1 in flight)');
    expect(line).toContain(attempt.id);
    expect(line).toContain(`${WEDGED_MINS + 1}m`);
  });

  /**
   * The regression this arm was rewritten for. `Campaign.concurrencyLimit`
   * defaults to 2 and `DIALER_DEFAULT_ACCOUNT_CONCURRENCY` to 2, so an
   * ordinary busy campaign sits at both caps at once — and an ungated account
   * arm spoke for it every single pass, forever, which is precisely the noise
   * the campaign arm's gate exists to prevent.
   */
  it('says nothing when the allotment is full but the account is turning over', async () => {
    const fixture = await seed({ contacts: 5, concurrencyLimit: 2, accountConcurrency: 2 });
    // BOTH lines occupied, or the campaign is not blocked at all and the case
    // passes without ever reaching the branch it is about.
    await occupy(fixture, 30_000, 'IN_PROGRESS', 0);
    await occupy(fixture, 45_000, 'IN_PROGRESS', 1);

    await runDialerPass({ now: NOW });

    expect(blockedFor(fixture)).toEqual([]);
  });

  it('names the account once its own oldest call is wedged', async () => {
    const fixture = await seed({ contacts: 5, concurrencyLimit: 5, accountConcurrency: 1 });
    const attempt = await occupy(fixture, (WEDGED_MINS + 1) * MINUTE, 'IN_PROGRESS');

    await runDialerPass({ now: NOW });

    const [line, ...rest] = blockedFor(fixture);

    expect(rest).toEqual([]);
    expect(line).toContain('at its allotment');
    expect(line).toContain('(1/1 in flight)');
    expect(line).toContain(fixture.accountId);
    expect(line).toContain(attempt.id);
  });

  /**
   * Zero is a limit somebody set — staff stopped this account. There is no
   * call to be old, so no gate applies, and "at its allotment" would send a
   * reader hunting for in-flight calls that do not exist.
   */
  it('says an account allotted zero lines was stopped, not saturated', async () => {
    const fixture = await seed({ contacts: 3, accountConcurrency: 0 });

    await runDialerPass({ now: NOW });

    const [line] = blockedFor(fixture);

    expect(line).toContain('allotted zero lines');
    expect(line).not.toContain('at its allotment');
  });

  it('names the shared pool when the platform has no room', async () => {
    await seed({ contacts: 3, concurrencyLimit: 5 });
    mockedGetConcurrency.mockResolvedValue({ limit: 100, active: 100, remaining: 0 });

    await runDialerPass({ now: NOW });

    expect(poolLines()).toHaveLength(1);
    expect(poolLines()[0]).toContain('the shared platform pool is full');
  });

  /**
   * One full pool is one fact. Reported per campaign it would speak once for
   * every RUNNING campaign on the platform — up to `CAMPAIGN_BATCH` lines a
   * minute for a single condition.
   */
  it('reports a full pool once per pass, not once per campaign', async () => {
    // One seed, then two more campaigns on its workspace — `seed` creates the
    // `va-pro` tier, which is unique, so it cannot be called twice in a case.
    const fixture = await seed({ contacts: 3, concurrencyLimit: 5 });
    const agent = await prisma.agent.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId },
    });
    const did = await prisma.phoneNumber.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId },
    });

    for (const name of ['Second', 'Third']) {
      const campaign = await prisma.campaign.create({
        data: {
          workspaceId: fixture.workspaceId,
          name,
          agentId: agent.id,
          phoneNumberId: did.id,
          status: 'RUNNING',
          concurrencyLimit: 5,
        },
      });
      const contact = await prisma.contact.create({
        data: { workspaceId: fixture.workspaceId, phone: `+91987654${name.length}21` },
      });
      await prisma.campaignContact.create({
        data: { campaignId: campaign.id, contactId: contact.id },
      });
    }

    mockedGetConcurrency.mockResolvedValue({ limit: 100, active: 100, remaining: 0 });

    await runDialerPass({ now: NOW });

    // Three RUNNING campaigns, all blocked by the same one fact.
    expect(poolLines()).toHaveLength(1);
  });

  it('stays quiet about a campaign that finished on the pass that found it full', async () => {
    // Its last call landing while it was at its ceiling is a completion, not a
    // campaign held by a cap. Reporting it as blocked would be the opposite of
    // what happened.
    const fixture = await seed({ contacts: 1, concurrencyLimit: 1 });
    await occupy(fixture, (WEDGED_MINS + 1) * MINUTE, 'IN_PROGRESS');
    await prisma.campaignContact.updateMany({
      where: { campaignId: fixture.campaignId },
      data: { status: 'COMPLETED' },
    });

    const result = await runDialerPass({ now: NOW });

    expect(result.completed).toBe(1);
    expect(blockedFor(fixture)).toEqual([]);
  });
});

/**
 * The per-contact daily cap, end to end through a real pass.
 *
 * The claim is where it is enforced and `test/dialer-claim.query.test.ts` pins
 * the predicate; what this asserts is the wiring the predicate needs — that
 * the pass computes the day boundary from the CAMPAIGN'S OWN ZONE and hands
 * it down, and that a contact held by the cap is held rather than settled.
 */
describe('the per-contact daily cap', () => {
  async function cappedToday() {
    const fixture = await seed({
      contacts: 1,
      window: { fromTime: null, toTime: null, timezone: 'Asia/Kolkata' },
    });

    await prisma.campaign.update({
      where: { id: fixture.campaignId },
      data: { maxDialsPerDay: 1, retryCount: 5, maxGoalFollowUps: 0, totalContacts: 1 },
    });

    // One placed dial an hour ago. NOW is 10:00Z = 15:30 IST, so it is this
    // local day's; against tomorrow's midnight it is yesterday's.
    await prisma.callAttempt.create({
      data: {
        campaignId: fixture.campaignId,
        campaignContactId: fixture.contactIds[0]!,
        workspaceId: fixture.workspaceId,
        accountId: fixture.accountId,
        attemptNo: 1,
        startedAt: new Date(NOW.getTime() - 60 * 60_000),
        status: 'COMPLETED',
        upstreamCallId: 'c_today',
        resolvedAt: new Date(NOW.getTime() - 59 * 60_000),
      },
    });

    return fixture;
  }

  it('claims nothing and settles nothing for a contact at its cap', async () => {
    const fixture = await cappedToday();

    await runDialerPass({ now: NOW });

    expect(mockedStartCall).not.toHaveBeenCalled();

    // Held, never settled: being capped is not running out of anything, and a
    // SKIPPED here would end a contact's campaign over a clock.
    const row = await prisma.campaignContact.findUniqueOrThrow({
      where: { id: fixture.contactIds[0]! },
    });
    expect(row.status).toBe('PENDING');

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: fixture.campaignId } });
    expect(campaign.skippedCount).toBe(0);
    // And the campaign is not completed either: this is work still to do.
    expect(campaign.status).toBe('RUNNING');
  });

  it('claims the same contact once the local day has turned', async () => {
    const fixture = await cappedToday();

    // 2026-08-31 04:00 IST. The dial above is yesterday's now.
    await runDialerPass({ now: new Date('2026-08-30T22:30:00Z') });

    expect(mockedStartCall).toHaveBeenCalledTimes(1);
    expect(
      (await prisma.campaignContact.findUniqueOrThrow({ where: { id: fixture.contactIds[0]! } }))
        .status,
    ).not.toBe('PENDING');
  });
});
