import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Agent, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { as, makeAccount, makeWorkspace } from './helpers.js';

vi.mock('../src/adapter/vocobase.js', () => ({
  listAgents: vi.fn(),
  listVoices: vi.fn(),
  getAgent: vi.fn(),
  getAgentTools: vi.fn(),
  getAgentLifecycleHooks: vi.fn(),
}));

const client = await import('../src/adapter/vocobase.js');
const { ApiError } = await import('../src/lib/errors.js');
const { createApp } = await import('../src/app.js');

const app = createApp();

/** A hook row as the platform really serves it: camelCase, raw. */
function hookRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hook-1',
    stage: 'PRE_CALL',
    position: 0,
    toolSlug: 'google_sheets',
    toolFn: 'lookup_row',
    functionId: null,
    name: 'Pre-call sheet lookup',
    input: {
      match_mode: 'phone',
      match_column: 'phone_number',
      match_value: '{{callee_phone}}',
      sheet_name: 'Leads (Do not Delete)',
      spreadsheet_id: '18lDzz_63MbXSS71WUnZXJt-secret',
      columns: [
        { header: 'Contact Name', variable: 'contact_name' },
        { header: 'City', variable: 'customer_city' },
      ],
    },
    exposeAs: 'lead',
    required: false,
    timeoutMs: 3000,
    enabled: true,
    ...overrides,
  };
}

async function makeAgent(externalId: string, workspace: Workspace | null): Promise<Agent> {
  return prisma.agent.create({
    data: { externalId, name: `Agent ${externalId}`, workspaceId: workspace?.id ?? null },
  });
}

beforeEach(async () => {
  await truncateAll();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // The default for the ownership probe: the agent has no tool bound at all.
  // Every assertion about an OWNED row overrides it explicitly, so a test that
  // forgets to cannot pass by accident.
  vi.mocked(client.getAgentTools).mockResolvedValue({ tools: [] });
});

/** An upstream tools row binding `slug` to `connectionId` on this agent. */
function toolRow(slug: string, connectionId: string | null, enabled = true) {
  return { toolSlug: slug, toolName: slug, enabled, connectionId, status: 'ACTIVE' };
}

/** Records that `workspaceId` owns an upstream resource, as staff mapping does. */
async function own(
  kind: 'CONNECTION' | 'FUNCTION',
  externalId: string,
  workspaceId: string,
): Promise<void> {
  await prisma.workspaceResource.create({ data: { kind, externalId, workspaceId } });
}

describe('GET /agents/:agentId/lifecycle-hooks', () => {
  it('serves the hooks in snake_case with stage, source and run facts', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({
      hooks: [
        hookRow(),
        hookRow({ id: 'hook-2', stage: 'POST_CALL', name: 'Notify CRM', toolFn: 'post_activity', exposeAs: null, enabled: false }),
      ],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({
      id: 'hook-1',
      stage: 'pre_call',
      name: 'Pre-call sheet lookup',
      source: 'google_sheets · lookup_row',
      expose_as: 'lead',
      required: false,
      timeout_ms: 3000,
      enabled: true,
    });
    expect(res.body.data[1]).toMatchObject({ stage: 'post_call', enabled: false });
    expect(client.getAgentLifecycleHooks).toHaveBeenCalledWith('ext-1');
  });

  it('reports the variables a pre-call hook supplies, from expose_as and its lookup columns', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({ hooks: [hookRow()] });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data[0].supplies).toEqual(['contact_name', 'customer_city', 'lead']);
  });

  it('never emits the hook input template or anything else off the allow-list', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({
      hooks: [hookRow({ functionId: 'fn-internal-id' })],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    // The template names a spreadsheet id and the platform's internal ids —
    // configuration YE staff own, not something a member reads back.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('18lDzz_63MbXSS71WUnZXJt-secret');
    expect(serialized).not.toContain('phone_number');
    expect(serialized).not.toContain('fn-internal-id');
    expect(res.body.data[0]).not.toHaveProperty('input');
  });

  it('labels a function-backed hook without naming the function id', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({
      hooks: [hookRow({ toolSlug: null, toolFn: null, functionId: 'fn-9', name: 'Warm the CRM' })],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data[0].source).toBe('function');
    expect(JSON.stringify(res.body)).not.toContain('fn-9');
  });

  it('answers an empty list when the platform reports no hooks', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({ hooks: [] });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("answers 404 for another workspace's agent, without calling upstream", async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    const foreign = await makeAgent('ext-theirs', theirs);

    const res = await request(app)
      .get(`/api/workspaces/${mine.id}/agents/${foreign.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(client.getAgentLifecycleHooks).not.toHaveBeenCalled();
  });

  it('answers 404 for an unassigned agent, without calling upstream', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const unassigned = await makeAgent('ext-pool', null);

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${unassigned.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(404);
    expect(client.getAgentLifecycleHooks).not.toHaveBeenCalled();
  });

  it('answers 404 for an agent id that names nothing', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/nope/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(404);
    expect(client.getAgentLifecycleHooks).not.toHaveBeenCalled();
  });

  it('passes an upstream failure through as the mapped error, not an empty list', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    vi.mocked(client.getAgentLifecycleHooks).mockRejectedValue(
      new ApiError(502, 'UPSTREAM_ERROR', 'The voice platform could not complete that request.'),
    );

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_ERROR');
  });
});

describe('what a hook says it supplies', () => {
  it('names each variable once, however many columns map to it', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Acme');
    const agent = await makeAgent('ext-supplies', workspace);

    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({
      hooks: [
        {
          id: 'h-1',
          stage: 'PRE_CALL',
          name: 'Sheet lookup',
          exposeAs: 'lead',
          input: {
            columns: [
              { header: 'Name', variable: 'lead' },
              { header: 'Full name', variable: 'lead' },
            ],
          },
        },
      ],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data[0].supplies).toEqual(['lead']);
  });

  /**
   * `supplies` alone cannot say whether a name missing from it is a typo.
   *
   * A sheet `lookup_row` ENUMERATES its output fields, so a reference to
   * something it does not list renders empty and is a genuine mistake. A CRM
   * or store lookup returns an opaque object under `expose_as`, so the same
   * absence proves nothing — the field may well arrive at call time. Reading
   * the two the same way either hides real typos or flags every working
   * reference, so the row says which kind of source it is.
   */
  it('marks a hook that enumerates its output fields', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Acme');
    const agent = await makeAgent('ext-enumerates', workspace);

    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({ hooks: [hookRow()] });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data[0].declares_fields).toBe(true);
  });

  it('marks a hook returning an opaque object as enumerating nothing', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Acme');
    const agent = await makeAgent('ext-opaque', workspace);

    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({
      hooks: [
        {
          id: 'h-crm',
          stage: 'PRE_CALL',
          name: 'CRM lookup',
          toolSlug: 'hubspot',
          toolFn: 'get_contact',
          exposeAs: 'lead',
          input: { object_type: 'contact', match_value: '{{callee_phone}}' },
        },
      ],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data[0].declares_fields).toBe(false);
    // Everything it supplies still arrives under one name, so a dotted
    // reference into it cannot be judged from this row.
    expect(res.body.data[0].supplies).toEqual(['lead']);
  });

  /**
   * An empty list is a source that enumerates its fields and maps none of
   * them, not an opaque one. Both render a bare `{{name}}` empty, and the
   * remedy — map the column — is the enumerating one.
   */
  it('does not call an empty column list an enumeration', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Acme');
    const agent = await makeAgent('ext-empty-columns', workspace);

    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({
      hooks: [{ id: 'h-1', stage: 'PRE_CALL', name: 'Sheet lookup', input: { columns: [] } }],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data[0].declares_fields).toBe(false);
  });

  /**
   * The flag describes the hook's configuration, not the stage it runs at —
   * so it stays true on a post-call action whose `supplies` is deliberately
   * empty. Pairing the two is a pre-call question; `stage` is what answers
   * whether to ask it at all.
   */
  it('describes the configuration, not the stage', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Acme');
    const agent = await makeAgent('ext-post-columns', workspace);

    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({
      hooks: [
        {
          id: 'h-2',
          stage: 'POST_CALL',
          name: 'Sheet append',
          input: { columns: [{ header: 'Outcome', variable: 'outcome' }] },
        },
      ],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data[0].declares_fields).toBe(true);
    expect(res.body.data[0].supplies).toEqual([]);
  });

  it('claims nothing for a post-call action, which supplies the call nothing', async () => {
    // `supplies` exists so the Variables surface can say where a value comes
    // from. A post-call action runs after the call is over; listing its
    // `expose_as` here advertises a variable that never exists during the call.
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Acme');
    const agent = await makeAgent('ext-post', workspace);

    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({
      hooks: [
        {
          id: 'h-2',
          stage: 'POST_CALL',
          name: 'CRM write',
          exposeAs: 'crm_result',
          input: { columns: [{ header: 'Outcome', variable: 'outcome' }] },
        },
      ],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data[0].stage).toBe('post_call');
    expect(res.body.data[0].supplies).toEqual([]);
  });
});

describe('the shape of a lifecycle hook', () => {
  it('is locked to the summary, so a new upstream field cannot ride along', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Acme');
    const agent = await makeAgent('ext-shape', workspace);

    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({
      hooks: [
        {
          id: 'h-1',
          stage: 'PRE_CALL',
          position: 1,
          name: 'Sheet lookup',
          toolSlug: 'google_sheets',
          toolFn: 'lookup_row',
          exposeAs: 'lead',
          required: true,
          timeoutMs: 3000,
          enabled: true,
          functionId: 'fn-internal-999',
          input: {
            spreadsheetId: 'sheet-secret-123',
            matchColumn: 'Phone',
            columns: [{ header: 'Customer name', variable: 'contact_name' }],
          },
        },
      ],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data).toEqual([
      {
        id: 'h-1',
        stage: 'pre_call',
        position: 1,
        name: 'Sheet lookup',
        source: 'google_sheets · lookup_row',
        expose_as: 'lead',
        supplies: ['contact_name', 'lead'],
        declares_fields: true,
        required: true,
        timeout_ms: 3000,
        enabled: true,
        owned: false,
      },
    ]);
    // The template and the platform's internals stay behind.
    const body = JSON.stringify(res.body);
    for (const secret of ['sheet-secret-123', 'fn-internal-999', 'Customer name', 'Phone']) {
      expect(body).not.toContain(secret);
    }
  });

  it('is locked to the full shape when the row IS owned', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Acme');
    const agent = await makeAgent('ext-shape-owned', workspace);
    await own('CONNECTION', 'conn-alice', workspace.id);
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow('google_sheets', 'conn-alice')],
    });

    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({
      hooks: [
        {
          id: 'h-1',
          stage: 'PRE_CALL',
          position: 1,
          name: 'Sheet lookup',
          toolSlug: 'google_sheets',
          toolFn: 'lookup_row',
          exposeAs: 'lead',
          required: true,
          timeoutMs: 3000,
          enabled: true,
          functionId: null,
          input: { spreadsheetId: 'sheet-1', columns: [{ header: 'Name', variable: 'n' }] },
          // Upstream grew a field. The owned shape widened once, on purpose;
          // it must not keep widening on its own.
          internalAuditToken: 'tok-999',
        },
      ],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(Object.keys(res.body.data[0]).sort()).toEqual([
      'declares_fields',
      'enabled',
      'expose_as',
      'function_id',
      'id',
      'input',
      'name',
      'owned',
      'position',
      'required',
      'skip_unless',
      'source',
      'stage',
      'supplies',
      'timeout_ms',
      'tool_fn',
      'tool_slug',
    ]);
    // `input` is passed through whole — its shape is the source's, and an
    // allow-list here would drop the input of every source added after it.
    // Everything OUTSIDE it is still rebuilt field by field.
    expect(res.body.data[0].input).toEqual({
      spreadsheetId: 'sheet-1',
      columns: [{ header: 'Name', variable: 'n' }],
    });
    expect(JSON.stringify(res.body)).not.toContain('tok-999');
  });

  it('orders the actions the way the platform sequences them', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Acme');
    const agent = await makeAgent('ext-order', workspace);

    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({
      hooks: [
        { id: 'c', stage: 'PRE_CALL', position: 3, name: 'third' },
        { id: 'a', stage: 'PRE_CALL', position: 1, name: 'first' },
        { id: 'b', stage: 'PRE_CALL', position: 2, name: 'second' },
      ],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data.map((h: { name: string }) => h.name)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('drops a row that is not a hook rather than inventing one', async () => {
    // A null or a bare string is not an action. Rebuilding it into a row of
    // nulls whose `source` reads "function" asserts a fact about garbage.
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Acme');
    const agent = await makeAgent('ext-garbage', workspace);

    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({
      hooks: ['nope', null, 42, { id: 'h-real', stage: 'PRE_CALL', name: 'real' }] as never,
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('real');
  });
});

/**
 * The extended read.
 *
 * The rows stopped being YE-staff configuration the moment a workspace could
 * create them, so a row whose source the workspace owns comes back in full —
 * its input template is the thing the editor loads to let somebody change it.
 * A row bound to a pool connection staff configured keeps the old summary
 * shape, and the flag says which is which so the dashboard does not have to
 * guess whether an empty `input` means "none" or "not yours".
 */
describe('GET /lifecycle-hooks — what the workspace owns', () => {
  it('returns an owned Sheets hook in full, with its input and source ids', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    await own('CONNECTION', 'conn-alice', workspace.id);
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow('google_sheets', 'conn-alice')],
    });
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({
      hooks: [hookRow({ skipUnless: ['extraction.email'] })],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      owned: true,
      tool_slug: 'google_sheets',
      tool_fn: 'lookup_row',
      function_id: null,
      skip_unless: ['extraction.email'],
    });
    expect(res.body.data[0].input).toMatchObject({
      spreadsheet_id: '18lDzz_63MbXSS71WUnZXJt-secret',
      match_column: 'phone_number',
    });
    // The summary fields the Variables list already reads are unchanged.
    expect(res.body.data[0].supplies).toEqual(['contact_name', 'customer_city', 'lead']);
    expect(res.body.data[0].source).toBe('google_sheets · lookup_row');
  });

  it('withholds the input of a staff-bound hook, and says it is not owned', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    // The binding exists and is live — it is simply somebody else's connection.
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow('google_sheets', 'conn-staff')],
    });
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({ hooks: [hookRow()] });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data[0].owned).toBe(false);
    expect(res.body.data[0]).not.toHaveProperty('input');
    expect(res.body.data[0]).not.toHaveProperty('tool_slug');
    expect(JSON.stringify(res.body)).not.toContain('18lDzz_63MbXSS71WUnZXJt-secret');
  });

  it('refuses to read an unbound tool row as ownership', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    // The tools LIST reads a null connection as owned — a built-in is the
    // workspace's to switch. A HOOK is a different question: a Google source
    // with no connection behind it is staff's, and reading the null as
    // ownership would hand every workspace the spreadsheet id on it.
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow('google_sheets', null, false)],
    });
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({ hooks: [hookRow()] });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data[0].owned).toBe(false);
  });

  it('owns a hook whose binding is mapped here but switched off', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    await own('CONNECTION', 'conn-alice', workspace.id);
    // Disabling the tool does not transfer the hook to somebody else, and a
    // reader who cannot see their own template cannot switch it back on
    // knowing what it does.
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow('google_sheets', 'conn-alice', false)],
    });
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({ hooks: [hookRow()] });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data[0].owned).toBe(true);
  });

  it('returns a function hook in full when the workspace owns the function', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    await own('FUNCTION', 'fn-9', workspace.id);
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({
      hooks: [hookRow({ toolSlug: null, toolFn: null, functionId: 'fn-9', input: { a: 1 } })],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data[0]).toMatchObject({
      owned: true,
      function_id: 'fn-9',
      tool_slug: null,
      input: { a: 1 },
    });
  });

  it('does not own a function hook whose function belongs to another workspace', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    const agent = await makeAgent('ext-1', workspace);
    await own('FUNCTION', 'fn-9', theirs.id);
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({
      hooks: [hookRow({ toolSlug: null, toolFn: null, functionId: 'fn-9', input: { a: 1 } })],
    });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.body.data[0].owned).toBe(false);
    expect(res.body.data[0]).not.toHaveProperty('input');
  });

  it('asks the platform for the agent’s tools once, however many hooks there are', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    await own('CONNECTION', 'conn-alice', workspace.id);
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow('google_sheets', 'conn-alice'), toolRow('gmail', 'conn-alice')],
    });
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({
      hooks: [
        hookRow({ id: 'a' }),
        hookRow({ id: 'b', toolSlug: 'gmail', toolFn: 'send_email', stage: 'POST_CALL' }),
        hookRow({ id: 'c' }),
      ],
    });

    await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(client.getAgentTools).toHaveBeenCalledTimes(1);
  });

  it('does not ask for the agent’s tools when no hook names one', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent('ext-1', workspace);
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({
      hooks: [hookRow({ toolSlug: null, toolFn: null, functionId: 'fn-9' })],
    });

    await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(client.getAgentTools).not.toHaveBeenCalled();
  });
});
