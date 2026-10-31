import { Router, type Response } from 'express';
import { z } from 'zod';
import {
  createAgentLifecycleHook,
  createInboundLifecycleHook,
  deleteAgentLifecycleHook,
  deleteInboundLifecycleHook,
  getAgentLifecycleHooks,
  getAgentTools,
  getInboundAgentTools,
  getInboundLifecycleHooks,
  getSheetColumns,
  listIntegrationLogs,
  previewAgentLifecycleHook,
  previewInboundLifecycleHook,
  reorderAgentLifecycleHooks,
  reorderInboundLifecycleHooks,
  replaceInboundLifecycleHooks,
  setAgentTool,
  setInboundAgentTool,
  updateAgentLifecycleHook,
  updateInboundLifecycleHook,
  type AgentToolsResponse,
  type LifecycleHookPatch,
  type LifecycleHookReorder,
  type LifecycleHookWrite,
  type LifecycleHooksResponse,
  type LifecycleHookResponse,
  type LifecycleHookPreviewResponse,
  type SetAgentToolBody,
  type UpstreamRecord,
} from '../adapter/vocobase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireMembership, workspaceOf } from '../middleware/workspace.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { agentInWorkspace } from './agents.routes.js';
import { hasAddressableFace, mirrorsToFace } from '../lib/agentDirection.js';
import { hookOwnership, hookToolSlug } from '../lib/hookOwnership.js';
import { serializeLifecycleHooks } from '../lib/serialize.js';
import { connectionIdOf, isUpstreamRow } from '../lib/serialize.js';
import { readArray, readBoolean, readNumber, readRecord, readString } from '../lib/upstream.js';
import { filterMapped, resourceInWorkspace } from '../lib/workspaceResource.js';
import { prisma } from '../lib/prisma.js';
import { parseBody } from '../lib/validate.js';
import { writeLimiter } from '../lib/writeLimiter.js';

/**
 * The editor half of the pre-call / post-call actions surface.
 *
 * Mounted beside `agentRoutes` rather than inside it because it is a
 * different thing: that file is the agent's own configuration, this is the
 * engine the platform runs around a call. The read (`GET …/lifecycle-hooks`)
 * stays there, next to the tools listing whose ownership rule it shares.
 *
 * **MEMBER, not ADMIN**, like every other agent edit. An action can only
 * reach a connection an admin already approved or a function the workspace
 * already owns, so the egress decision was taken before anybody arrived here.
 */
export const agentActionRoutes = Router();

/** The three sources the platform can execute. One array, per the design:
 *  the editor's catalogue and this gate are the same list. */
const TOOL_SLUGS = ['google_sheets', 'google_calendar', 'gmail'] as const;

/** `expose_as` is mandatory for these: the lookup's whole output is the
 *  object it names, and a row without one supplies nothing at all. */
const REQUIRES_EXPOSE_AS = ['lookup_row'];

const NAME_MAX = 200;

/** The platform's own cap on `skipUnless` paths; refused here, before the
 *  request leaves, rather than as a 422 whose path the form has to map. */
const SKIP_UNLESS_MAX = 10;

/** The platform's own ceiling on a hook's timeout (`TIMEOUT_MAX_MS`,
 *  crud.service.ts:82). Refused here so a create does not bind the tool
 *  first and only then learn the hook itself is invalid. */
const TIMEOUT_MAX_MS = 30_000;

const createHookSchema = z
  .object({
    stage: z.enum(['pre_call', 'post_call']),
    name: z.string().min(1).max(NAME_MAX),
    source: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('tool'),
        tool_slug: z.enum(TOOL_SLUGS),
        tool_fn: z.string().min(1).max(100),
        connection_id: z.string().min(1).optional(),
      }),
      z.object({
        kind: z.literal('function'),
        function_id: z.string().min(1),
      }),
    ]),
    // Shape-checked, not content-checked: what belongs in it is the source's
    // contract and the platform is its authority. A schema here would have to
    // be kept in step with a catalogue it cannot see, and would start
    // refusing valid input the day a source grows a field.
    input: z.record(z.string(), z.unknown()).default({}),
    expose_as: z.string().min(1).max(100).optional(),
    required: z.boolean().optional(),
    timeout_ms: z.number().int().min(100).max(TIMEOUT_MAX_MS).optional(),
    skip_unless: z.array(z.string().min(1)).max(SKIP_UNLESS_MAX).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.stage === 'pre_call' && value.skip_unless !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['skip_unless'],
        // Not silently dropped: a caller who set it believes the action is
        // conditional, and a pre-call action that always runs is a different
        // agent from the one they configured.
        message: 'skip_unless applies to post-call actions only.',
      });
    }

    if (value.stage === 'post_call' && value.expose_as !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['expose_as'],
        message: 'expose_as applies to pre-call actions only — nothing runs after to read it.',
      });
    }

    if (
      value.stage === 'pre_call' &&
      value.source.kind === 'tool' &&
      REQUIRES_EXPOSE_AS.includes(value.source.tool_fn) &&
      value.expose_as === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['expose_as'],
        message: 'expose_as is required for a lookup: it names the object the lookup returns.',
      });
    }
  });

/**
 * Makes sure the agent really has this tool bound, to a connection this
 * workspace owns — binding it first when it does not.
 *
 * The platform 422s `TOOL_NOT_CONNECTED` on a hook whose tool is not bound,
 * and a caller told their *input* was rejected when the actual problem is an
 * unconnected integration has been told the wrong thing. So the bind happens
 * here, before the hook, and only ever to a connection that passed
 * `resourceInWorkspace`.
 *
 * Three outcomes, and the refusals are deliberately different:
 *
 * - **Bound to a connection mapped here** — nothing to do, and any
 *   `connection_id` in the body is ignored rather than honoured. Rebinding a
 *   live tool as a side effect of adding one action would silently redirect
 *   every *other* action on the agent to a different Google account.
 * - **Bound to a connection mapped elsewhere** — 404, the same one every
 *   unowned resource answers. That a connection for this tool exists on the
 *   shared partner account is exactly the fact a workspace without one must
 *   not be able to learn.
 * - **Not bound** — `connection_id` is required and checked. Omitting it lets
 *   upstream pick its own default out of a pool holding every other
 *   workspace's OAuth tokens, which is the rule the tools PUT already holds.
 */
async function someBindingOwned(rows: unknown[], workspaceId: string): Promise<boolean> {
  // The strict rule, not the tools list's: a null connection means "no
  // connection", and reading that as ownership would let any workspace attach
  // an action to a Google row it has no account behind.
  const bound = rows.filter((row) => connectionIdOf(row) !== null);
  const owned = await filterMapped(bound, 'CONNECTION', workspaceId, connectionIdOf);
  return owned.length > 0;
}

/**
 * The agent's live, owned binding for one slug — or 404.
 *
 * `ensureToolBound` may create one; this only ever reads. The sheet-columns
 * proxy needs it because the request it makes upstream spends somebody's
 * OAuth token on a spreadsheet id the caller chose, and a workspace with no
 * Google account of its own must not be able to spend another's.
 */
async function requireOwnedToolBinding(
  externalId: string,
  slug: string,
  workspaceId: string,
): Promise<void> {
  const { tools } = await getAgentTools(externalId);
  const enabled = (Array.isArray(tools) ? tools : [])
    .filter(isUpstreamRow)
    .filter((row) => hookToolSlug(row) === slug && readBoolean(row, ['enabled']) === true);

  if (enabled.length > 0 && (await someBindingOwned(enabled, workspaceId))) return;

  throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Not found.');
}

/**
 * The tools surface of one side. A face hook runs against the FACE's tool
 * set, so a face write checks and binds there; checking the base would
 * create a face hook whose tool the face never had, and the platform's
 * TOOL_NOT_CONNECTED would then land on a real inbound call.
 */
const TOOLS = {
  base: {
    list: (id: string): Promise<AgentToolsResponse> => getAgentTools(id),
    bind: (id: string, slug: string, body: SetAgentToolBody): Promise<UpstreamRecord> =>
      setAgentTool(id, slug, body),
  },
  inbound: {
    list: (id: string): Promise<AgentToolsResponse> => getInboundAgentTools(id),
    bind: (id: string, slug: string, body: SetAgentToolBody): Promise<UpstreamRecord> =>
      setInboundAgentTool(id, slug, body),
  },
} as const;

async function ensureToolBound(
  externalId: string,
  slug: string,
  workspaceId: string,
  connectionId: string | undefined,
  side: Side = 'base',
): Promise<MirroredBind | null> {
  const tools = TOOLS[side];
  const { tools: rows } = await onSide(side, () => tools.list(externalId));
  const enabled = (Array.isArray(rows) ? rows : [])
    .filter(isUpstreamRow)
    .filter((row) => hookToolSlug(row) === slug && readBoolean(row, ['enabled']) === true);

  if (enabled.length > 0) {
    if (await someBindingOwned(enabled, workspaceId)) return null;

    throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Not found.');
  }

  if (!connectionId) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      `connection_id is required to use ${slug}: it is not connected on this agent yet. ` +
        "Choose one of this workspace's connections.",
    );
  }

  await resourceInWorkspace('CONNECTION', connectionId, workspaceId);
  await onSide(side, () =>
    tools.bind(externalId, slug, { enabled: true, connection_id: connectionId }),
  );

  // Handed back so the mirror can repeat it on the face. A face whose hooks
  // were copied but whose tool was not bound runs none of them, and the
  // platform's 422 would arrive on a call rather than on this request.
  return { slug, connectionId };
}

/** The YE body, translated to the camelCase the platform's hook routes read.
 *  Absent stays absent: sending `undefined` as `null` would clear a default
 *  the platform owns. */
function toUpstream(body: z.infer<typeof createHookSchema>): LifecycleHookWrite {
  const write: LifecycleHookWrite = {
    stage: body.stage === 'pre_call' ? 'PRE_CALL' : 'POST_CALL',
    name: body.name,
  };

  if (body.source.kind === 'tool') {
    write.toolSlug = body.source.tool_slug;
    write.toolFn = body.source.tool_fn;
  } else {
    write.functionId = body.source.function_id;
  }

  write.input = body.input;
  if (body.expose_as !== undefined) write.exposeAs = body.expose_as;
  if (body.required !== undefined) write.required = body.required;
  if (body.timeout_ms !== undefined) write.timeoutMs = body.timeout_ms;
  if (body.skip_unless !== undefined) write.skipUnless = body.skip_unless;

  return write;
}

/**
 * Serializes one written row the way the list does.
 *
 * Through the SAME ownership predicate rather than `owned: true` by
 * assertion: the write proved this workspace may create the row, which is
 * not quite the same question as whether the read will call it owned, and a
 * create that answered differently from the refresh after it would have the
 * editor's form change shape under the reader's hands.
 */
async function serializeOne(
  row: unknown,
  externalId: string,
  workspaceId: string,
  side: Side = 'base',
): Promise<Record<string, unknown> | null> {
  const owned = await hookOwnership([row], externalId, workspaceId, toolsOf(side));
  return serializeLifecycleHooks([row], owned)[0] ?? null;
}

/**
 * The tools list ownership is read from, for one side.
 *
 * A hook runs against the tool set of the face it sits on, so the face's own
 * bindings decide a face hook's owner. Through `onSide`, so an undeployed
 * face tools route reads as the same 501 as the hook route beside it.
 */
function toolsOf(side: Side): (id: string) => Promise<AgentToolsResponse> {
  return (id) => onSide(side, () => TOOLS[side].list(id));
}

agentActionRoutes.post(
  '/:workspaceId/agents/:agentId/lifecycle-hooks',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(createHookSchema, req.body);
    const side = sideOf(req.query.side);
    const agent = await agentInWorkspace(req);
    const workspaceId = workspaceOf(req).id;

    if (side === 'inbound') requireFace(agent);

    let bind: MirroredBind | null = null;

    if (body.source.kind === 'tool') {
      bind = await ensureToolBound(
        agent.externalId,
        body.source.tool_slug,
        workspaceId,
        body.source.connection_id,
        side,
      );
    } else {
      // The workspace's own function, and the platform's own
      // function-attached check is the second line behind this one.
      await resourceInWorkspace('FUNCTION', body.source.function_id, workspaceId);
    }

    const { hook } = await onSide(side, () => FACE[side].create(agent.externalId, toUpstream(body)));

    // A create that answered no row is a create whose result nobody can
    // render. Re-reading the list would paper over it; saying so does not,
    // and the row IS there, so the next refresh shows it.
    if (hook === undefined) {
      throw new ApiError(
        502,
        'UPSTREAM_ERROR',
        'The action was created but the voice platform did not describe it. Refresh to see it.',
      );
    }

    const data = await serializeOne(hook, agent.externalId, workspaceId, side);
    const mirror = side === 'base' ? await mirrorFace(agent, bind, () => ({ data })) : {};

    res.status(201).json({ success: true, data: { ...data, ...mirror } });
  }),
);

/**
 * The one hook this request is about, proved to be this workspace's.
 *
 * Every write re-reads the list. The id in the path is the only thing the
 * caller supplies, and the platform would patch an id belonging to another
 * workspace's agent if simply asked — the partner key authenticates YE, not
 * the reader. Resolving against the list *the read renders* is what keeps
 * the two from drifting: a row the GET calls unowned is a row every write
 * refuses, by construction rather than by two rules agreeing today.
 *
 * "Not on this agent" and "on it but not yours" answer the same 404, on
 * purpose. Distinguishing them would turn the route into an oracle for which
 * hook ids exist on the shared partner account.
 */
async function ownedHookRow(
  externalId: string,
  workspaceId: string,
  hookId: string,
  side: Side = 'base',
): Promise<Record<string, unknown>> {
  const rows = await ownedHookRows(externalId, workspaceId, side);
  const row = rows.find((candidate) => readString(candidate, ['id']) === hookId);

  if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Not found.');

  return row;
}

/**
 * Every hook on one face of the agent that this workspace owns, in the
 * list's own order, judged against THAT face's tool bindings.
 */
async function ownedHookRows(
  externalId: string,
  workspaceId: string,
  side: Side = 'base',
): Promise<Record<string, unknown>[]> {
  const { hooks } = await onSide(side, () => FACE[side].list(externalId));
  const rows = (Array.isArray(hooks) ? hooks : []).filter(isUpstreamRow);
  const owned = await hookOwnership(rows, externalId, workspaceId, toolsOf(side));
  return rows.filter(owned);
}

const STAGE_UP = { pre_call: 'PRE_CALL', post_call: 'POST_CALL' } as const;

/** Whether a stored row is post-call, whatever case upstream wrote it in. */
function isPostCall(row: unknown): boolean {
  return (readString(row, ['stage']) ?? '').toUpperCase() === 'POST_CALL';
}

/**
 * The patch body.
 *
 * `stage` and `source` are absent on purpose, and `.strict()` makes sending
 * either a 400 rather than a silent no-op. Moving a hook between stages, or
 * onto a different source, is not an edit: the input template's shape is the
 * source's, so the result would be a row whose configuration means nothing.
 * Delete and create again.
 *
 * The nullable fields really are nullable — clearing `expose_as` is
 * something an editor has to be able to do, and `undefined` cannot say it.
 */
const patchHookSchema = z
  .object({
    name: z.string().min(1).max(NAME_MAX).optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    expose_as: z.string().min(1).max(100).nullable().optional(),
    required: z.boolean().optional(),
    timeout_ms: z.number().int().min(100).max(TIMEOUT_MAX_MS).optional(),
    enabled: z.boolean().optional(),
    skip_unless: z.array(z.string().min(1)).max(SKIP_UNLESS_MAX).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });

function toUpstreamPatch(body: z.infer<typeof patchHookSchema>): LifecycleHookPatch {
  const patch: LifecycleHookPatch = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.input !== undefined) patch.input = body.input;
  if (body.expose_as !== undefined) patch.exposeAs = body.expose_as;
  if (body.required !== undefined) patch.required = body.required;
  if (body.timeout_ms !== undefined) patch.timeoutMs = body.timeout_ms;
  if (body.enabled !== undefined) patch.enabled = body.enabled;
  if (body.skip_unless !== undefined) patch.skipUnless = body.skip_unless;
  return patch;
}

agentActionRoutes.patch(
  '/:workspaceId/agents/:agentId/lifecycle-hooks/:hookId',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(patchHookSchema, req.body);
    const side = sideOf(req.query.side);
    const agent = await agentInWorkspace(req);
    const workspaceId = workspaceOf(req).id;

    if (side === 'inbound') requireFace(agent);

    const current = await ownedHookRow(agent.externalId, workspaceId, req.params.hookId, side);

    // Read off the STORED row, not the body: `stage` is not patchable, so the
    // only authority on which stage this hook is in is the platform's copy.
    if (body.skip_unless !== undefined && !isPostCall(current)) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        'skip_unless applies to post-call actions only.',
      );
    }

    const { hook } = await onSide(side, () =>
      FACE[side].update(agent.externalId, req.params.hookId, toUpstreamPatch(body)),
    );

    const data = await serializeOne(hook ?? current, agent.externalId, workspaceId, side);
    const mirror = side === 'base' ? await mirrorFace(agent, null, () => ({ data })) : {};

    res.json({ success: true, data: { ...data, ...mirror } });
  }),
);

agentActionRoutes.delete(
  '/:workspaceId/agents/:agentId/lifecycle-hooks/:hookId',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const side = sideOf(req.query.side);
    const agent = await agentInWorkspace(req);
    const workspaceId = workspaceOf(req).id;

    if (side === 'inbound') requireFace(agent);

    await ownedHookRow(agent.externalId, workspaceId, req.params.hookId, side);
    await onSide(side, () => FACE[side].remove(agent.externalId, req.params.hookId));

    const deleted = { deleted: true };
    const mirror = side === 'base' ? await mirrorFace(agent, null, () => deleted) : {};

    res.json({ success: true, data: { ...deleted, ...mirror } });
  }),
);

const reorderSchema = z
  .object({
    stage: z.enum(['pre_call', 'post_call']),
    ids: z.array(z.string().min(1)).min(1).max(100),
  })
  .strict();

/**
 * Reorder is replace-all upstream, which is why this is stricter than it
 * looks like it needs to be.
 *
 * The platform rewrites the stage's sequence from the list it is handed, so
 * an id the caller may not touch is a request to rewrite the stage *around*
 * somebody else's hook (404), and a list that is merely SHORT deletes the
 * hooks it leaves out (400). Neither is something a drag-and-drop meant, and
 * both are silent if this route only forwards.
 *
 * The 400 says so rather than quietly appending the missing ids: a list that
 * does not match the stage means the editor's view is stale, and completing
 * it here would reorder against a picture the reader is no longer looking at.
 */
agentActionRoutes.post(
  '/:workspaceId/agents/:agentId/lifecycle-hooks/reorder',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(reorderSchema, req.body);
    const side = sideOf(req.query.side);
    const agent = await agentInWorkspace(req);
    const workspaceId = workspaceOf(req).id;

    if (side === 'inbound') requireFace(agent);

    if (new Set(body.ids).size !== body.ids.length) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'ids must not repeat an action.');
    }

    const wantPostCall = body.stage === 'post_call';
    const inStage = (await ownedHookRows(agent.externalId, workspaceId, side)).filter(
      (row) => isPostCall(row) === wantPostCall,
    );
    const stageIds = new Set(
      inStage.map((row) => readString(row, ['id'])).filter((id): id is string => id !== null),
    );

    for (const id of body.ids) {
      if (!stageIds.has(id)) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Not found.');
    }

    if (body.ids.length !== stageIds.size) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        'ids must list every action in this stage — the platform replaces the whole sequence, ' +
          'so an action left out would be removed.',
      );
    }

    await onSide(side, () =>
      FACE[side].reorder(agent.externalId, { stage: STAGE_UP[body.stage], ids: body.ids }),
    );

    const order = { stage: body.stage, ids: body.ids };
    const mirror = side === 'base' ? await mirrorFace(agent, null, () => order) : {};

    res.json({ success: true, data: { ...order, ...mirror } });
  }),
);

const previewSchema = z
  .object({ variables: z.record(z.string(), z.unknown()).optional() })
  .strict();

agentActionRoutes.post(
  '/:workspaceId/agents/:agentId/lifecycle-hooks/:hookId/preview',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(previewSchema, req.body ?? {});
    const side = sideOf(req.query.side);
    const agent = await agentInWorkspace(req);
    const workspaceId = workspaceOf(req).id;

    if (side === 'inbound') requireFace(agent);

    await ownedHookRow(agent.externalId, workspaceId, req.params.hookId, side);

    // No mirror: a preview renders a template and writes nothing, so there
    // is nothing for the face to be out of step with.
    const rendered = await onSide(side, () =>
      FACE[side].preview(agent.externalId, req.params.hookId, {
        ...(body.variables === undefined ? {} : { variables: body.variables }),
      }),
    );

    // `skipped_on` is ONE path, not a list: the platform stops at the first
    // empty `skipUnless` entry, and that is the one the editor points at.
    res.json({
      success: true,
      data: {
        // `renderedInput` is the platform's one key (crud.service.ts:1057).
        input: rendered.renderedInput ?? {},
        skipped: rendered.skipped === true,
        skipped_on: typeof rendered.skippedOn === 'string' ? rendered.skippedOn : null,
      },
    });
  }),
);

const sheetColumnsQuery = z.object({
  spreadsheet_id: z.string().min(1).max(200),
  sheet_name: z.string().min(1).max(200).optional(),
});

/**
 * One spreadsheet's tabs, or one tab's headers, for the editor's picker.
 *
 * A read, but gated like a write: the request spends this agent's Google
 * token on a spreadsheet id the caller chose, so it needs an owned binding
 * behind it and not merely membership. Without that, a workspace with no
 * Google account could read any spreadsheet another workspace's connected
 * account can see.
 *
 * The platform's typed refusals are mapped rather than collapsed, because
 * they name different things to do: `NOT_CONNECTED` means an admin has to
 * connect Google Sheets (409 — the request was fine, the state is not),
 * `NOT_AUTHENTICATED` that one has to RE-connect it (409
 * INTEGRATION_REAUTH_REQUIRED), `SHEET_NOT_CONFIGURED` that there is no
 * spreadsheet id to read (422), `TAB_NOT_FOUND` that the tab name is wrong
 * (404, with the tabs that do exist in `details.tabs`), `SHEET_NOT_FOUND`
 * that the account cannot open the spreadsheet (404), and `SHEETS_ERROR`
 * that Google failed (429 to wait, 502 otherwise). Collapsed, each would
 * reach the editor pointing at nothing — or, for a 409, as "that name is
 * already in use".
 */
agentActionRoutes.get(
  '/:workspaceId/agents/:agentId/tools/google_sheets/sheet-columns',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const query = parseBody(sheetColumnsQuery, req.query);
    const agent = await agentInWorkspace(req);
    const workspaceId = workspaceOf(req).id;

    await requireOwnedToolBinding(agent.externalId, 'google_sheets', workspaceId);

    try {
      const result = await getSheetColumns(agent.externalId, {
        spreadsheet_id: query.spreadsheet_id,
        ...(query.sheet_name === undefined ? {} : { sheet_name: query.sheet_name }),
      });

      res.json({
        success: true,
        data: {
          columns: Array.isArray(result.columns) ? result.columns : [],
          // Which tab the headers came from: the first one when the caller
          // named none, so the picker can show it as the selection.
          sheet_name: typeof result.sheet_name === 'string' ? result.sheet_name : null,
          tabs: Array.isArray(result.tabs) ? result.tabs : [],
          truncated: result.truncated === true,
        },
      });
    } catch (err) {
      throw mapSheetError(err);
    }
  }),
);

function mapSheetError(err: unknown): unknown {
  if (!(err instanceof ApiError)) return err;

  if (err.code === 'NOT_CONNECTED') {
    return new ApiError(
      409,
      'INTEGRATION_NOT_CONNECTED',
      'Google Sheets is not connected for this workspace. An admin can connect it in Settings.',
    );
  }

  if (err.code === 'SHEET_NOT_CONFIGURED') {
    return new ApiError(
      422,
      'SHEET_NOT_CONFIGURED',
      'No spreadsheet to read: give a spreadsheet id.',
    );
  }

  if (err.code === 'NOT_AUTHENTICATED') {
    return new ApiError(
      409,
      'INTEGRATION_REAUTH_REQUIRED',
      'Google Sheets needs to be reconnected for this workspace: Google rejected the saved ' +
        'sign-in. An admin can reconnect it in Settings.',
    );
  }

  if (err.code === 'SHEET_NOT_FOUND') {
    return new ApiError(
      404,
      'SHEET_NOT_FOUND',
      "Couldn't open that spreadsheet. Check its id, and that the connected Google account can see it.",
    );
  }

  if (err.code === 'SHEETS_ERROR') {
    // Our own sentence, not Google's: its message is free text from a third
    // party. The status is the platform's where it means something to act
    // on (429: wait), and a gateway failure otherwise.
    return err.status === 429
      ? new ApiError(429, 'SHEETS_ERROR', 'Google Sheets is busy right now. Try again in a moment.')
      : new ApiError(502, 'SHEETS_ERROR', 'Google Sheets could not be read right now.');
  }

  if (err.code === 'TAB_NOT_FOUND') {
    // `details.tabs` — the tabs that DO exist — rides through untouched: it
    // is the picker's next move, and the sentence alone leaves it guessing.
    return new ApiError(
      404,
      'TAB_NOT_FOUND',
      'That tab does not exist in the spreadsheet. Pick one of its tabs.',
      err.details,
    );
  }

  return err;
}

// ---- sides, and the mirror ----
//
// An agent has one face or two. `?side=inbound` addresses the second one,
// and is only meaningful on a BI agent that has one: a UNI agent's single
// face IS the inbound behaviour, so there is no second side to name.
//
// What a UNI agent gets instead is a **mirror**. Every base write is
// followed by a wholesale replace of the face's list from the base's current
// list, so the two cannot drift. Replace-all rather than a diff because the
// mirror has to be idempotent: a sync that fails leaves the face at some
// unknown point, and the next successful write has to put it right without
// knowing where it stopped.

type Side = 'base' | 'inbound';

/**
 * Which face this request addresses.
 *
 * An unrecognised `?side=` is a 400 rather than a silent fall-back to the
 * base. A typo would otherwise write the wrong face and report success,
 * which on a two-faced agent is a change to the calls nobody was looking at.
 */
function sideOf(raw: unknown): Side {
  if (raw === undefined || raw === 'base') return 'base';
  if (raw === 'inbound') return 'inbound';

  throw new ApiError(400, 'VALIDATION_ERROR', "side must be 'base' or 'inbound' when it is given.");
}

/** 404 unless this agent really has a second, addressable face. */
function requireFace(agent: { direction: string; inboundEnabled: boolean }): void {
  if (hasAddressableFace(agent)) return;

  throw new ApiError(
    404,
    'INBOUND_NOT_ENABLED',
    'This agent has no separate inbound configuration. A one-faced agent answers inbound ' +
      'calls with the same actions it makes them with.',
  );
}

/**
 * The platform does not carry the inbound hook routes.
 *
 * Only a 404 with NO V2 envelope means that: the platform's catch-all
 * answers an absent route with a bare `{ error: 'Not found' }` (app.ts:426),
 * which `unwrap` maps to RESOURCE_NOT_FOUND. It is turned into a 501 rather
 * than passed on as "not found", because a 404 reaching the dashboard would
 * read as a fact about the agent when it is a fact about the deployment.
 * `baseWriteApplied` is the other half — the write the reader asked for DID
 * happen, and a bare error would have them do it again.
 *
 * The routes' own "not found" — a stale hook id, a face that is gone — is
 * the ENVELOPED 404 NOT_FOUND (inbound-lifecycle-hooks.routes.ts:83-91,343,
 * 361,416), which the adapter passes through as itself, so the two are told
 * apart by body. That one is answered as the RESOURCE_NOT_FOUND every other
 * vanished resource gets. INBOUND_NOT_ENABLED passes through as itself.
 *
 * Only a face call can mean the 501. The base routes have always existed,
 * so a base-side 404 is a hook that is gone and stays RESOURCE_NOT_FOUND —
 * `onSide` is the one door, and it opens this mapping for the inbound side
 * alone.
 */
function faceUnavailable(details?: unknown): ApiError {
  return new ApiError(
    501,
    'INBOUND_ACTIONS_UNAVAILABLE',
    'Inbound actions are not available on the voice platform yet. ' +
      'The outbound configuration is unaffected.',
    details,
  );
}

/** The bare, un-enveloped 404 of a route the platform does not carry. */
function isUpstreamAbsent(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && err.code === 'RESOURCE_NOT_FOUND';
}

/** The face's own enveloped "no such hook / no such face". */
function isFaceNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && err.code === 'NOT_FOUND';
}

/** Runs a face call: an absent route is the 501, the face's own NOT_FOUND a 404. */
async function onFace<T>(run: () => Promise<T>, details?: unknown): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isUpstreamAbsent(err)) throw faceUnavailable(details);
    if (isFaceNotFound(err)) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Not found.');
    throw err;
  }
}

/** `onFace` for the inbound side; the base side runs as itself. */
function onSide<T>(side: Side, run: () => Promise<T>): Promise<T> {
  return side === 'inbound' ? onFace(run) : run();
}

/**
 * One stored hook row, as a create body the face's replace-all accepts.
 *
 * Rebuilt from the fields the platform's write contract names rather than
 * passed through: the read row carries `id` and `position`, which a
 * replace-all must not be handed — the face's ids are its own, and position
 * is the order of the list it is given.
 */
function toCreateBody(row: Record<string, unknown>): LifecycleHookWrite {
  const stage = (readString(row, ['stage']) ?? '').toUpperCase();
  const body: LifecycleHookWrite = {
    stage: stage === 'POST_CALL' ? 'POST_CALL' : 'PRE_CALL',
    name: readString(row, ['name']) ?? '',
  };

  const toolSlug = hookToolSlug(row);
  const toolFn = readString(row, ['toolFn', 'tool_fn']);
  const functionId = readString(row, ['functionId', 'function_id']);
  if (toolSlug !== null) body.toolSlug = toolSlug;
  if (toolFn !== null) body.toolFn = toolFn;
  if (functionId !== null) body.functionId = functionId;

  const input = readRecord(row, ['input']);
  if (input !== null) body.input = input;
  const exposeAs = readString(row, ['exposeAs', 'expose_as']);
  if (exposeAs !== null) body.exposeAs = exposeAs;
  const required = readBoolean(row, ['required']);
  if (required !== null) body.required = required;
  const timeoutMs = readNumber(row, ['timeoutMs', 'timeout_ms']);
  if (timeoutMs !== null) body.timeoutMs = timeoutMs;
  // Carried, and pinned by a test: the platform honours `enabled` on
  // replace-all (crud.service.ts:838), so a hook paused on the base arrives
  // paused on the face.
  const enabled = readBoolean(row, ['enabled']);
  if (enabled !== null) body.enabled = enabled;
  const skipUnless = readArray(row, ['skipUnless', 'skip_unless']);
  if (skipUnless !== null) {
    body.skipUnless = skipUnless.filter((v): v is string => typeof v === 'string');
  }

  return body;
}

/** What a bind, if one happened, has to be repeated as on the face. */
interface MirroredBind {
  slug: string;
  connectionId: string;
}

/**
 * Brings the face level with the base after a successful base write.
 *
 * Runs only on a one-faced agent that answers inbound calls. A failure is
 * **not** allowed to undo the base write — the action the reader asked for
 * exists, and rolling it back to keep two copies in step would lose the
 * thing they actually wanted. So the outcome rides on the response instead,
 * and the next successful write re-syncs.
 *
 * The one exception is the undeployed release, which throws: a `false` flag
 * on a 201 says "this failed, and might work next time", and a platform
 * that does not have the routes at all will not work next time either.
 */
async function mirrorFace(
  agent: { externalId: string; direction: string; inboundEnabled: boolean },
  bind: MirroredBind | null,
  details: () => unknown,
): Promise<Record<string, unknown>> {
  if (!mirrorsToFace(agent)) return {};

  try {
    if (bind !== null) {
      await setInboundAgentTool(agent.externalId, bind.slug, {
        enabled: true,
        connection_id: bind.connectionId,
      });
    }

    const { hooks } = await getAgentLifecycleHooks(agent.externalId);
    const rows = (Array.isArray(hooks) ? hooks : []).filter(isUpstreamRow);
    await replaceInboundLifecycleHooks(agent.externalId, rows.map(toCreateBody));

    return { inboundActionsSynced: true };
  } catch (err) {
    if (isUpstreamAbsent(err)) throw faceUnavailable({ baseWriteApplied: true, ...(details() as object) });

    console.error(`[actions] could not mirror ${agent.externalId} onto its inbound face:`, err);

    return {
      inboundActionsSynced: false,
      // The platform's own sentence when there is one — a reader deciding
      // whether to retry needs to know if this was a validation refusal or
      // an outage, and "sync failed" says neither.
      inboundActionsError:
        err instanceof ApiError
          ? err.message
          : 'The voice platform could not update the inbound configuration.',
    };
  }
}

/** The adapter functions for one side, so a handler names the side once. */
const FACE = {
  base: {
    list: (id: string): Promise<LifecycleHooksResponse> => getAgentLifecycleHooks(id),
    create: (id: string, body: LifecycleHookWrite): Promise<LifecycleHookResponse> =>
      createAgentLifecycleHook(id, body),
    update: (id: string, hookId: string, body: LifecycleHookPatch): Promise<LifecycleHookResponse> =>
      updateAgentLifecycleHook(id, hookId, body),
    remove: (id: string, hookId: string): Promise<void> => deleteAgentLifecycleHook(id, hookId),
    reorder: (id: string, body: LifecycleHookReorder): Promise<LifecycleHooksResponse> =>
      reorderAgentLifecycleHooks(id, body),
    preview: (
      id: string,
      hookId: string,
      body: { variables?: Record<string, unknown> },
    ): Promise<LifecycleHookPreviewResponse> => previewAgentLifecycleHook(id, hookId, body),
  },
  inbound: {
    list: (id: string): Promise<LifecycleHooksResponse> => getInboundLifecycleHooks(id),
    create: (id: string, body: LifecycleHookWrite): Promise<LifecycleHookResponse> =>
      createInboundLifecycleHook(id, body),
    update: (id: string, hookId: string, body: LifecycleHookPatch): Promise<LifecycleHookResponse> =>
      updateInboundLifecycleHook(id, hookId, body),
    remove: (id: string, hookId: string): Promise<void> => deleteInboundLifecycleHook(id, hookId),
    reorder: (id: string, body: LifecycleHookReorder): Promise<LifecycleHooksResponse> =>
      reorderInboundLifecycleHooks(id, body),
    preview: (
      id: string,
      hookId: string,
      body: { variables?: Record<string, unknown> },
    ): Promise<LifecycleHookPreviewResponse> => previewInboundLifecycleHook(id, hookId, body),
  },
} as const;

/**
 * The pre-call and post-call actions configured on this agent, or on its
 * face.
 *
 * No longer only a mirror of staff configuration. A row whose source this
 * workspace owns is its own, and comes back in full — the input template
 * included, because that is what the editor loads. A row staff bound to a
 * pool connection keeps the summary shape it has always had, and `owned`
 * says which is which so a dashboard never draws an editable blank over
 * somebody else's spreadsheet.
 *
 * Ownership is resolved once for the whole list, through the same predicate
 * every write on this surface passes: the read cannot promise an editor the
 * writes will refuse, or the reverse.
 *
 * It lives here rather than beside the tools listing it used to sit next to,
 * because `?side=` is now part of its contract and the side rules belong in
 * one file.
 */
agentActionRoutes.get(
  '/:workspaceId/agents/:agentId/lifecycle-hooks',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const side = sideOf(req.query.side);
    const agent = await agentInWorkspace(req);

    if (side === 'inbound') requireFace(agent);

    const { hooks } = await onSide(side, () => FACE[side].list(agent.externalId));
    const rows = Array.isArray(hooks) ? hooks : [];
    const owned = await hookOwnership(rows, agent.externalId, workspaceOf(req).id, toolsOf(side));

    res.json({ success: true, data: serializeLifecycleHooks(rows, owned) });
  }),
);

// ---- run visibility ----
//
// The platform writes one audit row per hook run and serves them on
// `/integration-logs`. Nothing is stored here, which is the whole design:
// there is one record of what ran and it is the platform's, so these two
// routes are projections of it and never a second copy that can disagree.
//
// The consequence is that a pruned window looks like an empty list, so both
// routes say which window they read. A dashboard cannot otherwise tell
// "nothing ran in the last day" from "this is older than the platform
// keeps", and the two want different sentences.

const RUN_PAGE = 50;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Before the session is answered a pre-call hook has already run. */
const PRE_CALL_SLACK_MS = 5 * 60 * 1000;

/** The post-call queue runs well after the caller hangs up. */
const POST_CALL_SLACK_MS = 60 * 60 * 1000;

/**
 * One audit row, rebuilt.
 *
 * The platform's row carries a redacted args summary, which is redacted for
 * the platform's own purposes and still names the customer's spreadsheet
 * and the addresses an email went to. This surface renders a status line,
 * so it gets the fields a status line is made of and nothing else.
 */
function serializeRun(row: unknown): Record<string, unknown> {
  return {
    id: readString(row, ['id']),
    session_id: readString(row, ['sessionId', 'session_id']),
    tool_slug: readString(row, ['toolSlug', 'tool_slug']),
    fn: readString(row, ['fn']),
    status: readString(row, ['status']),
    upstream_code: readNumber(row, ['upstreamCode', 'upstream_code']),
    latency_ms: readNumber(row, ['latencyMs', 'latency_ms']),
    error: runErrorLine(row),
    created_at: readString(row, ['createdAt', 'created_at']),
  };
}

/**
 * The one sentence a status line shows beside a row that did not run.
 *
 * The platform sends `errorMessage` and no other spelling
 * (integration-logs.routes.ts:229). A SKIPPED row has no error — nothing
 * failed — but "SKIPPED" beside a blank leaves the reader asking which guard
 * fired, and the platform's `resultSummary` says: the `skipUnless` path that
 * was empty, or a reason when there was no path.
 */
function runErrorLine(row: unknown): string | null {
  const message = readString(row, ['errorMessage']);
  if (message !== null) return message;

  if ((readString(row, ['status']) ?? '').toUpperCase() !== 'SKIPPED') return null;

  const summary = readRecord(row, ['resultSummary', 'result_summary']);
  const path = readString(summary, ['path']);
  if (path !== null) return `Skipped: ${path} was empty`;

  const reason = readString(summary, ['reason']);
  return reason === null ? null : `Skipped: ${reason}`;
}

/**
 * An ISO instant from the query string, or a 400.
 *
 * `new Date('yesterday')` is an Invalid Date, whose `toISOString()` throws
 * and whose comparisons are all false — so an unparseable `from` reaching
 * the platform as `NaN` would render as a window nobody asked for, silently.
 */
function instant(raw: unknown, field: string): Date | null {
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} must be an ISO 8601 timestamp.`);
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} must be an ISO 8601 timestamp.`);
  }

  return parsed;
}

function windowFrom(query: Record<string, unknown>): { from: Date; to: Date } {
  const to = instant(query.to, 'to') ?? new Date();
  const from = instant(query.from, 'from') ?? new Date(to.getTime() - DEFAULT_WINDOW_MS);

  if (from.getTime() > to.getTime()) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'from must not be later than to.');
  }

  return { from, to };
}

/**
 * The runs on one face of the agent.
 *
 * `?side=inbound` asks for the face's rows under the same side rule as the
 * hook routes: only a BI agent with a face has a second side to name (404
 * INBOUND_NOT_ENABLED otherwise). When the local row and the platform
 * disagree, the platform's own INBOUND_NOT_ENABLED arrives as itself —
 * `listIntegrationLogs` passes that one code through the V2 envelope — and
 * is answered as the same 404. The face has no id of its own here — the
 * platform keys inbound rows on the PARENT agent and `side` picks which
 * face's — so the base `externalId` goes up either way.
 *
 * Not a 501 on any 404 here: the integration-logs route has always existed,
 * so a 404 is not the "route absent" signal the hook routes read it as.
 */
agentActionRoutes.get(
  '/:workspaceId/agents/:agentId/action-runs',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const side = sideOf(req.query.side);
    const agent = await agentInWorkspace(req);
    const query = req.query as Record<string, unknown>;
    const { from, to } = windowFrom(query);
    const cursor = typeof query.cursor === 'string' && query.cursor !== '' ? query.cursor : undefined;

    if (side === 'inbound') requireFace(agent);

    const result = await listIntegrationLogs({
      agentId: agent.externalId,
      from: from.toISOString(),
      to: to.toISOString(),
      ...(cursor === undefined ? {} : { cursor }),
      ...(side === 'inbound' ? { side } : {}),
      limit: RUN_PAGE,
    });

    res.json({
      success: true,
      data: {
        runs: (Array.isArray(result.logs) ? result.logs : []).map(serializeRun),
        next_cursor: result.nextCursor ?? null,
        window: { from: from.toISOString(), to: to.toISOString() },
      },
    });
  }),
);

/**
 * The actions that ran around one call.
 *
 * `:id` is accepted as **either** the local attempt id or the platform's
 * call id. The calls surface keys on the upstream id, because there is no
 * local row behind most of what it renders; but a call that was never
 * placed has no upstream id at all, and that is exactly the case this route
 * has to be able to answer. Taking both is what makes `not_placed`
 * reachable rather than a branch no caller can get to.
 *
 * An outbound dial is a `CallAttempt`; an inbound call is a
 * `CampaignInboundCall`, found by its own id, the carrier's id the routing
 * policy carried, or the platform's call id. Both are looked up in THIS
 * workspace only.
 *
 * A null `upstreamSessionId` answers an empty list with a REASON. The
 * platform has no session to filter on, so an unqualified read would return
 * every run on the agent — every other call's — which is worse than saying
 * nothing ran, and an unexplained empty list reads as a failure of the
 * actions rather than of the dial. A call in neither table is `not_tracked`,
 * not a 404: the panel must never offer a retry that cannot succeed.
 */
agentActionRoutes.get(
  '/:workspaceId/calls/:callId/actions',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const workspaceId = workspaceOf(req).id;
    const id = req.params.callId;

    const attempt = await prisma.callAttempt.findFirst({
      where: { workspaceId, OR: [{ id }, { upstreamCallId: id }] },
      select: {
        upstreamSessionId: true,
        startedAt: true,
        endedAt: true,
        campaign: { select: { agent: { select: { externalId: true } } } },
      },
    });

    if (!attempt) {
      await inboundCallActions(workspaceId, id, res);
      return;
    }

    const externalId = attempt.campaign?.agent?.externalId ?? null;

    // No session means the dial never left, so there is nothing keyed to it.
    if (attempt.upstreamSessionId === null) {
      res.json({ success: true, data: { runs: [], reason: 'not_placed' } });
      return;
    }

    // An agent unassigned since the call is the same shape of answer as a
    // call that does not exist: without the platform's agent id there is
    // nothing to ask, and inventing an unfiltered read would serve another
    // call's runs.
    if (externalId === null) throw new ApiError(404, 'NOT_FOUND', 'Call not found.');

    const started = attempt.startedAt ?? new Date();
    const ended = attempt.endedAt ?? new Date();

    const result = await listIntegrationLogs({
      agentId: externalId,
      sessionId: attempt.upstreamSessionId,
      from: new Date(started.getTime() - PRE_CALL_SLACK_MS).toISOString(),
      to: new Date(ended.getTime() + POST_CALL_SLACK_MS).toISOString(),
      limit: RUN_PAGE,
    });

    res.json({
      success: true,
      data: { runs: (Array.isArray(result.logs) ? result.logs : []).map(serializeRun) },
    });
  }),
);

/**
 * The inbound half of the call actions read.
 *
 * Asked by `sessionId` ALONE. The runs of an inbound call are the face's,
 * and the platform keys them on the face: `agentId=<parent>` without `side`
 * excludes them (integration-logs.routes.ts:153-170). The session id is
 * exact on its own, and the partner-key scope bounds the read.
 */
async function inboundCallActions(
  workspaceId: string,
  id: string,
  res: Response,
): Promise<void> {
  const call = await prisma.campaignInboundCall.findFirst({
    where: {
      workspaceId,
      OR: [{ id }, { upstreamCallId: id }, { upstreamPhoneCallId: id }],
    },
    select: { upstreamSessionId: true, arrivedAt: true, endedAt: true },
  });

  if (!call) {
    res.json({ success: true, data: { runs: [], reason: 'not_tracked' } });
    return;
  }

  if (call.upstreamSessionId === null) {
    res.json({ success: true, data: { runs: [], reason: 'not_placed' } });
    return;
  }

  const ended = call.endedAt ?? new Date();

  const result = await listIntegrationLogs({
    sessionId: call.upstreamSessionId,
    from: new Date(call.arrivedAt.getTime() - PRE_CALL_SLACK_MS).toISOString(),
    to: new Date(ended.getTime() + POST_CALL_SLACK_MS).toISOString(),
    limit: RUN_PAGE,
  });

  res.json({
    success: true,
    data: { runs: (Array.isArray(result.logs) ? result.logs : []).map(serializeRun) },
  });
}
