import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { Account, Agent, TestSession, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { toInternalCredits } from '../src/lib/credits.js';
import { settleTestSession } from '../src/services/testSessionOutcome.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeAgent, makeWorkspace } from './helpers.js';

const price = (display: string) => toInternalCredits(display);

let owner: Account;
let workspace: Workspace;
let agent: Agent;

beforeEach(async () => {
  await truncateAll();
  owner = await makeAccount('settle-owner');
  await prisma.account.update({ where: { id: owner.id }, data: { credits: price('100.00') } });
  workspace = await makeWorkspace(owner, 'Settle');
  agent = await makeAgent(workspace, 'Pratibha');
});

afterEach(truncateAll);

/** A live session carrying the plan it started under. */
async function live(
  overrides: Partial<Pick<TestSession, 'rateCreditsPerMin' | 'billingIncrementSecs' | 'status'>> = {},
): Promise<TestSession> {
  return prisma.testSession.create({
    data: {
      workspaceId: workspace.id,
      accountId: owner.id,
      agentId: agent.id,
      startedByAccountId: owner.id,
      upstreamSessionId: `sess-${Math.random().toString(36).slice(2, 10)}`,
      status: overrides.status ?? 'ACTIVE',
      tierId: null,
      tierSlug: 'va-pro',
      rateCreditsPerMin:
        overrides.rateCreditsPerMin === undefined ? price('2.00') : overrides.rateCreditsPerMin,
      billingIncrementSecs:
        overrides.billingIncrementSecs === undefined ? 60 : overrides.billingIncrementSecs,
    },
  });
}

const balance = async () =>
  (await prisma.account.findUniqueOrThrow({ where: { id: owner.id } })).credits;

describe('settleTestSession', () => {
  /**
   * The pulse doing its job: 47 seconds on a 60-second increment bills a full
   * minute. Asserted as exact BigInts — a billing figure that is approximately
   * right is wrong.
   */
  it('rounds the duration up to the increment and charges the plan', async () => {
    const session = await live();

    const result = await settleTestSession({
      sessionId: session.id,
      eventKey: `session.completed:${session.upstreamSessionId}`,
      durationSecs: 47,
      upstreamStatus: 'completed',
      endedAt: new Date(),
    });

    expect(result).toBe('charged');

    const row = await prisma.testSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.status).toBe('COMPLETED');
    expect(row.durationSecs).toBe(47);
    expect(row.billedSecs).toBe(60);
    expect(row.costCredits).toBe(price('2.00'));
    expect(row.chargedAt).not.toBeNull();
    expect(row.resolvedAt).not.toBeNull();
    expect(row.shortfall).toBe(false);

    expect(await balance()).toBe(price('98.00'));

    const ledger = await prisma.creditTransaction.findFirstOrThrow({});
    expect(ledger.type).toBe('TEST_SESSION_USAGE');
    expect(ledger.amount).toBe(-price('2.00'));
    expect(ledger.testSessionId).toBe(session.id);
    expect(ledger.callAttemptId).toBeNull();
    expect(ledger.workspaceId).toBe(workspace.id);
    // The reference is what the ledger's unique index makes a second charge
    // unreachable on.
    expect(ledger.reference).toBe(session.id);
  });

  it('bills a session that ended on the tick for exactly that tick', async () => {
    const session = await live();

    await settleTestSession({
      sessionId: session.id,
      eventKey: `session.completed:${session.upstreamSessionId}`,
      durationSecs: 60,
      upstreamStatus: 'completed',
      endedAt: new Date(),
    });

    const row = await prisma.testSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.billedSecs).toBe(60);
    expect(row.costCredits).toBe(price('2.00'));
  });

  /**
   * No ledger row for a session that cost nothing — a zero-credit charge
   * carries nothing the session row does not already say. `chargedAt` is still
   * stamped, so a late delivery cannot charge it afterwards.
   */
  it('writes no ledger row for a session nobody spoke on', async () => {
    const session = await live();

    await settleTestSession({
      sessionId: session.id,
      eventKey: `session.completed:${session.upstreamSessionId}`,
      durationSecs: 0,
      upstreamStatus: 'completed',
      endedAt: new Date(),
    });

    const row = await prisma.testSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.billedSecs).toBe(0);
    expect(row.costCredits).toBe(0n);
    expect(row.chargedAt).not.toBeNull();

    expect(await prisma.creditTransaction.count()).toBe(0);
    expect(await balance()).toBe(price('100.00'));
  });

  it('charges once when the same delivery arrives twice', async () => {
    const session = await live();
    const outcome = {
      sessionId: session.id,
      eventKey: `session.completed:${session.upstreamSessionId}`,
      durationSecs: 60,
      upstreamStatus: 'completed',
      endedAt: new Date(),
    };

    expect(await settleTestSession(outcome)).toBe('charged');
    expect(await settleTestSession(outcome)).toBe('already_closed');

    expect(await balance()).toBe(price('98.00'));
    expect(await prisma.creditTransaction.count()).toBe(1);
  });

  /**
   * The webhook and the reaper carry DIFFERENT event keys on purpose, so the
   * `WebhookEvent` marker cannot be what stops the second one. The
   * `chargedAt IS NULL` guard inside the update's `where` is.
   */
  it('charges once across two different event keys', async () => {
    const session = await live();
    const base = {
      sessionId: session.id,
      durationSecs: 60,
      upstreamStatus: 'completed',
      endedAt: new Date(),
    };

    expect(await settleTestSession({ ...base, eventKey: `session.completed:${session.id}` })).toBe(
      'charged',
    );
    expect(await settleTestSession({ ...base, eventKey: `testSession.reap:${session.id}` })).toBe(
      'already_closed',
    );

    expect(await balance()).toBe(price('98.00'));
    expect(await prisma.creditTransaction.count()).toBe(1);
  });

  /**
   * Fail closed. Nothing is partially debited: the ledger's rules are that a
   * balance never goes negative and every movement pairs with a row, and
   * breaking both to recover a fraction of a credit is not a trade worth making.
   */
  it('records a debt rather than overdrawing the account', async () => {
    await prisma.account.update({ where: { id: owner.id }, data: { credits: price('1.00') } });
    const session = await live();

    const result = await settleTestSession({
      sessionId: session.id,
      eventKey: `session.completed:${session.upstreamSessionId}`,
      durationSecs: 60,
      upstreamStatus: 'completed',
      endedAt: new Date(),
    });

    expect(result).toBe('charged');
    expect(await balance()).toBe(price('1.00'));

    const row = await prisma.testSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.shortfall).toBe(true);
    expect(row.costCredits).toBe(price('2.00'));
    expect(row.chargedAt).not.toBeNull();

    const marker = await prisma.creditTransaction.findFirstOrThrow({});
    expect(marker.type).toBe('TEST_SESSION_SHORTFALL');
    expect(marker.amount).toBe(0n);
    expect(marker.testSessionId).toBe(session.id);
  });

  /**
   * The snapshot is what bills. Staff may re-price or re-pulse the tier while
   * somebody is still talking, and a session started under one plan must be
   * charged on that plan.
   */
  it('bills the plan the session started under, not the tier as it stands now', async () => {
    const session = await live({ rateCreditsPerMin: price('2.00'), billingIncrementSecs: 60 });

    await prisma.tier.create({
      data: {
        slug: 'va-pro',
        name: 'VA-PRO',
        defaultPriceCreditsPerMin: price('9.00'),
        billingIncrementSecs: 1,
        isDefault: true,
      },
    });

    await settleTestSession({
      sessionId: session.id,
      eventKey: `session.completed:${session.upstreamSessionId}`,
      durationSecs: 47,
      upstreamStatus: 'completed',
      endedAt: new Date(),
    });

    const row = await prisma.testSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.costCredits).toBe(price('2.00'));
    expect(row.billedSecs).toBe(60);
  });

  /**
   * A row written before increments existed was billed per second. Erring the
   * other way would charge a customer a pulse they were never on.
   */
  it('bills per second when no increment was snapshotted', async () => {
    const session = await live({ billingIncrementSecs: null });

    await settleTestSession({
      sessionId: session.id,
      eventKey: `session.completed:${session.upstreamSessionId}`,
      durationSecs: 47,
      upstreamStatus: 'completed',
      endedAt: new Date(),
    });

    const row = await prisma.testSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.billedSecs).toBe(47);
    // 2.00/min × 47s, truncated in the customer's favour.
    expect(row.costCredits).toBe((price('2.00') * 47n) / 60n);
  });

  it('settles an ENDING session as readily as an ACTIVE one', async () => {
    const session = await live({ status: 'ENDING' });

    expect(
      await settleTestSession({
        sessionId: session.id,
        eventKey: `session.completed:${session.upstreamSessionId}`,
        durationSecs: 60,
        upstreamStatus: 'completed',
        endedAt: new Date(),
      }),
    ).toBe('charged');
  });

  it('records a session the platform says failed as FAILED, and still charges it', async () => {
    const session = await live();

    await settleTestSession({
      sessionId: session.id,
      eventKey: `session.completed:${session.upstreamSessionId}`,
      durationSecs: 60,
      upstreamStatus: 'failed',
      endedAt: new Date(),
    });

    const row = await prisma.testSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.status).toBe('FAILED');
    expect(row.upstreamStatus).toBe('failed');
    // The minutes were real and somebody owes for them.
    expect(row.costCredits).toBe(price('2.00'));
  });

  it('reports a session it has never heard of rather than throwing', async () => {
    expect(
      await settleTestSession({
        sessionId: 'nope',
        eventKey: 'session.completed:nope',
        durationSecs: 10,
        upstreamStatus: 'completed',
        endedAt: new Date(),
      }),
    ).toBe('unknown');
  });
});
