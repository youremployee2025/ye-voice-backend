import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Account, CreditTransactionType, PhoneNumber, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, as, makeAccount, makeWorkspace } from './helpers.js';
import { toInternalCredits } from '../src/lib/credits.js';

// No test may reach the real partner API.
vi.mock('../src/adapter/vocobase.js', () => ({
  listPurchasedDids: vi.fn(),
  listAgents: vi.fn(),
  listVoices: vi.fn(),
  getAgent: vi.fn(),
  getAgentDocuments: vi.fn(),
  getAgentFunctions: vi.fn(),
  getAgentTools: vi.fn(),
}));

const { createApp } = await import('../src/app.js');
const app = createApp();

let owner: Account;
let admin: Account;
let member: Account;
let workspace: Workspace;
let sequence = 0;

const asOwner = () => as(owner.clerkUserId, owner.email);
const asAdmin = () => as(admin.clerkUserId, admin.email);
const asMember = () => as(member.clerkUserId, member.email);

const url = (query = '') => `/api/workspaces/${workspace.id}/billing/transactions${query}`;

async function makeDid(workspaceId: string | null) {
  sequence += 1;

  return prisma.phoneNumber.create({
    data: {
      did: `+1415555${String(1000 + sequence)}`,
      provider: 'voicelink',
      status: workspaceId ? 'ASSIGNED' : 'UNASSIGNED',
      workspaceId,
    },
  });
}

interface RowOptions {
  account?: Account;
  workspaceId?: string | null;
  phoneNumber?: PhoneNumber;
  amount?: string;
  type?: CreditTransactionType;
  note?: string | null;
  reference?: string | null;
  createdAt?: Date;
  callAttemptId?: string;
}

async function makeRow({
  account,
  workspaceId,
  phoneNumber,
  amount = '-500',
  type = 'DID_PURCHASE',
  note = null,
  reference = null,
  createdAt,
  callAttemptId,
}: RowOptions = {}) {
  return prisma.creditTransaction.create({
    data: {
      accountId: (account ?? owner).id,
      workspaceId: workspaceId === undefined ? workspace.id : workspaceId,
      phoneNumberId: phoneNumber?.id ?? null,
      amount: toInternalCredits(amount.replace('-', '')) * (amount.startsWith('-') ? -1n : 1n),
      type,
      note,
      reference,
      callAttemptId: callAttemptId ?? null,
      ...(createdAt ? { createdAt } : {}),
    },
  });
}

beforeEach(async () => {
  await truncateAll();
  owner = await makeAccount('owner');
  admin = await makeAccount('admin');
  member = await makeAccount('member');
  workspace = await makeWorkspace(owner, 'Acme');
  await addMember(workspace, admin, 'ADMIN');
  await addMember(workspace, member, 'MEMBER');
});

describe('GET /api/workspaces/:id/billing/transactions', () => {
  it("lists this workspace's rows newest first", async () => {
    await makeRow({ createdAt: new Date('2026-01-01T00:00:00Z'), amount: '-100' });
    await makeRow({ createdAt: new Date('2026-03-01T00:00:00Z'), amount: '-300' });
    await makeRow({ createdAt: new Date('2026-02-01T00:00:00Z'), amount: '-200' });

    const res = await request(app).get(url()).set(...asAdmin());

    expect(res.status).toBe(200);
    expect(res.body.data.items.map((row: { amount: string }) => row.amount)).toEqual([
      '-300',
      '-200',
      '-100',
    ]);
  });

  // The second arm of the disjunction. A grant credits an Account and carries
  // no workspaceId, so without it a customer sees every charge and never the
  // top-up that paid for them.
  it("includes ADJUSTMENT grants on the owner's account", async () => {
    await makeRow({ type: 'ADJUSTMENT', amount: '1000', workspaceId: null, note: 'Q3 top-up' });

    const res = await request(app).get(url()).set(...asAdmin());

    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({ type: 'ADJUSTMENT', amount: '1000' });
  });

  it("does not include a grant on somebody else's account", async () => {
    const stranger = await makeAccount('stranger');
    await makeRow({ account: stranger, type: 'ADJUSTMENT', amount: '1000', workspaceId: null });

    const res = await request(app).get(url()).set(...asAdmin());

    expect(res.body.data.items).toHaveLength(0);
  });

  // The caller may be an ADMIN with credits of their own. Those are not this
  // page's subject — the balance shown above the table is the owner's.
  it("does not include a grant on the calling ADMIN's own account", async () => {
    await makeRow({ account: admin, type: 'ADJUSTMENT', amount: '1000', workspaceId: null });

    const res = await request(app).get(url()).set(...asAdmin());

    expect(res.body.data.items).toHaveLength(0);
  });

  it("does not include another workspace's DID charges", async () => {
    const other = await makeWorkspace(owner, 'Other');
    await makeRow({ workspaceId: other.id });

    const res = await request(app).get(url()).set(...asAdmin());

    expect(res.body.data.items).toHaveLength(0);
  });

  // A whitelist, not a shorthand. A future Account-scoped row of some other
  // type must not become customer-visible without somebody deciding it should.
  it('does not include a non-ADJUSTMENT row that carries no workspace', async () => {
    await makeRow({ type: 'DID_RENEWAL', workspaceId: null });

    const res = await request(app).get(url()).set(...asAdmin());

    expect(res.body.data.items).toHaveLength(0);
  });

  it('carries the note and reference a grant was written with', async () => {
    await makeRow({
      type: 'ADJUSTMENT',
      amount: '1000',
      workspaceId: null,
      note: 'Q3 top-up',
      reference: 'INV-2026-114',
    });

    const res = await request(app).get(url()).set(...asAdmin());

    expect(res.body.data.items[0]).toMatchObject({
      note: 'Q3 top-up',
      reference: 'INV-2026-114',
    });
  });

  it('leaves note null on a DID charge and names the number instead', async () => {
    const did = await makeDid(workspace.id);
    await makeRow({ phoneNumber: did });

    const res = await request(app).get(url()).set(...asAdmin());

    expect(res.body.data.items[0].note).toBeNull();
    expect(res.body.data.items[0].phone_number).toEqual({ id: did.id, did: did.did });
  });

  // Deliberately absent. It cannot be derived from a filtered subset of an
  // account's movements without inventing a number — see the design doc.
  it('emits no balance_after', async () => {
    await makeRow({});

    const res = await request(app).get(url()).set(...asAdmin());

    expect(res.body.data.items[0]).not.toHaveProperty('balance_after');
  });

  it('paginates and reports the total', async () => {
    for (let i = 0; i < 5; i += 1) {
      await makeRow({ createdAt: new Date(Date.UTC(2026, 0, i + 1)) });
    }

    const res = await request(app).get(url('?page=2&limit=2')).set(...asAdmin());

    expect(res.body.data).toMatchObject({ page: 2, limit: 2, total: 5 });
    expect(res.body.data.items).toHaveLength(2);
  });

  // Rows written in one transaction share a createdAt to the millisecond. An
  // unstable sort under offset pagination shows the same row on two pages.
  it('orders stably when rows share a timestamp', async () => {
    const at = new Date('2026-04-01T12:00:00.000Z');
    for (let i = 0; i < 6; i += 1) await makeRow({ createdAt: at });

    const [first, second] = await Promise.all([
      request(app).get(url('?page=1&limit=3')).set(...asAdmin()),
      request(app).get(url('?page=2&limit=3')).set(...asAdmin()),
    ]);

    const ids = [...first.body.data.items, ...second.body.data.items].map(
      (row: { id: string }) => row.id,
    );

    expect(new Set(ids).size).toBe(6);
  });

  it('filters by type', async () => {
    await makeRow({ type: 'DID_PURCHASE' });
    await makeRow({ type: 'DID_RENEWAL' });

    const res = await request(app).get(url('?type=DID_RENEWAL')).set(...asAdmin());

    expect(res.body.data.total).toBe(1);
    expect(res.body.data.items[0].type).toBe('DID_RENEWAL');
  });

  // An empty page here is indistinguishable from a workspace with no history.
  it('refuses an unknown type rather than answering an empty page', async () => {
    const res = await request(app).get(url('?type=NONSENSE')).set(...asAdmin());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('filters by date range', async () => {
    await makeRow({ createdAt: new Date('2026-03-15T00:00:00Z') });
    await makeRow({ createdAt: new Date('2026-05-15T00:00:00Z') });

    const res = await request(app).get(url('?from=2026-04-01&to=2026-06-01')).set(...asAdmin());

    expect(res.body.data.total).toBe(1);
  });

  // A bare `lte` on the named day's midnight silently drops every row from the
  // day the reader actually asked for.
  it('includes the whole of the day named by `to`', async () => {
    await makeRow({ createdAt: new Date('2026-04-30T23:30:00Z') });

    const res = await request(app).get(url('?to=2026-04-30')).set(...asAdmin());

    expect(res.body.data.total).toBe(1);
  });

  it('includes a row at the very start of the day named by `from`', async () => {
    await makeRow({ createdAt: new Date('2026-04-01T00:00:00Z') });

    const res = await request(app).get(url('?from=2026-04-01')).set(...asAdmin());

    expect(res.body.data.total).toBe(1);
  });

  it('refuses a range that ends before it starts', async () => {
    const res = await request(app).get(url('?from=2026-05-01&to=2026-04-01')).set(...asAdmin());

    expect(res.status).toBe(400);
  });

  it('refuses an unparseable date', async () => {
    const res = await request(app).get(url('?from=last-tuesday')).set(...asAdmin());

    expect(res.status).toBe(400);
  });

  it('refuses a bad page number', async () => {
    const res = await request(app).get(url('?page=0')).set(...asAdmin());

    expect(res.status).toBe(400);
  });

  it('answers an empty history as an empty page, not an error', async () => {
    const res = await request(app).get(url()).set(...asAdmin());

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ items: [], total: 0, page: 1 });
  });

  it('serves the owner too, not only a non-owner ADMIN', async () => {
    await makeRow({});

    const res = await request(app).get(url()).set(...asOwner());

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
  });

  it('refuses a MEMBER', async () => {
    const res = await request(app).get(url()).set(...asMember());

    expect(res.status).toBe(403);
  });

  it("hides an ADJUSTMENT attributed to a sibling workspace of the same owner", async () => {
    // The second arm of the OR exists to show the grants that funded this
    // workspace, which carry no workspaceId. A grant attributed to another of
    // the owner's workspaces is that other team's business, and it drags their
    // DID, note and invoice reference along with it through
    // `serializeLedgerRow`.
    const sibling = await makeWorkspace(owner, 'Skunkworks');
    const siblingDid = await makeDid(sibling.id);

    await makeRow({
      workspaceId: sibling.id,
      phoneNumber: siblingDid,
      amount: '500',
      type: 'ADJUSTMENT',
      note: 'goodwill for the Skunkworks outage',
      reference: 'INV-B-9911',
    });

    const res = await request(app).get(url()).set(...asAdmin());

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(0);
    expect(JSON.stringify(res.body)).not.toContain('INV-B-9911');
  });

  it("still shows an account-level grant, which is what the second arm is for", async () => {
    await makeRow({
      workspaceId: null,
      amount: '500',
      type: 'ADJUSTMENT',
      note: 'topped up by the YE team',
      reference: 'INV-A-1001',
    });

    const res = await request(app).get(url()).set(...asAdmin());

    expect(res.body.data.total).toBe(1);
    expect(res.body.data.items[0]).toMatchObject({
      type: 'ADJUSTMENT',
      note: 'topped up by the YE team',
      reference: 'INV-A-1001',
    });
  });

  it('refuses a day that does not exist rather than rolling it into the next month', async () => {
    // `new Date('2026-02-31T00:00:00Z')` is 3 March. Answered as a 200, this
    // returned March rows under a February heading.
    await makeRow({ createdAt: new Date('2026-03-02T12:00:00.000Z') });

    const res = await request(app).get(url('?to=2026-02-31')).set(...asAdmin());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('refuses 31 April, which parses to 1 May', async () => {
    const res = await request(app)
      .get(url('?from=2026-04-31&to=2026-04-31'))
      .set(...asAdmin());

    expect(res.status).toBe(400);
  });

  it('still accepts the last real day of a short month', async () => {
    const res = await request(app).get(url('?to=2026-02-28')).set(...asAdmin());

    expect(res.status).toBe(200);
  });

  it('accepts 29 February in a leap year', async () => {
    const res = await request(app).get(url('?to=2028-02-29')).set(...asAdmin());

    expect(res.status).toBe(200);
  });

  it('refuses a page number too large to be an offset, rather than 500ing on it', async () => {
    // `Number('99999999999999999999')` is 1e20; the skip derived from it is
    // 2.5e+21, which Prisma refuses to fit into a 64-bit integer — so this
    // came back an INTERNAL_ERROR from the module whose job is to make it a
    // 400.
    const res = await request(app).get(url('?page=99999999999999999999')).set(...asAdmin());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('refuses a page number that cannot survive being a JavaScript number', async () => {
    // Number('9007199254740993') is 9007199254740992 — the response would have
    // echoed back a different page than the one asked for.
    const res = await request(app).get(url('?page=9007199254740993')).set(...asAdmin());

    expect(res.status).toBe(400);
  });

  it('refuses somebody who is not a member at all', async () => {
    const outsider = await makeAccount('outsider');

    const res = await request(app)
      .get(url())
      .set(...as(outsider.clerkUserId, outsider.email));

    expect(res.status).toBe(403);
  });
});

/**
 * What a charge was actually for.
 *
 * The three figures come off the `CallAttempt` through the relation rather
 * than off the ledger row, which carries no copy of them — see
 * `serializeLedgerRow`.
 */
describe('the call behind a usage charge', () => {
  async function makeAttempt(over: {
    durationSecs?: number | null;
    billedSecs?: number | null;
    billingIncrementSecs?: number | null;
  }) {
    return prisma.callAttempt.create({
      data: {
        workspaceId: workspace.id,
        accountId: owner.id,
        attemptNo: 1,
        durationSecs: over.durationSecs ?? null,
        billedSecs: over.billedSecs ?? null,
        billingIncrementSecs: over.billingIncrementSecs ?? null,
      },
    });
  }

  it('reports the duration, the billed seconds and the increment', async () => {
    const attempt = await makeAttempt({
      durationSecs: 47,
      billedSecs: 60,
      billingIncrementSecs: 60,
    });
    await makeRow({ type: 'CALL_USAGE', amount: '-1', callAttemptId: attempt.id });

    const res = await request(app).get(url()).set(...asOwner());

    expect(res.body.data.items[0].call).toEqual({
      duration_secs: 47,
      billed_secs: 60,
      billing_increment_secs: 60,
    });
  });

  /**
   * A charge settled before increments existed. Null is the honest answer and
   * the only one — rendering it as 0 claims a call was billed for nothing, and
   * rendering it as the duration claims a figure nobody recorded.
   */
  it('reports an unrecorded billed figure as null, never as zero or as the duration', async () => {
    const attempt = await makeAttempt({ durationSecs: 47 });
    await makeRow({ type: 'CALL_USAGE', amount: '-1', callAttemptId: attempt.id });

    const res = await request(app).get(url()).set(...asOwner());

    expect(res.body.data.items[0].call).toEqual({
      duration_secs: 47,
      billed_secs: null,
      billing_increment_secs: null,
    });
  });

  /** A grant is not a call. An object of nulls would read as one nobody
   *  recorded, which is a different and wrong claim. */
  it('reports null for a row that is not a call at all', async () => {
    await makeRow({ type: 'DID_PURCHASE' });

    const res = await request(app).get(url()).set(...asOwner());

    expect(res.body.data.items[0].call).toBeNull();
  });

  /** A shortfall row is a call too — the minutes were real, the debit was
   *  not — so it carries the same block. */
  it('reports the call behind a shortfall marker', async () => {
    const attempt = await makeAttempt({
      durationSecs: 5,
      billedSecs: 30,
      billingIncrementSecs: 30,
    });
    await makeRow({ type: 'CALL_USAGE_SHORTFALL', amount: '0', callAttemptId: attempt.id });

    const res = await request(app).get(url()).set(...asOwner());

    expect(res.body.data.items[0].call).toMatchObject({ duration_secs: 5, billed_secs: 30 });
  });
});
