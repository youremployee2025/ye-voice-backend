import { beforeEach, describe, expect, it } from 'vitest';
import type { Account, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, makeAccount, makeWorkspace } from './helpers.js';
import {
  InsufficientCreditsError,
  PhoneNumberNotHeldError,
  PhoneNumberTakenError,
  priceOf,
  releasePhoneNumber,
  rentPhoneNumber,
} from '../src/services/didRental.js';

/** 500 display credits — the configured global default. */
const DEFAULT_PRICE = 5_000_000n;

let owner: Account;
let workspace: Workspace;

async function fund(account: Account, credits: bigint): Promise<void> {
  await prisma.account.update({ where: { id: account.id }, data: { credits } });
}

async function makeDid(did: string, overrides: Record<string, unknown> = {}) {
  return prisma.phoneNumber.create({ data: { did, provider: 'voicelink', ...overrides } });
}

const balanceOf = async (account: Account) =>
  (await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).credits;

beforeEach(async () => {
  await truncateAll();
  owner = await makeAccount('owner');
  workspace = await makeWorkspace(owner, 'Acme');
});

describe('priceOf', () => {
  it('falls back to the configured global default', () => {
    expect(priceOf({ monthlyPriceCredits: null })).toBe(DEFAULT_PRICE);
  });

  it('prefers a per-DID price staff set', () => {
    expect(priceOf({ monthlyPriceCredits: 123_400n })).toBe(123_400n);
  });

  it('treats an explicit zero as free, not as unset', () => {
    expect(priceOf({ monthlyPriceCredits: 0n })).toBe(0n);
  });
});

describe('rentPhoneNumber', () => {
  it('charges the workspace owner the full price and assigns the DID', async () => {
    await fund(owner, 10_000_000n);
    const did = await makeDid('+919429390403');

    const rented = await rentPhoneNumber({ phoneNumberId: did.id, workspace });

    expect(await balanceOf(owner)).toBe(5_000_000n);
    expect(rented.status).toBe('ASSIGNED');
    expect(rented.workspaceId).toBe(workspace.id);
    expect(rented.rentedAt).not.toBeNull();
    expect(rented.nextRenewalAt).not.toBeNull();

    const ledger = await prisma.creditTransaction.findMany();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      accountId: owner.id,
      workspaceId: workspace.id,
      phoneNumberId: did.id,
      amount: -DEFAULT_PRICE,
      type: 'DID_PURCHASE',
    });
  });

  it('sets the renewal date one calendar month out', async () => {
    await fund(owner, 10_000_000n);
    const did = await makeDid('+919429390403');

    const rented = await rentPhoneNumber({ phoneNumberId: did.id, workspace });
    const rentedAt = rented.rentedAt!;
    const renewal = rented.nextRenewalAt!;

    expect(renewal.getTime()).toBeGreaterThan(rentedAt.getTime());
    const expected = new Date(rentedAt);
    expected.setUTCMonth(expected.getUTCMonth() + 1);
    // Same day-of-month, or clamped back into a shorter month — never later.
    expect(renewal.getTime()).toBeLessThanOrEqual(expected.getTime());
  });

  it('charges the OWNER, not the admin who clicked', async () => {
    const admin = await makeAccount('admin');
    await addMember(workspace, admin, 'ADMIN');
    await fund(owner, 10_000_000n);
    await fund(admin, 10_000_000n);
    const did = await makeDid('+919429390403');

    await rentPhoneNumber({ phoneNumberId: did.id, workspace });

    expect(await balanceOf(owner)).toBe(5_000_000n);
    expect(await balanceOf(admin)).toBe(10_000_000n);
    expect((await prisma.creditTransaction.findFirstOrThrow()).accountId).toBe(owner.id);
  });

  it('uses a per-DID price when staff set one', async () => {
    await fund(owner, 10_000_000n);
    const did = await makeDid('+919429390403', { monthlyPriceCredits: 1_000_000n });

    await rentPhoneNumber({ phoneNumberId: did.id, workspace });

    expect(await balanceOf(owner)).toBe(9_000_000n);
    expect((await prisma.creditTransaction.findFirstOrThrow()).amount).toBe(-1_000_000n);
  });

  it('refuses a rental the owner cannot afford, and changes nothing', async () => {
    await fund(owner, DEFAULT_PRICE - 1n);
    const did = await makeDid('+919429390403');

    await expect(rentPhoneNumber({ phoneNumberId: did.id, workspace })).rejects.toBeInstanceOf(
      InsufficientCreditsError,
    );

    // The rollback IS the assertion: a claimed DID with no charge is a free
    // rental, and a charge with no DID is theft.
    expect(await balanceOf(owner)).toBe(DEFAULT_PRICE - 1n);
    const after = await prisma.phoneNumber.findUniqueOrThrow({ where: { id: did.id } });
    expect(after.status).toBe('UNASSIGNED');
    expect(after.workspaceId).toBeNull();
    expect(after.nextRenewalAt).toBeNull();
    expect(await prisma.creditTransaction.count()).toBe(0);
  });

  it('refuses a DID already assigned to another workspace', async () => {
    const other = await makeWorkspace(await makeAccount('other'), 'Other');
    await fund(owner, 10_000_000n);
    const did = await makeDid('+919429390403', { status: 'ASSIGNED', workspaceId: other.id });

    await expect(rentPhoneNumber({ phoneNumberId: did.id, workspace })).rejects.toBeInstanceOf(
      PhoneNumberTakenError,
    );

    expect(await balanceOf(owner)).toBe(10_000_000n);
    expect(await prisma.creditTransaction.count()).toBe(0);
  });

  it('rents a DID released for non-payment and clears the marker', async () => {
    await fund(owner, 10_000_000n);
    const did = await makeDid('+919429390403', { status: 'RELEASED_NONPAYMENT' });

    const rented = await rentPhoneNumber({ phoneNumberId: did.id, workspace });

    expect(rented.status).toBe('ASSIGNED');
    expect(rented.workspaceId).toBe(workspace.id);
  });

  it('lets only one of two concurrent rentals win', async () => {
    const rival = await makeAccount('rival');
    const rivalWorkspace = await makeWorkspace(rival, 'Rival');
    await fund(owner, 10_000_000n);
    await fund(rival, 10_000_000n);
    const did = await makeDid('+919429390403');

    const outcomes = await Promise.allSettled([
      rentPhoneNumber({ phoneNumberId: did.id, workspace }),
      rentPhoneNumber({ phoneNumberId: did.id, workspace: rivalWorkspace }),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(PhoneNumberTakenError);

    // One DID, one owner, one charge.
    expect(await prisma.creditTransaction.count()).toBe(1);
    const after = await prisma.phoneNumber.findUniqueOrThrow({ where: { id: did.id } });
    expect([workspace.id, rivalWorkspace.id]).toContain(after.workspaceId);
    expect((await balanceOf(owner)) + (await balanceOf(rival))).toBe(15_000_000n);
  });

  it('never lets a balance go negative under concurrent rentals', async () => {
    // Enough for exactly one number, two rentals at once.
    await fund(owner, DEFAULT_PRICE);
    const first = await makeDid('+919429390403');
    const second = await makeDid('+919429390404');

    const outcomes = await Promise.allSettled([
      rentPhoneNumber({ phoneNumberId: first.id, workspace }),
      rentPhoneNumber({ phoneNumberId: second.id, workspace }),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(await balanceOf(owner)).toBe(0n);
    expect(await prisma.creditTransaction.count()).toBe(1);
  });

  it('reports a DID that does not exist as taken rather than crashing', async () => {
    await fund(owner, 10_000_000n);

    await expect(
      rentPhoneNumber({ phoneNumberId: 'no-such-id', workspace }),
    ).rejects.toBeInstanceOf(PhoneNumberTakenError);
  });
});

describe('releasePhoneNumber', () => {
  it('returns the DID to the pool with a zero-amount marker and no refund', async () => {
    await fund(owner, 10_000_000n);
    const did = await makeDid('+919429390403');
    await rentPhoneNumber({ phoneNumberId: did.id, workspace });

    await releasePhoneNumber({ phoneNumberId: did.id, workspace });

    const after = await prisma.phoneNumber.findUniqueOrThrow({ where: { id: did.id } });
    expect(after.status).toBe('UNASSIGNED');
    expect(after.workspaceId).toBeNull();
    expect(after.rentedAt).toBeNull();
    expect(after.nextRenewalAt).toBeNull();

    // The month was paid in full at its start; giving the number back partway
    // through does not un-spend it.
    expect(await balanceOf(owner)).toBe(5_000_000n);

    const marker = await prisma.creditTransaction.findFirstOrThrow({
      where: { type: 'DID_RELEASE' },
    });
    expect(marker.amount).toBe(0n);
    // Still names the workspace it left, so the history survives the release.
    expect(marker.workspaceId).toBe(workspace.id);
    expect(marker.phoneNumberId).toBe(did.id);
  });

  it('refuses to release a DID this workspace does not hold', async () => {
    const other = await makeWorkspace(await makeAccount('other'), 'Other');
    const did = await makeDid('+919429390403', { status: 'ASSIGNED', workspaceId: other.id });

    await expect(releasePhoneNumber({ phoneNumberId: did.id, workspace })).rejects.toBeInstanceOf(
      PhoneNumberNotHeldError,
    );

    expect((await prisma.phoneNumber.findUniqueOrThrow({ where: { id: did.id } })).workspaceId).toBe(
      other.id,
    );
    expect(await prisma.creditTransaction.count()).toBe(0);
  });

  it('releases only once when called twice concurrently', async () => {
    await fund(owner, 10_000_000n);
    const did = await makeDid('+919429390403');
    await rentPhoneNumber({ phoneNumberId: did.id, workspace });

    const outcomes = await Promise.allSettled([
      releasePhoneNumber({ phoneNumberId: did.id, workspace }),
      releasePhoneNumber({ phoneNumberId: did.id, workspace }),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.creditTransaction.count({ where: { type: 'DID_RELEASE' } })).toBe(1);
  });
});
