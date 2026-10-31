import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';

vi.mock('../src/adapter/vocobase.js', () => ({
  createPartnerCustomer: vi.fn(),
}));

const client = await import('../src/adapter/vocobase.js');
const { ensurePartnerCustomer } = await import('../src/lib/partnerCustomer.js');
const { ApiError } = await import('../src/lib/errors.js');

let workspace: Workspace;

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});

  const account = await makeAccount('alice');
  workspace = await makeWorkspace(account, 'Acme');
});

function customerNamed(id: string) {
  return { id, external_id: workspace.id, name: 'Acme', status: 'ACTIVE' };
}

/**
 * `Workspace.partnerCustomerId` and the constraint the create path leans on.
 *
 * The uniqueness is not decoration: `ensurePartnerCustomer` reads a P2002 as
 * "this customer id is already stored against some workspace", and without the
 * index that branch could never fire.
 */
describe('Workspace.partnerCustomerId', () => {
  it('is null until something connects', () => {
    expect(workspace.partnerCustomerId).toBeNull();
  });

  it('cannot be shared by two workspaces', async () => {
    const other = await makeWorkspace(await makeAccount('bob'), 'Beta');

    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { partnerCustomerId: 'pcus_1' },
    });

    await expect(
      prisma.workspace.update({ where: { id: other.id }, data: { partnerCustomerId: 'pcus_1' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('lets any number of workspaces have none', async () => {
    await makeWorkspace(await makeAccount('bob'), 'Beta');

    expect(await prisma.workspace.count({ where: { partnerCustomerId: null } })).toBe(2);
  });
});

describe('ensurePartnerCustomer', () => {
  it('creates the customer on first use and stores the id', async () => {
    vi.mocked(client.createPartnerCustomer).mockResolvedValue(customerNamed('pcus_1'));

    await expect(ensurePartnerCustomer(workspace)).resolves.toBe('pcus_1');

    expect(client.createPartnerCustomer).toHaveBeenCalledWith({
      external_id: workspace.id,
      name: 'Acme',
    });
    const stored = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    expect(stored.partnerCustomerId).toBe('pcus_1');
  });

  it('reuses the stored id without calling upstream again', async () => {
    vi.mocked(client.createPartnerCustomer).mockResolvedValue(customerNamed('pcus_1'));
    await ensurePartnerCustomer(workspace);
    vi.mocked(client.createPartnerCustomer).mockClear();

    const again = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });

    await expect(ensurePartnerCustomer(again)).resolves.toBe('pcus_1');
    expect(client.createPartnerCustomer).not.toHaveBeenCalled();
  });

  /**
   * The caller may hold a row read before somebody else connected — the
   * workspace on `req` is loaded by `requireMembership` at the top of the
   * request. A stale null must not mint a second customer.
   */
  it('re-reads rather than trusting a stale null on the row it was handed', async () => {
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { partnerCustomerId: 'pcus_existing' },
    });

    await expect(ensurePartnerCustomer(workspace)).resolves.toBe('pcus_existing');
    expect(client.createPartnerCustomer).not.toHaveBeenCalled();
  });

  it('creates once when two callers race the first use', async () => {
    vi.mocked(client.createPartnerCustomer).mockImplementation(
      async () =>
        new Promise((resolve) => setTimeout(() => resolve(customerNamed('pcus_1')), 10)),
    );

    const [first, second] = await Promise.all([
      ensurePartnerCustomer(workspace),
      ensurePartnerCustomer(workspace),
    ]);

    expect(first).toBe('pcus_1');
    expect(second).toBe('pcus_1');
    expect(client.createPartnerCustomer).toHaveBeenCalledTimes(1);
  });

  /**
   * A lost response is the case the whole design of this function is for:
   * upstream is idempotent on `external_id`, so the retry finds the customer
   * the first attempt made rather than making a second one. What must not
   * happen is the failure being cached — the next call has to try again.
   */
  it('lets a failed create be retried, and lands on the same customer', async () => {
    vi.mocked(client.createPartnerCustomer).mockRejectedValueOnce(
      new ApiError(502, 'UPSTREAM_WRITE_UNCONFIRMED', 'no answer'),
    );

    await expect(ensurePartnerCustomer(workspace)).rejects.toMatchObject({ status: 502 });

    vi.mocked(client.createPartnerCustomer).mockResolvedValue(customerNamed('pcus_1'));

    await expect(ensurePartnerCustomer(workspace)).resolves.toBe('pcus_1');
    const stored = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    expect(stored.partnerCustomerId).toBe('pcus_1');
  });

  it('refuses a customer upstream did not name', async () => {
    vi.mocked(client.createPartnerCustomer).mockResolvedValue({ external_id: workspace.id });

    const err = await ensurePartnerCustomer(workspace).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(502);
    const stored = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    expect(stored.partnerCustomerId).toBeNull();
  });

  /**
   * The customer id upstream returned is already stored against a DIFFERENT
   * workspace. Nothing legitimate produces that — the create is keyed by
   * workspace id — so it is refused loudly rather than written over: the row
   * holding it would otherwise silently lose its connections to this caller.
   */
  it('refuses when the id upstream returned belongs to another workspace', async () => {
    const other = await makeWorkspace(await makeAccount('bob'), 'Beta');
    await prisma.workspace.update({
      where: { id: other.id },
      data: { partnerCustomerId: 'pcus_1' },
    });
    vi.mocked(client.createPartnerCustomer).mockResolvedValue(customerNamed('pcus_1'));

    const err = await ensurePartnerCustomer(workspace).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(502);
    const stored = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    expect(stored.partnerCustomerId).toBeNull();
    expect(
      (await prisma.workspace.findUniqueOrThrow({ where: { id: other.id } })).partnerCustomerId,
    ).toBe('pcus_1');
  });

  /** Upstream caps the name at 200 characters and 400s past it. A workspace
   *  name cannot reach that today; the guard is for the day the cap moves. */
  it('trims an over-long workspace name to what upstream accepts', async () => {
    const long = await prisma.workspace.update({
      where: { id: workspace.id },
      data: { name: 'x'.repeat(250) },
    });
    vi.mocked(client.createPartnerCustomer).mockResolvedValue(customerNamed('pcus_1'));

    await ensurePartnerCustomer(long);

    expect(vi.mocked(client.createPartnerCustomer).mock.calls[0][0].name).toHaveLength(200);
  });
});
