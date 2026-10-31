import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiError } from '../src/lib/errors.js';

/**
 * The client is imported fresh in each test so it reads whatever the test put
 * in the environment. `fetch` is stubbed throughout — nothing here may reach
 * the real partner API.
 *
 * `ApiError` comes from the same reset module registry as the client, since a
 * class imported across a registry reset is a different identity and would
 * fail every instanceof check.
 */
async function loadClient() {
  vi.resetModules();
  const [client, errors] = await Promise.all([
    import('../src/adapter/vocobase.js'),
    import('../src/lib/errors.js'),
  ]);
  return { ...client, ApiError: errors.ApiError };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const originalKey = process.env.VOCOBASE_API_KEY;
const originalUrl = process.env.VOCOBASE_API_URL;
const originalConnectionId = process.env.VOCOBASE_VOICELINK_CONNECTION_ID;

beforeEach(() => {
  process.env.VOCOBASE_API_KEY = 'test-key';
  process.env.VOCOBASE_API_URL = 'https://voice.test/api/v2';
  // Pinned like the two above: the developer's .env may name a real
  // connection, and the default-shape assertions must not depend on it.
  // Emptied rather than deleted — dotenv refills a deleted variable from
  // .env on the module reload `loadClient` performs, but never overrides one
  // that is set.
  process.env.VOCOBASE_VOICELINK_CONNECTION_ID = '';
  // The client logs upstream detail on purpose; the failure paths under test
  // would otherwise fill the run with expected noise.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env.VOCOBASE_API_KEY = originalKey;
  process.env.VOCOBASE_API_URL = originalUrl;
  if (originalConnectionId === undefined) delete process.env.VOCOBASE_VOICELINK_CONNECTION_ID;
  else process.env.VOCOBASE_VOICELINK_CONNECTION_ID = originalConnectionId;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('vocobase client', () => {
  it('unwraps the success envelope and returns the payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ success: true, data: { agents: [{ id: 'a1' }], total: 1 } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { listAgents } = await loadClient();
    const result = await listAgents({ limit: 100, offset: 0 });

    expect(result.agents).toEqual([{ id: 'a1' }]);
    expect(result.total).toBe(1);
  });

  it('sends the api key as a bearer token against the configured base url', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { agents: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    const { listAgents } = await loadClient();
    await listAgents({ limit: 50, offset: 25 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://voice.test/api/v2/agent/all?limit=50&offset=25');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
  });

  it('percent-encodes the agent id into the path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: {} }));
    vi.stubGlobal('fetch', fetchMock);

    const { getAgentTools } = await loadClient();
    await getAgentTools('a/b c');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://voice.test/api/v2/agent/a%2Fb%20c/tools');
  });

  it('keeps an upstream 404 a 404, rather than reporting an outage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ success: false, error: { code: 'NOT_FOUND', message: 'No such agent' } }, 404),
      ),
    );

    const { getAgent, ApiError } = await loadClient();
    const error = await getAgent('missing').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    // A resource that is already gone is not a platform failure. Reporting it
    // as 502 made a double-clicked delete read as a fault and left the caller
    // unable to clean up the local row pointing at it.
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).code).toBe('RESOURCE_NOT_FOUND');
    // Upstream's own wording is not repeated on a 404: whether that id names
    // something real is the fact isolation withholds.
    expect((error as ApiError).message).toBe('Not found.');
  });

  it('turns any other failure envelope into a 502 UPSTREAM_ERROR', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ success: false, error: { code: 'BAD_GATEWAY', message: 'upstream down' } }, 502),
      ),
    );

    const { getAgent, ApiError } = await loadClient();
    const error = await getAgent('x').catch((e: unknown) => e);

    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).code).toBe('UPSTREAM_ERROR');
  });

  it('turns a non-JSON error response into a 502 UPSTREAM_ERROR', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>gateway</html>', { status: 502 })),
    );

    const { listVoices, ApiError } = await loadClient();
    const error = await listVoices().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
  });

  it('turns a network failure into a 502 UPSTREAM_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const { listAgents, ApiError } = await loadClient();
    const error = await listAgents({ limit: 10, offset: 0 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).code).toBe('UPSTREAM_ERROR');
  });

  it('masks the api key in what it logs about an upstream failure', async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          { success: false, error: { message: 'bad key rg_live_abc123XYZ' } },
          401,
        ),
      ),
    );

    const { listAgents } = await loadClient();
    await listAgents({ limit: 10, offset: 0 }).catch(() => undefined);

    const text = JSON.stringify(logged);
    expect(text).not.toContain('rg_live_abc123XYZ');
    expect(text).toContain('rg_live_***');
  });

  /**
   * The property is "our key never reaches a log", not "strings shaped like
   * `rg_live_*` never do". Planting an unrelated token tested the regex; the
   * configured key is what actually has to survive rotation to a new prefix.
   */
  it('masks the configured key whatever prefix it was issued with', async () => {
    process.env.VOCOBASE_API_KEY = 'sk-partner-9f3a-NOT-THE-USUAL-PREFIX';

    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            success: false,
            error: { message: 'invalid credential sk-partner-9f3a-NOT-THE-USUAL-PREFIX' },
          },
          401,
        ),
      ),
    );

    const { listAgents } = await loadClient();
    await listAgents({ limit: 10, offset: 0 }).catch(() => undefined);

    expect(JSON.stringify(logged)).not.toContain('sk-partner-9f3a-NOT-THE-USUAL-PREFIX');
  });

  it('never leaks the upstream message to the caller', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ success: false, error: { code: 'X', message: 'partner key rg_live_secret' } }, 401),
      ),
    );

    const { listAgents } = await loadClient();
    const error = (await listAgents({ limit: 10, offset: 0 }).catch((e: unknown) => e)) as ApiError;

    expect(error.message).not.toContain('rg_live_secret');
  });

  it('fails without reaching the network when no api key is configured', async () => {
    process.env.VOCOBASE_API_KEY = '';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { listAgents, ApiError } = await loadClient();
    const error = await listAgents({ limit: 10, offset: 0 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('UPSTREAM_ERROR');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the sub-resource collections each endpoint returns', async () => {
    const bodies: Record<string, unknown> = {
      '/agent/a1/documents': { documents: [{ id: 'd1' }], total: 1 },
      '/agent/a1/functions': { functions: [{ id: 'f1' }] },
      '/agent/a1/tools': { tools: [{ toolSlug: 'google_sheets', enabled: false }] },
      '/agent/voices': { voices: [{ id: 'v1', display_name: 'Anisha' }] },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const path = url.replace('https://voice.test/api/v2', '');
        return Promise.resolve(jsonResponse({ success: true, data: bodies[path] }));
      }),
    );

    const { getAgentDocuments, getAgentFunctions, getAgentTools, listVoices } = await loadClient();

    expect((await getAgentDocuments('a1')).documents).toEqual([{ id: 'd1' }]);
    expect((await getAgentFunctions('a1')).functions).toEqual([{ id: 'f1' }]);
    expect((await getAgentTools('a1')).tools).toEqual([{ toolSlug: 'google_sheets', enabled: false }]);
    expect((await listVoices()).voices).toEqual([{ id: 'v1', display_name: 'Anisha' }]);
  });
});

describe('the tier catalogue', () => {
  /**
   * The base URL already ends in `/api/v2`, and every other path in the client
   * is relative to it. This one was written absolute, so the request went to
   * `/api/v2/api/v2/phone-numbers/…`, upstream answered 404, and `absentOn404`
   * — there for a row that is genuinely gone — read that as success. Every
   * inbound release "succeeded" while the number stayed bound to the agent.
   */
  it('unbinds a phone number at the same base every other call uses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: {} }));
    vi.stubGlobal('fetch', fetchMock);

    const { clearPhoneNumberAgent } = await loadClient();
    await clearPhoneNumberAgent('pn-1');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://voice.test/api/v2/phone-numbers/pn-1');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('PUT');
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({ agent_id: null });
  });

  it('reads the tiers this partner account may sell', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        data: { tiers: [{ tier: 'va-1', label: 'VA 1' }, { tier: 'va-1-pro', label: 'VA 1 Pro' }] },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { listVoiceTiers } = await loadClient();
    const result = await listVoiceTiers();

    expect(result.tiers).toEqual([
      { tier: 'va-1', label: 'VA 1' },
      { tier: 'va-1-pro', label: 'VA 1 Pro' },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://voice.test/api/v2/agent/voice-tiers');
  });

  /**
   * The parameter exists and is exercised, but the voices route does not use
   * it: an account holding three tiers would spend three upstream requests to
   * assemble a list one request already contains, against a rate limit every
   * workspace on the platform shares. Kept because the day a tier's catalogue
   * is too large to filter locally, this is the seam.
   */
  it('can narrow the voice catalogue to one tier, and sends no filter without one', async () => {
    // A fresh Response per call: a body may only be read once, so a single
    // resolved value makes the second call look like an unreadable answer.
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ success: true, data: { voices: [] } })),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { listVoices } = await loadClient();

    await listVoices({ tier: 'va-1-pro' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://voice.test/api/v2/agent/voices?tier=va-1-pro',
    );

    await listVoices();
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://voice.test/api/v2/agent/voices');
  });
});

describe('vocobase client writes', () => {
  it('sends a JSON body and content type on a create', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { id: 'a1' } }, 201));
    vi.stubGlobal('fetch', fetchMock);

    const { createAgent } = await loadClient();
    const created = await createAgent({ agent_name: 'Reception', prompt: 'hi' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://voice.test/api/v2/agent');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ agent_name: 'Reception', prompt: 'hi' });
    expect(created).toEqual({ id: 'a1' });
  });

  it('sends only the supplied fields on an update', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { id: 'a1' } }));
    vi.stubGlobal('fetch', fetchMock);

    const { updateAgent } = await loadClient();
    await updateAgent('a1', { prompt: 'new' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://voice.test/api/v2/agent/a1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ prompt: 'new' });
  });

  /** The calls that put the managed callback key on a campaign's agent. */
  it('creates an extraction set with the keys it was given', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ success: true, data: { id: 'set_1' } }, 201));
    vi.stubGlobal('fetch', fetchMock);

    const { createExtractionSet } = await loadClient();
    await createExtractionSet({
      name: 'Campaign callbacks',
      keys: [{ name: 'callback_requested_at', type: 'datetime' }],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://voice.test/api/v2/extraction-sets');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string).keys).toEqual([
      { name: 'callback_requested_at', type: 'datetime' },
    ]);
  });

  it('reads the sets an agent already carries', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ success: true, data: { extraction_sets: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    const { listAgentExtractionSets } = await loadClient();
    await listAgentExtractionSets('a 1');

    // The id is encoded, as everywhere else this client builds a path.
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'https://voice.test/api/v2/agent/a%201/extraction-sets',
    );
  });

  /** Attaching is idempotent upstream: 201 for a new attachment, 200 when it
   *  was already there. Both are a success envelope, so neither is special. */
  it.each([200, 201])('treats a %i on attach as done', async (status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ success: true, data: { attached: true } }, status));
    vi.stubGlobal('fetch', fetchMock);

    const { attachAgentExtractionSet } = await loadClient();

    await expect(attachAgentExtractionSet('a1', 'set_1')).resolves.toEqual({ attached: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://voice.test/api/v2/agent/a1/extraction-sets/set_1');
    expect(init.method).toBe('POST');
  });

  it('resolves a 204 with no body rather than failing to parse it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const { detachFunction } = await loadClient();

    await expect(detachFunction('a1', 'f1')).resolves.toBeUndefined();
  });

  it('surfaces an upstream validation message so the caller learns what to fix', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'prompt must be 120000 characters or fewer' },
        },
        400,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { updateAgent, ApiError } = await loadClient();
    const error = await updateAgent('a1', { prompt: 'x' }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).code).toBe('VALIDATION_ERROR');
    expect((error as ApiError).message).toBe('prompt must be 120000 characters or fewer');
  });

  it('redacts the partner key out of a validation message before returning it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        { success: false, error: { code: 'VALIDATION_ERROR', message: 'bad key test-key supplied' } },
        400,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { updateAgent } = await loadClient();
    const error = await updateAgent('a1', { prompt: 'x' }).catch((err: unknown) => err);

    expect((error as ApiError).message).not.toContain('test-key');
    expect((error as ApiError).message).toContain('***');
  });

  it('reports a name collision without confirming what it collided with', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ success: false, error: { code: 'CONFLICT', message: 'name taken' } }, 409),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { createAgent, ApiError } = await loadClient();
    const error = await createAgent({ agent_name: 'Reception' }).catch((err: unknown) => err);

    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).code).toBe('NAME_TAKEN');
    // The colliding agent is very often another workspace's, invisible by
    // every other route. Saying "an agent with that name already exists" made
    // create a name-enumeration oracle over the whole partner account — and
    // was simply wrong on the dictionary and function paths, which share this
    // code and are not agents at all.
    expect((error as ApiError).message).not.toMatch(/agent/i);
    expect((error as ApiError).message).not.toMatch(/exists/i);
  });

  it('strips identifiers out of an upstream validation message before repeating it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            success: false,
            error: {
              code: 'VALIDATION',
              message: 'document doc_9fa3bc21x is already linked to agent agt_77kkzz01',
            },
          },
          400,
        ),
      ),
    );

    const { getAgent, ApiError } = await loadClient();
    const error = await getAgent('x').catch((err: unknown) => err);

    // The 400 passthrough exists so a caller learns what to fix. It must not
    // also read out entity ids belonging to workspaces they cannot see.
    expect((error as ApiError).message).not.toContain('doc_9fa3bc21x');
    expect((error as ApiError).message).not.toContain('agt_77kkzz01');
    expect((error as ApiError).message).toContain('already linked');
  });

  it('keeps the generic message for a server-side upstream failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ success: false, error: { code: 'INTERNAL_ERROR', message: 'stack trace' } }, 500),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { updateAgent, ApiError } = await loadClient();
    const error = await updateAgent('a1', { prompt: 'x' }).catch((err: unknown) => err);

    expect((error as ApiError).code).toBe('UPSTREAM_ERROR');
    expect((error as ApiError).message).not.toContain('stack trace');
  });

  it('never sends the partner key to the storage host on a presigned upload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { putToPresignedUrl } = await loadClient();
    await putToPresignedUrl('https://storage.test/put?sig=1', Buffer.from('hi'), 'text/plain');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://storage.test/put?sig=1');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe('listPurchasedDids', () => {
  it('peels the doubly-nested purchased-DID envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          success: true,
          data: {
            status: true,
            message: 'Success',
            data: { data: [{ id: 1 }, { id: 2 }], current_page: 1, per_page: 200, last_page: 2 },
          },
        }),
      ),
    );

    const { listPurchasedDids } = await loadClient();
    const page = await listPurchasedDids({ page: 1, perPage: 200 });

    expect(page.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(page.lastPage).toBe(2);
  });

  it('sends page and per_page on the query string, and no connection id by default', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ success: true, data: { data: { data: [] } } }));
    vi.stubGlobal('fetch', fetchMock);

    const { listPurchasedDids } = await loadClient();
    await listPurchasedDids({ page: 3, perPage: 200 });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://voice.test/api/v2/voicelink/dids/purchased?page=3&per_page=200');
  });

  /**
   * A partner holding several VoiceLink connections has to name the one this
   * inventory mirrors — upstream refuses to guess between them, and the sync
   * would fail on an account that grew a second connection.
   */
  it('names the configured connection when the partner holds more than one', async () => {
    process.env.VOCOBASE_VOICELINK_CONNECTION_ID = 'conn-1234';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ success: true, data: { data: { data: [] } } }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const { listPurchasedDids } = await loadClient();
      await listPurchasedDids({ page: 1, perPage: 200 });

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe(
        'https://voice.test/api/v2/voicelink/dids/purchased?page=1&per_page=200&connection_id=conn-1234',
      );
    } finally {
      delete process.env.VOCOBASE_VOICELINK_CONNECTION_ID;
    }
  });

});

/**
 * The same rule the DID listing above follows, on the two endpoints that were
 * left out of it.
 *
 * Upstream documents `connection_id` as required once a partner holds more
 * than one active VoiceLink connection — `/calls/start` answers
 * `CONNECTION_AMBIGUOUS` without it, and `/voicelink/call-ready` refuses in
 * the same terms. Both are on the dialing path, so an account that grows a
 * second connection stops being able to start a campaign or place a call
 * while the DID mirror carries on working.
 */
describe('naming the VoiceLink connection on the dialing path', () => {
  it('call-ready sends the DID alone when only one connection exists', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { ready: true } }));
    vi.stubGlobal('fetch', fetchMock);

    const { voicelinkCallReady } = await loadClient();
    await voicelinkCallReady('+919228130271');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://voice.test/api/v2/voicelink/call-ready');
    expect(JSON.parse(String(init.body))).toEqual({ did_number: '+919228130271' });
  });

  it('call-ready names the configured connection when the partner holds more than one', async () => {
    process.env.VOCOBASE_VOICELINK_CONNECTION_ID = 'conn-1234';
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { ready: true } }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const { voicelinkCallReady } = await loadClient();
      await voicelinkCallReady('+919228130271');

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({
        did_number: '+919228130271',
        connection_id: 'conn-1234',
      });
    } finally {
      delete process.env.VOCOBASE_VOICELINK_CONNECTION_ID;
    }
  });

  /**
   * `client_id` stays absent whatever else is added.
   *
   * Naming a client is the one step of this workflow that is not idempotent in
   * a recoverable direction, and this service shares a partner account with
   * other integrators. The connection id comes from the deployment's own
   * environment; a client id would come from whatever a caller supplied.
   */
  it('call-ready never sends a client id', async () => {
    process.env.VOCOBASE_VOICELINK_CONNECTION_ID = 'conn-1234';
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { ready: true } }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const { voicelinkCallReady } = await loadClient();
      await voicelinkCallReady('+919228130271');

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(init.body))).not.toHaveProperty('client_id');
    } finally {
      delete process.env.VOCOBASE_VOICELINK_CONNECTION_ID;
    }
  });

  const START_BODY = {
    agent_id: 'agent-1',
    to_number: '+919000000001',
    provider: 'voicelink',
    from_number: '+919228130271',
    client_reference_id: 'ezo:c1:c2:a3',
    variables: {},
  };

  it('start-call sends the body unchanged when only one connection exists', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { call_id: 'c1' } }));
    vi.stubGlobal('fetch', fetchMock);

    const { startCall } = await loadClient();
    await startCall({ ...START_BODY });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://voice.test/api/v2/calls/start');
    expect(JSON.parse(String(init.body))).toEqual(START_BODY);
  });

  it('start-call names the configured connection when the partner holds more than one', async () => {
    process.env.VOCOBASE_VOICELINK_CONNECTION_ID = 'conn-1234';
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { call_id: 'c1' } }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const { startCall } = await loadClient();
      await startCall({ ...START_BODY });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({
        ...START_BODY,
        connection_id: 'conn-1234',
      });
    } finally {
      delete process.env.VOCOBASE_VOICELINK_CONNECTION_ID;
    }
  });

  /**
   * `client_reference_id` is the platform's per-account idempotency key, so a
   * retry must send the same one. Adding a field to the body must not disturb
   * it.
   */
  it('start-call leaves the idempotency key untouched', async () => {
    process.env.VOCOBASE_VOICELINK_CONNECTION_ID = 'conn-1234';
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { call_id: 'c1' } }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const { startCall } = await loadClient();
      await startCall({ ...START_BODY });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(init.body)).client_reference_id).toBe('ezo:c1:c2:a3');
    } finally {
      delete process.env.VOCOBASE_VOICELINK_CONNECTION_ID;
    }
  });
});

describe('vocobase client, continued', () => {
  it('reports an unrecognised body as no rows rather than throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { status: true } })),
    );

    const { listPurchasedDids } = await loadClient();
    const page = await listPurchasedDids({ page: 1, perPage: 200 });

    expect(page.rows).toEqual([]);
    expect(page.lastPage).toBeNull();
  });

  it('accepts the array directly under data, not only nested twice', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { data: [{ id: 9 }] } })),
    );

    const { listPurchasedDids } = await loadClient();
    expect((await listPurchasedDids({ page: 1, perPage: 200 })).rows).toEqual([{ id: 9 }]);
  });
});

describe('call history client', () => {
  it('unwraps a listing page and passes limit and offset upstream', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        data: { calls: [{ call_id: 'c1' }], total: 41, limit: 100, offset: 200 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { listCalls } = await loadClient();
    const page = await listCalls({ limit: 100, offset: 200 });

    expect(page.calls).toEqual([{ call_id: 'c1' }]);
    expect(page.total).toBe(41);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://voice.test/api/v2/calls?limit=100&offset=200');
  });

  it('fetches one call by id, encoding the id into the path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ success: true, data: { call_id: 'c 1', session: { transcript: [] } } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { getCall } = await loadClient();
    const call = await getCall('c 1');

    expect(call.call_id).toBe('c 1');
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('https://voice.test/api/v2/calls/c%201');
  });

  it('mints a fresh recording url', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ success: true, data: { call_id: 'c1', recording_url: 'https://cdn.test/a.wav' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { getCallRecordingUrl } = await loadClient();
    const minted = await getCallRecordingUrl('c1');

    expect(minted.recording_url).toBe('https://cdn.test/a.wav');
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'https://voice.test/api/v2/calls/c1/recording-url',
    );
  });

  it('passes an upstream 404 on the listing through as RESOURCE_NOT_FOUND', async () => {
    // The shared unwrap passes a 404 through as a fact rather than an outage —
    // the platform-wide rule. getCall opts into the ABSENT sentinel instead,
    // and has its own cases below.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ success: false, error: { code: 'NOT_FOUND', message: 'no' } }, 404),
      ),
    );

    const { listCalls, ApiError } = await loadClient();
    const error = await listCalls({ limit: 100, offset: 0 }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).code).toBe('RESOURCE_NOT_FOUND');
  });

  it('maps a network failure while listing calls to UPSTREAM_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')));

    const { listCalls, ApiError } = await loadClient();
    const error = await listCalls({ limit: 100, offset: 0 }).catch((err: unknown) => err);

    expect((error as ApiError).code).toBe('UPSTREAM_ERROR');
    expect((error as ApiError).message).not.toContain('socket hang up');
  });
});

describe('fetchRecording', () => {
  it('never sends the partner key to the storage host', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('audio', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { fetchRecording } = await loadClient();
    await fetchRecording('https://storage.test/rec.wav?sig=abc');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://storage.test/rec.wav?sig=abc');
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(JSON.stringify(init)).not.toContain('test-key');
  });

  it('forwards a Range header so the player can seek', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('dio', { status: 206 }));
    vi.stubGlobal('fetch', fetchMock);

    const { fetchRecording } = await loadClient();
    const response = await fetchRecording('https://storage.test/rec.wav', 'bytes=2-4');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Range).toBe('bytes=2-4');
    expect(response.status).toBe(206);
  });

  it('returns the raw response rather than unwrapping an envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('RIFF', { status: 200, headers: { 'Content-Type': 'audio/wav' } }),
      ),
    );

    const { fetchRecording } = await loadClient();
    const response = await fetchRecording('https://storage.test/rec.wav');

    expect(response.headers.get('Content-Type')).toBe('audio/wav');
    expect(await response.text()).toBe('RIFF');
  });

  it('maps a network failure reaching storage to UPSTREAM_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('dns')));

    const { fetchRecording, ApiError } = await loadClient();
    const error = await fetchRecording('https://storage.test/rec.wav').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('UPSTREAM_ERROR');
  });
});

describe('fetchRecording — where it will and will not go', () => {
  it('refuses anything but public https storage, without making a request', async () => {
    // The URL is a string out of an upstream JSON body handed straight to
    // fetch. A compromised or misconfigured platform naming a link-local
    // address would turn recording playback into a relay for whatever answers
    // on our own network.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { fetchRecording, ApiError } = await loadClient();

    for (const url of [
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'https://127.0.0.1:9200/_search',
      'https://localhost/secrets',
      'https://10.0.0.5/internal.wav',
      'https://192.168.1.10/internal.wav',
      'https://[::1]/internal.wav',
      'http://storage.test/plain.wav',
      'not-a-url',
    ]) {
      const error = await fetchRecording(url).catch((err: unknown) => err);

      expect(error, url).toBeInstanceOf(ApiError);
      expect((error as InstanceType<typeof ApiError>).status, url).toBe(502);
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches ordinary https storage, and does not follow a redirect away from it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('RIFF', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { fetchRecording } = await loadClient();
    await fetchRecording('https://storage.example.com/signed.wav?sig=x', 'bytes=0-9');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://storage.example.com/signed.wav?sig=x',
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(fetchMock.mock.calls[0][1].headers.Range).toBe('bytes=0-9');
  });

  it('does not send the partner key to the supplier storage host', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('RIFF', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { fetchRecording } = await loadClient();
    await fetchRecording('https://storage.example.com/signed.wav?sig=x');

    expect(JSON.stringify(fetchMock.mock.calls[0][1].headers)).not.toContain('Bearer');
  });
});

describe('getCall — absence versus outage', () => {
  it('returns null when upstream says the call does not exist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ success: false, error: { code: 'NOT_FOUND', message: 'Call not found' } }, 404),
      ),
    );

    const { getCall } = await loadClient();

    expect(await getCall('nope')).toBeNull();
  });

  it('reads a 404 that is not JSON as absence, not as an unreadable platform', async () => {
    // A gateway, a CDN or a bare nginx answers 404 with HTML or with nothing.
    // Parsing the body before looking at the status turned every one of those
    // into a 502, so a call that genuinely does not exist was reported as an
    // outage for as long as whatever sits in front of upstream kept answering.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>404 Not Found</html>', { status: 404 })),
    );

    const { getCall } = await loadClient();

    expect(await getCall('nope')).toBeNull();
  });

  it('still throws UPSTREAM_ERROR when upstream is broken rather than empty', async () => {
    // The distinction the caller needs: "no such call" is a fact about the
    // call, and every other failure is a fact about the platform. Collapsing
    // them tells a reader their call was deleted during an outage.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ success: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500),
      ),
    );

    const { getCall, ApiError } = await loadClient();
    const error = await getCall('c1').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
  });

  it('treats an unreachable platform as an outage, not an absent call', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')));

    const { getCall, ApiError } = await loadClient();
    const error = await getCall('c1').catch((err: unknown) => err);

    expect((error as ApiError).code).toBe('UPSTREAM_ERROR');
  });
});

/**
 * The webhook-configuration family.
 *
 * This is the one surface on the partner API that hands back a credential, and
 * it hands it back exactly once — on create and on rotation. Everywhere else
 * the secret is unreadable, so the adapter's whole job here is to pass that one
 * value through untouched while keeping it out of every log sink.
 */
describe('webhook configuration', () => {
  const endpoint = {
    id: 'we_1',
    label: 'ezo-backend',
    url: 'https://api.ezo.test/webhooks/vocobase',
    enabled: true,
    agent_id: null,
    agent_name: null,
    events: ['session.completed'],
    last_delivery_at: null,
    last_delivery_status: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  };

  const stub = (body: unknown, status = 200) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body, status));
    vi.stubGlobal('fetch', fetchMock);

    return fetchMock;
  };

  it('reads the account config, where the secret is already a placeholder', async () => {
    const fetchMock = stub({
      success: true,
      data: { webhook: { configured: true, url: endpoint.url, secret: '****' }, webhooks: [endpoint] },
    });

    const { getPartnerConfig } = await loadClient();
    const config = await getPartnerConfig();

    expect(fetchMock.mock.calls[0]![0]).toBe('https://voice.test/api/v2/config');
    expect(config.webhook?.secret).toBe('****');
    expect(config.webhooks).toHaveLength(1);
  });

  it('lists endpoints and the catalogue of events they may subscribe to', async () => {
    const fetchMock = stub({
      success: true,
      data: { endpoints: [endpoint], available_events: ['session.completed', 'call.status.updated'] },
    });

    const { listWebhookEndpoints } = await loadClient();
    const listed = await listWebhookEndpoints();

    expect(fetchMock.mock.calls[0]![0]).toBe('https://voice.test/api/v2/config/webhooks');
    expect(listed.endpoints?.[0]?.label).toBe('ezo-backend');
    expect(listed.available_events).toContain('call.status.updated');
  });

  it('passes the once-only secret through a create untouched', async () => {
    const secret = 'whsec_abcdefghijklmnopqrstuvwxyz0123456789';
    const fetchMock = stub(
      { success: true, data: { ...endpoint, secret, message: 'Save this secret.' } },
      201,
    );

    const { createWebhookEndpoint } = await loadClient();
    const created = await createWebhookEndpoint({
      label: 'ezo-backend',
      url: endpoint.url,
      events: ['session.completed'],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://voice.test/api/v2/config/webhooks');
    expect(init.method).toBe('POST');
    // Verbatim. A secret this layer edited is a secret no signature verifies.
    expect(created.secret).toBe(secret);
  });

  it('sends only the keys an update supplies', async () => {
    const fetchMock = stub({ success: true, data: endpoint });

    const { updateWebhookEndpoint } = await loadClient();
    await updateWebhookEndpoint('we/1', { url: endpoint.url });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://voice.test/api/v2/config/webhooks/we%2F1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ url: endpoint.url });
  });

  it('deletes an endpoint', async () => {
    const fetchMock = stub({ success: true, data: { id: 'we_1', deleted: true } });

    const { deleteWebhookEndpoint } = await loadClient();
    await deleteWebhookEndpoint('we_1');

    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('DELETE');
  });

  it('rotates a secret and returns the new one', async () => {
    const secret = 'whsec_9876543210zyxwvutsrqponmlkjihgfedcba';
    const fetchMock = stub({
      success: true,
      data: { id: 'we_1', label: 'ezo-backend', secret, message: 'Save this secret.' },
    });

    const { rotateWebhookSecret } = await loadClient();
    const rotated = await rotateWebhookSecret('we_1');

    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://voice.test/api/v2/config/webhooks/we_1/rotate-secret',
    );
    expect(rotated.secret).toBe(secret);
  });

  it('sends a test delivery and reports the enqueued id', async () => {
    const fetchMock = stub({ success: true, data: { delivery_id: 'wd_1' } }, 202);

    const { testWebhookEndpoint } = await loadClient();
    const sent = await testWebhookEndpoint('we_1');

    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://voice.test/api/v2/config/webhooks/we_1/test',
    );
    expect(sent.delivery_id).toBe('wd_1');
  });

  /**
   * The credential redaction exists so our own key never lands in a log sink.
   * A webhook secret is the same kind of value with the same consequence — one
   * that reaches logging forges completions and charges — so it gets the same
   * net, for the day an upstream error message quotes one back at us.
   */
  it('keeps a webhook secret out of the log sink when upstream quotes one', async () => {
    const logged: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(...args);
    });

    stub(
      {
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'secret whsec_leakedsecretvalue0123456789 is invalid' },
      },
      400,
    );

    const { rotateWebhookSecret, ApiError } = await loadClient();
    const error = await rotateWebhookSecret('we_1').catch((err: unknown) => err);

    expect((error as ApiError).status).toBe(400);
    expect(JSON.stringify(logged)).not.toContain('whsec_leakedsecretvalue0123456789');
    expect(JSON.stringify(logged)).toContain('whsec_***');
  });
});

/**
 * Lifecycle hooks are the one V2 surface that answers without the
 * `{ success, data }` envelope: a 200 is the raw `{ hooks: [...] }` document,
 * and its path is `/agents/…` — plural — where every other agent read is
 * `/agent/…`. Both facts are upstream's contract, and both are exactly the
 * kind of detail a refactor "normalises" away, so both are pinned here.
 */
describe('getAgentLifecycleHooks', () => {
  it('requests the plural /agents path with the id encoded', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hooks: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const { getAgentLifecycleHooks } = await loadClient();
    await getAgentLifecycleHooks('ag one');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://voice.test/api/v2/agents/ag%20one/lifecycle-hooks');
  });

  it('returns the raw hooks document without demanding the success envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ hooks: [{ id: 'h1', stage: 'PRE_CALL', name: 'lookup' }] }),
      ),
    );

    const { getAgentLifecycleHooks } = await loadClient();
    const result = await getAgentLifecycleHooks('ag-1');

    expect(result.hooks).toEqual([{ id: 'h1', stage: 'PRE_CALL', name: 'lookup' }]);
  });

  it('keeps an upstream 404 a 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: 'Agent not found' }, 404)),
    );

    const { getAgentLifecycleHooks, ApiError } = await loadClient();
    const error = await getAgentLifecycleHooks('missing').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).code).toBe('RESOURCE_NOT_FOUND');
  });

  it('turns an upstream failure into a 502 without repeating its wording', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: 'boom from the platform' }, 500)),
    );

    const { getAgentLifecycleHooks, ApiError } = await loadClient();
    const error = await getAgentLifecycleHooks('ag-1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).message).not.toContain('boom');
  });

  /**
   * The bypass is an opt-out of `unwrap`, and `unwrap` is the only thing that
   * catches a failure dressed as a success. These three are the shapes where
   * skipping it would hand the route something it reads as "no hooks" — the
   * empty list that this surface exists to never claim falsely.
   */
  it('refuses a 200 that carries a failure envelope instead of the document', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ success: false, error: { message: 'nope from the platform' } }),
      ),
    );

    const { getAgentLifecycleHooks, ApiError } = await loadClient();
    const error = await getAgentLifecycleHooks('ag-1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).message).not.toContain('nope');
  });

  it('refuses a 200 that carries the key but not the document', async () => {
    // The bypass used to test `'hooks' in body`, and `in` is true for a key
    // whose value is null. A failure envelope that happens to carry the key
    // therefore skipped `unwrap` entirely, and the route's
    // `Array.isArray(hooks) ? hooks : []` answered 200 `{data: []}` — "this
    // agent has no pre/post-call actions" for an agent that has several.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ hooks: null, success: false, error: { message: 'nope from the platform' } }),
      ),
    );

    const { getAgentLifecycleHooks, ApiError } = await loadClient();
    const error = await getAgentLifecycleHooks('ag-1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).message).not.toContain('nope');
  });

  it('refuses a 200 whose body is not the hooks document at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(null)));

    const { getAgentLifecycleHooks, ApiError } = await loadClient();
    const error = await getAgentLifecycleHooks('ag-1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
  });

  it('refuses a 204, which promises a document and sends none', async () => {
    // The shared 204 short-circuit exists for a successful DELETE. On a
    // surface whose whole contract is "a bare document comes back", it
    // handed the route `undefined`, which destructured into a TypeError and
    // a 500 — an unreadable upstream reported as our own bug.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    const { getAgentLifecycleHooks, ApiError } = await loadClient();
    const error = await getAgentLifecycleHooks('ag-1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
  });

  it('reads an empty hooks document as an empty list, not a fault', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ hooks: [] })));

    const { getAgentLifecycleHooks } = await loadClient();

    expect((await getAgentLifecycleHooks('ag-1')).hooks).toEqual([]);
  });
});

/**
 * The face's knowledge-base sync signal. Every body below is copied from what
 * Vocobase sends: the success document from `agent-document.routes.ts:194-201`
 * (reached through the face proxy, `inboundFaceProxy.ts:78,115`), the refusal
 * from `inboundFaceProxy.ts:102-111`.
 */
describe('getFaceDocumentSyncStatusForStart', () => {
  it('reads the face through the parent id, with the id encoded', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          agent_id: 'face-internal',
          summary: { total: 0, pending: 0, syncing: 0, synced: 0, failed: 0, deleted: 0 },
          documents: [],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { getFaceDocumentSyncStatusForStart } = await loadClient();
    await getFaceDocumentSyncStatusForStart('ag one');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://voice.test/api/v2/agent/ag%20one/inbound/documents/sync-status');
  });

  it('unwraps the V2 envelope to the summary and the per-document rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          success: true,
          data: {
            agent_id: 'face-internal',
            summary: { total: 2, pending: 1, syncing: 0, synced: 0, failed: 1, deleted: 0 },
            documents: [
              {
                document_id: 'doc-1',
                name: 'Pricing.pdf',
                type: 'file',
                sync_status: 'failed',
                sync_error: 'provider rejected the file',
                synced_at: null,
                linked_at: '2026-09-23T00:00:00.000Z',
                providers: { supermemory: false, gemini: false, vertex: false, azure: false },
              },
            ],
          },
        }),
      ),
    );

    const { getFaceDocumentSyncStatusForStart } = await loadClient();
    const result = await getFaceDocumentSyncStatusForStart('ag-1');

    expect(result.summary).toEqual({
      total: 2,
      pending: 1,
      syncing: 0,
      synced: 0,
      failed: 1,
      deleted: 0,
    });
    expect(result.documents?.[0]).toMatchObject({ sync_status: 'failed' });
  });

  it('refuses the enveloped 404 a face-less agent gets, as a 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            success: false,
            error: { code: 'INBOUND_NOT_ENABLED', message: 'Inbound is not enabled for this agent' },
          },
          404,
        ),
      ),
    );

    const { getFaceDocumentSyncStatusForStart, ApiError } = await loadClient();
    const error = await getFaceDocumentSyncStatusForStart('ag-1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });
});

/**
 * The face's replace-all. The success body is `inbound-lifecycle-hooks.routes.ts:280`
 * (rows rewritten to name the PARENT by `asParent`, `:110-112`); the refusals
 * are `:83-92` (no face) and `:116-123` (a hook the platform will not take).
 */
describe('replaceInboundLifecycleHooks', () => {
  const faceHook = {
    id: 'fh-1',
    agentId: 'ag-1',
    stage: 'PRE_CALL',
    position: 0,
    toolSlug: 'google_sheets',
    toolFn: 'lookup_row',
    functionId: null,
    name: 'Look up lead',
    input: { spreadsheetId: 's1' },
    exposeAs: 'lead',
    skipUnless: [],
    required: false,
    timeoutMs: 3000,
    enabled: true,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
  };

  it('PUTs the whole list, camelCase, to the plural inbound path', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ success: true, data: { hooks: [faceHook] } }));
    vi.stubGlobal('fetch', fetchMock);

    const { replaceInboundLifecycleHooks } = await loadClient();
    const hooks = [
      {
        stage: 'PRE_CALL' as const,
        name: 'Look up lead',
        toolSlug: 'google_sheets',
        toolFn: 'lookup_row',
        input: { spreadsheetId: 's1' },
        exposeAs: 'lead',
        required: false,
        timeoutMs: 3000,
        enabled: false,
        skipUnless: ['lead.phone'],
      },
    ];
    const result = await replaceInboundLifecycleHooks('ag one', hooks);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://voice.test/api/v2/agents/ag%20one/inbound/lifecycle-hooks');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ hooks });
    expect(result.hooks).toEqual([faceHook]);
  });

  it('passes the no-face refusal through wearing the platform code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            success: false,
            error: { code: 'INBOUND_NOT_ENABLED', message: 'Inbound is not enabled for this agent' },
          },
          404,
        ),
      ),
    );

    const { replaceInboundLifecycleHooks, ApiError } = await loadClient();
    const error = await replaceInboundLifecycleHooks('ag-1', []).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).code).toBe('INBOUND_NOT_ENABLED');
  });

  it('passes a validation refusal through with the platform sentence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            success: false,
            error: {
              code: 'VALIDATION_FAILED',
              message: 'One or more hooks are invalid',
              issues: [{ field: 'hooks[0].toolFn', code: 'UNKNOWN_FN', message: 'no such fn' }],
            },
          },
          422,
        ),
      ),
    );

    const { replaceInboundLifecycleHooks, ApiError } = await loadClient();
    const error = await replaceInboundLifecycleHooks('ag-1', []).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
    expect((error as ApiError).code).toBe('VALIDATION_FAILED');
    expect((error as ApiError).message).toBe('One or more hooks are invalid');
  });

  it('refuses a 200 carrying the failure envelope rather than reading it as a replaced list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ success: false, error: { code: 'INTERNAL_ERROR', message: 'x' } }),
      ),
    );

    const { replaceInboundLifecycleHooks, ApiError } = await loadClient();
    const error = await replaceInboundLifecycleHooks('ag-1', []).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
  });
});

/**
 * The BASE list's replace-all, which keeping the inbound persona writes the
 * face's actions through. Every body below is the contract Vocobase is adding
 * this route under: success is the bare `{ hooks }` document the base GET
 * already answers, a refusal the bare `{ error: 'VALIDATION_FAILED', issues }`
 * the base POST already answers, and a platform that does not carry the route
 * yet answers its catch-all, the bare `{ error: 'Not found' }` (app.ts:426).
 */
describe('replaceAgentLifecycleHooks', () => {
  const hooks = [
    {
      stage: 'PRE_CALL' as const,
      name: 'Look up lead',
      toolSlug: 'google_sheets',
      toolFn: 'lookup_row',
      input: { spreadsheetId: 's1' },
      exposeAs: 'lead',
      required: false,
      timeoutMs: 3000,
      enabled: false,
      skipUnless: ['lead.phone'],
    },
  ];
  const baseRow = {
    id: 'bh-9',
    agentId: 'ag-1',
    stage: 'PRE_CALL',
    position: 0,
    name: 'Look up lead',
    enabled: false,
  };

  it('PUTs the whole list, camelCase, to the plural base path and reads the bare document', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hooks: [baseRow] }));
    vi.stubGlobal('fetch', fetchMock);

    const { replaceAgentLifecycleHooks } = await loadClient();
    const result = await replaceAgentLifecycleHooks('ag one', hooks);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://voice.test/api/v2/agents/ag%20one/lifecycle-hooks');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ hooks });
    expect(result.hooks).toEqual([baseRow]);
  });

  it('passes the bare validation refusal through with its issues', async () => {
    const issues = [{ field: 'hooks[0].toolFn', code: 'UNKNOWN_FN', message: 'no such fn' }];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: 'VALIDATION_FAILED', issues }, 422)),
    );

    const { replaceAgentLifecycleHooks, ApiError } = await loadClient();
    const error = await replaceAgentLifecycleHooks('ag-1', hooks).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
    expect((error as ApiError).code).toBe('VALIDATION_FAILED');
    expect((error as ApiError).details).toEqual({ issues });
  });

  it('reads the catch-all 404 as the route not being deployed yet', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'Not found' }, 404)));

    const { replaceAgentLifecycleHooks, ApiError } = await loadClient();
    const error = await replaceAgentLifecycleHooks('ag-1', hooks).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(501);
    expect((error as ApiError).code).toBe('KEEP_INBOUND_UNAVAILABLE');
    expect((error as ApiError).message).toBe(
      'Keeping the inbound persona needs a platform update that is not live yet. ' +
        'Keep the outbound persona, or try again later.',
    );
  });

  it("keeps the route's own agent-not-found a 404, told apart by body", async () => {
    // The base family's own refusal for an unknown agent (see the
    // getAgentLifecycleHooks block above) — a live route, so not the 501.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: 'Agent not found' }, 404)),
    );

    const { replaceAgentLifecycleHooks, ApiError } = await loadClient();
    const error = await replaceAgentLifecycleHooks('ag-1', hooks).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).code).toBe('RESOURCE_NOT_FOUND');
  });

  it('refuses a 200 carrying a failure envelope rather than reading it as a replaced list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ hooks: null, success: false, error: 'x' })),
    );

    const { replaceAgentLifecycleHooks, ApiError } = await loadClient();
    const error = await replaceAgentLifecycleHooks('ag-1', hooks).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
  });
});

describe('browser test sessions', () => {
  it('starts a session and returns the room and its token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          session_id: 'sess-1',
          agent_id: 'ext-1',
          daily_room_url: 'https://daily.test/room/abc',
          daily_token: 'tok-1',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { startWebSession } = await loadClient();
    const session = await startWebSession({ agent_id: 'ext-1' });

    expect(session.session_id).toBe('sess-1');
    expect(session.daily_room_url).toBe('https://daily.test/room/abc');
    expect(session.daily_token).toBe('tok-1');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://voice.test/api/v2/sessions/webrtc');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ agent_id: 'ext-1' });
  });

  /**
   * An absent key and an empty object are different requests, and only the
   * first means "I did not fill any of these in". The platform substitutes a
   * missing variable as a blank string, so sending `{}` where nothing was
   * asked for is harmless today and is still the wrong request to send.
   */
  it('omits the variables key entirely when none were given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ success: true, data: { session_id: 's', daily_room_url: 'u', daily_token: 't' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { startWebSession } = await loadClient();
    await startWebSession({ agent_id: 'ext-1' });

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).not.toHaveProperty('variables');
  });

  it('forwards the variables it was given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ success: true, data: { session_id: 's', daily_room_url: 'u', daily_token: 't' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { startWebSession } = await loadClient();
    await startWebSession({ agent_id: 'ext-1', variables: { contact_name: 'Asha' } });

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({
      agent_id: 'ext-1',
      variables: { contact_name: 'Asha' },
    });
  });

  it('reads one session back by the platform id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ success: true, data: { session_id: 'sess-1', status: 'completed', duration_seconds: 47 } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { getSession } = await loadClient();
    const session = await getSession('sess-1');

    expect(session).toMatchObject({ status: 'completed', duration_seconds: 47 });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://voice.test/api/v2/sessions/sess-1');
  });

  /**
   * "No such session" and "the platform is down" are different facts, and the
   * reaper acts on them differently: the first settles a row at zero, the
   * second leaves it for the next tick.
   */
  it('returns null for a session the platform has never heard of', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ success: false, error: {} }, 404)));

    const { getSession } = await loadClient();

    await expect(getSession('gone')).resolves.toBeNull();
  });

  it('still throws when the platform fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ success: false, error: {} }, 500)));

    const { getSession, ApiError } = await loadClient();

    await expect(getSession('sess-1')).rejects.toBeInstanceOf(ApiError);
  });
});
