import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import {
  addMember,
  interposeBeforeTx,
  makeAccount,
  makeAgent,
  makePhoneNumber,
  makeWorkspace,
} from './helpers.js';

const findOrCreateClerkUser = vi.fn();
vi.mock('../src/lib/clerkUsers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/clerkUsers.js')>()),
  findOrCreateClerkUser: (email: string) => findOrCreateClerkUser(email),
}));

// Onboarding strips each agent before it claims it, and the strip talks to
// the platform. Mocked at the service boundary; `onboarding.test.ts` pins the
// contract, this file only needs it not to reach the network.
const detachForeignResources = vi.fn();
vi.mock('../src/services/agentHandover.js', () => ({
  detachForeignResources: (...args: unknown[]) => detachForeignResources(...args),
}));

const TOKEN = 'staff-token-for-tests';
process.env.ADMIN_STAFF_TOKEN = TOKEN;

const { createApp } = await import('../src/app.js');

const app = createApp();
const staff = () => ['X-Admin-Token', TOKEN] as [string, string];

beforeEach(async () => {
  await truncateAll();
  detachForeignResources.mockReset();
  detachForeignResources.mockResolvedValue(undefined);
  findOrCreateClerkUser.mockReset();
  findOrCreateClerkUser.mockImplementation(async (email: string) => ({
    clerkUserId: `user_${email.replace(/[^a-z0-9]/gi, '_')}`,
    email,
    name: null,
    imageUrl: null,
    created: true,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const onboardBody = {
  email: 'ops@moomba.test',
  workspaceName: 'Moomba Foods',
  credits: '500',
};

describe('staff authentication on the customer routes', () => {
  // Its own app, so these rejections do not spend the limiter's failure budget
  // on behalf of every case below.
  const app = createApp();

  const routes: Array<[string, string]> = [
    ['post', '/api/admin/customers/onboard'],
    ['get', '/api/admin/account-transfers/preview'],
    ['post', '/api/admin/account-transfers'],
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
    const res = await request(app)
      .post('/api/admin/customers/onboard')
      .set('X-Test-Clerk-User', 'user_alice|alice@ezo.test')
      .send(onboardBody);

    expect(res.status).toBe(401);
    expect(await prisma.workspace.count()).toBe(0);
  });
});

describe('POST /api/admin/customers/onboard', () => {
  it('onboards a customer and reports what it assigned', async () => {
    const agent = await makeAgent(null, 'receptionist');
    const did = await makePhoneNumber(null, '+913331', 'UNASSIGNED');
    const tier = await prisma.tier.create({
      data: { slug: 'va-1', name: 'Standard', defaultPriceCreditsPerMin: 10_000n },
    });

    const res = await request(app)
      .post('/api/admin/customers/onboard')
      .set(...staff())
      .send({
        ...onboardBody,
        agentIds: [agent.id],
        phoneNumberIds: [did.id],
        tierId: tier.id,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.workspace).toMatchObject({
      name: 'Moomba Foods',
      slug: 'moomba-foods',
    });
    expect(res.body.data.assigned).toMatchObject({
      agents: 1,
      phone_numbers: 1,
      tier: 'Standard',
      credits: '500',
    });
    expect(res.body.data.account.email).toBe('ops@moomba.test');
  });

  it('accepts an email padded with whitespace, and stores it trimmed', async () => {
    const res = await request(app)
      .post('/api/admin/customers/onboard')
      .set(...staff())
      .send({ ...onboardBody, email: '  ops@moomba.test  ' });

    expect(res.status).toBe(201);
    expect(res.body.data.account.email).toBe('ops@moomba.test');
    expect(findOrCreateClerkUser).toHaveBeenCalledWith('ops@moomba.test');
    expect((await prisma.account.findFirstOrThrow()).email).toBe('ops@moomba.test');
  });

  it('refuses a malformed email before anything is written', async () => {
    const res = await request(app)
      .post('/api/admin/customers/onboard')
      .set(...staff())
      .send({ ...onboardBody, email: 'not-an-address' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(findOrCreateClerkUser).not.toHaveBeenCalled();
    expect(await prisma.workspace.count()).toBe(0);
  });

  it('refuses a blank workspace name', async () => {
    const res = await request(app)
      .post('/api/admin/customers/onboard')
      .set(...staff())
      .send({ ...onboardBody, workspaceName: '   ' });

    expect(res.status).toBe(400);
  });

  it('refuses a zero or negative opening credit', async () => {
    for (const credits of ['0', '-5']) {
      const res = await request(app)
        .post('/api/admin/customers/onboard')
        .set(...staff())
        .send({ ...onboardBody, credits });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }

    expect(await prisma.workspace.count()).toBe(0);
  });

  it('refuses the same agent twice rather than silently deduping', async () => {
    const agent = await makeAgent(null, 'receptionist');

    const res = await request(app)
      .post('/api/admin/customers/onboard')
      .set(...staff())
      .send({ ...onboardBody, agentIds: [agent.id, agent.id] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('answers 409 for an agent somebody else holds', async () => {
    const owner = await makeAccount('alice');
    const theirs = await makeWorkspace(owner, 'Theirs');
    const taken = await makeAgent(theirs, 'taken');

    const res = await request(app)
      .post('/api/admin/customers/onboard')
      .set(...staff())
      .send({ ...onboardBody, agentIds: [taken.id] });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AGENT_NOT_AVAILABLE');
    expect(await prisma.workspace.count({ where: { name: 'Moomba Foods' } })).toBe(0);
  });

  it('answers 409 for a number somebody else rents', async () => {
    const owner = await makeAccount('alice');
    const theirs = await makeWorkspace(owner, 'Theirs');
    const rented = await makePhoneNumber(theirs, '+913332', 'ASSIGNED');

    const res = await request(app)
      .post('/api/admin/customers/onboard')
      .set(...staff())
      .send({ ...onboardBody, phoneNumberIds: [rented.id] });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PHONE_NUMBER_NOT_AVAILABLE');
  });

  it('answers 409 for a retired tier', async () => {
    const tier = await prisma.tier.create({
      data: { slug: 'gone', name: 'Gone', status: 'REMOVED' },
    });

    const res = await request(app)
      .post('/api/admin/customers/onboard')
      .set(...staff())
      .send({ ...onboardBody, tierId: tier.id });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TIER_NOT_ASSIGNABLE');
  });

  it('answers 404 for a tier that does not exist', async () => {
    const res = await request(app)
      .post('/api/admin/customers/onboard')
      .set(...staff())
      .send({ ...onboardBody, tierId: 'no-such-tier' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('answers 502 when Clerk cannot be reached, and writes nothing', async () => {
    const { ClerkProvisioningError } = await import('../src/lib/clerkUsers.js');
    findOrCreateClerkUser.mockRejectedValue(
      new ClerkProvisioningError('ops@moomba.test', new Error('down')),
    );

    const res = await request(app)
      .post('/api/admin/customers/onboard')
      .set(...staff())
      .send(onboardBody);

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('CLERK_ERROR');
    // The message must not name the upstream failure verbatim — it is logged.
    expect(res.body.error.message).not.toContain('down');
    expect(await prisma.account.count()).toBe(0);
  });
});

describe('GET /api/admin/account-transfers/preview', () => {
  it('describes the transfer without performing it', async () => {
    const source = await makeAccount('source');
    const destination = await makeAccount('destination');
    const workspace = await makeWorkspace(source, 'One');
    await makeAgent(workspace, 'receptionist');
    await prisma.account.update({ where: { id: source.id }, data: { credits: 5_000_000n } });

    const res = await request(app)
      .get('/api/admin/account-transfers/preview')
      .query({ sourceAccountId: source.id, destinationAccountId: destination.id })
      .set(...staff());

    expect(res.status).toBe(200);
    expect(res.body.data.counts).toMatchObject({ workspaces: 1, agents: 1 });
    expect(res.body.data.credits).toBe('500');
    // The plan carries the raw bigint the commit CASes on; the wire gets the
    // decimal string only.
    expect(res.body.data).not.toHaveProperty('balanceInternal');

    // Nothing moved.
    expect(
      (await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } }))
        .ownerAccountId,
    ).toBe(source.id);
  });

  it('answers 422 for a source and destination that are the same', async () => {
    const source = await makeAccount('source');

    const res = await request(app)
      .get('/api/admin/account-transfers/preview')
      .query({ sourceAccountId: source.id, destinationAccountId: source.id })
      .set(...staff());

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SAME_ACCOUNT');
  });

  it('answers 404 for an account that does not exist', async () => {
    const source = await makeAccount('source');

    const res = await request(app)
      .get('/api/admin/account-transfers/preview')
      .query({ sourceAccountId: source.id, destinationAccountId: 'nobody' })
      .set(...staff());

    expect(res.status).toBe(404);
  });

  it('answers 400 when an account id is missing', async () => {
    const res = await request(app)
      .get('/api/admin/account-transfers/preview')
      .set(...staff());

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/admin/account-transfers', () => {
  it('transfers everything and reports what moved', async () => {
    const source = await makeAccount('source');
    const destination = await makeAccount('destination');
    const workspace = await makeWorkspace(source, 'One');
    const colleague = await makeAccount('colleague');
    await addMember(workspace, colleague, 'MEMBER');
    await prisma.account.update({ where: { id: source.id }, data: { credits: 5_000_000n } });

    const res = await request(app)
      .post('/api/admin/account-transfers')
      .set(...staff())
      .send({ sourceAccountId: source.id, destinationAccountId: destination.id });

    expect(res.status).toBe(200);
    expect(res.body.data.counts.workspaces).toBe(1);
    expect(res.body.data.credits).toBe('500');

    expect(
      (await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } }))
        .ownerAccountId,
    ).toBe(destination.id);
    expect(
      (await prisma.account.findUniqueOrThrow({ where: { id: destination.id } })).credits,
    ).toBe(5_000_000n);
    // The colleague is untouched.
    expect(
      await prisma.workspaceMember.count({
        where: { workspaceId: workspace.id, accountId: colleague.id },
      }),
    ).toBe(1);
  });

  it('answers 409 when the book of business changes under the transfer', async () => {
    const source = await makeAccount('source');
    const destination = await makeAccount('destination');
    const third = await makeAccount('third');
    const workspace = await makeWorkspace(source, 'Moved');

    interposeBeforeTx('workspace', 'updateMany', async () => {
      await prisma.workspace.update({
        where: { id: workspace.id },
        data: { ownerAccountId: third.id },
      });
    });

    const res = await request(app)
      .post('/api/admin/account-transfers')
      .set(...staff())
      .send({ sourceAccountId: source.id, destinationAccountId: destination.id });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONCURRENT_MODIFICATION');
    expect(await prisma.workspaceMember.count({ where: { accountId: destination.id } })).toBe(0);
  });

  it('answers 422 for a source that owns nothing', async () => {
    const source = await makeAccount('source');
    const destination = await makeAccount('destination');

    const res = await request(app)
      .post('/api/admin/account-transfers')
      .set(...staff())
      .send({ sourceAccountId: source.id, destinationAccountId: destination.id });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NO_WORKSPACES');
  });

  it('answers 422 for a source and destination that are the same', async () => {
    const source = await makeAccount('source');
    await makeWorkspace(source, 'One');

    const res = await request(app)
      .post('/api/admin/account-transfers')
      .set(...staff())
      .send({ sourceAccountId: source.id, destinationAccountId: source.id });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SAME_ACCOUNT');
  });

  it('answers 404 for an account that does not exist, and moves nothing', async () => {
    const source = await makeAccount('source');
    const workspace = await makeWorkspace(source, 'One');

    const res = await request(app)
      .post('/api/admin/account-transfers')
      .set(...staff())
      .send({ sourceAccountId: source.id, destinationAccountId: 'nobody' });

    expect(res.status).toBe(404);
    expect(
      (await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } }))
        .ownerAccountId,
    ).toBe(source.id);
  });
});
