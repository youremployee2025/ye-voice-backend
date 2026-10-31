import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NON_TERMINAL_ATTEMPT_STATUSES,
  accountInFlight,
  campaignInFlight,
  campaignLaneInFlight,
  resolveAccountConcurrency,
} from '../src/lib/concurrency.js';
import { env } from '../src/lib/env.js';
import { prisma } from '../src/lib/prisma.js';
import { makeAccount, makeAgent, makeWorkspace } from './helpers.js';
import { truncateAll } from './setup.js';

describe('resolveAccountConcurrency', () => {
  it("uses the account's own limit when staff have set one", () => {
    expect(resolveAccountConcurrency({ concurrencyLimit: 7 })).toBe(7);
  });

  it('falls back to the platform default when the account has none', () => {
    expect(resolveAccountConcurrency({ concurrencyLimit: null })).toBe(
      env.dialerDefaultAccountConcurrency,
    );
  });

  /**
   * The reason this module exists.
   *
   * Zero is a limit somebody set — "this account may not dial" — and absence
   * is not a limit at all. `||` is falsy on `0` and would step straight over a
   * deliberate stop onto the default, silently starting an account dialing
   * again after staff had halted it. `tierPricing.ts` documents the identical
   * trap for a `0n` price; it is worse here because nothing about the outcome
   * looks wrong until somebody's phone rings.
   */
  it('treats a deliberate zero as zero, not as unset', () => {
    expect(resolveAccountConcurrency({ concurrencyLimit: 0 })).toBe(0);
  });

  it('does not confuse zero with the default even when the default is nonzero', () => {
    expect(env.dialerDefaultAccountConcurrency).toBeGreaterThan(0);
    expect(resolveAccountConcurrency({ concurrencyLimit: 0 })).not.toBe(
      env.dialerDefaultAccountConcurrency,
    );
  });
});

describe('the non-terminal set', () => {
  /**
   * The voice platform counts `PENDING, RINGING, IN_PROGRESS` toward its
   * account-wide concurrency ceiling. Ours must mean the same calls, or a
   * local cap and the remote cap disagree about the same call and the sweep
   * paces against a number that is not the one being enforced.
   */
  it('is the three statuses the platform also counts as in flight', () => {
    expect([...NON_TERMINAL_ATTEMPT_STATUSES].sort()).toEqual([
      'IN_PROGRESS',
      'QUEUED',
      'RINGING',
    ]);
  });
});

describe('counting what is in flight', () => {
  let accountId: string;
  let workspaceId: string;
  let campaignId: string;
  let otherCampaignId: string;

  // Each dial gets its own number: one contact may only hold one attempt per
  // `attemptNo`, which is what stops two dispatchers placing the same call.
  let attemptNo = 0;

  /**
   * One attempt row. `kind` is the lane the claim spent on it, and it is what
   * the lane count reads; a row left unstamped — every row written before the
   * stamp existed — still occupies a line like any other.
   */
  const attempt = (
    cid: string,
    ccid: string,
    status: 'QUEUED' | 'RINGING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'ABANDONED',
    kind?: string,
  ) => {
    attemptNo += 1;

    return prisma.callAttempt.create({
      data: {
        campaignId: cid,
        campaignContactId: ccid,
        workspaceId,
        accountId,
        attemptNo,
        status,
        kind,
      },
    });
  };

  beforeEach(async () => {
    await truncateAll();

    const account = await makeAccount('lines');
    const workspace = await makeWorkspace(account, 'Lines');
    const agent = await makeAgent(workspace, 'dialer');

    accountId = account.id;
    workspaceId = workspace.id;
    attemptNo = 0;

    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'One', agentId: agent.id, status: 'RUNNING' },
    });
    const other = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'Two', agentId: agent.id, status: 'RUNNING' },
    });

    campaignId = campaign.id;
    otherCampaignId = other.id;

    const contact = await prisma.contact.create({
      data: { workspaceId: workspace.id, phone: '+919876500001' },
    });

    const link = async (cid: string) =>
      prisma.campaignContact.create({ data: { campaignId: cid, contactId: contact.id } });

    const one = await link(campaignId);
    const two = await link(otherCampaignId);

    await attempt(campaignId, one.id, 'QUEUED');
    await attempt(campaignId, one.id, 'RINGING');
    await attempt(campaignId, one.id, 'IN_PROGRESS');
    // Terminal rows must not be counted; each of the three is a separate way
    // an attempt can stop occupying a line.
    await attempt(campaignId, one.id, 'COMPLETED');
    await attempt(campaignId, one.id, 'FAILED');
    await attempt(campaignId, one.id, 'ABANDONED');
    await attempt(otherCampaignId, two.id, 'QUEUED');
  });

  afterEach(async () => {
    await truncateAll();
  });

  it('counts only a campaign of its own non-terminal attempts', async () => {
    await expect(campaignInFlight(prisma, campaignId)).resolves.toBe(3);
    await expect(campaignInFlight(prisma, otherCampaignId)).resolves.toBe(1);
  });

  /**
   * The account's allotment spans every workspace and every campaign it owns,
   * which is what makes it YE's unit of sale rather than a per-campaign
   * setting the customer could raise themselves.
   */
  it("counts an account's attempts across all of its campaigns", async () => {
    await expect(accountInFlight(prisma, accountId)).resolves.toBe(4);
  });

  it('counts nothing for an account that has never dialed', async () => {
    const stranger = await makeAccount('idle');
    await expect(accountInFlight(prisma, stranger.id)).resolves.toBe(0);
  });

  /**
   * Which lane a live call occupies is `CallAttempt.kind` — the arm the claim
   * actually spent — and nothing about the contact it was placed to.
   *
   * The contact here has consumed four retries, which is exactly what the
   * reading this replaced asked: "has this contact ever been dialed", over the
   * lifetime counters. It answered yes for every one of these five calls, so on
   * a campaign whose fresh queue is exhausted every live call of every kind
   * counted as a retry, the retry budget came out at zero, and the reserved
   * lane was never queried at all.
   */
  it('splits a campaign’s live calls by the lane that claimed them', async () => {
    const campaign = await prisma.campaign.create({
      data: { workspaceId, name: 'Lanes', status: 'RUNNING' },
    });
    const contact = await prisma.contact.create({
      data: { workspaceId, phone: '+919876500002' },
    });
    const link = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id, attempts: 4 },
    });

    await attempt(campaign.id, link.id, 'IN_PROGRESS', 'retry');
    await attempt(campaign.id, link.id, 'RINGING', 'follow_up');
    await attempt(campaign.id, link.id, 'QUEUED', 'callback');
    await attempt(campaign.id, link.id, 'RINGING', 'resume');
    await attempt(campaign.id, link.id, 'IN_PROGRESS', 'fresh');
    // Settled, so it holds no line in any lane.
    await attempt(campaign.id, link.id, 'COMPLETED', 'retry');

    await expect(campaignLaneInFlight(prisma, campaign.id)).resolves.toEqual({
      all: 5,
      fresh: 1,
      urgent: 2,
      retry: 2,
    });
  });
});
