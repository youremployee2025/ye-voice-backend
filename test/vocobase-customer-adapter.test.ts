import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The partner-customer and connection surface of the adapter.
 *
 * `fetch` is stubbed rather than the module mocked, for the reason the wallet
 * suite beside this one gives: what is under test is the request that goes out
 * and how an upstream status comes back, neither of which a mocked module has.
 *
 * The key and base URL are assigned before the client is imported. `env` is
 * read once at module load, so a value set in a `beforeEach` would never be
 * seen and every call here would fail as "not configured".
 */
process.env.VOCOBASE_API_KEY = 'rg_live_testkey';
process.env.VOCOBASE_API_URL = 'https://voice.test/api/v2';

const { ApiError } = await import('../src/lib/errors.js');
const {
  createConnectLink,
  createPartnerCustomer,
  deleteCustomerConnection,
  listConnectors,
  listCustomerConnections,
} = await import('../src/adapter/vocobase.js');

function respond(status: number, payload: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () =>
    status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify(payload), { status }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sent(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  const [url, init] = fetchMock.mock.calls[call] as unknown as [string, RequestInit];
  return {
    url,
    method: init.method,
    body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createPartnerCustomer', () => {
  it('posts the workspace id as external_id and returns the customer', async () => {
    const fetchMock = respond(200, {
      success: true,
      data: { id: 'pcus_1', external_id: 'ws_1', name: 'Acme', status: 'ACTIVE' },
    });

    await expect(createPartnerCustomer({ external_id: 'ws_1', name: 'Acme' })).resolves.toMatchObject(
      { id: 'pcus_1', external_id: 'ws_1' },
    );

    expect(sent(fetchMock)).toMatchObject({
      url: 'https://voice.test/api/v2/customers',
      method: 'POST',
      body: { external_id: 'ws_1', name: 'Acme' },
    });
  });

  /**
   * The create is idempotent upstream on `external_id`, which is the whole
   * reason `ensurePartnerCustomer` may retry a lost response. The adapter must
   * not turn the second answer into a conflict.
   */
  it('returns the same customer when upstream de-duplicates on external_id', async () => {
    respond(200, {
      success: true,
      data: { id: 'pcus_1', external_id: 'ws_1', name: 'Acme', status: 'ACTIVE' },
    });

    await expect(createPartnerCustomer({ external_id: 'ws_1', name: 'Acme' })).resolves.toMatchObject(
      { id: 'pcus_1' },
    );
  });

  it('reports a lost response as an unconfirmed write, not as nothing happened', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    );

    const err = await createPartnerCustomer({ external_id: 'ws_1', name: 'Acme' }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).code).toBe('UPSTREAM_WRITE_UNCONFIRMED');
  });
});

describe('createConnectLink', () => {
  it('posts the slug and redirect and returns the hosted URL', async () => {
    const fetchMock = respond(200, {
      success: true,
      data: { url: 'https://voice.test/connect/tok', expires_at: '2026-09-21T12:15:00.000Z' },
    });

    await expect(
      createConnectLink('pcus_1', {
        tool_slug: 'google_sheets',
        redirect_uri: 'https://api.ezo.test/integrations/google/return/n1',
      }),
    ).resolves.toEqual({
      url: 'https://voice.test/connect/tok',
      expires_at: '2026-09-21T12:15:00.000Z',
    });

    expect(sent(fetchMock)).toMatchObject({
      url: 'https://voice.test/api/v2/customers/pcus_1/connect-link',
      method: 'POST',
      body: {
        tool_slug: 'google_sheets',
        redirect_uri: 'https://api.ezo.test/integrations/google/return/n1',
      },
    });
  });

  /** Omitted rather than sent as null: upstream substitutes its own default,
   *  and a null would be a validation failure rather than "use the default". */
  it('leaves expires_in_seconds out when the caller did not choose one', async () => {
    const fetchMock = respond(200, { success: true, data: { url: 'u', expires_at: 'e' } });

    await createConnectLink('pcus_1', { tool_slug: 'gmail', redirect_uri: 'https://a.test/r' });

    expect(Object.keys(sent(fetchMock).body)).toEqual(['tool_slug', 'redirect_uri']);
  });

  it('sends expires_in_seconds when it is given', async () => {
    const fetchMock = respond(200, { success: true, data: { url: 'u', expires_at: 'e' } });

    await createConnectLink('pcus_1', {
      tool_slug: 'gmail',
      redirect_uri: 'https://a.test/r',
      expires_in_seconds: 900,
    });

    expect(sent(fetchMock).body).toMatchObject({ expires_in_seconds: 900 });
  });

  /**
   * The connect-link failures are the one place upstream's own code is the
   * answer: `INVALID_REDIRECT_URI` means an ops step was skipped in this
   * environment, and flattened to `VALIDATION_ERROR` it reads as a bad request
   * from the customer — who has nothing to fix.
   */
  it("passes the platform's own code through for a redirect host that is not allow-listed", async () => {
    respond(400, {
      success: false,
      error: {
        code: 'INVALID_REDIRECT_URI',
        message: 'redirect_uri host "api.ezo.test" not in allowed_redirect_hosts',
      },
    });

    const err = await createConnectLink('pcus_1', {
      tool_slug: 'gmail',
      redirect_uri: 'https://api.ezo.test/r',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(400);
    expect((err as InstanceType<typeof ApiError>).code).toBe('INVALID_REDIRECT_URI');
  });

  it.each(['TOOL_NOT_FOUND', 'TOOL_INACTIVE', 'CUSTOMER_ARCHIVED', 'PARTNER_MISMATCH'])(
    'passes %s through as well',
    async (code) => {
      respond(400, { success: false, error: { code, message: 'no' } });

      const err = await createConnectLink('pcus_1', {
        tool_slug: 'gmail',
        redirect_uri: 'https://a.test/r',
      }).catch((e: unknown) => e);

      expect((err as InstanceType<typeof ApiError>).code).toBe(code);
    },
  );

  /** An allow-list, not a blanket pass-through: a 400 upstream adds later must
   *  still reach the caller as the mapped validation failure. */
  it('still maps an unlisted 400 through the usual validation mapping', async () => {
    respond(400, {
      success: false,
      error: { code: 'SOMETHING_NEW', message: 'tool_slug is required' },
    });

    const err = await createConnectLink('pcus_1', {
      tool_slug: '',
      redirect_uri: 'https://a.test/r',
    }).catch((e: unknown) => e);

    expect((err as InstanceType<typeof ApiError>).code).toBe('VALIDATION_ERROR');
  });
});

describe('listCustomerConnections', () => {
  it('unwraps the connection list', async () => {
    const fetchMock = respond(200, {
      success: true,
      data: {
        connections: [
          {
            id: 'conn_1',
            tool_slug: 'google_sheets',
            tool_name: 'Google Sheets',
            status: 'ACTIVE',
            provider_email: 'ops@acme.test',
            created_at: '2026-09-21T10:00:00.000Z',
          },
        ],
      },
    });

    const { connections } = await listCustomerConnections('pcus_1');

    expect(connections).toHaveLength(1);
    expect(connections?.[0]).toMatchObject({ id: 'conn_1', provider_email: 'ops@acme.test' });
    expect(sent(fetchMock)).toMatchObject({
      url: 'https://voice.test/api/v2/customers/pcus_1/connections',
      method: 'GET',
    });
  });

  it('encodes the customer id into the path', async () => {
    const fetchMock = respond(200, { success: true, data: { connections: [] } });

    await listCustomerConnections('a/b?c');

    expect(sent(fetchMock).url).toBe('https://voice.test/api/v2/customers/a%2Fb%3Fc/connections');
  });
});

describe('deleteCustomerConnection', () => {
  it('sends the revoke and accepts the empty 204', async () => {
    const fetchMock = respond(204, null);

    await expect(deleteCustomerConnection('pcus_1', 'conn_1')).resolves.toBeUndefined();
    expect(sent(fetchMock)).toMatchObject({
      url: 'https://voice.test/api/v2/customers/pcus_1/connections/conn_1',
      method: 'DELETE',
    });
  });

  /** Surfaced as a 404 rather than a 502 so the route can drop a mapping that
   *  points at a connection the platform has already let go. */
  it('reports a connection that is already gone as a 404', async () => {
    respond(404, {
      success: false,
      error: { code: 'CONNECTION_NOT_FOUND', message: 'Connection not found' },
    });

    const err = await deleteCustomerConnection('pcus_1', 'conn_1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(404);
  });
});

describe('listConnectors', () => {
  it('unwraps the catalogue', async () => {
    const fetchMock = respond(200, {
      success: true,
      data: {
        connectors: [
          { id: 't1', slug: 'google_sheets', name: 'Google Sheets', status: 'ACTIVE' },
          { id: 't2', slug: 'gmail', name: 'Gmail', status: 'ACTIVE' },
        ],
      },
    });

    const { connectors } = await listConnectors();

    expect(connectors?.map((row) => row.slug)).toEqual(['google_sheets', 'gmail']);
    expect(sent(fetchMock)).toMatchObject({
      url: 'https://voice.test/api/v2/connectors',
      method: 'GET',
    });
  });
});
