import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, as, makeAccount, makeWorkspace } from './helpers.js';
// The staff path, because fixtures need to put a connection wherever the case
// needs it — including another workspace, which the customer path refuses to
// arrange on purpose.
import { reassignResource as mapResource } from '../src/lib/workspaceResource.js';

vi.mock('../src/adapter/vocobase.js', () => ({
  listConnectors: vi.fn(),
  listCustomerConnections: vi.fn(),
  createPartnerCustomer: vi.fn(),
  createConnectLink: vi.fn(),
  deleteCustomerConnection: vi.fn(),
}));

const client = await import('../src/adapter/vocobase.js');
const { createApp } = await import('../src/app.js');
const { env } = await import('../src/lib/env.js');
const nonceModule = await import('../src/lib/oauthNonce.js');
const { consumeConnectNonce, mintConnectNonce } = nonceModule;
const { closeQueueConnection, getQueueConnection } = await import('../src/lib/queue/connection.js');

const app = createApp();

function connector(slug: string, name: string) {
  return { id: `tool_${slug}`, slug, name, status: 'ACTIVE', provider: 'google' };
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn_1',
    tool_slug: 'google_sheets',
    tool_name: 'Google Sheets',
    status: 'ACTIVE',
    provider_email: 'ops@acme.test',
    created_at: '2026-09-21T10:00:00.000Z',
    ...overrides,
  };
}

/** The catalogue as it really arrives: every connector on the partner account,
 *  not only the three this surface offers. */
const CATALOGUE = {
  connectors: [
    connector('google_sheets', 'Google Sheets'),
    connector('google_calendar', 'Google Calendar'),
    connector('gmail', 'Gmail'),
    connector('shopify', 'Shopify'),
  ],
};

let alice: Awaited<ReturnType<typeof makeAccount>>;
let workspace: Workspace;

beforeEach(async () => {
  await truncateAll();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});

  alice = await makeAccount('alice');
  workspace = await makeWorkspace(alice, 'Acme');

  vi.mocked(client.listConnectors).mockResolvedValue(CATALOGUE);
  vi.mocked(client.listCustomerConnections).mockResolvedValue({ connections: [] });
});

afterAll(async () => {
  await closeQueueConnection();
});

/** The nonce out of the redirect the connect link was minted with — the only
 *  place it is ever visible to a caller. */
function nonceFromLastConnectLink(): string {
  const [, body] = vi.mocked(client.createConnectLink).mock.calls[0];
  return new URL(body.redirect_uri).pathname.split('/').pop() ?? '';
}

async function withCustomer(id = 'pcus_1'): Promise<Workspace> {
  return prisma.workspace.update({
    where: { id: workspace.id },
    data: { partnerCustomerId: id },
  });
}

describe('GET /:workspaceId/integrations', () => {
  it('offers the three Google connectors and nothing else on the account', async () => {
    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/integrations`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data.tools.map((tool: { slug: string }) => tool.slug)).toEqual([
      'google_sheets',
      'google_calendar',
      'gmail',
    ]);
  });

  /** A read must not mint anything upstream: an admin opening the page has not
   *  asked for a customer, and every workspace that ever looks would get one. */
  it('does not create a partner customer, and asks for no connections without one', async () => {
    await request(app)
      .get(`/api/workspaces/${workspace.id}/integrations`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(client.createPartnerCustomer).not.toHaveBeenCalled();
    expect(client.listCustomerConnections).not.toHaveBeenCalled();
    const stored = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    expect(stored.partnerCustomerId).toBeNull();
  });

  it('lists a connected account under its tool', async () => {
    await withCustomer();
    await mapResource('CONNECTION', 'conn_1', workspace.id);
    vi.mocked(client.listCustomerConnections).mockResolvedValue({
      connections: [connection()],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/integrations`)
      .set(...as('user_alice', 'alice@ezo.test'));

    const sheets = res.body.data.tools.find((tool: { slug: string }) => tool.slug === 'google_sheets');
    expect(sheets.connections).toEqual([
      {
        id: 'conn_1',
        providerEmail: 'ops@acme.test',
        status: 'ACTIVE',
        createdAt: '2026-09-21T10:00:00.000Z',
      },
    ]);
  });

  /**
   * The return leg can be lost — the browser is closed on the consent screen's
   * redirect, the tab is killed mid-flight — and the connection then exists
   * upstream with no mapping here, invisible to every bind that would use it.
   * The listing is the repair: the platform has already told us whose customer
   * holds it.
   */
  it('claims a connection the return leg never recorded', async () => {
    await withCustomer();
    vi.mocked(client.listCustomerConnections).mockResolvedValue({
      connections: [connection({ id: 'conn_orphan' })],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/integrations`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    const mapped = await prisma.workspaceResource.findUnique({
      where: { kind_externalId: { kind: 'CONNECTION', externalId: 'conn_orphan' } },
    });
    expect(mapped?.workspaceId).toBe(workspace.id);
    expect(mapped?.name).toBe('ops@acme.test');
  });

  /**
   * Nothing legitimate produces this — the connection is upstream-owned by
   * THIS workspace's customer — so it is a contradiction, and the safe reading
   * is to leave the existing mapping alone and not offer a connection this
   * workspace could never bind.
   */
  it('neither moves nor lists a connection already mapped to another workspace', async () => {
    await withCustomer();
    const theirs = await makeWorkspace(await makeAccount('bob'), 'Bob Co');
    await mapResource('CONNECTION', 'conn_1', theirs.id);
    vi.mocked(client.listCustomerConnections).mockResolvedValue({
      connections: [connection()],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/integrations`)
      .set(...as('user_alice', 'alice@ezo.test'));

    const sheets = res.body.data.tools.find((tool: { slug: string }) => tool.slug === 'google_sheets');
    expect(sheets.connections).toEqual([]);
    const mapped = await prisma.workspaceResource.findUnique({
      where: { kind_externalId: { kind: 'CONNECTION', externalId: 'conn_1' } },
    });
    expect(mapped?.workspaceId).toBe(theirs.id);
  });

  it('drops a connection for a tool this surface does not offer', async () => {
    await withCustomer();
    vi.mocked(client.listCustomerConnections).mockResolvedValue({
      connections: [connection({ id: 'conn_shop', tool_slug: 'shopify' })],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/integrations`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(
      res.body.data.tools.flatMap((tool: { connections: unknown[] }) => tool.connections),
    ).toEqual([]);
  });

  it('is open to a member, and closed to a stranger', async () => {
    const bob = await makeAccount('bob');
    await addMember(workspace, bob, 'MEMBER');

    const member = await request(app)
      .get(`/api/workspaces/${workspace.id}/integrations`)
      .set(...as('user_bob', 'bob@ezo.test'));
    expect(member.status).toBe(200);

    await makeAccount('carol');
    const stranger = await request(app)
      .get(`/api/workspaces/${workspace.id}/integrations`)
      .set(...as('user_carol', 'carol@ezo.test'));
    expect(stranger.status).toBe(403);
  });
});

describe('POST /:workspaceId/integrations/:slug/connect', () => {
  beforeEach(() => {
    vi.mocked(client.createPartnerCustomer).mockResolvedValue({
      id: 'pcus_1',
      external_id: 'ws',
      name: 'Acme',
    });
    vi.mocked(client.createConnectLink).mockResolvedValue({
      url: 'https://voice.test/connect/tok',
      expires_at: '2026-09-21T12:15:00.000Z',
    });
  });

  function connect(slug = 'google_sheets', who: [string, string] = ['user_alice', 'alice@ezo.test']) {
    return request(app)
      .post(`/api/workspaces/${workspace.id}/integrations/${slug}/connect`)
      .set(...as(...who));
  }

  /**
   * ADMIN, not member — this is the act that authorises call content to leave
   * for a mailbox or a spreadsheet of somebody's choosing.
   */
  it('refuses a member', async () => {
    const bob = await makeAccount('bob');
    await addMember(workspace, bob, 'MEMBER');

    const res = await connect('google_sheets', ['user_bob', 'bob@ezo.test']);

    expect(res.status).toBe(403);
    expect(client.createConnectLink).not.toHaveBeenCalled();
    expect(client.createPartnerCustomer).not.toHaveBeenCalled();
  });

  it('mints a link and a single-use nonce that carries the context back', async () => {
    const res = await connect();

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      url: 'https://voice.test/connect/tok',
      expires_at: '2026-09-21T12:15:00.000Z',
    });

    const [customerId, body] = vi.mocked(client.createConnectLink).mock.calls[0];
    expect(customerId).toBe('pcus_1');
    expect(body.tool_slug).toBe('google_sheets');
    // Built from whatever `PUBLIC_API_URL` resolves to in this process, as
    // `RETURN_TO` is below: the deploy docs tell a developer to point it at a
    // tunnel, and a pinned host would fail the suite for doing so.
    expect(body.redirect_uri.startsWith(`${env.publicApiUrl}/integrations/google/return/`)).toBe(
      true,
    );

    const nonce = nonceFromLastConnectLink();
    expect(await consumeConnectNonce(nonce)).toEqual({
      workspaceId: workspace.id,
      slug: 'google_sheets',
      accountId: alice.id,
    });
    // Single use: the second read finds nothing.
    expect(await consumeConnectNonce(nonce)).toBeNull();
  });

  /**
   * The nonce must outlive every way the platform can still send the browser
   * back. The link is usable for `expires_in_seconds` (default 1800,
   * `connectLink.service.ts:18`) and the OAuth state it starts lives another
   * 600 s (`STATE_EXPIRY_SECONDS`, `integration.routes.ts:26`). A nonce shorter
   * than the sum tells an admin whose connection succeeded that it "expired".
   *
   * 600 is written out here rather than imported, so the test does not agree
   * with a constant that has drifted from the platform.
   */
  it('asks for a link that cannot outlive the nonce it returns to', async () => {
    const PLATFORM_OAUTH_STATE_SECONDS = 600;
    const { NONCE_TTL_SECONDS, CONNECT_LINK_TTL_SECONDS } = nonceModule;

    await connect();

    const [, body] = vi.mocked(client.createConnectLink).mock.calls[0];
    expect(body.expires_in_seconds).toBe(CONNECT_LINK_TTL_SECONDS);
    expect(CONNECT_LINK_TTL_SECONDS + PLATFORM_OAUTH_STATE_SECONDS).toBeLessThanOrEqual(
      NONCE_TTL_SECONDS,
    );
    // No shorter than the platform's own default: a slow consent (a password
    // and a second factor) must still find a live link.
    expect(CONNECT_LINK_TTL_SECONDS).toBeGreaterThanOrEqual(1800);

    // And the key really is stored for that long, not merely declared so.
    const ttl = await getQueueConnection().ttl(`ezo:oauth:${nonceFromLastConnectLink()}`);
    expect(ttl).toBeGreaterThan(NONCE_TTL_SECONDS - 5);
    expect(ttl).toBeLessThanOrEqual(NONCE_TTL_SECONDS);
  });

  it('creates the partner customer on first use and stores it', async () => {
    await connect();

    expect(client.createPartnerCustomer).toHaveBeenCalledWith({
      external_id: workspace.id,
      name: 'Acme',
    });
    const stored = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    expect(stored.partnerCustomerId).toBe('pcus_1');
  });

  it('reuses the customer a workspace already has', async () => {
    await withCustomer('pcus_existing');

    await connect();

    expect(client.createPartnerCustomer).not.toHaveBeenCalled();
    expect(vi.mocked(client.createConnectLink).mock.calls[0][0]).toBe('pcus_existing');
  });

  it('refuses a connector this surface does not offer', async () => {
    const res = await connect('shopify');

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('google_sheets');
    expect(client.createConnectLink).not.toHaveBeenCalled();
    expect(client.createPartnerCustomer).not.toHaveBeenCalled();
  });

  /**
   * The ops failure this flow has: the API host was never added to the partner
   * user's `allowedRedirectHosts` upstream. Reported as a configuration fault
   * rather than as a validation error, which would blame an admin who supplied
   * nothing.
   */
  it('reports an un-allow-listed redirect host as a configuration fault', async () => {
    const { ApiError } = await import('../src/lib/errors.js');
    vi.mocked(client.createConnectLink).mockRejectedValue(
      new ApiError(400, 'INVALID_REDIRECT_URI' as never, 'host not in allowed_redirect_hosts'),
    );

    const res = await connect();

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('INTEGRATIONS_NOT_CONFIGURED');
  });

  it.each(['TOOL_NOT_FOUND', 'TOOL_INACTIVE'])(
    'reports %s as the connector being unavailable',
    async (code) => {
      const { ApiError } = await import('../src/lib/errors.js');
      vi.mocked(client.createConnectLink).mockRejectedValue(
        new ApiError(400, code as never, 'nope'),
      );

      const res = await connect();

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('INTEGRATION_UNAVAILABLE');
    },
  );

  it('still reports an ordinary validation failure as one', async () => {
    const { ApiError } = await import('../src/lib/errors.js');
    vi.mocked(client.createConnectLink).mockRejectedValue(
      new ApiError(400, 'VALIDATION_ERROR', 'tool_slug is required'),
    );

    const res = await connect();

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  /** A link built on an empty origin points at `/integrations/...` with no
   *  host, which the platform cannot redirect to. Refused before anything is
   *  minted, rather than after a customer exists for it. */
  it('refuses to mint anything without a public origin', async () => {
    const saved = env.publicApiUrl;
    (env as { publicApiUrl: string }).publicApiUrl = '';

    try {
      const res = await connect();

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('INTEGRATIONS_NOT_CONFIGURED');
      expect(client.createPartnerCustomer).not.toHaveBeenCalled();
      expect(client.createConnectLink).not.toHaveBeenCalled();
    } finally {
      (env as { publicApiUrl: string }).publicApiUrl = saved;
    }
  });
});

describe('GET /integrations/google/return/:nonce', () => {
  // Whatever `CORS_ORIGIN` resolves to in this process — the route builds its
  // redirect from `env.dashboardUrl`, and pinning a port here would make the
  // suite depend on an `.env` the CI runner does not have.
  const RETURN_TO = `${env.dashboardUrl}/settings/integrations`;

  async function nonceFor(slug = 'google_sheets', ws = workspace.id) {
    return mintConnectNonce({ workspaceId: ws, slug, accountId: alice.id });
  }

  function ret(nonce: string, query: string) {
    return request(app).get(`/integrations/google/return/${nonce}?${query}`);
  }

  beforeEach(async () => {
    await withCustomer();
    vi.mocked(client.listCustomerConnections).mockResolvedValue({
      connections: [connection()],
    });
  });

  it('claims the connection and sends the browser back to the dashboard', async () => {
    const nonce = await nonceFor();

    const res = await ret(nonce, 'status=ok&tool=google_sheets&connection_id=conn_1');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${RETURN_TO}?connected=google_sheets`);
    const mapped = await prisma.workspaceResource.findUnique({
      where: { kind_externalId: { kind: 'CONNECTION', externalId: 'conn_1' } },
    });
    expect(mapped?.workspaceId).toBe(workspace.id);
    expect(mapped?.name).toBe('ops@acme.test');
  });

  /**
   * The success redirect carries `tool=<slug>` on an unauthenticated query
   * string. What the dashboard announces must come from the nonce this
   * service minted, never from that parameter.
   */
  it('announces the tool the nonce was minted for, not the one the query names', async () => {
    const nonce = await nonceFor('google_sheets');

    const res = await ret(nonce, 'status=ok&tool=gmail&connection_id=conn_1');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${RETURN_TO}?connected=google_sheets`);
  });

  /** The nonce is the whole of the authentication here, so a replay must not
   *  be a second claim — and the honest thing to tell the second arrival is
   *  that its link is spent. */
  it('is single use: replaying the same link reports it expired', async () => {
    const nonce = await nonceFor();
    await ret(nonce, 'status=ok&connection_id=conn_1');

    const replay = await ret(nonce, 'status=ok&connection_id=conn_1');

    expect(replay.headers.location).toBe(`${RETURN_TO}?error=expired`);
  });

  it('reports an unknown nonce as expired without asking upstream anything', async () => {
    const res = await ret('not-a-nonce', 'status=ok&connection_id=conn_1');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${RETURN_TO}?error=expired`);
    expect(client.listCustomerConnections).not.toHaveBeenCalled();
    expect(await prisma.workspaceResource.count()).toBe(0);
  });

  /**
   * The platform's failure redirect carries `error` and NO `status`, so
   * "anything that is not ok" is the branch — not "status says error".
   */
  it('reports a refused consent as denied', async () => {
    const nonce = await nonceFor();

    const res = await ret(nonce, 'error=oauth_denied');

    expect(res.headers.location).toBe(`${RETURN_TO}?error=denied`);
    expect(await prisma.workspaceResource.count()).toBe(0);
  });

  it('reports any other platform failure as failed', async () => {
    const nonce = await nonceFor();

    const res = await ret(nonce, 'error=connection_failed');

    expect(res.headers.location).toBe(`${RETURN_TO}?error=failed`);
  });

  /**
   * Dead ends that retrying will not fix: the connector is switched off on the
   * platform (`tool_not_available`, sent with `status=error` before OAuth
   * starts) or the workspace's customer is archived there (`customer_archived`,
   * sent both before OAuth with `status=error` and after it with no status).
   * "Something went wrong, try again" would send the admin round the same loop.
   */
  it.each([
    'status=error&error=tool_not_available',
    'status=error&error=customer_archived',
    'error=customer_archived',
  ])('reports %s as unavailable', async (query) => {
    const nonce = await nonceFor();

    const res = await ret(nonce, query);

    expect(res.headers.location).toBe(`${RETURN_TO}?error=unavailable`);
    expect(await prisma.workspaceResource.count()).toBe(0);
  });

  /** `oauth_denied` is the one code the platform sends for a refusal. A
   *  lookalike that it never sends is a fault, not a decision, and must not
   *  tell an admin they cancelled something they did not. */
  it('does not read a denial code the platform never sends as a refusal', async () => {
    const nonce = await nonceFor();

    const res = await ret(nonce, 'error=access_denied');

    expect(res.headers.location).toBe(`${RETURN_TO}?error=failed`);
  });

  /**
   * The isolation check, and the reason the customer exists at all: the
   * platform named a connection, and only its own listing for THIS workspace's
   * customer can say whether it is theirs.
   */
  it('refuses a connection the workspace customer does not hold', async () => {
    const nonce = await nonceFor();
    vi.mocked(client.listCustomerConnections).mockResolvedValue({
      connections: [connection({ id: 'conn_somebody_else' })],
    });

    const res = await ret(nonce, 'status=ok&connection_id=conn_1');

    expect(res.headers.location).toBe(`${RETURN_TO}?error=not_ours`);
    expect(await prisma.workspaceResource.count()).toBe(0);
  });

  /**
   * The nonce says which tool the admin set out to connect; the platform's
   * listing says which tool the named connection is for. When they disagree
   * the row is real and held, but it is not what the dashboard is about to
   * report as connected — so nothing is claimed and nothing is announced.
   */
  it('claims nothing when the held connection is for a different tool', async () => {
    const nonce = await nonceFor('google_sheets');
    vi.mocked(client.listCustomerConnections).mockResolvedValue({
      connections: [connection({ id: 'conn_1', tool_slug: 'google_calendar' })],
    });

    const res = await ret(nonce, 'status=ok&tool=google_sheets&connection_id=conn_1');

    expect(res.headers.location).toBe(`${RETURN_TO}?error=failed`);
    expect(await prisma.workspaceResource.count()).toBe(0);
  });

  /** A success case on purpose: a `failed` expectation could not tell "read
   *  the camel-cased key" from "read no key at all", since both miss the
   *  slug. If the listing ever ships camelCase only, dropping the key would
   *  turn every good connect into `failed`, and this is the case that sees it. */
  it('reads the tool off a camel-cased listing row too', async () => {
    const nonce = await nonceFor('google_sheets');
    vi.mocked(client.listCustomerConnections).mockResolvedValue({
      connections: [
        { id: 'conn_1', toolSlug: 'google_sheets', status: 'ACTIVE', providerEmail: 'ops@acme.test' },
      ],
    });

    const res = await ret(nonce, 'status=ok&connection_id=conn_1');

    expect(res.headers.location).toBe(`${RETURN_TO}?connected=google_sheets`);
    expect(await prisma.workspaceResource.count()).toBe(1);
  });

  it('refuses a success that names no connection at all', async () => {
    const nonce = await nonceFor();

    const res = await ret(nonce, 'status=ok');

    expect(res.headers.location).toBe(`${RETURN_TO}?error=failed`);
    expect(client.listCustomerConnections).not.toHaveBeenCalled();
  });

  it('leaves a connection another workspace holds exactly where it is', async () => {
    const nonce = await nonceFor();
    const theirs = await makeWorkspace(await makeAccount('bob'), 'Bob Co');
    await mapResource('CONNECTION', 'conn_1', theirs.id);

    const res = await ret(nonce, 'status=ok&connection_id=conn_1');

    expect(res.headers.location).toBe(`${RETURN_TO}?error=not_ours`);
    const mapped = await prisma.workspaceResource.findUnique({
      where: { kind_externalId: { kind: 'CONNECTION', externalId: 'conn_1' } },
    });
    expect(mapped?.workspaceId).toBe(theirs.id);
  });

  /** Claiming twice is the ordinary shape of a reconciled listing followed by
   *  a slow return leg, and it is not a failure. */
  it('treats a connection this workspace already holds as connected', async () => {
    const nonce = await nonceFor();
    await mapResource('CONNECTION', 'conn_1', workspace.id);

    const res = await ret(nonce, 'status=ok&connection_id=conn_1');

    expect(res.headers.location).toBe(`${RETURN_TO}?connected=google_sheets`);
  });

  it('reports an upstream that cannot be read as failed, not as connected', async () => {
    const nonce = await nonceFor();
    const { ApiError } = await import('../src/lib/errors.js');
    vi.mocked(client.listCustomerConnections).mockRejectedValue(
      new ApiError(502, 'UPSTREAM_ERROR', 'down'),
    );

    const res = await ret(nonce, 'status=ok&connection_id=conn_1');

    expect(res.headers.location).toBe(`${RETURN_TO}?error=failed`);
    expect(await prisma.workspaceResource.count()).toBe(0);
  });

  /** The workspace was deleted while the admin was on the consent screen. */
  it('reports a workspace that has gone as failed', async () => {
    const nonce = await nonceFor();
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { deletedAt: new Date() },
    });

    const res = await ret(nonce, 'status=ok&connection_id=conn_1');

    expect(res.headers.location).toBe(`${RETURN_TO}?error=failed`);
    expect(await prisma.workspaceResource.count()).toBe(0);
  });

  it('needs no session of its own', async () => {
    const nonce = await nonceFor();

    // No identity header at all — the nonce is the authentication.
    const res = await ret(nonce, 'status=ok&connection_id=conn_1');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${RETURN_TO}?connected=google_sheets`);
  });
});

describe('DELETE /:workspaceId/integrations/connections/:connectionId', () => {
  function disconnect(id = 'conn_1', who: [string, string] = ['user_alice', 'alice@ezo.test']) {
    return request(app)
      .delete(`/api/workspaces/${workspace.id}/integrations/connections/${id}`)
      .set(...as(...who));
  }

  beforeEach(async () => {
    await withCustomer();
    await mapResource('CONNECTION', 'conn_1', workspace.id);
    vi.mocked(client.deleteCustomerConnection).mockResolvedValue(undefined);
  });

  it('refuses a member', async () => {
    const bob = await makeAccount('bob');
    await addMember(workspace, bob, 'MEMBER');

    const res = await disconnect('conn_1', ['user_bob', 'bob@ezo.test']);

    expect(res.status).toBe(403);
    expect(client.deleteCustomerConnection).not.toHaveBeenCalled();
  });

  it('revokes upstream and drops the mapping', async () => {
    const res = await disconnect();

    expect(res.status).toBe(204);
    expect(client.deleteCustomerConnection).toHaveBeenCalledWith('pcus_1', 'conn_1');
    expect(
      await prisma.workspaceResource.findUnique({
        where: { kind_externalId: { kind: 'CONNECTION', externalId: 'conn_1' } },
      }),
    ).toBeNull();
  });

  /** Ownership is proven before anything is revoked, so one workspace cannot
   *  disconnect another's Google account by guessing an id. */
  it('will not touch another workspace\'s connection', async () => {
    const theirs = await makeWorkspace(await makeAccount('bob'), 'Bob Co');
    await mapResource('CONNECTION', 'conn_theirs', theirs.id);

    const res = await disconnect('conn_theirs');

    expect(res.status).toBe(404);
    expect(client.deleteCustomerConnection).not.toHaveBeenCalled();
    const mapped = await prisma.workspaceResource.findUnique({
      where: { kind_externalId: { kind: 'CONNECTION', externalId: 'conn_theirs' } },
    });
    expect(mapped?.workspaceId).toBe(theirs.id);
  });

  it('answers a connection nobody holds the same way', async () => {
    const res = await disconnect('conn_nowhere');

    expect(res.status).toBe(404);
    expect(client.deleteCustomerConnection).not.toHaveBeenCalled();
  });

  /** Already revoked upstream: the mapping still has to go, or it holds the
   *  unique slot for something that does not exist. */
  it('drops the mapping for a connection the platform has already let go', async () => {
    const { ApiError } = await import('../src/lib/errors.js');
    vi.mocked(client.deleteCustomerConnection).mockRejectedValue(
      new ApiError(404, 'RESOURCE_NOT_FOUND', 'Not found.'),
    );

    const res = await disconnect();

    expect(res.status).toBe(204);
    expect(
      await prisma.workspaceResource.findUnique({
        where: { kind_externalId: { kind: 'CONNECTION', externalId: 'conn_1' } },
      }),
    ).toBeNull();
  });

  /** An upstream that is merely down must not leave a live Google connection
   *  mapped to nobody: unmapping first and failing the revoke would make it
   *  invisible to every workspace and revocable by none. */
  it('keeps the mapping when the revoke fails', async () => {
    const { ApiError } = await import('../src/lib/errors.js');
    vi.mocked(client.deleteCustomerConnection).mockRejectedValue(
      new ApiError(502, 'UPSTREAM_ERROR', 'down'),
    );

    const res = await disconnect();

    expect(res.status).toBe(502);
    expect(
      await prisma.workspaceResource.findUnique({
        where: { kind_externalId: { kind: 'CONNECTION', externalId: 'conn_1' } },
      }),
    ).not.toBeNull();
  });

  /**
   * A connection mapped by staff under the older flow has no customer behind
   * it, so there is nothing this surface can revoke — and unmapping alone
   * would tell an admin their Google access was withdrawn while the token
   * went on working.
   */
  it('refuses a connection that was not minted through this flow', async () => {
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { partnerCustomerId: null },
    });

    const res = await disconnect();

    expect(res.status).toBe(404);
    expect(client.deleteCustomerConnection).not.toHaveBeenCalled();
    expect(
      await prisma.workspaceResource.findUnique({
        where: { kind_externalId: { kind: 'CONNECTION', externalId: 'conn_1' } },
      }),
    ).not.toBeNull();
  });
});
