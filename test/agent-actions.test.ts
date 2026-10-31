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
  setAgentTool: vi.fn(),
  getAgentLifecycleHooks: vi.fn(),
  createAgentLifecycleHook: vi.fn(),
  updateAgentLifecycleHook: vi.fn(),
  deleteAgentLifecycleHook: vi.fn(),
  reorderAgentLifecycleHooks: vi.fn(),
  previewAgentLifecycleHook: vi.fn(),
  getSheetColumns: vi.fn(),
  listIntegrationLogs: vi.fn(),
  getInboundLifecycleHooks: vi.fn(),
  replaceInboundLifecycleHooks: vi.fn(),
  createInboundLifecycleHook: vi.fn(),
  updateInboundLifecycleHook: vi.fn(),
  deleteInboundLifecycleHook: vi.fn(),
  reorderInboundLifecycleHooks: vi.fn(),
  previewInboundLifecycleHook: vi.fn(),
  setInboundAgentTool: vi.fn(),
  getInboundAgentTools: vi.fn(),
}));

const client = await import('../src/adapter/vocobase.js');
const { ApiError } = await import('../src/lib/errors.js');
const { createApp } = await import('../src/app.js');

const app = createApp();

async function makeAgent(
  externalId: string,
  workspace: Workspace | null,
  data: Partial<Agent> = {},
): Promise<Agent> {
  return prisma.agent.create({
    data: {
      externalId,
      name: `Agent ${externalId}`,
      workspaceId: workspace?.id ?? null,
      ...data,
    },
  });
}

function toolRow(slug: string, connectionId: string | null, enabled = true) {
  return { toolSlug: slug, toolName: slug, enabled, connectionId, status: 'ACTIVE' };
}

async function own(
  kind: 'CONNECTION' | 'FUNCTION',
  externalId: string,
  workspaceId: string,
): Promise<void> {
  await prisma.workspaceResource.create({ data: { kind, externalId, workspaceId } });
}

/** The hook the platform answers a create with, in its own camelCase. */
function createdHook(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hook-new',
    stage: 'PRE_CALL',
    position: 0,
    name: 'Look up the lead',
    toolSlug: 'google_sheets',
    toolFn: 'lookup_row',
    functionId: null,
    input: { spreadsheet_id: 'sheet-1', match_column: 'Phone', columns: [] },
    exposeAs: 'lead',
    required: false,
    timeoutMs: 3000,
    enabled: true,
    ...overrides,
  };
}

const SHEET_BODY = {
  stage: 'pre_call',
  name: 'Look up the lead',
  source: { kind: 'tool', tool_slug: 'google_sheets', tool_fn: 'lookup_row' },
  input: { spreadsheet_id: 'sheet-1', match_column: 'Phone', columns: [] },
  expose_as: 'lead',
};

let alice: Awaited<ReturnType<typeof makeAccount>>;
let workspace: Workspace;
let agent: Agent;

beforeEach(async () => {
  await truncateAll();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(client.getAgentTools).mockResolvedValue({ tools: [] });
  vi.mocked(client.createAgentLifecycleHook).mockResolvedValue({ hook: createdHook() });

  alice = await makeAccount('alice');
  workspace = await makeWorkspace(alice, 'Alice Co');
  agent = await makeAgent('ext-1', workspace);
});

const auth = () => as('user_alice', 'alice@ezo.test');
const post = (body: unknown) =>
  request(app)
    .post(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
    .set(...auth())
    .send(body as object);

describe('POST /lifecycle-hooks — a tool action', () => {
  it('binds the tool to the named connection, then creates the hook', async () => {
    await own('CONNECTION', 'conn-alice', workspace.id);

    const res = await post({
      ...SHEET_BODY,
      source: { ...SHEET_BODY.source, connection_id: 'conn-alice' },
    });

    expect(res.status).toBe(201);
    // Bound BEFORE the hook: the platform 422s TOOL_NOT_CONNECTED otherwise,
    // and the caller would be told their input was wrong when it was not.
    expect(client.setAgentTool).toHaveBeenCalledWith('ext-1', 'google_sheets', {
      enabled: true,
      connection_id: 'conn-alice',
    });
    expect(client.createAgentLifecycleHook).toHaveBeenCalledWith('ext-1', {
      stage: 'PRE_CALL',
      name: 'Look up the lead',
      toolSlug: 'google_sheets',
      toolFn: 'lookup_row',
      input: { spreadsheet_id: 'sheet-1', match_column: 'Phone', columns: [] },
      exposeAs: 'lead',
    });
    const setOrder = vi.mocked(client.setAgentTool).mock.invocationCallOrder[0];
    const createOrder = vi.mocked(client.createAgentLifecycleHook).mock.invocationCallOrder[0];
    expect(setOrder).toBeLessThan(createOrder);
  });

  it('leaves an already-bound tool alone and ignores the connection it names', async () => {
    await own('CONNECTION', 'conn-alice', workspace.id);
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow('google_sheets', 'conn-alice')],
    });

    const res = await post({
      ...SHEET_BODY,
      source: { ...SHEET_BODY.source, connection_id: 'conn-other' },
    });

    expect(res.status).toBe(201);
    expect(client.setAgentTool).not.toHaveBeenCalled();
  });

  it('refuses to enable a tool without naming a connection', async () => {
    const res = await post(SHEET_BODY);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(client.setAgentTool).not.toHaveBeenCalled();
    expect(client.createAgentLifecycleHook).not.toHaveBeenCalled();
  });

  it("refuses a connection another workspace owns, without reaching the platform", async () => {
    const bob = await makeAccount('bob');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    await own('CONNECTION', 'conn-bob', theirs.id);

    const res = await post({
      ...SHEET_BODY,
      source: { ...SHEET_BODY.source, connection_id: 'conn-bob' },
    });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(client.setAgentTool).not.toHaveBeenCalled();
    expect(client.createAgentLifecycleHook).not.toHaveBeenCalled();
  });

  it('refuses when the tool is already bound to a connection this workspace does not own', async () => {
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow('google_sheets', 'conn-staff')],
    });

    const res = await post({
      ...SHEET_BODY,
      source: { ...SHEET_BODY.source, connection_id: 'conn-alice' },
    });

    // The same 404 every other unowned-resource refusal answers: that a
    // connection for this tool exists on the partner account is exactly the
    // fact a workspace without one must not learn.
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(client.createAgentLifecycleHook).not.toHaveBeenCalled();
  });

  it('serializes the created row as owned, with its input', async () => {
    await own('CONNECTION', 'conn-alice', workspace.id);
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow('google_sheets', 'conn-alice')],
    });

    const res = await post(SHEET_BODY);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      id: 'hook-new',
      stage: 'pre_call',
      owned: true,
      tool_slug: 'google_sheets',
      input: { spreadsheet_id: 'sheet-1' },
    });
  });
});

describe('POST /lifecycle-hooks — a function action', () => {
  it('creates against a function the workspace owns', async () => {
    await own('FUNCTION', 'fn-9', workspace.id);
    vi.mocked(client.createAgentLifecycleHook).mockResolvedValue({
      hook: createdHook({ toolSlug: null, toolFn: null, functionId: 'fn-9' }),
    });

    const res = await post({
      stage: 'post_call',
      name: 'Warm the CRM',
      source: { kind: 'function', function_id: 'fn-9' },
      input: { contact: '{{ezo_contact_id}}' },
    });

    expect(res.status).toBe(201);
    expect(client.createAgentLifecycleHook).toHaveBeenCalledWith('ext-1', {
      stage: 'POST_CALL',
      name: 'Warm the CRM',
      functionId: 'fn-9',
      input: { contact: '{{ezo_contact_id}}' },
    });
    expect(client.setAgentTool).not.toHaveBeenCalled();
  });

  it("404s a function another workspace owns, without reaching the platform", async () => {
    const bob = await makeAccount('bob');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    await own('FUNCTION', 'fn-9', theirs.id);

    const res = await post({
      stage: 'post_call',
      name: 'Warm the CRM',
      source: { kind: 'function', function_id: 'fn-9' },
      input: {},
    });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(client.createAgentLifecycleHook).not.toHaveBeenCalled();
  });
});

describe('POST /lifecycle-hooks — the body', () => {
  it('requires expose_as for a pre-call sheet lookup', async () => {
    await own('CONNECTION', 'conn-alice', workspace.id);
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow('google_sheets', 'conn-alice')],
    });

    const { expose_as: _dropped, ...withoutExposeAs } = SHEET_BODY;
    const res = await post(withoutExposeAs);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(client.createAgentLifecycleHook).not.toHaveBeenCalled();
  });

  it('refuses skip_unless on a pre-call action', async () => {
    await own('CONNECTION', 'conn-alice', workspace.id);
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow('google_sheets', 'conn-alice')],
    });

    const res = await post({ ...SHEET_BODY, skip_unless: ['extraction.email'] });

    expect(res.status).toBe(400);
    expect(client.createAgentLifecycleHook).not.toHaveBeenCalled();
  });

  it('carries skip_unless on a post-call action', async () => {
    await own('FUNCTION', 'fn-9', workspace.id);
    vi.mocked(client.createAgentLifecycleHook).mockResolvedValue({
      hook: createdHook({ toolSlug: null, toolFn: null, functionId: 'fn-9', stage: 'POST_CALL' }),
    });

    const res = await post({
      stage: 'post_call',
      name: 'Book it',
      source: { kind: 'function', function_id: 'fn-9' },
      input: {},
      skip_unless: ['extraction.callback_at'],
    });

    expect(res.status).toBe(201);
    expect(client.createAgentLifecycleHook).toHaveBeenCalledWith(
      'ext-1',
      expect.objectContaining({ skipUnless: ['extraction.callback_at'] }),
    );
  });

  it('caps skip_unless at the platform’s ten paths', async () => {
    await own('FUNCTION', 'fn-9', workspace.id);
    const eleven = Array.from({ length: 11 }, (_, i) => `extraction.f${i}`);

    const res = await post({
      stage: 'post_call',
      name: 'Book it',
      source: { kind: 'function', function_id: 'fn-9' },
      input: {},
      skip_unless: eleven,
    });

    // Refused HERE rather than upstream: the platform's 422 would arrive
    // as VALIDATION_FAILED with a path the form has to map, when the
    // shape rule is known before the request leaves.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(client.createAgentLifecycleHook).not.toHaveBeenCalled();
  });

  it('caps timeout_ms at the platform’s 30 s, locally, before anything upstream', async () => {
    // crud.service.ts:82 TIMEOUT_MAX_MS = 30_000. Past it the platform would
    // 422 the hook, after this route had already bound the tool.
    await own('CONNECTION', 'conn-alice', workspace.id);
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow('google_sheets', 'conn-alice')],
    });

    const over = await post({ ...SHEET_BODY, timeout_ms: 30_001 });

    expect(over.status).toBe(400);
    expect(client.getAgentTools).not.toHaveBeenCalled();
    expect(client.createAgentLifecycleHook).not.toHaveBeenCalled();

    const atCap = await post({ ...SHEET_BODY, timeout_ms: 30_000 });

    expect(atCap.status).toBe(201);
    expect(client.createAgentLifecycleHook).toHaveBeenCalledWith(
      'ext-1',
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });

  it('refuses a tool slug that is not one of the three sources', async () => {
    const res = await post({
      ...SHEET_BODY,
      source: { kind: 'tool', tool_slug: 'salesforce', tool_fn: 'x', connection_id: 'c' },
    });

    expect(res.status).toBe(400);
    expect(client.createAgentLifecycleHook).not.toHaveBeenCalled();
  });

  it("passes the platform's 422 issues through untouched", async () => {
    await own('FUNCTION', 'fn-9', workspace.id);
    const issues = [{ path: 'input.columns[2].header', message: 'Required' }];
    vi.mocked(client.createAgentLifecycleHook).mockRejectedValue(
      new ApiError(422, 'VALIDATION_FAILED', 'The voice platform rejected those values.', {
        issues,
      }),
    );

    const res = await post({
      stage: 'post_call',
      name: 'x',
      source: { kind: 'function', function_id: 'fn-9' },
      input: {},
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.details).toEqual({ issues });
  });
});

describe('POST /lifecycle-hooks — who may', () => {
  it("404s another workspace's agent without reaching the platform", async () => {
    const bob = await makeAccount('bob');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    const foreign = await makeAgent('ext-theirs', theirs);

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents/${foreign.id}/lifecycle-hooks`)
      .set(...auth())
      .send(SHEET_BODY);

    expect(res.status).toBe(404);
    expect(client.createAgentLifecycleHook).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`)
      .send(SHEET_BODY);

    expect(res.status).toBe(401);
  });
});

/**
 * Every write below re-reads the agent's hook list first.
 *
 * The id in the path is the only thing the caller supplies, and the platform
 * would happily patch a hook belonging to an agent in another workspace if
 * asked — the partner key authenticates YE, not the reader. So ownership is
 * resolved the same way the list renders it, against the list itself: an id
 * that is not in it, or is in it and is not this workspace's, is 404
 * RESOURCE_NOT_FOUND. The two are deliberately the same answer.
 */
describe('PATCH /lifecycle-hooks/:hookId', () => {
  beforeEach(async () => {
    await own('CONNECTION', 'conn-alice', workspace.id);
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow('google_sheets', 'conn-alice')],
    });
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({ hooks: [createdHook()] });
    vi.mocked(client.updateAgentLifecycleHook).mockResolvedValue({
      hook: createdHook({ name: 'Renamed' }),
    });
  });

  const patch = (hookId: string, body: unknown) =>
    request(app)
      .patch(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks/${hookId}`)
      .set(...auth())
      .send(body as object);

  it('updates an owned hook and answers the new row', async () => {
    const res = await patch('hook-new', { name: 'Renamed', enabled: false });

    expect(res.status).toBe(200);
    expect(client.updateAgentLifecycleHook).toHaveBeenCalledWith('ext-1', 'hook-new', {
      name: 'Renamed',
      enabled: false,
    });
    expect(res.body.data).toMatchObject({ name: 'Renamed', owned: true });
  });

  it('404s a hook id the agent does not have', async () => {
    const res = await patch('hook-nope', { name: 'Renamed' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(client.updateAgentLifecycleHook).not.toHaveBeenCalled();
  });

  it('404s a hook the workspace does not own, rather than saying whose it is', async () => {
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow('google_sheets', 'conn-staff')],
    });

    const res = await patch('hook-new', { name: 'Renamed' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(client.updateAgentLifecycleHook).not.toHaveBeenCalled();
  });

  it('keeps a base-side upstream 404 as RESOURCE_NOT_FOUND, never the undeployed-release 501', async () => {
    // The id was in the list a moment ago and is gone now (somebody else
    // deleted it). That is a fact about the hook; the 501 is a fact about
    // the platform's deployment and only a FACE call can mean it.
    vi.mocked(client.updateAgentLifecycleHook).mockRejectedValue(
      new ApiError(404, 'RESOURCE_NOT_FOUND', 'Not found.'),
    );

    const res = await patch('hook-new', { name: 'Renamed' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('caps timeout_ms at 30 s on a patch too, without reaching the platform', async () => {
    const over = await patch('hook-new', { timeout_ms: 30_001 });

    expect(over.status).toBe(400);
    expect(client.getAgentLifecycleHooks).not.toHaveBeenCalled();
    expect(client.updateAgentLifecycleHook).not.toHaveBeenCalled();

    const atCap = await patch('hook-new', { timeout_ms: 30_000 });

    expect(atCap.status).toBe(200);
    expect(client.updateAgentLifecycleHook).toHaveBeenCalledWith('ext-1', 'hook-new', {
      timeoutMs: 30_000,
    });
  });

  it('refuses an empty body rather than sending a no-op upstream', async () => {
    const res = await patch('hook-new', {});

    expect(res.status).toBe(400);
    expect(client.updateAgentLifecycleHook).not.toHaveBeenCalled();
  });

  it('refuses to move a hook between stages or sources', async () => {
    for (const body of [
      { stage: 'post_call' },
      { source: { kind: 'function', function_id: 'fn-9' } },
    ]) {
      const res = await patch('hook-new', body);
      expect(res.status).toBe(400);
    }
    expect(client.updateAgentLifecycleHook).not.toHaveBeenCalled();
  });

  it('carries skip_unless onto a post-call hook', async () => {
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({
      hooks: [createdHook({ stage: 'POST_CALL', exposeAs: null })],
    });
    vi.mocked(client.updateAgentLifecycleHook).mockResolvedValue({
      hook: createdHook({ stage: 'POST_CALL', exposeAs: null }),
    });

    const res = await patch('hook-new', { skip_unless: ['extraction.email'] });

    expect(res.status).toBe(200);
    expect(client.updateAgentLifecycleHook).toHaveBeenCalledWith('ext-1', 'hook-new', {
      skipUnless: ['extraction.email'],
    });
  });

  it('caps skip_unless at ten paths on a patch too', async () => {
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({
      hooks: [createdHook({ stage: 'POST_CALL', exposeAs: null })],
    });
    const eleven = Array.from({ length: 11 }, (_, i) => `extraction.f${i}`);

    const res = await patch('hook-new', { skip_unless: eleven });

    expect(res.status).toBe(400);
    expect(client.updateAgentLifecycleHook).not.toHaveBeenCalled();
  });

  it('refuses skip_unless on a pre-call hook, reading the stage off the stored row', async () => {
    const res = await patch('hook-new', { skip_unless: ['extraction.email'] });

    expect(res.status).toBe(400);
    expect(client.updateAgentLifecycleHook).not.toHaveBeenCalled();
  });

  it('clears an optional field when the caller sends null', async () => {
    const res = await patch('hook-new', { expose_as: null });

    expect(res.status).toBe(200);
    expect(client.updateAgentLifecycleHook).toHaveBeenCalledWith('ext-1', 'hook-new', {
      exposeAs: null,
    });
  });
});

describe('DELETE /lifecycle-hooks/:hookId', () => {
  beforeEach(async () => {
    await own('CONNECTION', 'conn-alice', workspace.id);
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow('google_sheets', 'conn-alice')],
    });
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({ hooks: [createdHook()] });
    vi.mocked(client.deleteAgentLifecycleHook).mockResolvedValue(undefined);
  });

  const del = (hookId: string) =>
    request(app)
      .delete(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks/${hookId}`)
      .set(...auth());

  it('deletes an owned hook', async () => {
    const res = await del('hook-new');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ deleted: true });
    expect(client.deleteAgentLifecycleHook).toHaveBeenCalledWith('ext-1', 'hook-new');
  });

  it('404s an unowned hook without deleting anything', async () => {
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow('google_sheets', 'conn-staff')],
    });

    const res = await del('hook-new');

    expect(res.status).toBe(404);
    expect(client.deleteAgentLifecycleHook).not.toHaveBeenCalled();
  });
});

describe('POST /lifecycle-hooks/reorder', () => {
  beforeEach(async () => {
    await own('CONNECTION', 'conn-alice', workspace.id);
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow('google_sheets', 'conn-alice')],
    });
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({
      hooks: [
        createdHook({ id: 'h-1', position: 0 }),
        createdHook({ id: 'h-2', position: 1 }),
        createdHook({ id: 'h-3', stage: 'POST_CALL', position: 0, exposeAs: null }),
      ],
    });
    vi.mocked(client.reorderAgentLifecycleHooks).mockResolvedValue({ hooks: [] });
  });

  const reorder = (body: unknown) =>
    request(app)
      .post(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks/reorder`)
      .set(...auth())
      .send(body as object);

  it('reorders one stage', async () => {
    const res = await reorder({ stage: 'pre_call', ids: ['h-2', 'h-1'] });

    expect(res.status).toBe(200);
    expect(client.reorderAgentLifecycleHooks).toHaveBeenCalledWith('ext-1', {
      stage: 'PRE_CALL',
      ids: ['h-2', 'h-1'],
    });
  });

  it('404s when any id in the list is not an owned hook of this stage', async () => {
    // One foreign id is enough. Reordering is replace-all upstream, so a list
    // that names a hook the caller may not touch is a request to rewrite the
    // whole stage around it.
    const res = await reorder({ stage: 'pre_call', ids: ['h-2', 'h-nope'] });

    expect(res.status).toBe(404);
    expect(client.reorderAgentLifecycleHooks).not.toHaveBeenCalled();
  });

  it('refuses a list that names a hook from the other stage', async () => {
    const res = await reorder({ stage: 'pre_call', ids: ['h-1', 'h-3'] });

    expect(res.status).toBe(404);
    expect(client.reorderAgentLifecycleHooks).not.toHaveBeenCalled();
  });

  it('refuses a partial list, which upstream would read as a deletion', async () => {
    const res = await reorder({ stage: 'pre_call', ids: ['h-1'] });

    expect(res.status).toBe(400);
    expect(client.reorderAgentLifecycleHooks).not.toHaveBeenCalled();
  });

  it('refuses a repeated id', async () => {
    const res = await reorder({ stage: 'pre_call', ids: ['h-1', 'h-1'] });

    expect(res.status).toBe(400);
    expect(client.reorderAgentLifecycleHooks).not.toHaveBeenCalled();
  });
});

describe('POST /lifecycle-hooks/:hookId/preview', () => {
  beforeEach(async () => {
    await own('CONNECTION', 'conn-alice', workspace.id);
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow('google_sheets', 'conn-alice')],
    });
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({ hooks: [createdHook()] });
    vi.mocked(client.previewAgentLifecycleHook).mockResolvedValue({
      renderedInput: { match_value: '+919000000001' },
      hook: createdHook(),
      skipped: false,
    });
  });

  const preview = (hookId: string, body: unknown = {}) =>
    request(app)
      .post(
        `/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks/${hookId}/preview`,
      )
      .set(...auth())
      .send(body as object);

  it('renders the template against the caller’s sample variables', async () => {
    const res = await preview('hook-new', { variables: { callee_phone: '+919000000001' } });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      input: { match_value: '+919000000001' },
      skipped: false,
      skipped_on: null,
    });
    expect(client.previewAgentLifecycleHook).toHaveBeenCalledWith('ext-1', 'hook-new', {
      variables: { callee_phone: '+919000000001' },
    });
  });

  it('says which skip_unless path would have skipped the action — one path, not a list', async () => {
    vi.mocked(client.previewAgentLifecycleHook).mockResolvedValue({
      renderedInput: {},
      hook: createdHook({ stage: 'POST_CALL', exposeAs: null }),
      skipped: true,
      skippedOn: 'extraction.email',
    });

    const res = await preview('hook-new', { variables: {} });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ input: {}, skipped: true, skipped_on: 'extraction.email' });
  });

  it('reads the render from `renderedInput` only, the one key the platform sends', async () => {
    // crud.service.ts:1057,1105 — previewHook returns `renderedInput`; the
    // base route answers it as is (lifecycle-hooks.routes.ts:197).
    vi.mocked(client.previewAgentLifecycleHook).mockResolvedValue({
      input: { a: 1 },
    } as never);

    const res = await preview('hook-new');

    expect(res.body.data).toEqual({ input: {}, skipped: false, skipped_on: null });
  });

  it('404s a hook the workspace does not own', async () => {
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow('google_sheets', 'conn-staff')],
    });

    const res = await preview('hook-new');

    expect(res.status).toBe(404);
    expect(client.previewAgentLifecycleHook).not.toHaveBeenCalled();
  });
});

describe('GET /tools/google_sheets/sheet-columns', () => {
  const columns = (query: string) =>
    request(app)
      .get(
        `/api/workspaces/${workspace.id}/agents/${agent.id}/tools/google_sheets/sheet-columns?${query}`,
      )
      .set(...auth());

  beforeEach(async () => {
    await own('CONNECTION', 'conn-alice', workspace.id);
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow('google_sheets', 'conn-alice')],
    });
    vi.mocked(client.getSheetColumns).mockResolvedValue({
      columns: ['Name', 'Phone'],
      sheet_name: 'Leads',
      spreadsheet_id: 'sheet-1',
      tabs: ['Leads', 'Archive'],
      truncated: false,
    });
  });

  it('proxies one sheet’s headers and the workbook’s tabs for an owned binding', async () => {
    const res = await columns('spreadsheet_id=sheet-1&sheet_name=Leads');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      columns: ['Name', 'Phone'],
      sheet_name: 'Leads',
      tabs: ['Leads', 'Archive'],
      truncated: false,
    });
    expect(res.body.data).not.toHaveProperty('sheets');
    expect(client.getSheetColumns).toHaveBeenCalledWith('ext-1', {
      spreadsheet_id: 'sheet-1',
      sheet_name: 'Leads',
    });
  });

  it('asks for the workbook’s tabs when no sheet is named, and says which tab was read', async () => {
    // The platform reads the first tab when none is named and says which.
    const res = await columns('spreadsheet_id=sheet-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ sheet_name: 'Leads', tabs: ['Leads', 'Archive'] });
    expect(client.getSheetColumns).toHaveBeenCalledWith('ext-1', { spreadsheet_id: 'sheet-1' });
  });

  it('flags a header row the platform cut short', async () => {
    vi.mocked(client.getSheetColumns).mockResolvedValue({ columns: ['A'], truncated: true });

    const res = await columns('spreadsheet_id=sheet-1');

    expect(res.body.data).toMatchObject({ columns: ['A'], tabs: [], truncated: true });
  });

  it('requires a spreadsheet id', async () => {
    const res = await columns('sheet_name=Leads');

    expect(res.status).toBe(400);
    expect(client.getSheetColumns).not.toHaveBeenCalled();
  });

  it('404s when the binding belongs to another workspace', async () => {
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow('google_sheets', 'conn-staff')],
    });

    const res = await columns('spreadsheet_id=sheet-1');

    expect(res.status).toBe(404);
    expect(client.getSheetColumns).not.toHaveBeenCalled();
  });

  it('409s INTEGRATION_NOT_CONNECTED when the platform says the account is gone', async () => {
    vi.mocked(client.getSheetColumns).mockRejectedValue(
      new ApiError(409, 'NOT_CONNECTED', 'Google Sheets is not connected.'),
    );

    const res = await columns('spreadsheet_id=sheet-1');

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_NOT_CONNECTED');
  });

  it('404s TAB_NOT_FOUND with the tabs that do exist', async () => {
    vi.mocked(client.getSheetColumns).mockRejectedValue(
      new ApiError(404, 'TAB_NOT_FOUND', 'No tab named Nope.', { tabs: ['Leads', 'Archive'] }),
    );

    const res = await columns('spreadsheet_id=sheet-1&sheet_name=Nope');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TAB_NOT_FOUND');
    // The picker's next move: the tabs that DO exist.
    expect(res.body.details).toEqual({ tabs: ['Leads', 'Archive'] });
  });

  it('409s INTEGRATION_REAUTH_REQUIRED when Google rejected the stored token, never NAME_TAKEN', async () => {
    vi.mocked(client.getSheetColumns).mockRejectedValue(
      new ApiError(409, 'NOT_AUTHENTICATED', 'Google rejected the stored credentials.'),
    );

    const res = await columns('spreadsheet_id=sheet-1');

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_REAUTH_REQUIRED');
    expect(res.body.error.message).not.toMatch(/name/i);
  });

  it('404s SHEET_NOT_FOUND in its own words when the connected account cannot open the spreadsheet', async () => {
    vi.mocked(client.getSheetColumns).mockRejectedValue(
      new ApiError(404, 'SHEET_NOT_FOUND', 'upstream wording for sheet 1AbC'),
    );

    const res = await columns('spreadsheet_id=sheet-1');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SHEET_NOT_FOUND');
    expect(res.body.error.message).toBe(
      "Couldn't open that spreadsheet. Check its id, and that the connected Google account can see it.",
    );
  });

  it('429s SHEETS_ERROR when Google is rate limiting', async () => {
    vi.mocked(client.getSheetColumns).mockRejectedValue(
      new ApiError(429, 'SHEETS_ERROR', 'Google Sheets rate limit hit.'),
    );

    const res = await columns('spreadsheet_id=sheet-1');

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('SHEETS_ERROR');
  });

  it('502s SHEETS_ERROR for any other Sheets failure, without repeating Google’s wording', async () => {
    vi.mocked(client.getSheetColumns).mockRejectedValue(
      new ApiError(500, 'SHEETS_ERROR', 'internal: quota project 1234 exhausted'),
    );

    const res = await columns('spreadsheet_id=sheet-1');

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('SHEETS_ERROR');
    expect(res.body.error.message).not.toContain('1234');
  });

  it('422s SHEET_NOT_CONFIGURED as a fact about the request', async () => {
    vi.mocked(client.getSheetColumns).mockRejectedValue(
      new ApiError(422, 'SHEET_NOT_CONFIGURED', 'No spreadsheet.'),
    );

    const res = await columns('spreadsheet_id=sheet-1');

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SHEET_NOT_CONFIGURED');
  });
});

/**
 * Sides, and the mirror that keeps a one-faced agent's inbound half equal to
 * its outbound one.
 *
 * `?side=inbound` addresses the face directly and is only meaningful on a
 * BI agent, which has two faces to tell apart. A UNI agent has one face; a
 * write there is a write to both, so the backend mirrors it rather than
 * asking the reader to do it twice.
 *
 * The platform release carrying the inbound hook routes has not shipped, so
 * an upstream 404 is a stated gap: 501 INBOUND_ACTIONS_UNAVAILABLE, with the
 * base write already applied and said so.
 */
describe('?side=inbound', () => {
  const postTo = (side: string, body: unknown = SHEET_BODY) =>
    request(app)
      .post(
        `/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks?side=${side}`,
      )
      .set(...auth())
      .send(body as object);

  beforeEach(async () => {
    await own('CONNECTION', 'conn-alice', workspace.id);
    // Bound on BOTH sides: a face write checks, binds and judges ownership
    // against the face's own bindings, and a base write against the base's.
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow('google_sheets', 'conn-alice')],
    });
    vi.mocked(client.getInboundAgentTools).mockResolvedValue({
      tools: [toolRow('google_sheets', 'conn-alice')],
    });
    vi.mocked(client.createInboundLifecycleHook).mockResolvedValue({ hook: createdHook() });
    vi.mocked(client.getInboundLifecycleHooks).mockResolvedValue({ hooks: [] });
  });

  it('writes to the face on a BI agent whose face exists', async () => {
    await prisma.agent.update({
      where: { id: agent.id },
      data: { direction: 'BI', inboundEnabled: true },
    });

    const res = await postTo('inbound');

    expect(res.status).toBe(201);
    expect(client.createInboundLifecycleHook).toHaveBeenCalledWith('ext-1', expect.anything());
    expect(client.createAgentLifecycleHook).not.toHaveBeenCalled();
    // One side, named. No mirror: a BI agent's two faces are different
    // agents to the reader, and copying one onto the other is the thing
    // having two faces exists to avoid.
    expect(client.replaceInboundLifecycleHooks).not.toHaveBeenCalled();
  });

  describe('binding the tool on the face, not the base', () => {
    beforeEach(async () => {
      await prisma.agent.update({
        where: { id: agent.id },
        data: { direction: 'BI', inboundEnabled: true },
      });
      vi.mocked(client.setInboundAgentTool).mockResolvedValue({});
    });

    it('binds through the face when the face has no binding, whatever the base has', async () => {
      // The base is bound; the face is not. A BI agent's two faces are two
      // tool sets, and checking the base here would create a face hook whose
      // tool the face never had — the 422 then lands on a real inbound call.
      vi.mocked(client.getInboundAgentTools).mockResolvedValue({ tools: [] });

      const res = await postTo('inbound', {
        ...SHEET_BODY,
        source: { ...SHEET_BODY.source, connection_id: 'conn-alice' },
      });

      expect(res.status).toBe(201);
      expect(client.setInboundAgentTool).toHaveBeenCalledWith('ext-1', 'google_sheets', {
        enabled: true,
        connection_id: 'conn-alice',
      });
      expect(client.setAgentTool).not.toHaveBeenCalled();
      const bindOrder = vi.mocked(client.setInboundAgentTool).mock.invocationCallOrder[0];
      const createOrder = vi.mocked(client.createInboundLifecycleHook).mock.invocationCallOrder[0];
      expect(bindOrder).toBeLessThan(createOrder);
    });

    it('answers the platform’s INBOUND_NOT_ENABLED from the tools check as a 404, not a 501', async () => {
      // The local row says the face is on; the platform's tools proxy says
      // it is not. That is the exact ApiError `getInboundAgentTools` now
      // builds from the V2 envelope (pinned in the adapter suite). Before
      // the pass-through it arrived as RESOURCE_NOT_FOUND and the tools
      // check — which runs BEFORE the hook create — turned it into 501
      // "not available on the voice platform yet", so one drift answered
      // 501 here and 404 from the hook family.
      vi.mocked(client.getInboundAgentTools).mockRejectedValue(
        new ApiError(404, 'INBOUND_NOT_ENABLED', 'Inbound is not enabled on this agent.'),
      );

      const res = await postTo('inbound');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INBOUND_NOT_ENABLED');
      expect(client.createInboundLifecycleHook).not.toHaveBeenCalled();
    });

    it('leaves a face binding this workspace owns alone', async () => {
      vi.mocked(client.getAgentTools).mockResolvedValue({ tools: [] });
      vi.mocked(client.getInboundAgentTools).mockResolvedValue({
        tools: [toolRow('google_sheets', 'conn-alice')],
      });

      const res = await postTo('inbound');

      expect(res.status).toBe(201);
      expect(client.setInboundAgentTool).not.toHaveBeenCalled();
      expect(client.setAgentTool).not.toHaveBeenCalled();
    });

    it('requires a connection_id for an unbound face, as the base does', async () => {
      vi.mocked(client.getInboundAgentTools).mockResolvedValue({ tools: [] });

      const res = await postTo('inbound');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(client.setInboundAgentTool).not.toHaveBeenCalled();
      expect(client.createInboundLifecycleHook).not.toHaveBeenCalled();
    });
  });

  describe('ownership of a face hook is read off the FACE’s bindings', () => {
    const faceHook = () => createdHook({ id: 'hook-face' });
    const getFace = () =>
      request(app)
        .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks?side=inbound`)
        .set(...auth());
    const patchFace = () =>
      request(app)
        .patch(
          `/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks/hook-face?side=inbound`,
        )
        .set(...auth())
        .send({ name: 'Renamed' });

    beforeEach(async () => {
      await prisma.agent.update({
        where: { id: agent.id },
        data: { direction: 'BI', inboundEnabled: true },
      });
      vi.mocked(client.getInboundLifecycleHooks).mockResolvedValue({ hooks: [faceHook()] });
      vi.mocked(client.updateInboundLifecycleHook).mockResolvedValue({
        hook: createdHook({ id: 'hook-face', name: 'Renamed' }),
      });
    });

    it('owns a hook whose tool is bound on the face only, and lets it be edited', async () => {
      // A ?side=inbound create binds on the face alone, so the base has
      // nothing. Read off the base, the hook the reader just made is
      // someone else's and every write on it 404s.
      vi.mocked(client.getAgentTools).mockResolvedValue({ tools: [] });
      vi.mocked(client.getInboundAgentTools).mockResolvedValue({
        tools: [toolRow('google_sheets', 'conn-alice')],
      });

      const read = await getFace();
      expect(read.status).toBe(200);
      expect(read.body.data[0]).toMatchObject({ id: 'hook-face', owned: true });

      const res = await patchFace();
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: 'hook-face', owned: true });
      expect(client.updateInboundLifecycleHook).toHaveBeenCalled();
    });

    it('does not own a face hook whose face binding is another workspace’s, whatever the base has', async () => {
      // The base is this workspace's; the face was bound by staff to a pool
      // connection. The hook runs on the face's token — another account's.
      await own('CONNECTION', 'conn-bob', (await makeWorkspace(await makeAccount('bob'), 'Bob Co')).id);
      vi.mocked(client.getAgentTools).mockResolvedValue({
        tools: [toolRow('google_sheets', 'conn-alice')],
      });
      vi.mocked(client.getInboundAgentTools).mockResolvedValue({
        tools: [toolRow('google_sheets', 'conn-bob')],
      });

      const read = await getFace();
      expect(read.body.data[0]).toMatchObject({ id: 'hook-face', owned: false });

      const res = await patchFace();
      expect(res.status).toBe(404);
      expect(client.updateInboundLifecycleHook).not.toHaveBeenCalled();
    });

    it('serializes a face create as owned when only the face carries the binding', async () => {
      vi.mocked(client.getAgentTools).mockResolvedValue({ tools: [] });
      vi.mocked(client.getInboundAgentTools).mockResolvedValue({
        tools: [toolRow('google_sheets', 'conn-alice')],
      });

      const res = await postTo('inbound');

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ id: 'hook-new', owned: true });
    });
  });

  it('404s INBOUND_NOT_ENABLED on a one-faced agent', async () => {
    await prisma.agent.update({
      where: { id: agent.id },
      data: { direction: 'UNI', inboundEnabled: true },
    });

    const res = await postTo('inbound');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('INBOUND_NOT_ENABLED');
    expect(client.createInboundLifecycleHook).not.toHaveBeenCalled();
    expect(client.createAgentLifecycleHook).not.toHaveBeenCalled();
  });

  it('404s INBOUND_NOT_ENABLED on a BI agent with no face yet', async () => {
    await prisma.agent.update({
      where: { id: agent.id },
      data: { direction: 'BI', inboundEnabled: false },
    });

    const res = await postTo('inbound');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('INBOUND_NOT_ENABLED');
  });

  it('answers the face’s 422 with the platform’s issues, the same shape as the base', async () => {
    await prisma.agent.update({
      where: { id: agent.id },
      data: { direction: 'BI', inboundEnabled: true },
    });
    const issues = [{ path: 'exposeAs', message: 'Required' }];
    vi.mocked(client.createInboundLifecycleHook).mockRejectedValue(
      new ApiError(422, 'VALIDATION_FAILED', 'Invalid hook.', { issues }),
    );

    const res = await postTo('inbound');

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.details).toEqual({ issues });
  });

  it('refuses a side it does not know rather than silently writing the base', async () => {
    const res = await postTo('sideways');

    expect(res.status).toBe(400);
    // The refusal names both values it takes: `base` is accepted, and a
    // message that says only 'inbound' tells a caller who sent `base` that
    // the value they sent — which worked — is the one being refused.
    expect(res.body.error.message).toBe("side must be 'base' or 'inbound' when it is given.");
    expect(client.createAgentLifecycleHook).not.toHaveBeenCalled();
  });

  it('accepts side=base as the base', async () => {
    const res = await postTo('base');

    expect(res.status).toBe(201);
    expect(client.createAgentLifecycleHook).toHaveBeenCalled();
    expect(client.createInboundLifecycleHook).not.toHaveBeenCalled();
  });

  it('answers 501 while the platform release is undeployed', async () => {
    await prisma.agent.update({
      where: { id: agent.id },
      data: { direction: 'BI', inboundEnabled: true },
    });
    vi.mocked(client.createInboundLifecycleHook).mockRejectedValue(
      new ApiError(404, 'RESOURCE_NOT_FOUND', 'Not found.'),
    );

    const res = await postTo('inbound');

    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('INBOUND_ACTIONS_UNAVAILABLE');
  });

  it('answers the face’s enveloped NOT_FOUND on a stale hook id as 404, not the 501', async () => {
    // The hook was listed a moment ago and is gone now. The inbound routes
    // are live, so this is a fact about the hook, not about the release.
    await prisma.agent.update({
      where: { id: agent.id },
      data: { direction: 'BI', inboundEnabled: true },
    });
    vi.mocked(client.getInboundLifecycleHooks).mockResolvedValue({ hooks: [createdHook()] });
    vi.mocked(client.updateInboundLifecycleHook).mockRejectedValue(
      new ApiError(404, 'NOT_FOUND', 'Hook not found'),
    );

    const res = await request(app)
      .patch(
        `/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks/hook-new?side=inbound`,
      )
      .set(...auth())
      .send({ name: 'Renamed' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('passes the platform’s own INBOUND_NOT_ENABLED through as a 404, not a 501', async () => {
    // Locally the face looks enabled (the row says so); the platform says
    // it is not. The platform's word is the one to repeat, and it is a 404
    // about the agent, not a 501 about the release.
    await prisma.agent.update({
      where: { id: agent.id },
      data: { direction: 'BI', inboundEnabled: true },
    });
    vi.mocked(client.getInboundLifecycleHooks).mockRejectedValue(
      new ApiError(404, 'INBOUND_NOT_ENABLED', 'Inbound is not enabled on this agent.'),
    );

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks?side=inbound`)
      .set(...auth());

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('INBOUND_NOT_ENABLED');
  });

  it('reads 501 off a face GET whose route the release does not carry', async () => {
    await prisma.agent.update({
      where: { id: agent.id },
      data: { direction: 'BI', inboundEnabled: true },
    });
    vi.mocked(client.getInboundLifecycleHooks).mockRejectedValue(
      new ApiError(404, 'RESOURCE_NOT_FOUND', 'Not found.'),
    );

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks?side=inbound`)
      .set(...auth());

    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('INBOUND_ACTIONS_UNAVAILABLE');
  });

  it('reads the face’s actions', async () => {
    await prisma.agent.update({
      where: { id: agent.id },
      data: { direction: 'BI', inboundEnabled: true },
    });
    vi.mocked(client.getInboundLifecycleHooks).mockResolvedValue({ hooks: [createdHook()] });

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks?side=inbound`)
      .set(...auth());

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ id: 'hook-new', owned: true });
    expect(client.getAgentLifecycleHooks).not.toHaveBeenCalled();
  });
});

describe('the UNI mirror', () => {
  beforeEach(async () => {
    await own('CONNECTION', 'conn-alice', workspace.id);
    vi.mocked(client.getAgentTools).mockResolvedValue({
      tools: [toolRow('google_sheets', 'conn-alice')],
    });
    vi.mocked(client.replaceInboundLifecycleHooks).mockResolvedValue({ hooks: [] });
    vi.mocked(client.setInboundAgentTool).mockResolvedValue({});
    // The base list AFTER the write — what the face is set to.
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({
      hooks: [createdHook(), createdHook({ id: 'hook-2', stage: 'POST_CALL', exposeAs: null })],
    });
    await prisma.agent.update({
      where: { id: agent.id },
      data: { direction: 'UNI', inboundEnabled: true },
    });
  });

  it('replaces the face’s list with the base list after a create', async () => {
    const res = await post(SHEET_BODY);

    expect(res.status).toBe(201);
    expect(res.body.data.inboundActionsSynced).toBe(true);
    expect(client.replaceInboundLifecycleHooks).toHaveBeenCalledWith('ext-1', [
      {
        stage: 'PRE_CALL',
        name: 'Look up the lead',
        toolSlug: 'google_sheets',
        toolFn: 'lookup_row',
        input: { spreadsheet_id: 'sheet-1', match_column: 'Phone', columns: [] },
        exposeAs: 'lead',
        required: false,
        timeoutMs: 3000,
        enabled: true,
      },
      {
        stage: 'POST_CALL',
        name: 'Look up the lead',
        toolSlug: 'google_sheets',
        toolFn: 'lookup_row',
        input: { spreadsheet_id: 'sheet-1', match_column: 'Phone', columns: [] },
        required: false,
        timeoutMs: 3000,
        enabled: true,
      },
    ]);
  });

  it('carries a paused hook onto the face as enabled:false', async () => {
    // The platform honours `enabled` on replace-all, so a hook the reader
    // paused on the base has to arrive paused on the face — a mirror that
    // dropped the flag would re-enable it on every inbound call.
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({
      hooks: [createdHook({ enabled: false })],
    });

    await post(SHEET_BODY);

    expect(client.replaceInboundLifecycleHooks).toHaveBeenCalledWith('ext-1', [
      expect.objectContaining({ name: 'Look up the lead', enabled: false }),
    ]);
  });

  it('mirrors the tool bind too, when the create had to make one', async () => {
    vi.mocked(client.getAgentTools).mockResolvedValue({ tools: [] });

    const res = await post({
      ...SHEET_BODY,
      source: { ...SHEET_BODY.source, connection_id: 'conn-alice' },
    });

    expect(res.status).toBe(201);
    expect(client.setInboundAgentTool).toHaveBeenCalledWith('ext-1', 'google_sheets', {
      enabled: true,
      connection_id: 'conn-alice',
    });
  });

  it('does not touch the face when nothing was bound', async () => {
    await post(SHEET_BODY);

    expect(client.setInboundAgentTool).not.toHaveBeenCalled();
    expect(client.replaceInboundLifecycleHooks).toHaveBeenCalled();
  });

  it('mirrors after a patch, a delete and a reorder', async () => {
    vi.mocked(client.updateAgentLifecycleHook).mockResolvedValue({ hook: createdHook() });
    vi.mocked(client.deleteAgentLifecycleHook).mockResolvedValue(undefined);
    vi.mocked(client.reorderAgentLifecycleHooks).mockResolvedValue({ hooks: [] });
    const base = `/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks`;

    await request(app).patch(`${base}/hook-new`).set(...auth()).send({ name: 'Renamed' });
    expect(client.replaceInboundLifecycleHooks).toHaveBeenCalledTimes(1);

    await request(app).delete(`${base}/hook-new`).set(...auth());
    expect(client.replaceInboundLifecycleHooks).toHaveBeenCalledTimes(2);

    await request(app)
      .post(`${base}/reorder`)
      .set(...auth())
      .send({ stage: 'pre_call', ids: ['hook-new'] });
    expect(client.replaceInboundLifecycleHooks).toHaveBeenCalledTimes(3);
  });

  it('does not mirror a preview, which writes nothing', async () => {
    vi.mocked(client.previewAgentLifecycleHook).mockResolvedValue({ input: {} });

    await request(app)
      .post(
        `/api/workspaces/${workspace.id}/agents/${agent.id}/lifecycle-hooks/hook-new/preview`,
      )
      .set(...auth())
      .send({});

    expect(client.replaceInboundLifecycleHooks).not.toHaveBeenCalled();
  });

  it('keeps the base write and reports a sync failure rather than losing both', async () => {
    vi.mocked(client.replaceInboundLifecycleHooks).mockRejectedValue(
      new ApiError(502, 'UPSTREAM_ERROR', 'The voice platform could not complete that request.'),
    );

    const res = await post(SHEET_BODY);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id: 'hook-new', inboundActionsSynced: false });
    expect(typeof res.body.data.inboundActionsError).toBe('string');
    // The next successful write re-syncs, because replace-all is idempotent.
    expect(client.createAgentLifecycleHook).toHaveBeenCalled();
  });

  it('reports an enveloped NOT_FOUND from the face as a sync failure, not the 501', async () => {
    // Through the REAL adapter: the platform's enveloped 404 NOT_FOUND
    // (inbound-lifecycle-hooks.routes.ts:83-91) is a live route answering,
    // so the base write stands and the face is merely out of step.
    const actual = await vi.importActual<typeof import('../src/adapter/vocobase.js')>(
      '../src/adapter/vocobase.js',
    );
    const { env } = await import('../src/lib/env.js');
    const key = env.vocobaseApiKey;
    env.vocobaseApiKey = 'test-key';
    vi.mocked(client.replaceInboundLifecycleHooks).mockImplementation(
      actual.replaceInboundLifecycleHooks,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Agent not found' },
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    try {
      const res = await post(SHEET_BODY);

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ id: 'hook-new', inboundActionsSynced: false });
    } finally {
      env.vocobaseApiKey = key;
      vi.unstubAllGlobals();
    }
  });

  it('answers 501 on the undeployed release, saying the base write landed', async () => {
    vi.mocked(client.replaceInboundLifecycleHooks).mockRejectedValue(
      new ApiError(404, 'RESOURCE_NOT_FOUND', 'Not found.'),
    );

    const res = await post(SHEET_BODY);

    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('INBOUND_ACTIONS_UNAVAILABLE');
    expect(res.body.details).toMatchObject({ baseWriteApplied: true });
    // The action really was created; only the face is out of step.
    expect(client.createAgentLifecycleHook).toHaveBeenCalled();
  });

  it('does not mirror a one-faced agent that has no face', async () => {
    await prisma.agent.update({
      where: { id: agent.id },
      data: { direction: 'UNI', inboundEnabled: false },
    });

    const res = await post(SHEET_BODY);

    expect(res.status).toBe(201);
    expect(res.body.data).not.toHaveProperty('inboundActionsSynced');
    expect(client.replaceInboundLifecycleHooks).not.toHaveBeenCalled();
  });

  it('does not mirror a BI agent, whose faces are meant to differ', async () => {
    await prisma.agent.update({
      where: { id: agent.id },
      data: { direction: 'BI', inboundEnabled: true },
    });

    const res = await post(SHEET_BODY);

    expect(res.status).toBe(201);
    expect(client.replaceInboundLifecycleHooks).not.toHaveBeenCalled();
  });
});
