import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiError } from '../src/lib/errors.js';

/**
 * The lifecycle-hook write surface, and the two read proxies beside it.
 *
 * Same harness as `vocobase-adapter.test.ts`: the client is re-imported per
 * test so it reads whatever the test put in the environment, `fetch` is
 * stubbed throughout, and `ApiError` comes from the same module registry so
 * `instanceof` holds.
 *
 * What these tests pin is the **wire**: the method, the path, the query and
 * the body each function sends, and how the two envelopes this surface uses
 * come back. Every one of them is a fact about the platform that no type can
 * hold, and the routes above are written against them.
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

/** The one call `fetch` received, as `(url, init)`. */
function calledWith(fetchMock: ReturnType<typeof vi.fn>): { url: URL; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url: new URL(url), init };
}

const originalKey = process.env.VOCOBASE_API_KEY;
const originalUrl = process.env.VOCOBASE_API_URL;

beforeEach(() => {
  process.env.VOCOBASE_API_KEY = 'test-key';
  process.env.VOCOBASE_API_URL = 'https://voice.test/api/v2';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env.VOCOBASE_API_KEY = originalKey;
  process.env.VOCOBASE_API_URL = originalUrl;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const HOOK = { id: 'hook-1', stage: 'PRE_CALL', name: 'Lookup', position: 0 };

describe('lifecycle hook writes', () => {
  it('creates a hook against the plural path and returns the bare document', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hook: HOOK }, 201));
    vi.stubGlobal('fetch', fetchMock);

    const { createAgentLifecycleHook } = await loadClient();
    const result = await createAgentLifecycleHook('ag_1', {
      stage: 'PRE_CALL',
      name: 'Lookup',
      toolSlug: 'google_sheets',
      toolFn: 'lookup_row',
      input: { spreadsheet_id: 'sheet-1' },
      exposeAs: 'lead',
    });

    const { url, init } = calledWith(fetchMock);
    expect(url.pathname).toBe('/api/v2/agents/ag_1/lifecycle-hooks');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({
      stage: 'PRE_CALL',
      toolSlug: 'google_sheets',
      exposeAs: 'lead',
    });
    expect(result.hook).toEqual(HOOK);
  });

  it('passes a 422 VALIDATION_FAILED through with its issues', async () => {
    const issues = [{ path: 'input.columns[2].header', message: 'Required' }];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'VALIDATION_FAILED', issues }, 422));
    vi.stubGlobal('fetch', fetchMock);

    const { createAgentLifecycleHook, ApiError: Err } = await loadClient();
    const error = await createAgentLifecycleHook('ag_1', { stage: 'PRE_CALL', name: 'x' }).catch(
      (e: unknown) => e as ApiError,
    );

    expect(error).toBeInstanceOf(Err);
    expect(error.status).toBe(422);
    expect(error.code).toBe('VALIDATION_FAILED');
    // Verbatim: the paths name fields the form draws, and rewriting them
    // would cost the reader the only thing that says which input to fix.
    expect(error.details).toEqual({ issues });
  });

  it('maps a non-VALIDATION_FAILED bare error by its status, not its word', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'TOOL_NOT_CONNECTED' }, 422));
    vi.stubGlobal('fetch', fetchMock);

    const { createAgentLifecycleHook, ApiError: Err } = await loadClient();
    const error = await createAgentLifecycleHook('ag_1', { stage: 'PRE_CALL', name: 'x' }).catch(
      (e: unknown) => e as ApiError,
    );

    expect(error).toBeInstanceOf(Err);
    expect(error.status).toBe(502);
    expect(error.code).toBe('UPSTREAM_ERROR');
  });

  it('updates a hook with PATCH', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hook: HOOK }));
    vi.stubGlobal('fetch', fetchMock);

    const { updateAgentLifecycleHook } = await loadClient();
    await updateAgentLifecycleHook('ag_1', 'hook-1', { name: 'Renamed' });

    const { url, init } = calledWith(fetchMock);
    expect(url.pathname).toBe('/api/v2/agents/ag_1/lifecycle-hooks/hook-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Renamed' });
  });

  it('deletes a hook and tolerates the empty 204', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const { deleteAgentLifecycleHook } = await loadClient();
    await expect(deleteAgentLifecycleHook('ag_1', 'hook-1')).resolves.toBeUndefined();

    const { url, init } = calledWith(fetchMock);
    expect(url.pathname).toBe('/api/v2/agents/ag_1/lifecycle-hooks/hook-1');
    expect(init.method).toBe('DELETE');
  });

  it('reorders one stage by its list of ids', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hooks: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const { reorderAgentLifecycleHooks } = await loadClient();
    await reorderAgentLifecycleHooks('ag_1', { stage: 'POST_CALL', ids: ['b', 'a'] });

    const { url, init } = calledWith(fetchMock);
    expect(url.pathname).toBe('/api/v2/agents/ag_1/lifecycle-hooks/reorder');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ stage: 'POST_CALL', ids: ['b', 'a'] });
  });

  it('previews a hook against sample variables and reads the platform’s bare body', async () => {
    // The platform's real preview document: `renderedInput`, the hook it
    // rendered, and whether a `skipUnless` guard would have skipped it. No
    // `input` key — a predicate that looked for one refused every real answer.
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        renderedInput: { to: 'a@b.test' },
        hook: HOOK,
        skipped: true,
        skippedOn: 'extraction.email',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { previewAgentLifecycleHook } = await loadClient();
    const result = await previewAgentLifecycleHook('ag_1', 'hook-1', {
      variables: { 'extraction.email': 'a@b.test' },
    });

    const { url, init } = calledWith(fetchMock);
    expect(url.pathname).toBe('/api/v2/agents/ag_1/lifecycle-hooks/hook-1/preview');
    expect(init.method).toBe('POST');
    expect(result.renderedInput).toEqual({ to: 'a@b.test' });
    expect(result.skipped).toBe(true);
    expect(result.skippedOn).toBe('extraction.email');
  });

  it('does not take a body without `renderedInput` for a preview', async () => {
    // The platform's preview is `{ renderedInput, hook, skipped, skippedOn? }`
    // (crud.service.ts:1056-1062). A document without its one field is not
    // one, and is reported as unreadable rather than rendered as empty.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ input: { to: 'a@b.test' } }));
    vi.stubGlobal('fetch', fetchMock);

    const { previewAgentLifecycleHook } = await loadClient();
    const error = await previewAgentLifecycleHook('ag_1', 'hook-1', {}).catch(
      (e: unknown) => e as ApiError,
    );

    expect(error.status).toBe(502);
  });
});

describe('sheet columns', () => {
  /** The platform's document, in full. */
  const SHEET = {
    columns: ['Name', 'Phone'],
    sheet_name: 'Leads',
    spreadsheet_id: 'sheet-1',
    tabs: ['Leads', 'Archive'],
    truncated: false,
  };

  it('asks the agent’s google_sheets binding for one sheet’s headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: SHEET }));
    vi.stubGlobal('fetch', fetchMock);

    const { getSheetColumns } = await loadClient();
    const result = await getSheetColumns('ag_1', {
      spreadsheet_id: 'sheet-1',
      sheet_name: 'Leads',
    });

    const { url, init } = calledWith(fetchMock);
    expect(url.pathname).toBe('/api/v2/agent/ag_1/tools/google_sheets/sheet-columns');
    expect(url.searchParams.get('spreadsheet_id')).toBe('sheet-1');
    expect(url.searchParams.get('sheet_name')).toBe('Leads');
    expect(init.method ?? 'GET').toBe('GET');
    expect(result.columns).toEqual(['Name', 'Phone']);
    // `tabs`, the platform's key for the workbook's tab list.
    expect(result.tabs).toEqual(['Leads', 'Archive']);
    expect(result.truncated).toBe(false);
  });

  it('omits sheet_name when the caller only wants the tab list', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: SHEET }));
    vi.stubGlobal('fetch', fetchMock);

    const { getSheetColumns } = await loadClient();
    await getSheetColumns('ag_1', { spreadsheet_id: 'sheet-1' });

    const { url } = calledWith(fetchMock);
    expect(url.searchParams.has('sheet_name')).toBe(false);
  });

  it('re-throws NOT_CONNECTED so the route can map it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        { success: false, error: { code: 'NOT_CONNECTED', message: 'Google Sheets is not connected.' } },
        409,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { getSheetColumns, ApiError: Err } = await loadClient();
    const error = await getSheetColumns('ag_1', { spreadsheet_id: 's' }).catch(
      (e: unknown) => e as ApiError,
    );

    expect(error).toBeInstanceOf(Err);
    expect(error.code).toBe('NOT_CONNECTED');
  });

  it('re-throws TAB_NOT_FOUND with the tab list the platform puts under error.details', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          success: false,
          error: {
            code: 'TAB_NOT_FOUND',
            message: 'No tab named Nope.',
            details: { tabs: ['Leads', 'Archive'] },
          },
        },
        404,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { getSheetColumns } = await loadClient();
    const error = await getSheetColumns('ag_1', { spreadsheet_id: 's', sheet_name: 'Nope' }).catch(
      (e: unknown) => e as ApiError,
    );

    expect(error.status).toBe(404);
    expect(error.code).toBe('TAB_NOT_FOUND');
    expect(error.details).toEqual({ tabs: ['Leads', 'Archive'] });
  });

  it('re-throws SHEET_NOT_CONFIGURED as itself', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        { success: false, error: { code: 'SHEET_NOT_CONFIGURED', message: 'No spreadsheet.' } },
        422,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { getSheetColumns } = await loadClient();
    const error = await getSheetColumns('ag_1', { spreadsheet_id: 's' }).catch(
      (e: unknown) => e as ApiError,
    );

    expect(error.status).toBe(422);
    expect(error.code).toBe('SHEET_NOT_CONFIGURED');
  });
});

describe('sheet-columns refusals the platform sends', () => {
  // Each body is what agent.routes.ts:2531-2539 answers for a
  // sheetColumns.service.ts:222-248 failure: the V2 envelope, the platform's
  // own code and status.
  const cases = [
    { status: 409, code: 'NOT_AUTHENTICATED', message: 'Google rejected the stored credentials.' },
    { status: 404, code: 'SHEET_NOT_FOUND', message: "Couldn't open that sheet." },
    { status: 429, code: 'SHEETS_ERROR', message: 'Google Sheets rate limit hit.' },
    { status: 502, code: 'SHEETS_ERROR', message: 'Bad gateway from Google.' },
  ];

  for (const { status, code, message } of cases) {
    it(`passes ${code} (${status}) through as itself, not mapped by status`, async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse({ success: false, error: { code, message } }, status));
      vi.stubGlobal('fetch', fetchMock);

      const { getSheetColumns } = await loadClient();
      const error = await getSheetColumns('ag_1', { spreadsheet_id: 's' }).catch(
        (e: unknown) => e as ApiError,
      );

      expect(error.status).toBe(status);
      expect(error.code).toBe(code);
    });
  }
});

describe('integration logs', () => {
  // The platform's route answers success BARE — `res.json({ logs, nextCursor })`
  // at integration-logs.routes.ts:215-233 — with no `{ success, data }`
  // envelope. Every success fixture below is that body, copied.
  it('reads the bare { logs, nextCursor } body the platform answers', async () => {
    const row = {
      id: 'log-1',
      agentId: 'ag_1',
      sessionId: 'sess_1',
      toolSlug: 'google_sheets',
      fn: 'lookup_row',
      status: 'OK',
      upstreamCode: 200,
      latencyMs: 12,
      argsRedacted: {},
      resultSummary: null,
      errorMessage: null,
      createdAt: '2026-09-21T11:59:00.000Z',
    };
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ logs: [row], nextCursor: '2026-09-21T11:59:00.000Z|log-1' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { listIntegrationLogs } = await loadClient();
    const result = await listIntegrationLogs({ agentId: 'ag_1', limit: 1 });

    expect(result.logs).toEqual([row]);
    expect(result.nextCursor).toBe('2026-09-21T11:59:00.000Z|log-1');
  });

  it('answers the enveloped NOT_FOUND for an agent the platform does not show as a 404', async () => {
    // integration-logs.routes.ts:140-144: a face id, or a missing face on
    // side=inbound, is this envelope. It is not the bare document, so it
    // must not take the bypass and read as an empty list.
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ success: false, error: { code: 'NOT_FOUND', message: 'Agent not found' } }, 404),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { listIntegrationLogs } = await loadClient();
    const error = await listIntegrationLogs({ agentId: 'ag_face' }).catch(
      (e: unknown) => e as ApiError,
    );

    expect(error.status).toBe(404);
    expect(error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('sends the platform’s camelCase filters and drops the ones not asked for', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ logs: [], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);

    const { listIntegrationLogs } = await loadClient();
    await listIntegrationLogs({
      agentId: 'ag_1',
      from: '2026-09-20T00:00:00.000Z',
      to: '2026-09-21T00:00:00.000Z',
      limit: 50,
    });

    const { url } = calledWith(fetchMock);
    expect(url.pathname).toBe('/api/v2/integration-logs');
    expect(url.searchParams.get('agentId')).toBe('ag_1');
    expect(url.searchParams.get('from')).toBe('2026-09-20T00:00:00.000Z');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.has('sessionId')).toBe(false);
    expect(url.searchParams.has('cursor')).toBe(false);
    expect(url.searchParams.has('side')).toBe(false);
  });

  it('asks for the face’s runs with side=inbound and the BASE agent id', async () => {
    // The face has no id of its own on this surface: the platform keys the
    // inbound rows on the parent agent and `side` picks which face's.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ logs: [], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);

    const { listIntegrationLogs } = await loadClient();
    await listIntegrationLogs({ agentId: 'ag_1', side: 'inbound', limit: 50 });

    const { url } = calledWith(fetchMock);
    expect(url.searchParams.get('agentId')).toBe('ag_1');
    expect(url.searchParams.get('side')).toBe('inbound');
  });

  it('passes the platform’s INBOUND_NOT_ENABLED on a face read through as itself', async () => {
    // The exact V2 envelope the platform answers when the local row says
    // the face is on and the platform says it is not.
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          success: false,
          error: { code: 'INBOUND_NOT_ENABLED', message: 'Inbound is not enabled on this agent.' },
        },
        404,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { listIntegrationLogs, ApiError: Err } = await loadClient();
    const error = await listIntegrationLogs({ agentId: 'ag_1', side: 'inbound' }).catch(
      (e: unknown) => e as ApiError,
    );

    expect(error).toBeInstanceOf(Err);
    expect(error.status).toBe(404);
    expect(error.code).toBe('INBOUND_NOT_ENABLED');
  });

  it('sends no agentId at all when a call asks by session alone', async () => {
    // An inbound call's runs are the FACE's, and a bare parent agentId
    // excludes them (integration-logs.routes.ts:153-170).
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ logs: [], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);

    const { listIntegrationLogs } = await loadClient();
    await listIntegrationLogs({ sessionId: 'sess_in', limit: 50 });

    const { url } = calledWith(fetchMock);
    expect(url.searchParams.get('sessionId')).toBe('sess_in');
    expect(url.searchParams.has('agentId')).toBe(false);
  });

  it('carries the sessionId filter when a call asks for its own runs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ logs: [], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);

    const { listIntegrationLogs } = await loadClient();
    await listIntegrationLogs({ agentId: 'ag_1', sessionId: 'sess_9', cursor: 'c1', limit: 50 });

    const { url } = calledWith(fetchMock);
    expect(url.searchParams.get('sessionId')).toBe('sess_9');
    expect(url.searchParams.get('cursor')).toBe('c1');
  });
});

describe('the face’s real NOT_FOUND against an absent route', () => {
  // inbound-lifecycle-hooks.routes.ts:343-345 (stale hook id) and :83-91 (no
  // face): the ENVELOPED 404 NOT_FOUND. An absent route is the platform's
  // catch-all, app.ts:426 — `{ error: 'Not found' }`, no envelope.
  const enveloped = () =>
    jsonResponse({ success: false, error: { code: 'NOT_FOUND', message: 'Hook not found' } }, 404);

  it('passes the enveloped NOT_FOUND on a face hook through as itself', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(enveloped()));

    const { updateInboundLifecycleHook } = await loadClient();
    const error = await updateInboundLifecycleHook('ag_1', 'stale', { name: 'x' }).catch(
      (e: unknown) => e as ApiError,
    );

    expect(error.status).toBe(404);
    expect(error.code).toBe('NOT_FOUND');
  });

  it('passes it through on the face’s tools too', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(enveloped()));

    const { getInboundAgentTools } = await loadClient();
    const error = await getInboundAgentTools('ag_1').catch((e: unknown) => e as ApiError);

    expect(error.status).toBe(404);
    expect(error.code).toBe('NOT_FOUND');
  });

  it('keeps the bare catch-all 404 as RESOURCE_NOT_FOUND, the absent-route signal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'Not found' }, 404)));

    const { updateInboundLifecycleHook } = await loadClient();
    const error = await updateInboundLifecycleHook('ag_1', 'hook-1', { name: 'x' }).catch(
      (e: unknown) => e as ApiError,
    );

    expect(error.status).toBe(404);
    expect(error.code).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('the inbound face', () => {
  it('reads the face’s hooks from the inbound path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hooks: [HOOK] }));
    vi.stubGlobal('fetch', fetchMock);

    const { getInboundLifecycleHooks } = await loadClient();
    const result = await getInboundLifecycleHooks('ag_1');

    const { url } = calledWith(fetchMock);
    expect(url.pathname).toBe('/api/v2/agents/ag_1/inbound/lifecycle-hooks');
    expect(result.hooks).toEqual([HOOK]);
  });

  it('replaces the face’s whole list with PUT', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hooks: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const { replaceInboundLifecycleHooks } = await loadClient();
    await replaceInboundLifecycleHooks('ag_1', [{ stage: 'PRE_CALL', name: 'Lookup' }]);

    const { url, init } = calledWith(fetchMock);
    expect(url.pathname).toBe('/api/v2/agents/ag_1/inbound/lifecycle-hooks');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      hooks: [{ stage: 'PRE_CALL', name: 'Lookup' }],
    });
  });

  it('creates, patches, deletes, reorders and previews on the face', async () => {
    const paths: string[] = [];
    const methods: (string | undefined)[] = [];
    const fetchMock = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      paths.push(new URL(url).pathname);
      methods.push(init.method);
      return Promise.resolve(jsonResponse({ hook: HOOK, hooks: [], renderedInput: {} }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = await loadClient();
    await client.createInboundLifecycleHook('ag_1', { stage: 'PRE_CALL', name: 'x' });
    await client.updateInboundLifecycleHook('ag_1', 'hook-1', { name: 'y' });
    await client.reorderInboundLifecycleHooks('ag_1', { stage: 'PRE_CALL', ids: ['hook-1'] });
    await client.previewInboundLifecycleHook('ag_1', 'hook-1', {});

    expect(paths).toEqual([
      '/api/v2/agents/ag_1/inbound/lifecycle-hooks',
      '/api/v2/agents/ag_1/inbound/lifecycle-hooks/hook-1',
      '/api/v2/agents/ag_1/inbound/lifecycle-hooks/reorder',
      '/api/v2/agents/ag_1/inbound/lifecycle-hooks/hook-1/preview',
    ]);
    expect(methods).toEqual(['POST', 'PATCH', 'POST', 'POST']);
  });

  it('previews on the face, unwrapping the inbound family’s success envelope', async () => {
    // The inbound routes answer `{ success, data }` where the base family is
    // bare; the same function has to read both without being told which.
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        data: { renderedInput: { to: 'x@y.test' }, hook: HOOK, skipped: false },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { previewInboundLifecycleHook } = await loadClient();
    const result = await previewInboundLifecycleHook('ag_1', 'hook-1', {});

    expect(result.renderedInput).toEqual({ to: 'x@y.test' });
    expect(result.skipped).toBe(false);
  });

  it('deletes on the face', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const { deleteInboundLifecycleHook } = await loadClient();
    await deleteInboundLifecycleHook('ag_1', 'hook-1');

    const { url, init } = calledWith(fetchMock);
    expect(url.pathname).toBe('/api/v2/agents/ag_1/inbound/lifecycle-hooks/hook-1');
    expect(init.method).toBe('DELETE');
  });

  it('lists the face’s own tool bindings under the singular agent path', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ success: true, data: { tools: [{ toolSlug: 'gmail' }] } }));
    vi.stubGlobal('fetch', fetchMock);

    const { getInboundAgentTools } = await loadClient();
    const result = await getInboundAgentTools('ag_1');

    const { url, init } = calledWith(fetchMock);
    expect(url.pathname).toBe('/api/v2/agent/ag_1/inbound/tools');
    expect(init.method ?? 'GET').toBe('GET');
    expect(result.tools).toEqual([{ toolSlug: 'gmail' }]);
  });

  it('binds a tool on the face under the singular agent path', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ success: true, data: { enabled: true } }));
    vi.stubGlobal('fetch', fetchMock);

    const { setInboundAgentTool } = await loadClient();
    await setInboundAgentTool('ag_1', 'google_sheets', { enabled: true, connection_id: 'conn-1' });

    const { url, init } = calledWith(fetchMock);
    expect(url.pathname).toBe('/api/v2/agent/ag_1/inbound/tools/google_sheets');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ enabled: true, connection_id: 'conn-1' });
  });

  it('unwraps the inbound family’s failure envelope, carrying VALIDATION_FAILED and its issues', async () => {
    // Where the base family answers `{ error: 'CODE', issues }`, the face
    // answers `{ success: false, error: { code, message, issues } }`. The
    // issues have to reach `details.issues` either way: they name the form
    // fields to fix, and the editor reads one shape.
    const issues = [{ path: 'exposeAs', message: 'Required' }];
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          success: false,
          error: { code: 'VALIDATION_FAILED', message: 'Invalid hook.', issues },
        },
        422,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { createInboundLifecycleHook, ApiError: Err } = await loadClient();
    const error = await createInboundLifecycleHook('ag_1', { stage: 'PRE_CALL', name: 'x' }).catch(
      (e: unknown) => e as ApiError,
    );

    expect(error).toBeInstanceOf(Err);
    expect(error.status).toBe(422);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details).toEqual({ issues });
  });

  it('passes the face’s INBOUND_NOT_ENABLED through as its own 404', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        { success: false, error: { code: 'INBOUND_NOT_ENABLED', message: 'Inbound is off.' } },
        404,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { getInboundLifecycleHooks, ApiError: Err } = await loadClient();
    const error = await getInboundLifecycleHooks('ag_1').catch((e: unknown) => e as ApiError);

    expect(error).toBeInstanceOf(Err);
    expect(error.status).toBe(404);
    expect(error.code).toBe('INBOUND_NOT_ENABLED');
  });

  it('carries the envelope’s issues on a face delete too', async () => {
    const issues = [{ path: 'id', message: 'In use' }];
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        { success: false, error: { code: 'VALIDATION_FAILED', message: 'No.', issues } },
        422,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { deleteInboundLifecycleHook } = await loadClient();
    const error = await deleteInboundLifecycleHook('ag_1', 'hook-1').catch(
      (e: unknown) => e as ApiError,
    );

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details).toEqual({ issues });
  });

  it('passes INBOUND_NOT_ENABLED from the face tools listing through as itself', async () => {
    // Live on production today: the tools proxy answers this envelope when
    // the face is off. Mapped by status it became RESOURCE_NOT_FOUND, which
    // the route reads as "release not deployed" — a 501 for a 404.
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        { success: false, error: { code: 'INBOUND_NOT_ENABLED', message: 'Inbound is off.' } },
        404,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { getInboundAgentTools } = await loadClient();
    const error = await getInboundAgentTools('ag_1').catch((e: unknown) => e as ApiError);

    expect(error.status).toBe(404);
    expect(error.code).toBe('INBOUND_NOT_ENABLED');
  });

  it('passes INBOUND_NOT_ENABLED from a face tool bind through as itself', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        { success: false, error: { code: 'INBOUND_NOT_ENABLED', message: 'Inbound is off.' } },
        404,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { setInboundAgentTool } = await loadClient();
    const error = await setInboundAgentTool('ag_1', 'google_sheets', {
      enabled: true,
      connection_id: 'conn-1',
    }).catch((e: unknown) => e as ApiError);

    expect(error.status).toBe(404);
    expect(error.code).toBe('INBOUND_NOT_ENABLED');
  });

  it('reports the platform release that has not shipped as a plain 404', async () => {
    // The inbound hook family does not exist yet. The route above turns this
    // into 501 INBOUND_ACTIONS_UNAVAILABLE; the adapter's job is only to not
    // dress it as an outage.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'NOT_FOUND' }, 404));
    vi.stubGlobal('fetch', fetchMock);

    const { getInboundLifecycleHooks, ApiError: Err } = await loadClient();
    const error = await getInboundLifecycleHooks('ag_1').catch((e: unknown) => e as ApiError);

    expect(error).toBeInstanceOf(Err);
    expect(error.status).toBe(404);
    expect(error.code).toBe('RESOURCE_NOT_FOUND');
  });
});
