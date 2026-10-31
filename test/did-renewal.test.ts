import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';
import { runRenewalSweep } from '../src/services/didRenewal.js';

const DEFAULT_PRICE = 5_000_000n;

const JULY = new Date('2026-07-15T00:00:00.000Z');
const SEPTEMBER = new Date('2026-09-15T00:00:00.000Z');

/**
 * Strictly between JULY and JULY+1month, so a DID that renews once is not
 * immediately due again. Picking the boundary instead would make the
 * idempotency cases indistinguishable from correct catch-up billing — see the
 * boundary case at the end of this file.
 */
const AUGUST = new Date('2026-08-01T00:00:00.000Z');

let owner: Account;
let workspace: Workspace;

async function fund(account: Account, credits: bigint): Promise<void> {
  await prisma.account.update({ where: { id: account.id }, data: { credits } });
}

async function rentedDid(
  did: string,
  nextRenewalAt: Date,
  workspaceId: string,
  overrides: Record<string, unknown> = {},
) {
  return prisma.phoneNumber.create({
    data: {
      did,
      status: 'ASSIGNED',
      workspaceId,
      rentedAt: JULY,
      nextRenewalAt,
      ...overrides,
    },
  });
}

const balanceOf = async (account: Account) =>
  (await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).credits;

const didById = (id: string) => prisma.phoneNumber.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  await truncateAll();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  owner = await makeAccount('owner');
  workspace = await makeWorkspace(owner, 'Acme');
});

describe('runRenewalSweep', () => {
  it('charges a DID whose renewal date has arrived and advances it a month', async () => {
    await fund(owner, 10_000_000n);
    const did = await rentedDid('+919429390403', JULY, workspace.id);

    expect(await runRenewalSweep({ now: AUGUST })).toMatchObject({ renewed: 1, released: 0 });

    expect(await balanceOf(owner)).toBe(5_000_000n);
    // Advanced from the DUE date, not from now.
    expect((await didById(did.id)).nextRenewalAt?.toISOString()).toBe('2026-08-15T00:00:00.000Z');

    const ledger = await prisma.creditTransaction.findMany();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      accountId: owner.id,
      workspaceId: workspace.id,
      phoneNumberId: did.id,
      amount: -DEFAULT_PRICE,
      type: 'DID_RENEWAL',
    });
  });

  it('leaves a DID whose renewal is still in the future alone', async () => {
    await fund(owner, 10_000_000n);
    const did = await rentedDid('+919429390403', SEPTEMBER, workspace.id);

    expect(await runRenewalSweep({ now: AUGUST })).toMatchObject({ renewed: 0, released: 0 });

    expect(await balanceOf(owner)).toBe(10_000_000n);
    expect((await didById(did.id)).nextRenewalAt?.toISOString()).toBe(SEPTEMBER.toISOString());
    expect(await prisma.creditTransaction.count()).toBe(0);
  });

  it('is idempotent: a second sweep at the same instant charges nothing more', async () => {
    // The central property. Two runners, or a retry, must not bill twice.
    await fund(owner, 20_000_000n);
    await rentedDid('+919429390403', JULY, workspace.id);

    await runRenewalSweep({ now: AUGUST });
    expect(await runRenewalSweep({ now: AUGUST })).toMatchObject({ renewed: 0 });

    expect(await prisma.creditTransaction.count()).toBe(1);
    expect(await balanceOf(owner)).toBe(15_000_000n);
  });

  it('is safe when two sweeps run concurrently', async () => {
    await fund(owner, 20_000_000n);
    await rentedDid('+919429390403', JULY, workspace.id);

    await Promise.all([runRenewalSweep({ now: AUGUST }), runRenewalSweep({ now: AUGUST })]);

    expect(await prisma.creditTransaction.count()).toBe(1);
    expect(await balanceOf(owner)).toBe(15_000_000n);
  });

  it('charges once per sweep for a DID overdue by three months', async () => {
    // Advancing from `now` would forgive the gap; charging the whole backlog
    // at once would empty the account without warning.
    await fund(owner, 20_000_000n);
    const did = await rentedDid('+919429390403', new Date('2026-05-15T00:00:00.000Z'), workspace.id);

    for (let i = 0; i < 3; i += 1) await runRenewalSweep({ now: AUGUST });

    expect(await prisma.creditTransaction.count({ where: { type: 'DID_RENEWAL' } })).toBe(3);
    expect(await balanceOf(owner)).toBe(5_000_000n);
    expect((await didById(did.id)).nextRenewalAt?.toISOString()).toBe('2026-08-15T00:00:00.000Z');
  });

  it('marks a DID past due rather than taking it away on the first declined charge', async () => {
    await fund(owner, DEFAULT_PRICE - 1n);
    const did = await rentedDid('+919429390403', JULY, workspace.id);

    expect(await runRenewalSweep({ now: AUGUST })).toMatchObject({
      renewed: 0,
      pastDue: 1,
      released: 0,
    });

    // The number is still theirs and still rings. One credit short at the
    // instant the sweep ran must not cost somebody a published business line.
    const after = await didById(did.id);
    expect(after.status).toBe('PAST_DUE');
    expect(after.workspaceId).toBe(workspace.id);
    expect(after.pastDueSince?.toISOString()).toBe(AUGUST.toISOString());
    // The due date is unmoved, so the next pass retries this same month.
    expect(after.nextRenewalAt?.toISOString()).toBe(JULY.toISOString());

    // A failed charge that left a debit behind is the worst outcome available.
    expect(await balanceOf(owner)).toBe(DEFAULT_PRICE - 1n);
    expect(await prisma.creditTransaction.count()).toBe(0);
  });

  it('keeps the first decline as the deadline, however many times it retries', async () => {
    await fund(owner, 0n);
    const did = await rentedDid('+919429390403', JULY, workspace.id);

    await runRenewalSweep({ now: AUGUST });
    const firstMark = (await didById(did.id)).pastDueSince;

    // Days later, still broke. The window must not restart on every attempt,
    // or a customer who never pays is never released.
    await runRenewalSweep({ now: new Date('2026-08-04T00:00:00.000Z') });

    const after = await didById(did.id);
    expect(after.pastDueSince?.toISOString()).toBe(firstMark?.toISOString());
    expect(after.status).toBe('PAST_DUE');
  });

  it('charges a past-due DID that has been topped up, and clears the mark', async () => {
    await fund(owner, 0n);
    const did = await rentedDid('+919429390403', JULY, workspace.id);

    await runRenewalSweep({ now: AUGUST });
    expect((await didById(did.id)).status).toBe('PAST_DUE');

    await fund(owner, 10_000_000n);
    expect(await runRenewalSweep({ now: new Date('2026-08-02T00:00:00.000Z') })).toMatchObject({
      renewed: 1,
      pastDue: 0,
      released: 0,
    });

    const after = await didById(did.id);
    expect(after.status).toBe('ASSIGNED');
    expect(after.pastDueSince).toBeNull();
    expect(await balanceOf(owner)).toBe(5_000_000n);
  });

  it('releases only once the grace window has run out', async () => {
    await fund(owner, 0n);
    const did = await rentedDid('+919429390403', JULY, workspace.id);

    await runRenewalSweep({ now: AUGUST, graceDays: 7 });

    // Day 6: still theirs.
    await runRenewalSweep({ now: new Date('2026-08-07T00:00:00.000Z'), graceDays: 7 });
    expect((await didById(did.id)).workspaceId).toBe(workspace.id);

    // Day 8: gone.
    expect(
      await runRenewalSweep({ now: new Date('2026-08-09T00:00:00.000Z'), graceDays: 7 }),
    ).toMatchObject({ released: 1 });

    const after = await didById(did.id);
    expect(after.status).toBe('RELEASED_NONPAYMENT');
    expect(after.workspaceId).toBeNull();
    expect(after.rentedAt).toBeNull();
    expect(after.nextRenewalAt).toBeNull();
    expect(after.pastDueSince).toBeNull();
    expect(after.rentedPriceCredits).toBeNull();

    expect(await balanceOf(owner)).toBe(0n);
    expect(await prisma.creditTransaction.count({ where: { type: 'DID_RENEWAL' } })).toBe(0);

    const marker = await prisma.creditTransaction.findFirstOrThrow();
    expect(marker).toMatchObject({
      accountId: owner.id,
      workspaceId: workspace.id,
      phoneNumberId: did.id,
      amount: 0n,
      type: 'DID_RELEASE_NONPAYMENT',
    });
  });

  it('releases on the first decline when the grace window is zero', async () => {
    await fund(owner, 0n);
    const did = await rentedDid('+919429390403', JULY, workspace.id);

    expect(await runRenewalSweep({ now: AUGUST, graceDays: 0 })).toMatchObject({ released: 1 });
    expect((await didById(did.id)).status).toBe('RELEASED_NONPAYMENT');
  });

  it('leaves a released DID rentable again', async () => {
    await fund(owner, 0n);
    const did = await rentedDid('+919429390403', JULY, workspace.id);

    await runRenewalSweep({ now: AUGUST, graceDays: 0 });

    // The pool is every DID with no workspace; the status only records why.
    const pool = await prisma.phoneNumber.findMany({ where: { workspaceId: null } });
    expect(pool.map((n) => n.id)).toEqual([did.id]);
  });

  it('stops releasing once one pass has taken back too many numbers', async () => {
    // The realistic cause of a mass release is a pricing mistake that made
    // everybody insolvent at once. Finishing the run correctly is worth less
    // than stopping while there is still something to put back.
    await fund(owner, 0n);
    for (let i = 0; i < 4; i += 1) {
      await rentedDid(`+91942939040${i}`, JULY, workspace.id);
    }

    const result = await runRenewalSweep({ now: AUGUST, graceDays: 0, maxReleases: 2 });

    expect(result).toMatchObject({ released: 2, haltedOnReleaseCap: true });
    expect(await prisma.phoneNumber.count({ where: { workspaceId: workspace.id } })).toBe(2);
  });

  it('keeps sweeping after one DID fails', async () => {
    const solvent = await makeAccount('solvent');
    const solventWorkspace = await makeWorkspace(solvent, 'Solvent');
    await fund(owner, 0n);
    await fund(solvent, 10_000_000n);

    await rentedDid('+919429390403', JULY, workspace.id);
    await rentedDid('+919429390404', JULY, solventWorkspace.id);

    expect(await runRenewalSweep({ now: AUGUST })).toMatchObject({ renewed: 1, pastDue: 1 });
    expect(await balanceOf(solvent)).toBe(5_000_000n);
  });

  it('charges the price the workspace agreed to, not the catalog price', async () => {
    // The whole reason the snapshot exists: re-pricing a DID, or correcting
    // the global default, must not re-bill somebody already renting it.
    await fund(owner, 10_000_000n);
    await rentedDid('+919429390403', JULY, workspace.id, {
      rentedPriceCredits: 1_000_000n,
      monthlyPriceCredits: 9_000_000n,
    });

    await runRenewalSweep({ now: AUGUST });

    expect(await balanceOf(owner)).toBe(9_000_000n);
  });

  it('ignores an unowned DID even when its renewal date is past', async () => {
    await fund(owner, 10_000_000n);
    await prisma.phoneNumber.create({
      data: { did: '+919429390403', status: 'UNASSIGNED', nextRenewalAt: JULY },
    });

    expect(await runRenewalSweep({ now: AUGUST })).toMatchObject({ renewed: 0, released: 0 });
    expect(await prisma.creditTransaction.count()).toBe(0);
  });

  it('honours a per-DID price', async () => {
    await fund(owner, 10_000_000n);
    await rentedDid('+919429390403', JULY, workspace.id, { monthlyPriceCredits: 1_000_000n });

    await runRenewalSweep({ now: AUGUST });

    expect(await balanceOf(owner)).toBe(9_000_000n);
  });

  it('charges again when the advanced date is itself already due', async () => {
    // Not double billing: a DID due 15 July, swept on 15 August, owes both
    // July-August and August-September. Each pass charges exactly one month,
    // which is what keeps a backlog from emptying an account in one go.
    await fund(owner, 20_000_000n);
    await rentedDid('+919429390403', JULY, workspace.id);

    await runRenewalSweep({ now: new Date('2026-08-15T00:00:00.000Z') });
    await runRenewalSweep({ now: new Date('2026-08-15T00:00:00.000Z') });

    expect(await prisma.creditTransaction.count({ where: { type: 'DID_RENEWAL' } })).toBe(2);
  });

  it('renews a free DID without touching the balance', async () => {
    await fund(owner, 0n);
    const did = await rentedDid('+919429390403', JULY, workspace.id, { monthlyPriceCredits: 0n });

    expect(await runRenewalSweep({ now: AUGUST })).toMatchObject({ renewed: 1, released: 0 });
    expect((await didById(did.id)).status).toBe('ASSIGNED');
  });
});
