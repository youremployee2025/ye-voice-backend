import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';

// Mocked in every test. Sync reads a live telephony account that serves real
// customers; no test may reach it.
vi.mock('../src/adapter/vocobase.js', () => ({
  listPurchasedDids: vi.fn(),
  voicelinkCallReady: vi.fn(),
}));

const { listPurchasedDids, voicelinkCallReady } = await import('../src/adapter/vocobase.js');
const { syncPurchasedDids } = await import('../src/services/didSync.js');

const mockedList = vi.mocked(listPurchasedDids);
const mockedCallReady = vi.mocked(voicelinkCallReady);

/** A purchased DID in the shape the platform actually sends: `did_number` and
 *  `country_code` arrive as JSON numbers, not strings. */
function upstreamDid(overrides: Record<string, unknown> = {}) {
  return {
    id: 2027,
    did_number: 919429390403,
    did_type: 2,
    type_label: 'Mobile',
    country_code: 91,
    status: 2,
    status_label: 'Assigned',
    is_expired: false,
    expiry_date: '2026-08-31',
    client_id: 2314,
    auto_renew: true,
    ...overrides,
  };
}

/** One page, ending the walk. */
function onePage(rows: unknown[]) {
  mockedList.mockResolvedValue({ rows: rows as never, lastPage: 1 });
}

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mockedCallReady.mockResolvedValue({ ready: true, steps: [] } as never);
});

describe('reading the upstream number', () => {
  it('accepts a DID already in E.164, not just a bare JSON number', async () => {
    // The most likely string form upstream could switch to. Requiring bare
    // digits meant `canonicalizeE164` — which handles '+', spaces and dashes
    // correctly — never saw it, so every row skipped and the run reported a
    // 200 with `{imported: 0, skipped: N}` and no log line.
    onePage([upstreamDid({ did_number: '+919429390403' })]);

    expect(await syncPurchasedDids()).toMatchObject({ imported: 1, skipped: 0 });
    expect((await prisma.phoneNumber.findFirstOrThrow()).did).toBe('+919429390403');
  });

  it('accepts a formatted DID', async () => {
    onePage([upstreamDid({ did_number: '+91 94293-90403' })]);

    expect(await syncPurchasedDids()).toMatchObject({ imported: 1, skipped: 0 });
    expect((await prisma.phoneNumber.findFirstOrThrow()).did).toBe('+919429390403');
  });

  it('still refuses a number a float would have mangled', async () => {
    // Past MAX_SAFE_INTEGER, so JSON.parse already lost digits. A wrong number
    // is worse than a missing one: a missing one is reported, a wrong one is
    // dialled.
    onePage([upstreamDid({ did_number: 9007199254740993000 })]);

    expect(await syncPurchasedDids()).toMatchObject({ imported: 0, skipped: 1 });
  });

  it('accepts a non-numeric provider id', async () => {
    // `externalId` is String? in the schema and the adapter's own comment says
    // the shape has moved before. Requiring digits meant a switch to
    // "did_2027" or a UUID skipped the entire estate at once.
    onePage([upstreamDid({ id: 'did_2027' })]);

    expect(await syncPurchasedDids()).toMatchObject({ imported: 1, skipped: 0 });
    expect((await prisma.phoneNumber.findFirstOrThrow()).externalId).toBe('did_2027');
  });
});

describe('the page walk', () => {
  it('trusts the reported last page over a short one', async () => {
    // Upstream capping per_page below what was asked for used to end the walk
    // on page 1 and report a clean run over a fifth of the estate.
    mockedList
      .mockResolvedValueOnce({ rows: [upstreamDid({ id: 1, did_number: 919429390401 })] as never, lastPage: 2 })
      .mockResolvedValueOnce({ rows: [upstreamDid({ id: 2, did_number: 919429390402 })] as never, lastPage: 2 });

    expect(await syncPurchasedDids()).toMatchObject({ imported: 2, truncated: false });
    expect(mockedList).toHaveBeenCalledTimes(2);
  });

  it('reports a walk that stopped at the backstop', async () => {
    mockedList.mockImplementation((async ({ page }: { page: number }) => ({
      rows: [upstreamDid({ id: page, did_number: 919429390400 + page })] as never,
      lastPage: 99,
    })) as never);

    const result = await syncPurchasedDids({ maxPages: 3 });

    // A truncated mirror must not look like a complete one.
    expect(result.truncated).toBe(true);
    expect(mockedList).toHaveBeenCalledTimes(3);
  });
});

describe('syncPurchasedDids', () => {
  it('imports a purchased DID as UNASSIGNED with its provider metadata', async () => {
    onePage([upstreamDid()]);

    const result = await syncPurchasedDids();

    expect(result).toMatchObject({ imported: 1, updated: 0, skipped: 0, conflicts: 0 });

    const row = await prisma.phoneNumber.findUniqueOrThrow({ where: { did: '+919429390403' } });
    expect(row.externalId).toBe('2027');
    expect(row.provider).toBe('voicelink');
    expect(row.countryCode).toBe('91');
    expect(row.numberType).toBe('Mobile');
    expect(row.providerStatus).toBe('Assigned');
    expect(row.providerExpiresAt?.toISOString()).toBe('2026-08-31T00:00:00.000Z');
    expect(row.lastSyncedAt).not.toBeNull();

    // Tenancy and billing are untouched by sync.
    expect(row.status).toBe('UNASSIGNED');
    expect(row.workspaceId).toBeNull();
    expect(row.monthlyPriceCredits).toBeNull();
    expect(row.rentedAt).toBeNull();
    expect(row.nextRenewalAt).toBeNull();
  });

  it('walks every page until the last one', async () => {
    const page = (start: number, count: number) =>
      Array.from({ length: count }, (_, i) =>
        upstreamDid({ id: start + i, did_number: 919000000000 + start + i }),
      );

    mockedList
      .mockResolvedValueOnce({ rows: page(1, 200) as never, lastPage: 3 })
      .mockResolvedValueOnce({ rows: page(201, 200) as never, lastPage: 3 })
      .mockResolvedValueOnce({ rows: page(401, 5) as never, lastPage: 3 });

    const result = await syncPurchasedDids();

    expect(mockedList).toHaveBeenCalledTimes(3);
    expect(mockedList.mock.calls.map(([q]) => q.page)).toEqual([1, 2, 3]);
    expect(result.imported).toBe(405);
    expect(await prisma.phoneNumber.count()).toBe(405);
  });

  it('stops on a short page even when last_page is unknown', async () => {
    mockedList.mockResolvedValue({ rows: [upstreamDid()] as never, lastPage: null });

    await syncPurchasedDids();

    expect(mockedList).toHaveBeenCalledTimes(1);
  });

  it('never overwrites tenancy or billing state on re-sync', async () => {
    // The central invariant. A refresh that un-rented a number would leave the
    // ledger recording charges for nothing.
    const owner = await makeAccount('owner');
    const workspace = await makeWorkspace(owner, 'Acme');
    const rentedAt = new Date('2026-08-01T00:00:00.000Z');
    const nextRenewalAt = new Date('2026-09-01T00:00:00.000Z');

    await prisma.phoneNumber.create({
      data: {
        did: '+919429390403',
        externalId: '2027',
        status: 'ASSIGNED',
        workspaceId: workspace.id,
        monthlyPriceCredits: 5_000_000n,
        rentedAt,
        nextRenewalAt,
        providerStatus: 'stale',
      },
    });

    onePage([upstreamDid({ status_label: 'Expired' })]);
    const result = await syncPurchasedDids();

    expect(result).toMatchObject({ imported: 0, updated: 1 });

    const row = await prisma.phoneNumber.findUniqueOrThrow({ where: { externalId: '2027' } });
    expect(row.status).toBe('ASSIGNED');
    expect(row.workspaceId).toBe(workspace.id);
    expect(row.monthlyPriceCredits).toBe(5_000_000n);
    expect(row.rentedAt?.toISOString()).toBe(rentedAt.toISOString());
    expect(row.nextRenewalAt?.toISOString()).toBe(nextRenewalAt.toISOString());
    // Provider facts DID refresh.
    expect(row.providerStatus).toBe('Expired');
  });

  it('skips a DID whose number will not canonicalize, and counts it', async () => {
    onePage([upstreamDid({ did_number: 12345 })]);

    const result = await syncPurchasedDids();

    expect(result).toMatchObject({ imported: 0, skipped: 1 });
    // A fabricated '+12345' must never be stored: it would fail much later, at
    // dial time, far from the sync that invented it.
    expect(await prisma.phoneNumber.count()).toBe(0);
  });

  it('skips a row with no number at all', async () => {
    onePage([upstreamDid({ did_number: null })]);

    expect(await syncPurchasedDids()).toMatchObject({ skipped: 1 });
    expect(await prisma.phoneNumber.count()).toBe(0);
  });

  it('accepts did_number sent as a string', async () => {
    onePage([upstreamDid({ did_number: '919429390403' })]);

    expect(await syncPurchasedDids()).toMatchObject({ imported: 1 });
    expect(await prisma.phoneNumber.findUnique({ where: { did: '+919429390403' } })).not.toBeNull();
  });

  it('counts a number re-issued under a new provider id as a conflict', async () => {
    await prisma.phoneNumber.create({
      data: { did: '+919429390403', externalId: '2027', provider: 'voicelink' },
    });

    onePage([upstreamDid({ id: 9999 })]);
    const result = await syncPurchasedDids();

    expect(result).toMatchObject({ conflicts: 1, imported: 0 });
    // The run completes and the existing row is untouched — one odd number
    // must not fail the whole sync.
    const row = await prisma.phoneNumber.findUniqueOrThrow({ where: { did: '+919429390403' } });
    expect(row.externalId).toBe('2027');
  });

  it('leaves a DID the platform stopped listing alone', async () => {
    await prisma.phoneNumber.create({ data: { did: '+919999999999', externalId: 'gone' } });

    onePage([upstreamDid()]);
    await syncPurchasedDids();

    // Never deleted, never unassigned on a guess: reconciling a vanished DID
    // needs a policy, and this slice does not have one.
    expect(await prisma.phoneNumber.findUnique({ where: { externalId: 'gone' } })).not.toBeNull();
  });

  it('skips a row with no provider id, since sync would have nothing to match on', async () => {
    onePage([upstreamDid({ id: null })]);

    expect(await syncPurchasedDids()).toMatchObject({ skipped: 1 });
    expect(await prisma.phoneNumber.count()).toBe(0);
  });

  it('stops at the page backstop rather than walking forever', async () => {
    mockedList.mockImplementation(async ({ page }) => ({
      rows: Array.from({ length: 200 }, (_, i) =>
        upstreamDid({ id: page * 1000 + i, did_number: 919000000000 + page * 1000 + i }),
      ) as never,
      lastPage: 9999,
    }));

    await syncPurchasedDids({ maxPages: 3 });

    expect(mockedList).toHaveBeenCalledTimes(3);
  });
});

describe('divergence from upstream', () => {
  it('names rented DIDs upstream has stopped listing', async () => {
    // The charging half of this shipped without the divergence half: the
    // renewal sweep consults no provider fact, so a number that lapsed
    // upstream bills its renter every month, forever, and the only trace is a
    // lastSyncedAt going stale where nobody is looking.
    const owner = await makeAccount('owner');
    const workspace = await makeWorkspace(owner, 'Acme');

    await prisma.phoneNumber.create({
      data: {
        did: '+919429390499',
        externalId: '9999',
        status: 'ASSIGNED',
        workspaceId: workspace.id,
      },
    });

    onePage([upstreamDid()]);

    const result = await syncPurchasedDids();

    expect(result.unseenAssigned).toEqual(['+919429390499']);
    // Still left alone: what happens to it is a policy nobody has written.
    const stale = await prisma.phoneNumber.findFirstOrThrow({ where: { externalId: '9999' } });
    expect(stale.workspaceId).toBe(workspace.id);
  });

  it('says nothing about unrented DIDs upstream has stopped listing', async () => {
    await prisma.phoneNumber.create({
      data: { did: '+919429390499', externalId: '9999', status: 'UNASSIGNED' },
    });

    onePage([upstreamDid()]);

    expect((await syncPurchasedDids()).unseenAssigned).toEqual([]);
  });

  it('does not cry vanished when the walk was truncated', async () => {
    // A partial listing makes every unvisited row look gone. Turning a
    // backstop into a false alarm about paid-for numbers is worse than silence.
    const owner = await makeAccount('owner');
    const workspace = await makeWorkspace(owner, 'Acme');

    await prisma.phoneNumber.create({
      data: {
        did: '+919429390499',
        externalId: '9999',
        status: 'ASSIGNED',
        workspaceId: workspace.id,
      },
    });

    mockedList.mockImplementation((async ({ page }: { page: number }) => ({
      rows: [upstreamDid({ id: page, did_number: 919429390400 + page })] as never,
      lastPage: 99,
    })) as never);

    const result = await syncPurchasedDids({ maxPages: 2 });

    expect(result.truncated).toBe(true);
    expect(result.unseenAssigned).toEqual([]);
  });
});

describe('refreshing an existing row', () => {
  it('keeps a provider fact this payload did not carry', async () => {
    onePage([upstreamDid()]);
    await syncPurchasedDids();

    const before = await prisma.phoneNumber.findFirstOrThrow();
    expect(before.providerExpiresAt).not.toBeNull();
    expect(before.providerStatus).toBe('Assigned');

    // A thinner page: no expiry, and `status` as a number so readString
    // declines it. Clearing known-good values on that basis left the staff
    // console unable to tell "no expiry" from "a thin response".
    onePage([upstreamDid({ expiry_date: undefined, status_label: undefined })]);
    await syncPurchasedDids();

    const after = await prisma.phoneNumber.findFirstOrThrow();
    expect(after.providerExpiresAt?.toISOString()).toBe(before.providerExpiresAt?.toISOString());
    expect(after.providerStatus).toBe('Assigned');
  });

  it('refuses to rewrite the number under a live rental', async () => {
    // `did` is a provider fact, but it is the one a customer is billed
    // against: the ledger renders phoneNumber.did, so rewriting it under a
    // rental retroactively changes which number every past charge was for.
    const owner = await makeAccount('owner');
    const workspace = await makeWorkspace(owner, 'Acme');

    onePage([upstreamDid()]);
    await syncPurchasedDids();

    await prisma.phoneNumber.updateMany({
      data: { status: 'ASSIGNED', workspaceId: workspace.id },
    });

    onePage([upstreamDid({ did_number: 919429390555 })]);
    const result = await syncPurchasedDids();

    expect(result).toMatchObject({ conflicts: 1, updated: 0 });
    expect((await prisma.phoneNumber.findFirstOrThrow()).did).toBe('+919429390403');
  });
});


/**
 * A number this platform has imported but never provisioned is a caller id
 * that fails at dial time, and the failure surfaces as a refused campaign
 * start rather than as anything about the number. Provisioning it at the
 * moment it is imported is what makes "the DID is in the inventory" and "the
 * DID can place a call" the same fact.
 */
describe('making an imported DID call-ready', () => {
  it('provisions a newly imported DID', async () => {
    onePage([upstreamDid({ did_number: 919429390403 })]);

    const result = await syncPurchasedDids();

    expect(result).toMatchObject({ imported: 1, provisioned: 1, provisionFailed: 0 });
    expect(mockedCallReady).toHaveBeenCalledTimes(1);
    expect(mockedCallReady).toHaveBeenCalledWith('+919429390403');
  });

  /**
   * The sweep runs hourly against the whole inventory. Provisioning every row
   * every pass would turn a read-shaped mirror into a steady stream of writes
   * against a live telephony account, for numbers that were already ready.
   */
  it('does not re-provision a DID that was already in the inventory', async () => {
    onePage([upstreamDid()]);
    await syncPurchasedDids();
    mockedCallReady.mockClear();

    onePage([upstreamDid()]);
    const second = await syncPurchasedDids();

    expect(second).toMatchObject({ imported: 0, updated: 1, provisioned: 0 });
    expect(mockedCallReady).not.toHaveBeenCalled();
  });

  /**
   * Provisioning is a best effort on top of the mirror, never a precondition
   * for it. A telephony account that refuses one number must not cost us the
   * record of every other.
   */
  it('keeps the imported row when provisioning fails, and counts the failure', async () => {
    mockedCallReady.mockRejectedValue(new Error('upstream said no'));
    onePage([upstreamDid({ did_number: 919429390403 })]);

    const result = await syncPurchasedDids();

    expect(result).toMatchObject({ imported: 1, provisioned: 0, provisionFailed: 1 });
    expect(await prisma.phoneNumber.findFirst({ where: { did: '+919429390403' } })).not.toBeNull();
  });

  /** `ready: false` is upstream reporting work left to do, not an error. It is
   *  reported rather than counted as success, so a number that needs a human
   *  is visible instead of silently un-dialable. */
  it('counts a not-ready verdict separately from a success', async () => {
    mockedCallReady.mockResolvedValue({
      ready: false,
      readiness: { state: 'NO_CLIENT_MAPPING', issues: ['DID is not mapped to a client'] },
    } as never);
    onePage([upstreamDid()]);

    const result = await syncPurchasedDids();

    expect(result).toMatchObject({ imported: 1, provisioned: 0, provisionUnready: 1 });
  });

  it('provisions nothing when the switch is off', async () => {
    const previous = process.env.VOICELINK_AUTO_CALL_READY;
    process.env.VOICELINK_AUTO_CALL_READY = 'false';
    vi.resetModules();

    try {
      const { syncPurchasedDids: sync } = await import('../src/services/didSync.js');
      onePage([upstreamDid()]);

      const result = await sync();

      expect(result).toMatchObject({ imported: 1, provisioned: 0 });
      expect(mockedCallReady).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.VOICELINK_AUTO_CALL_READY;
      else process.env.VOICELINK_AUTO_CALL_READY = previous;
      vi.resetModules();
    }
  });
});
