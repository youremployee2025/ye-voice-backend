import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { NEVER_PLACED, neverPlacedSql } from '../src/lib/dialBudget.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';

/**
 * The one rule in two spellings, proved to agree on a real Postgres.
 *
 * `dialBudget.ts` exists so the claim's `NOT EXISTS` (SQL) and the
 * resolution's `NOT: NEVER_PLACED` (Prisma) cannot disagree about what a dial
 * is. Every caller applies the predicate under NOT, and two of its columns
 * are nullable, so the failure mode is not "the two disagree on a row" but
 * "one of them evaluates to NULL and the row silently vanishes from both the
 * matched and the unmatched set". Each shape below is asserted four ways —
 * SQL, NOT SQL, Prisma, NOT Prisma — and the two halves of each spelling
 * must partition the table exactly.
 */

beforeEach(async () => {
  await truncateAll();
});

afterEach(async () => {
  await truncateAll();
});

type Shape = [label: string, row: Partial<Prisma.CallAttemptUncheckedCreateInput>, neverPlaced: boolean];

const SHAPES: Shape[] = [
  ['ordinary silence, no signal', { status: 'FAILED', upstreamCallId: 'c1' }, false],
  ['SYSTEM_ERROR, nobody heard', { status: 'FAILED', upstreamCallId: 'c2', endCallReason: 'SYSTEM_ERROR' }, true],
  ['SYSTEM_ERROR, human heard', { status: 'COMPLETED', upstreamCallId: 'c3', endCallReason: 'SYSTEM_ERROR', answeredBy: 'human' }, false],
  ['SYSTEM_ERROR, Human (case) heard', { status: 'COMPLETED', upstreamCallId: 'c4', endCallReason: 'SYSTEM_ERROR', answeredBy: 'Human' }, false],
  ['SYSTEM_ERROR, machine', { status: 'COMPLETED', upstreamCallId: 'c5', endCallReason: 'SYSTEM_ERROR', answeredBy: 'machine' }, true],
  // The column stores the reason normalised; a raw lower-case value is not
  // one this service wrote, and neither spelling may quietly upper-case it.
  ['lower-case system_error (unnormalised store)', { status: 'FAILED', upstreamCallId: 'c6', endCallReason: 'system_error' }, false],
  ['errorCode, no reason', { status: 'FAILED', upstreamCallId: 'c7', errorCode: 'PENDING_TIMEOUT' }, true],
  // Answered per the carrier's clock, nothing detected: tested, so placed.
  ['SYSTEM_ERROR, answered, no detector', { status: 'FAILED', upstreamCallId: 'c11', endCallReason: 'SYSTEM_ERROR', answeredAt: new Date('2026-09-15T10:00:00Z') }, false],
  ['errorCode, answered, no detector', { status: 'FAILED', upstreamCallId: 'c12', errorCode: 'ADMIN_DISMISSED', answeredAt: new Date('2026-09-15T10:00:00Z') }, false],
  ['NO_ANSWER reason', { status: 'FAILED', upstreamCallId: 'c8', endCallReason: 'NO_ANSWER' }, false],
  ['launch rollback', { status: 'FAILED', upstreamCallId: null, launchError: 'boom' }, true],
  ['launch rollback + SYSTEM_ERROR + human (odd)', { status: 'FAILED', upstreamCallId: null, launchError: 'boom', endCallReason: 'SYSTEM_ERROR', answeredBy: 'human' }, true],
];

describe('the never-placed rule, SQL half against Prisma half', () => {
  it('agrees on every row shape, and neither NOT-form ever drops a row', async () => {
    const account = await makeAccount(`eq${Math.random().toString(36).slice(2, 7)}`);
    const workspace = await makeWorkspace(account, 'Equivalence');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'Probe', status: 'RUNNING' },
    });
    const contact = await prisma.contact.create({ data: { workspaceId: workspace.id, phone: '+919000001000' } });
    const link = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id, status: 'PENDING' },
    });

    const ids = new Map<string, string>();
    for (const [i, [label, row]] of SHAPES.entries()) {
      const created = await prisma.callAttempt.create({
        data: {
          campaignId: campaign.id,
          campaignContactId: link.id,
          workspaceId: workspace.id,
          accountId: account.id,
          attemptNo: i + 1,
          ...row,
        } as Prisma.CallAttemptUncheckedCreateInput,
      });
      ids.set(label, created.id);
    }

    // The SQL half, evaluated as a column so a NULL shows up AS null rather
    // than as an absent row.
    const sqlRows = await prisma.$queryRaw<Array<{ id: string; np: boolean | null; not_np: boolean | null }>>(
      Prisma.sql`SELECT "a".id, (${neverPlacedSql('a')}) AS np, (NOT ${neverPlacedSql('a')}) AS not_np FROM "CallAttempt" "a"`,
    );
    const sqlMatched = await prisma.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "a".id FROM "CallAttempt" "a" WHERE ${neverPlacedSql('a')}`,
    );
    const sqlNotMatched = await prisma.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "a".id FROM "CallAttempt" "a" WHERE NOT ${neverPlacedSql('a')}`,
    );

    const prismaMatched = await prisma.callAttempt.findMany({ where: NEVER_PLACED, select: { id: true } });
    const prismaNotMatched = await prisma.callAttempt.findMany({ where: { NOT: NEVER_PLACED }, select: { id: true } });
    const np = new Set(prismaMatched.map((r) => r.id));
    const notNp = new Set(prismaNotMatched.map((r) => r.id));

    for (const [label, , expected] of SHAPES) {
      const id = ids.get(label)!;
      const s = sqlRows.find((r) => r.id === id)!;
      expect(s.np, `SQL: ${label}`).toBe(expected);
      expect(s.not_np, `NOT SQL: ${label}`).toBe(!expected);
      expect(np.has(id), `Prisma: ${label}`).toBe(expected);
      expect(notNp.has(id), `NOT Prisma: ${label}`).toBe(!expected);
    }

    // The partition property: a NULL predicate drops a row from BOTH sides.
    expect(sqlMatched.length + sqlNotMatched.length).toBe(SHAPES.length);
    expect(prismaMatched.length + prismaNotMatched.length).toBe(SHAPES.length);
    expect(sqlRows.every((r) => r.np !== null && r.not_np !== null)).toBe(true);
  });
});
