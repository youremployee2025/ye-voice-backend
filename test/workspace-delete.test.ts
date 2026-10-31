import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { as, addMember, makeAccount, makeAgent, makePhoneNumber, makeWorkspace } from './helpers.js';

// The recording case reaches a route that talks to the platform, and no test
// may. Spread over the real module so every other export the app imports is
// still there — a mock missing one fails the whole file at load.
vi.mock('../src/adapter/vocobase.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/adapter/vocobase.js')>()),
  getCall: vi.fn(),
  getCallRecordingUrl: vi.fn(),
  fetchRecording: vi.fn(),
}));

const client = await import('../src/adapter/vocobase.js');
const { createApp } = await import('../src/app.js');

const app = createApp();

const getCall = vi.mocked(client.getCall);
const getCallRecordingUrl = vi.mocked(client.getCallRecordingUrl);
const fetchRecording = vi.mocked(client.fetchRecording);

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
});

async function deletedWorkspace() {
  const owner = await makeAccount('owner');
  const workspace = await makeWorkspace(owner, 'Doomed');
  await prisma.workspace.update({
    where: { id: workspace.id },
    data: { deletedAt: new Date() },
  });
  return { owner, workspace };
}

describe('a deleted workspace is unreachable', () => {
  it('answers 403 with the same sentence a non-member gets', async () => {
    const { owner, workspace } = await deletedWorkspace();

    // The comparison is made rather than assumed. A hardcoded literal would go
    // on passing if somebody reworded the non-member refusal alone, and the
    // two answers differing is exactly what would let a caller sort workspace
    // ids into deleted and never-existed.
    const stranger = await makeAccount('stranger');
    const live = await makeWorkspace(await makeAccount('elsewhere'), 'Live');

    const deleted = await request(app)
      .get(`/api/workspaces/${workspace.id}/members`)
      .set(...as(owner.clerkUserId, owner.email));

    const nonMember = await request(app)
      .get(`/api/workspaces/${live.id}/members`)
      .set(...as(stranger.clerkUserId, stranger.email));

    expect(nonMember.status).toBe(403);
    expect(deleted.status).toBe(nonMember.status);
    expect(deleted.body.error).toEqual(nonMember.body.error);
    expect(deleted.body.error.code).toBe('FORBIDDEN');
  });

  it('stops a recording token minted moments earlier from playing', async () => {
    // The one workspace-scoped route a request can reach without passing
    // through `requireMembership`: a valid `?token=` short-circuits it. The
    // token outlives the delete by up to its two-minute TTL, and every Range
    // request inside that window would keep streaming audio.
    const owner = await makeAccount('owner');
    const workspace = await makeWorkspace(owner, 'Doomed');
    const agent = await makeAgent(workspace, 'Support');

    getCall.mockResolvedValue({
      call_id: 'call-1',
      agent_id: agent.externalId,
      session: { recording_url: 'https://storage.test/signed.wav?sig=secret' },
    } as never);
    getCallRecordingUrl.mockResolvedValue({
      call_id: 'call-1',
      recording_url: 'https://storage.test/fresh.wav?sig=fresh',
    } as never);
    fetchRecording.mockResolvedValue(new Response('RIFFDATA', { status: 200 }));

    const minted = await request(app)
      .get(`/api/workspaces/${workspace.id}/calls/call-1/recording-token`)
      .set(...as(owner.clerkUserId, owner.email));
    expect(minted.status).toBe(200);
    const token = minted.body.data.token as string;

    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { deletedAt: new Date() },
    });

    const played = await request(app).get(
      `/api/workspaces/${workspace.id}/calls/call-1/recording?token=${token}`,
    );

    expect(played.status).toBe(401);
    // The words an expired link gets, so the two are indistinguishable.
    expect(played.body.error.message).toBe('This recording link is invalid or has expired.');
    expect(fetchRecording).not.toHaveBeenCalled();
  });
});

/**
 * Express keeps no copy of the string a router was mounted at — only the
 * regexp it compiled from it — so the prefix is read back out of that. A
 * source carrying anything but literal path characters is refused rather than
 * guessed at: a prefix that is silently wrong makes every request in the sweep
 * a 404, which is not a 403 and would fail the sweep for a reason that has
 * nothing to do with the rule under test.
 */
function mountPrefix(regexp: RegExp): string {
  const literal = regexp.source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\\\//g, '/');

  if (!/^\/[a-zA-Z0-9/_-]*$/.test(literal)) {
    throw new Error(`Cannot read a mount path back out of ${regexp.source}`);
  }

  return literal;
}

/**
 * Every `/api/workspaces/:workspaceId/*` route, enumerated from the app rather
 * than listed by hand. A route added later that forgets the rule fails here,
 * not in production.
 */
function workspaceScopedRoutes(): Array<{ method: string; path: string }> {
  const found: Array<{ method: string; path: string }> = [];

  for (const layer of (app as never as { _router: { stack: never[] } })._router.stack) {
    const mounted = layer as {
      name: string;
      handle?: { stack?: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };
      regexp?: RegExp;
    };
    if (mounted.name !== 'router' || !mounted.handle?.stack) continue;
    if (!mounted.regexp?.source.includes('api')) continue;

    for (const inner of mounted.handle.stack) {
      const route = inner.route;
      if (!route?.path.includes(':workspaceId')) continue;
      const path = `${mountPrefix(mounted.regexp)}${route.path}`;
      for (const [method, on] of Object.entries(route.methods)) {
        if (on) found.push({ method, path });
      }
    }
  }

  return found;
}

/**
 * `path` is a route pattern, not a URL. The workspace id is substituted first
 * because it is the one parameter whose value has to be real; every other one
 * is a child id and any value does, since the membership check runs before the
 * lookup and the 403 must arrive first.
 *
 * An **escaped** colon is left alone. `documents\:upload` is a literal segment
 * rather than a parameter, and rewriting it produces a path that 404s — a
 * failure that reads as a route ducking the rule when it is the sweep that
 * mangled the URL.
 */
function urlFor(path: string, workspaceId: string): string {
  return path
    .replace(':workspaceId', workspaceId)
    .replace(/(?<!\\):[A-Za-z]+/g, 'x')
    .replace(/\\:/g, ':');
}

type Send = Record<
  string,
  (url: string) => {
    set(field: string, value: string): PromiseLike<{
      status: number;
      body: { error?: { code?: string } };
    }>;
  }
>;

describe('isolation sweep', () => {
  it('finds the workspace-scoped routes to sweep', () => {
    // A guard on the guard: if the stack walk ever returns nothing — a renamed
    // internal, a router mounted somewhere new — the sweep below passes
    // vacuously and proves the opposite of what it claims.
    expect(workspaceScopedRoutes().length).toBeGreaterThan(60);
  });

  it('refuses every workspace-scoped route on a deleted workspace', async () => {
    const { owner, workspace } = await deletedWorkspace();

    for (const { method, path } of workspaceScopedRoutes()) {
      const where = `${method.toUpperCase()} ${path}`;
      const response = await (request(app) as never as Send)
        [method](urlFor(path, workspace.id))
        .set(...as(owner.clerkUserId, owner.email));

      // Named per route: a bare "expected 200 to be 403" across ninety of them
      // says nothing about which one let the caller through. The refusal
      // sentence is deliberately not pinned here — the case above already does
      // that, against a real non-member's answer rather than a literal.
      expect(response.status, `${where} answered ${response.status}`).toBe(403);
      expect(response.body.error?.code, `${where} refused with the wrong code`).toBe('FORBIDDEN');
    }
  });
});

describe('a deleted workspace disappears from the bootstrap payload', () => {
  /**
   * The invite row is written directly because the route that would send one
   * is behind `requireMembership` and now refuses. It stands for the only way
   * such a row can exist at all: an invite sent while the workspace was live,
   * which the delete leaves PENDING behind it.
   */
  async function pendingInviteToDeletedWorkspace(email: string) {
    const { owner, workspace } = await deletedWorkspace();
    const invite = await prisma.workspaceInvite.create({
      data: { workspaceId: workspace.id, email, role: 'MEMBER', invitedById: owner.id },
    });
    return { owner, workspace, invite };
  }

  it('is omitted from /api/me', async () => {
    const { owner, workspace } = await deletedWorkspace();
    const live = await makeWorkspace(owner, 'Live');

    const res = await request(app)
      .get('/api/me')
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(200);
    // Named rather than counted: a switcher listing the deleted workspace and
    // the live one differs from a correct payload only by which id is there.
    expect(res.body.data.workspaces.map((w: { id: string }) => w.id)).toEqual([live.id]);
    expect(res.body.data.workspaces.map((w: { id: string }) => w.id)).not.toContain(workspace.id);
  });

  it('omits a pending invite to it', async () => {
    await pendingInviteToDeletedWorkspace('carol@ezo.test');

    const res = await request(app)
      .get('/api/me')
      .set(...as('user_carol', 'carol@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data.pendingInvites).toEqual([]);
  });

  it('cannot accept a pending invite to it', async () => {
    const { workspace, invite } = await pendingInviteToDeletedWorkspace('carol@ezo.test');

    const res = await request(app)
      .post(`/api/invites/${invite.id}/accept`)
      .set(...as('user_carol', 'carol@ezo.test'));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');

    // The assertion that matters. A 404 that still wrote the membership row
    // would seat somebody in a workspace nobody can open, and the status code
    // alone would go on reading as a refusal.
    const carol = await prisma.account.findUniqueOrThrow({ where: { clerkUserId: 'user_carol' } });
    expect(
      await prisma.workspaceMember.count({
        where: { workspaceId: workspace.id, accountId: carol.id },
      }),
    ).toBe(0);
  });
});

describe('only the owner may delete', () => {
  /**
   * An ADMIN who was invited, and the owner, on the same workspace. The two
   * cases below are the same request from the two identities: the refusal
   * means nothing unless the identical call succeeds for the owner, since a
   * 403 for everybody is also what a route nobody may call looks like.
   */
  async function invitedAdmin() {
    const owner = await makeAccount('owner');
    const admin = await makeAccount('admin');
    const workspace = await makeWorkspace(owner, 'Theirs');
    await addMember(workspace, admin, 'ADMIN');
    return { owner, admin, workspace };
  }

  it('refuses an invited ADMIN who is not the owner', async () => {
    const { admin, workspace } = await invitedAdmin();

    const res = await request(app)
      .delete(`/api/workspaces/${workspace.id}`)
      .set(...as(admin.clerkUserId, admin.email));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    // The workspace is untouched, not merely un-answered. An admin who can
    // rename it must not be able to erase it out from under the person whose
    // account is billed for its DIDs and its calls.
    expect(await prisma.workspace.findUnique({ where: { id: workspace.id } })).toMatchObject({
      deletedAt: null,
    });
  });

  it('lets the owner delete the workspace the admin could not', async () => {
    const { owner, workspace } = await invitedAdmin();

    const res = await request(app)
      .delete(`/api/workspaces/${workspace.id}`)
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(workspace.id);
    expect(
      (await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).deletedAt,
    ).toBeInstanceOf(Date);
  });
});

describe('the blockers', () => {
  async function owned() {
    const owner = await makeAccount('owner');
    const workspace = await makeWorkspace(owner, 'Mine');
    return { owner, workspace };
  }

  const del = (workspace: { id: string }, owner: { clerkUserId: string; email: string }) =>
    request(app)
      .delete(`/api/workspaces/${workspace.id}`)
      .set(...as(owner.clerkUserId, owner.email));

  it('refuses while a DID is rented, and names it', async () => {
    const { owner, workspace } = await owned();
    const did = await makePhoneNumber(workspace, '+918000', 'ASSIGNED');

    const res = await del(workspace, owner);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WORKSPACE_HAS_PHONE_NUMBERS');
    // The list, not just the count: releasing a DID is irreversible, so the
    // reader has to see exactly which numbers they are being asked to give up
    // before they go and do it.
    expect(res.body.details.phoneNumbers).toEqual([{ id: did.id, did: did.did }]);
  });

  it('refuses while a campaign is RUNNING, and names it', async () => {
    const { owner, workspace } = await owned();
    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'Live one', status: 'RUNNING' },
    });

    const res = await del(workspace, owner);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WORKSPACE_HAS_LIVE_CAMPAIGNS');
    expect(res.body.details.campaigns).toEqual([
      { id: campaign.id, name: 'Live one', status: 'RUNNING' },
    ]);
  });

  it('refuses a DRAFT campaign that is scheduled to start', async () => {
    const { owner, workspace } = await owned();
    const campaign = await prisma.campaign.create({
      data: {
        workspaceId: workspace.id,
        name: 'Tomorrow',
        status: 'DRAFT',
        scheduledStartAt: new Date(Date.now() + 86_400_000),
      },
    });

    const res = await del(workspace, owner);

    // The status alone would let this one through, and it is the case that
    // fails overnight with nobody watching: the scanner starts it on its own
    // clock, into a workspace that is gone.
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WORKSPACE_HAS_LIVE_CAMPAIGNS');
    expect(res.body.details.campaigns).toEqual([
      { id: campaign.id, name: 'Tomorrow', status: 'DRAFT' },
    ]);
  });

  it('refuses while a call is in flight', async () => {
    const { owner, workspace } = await owned();
    // PAUSED, so the campaign blocker cannot be what refuses: a stopped
    // campaign can still have a call connected on it, and that call is the
    // thing being tested.
    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'Winding down', status: 'PAUSED' },
    });
    const contact = await prisma.contact.create({
      data: { workspaceId: workspace.id, phone: '+919000000001' },
    });
    const link = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id, status: 'QUEUED' },
    });
    await prisma.callAttempt.create({
      data: {
        campaignId: campaign.id,
        campaignContactId: link.id,
        workspaceId: workspace.id,
        accountId: owner.id,
        attemptNo: 1,
        status: 'IN_PROGRESS',
      },
    });

    const res = await del(workspace, owner);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WORKSPACE_HAS_CALLS_IN_FLIGHT');
    expect(res.body.details.inFlight).toBe(1);
  });

  it('refuses while a test session is ACTIVE', async () => {
    const { owner, workspace } = await owned();
    const agent = await makeAgent(workspace, 'receptionist');
    await prisma.testSession.create({
      data: {
        workspaceId: workspace.id,
        accountId: owner.id,
        agentId: agent.id,
        startedByAccountId: owner.id,
        status: 'ACTIVE',
      },
    });

    const res = await del(workspace, owner);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WORKSPACE_HAS_ACTIVE_TEST_SESSION');
    expect(res.body.details.activeTestSessions).toBe(1);
  });

  it('nothing is released or stopped by a refusal', async () => {
    const { owner, workspace } = await owned();
    const did = await makePhoneNumber(workspace, '+918000', 'ASSIGNED');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'Live one', status: 'RUNNING' },
    });

    expect((await del(workspace, owner)).status).toBe(409);

    // Releasing a DID returns it to the shared pool where anyone may rent it,
    // so it stays a separate deliberate act rather than a side effect of a
    // button named Delete. The same for stopping a campaign mid-dial.
    expect(await prisma.phoneNumber.findUnique({ where: { id: did.id } })).toMatchObject({
      workspaceId: workspace.id,
      status: 'ASSIGNED',
    });
    expect(await prisma.campaign.findUnique({ where: { id: campaign.id } })).toMatchObject({
      status: 'RUNNING',
    });
    // And the workspace itself survives the refusal, rather than being marked
    // deleted alongside a 409 that says it was not.
    expect(await prisma.workspace.findUnique({ where: { id: workspace.id } })).toMatchObject({
      deletedAt: null,
    });
  });
});

describe('the delete itself', () => {
  it('marks the row deleted and leaves the ledger resolvable', async () => {
    const owner = await makeAccount('owner');
    const workspace = await makeWorkspace(owner, 'Mine');

    // A finished call and the charge it produced, written the way
    // `dialerOutcome` writes them. Terminal, so neither blocker fires — the
    // point of the fixture is the ledger row, not the attempt.
    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'Finished', status: 'COMPLETED' },
    });
    const attempt = await prisma.callAttempt.create({
      data: {
        campaignId: campaign.id,
        workspaceId: workspace.id,
        accountId: owner.id,
        attemptNo: 1,
        status: 'COMPLETED',
        resolvedAt: new Date(),
      },
    });
    const ledger = await prisma.creditTransaction.create({
      data: {
        accountId: owner.id,
        workspaceId: workspace.id,
        callAttemptId: attempt.id,
        reference: attempt.id,
        amount: -10_000n,
        type: 'CALL_USAGE',
      },
    });

    const res = await request(app)
      .delete(`/api/workspaces/${workspace.id}`)
      .set(...as(owner.clerkUserId, owner.email));

    expect(res.status).toBe(200);
    expect(
      (await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).deletedAt,
    ).toBeInstanceOf(Date);

    // The assertion this whole task turns on. `CreditTransaction.workspace` is
    // `onDelete: Restrict` precisely so a workspace's billing history cannot
    // evaporate the moment somebody wants to read it; a row-level DELETE would
    // have had to erase this row or null its snapshot to get past that
    // constraint. The row still names the workspace it was charged against.
    const row = await prisma.creditTransaction.findUnique({
      where: { id: ledger.id },
      include: { workspace: true },
    });
    expect(row?.workspace?.id).toBe(workspace.id);
    expect(row?.amount).toBe(-10_000n);
  });

  it('keeps the slug taken', async () => {
    const owner = await makeAccount('owner');
    const workspace = await prisma.workspace.create({
      data: {
        name: 'Acme',
        slug: 'acme',
        color: '#6366f1',
        ownerAccountId: owner.id,
        members: { create: { accountId: owner.id, role: 'ADMIN' } },
      },
    });

    const deleted = await request(app)
      .delete(`/api/workspaces/${workspace.id}`)
      .set(...as(owner.clerkUserId, owner.email));
    expect(deleted.status).toBe(200);

    const res = await request(app)
      .post('/api/workspaces')
      .set(...as(owner.clerkUserId, owner.email))
      .send({ name: 'Acme' });

    expect(res.status).toBe(201);
    // Re-issuing a dead workspace's slug would make every old link to it
    // resolve to a stranger's workspace.
    expect(res.body.data.slug).not.toBe('acme');
  });

  it('is idempotent enough to be safe: a second delete is a 403', async () => {
    const owner = await makeAccount('owner');
    const workspace = await makeWorkspace(owner, 'Mine');
    const attempt = () =>
      request(app)
        .delete(`/api/workspaces/${workspace.id}`)
        .set(...as(owner.clerkUserId, owner.email));

    expect((await attempt()).status).toBe(200);
    const first = (await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } }))
      .deletedAt;

    // `requireMembership` refuses before the handler, so the second click gets
    // the same answer every other route now gives — and the timestamp is the
    // moment of the first delete, not of the second click.
    expect((await attempt()).status).toBe(403);
    expect(
      (await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).deletedAt,
    ).toEqual(first);
  });
});
