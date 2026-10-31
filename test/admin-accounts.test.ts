import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, makeAccount, makeWorkspace } from './helpers.js';

const TOKEN = 'staff-token-for-tests';
process.env.ADMIN_STAFF_TOKEN = TOKEN;

const { createApp } = await import('../src/app.js');

const app = createApp();
const staff = () => ['X-Admin-Token', TOKEN] as [string, string];

beforeEach(async () => {
  await truncateAll();
});

describe('staff authentication on the account routes', () => {
  // Its own app, so the rejections this describe exists to make do not spend
  // the limiter's failure budget on behalf of every case below it. That budget
  // is small on purpose — it is what stops a stranger working through the
  // keyspace — and a test file is the one caller that legitimately looks like
  // one.
  const app = createApp();

  const routes: Array<[string, string]> = [
    ['get', '/api/admin/accounts'],
    ['get', '/api/admin/accounts/any-id'],
    ['post', '/api/admin/accounts/any-id/credits'],
    ['get', '/api/admin/credit-transactions'],
  ];

  for (const [method, path] of routes) {
    it(`rejects ${method.toUpperCase()} ${path} without a token`, async () => {
      const res = await (method === 'get'
        ? request(app).get(path)
        : request(app).post(path).send({}));

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });
  }

  it('does not accept a customer identity in place of the staff token', async () => {
    await makeAccount('alice');

    const res = await request(app)
      .get('/api/admin/accounts')
      .set('X-Test-Clerk-User', 'user_alice|alice@ezo.test');

    expect(res.status).toBe(401);
  });
});

describe('GET /api/admin/accounts', () => {
  it('pages the list and reports the full total', async () => {
    await makeAccount('alice');
    await makeAccount('bob');
    await makeAccount('carol');

    const res = await request(app)
      .get('/api/admin/accounts?limit=2')
      .set(...staff());

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.page).toBe(1);
    expect(res.body.data.limit).toBe(2);

    const second = await request(app).get('/api/admin/accounts?limit=2&page=2').set(...staff());
    expect(second.body.data.items).toHaveLength(1);
  });

  it('counts owned workspaces and memberships without loading them', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const workspace = await makeWorkspace(alice, 'Acme');
    await makeWorkspace(alice, 'Beta');
    await addMember(workspace, bob, 'MEMBER');

    const res = await request(app).get('/api/admin/accounts').set(...staff());
    const rows = res.body.data.items as Array<Record<string, unknown>>;
    const row = rows.find((r) => r.email === 'alice@ezo.test')!;

    expect(row.workspace_count).toBe(2);
    // Creating a workspace makes the owner a member of it, so Alice has two.
    expect(row.membership_count).toBe(2);
    expect(rows.find((r) => r.email === 'bob@ezo.test')!.workspace_count).toBe(0);
  });

  it('carries the balance as a display string', async () => {
    const alice = await makeAccount('alice');
    await prisma.account.update({ where: { id: alice.id }, data: { credits: 12_3400n } });

    const res = await request(app).get('/api/admin/accounts').set(...staff());

    expect(res.body.data.items[0].credits).toBe('12.34');
  });

  it('searches a fragment of an email, not only its start', async () => {
    await makeAccount('alice');
    await makeAccount('bob');

    const res = await request(app).get('/api/admin/accounts?search=lic').set(...staff());

    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].email).toBe('alice@ezo.test');
    expect(res.body.data.total).toBe(1);
  });

  it('searches the name too, case-insensitively', async () => {
    await makeAccount('alice');

    const res = await request(app).get('/api/admin/accounts?search=ALI').set(...staff());

    expect(res.body.data.items).toHaveLength(1);
  });

  it('rejects a page number it cannot honour', async () => {
    const res = await request(app).get('/api/admin/accounts?page=0').set(...staff());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it.each(['99999999999999999999', '9007199254740993'])(
    'answers page=%s with a 400 rather than a 500',
    async (page) => {
      const res = await request(app).get(`/api/admin/accounts?page=${page}`).set(...staff());

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    },
  );

  it('answers a page past the end with an empty listing, not an error', async () => {
    await makeAccount('alice');

    const res = await request(app).get('/api/admin/accounts?page=40').set(...staff());

    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.total).toBe(1);
  });
});

describe('GET /api/admin/accounts/:id', () => {
  it('separates owned workspaces from joined ones', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const owned = await makeWorkspace(alice, 'Acme');
    const joined = await makeWorkspace(bob, 'Other');
    await addMember(joined, alice, 'MEMBER');

    const res = await request(app).get(`/api/admin/accounts/${alice.id}`).set(...staff());

    expect(res.status).toBe(200);
    expect(res.body.data.owned_workspaces).toHaveLength(1);
    expect(res.body.data.owned_workspaces[0].id).toBe(owned.id);
    expect(res.body.data.memberships).toHaveLength(2);

    const memberships = res.body.data.memberships as Array<Record<string, never>>;
    const other = memberships.find((m) => (m.workspace as unknown as { id: string }).id === joined.id)!;
    expect(other.role).toBe('MEMBER');
  });

  it('includes the recent ledger rows', async () => {
    const alice = await makeAccount('alice');
    await prisma.creditTransaction.create({
      data: { accountId: alice.id, amount: 50_0000n, type: 'ADJUSTMENT', note: 'goodwill' },
    });

    const res = await request(app).get(`/api/admin/accounts/${alice.id}`).set(...staff());

    expect(res.body.data.recent_transactions).toHaveLength(1);
    expect(res.body.data.recent_transactions[0]).toMatchObject({
      amount: '50',
      type: 'ADJUSTMENT',
      note: 'goodwill',
    });
  });

  it('404s an id that names nothing', async () => {
    const res = await request(app).get('/api/admin/accounts/nope').set(...staff());

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('POST /api/admin/accounts/:id/credits', () => {
  it('grants credits and records why', async () => {
    const alice = await makeAccount('alice');

    const res = await request(app)
      .post(`/api/admin/accounts/${alice.id}/credits`)
      .set(...staff())
      .send({ amount: '25.5', note: 'launch goodwill', reference: 'TICKET-4' });

    expect(res.status).toBe(200);
    expect(res.body.data.account.credits).toBe('25.5');
    expect(res.body.data.transaction).toMatchObject({
      amount: '25.5',
      type: 'ADJUSTMENT',
      note: 'launch goodwill',
      reference: 'TICKET-4',
    });

    const after = await prisma.account.findUniqueOrThrow({ where: { id: alice.id } });
    expect(after.credits).toBe(25_5000n);
    expect(await prisma.creditTransaction.count()).toBe(1);
  });

  it('deducts credits', async () => {
    const alice = await makeAccount('alice');
    await prisma.account.update({ where: { id: alice.id }, data: { credits: 100_0000n } });

    const res = await request(app)
      .post(`/api/admin/accounts/${alice.id}/credits`)
      .set(...staff())
      .send({ amount: '-40', note: 'billing correction' });

    expect(res.status).toBe(200);
    expect(res.body.data.account.credits).toBe('60');
    expect(res.body.data.transaction.amount).toBe('-40');
  });

  it('allows a deduction of exactly the balance', async () => {
    const alice = await makeAccount('alice');
    await prisma.account.update({ where: { id: alice.id }, data: { credits: 10_0000n } });

    const res = await request(app)
      .post(`/api/admin/accounts/${alice.id}/credits`)
      .set(...staff())
      .send({ amount: '-10', note: 'zeroing out' });

    expect(res.status).toBe(200);
    expect(res.body.data.account.credits).toBe('0');
  });

  it('refuses to drive a balance negative, and writes nothing', async () => {
    const alice = await makeAccount('alice');
    await prisma.account.update({ where: { id: alice.id }, data: { credits: 10_0000n } });

    const res = await request(app)
      .post(`/api/admin/accounts/${alice.id}/credits`)
      .set(...staff())
      .send({ amount: '-10.0001', note: 'one unit too far' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_CREDITS');

    const after = await prisma.account.findUniqueOrThrow({ where: { id: alice.id } });
    expect(after.credits).toBe(10_0000n);
    expect(await prisma.creditTransaction.count()).toBe(0);
  });

  it('applies concurrent grants to the balance, losing none of them', async () => {
    const alice = await makeAccount('alice');

    const results = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        request(app)
          .post(`/api/admin/accounts/${alice.id}/credits`)
          .set(...staff())
          .send({ amount: '50', note: `grant ${n}` }),
      ),
    );

    expect(results.map((res) => res.status)).toEqual([200, 200, 200, 200]);

    const after = await prisma.account.findUniqueOrThrow({ where: { id: alice.id } });
    expect(after.credits).toBe(200_0000n);
  });

  it('refuses the concurrent deductions that would overdraw, not merely the last', async () => {
    const alice = await makeAccount('alice');
    await prisma.account.update({ where: { id: alice.id }, data: { credits: 100_0000n } });

    const results = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        request(app)
          .post(`/api/admin/accounts/${alice.id}/credits`)
          .set(...staff())
          .send({ amount: '-50', note: `deduct ${n}` }),
      ),
    );

    // Two fit in the balance; the other two must be refused rather than
    // overwriting each other's arithmetic.
    expect(results.filter((res) => res.status === 200)).toHaveLength(2);
    expect(results.filter((res) => res.status === 422)).toHaveLength(2);

    const after = await prisma.account.findUniqueOrThrow({ where: { id: alice.id } });
    expect(after.credits).toBe(0n);
  });

  it('keeps the ledger reconciled with the balance under concurrency', async () => {
    const alice = await makeAccount('alice');
    await prisma.account.update({ where: { id: alice.id }, data: { credits: 100_0000n } });

    await Promise.all(
      ['25', '-10', '5', '-30', '40', '-15'].map((amount, n) =>
        request(app)
          .post(`/api/admin/accounts/${alice.id}/credits`)
          .set(...staff())
          .send({ amount, note: `mixed ${n}` }),
      ),
    );

    const after = await prisma.account.findUniqueOrThrow({ where: { id: alice.id } });
    const rows = await prisma.creditTransaction.findMany({ where: { accountId: alice.id } });
    const ledger = rows.reduce((total, row) => total + row.amount, 0n);

    // The invariant the ledger exists for: it explains the balance exactly.
    expect(100_0000n + ledger).toBe(after.credits);
  });

  it('refuses a second adjustment carrying a reference already used, writing nothing', async () => {
    const alice = await makeAccount('alice');

    const first = await request(app)
      .post(`/api/admin/accounts/${alice.id}/credits`)
      .set(...staff())
      .send({ amount: '25', note: 'goodwill', reference: 'TICKET-4' });
    expect(first.status).toBe(200);

    const again = await request(app)
      .post(`/api/admin/accounts/${alice.id}/credits`)
      .set(...staff())
      .send({ amount: '25', note: 'goodwill', reference: 'TICKET-4' });

    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DUPLICATE_REFERENCE');

    // The refusal rolls the balance back with it: a resubmitted form must not
    // move the balance and then fail to record why.
    const after = await prisma.account.findUniqueOrThrow({ where: { id: alice.id } });
    expect(after.credits).toBe(25_0000n);
    expect(await prisma.creditTransaction.count()).toBe(1);
  });

  it('scopes the reference to the account, so two accounts may cite one invoice', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');

    for (const account of [alice, bob]) {
      const res = await request(app)
        .post(`/api/admin/accounts/${account.id}/credits`)
        .set(...staff())
        .send({ amount: '10', note: 'split invoice', reference: 'INV-9' });
      expect(res.status).toBe(200);
    }

    expect(await prisma.creditTransaction.count()).toBe(2);
  });

  it('never treats two adjustments without a reference as duplicates', async () => {
    const alice = await makeAccount('alice');

    for (const n of [1, 2, 3]) {
      const res = await request(app)
        .post(`/api/admin/accounts/${alice.id}/credits`)
        .set(...staff())
        .send({ amount: '10', note: `correction ${n}` });
      expect(res.status).toBe(200);
    }

    expect(await prisma.creditTransaction.count()).toBe(3);
  });

  it('requires a note, so no correction is unexplained', async () => {
    const alice = await makeAccount('alice');

    const res = await request(app)
      .post(`/api/admin/accounts/${alice.id}/credits`)
      .set(...staff())
      .send({ amount: '10', note: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await prisma.creditTransaction.count()).toBe(0);
  });

  it.each(['0', 'ten', '1e3', '0.00001', ''])('rejects an amount of %j', async (amount) => {
    const alice = await makeAccount('alice');

    const res = await request(app)
      .post(`/api/admin/accounts/${alice.id}/credits`)
      .set(...staff())
      .send({ amount, note: 'why not' });

    expect(res.status).toBe(400);
    expect(await prisma.creditTransaction.count()).toBe(0);
  });

  it('404s an account that does not exist, before writing anything', async () => {
    const res = await request(app)
      .post('/api/admin/accounts/nope/credits')
      .set(...staff())
      .send({ amount: '10', note: 'ghost' });

    expect(res.status).toBe(404);
    expect(await prisma.creditTransaction.count()).toBe(0);
  });
});

describe('GET /api/admin/credit-transactions', () => {
  it('lists every account’s rows newest first, naming the account', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    // Timestamps stated rather than taken from the clock: two rows written
    // back to back land in the same millisecond, and a test that then asserts
    // which is "newest" is asserting on a tie.
    await prisma.creditTransaction.create({
      data: {
        accountId: alice.id,
        amount: 10_0000n,
        type: 'ADJUSTMENT',
        note: 'first',
        createdAt: new Date('2026-08-01T10:00:00.000Z'),
      },
    });
    await prisma.creditTransaction.create({
      data: {
        accountId: bob.id,
        amount: -5_0000n,
        type: 'ADJUSTMENT',
        note: 'second',
        createdAt: new Date('2026-08-01T10:00:01.000Z'),
      },
    });

    const res = await request(app).get('/api/admin/credit-transactions').set(...staff());

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.items[0].account).toMatchObject({ email: 'bob@ezo.test' });
  });

  it('orders rows sharing a timestamp stably, so paging cannot repeat or skip one', async () => {
    const alice = await makeAccount('alice');
    // `createdAt` is a TIMESTAMP(3); a batch written in one pass shares one
    // millisecond. Ordered on that column alone the tie is broken arbitrarily
    // per query, and offset paging over an arbitrary order shows a row on two
    // pages or on none.
    const sameInstant = new Date('2026-08-01T10:00:00.000Z');
    await prisma.creditTransaction.createMany({
      data: [1, 2, 3, 4, 5, 6].map((n) => ({
        accountId: alice.id,
        amount: BigInt(n) * 10_000n,
        type: 'ADJUSTMENT' as const,
        note: `row ${n}`,
        createdAt: sameInstant,
      })),
    });

    const pageOne = await request(app)
      .get('/api/admin/credit-transactions?limit=3')
      .set(...staff());
    const pageTwo = await request(app)
      .get('/api/admin/credit-transactions?limit=3&page=2')
      .set(...staff());
    const pageOneAgain = await request(app)
      .get('/api/admin/credit-transactions?limit=3')
      .set(...staff());

    const ids = (res: typeof pageOne) =>
      (res.body.data.items as Array<{ id: string }>).map((row) => row.id);

    // The same query twice is the same page.
    expect(ids(pageOneAgain)).toEqual(ids(pageOne));
    // And the two pages together are the six rows, each exactly once.
    expect(new Set([...ids(pageOne), ...ids(pageTwo)]).size).toBe(6);
  });

  it('filters by account', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    await prisma.creditTransaction.create({
      data: { accountId: alice.id, amount: 10_0000n, type: 'ADJUSTMENT' },
    });
    await prisma.creditTransaction.create({
      data: { accountId: bob.id, amount: 10_0000n, type: 'ADJUSTMENT' },
    });

    const res = await request(app)
      .get(`/api/admin/credit-transactions?accountId=${alice.id}`)
      .set(...staff());

    expect(res.body.data.total).toBe(1);
    expect(res.body.data.items[0].account.id).toBe(alice.id);
  });

  it('filters by type', async () => {
    const alice = await makeAccount('alice');
    await prisma.creditTransaction.create({
      data: { accountId: alice.id, amount: 10_0000n, type: 'ADJUSTMENT' },
    });
    await prisma.creditTransaction.create({
      data: { accountId: alice.id, amount: -1_0000n, type: 'DID_PURCHASE' },
    });

    const res = await request(app)
      .get('/api/admin/credit-transactions?type=DID_PURCHASE')
      .set(...staff());

    expect(res.body.data.total).toBe(1);
    expect(res.body.data.items[0].type).toBe('DID_PURCHASE');
  });

  // An unrecognised filter that returned everything would read as "this
  // account has no DID charges" when it has several.
  it('rejects a type it does not know rather than ignoring it', async () => {
    const res = await request(app)
      .get('/api/admin/credit-transactions?type=REFUND')
      .set(...staff());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
