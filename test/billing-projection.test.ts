import { beforeEach, describe, expect, it } from 'vitest';
import type { Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';
import { toInternalCredits } from '../src/lib/credits.js';
import { projectUpcomingRenewals } from '../src/services/billingProjection.js';

const DAY = 24 * 60 * 60 * 1000;

let workspace: Workspace;
let sequence = 0;

/** A DID held by `workspaceId`, renewing in ten days at 500 credits. */
async function makeDid(workspaceId: string | null, overrides: Record<string, unknown> = {}) {
  sequence += 1;

  return prisma.phoneNumber.create({
    data: {
      did: `+1415555${String(1000 + sequence)}`,
      provider: 'voicelink',
      status: workspaceId ? 'ASSIGNED' : 'UNASSIGNED',
      workspaceId,
      rentedPriceCredits: toInternalCredits('500'),
      nextRenewalAt: new Date(Date.now() + 10 * DAY),
      ...overrides,
    },
  });
}

beforeEach(async () => {
  await truncateAll();
  workspace = await makeWorkspace(await makeAccount('owner'), 'Acme');
});

describe('projectUpcomingRenewals', () => {
  it('sums the numbers renewing inside the window', async () => {
    await makeDid(workspace.id);
    await makeDid(workspace.id);

    const result = await projectUpcomingRenewals(workspace.id, workspace.ownerAccountId, toInternalCredits('2000'));

    expect(result.windowDays).toBe(30);
    expect(result.renewalCount).toBe(2);
    expect(result.totalCredits).toBe(toInternalCredits('1000'));
    expect(result.covers).toBe(true);
    expect(result.shortfallCredits).toBeNull();
  });

  it('reports the shortfall when the balance will not cover it', async () => {
    await makeDid(workspace.id);
    await makeDid(workspace.id);

    const result = await projectUpcomingRenewals(workspace.id, workspace.ownerAccountId, toInternalCredits('800'));

    expect(result.covers).toBe(false);
    expect(result.shortfallCredits).toBe(toInternalCredits('200'));
  });

  it('treats a balance exactly equal to the total as covering it', async () => {
    await makeDid(workspace.id);

    const result = await projectUpcomingRenewals(workspace.id, workspace.ownerAccountId, toInternalCredits('500'));

    expect(result.covers).toBe(true);
    expect(result.shortfallCredits).toBeNull();
  });

  it('ignores a renewal beyond the window', async () => {
    await makeDid(workspace.id, { nextRenewalAt: new Date(Date.now() + 45 * DAY) });

    const result = await projectUpcomingRenewals(workspace.id, workspace.ownerAccountId, 0n);

    expect(result.renewalCount).toBe(0);
    expect(result.totalCredits).toBe(0n);
    expect(result.covers).toBe(true);
  });

  // A declined charge does not move `nextRenewalAt` — that is what makes the
  // sweep retry the same month — so a PAST_DUE number is already inside every
  // window by date. It is also the strongest evidence that the balance is
  // short, so excluding it would drop the one case this warning exists for.
  it('includes a past-due number, whose renewal date is already behind us', async () => {
    await makeDid(workspace.id, {
      status: 'PAST_DUE',
      nextRenewalAt: new Date(Date.now() - 3 * DAY),
      pastDueSince: new Date(Date.now() - 3 * DAY),
    });

    const result = await projectUpcomingRenewals(workspace.id, workspace.ownerAccountId, 0n);

    expect(result.renewalCount).toBe(1);
    expect(result.totalCredits).toBe(toInternalCredits('500'));
    expect(result.covers).toBe(false);
  });

  // Folding an unknown date into a total would present a guess as a sum.
  it('counts a number with no renewal date separately instead of guessing', async () => {
    await makeDid(workspace.id, { nextRenewalAt: null });

    const result = await projectUpcomingRenewals(workspace.id, workspace.ownerAccountId, 0n);

    expect(result.renewalCount).toBe(0);
    expect(result.unscheduledCount).toBe(1);
    expect(result.totalCredits).toBe(0n);
    expect(result.covers).toBe(true);
  });

  it('charges the agreed price, not the catalog price staff may have changed', async () => {
    await makeDid(workspace.id, {
      rentedPriceCredits: toInternalCredits('300'),
      monthlyPriceCredits: toInternalCredits('900'),
    });

    const result = await projectUpcomingRenewals(workspace.id, workspace.ownerAccountId, 0n);

    expect(result.totalCredits).toBe(toInternalCredits('300'));
  });

  it('falls back to the catalog price for a rental taken before the snapshot existed', async () => {
    await makeDid(workspace.id, {
      rentedPriceCredits: null,
      monthlyPriceCredits: toInternalCredits('120'),
    });

    const result = await projectUpcomingRenewals(workspace.id, workspace.ownerAccountId, 0n);

    expect(result.totalCredits).toBe(toInternalCredits('120'));
  });

  it("does not count another workspace's numbers", async () => {
    const other = await makeWorkspace(await makeAccount('rival'), 'Rival');
    await makeDid(other.id);

    const result = await projectUpcomingRenewals(workspace.id, workspace.ownerAccountId, 0n);

    expect(result.renewalCount).toBe(0);
    expect(result.unscheduledCount).toBe(0);
  });

  it('does not count numbers sitting in the shared pool', async () => {
    await makeDid(null);

    const result = await projectUpcomingRenewals(workspace.id, workspace.ownerAccountId, 0n);

    expect(result.renewalCount).toBe(0);
    expect(result.unscheduledCount).toBe(0);
  });

  it('answers a workspace holding nothing', async () => {
    const result = await projectUpcomingRenewals(workspace.id, workspace.ownerAccountId, toInternalCredits('10'));

    expect(result).toMatchObject({
      renewalCount: 0,
      unscheduledCount: 0,
      totalCredits: 0n,
      covers: true,
      shortfallCredits: null,
    });
  });

  it("counts a sibling workspace's renewals into the account total, not this one's", async () => {
    // One owner, two workspaces, one balance. This is the case a per-workspace
    // comparison got wrong: 1000 credits against 800 + 800 reported `covers:
    // true` on both pages while the account was 600 short.
    const sibling = await makeWorkspace(
      await prisma.account.findUniqueOrThrow({ where: { id: workspace.ownerAccountId } }),
      'Skunkworks',
    );

    await makeDid(workspace.id, { rentedPriceCredits: toInternalCredits('800') });
    await makeDid(sibling.id, { rentedPriceCredits: toInternalCredits('800') });

    const result = await projectUpcomingRenewals(
      workspace.id,
      workspace.ownerAccountId,
      toInternalCredits('1000'),
    );

    // This workspace's own table still shows only its own number.
    expect(result.renewalCount).toBe(1);
    expect(result.totalCredits).toBe(toInternalCredits('800'));

    // But the claim about the balance is made against everything that balance
    // has to pay for.
    expect(result.accountTotalCredits).toBe(toInternalCredits('1600'));
    expect(result.covers).toBe(false);
    expect(result.shortfallCredits).toBe(toInternalCredits('600'));
  });

  it('reports the account total as equal to its own when the owner has one workspace', async () => {
    await makeDid(workspace.id);

    const result = await projectUpcomingRenewals(workspace.id, workspace.ownerAccountId, 0n);

    expect(result.accountTotalCredits).toBe(result.totalCredits);
  });

  it("leaves another account's workspace out of the account total", async () => {
    const rival = await makeWorkspace(await makeAccount('rival'), 'Rival');
    await makeDid(rival.id);

    const result = await projectUpcomingRenewals(workspace.id, workspace.ownerAccountId, 0n);

    expect(result.accountTotalCredits).toBe(0n);
    expect(result.covers).toBe(true);
  });

  it('ignores a number released for non-payment even if it still names a workspace', async () => {
    // The sweep filters `status IN (ASSIGNED, PAST_DUE)` and this must select
    // the same rows. Every release path nulls `workspaceId` in the same
    // statement that sets the terminal status, so this shape should not occur
    // — which is exactly why the projection must not depend on it not
    // occurring.
    await makeDid(workspace.id, { status: 'RELEASED_NONPAYMENT' });

    const result = await projectUpcomingRenewals(workspace.id, workspace.ownerAccountId, 0n);

    expect(result.renewalCount).toBe(0);
    expect(result.totalCredits).toBe(0n);
  });

  it('counts a past-due number, which is the case the warning exists for', async () => {
    await makeDid(workspace.id, {
      status: 'PAST_DUE',
      nextRenewalAt: new Date(Date.now() - 3 * DAY),
    });

    const result = await projectUpcomingRenewals(workspace.id, workspace.ownerAccountId, 0n);

    expect(result.renewalCount).toBe(1);
    expect(result.covers).toBe(false);
  });

  it('takes the window from the moment it is given, not from the clock', async () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    // 29 June is inside a 30-day window from 1 June; 5 July is not.
    await makeDid(workspace.id, { nextRenewalAt: new Date('2026-06-29T00:00:00.000Z') });
    await makeDid(workspace.id, { nextRenewalAt: new Date('2026-07-05T00:00:00.000Z') });

    const result = await projectUpcomingRenewals(workspace.id, workspace.ownerAccountId, 0n, now);

    expect(result.renewalCount).toBe(1);
  });
});
