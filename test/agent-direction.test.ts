import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { as, makeAccount, makeWorkspace } from './helpers.js';

/**
 * An agent's direction: what it is FOR, and therefore whether its two upstream
 * configurations are edited as one persona or two.
 *
 * YE's own column. The platform's `inbound.enabled` says whether a face
 * exists; this says how it is written.
 */

vi.mock('../src/adapter/vocobase.js', () => ({
  listAgents: vi.fn(),
  listVoices: vi.fn(),
  getAgent: vi.fn(),
  updateAgent: vi.fn(),
  setAgentInbound: vi.fn(),
  updateAgentInbound: vi.fn(),
  getAgentLifecycleHooks: vi.fn(),
  replaceInboundLifecycleHooks: vi.fn(),
  getInboundLifecycleHooks: vi.fn(),
  replaceAgentLifecycleHooks: vi.fn(),
}));

const client = await import('../src/adapter/vocobase.js');
const { createApp } = await import('../src/app.js');

const app = createApp();

function upstreamAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ext-1',
    agent_name: 'Support Line',
    status: 'active',
    voice_id: 'voice-1',
    language: 'en',
    prompt: 'Answer politely.',
    ...overrides,
  };
}

/**
 * `getAgent` as the platform answers it. The plain read is the base record
 * (`toV2AgentResponse` plus `inbound: { enabled }`, Vocobase
 * `routes/v2/agent.routes.ts:374-382`); the `?include=inbound` read nests the
 * face's own record under `inbound.config` (`:357-382`). The face defaults to
 * the base itself — two sides that match, which needs no fingerprint.
 */
function platformAgent(
  base: Record<string, unknown>,
  face: Record<string, unknown> | null = base,
) {
  vi.mocked(client.getAgent).mockImplementation(async (_id, opts) =>
    opts?.includeInbound && face
      ? { ...base, inbound: { enabled: true, config: face } }
      : base,
  );
}

/**
 * A confirmed `BI → UNI` over sides that differ: read the preview, then send
 * back the fingerprint of the chosen side, as the dashboard does. Mock call
 * history is cleared between the two so assertions see only the move.
 */
async function confirmedUni(
  workspace: Workspace,
  agentId: string,
  keep: 'outbound' | 'inbound' = 'outbound',
) {
  const preview = await request(app)
    .get(`/api/workspaces/${workspace.id}/agents/${agentId}/direction/preview?to=UNI`)
    .set(...as('user_alice', 'alice@ezo.test'))
    .expect(200);
  vi.clearAllMocks();
  const side = keep === 'inbound' ? 'keep_inbound' : 'keep_outbound';
  return request(app)
    .patch(`/api/workspaces/${workspace.id}/agents/${agentId}/direction`)
    .set(...as('user_alice', 'alice@ezo.test'))
    .send({ direction: 'UNI', confirm: true, keep, fingerprint: preview.body.data[side].fingerprint });
}

async function makeAgent(
  workspace: Workspace,
  direction: 'UNI' | 'BI' = 'UNI',
  /**
   * The platform's fact about whether a face exists, settable apart from the
   * mode because the two legitimately disagree — staff can enable or disable a
   * face upstream, `PATCH .../inbound` moves this column and not the mode, and
   * a `UNI` agent gets a face only once something routes inbound to it. So it
   * defaults to true for `BI`, which creates one by construction, and false
   * for `UNI`, which is where every agent starts.
   */
  inboundEnabled: boolean = direction === 'BI',
) {
  return prisma.agent.create({
    data: {
      externalId: 'ext-1',
      name: 'Support Line',
      status: 'active',
      workspaceId: workspace.id,
      direction,
      inboundEnabled,
    },
  });
}

beforeEach(async () => {
  await truncateAll();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.mocked(client.listVoices).mockResolvedValue({ voices: [] });
  platformAgent(upstreamAgent());
  vi.mocked(client.updateAgent).mockResolvedValue(upstreamAgent());
  vi.mocked(client.updateAgentInbound).mockResolvedValue(upstreamAgent());
  vi.mocked(client.setAgentInbound).mockResolvedValue(upstreamAgent());
  vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({ hooks: [] });
  vi.mocked(client.replaceInboundLifecycleHooks).mockResolvedValue({ hooks: [] });
  vi.mocked(client.getInboundLifecycleHooks).mockResolvedValue({ hooks: [] });
  vi.mocked(client.replaceAgentLifecycleHooks).mockResolvedValue({ hooks: [] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/**
 * A base hook as `GET /agents/:id/lifecycle-hooks` sends it: the bare
 * `{ hooks }` document of Prisma `AgentLifecycleHook` rows (Vocobase
 * `routes/v2/lifecycle-hooks.routes.ts:66-67`, ordered stage then position by
 * `crud.service.ts:661-671`), serialized — dates as ISO strings.
 */
function baseHook(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bh-1',
    agentId: 'ext-1',
    stage: 'PRE_CALL',
    position: 0,
    toolSlug: 'google_sheets',
    toolFn: 'lookup_row',
    functionId: null,
    name: 'Look up lead',
    input: { spreadsheetId: 'sheet-1', sheetName: 'Leads', matchColumn: 'phone' },
    exposeAs: 'lead',
    skipUnless: [],
    required: false,
    timeoutMs: 3000,
    enabled: true,
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
    ...overrides,
  };
}

describe('a save, by direction', () => {
  const body = { prompt: 'Answer the support line.' };

  it('writes the base config alone on a UNI agent with no face', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'UNI', false);

    await request(app)
      .patch(`/api/workspaces/${workspace.id}/agents/${agent.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send(body)
      .expect(200);

    expect(vi.mocked(client.updateAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.updateAgentInbound)).not.toHaveBeenCalled();
  });

  /**
   * The whole config, not just extraction. One editor is on screen, so what it
   * holds has to be what answers — leaving the face on an older prompt would
   * make the agent say something nothing on the page accounts for.
   */
  it('writes the SAME body to both sides on a UNI agent that has a face', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'UNI', true);

    await request(app)
      .patch(`/api/workspaces/${workspace.id}/agents/${agent.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send(body)
      .expect(200);

    expect(vi.mocked(client.updateAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.updateAgentInbound)).toHaveBeenCalledTimes(1);

    const face = vi.mocked(client.updateAgentInbound).mock.calls[0][1];
    expect(face).toMatchObject(body);
    // `toMatchObject` cannot see a field that should NOT be there, and these
    // two are the ones that must not: the face's name tracks its parent's and
    // `agent_name` is partner-unique, so sending it is a 409 waiting to happen.
    expect(face).not.toHaveProperty('agent_name');
    expect(face).not.toHaveProperty('project_id');
  });

  /**
   * The §11 mirror is OFF in BOTH, and that is the point of the mode: the two
   * sides are edited independently, so mirroring the outbound save would
   * silently overwrite the inbound extraction somebody had just written.
   */
  it('never touches the face on a BI agent, extraction included', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'BI');

    await request(app)
      .patch(`/api/workspaces/${workspace.id}/agents/${agent.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({
        ...body,
        extraction_config: {
          prompt: 'Extract the budget.',
          keys: [{ name: 'budget', type: 'string' }],
        },
      })
      .expect(200);

    expect(vi.mocked(client.updateAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.updateAgentInbound)).not.toHaveBeenCalled();
  });

  it('still 200s but flags the sync when the face write fails', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'UNI', true);
    vi.mocked(client.updateAgentInbound).mockRejectedValue(new Error('upstream down'));

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/agents/${agent.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send(body);

    // The outbound write landed, so it is not rolled back — and the two sides
    // now disagree, so it does not report a clean success either.
    expect(res.status).toBe(200);
    expect(res.body.data.inboundConfigSynced).toBe(false);
  });
});

describe('PATCH /api/workspaces/:id/agents/:agentId/direction', () => {
  const url = (workspace: Workspace, agentId: string) =>
    `/api/workspaces/${workspace.id}/agents/${agentId}/direction`;

  it('enables the face on the way to BI when there is none', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'UNI', false);

    await request(app)
      .patch(url(workspace, agent.id))
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ direction: 'BI' })
      .expect(200);

    // No `confirm`: this route never disables a face, so the platform's
    // two-step cannot arise and passing one would be meaningless.
    expect(vi.mocked(client.setAgentInbound)).toHaveBeenCalledWith('ext-1', true);
    expect(await direction(agent.id)).toBe('BI');
  });

  /**
   * The enable is a deep copy only when no face exists. Over one that was
   * switched off it revives the face UNCHANGED (Vocobase
   * `agentFace.service.ts:426-438`) — whatever persona it had before this
   * UNI agent stopped being kept level with it. Both sides must START
   * identical when the agent becomes BI, so the base is written over it:
   * config first, then its actions.
   */
  it('writes the base over a revived face on the way to BI', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'UNI', false);
    // The revived face still holds the persona it had before it was switched off.
    platformAgent(
      upstreamAgent({ prompt: 'The current base prompt.', inbound: { enabled: true } }),
      upstreamAgent({ prompt: 'An inbound persona from before.' }),
    );
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({ hooks: [baseHook()] });

    const res = await request(app)
      .patch(url(workspace, agent.id))
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ direction: 'BI' })
      .expect(200);

    expect(vi.mocked(client.updateAgentInbound)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.updateAgentInbound).mock.calls[0][1]).toMatchObject({
      prompt: 'The current base prompt.',
    });
    expect(vi.mocked(client.replaceInboundLifecycleHooks)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.replaceInboundLifecycleHooks).mock.calls[0][1]).toEqual([
      {
        stage: 'PRE_CALL',
        name: 'Look up lead',
        toolSlug: 'google_sheets',
        toolFn: 'lookup_row',
        input: { spreadsheetId: 'sheet-1', sheetName: 'Leads', matchColumn: 'phone' },
        exposeAs: 'lead',
        required: false,
        timeoutMs: 3000,
        enabled: true,
        skipUnless: [],
      },
    ]);
    const order = (fn: unknown) =>
      (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];
    expect(order(client.setAgentInbound)).toBeLessThan(order(client.updateAgentInbound));
    expect(order(client.updateAgentInbound)).toBeLessThan(order(client.replaceInboundLifecycleHooks));
    expect(res.body.data.inboundActionsSynced).toBe(true);
    expect(await direction(agent.id)).toBe('BI');
  });

  /**
   * The column is not the contract — the serialized field is. The dashboard
   * branches every one of its gates on `direction`, so a serializer that
   * stopped emitting it would ship every agent as uni-directional, hiding
   * every second persona behind a page that offers no way to reach one, with
   * the column still right in Postgres and the suite still green.
   */
  it('emits the new direction in the response body', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'UNI', false);

    const res = await request(app)
      .patch(url(workspace, agent.id))
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ direction: 'BI' })
      .expect(200);

    expect(res.body.data.direction).toBe('BI');
  });

  /**
   * The detail read is the other half of that contract. The dashboard decides
   * whether to draw one editor or two off this field, so a serializer that
   * stopped emitting it would render every bi-directional agent as a single
   * persona and hide the inbound side behind a page with no way to reach it.
   */
  it('emits the direction on the agent detail read', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'BI');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .expect(200);

    expect(res.body.data.direction).toBe('BI');
  });

  it('touches nothing upstream going to BI over a face that already exists', async () => {
    // A face somebody enabled through `PATCH .../inbound`, or that this agent
    // grew lazily as a UNI. It is already the base's deep copy or the base's
    // mirror, so the two sides are identical: all that changes is that this
    // service stops keeping them so.
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'UNI', true);

    await request(app)
      .patch(url(workspace, agent.id))
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ direction: 'BI' })
      .expect(200);

    expect(vi.mocked(client.setAgentInbound)).not.toHaveBeenCalled();
    expect(vi.mocked(client.updateAgentInbound)).not.toHaveBeenCalled();
    expect(await direction(agent.id)).toBe('BI');
  });

  it('overwrites the face with the base going back to UNI', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'BI');

    // Read from the PLATFORM, not the mirror: this write replaces a persona
    // somebody wrote, and `rawConfig` is a display cache that may be older.
    platformAgent(
      upstreamAgent({ prompt: 'Dial politely.', intro_message: 'Hello?' }),
      upstreamAgent({ prompt: 'Answer the inbound line.' }),
    );

    expect((await confirmedUni(workspace, agent.id)).status).toBe(200);

    // The outbound persona wins, which is what the confirm says it will.
    expect(vi.mocked(client.updateAgentInbound)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.updateAgentInbound).mock.calls[0][1]).toMatchObject({
      prompt: 'Dial politely.',
    });
    expect(await direction(agent.id)).toBe('UNI');
  });

  /**
   * The config overwrite leaves the face's hooks alone — `PUT .../inbound/config`
   * is scalar config only — so without this the old inbound actions keep
   * running under a mode whose one editor does not show them. The face's list
   * is replaced with the base's, in order, each row carrying whether it is
   * paused and its run condition.
   */
  it("replaces the face's actions with the base's going back to UNI", async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'BI');
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({
      hooks: [
        baseHook(),
        baseHook({
          id: 'bh-2',
          stage: 'POST_CALL',
          position: 0,
          toolSlug: null,
          toolFn: null,
          functionId: 'fn-crm',
          name: 'Push to CRM',
          input: { outcome: '{{extraction.call_outcome}}' },
          exposeAs: null,
          skipUnless: ['extraction.callback_at'],
          required: true,
          timeoutMs: 8000,
          enabled: false,
        }),
      ],
    });

    const res = await confirmedUni(workspace, agent.id);
    expect(res.status).toBe(200);

    expect(vi.mocked(client.getAgentLifecycleHooks)).toHaveBeenCalledWith('ext-1');
    expect(vi.mocked(client.replaceInboundLifecycleHooks)).toHaveBeenCalledTimes(1);
    const [id, hooks] = vi.mocked(client.replaceInboundLifecycleHooks).mock.calls[0];
    expect(id).toBe('ext-1');
    // Exact, not toMatchObject: a field that must NOT be sent (the base's own
    // ids, its position, a null source) is exactly what a partial match misses.
    expect(hooks).toEqual([
      {
        stage: 'PRE_CALL',
        name: 'Look up lead',
        toolSlug: 'google_sheets',
        toolFn: 'lookup_row',
        input: { spreadsheetId: 'sheet-1', sheetName: 'Leads', matchColumn: 'phone' },
        exposeAs: 'lead',
        required: false,
        timeoutMs: 3000,
        enabled: true,
        skipUnless: [],
      },
      {
        stage: 'POST_CALL',
        name: 'Push to CRM',
        functionId: 'fn-crm',
        input: { outcome: '{{extraction.call_outcome}}' },
        required: true,
        timeoutMs: 8000,
        enabled: false,
        skipUnless: ['extraction.callback_at'],
      },
    ]);
    // After the config: the persona first, then what it runs.
    expect(vi.mocked(client.updateAgentInbound).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(client.replaceInboundLifecycleHooks).mock.invocationCallOrder[0],
    );
    expect(res.body.data.inboundActionsSynced).toBe(true);
    expect(await direction(agent.id)).toBe('UNI');
  });

  /**
   * Best effort. The direction change the operator confirmed did happen and
   * the persona was overwritten; a hook copy that failed must not undo that
   * or report a clean success — it rides on the response for the dashboard.
   */
  it('still moves to UNI but flags it when the actions copy fails', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'BI');
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({ hooks: [baseHook()] });
    const { ApiError } = await import('../src/lib/errors.js');
    vi.mocked(client.replaceInboundLifecycleHooks).mockRejectedValue(
      new ApiError(422, 'VALIDATION_FAILED' as never, 'One or more hooks are invalid'),
    );

    const res = await confirmedUni(workspace, agent.id);
    expect(res.status).toBe(200);

    expect(res.body.data.direction).toBe('UNI');
    expect(res.body.data.inboundActionsSynced).toBe(false);
    expect(res.body.data.inboundActionsError).toBe('One or more hooks are invalid');
    expect(await direction(agent.id)).toBe('UNI');
  });

  /**
   * An unread base used to let the move go ahead with the actions flagged.
   * Now it cannot be compared or confirmed, so the move is refused before
   * anything is written: an overwrite nobody could see the diff of is the
   * incident this guards against.
   */
  it('refuses the move, writing nothing, when the base actions cannot be read', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'BI');
    vi.mocked(client.getAgentLifecycleHooks).mockRejectedValue(new Error('socket hang up'));

    const res = await request(app)
      .patch(url(workspace, agent.id))
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ direction: 'UNI', confirm: true });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('SNAPSHOT_FAILED');
    expect(vi.mocked(client.updateAgentInbound)).not.toHaveBeenCalled();
    expect(vi.mocked(client.replaceInboundLifecycleHooks)).not.toHaveBeenCalled();
    expect(await direction(agent.id)).toBe('BI');
  });

  // The copy's own guard, on the path that still copies after reading: a
  // revive, where only the face is snapshotted and the base hooks are read by
  // the copy itself.
  it('flags the copy, and still moves, when the base actions cannot be read on a revive', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'UNI', false);
    vi.mocked(client.getAgentLifecycleHooks).mockRejectedValue(new Error('socket hang up'));

    const res = await request(app)
      .patch(url(workspace, agent.id))
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ direction: 'BI' })
      .expect(200);

    // Never an empty replace-all: an unread base must not clear the face.
    expect(vi.mocked(client.replaceInboundLifecycleHooks)).not.toHaveBeenCalled();
    expect(res.body.data.inboundActionsSynced).toBe(false);
    expect(await direction(agent.id)).toBe('BI');
  });

  it('never clears the face from a base read that carried no list', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'UNI', false);
    // The adapter's bare-body predicate should make this unreachable; the
    // copy must still not read a missing list as an empty one.
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({});

    const res = await request(app)
      .patch(url(workspace, agent.id))
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ direction: 'BI' })
      .expect(200);

    expect(vi.mocked(client.replaceInboundLifecycleHooks)).not.toHaveBeenCalled();
    expect(res.body.data.inboundActionsSynced).toBe(false);
    expect(res.body.data.inboundActionsError).toBe("The agent's actions could not be read.");
  });

  /**
   * The property that retires the platform's whole `CONFIRM_REQUIRED`
   * two-step: nothing on this route turns a face off. Numbers stay linked,
   * inbound campaigns keep running, and turning an agent bi-directional and
   * back loses nothing but the inbound edits the confirm warns about.
   */
  it('never disables a face on any move', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'BI');
    // What the platform actually reports for this agent: the face is on, and
    // this move is not what turns it off. The mirror refresh at the end of the
    // route reads this, so a fixture omitting it would blank the column here
    // and the assertion below would be about the fixture rather than the move.
    platformAgent(upstreamAgent({ inbound: { enabled: true } }), upstreamAgent());

    await request(app)
      .patch(url(workspace, agent.id))
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ direction: 'UNI', confirm: true })
      .expect(200);

    expect(vi.mocked(client.setAgentInbound)).not.toHaveBeenCalled();
    // And the face survives the move, which is what makes every inbound
    // number and campaign bound to it keep working.
    const agentRow = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(agentRow.inboundEnabled).toBe(true);
  });

  /**
   * The one move that destroys something a person wrote, so it is the one
   * move that asks. YE's own confirm, not the platform's: the upstream
   * two-step guards a disable, and there is no disable here.
   */
  it('refuses BI to UNI without a confirm, and writes nothing', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'BI');

    const res = await request(app)
      .patch(url(workspace, agent.id))
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ direction: 'UNI' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFIRM_REQUIRED');
    expect(res.body.details).toMatchObject({ overwrites: 'inbound' });
    expect(vi.mocked(client.updateAgentInbound)).not.toHaveBeenCalled();
    expect(vi.mocked(client.setAgentInbound)).not.toHaveBeenCalled();
    // The mode must not move when the face did not.
    expect(await direction(agent.id)).toBe('BI');
  });

  /**
   * Asked for even where there is no face to overwrite — a `BI` agent whose
   * face staff turned off upstream. Gating the confirm on `inboundEnabled`
   * would make the dialog appear or not according to a platform fact the
   * operator did not change and cannot see, and the cost of asking when
   * nothing would be lost is a click, where the cost of not asking when
   * something would be is somebody's inbound persona.
   */
  it('asks for the same confirm when there is no face to overwrite', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'BI', false);

    await request(app)
      .patch(url(workspace, agent.id))
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ direction: 'UNI' })
      .expect(409);

    expect(await direction(agent.id)).toBe('BI');

    await request(app)
      .patch(url(workspace, agent.id))
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ direction: 'UNI', confirm: true })
      .expect(200);

    // Confirmed, but there was never a face: nothing to write over.
    expect(vi.mocked(client.updateAgentInbound)).not.toHaveBeenCalled();
    expect(vi.mocked(client.replaceInboundLifecycleHooks)).not.toHaveBeenCalled();
    expect(await direction(agent.id)).toBe('UNI');
  });

  it('is a no-op when the direction is already what was asked for', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'BI');

    await request(app)
      .patch(url(workspace, agent.id))
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ direction: 'BI' })
      .expect(200);

    expect(vi.mocked(client.setAgentInbound)).not.toHaveBeenCalled();
    expect(vi.mocked(client.updateAgentInbound)).not.toHaveBeenCalled();
  });

  it('refuses a value that is not a direction', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'UNI', false);

    await request(app)
      .patch(url(workspace, agent.id))
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ direction: 'SIDEWAYS' })
      .expect(400);
  });

  /**
   * A retired value is refused by the same rule, and that matters for one
   * release: the dashboard ships first and reads both vocabularies, so an
   * older build can still be posting `BOTH` at a backend that has moved. A
   * 400 naming the field is the honest answer — accepting it would mean
   * guessing which of two personas the caller meant.
   */
  it('refuses a retired three-mode value', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'UNI', false);

    const res = await request(app)
      .patch(url(workspace, agent.id))
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ direction: 'BOTH' })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    // Nothing upstream, and the column stands.
    expect(vi.mocked(client.setAgentInbound)).not.toHaveBeenCalled();
    expect(await direction(agent.id)).toBe('UNI');
  });

  it('404s an agent that is not this workspace, without calling upstream', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const alices = await makeWorkspace(alice, 'Alice Co');
    const bobs = await makeWorkspace(bob, 'Bob Co');
    const agent = await makeAgent(alices, 'UNI', false);

    await request(app)
      .patch(url(bobs, agent.id))
      .set(...as('user_bob', 'bob@ezo.test'))
      .send({ direction: 'BI' })
      .expect(404);

    expect(vi.mocked(client.setAgentInbound)).not.toHaveBeenCalled();
  });
});

describe('two direction changes racing', () => {
  /**
   * Every decision this route makes comes from the row it read at the top, and
   * the write at the bottom took no account of that row having moved. Two
   * moves in flight could therefore interleave into a state the route's own
   * docblock forbids: A writes the base over the face (`BI → UNI`) while B,
   * reading the same `BI` row, lands after it — two personas on record, one
   * of them just erased, and nobody told.
   */
  it('refuses the write when the mode moved under it', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'BI');

    // The other request lands while this one is upstream — the exact window
    // between this route's read and its write. `BI → UNI` over a live face
    // makes no `setAgentInbound` call, so the overwrite is the window.
    vi.mocked(client.updateAgentInbound).mockImplementation(async () => {
      await prisma.agent.update({
        where: { id: agent.id },
        data: { direction: 'UNI', inboundEnabled: false },
      });
      return upstreamAgent();
    });

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/agents/${agent.id}/direction`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ direction: 'UNI', confirm: true });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DIRECTION_CHANGED');
    // The winner stands rather than being overwritten by the stale decision.
    expect(await direction(agent.id)).toBe('UNI');
  });
});

describe('the mirror rule', () => {
  it('sync never writes direction', async () => {
    // `direction` is YE's, not the platform's. A refresh that touched it
    // would silently re-mode every agent staff had configured.
    const source = await import('../src/services/agentSync.js');
    expect(Object.keys(source)).toBeTruthy();

    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'BI');

    const { refreshAgent } = await import('../src/services/agentSync.js');
    vi.mocked(client.getAgent).mockResolvedValue(
      upstreamAgent({ inbound: { enabled: true } }),
    );
    await refreshAgent('ext-1');

    expect(await direction(agent.id)).toBe('BI');
  });
});

describe('the body the face is overwritten with', () => {
  /**
   * The overwrite is owed by the mode being LEFT, not by how the face came to
   * exist: every `BI` agent has one by construction, whether the enable made
   * it on the way up or it was already there. What the test pins is the shape
   * of the body — the face has no name or project of its own.
   */
  it('writes the base over the face, carrying neither name nor project', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'BI');

    platformAgent(upstreamAgent({ prompt: 'Dial politely.', intro_message: 'Hello?' }));

    await request(app)
      .patch(`/api/workspaces/${workspace.id}/agents/${agent.id}/direction`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ direction: 'UNI', confirm: true })
      .expect(200);

    expect(vi.mocked(client.updateAgentInbound)).toHaveBeenCalledTimes(1);
    const face = vi.mocked(client.updateAgentInbound).mock.calls[0][1];
    expect(face).toMatchObject({ prompt: 'Dial politely.', intro_message: 'Hello?' });
    // The face has no name or project of its own: upstream discards both, and
    // `agent_name` is partner-unique, so sending it is a 409 waiting to happen.
    expect(face).not.toHaveProperty('agent_name');
    expect(face).not.toHaveProperty('project_id');
  });
});

describe('the base config the face is overwritten with', () => {
  async function biAgent() {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'BI');
    return { workspace, agent };
  }

  const toUni = (workspace: Workspace, agentId: string) =>
    request(app)
      .patch(`/api/workspaces/${workspace.id}/agents/${agentId}/direction`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ direction: 'UNI', confirm: true });

  const faceBody = () =>
    vi.mocked(client.updateAgentInbound).mock.calls[0][1] as Record<string, unknown>;

  /**
   * Arriving at UNI makes the face EQUAL the base — it is an overwrite,
   * not a patch. A field the base has cleared and the face has set is a
   * divergence like any other, and omitting the key leaves the face's own
   * value standing under a mode that claims one persona.
   */
  it('clears a field the base does not carry', async () => {
    const { workspace, agent } = await biAgent();
    // No `intro_message` upstream: the base has no greeting.
    platformAgent(upstreamAgent());

    await toUni(workspace, agent.id).expect(200);

    expect(faceBody()).toHaveProperty('intro_message', null);
  });

  /**
   * Only where the platform takes one. `prompt`, `voice_id` and the booleans
   * have no null, so a base that does not carry them cannot clear the face's —
   * that is the platform's constraint, and it is better stated than papered
   * over with an invented value.
   */
  it('does not invent a null for a field that has none, and says nothing about it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { workspace, agent } = await biAgent();
    platformAgent(upstreamAgent({ prompt: 'Dial politely.' }));

    await toUni(workspace, agent.id).expect(200);

    expect(faceBody()).not.toHaveProperty('enable_recording');
    expect(faceBody()).toHaveProperty('prompt', 'Dial politely.');
    // A boolean the base simply does not carry is this service declining to
    // invent a value, not the platform handing back one we refuse — warning
    // about it on every transition is how a real warning gets learned as noise.
    expect(warn).not.toHaveBeenCalled();
  });

  /**
   * This body is assembled from the platform's own response rather than sent
   * by a caller, so a value our schema will not take is the platform's data
   * and not the operator's mistake. `agent_type` is documented as frequently
   * null in real data; refusing the whole move over it would strand exactly
   * the agents that state is common on.
   */
  it('drops a value the payload schema refuses, and still makes the move', async () => {
    const { workspace, agent } = await biAgent();
    platformAgent(upstreamAgent({ agent_type: null, prompt: 'Dial politely.' }));

    await toUni(workspace, agent.id).expect(200);

    expect(faceBody()).not.toHaveProperty('agent_type');
    expect(faceBody()).toHaveProperty('prompt', 'Dial politely.');
    expect(await direction(agent.id)).toBe('UNI');
  });
});

describe('a mirrored save with nothing to mirror', () => {
  /**
   * The platform's update takes every field as optional but requires at least
   * one, so an empty body is a 400 — and the route would report it as
   * `inboundConfigSynced: false`, telling the operator the two sides diverged
   * when the save carried nothing that could diverge.
   */
  it('does not write the face when the strip leaves the body empty', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'UNI', true);

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/agents/${agent.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      // `agent_name` is the whole body, and it is stripped from the face write.
      .send({ agent_name: 'Renamed' })
      .expect(200);

    expect(vi.mocked(client.updateAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.updateAgentInbound)).not.toHaveBeenCalled();
    // Nothing was attempted, so nothing failed: the operator must not be told
    // the two sides may differ.
    expect(res.body.data.inboundConfigSynced).not.toBe(false);
  });
});

describe('the face variable union on the mirror path', () => {
  /**
   * `unionWithUpstreamVariables` takes `faceExists` to tell two silences
   * apart: a face that was never enabled has no list to lose, while a face
   * that exists and could not be read is the truncation the function is there
   * to prevent. The mirror only runs when `inboundEnabled` is true, so it is
   * always the second case and must say so.
   */
  it('warns rather than silently truncating when the face cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'UNI', true);

    // Upstream hands back no `inbound` record for a face the mirror says exists.
    vi.mocked(client.getAgent).mockResolvedValue(upstreamAgent());

    await request(app)
      .patch(`/api/workspaces/${workspace.id}/agents/${agent.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ prompt: 'Answer the support line.', variables: ['lead_id'] })
      .expect(200);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('face is enabled'));
  });
});

async function direction(agentId: string): Promise<string> {
  const row = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  return row.direction;
}

/**
 * The enum itself. Two values, because the only decision a reader makes is
 * whether the agent has one persona or two — "is that one persona outbound or
 * inbound" was a question about the platform's plumbing dressed up as a
 * product choice, and it produced a mode whose agents silently could not
 * answer a call until somebody found the dropdown.
 */
describe('the direction enum', () => {
  it('defaults a new agent to UNI', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');

    const agent = await prisma.agent.create({
      data: { externalId: 'ext-default', name: 'No direction given', workspaceId: workspace.id },
    });

    expect(agent.direction).toBe('UNI');
  });

  /**
   * The `@ts-expect-error` is half the test and `tsc --noEmit` is what runs
   * it: were `BOTH` still assignable the suppression would be unused and the
   * build would fail on it. The rejection below is the other half — the
   * database's own refusal, which is what actually stops a stale caller.
   */
  it('refuses a retired three-mode value', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');

    await expect(
      prisma.agent.create({
        data: {
          externalId: 'ext-retired',
          name: 'Three-mode',
          workspaceId: workspace.id,
          // @ts-expect-error `BOTH` is not a direction any more — it is `BI`.
          direction: 'BOTH',
        },
      }),
    ).rejects.toThrow();
  });
});

/**
 * Which persona survives a `BI → UNI` move.
 *
 * `keep` defaults to `'outbound'` — the base is written over the face, as it
 * always was. `'inbound'` first makes the BASE equal to the face (its actions,
 * then its configuration) and then runs that same path, so both sides end as
 * the inbound persona.
 *
 * Mocked platform shapes, as the adapter hands them to the route:
 *  - `getAgent(id, { includeInbound: true })` → the base record with the face
 *    NESTED as `inbound: { enabled, config }` (the `?include=inbound` read the
 *    GET handler's `faceConfig` unwraps).
 *  - `getInboundLifecycleHooks` → `{ hooks }` of Prisma `AgentLifecycleHook`
 *    rows, the face route's `{ success, data: { hooks } }` after `unwrap`.
 *  - `replaceAgentLifecycleHooks` → the bare `{ hooks }` document; a refusal is
 *    the bare 422 `{ error: 'VALIDATION_FAILED', issues }`, which the adapter
 *    throws as ApiError(422, 'VALIDATION_FAILED', …, { issues }); an
 *    undeployed route is the catch-all `{ error: 'Not found' }`, which the
 *    adapter throws as ApiError(501, 'KEEP_INBOUND_UNAVAILABLE', …).
 */
describe('keeping a persona on the way to UNI', () => {
  const url = (workspace: Workspace, agentId: string) =>
    `/api/workspaces/${workspace.id}/agents/${agentId}/direction`;

  const faceConfigBody = {
    agent_name: 'Support Line (inbound)',
    project_id: 'proj-face',
    prompt: 'Answer the inbound line.',
    intro_message: 'Thanks for calling.',
    voice_id: 'voice-face',
    variables: ['caller_name'],
    extraction_enabled: true,
    extraction_config: {
      prompt: 'Extract the reason.',
      keys: [{ name: 'reason', type: 'string' }],
    },
    enable_recording: false,
    max_call_duration_secs: 600,
  };

  /** The base, with its face under `inbound.config` when asked for it. */
  function withFace(face: Record<string, unknown> | null = faceConfigBody) {
    vi.mocked(client.getAgent).mockImplementation(async (_id, opts) =>
      upstreamAgent({
        variables: ['lead_id'],
        inbound:
          opts?.includeInbound && face !== null
            ? { enabled: true, config: face }
            : { enabled: true },
      }),
    );
  }

  const faceHooks = [
    baseHook({ id: 'fh-1', name: 'Look up caller', exposeAs: 'caller' }),
    baseHook({
      id: 'fh-2',
      stage: 'POST_CALL',
      toolSlug: null,
      toolFn: null,
      functionId: 'fn-crm',
      name: 'Log the call',
      input: { reason: '{{extraction.reason}}' },
      exposeAs: null,
      skipUnless: ['extraction.reason'],
      required: true,
      timeoutMs: 8000,
      enabled: false,
    }),
  ];

  async function biAgent() {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'BI');
    return { workspace, agent };
  }

  function nothingWritten() {
    expect(vi.mocked(client.replaceAgentLifecycleHooks)).not.toHaveBeenCalled();
    expect(vi.mocked(client.updateAgent)).not.toHaveBeenCalled();
    expect(vi.mocked(client.updateAgentInbound)).not.toHaveBeenCalled();
    expect(vi.mocked(client.replaceInboundLifecycleHooks)).not.toHaveBeenCalled();
  }

  /**
   * There is no default once the sides differ: the move that destroyed a
   * whole inbound persona on 2026-09-21 was exactly this omitted keep.
   */
  it('refuses an omitted keep when the sides differ, and writes nothing', async () => {
    const { workspace, agent } = await biAgent();
    withFace();

    const res = await request(app)
      .patch(url(workspace, agent.id))
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ direction: 'UNI', confirm: true });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OVERWRITE_CONFIRM_REQUIRED');
    nothingWritten();
    expect(await direction(agent.id)).toBe('BI');
  });

  it("keep: 'outbound' is the same move", async () => {
    const { workspace, agent } = await biAgent();
    withFace();

    const res = await confirmedUni(workspace, agent.id, 'outbound');
    expect(res.status).toBe(200);

    expect(res.body.data.kept).toBe('outbound');
    expect(res.body.data.inboundActionsSynced).toBe(true);
    expect(vi.mocked(client.replaceAgentLifecycleHooks)).not.toHaveBeenCalled();
    expect(vi.mocked(client.updateAgent)).not.toHaveBeenCalled();
    expect(vi.mocked(client.updateAgentInbound)).toHaveBeenCalledTimes(1);
    expect(await direction(agent.id)).toBe('UNI');
  });

  it("keep: 'inbound' moves the face's actions and config onto the base, then levels the face", async () => {
    const { workspace, agent } = await biAgent();
    withFace();
    vi.mocked(client.getInboundLifecycleHooks).mockResolvedValue({ hooks: faceHooks });

    const res = await confirmedUni(workspace, agent.id, 'inbound');
    expect(res.status).toBe(200);

    expect(vi.mocked(client.getAgent)).toHaveBeenCalledWith('ext-1', { includeInbound: true });
    expect(vi.mocked(client.getInboundLifecycleHooks)).toHaveBeenCalledWith('ext-1');

    // The face's list, in order, each row carrying its pause and run condition.
    expect(vi.mocked(client.replaceAgentLifecycleHooks)).toHaveBeenCalledTimes(1);
    const [hookId, hooks] = vi.mocked(client.replaceAgentLifecycleHooks).mock.calls[0];
    expect(hookId).toBe('ext-1');
    expect(hooks).toEqual([
      {
        stage: 'PRE_CALL',
        name: 'Look up caller',
        toolSlug: 'google_sheets',
        toolFn: 'lookup_row',
        input: { spreadsheetId: 'sheet-1', sheetName: 'Leads', matchColumn: 'phone' },
        exposeAs: 'caller',
        required: false,
        timeoutMs: 3000,
        enabled: true,
        skipUnless: [],
      },
      {
        stage: 'POST_CALL',
        name: 'Log the call',
        functionId: 'fn-crm',
        input: { reason: '{{extraction.reason}}' },
        required: true,
        timeoutMs: 8000,
        enabled: false,
        skipUnless: ['extraction.reason'],
      },
    ]);

    // The face's configuration onto the base, never its name or project.
    expect(vi.mocked(client.updateAgent)).toHaveBeenCalledTimes(1);
    const [baseId, base] = vi.mocked(client.updateAgent).mock.calls[0];
    expect(baseId).toBe('ext-1');
    expect(base).toMatchObject({
      prompt: 'Answer the inbound line.',
      intro_message: 'Thanks for calling.',
      voice_id: 'voice-face',
      extraction_enabled: true,
      extraction_config: faceConfigBody.extraction_config,
      enable_recording: false,
      max_call_duration_secs: 600,
    });
    expect(base).not.toHaveProperty('agent_name');
    expect(base).not.toHaveProperty('project_id');
    // Unioned the way the outbound save unions: the face's names first, then
    // any the base declares that the face does not.
    expect(base.variables).toEqual(['caller_name', 'lead_id']);

    // Actions first, then the base config, then the face overwrite.
    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0];
    expect(order(vi.mocked(client.replaceAgentLifecycleHooks))).toBeLessThan(
      order(vi.mocked(client.updateAgent)),
    );
    expect(order(vi.mocked(client.updateAgent))).toBeLessThan(
      order(vi.mocked(client.updateAgentInbound)),
    );
    expect(vi.mocked(client.replaceInboundLifecycleHooks)).toHaveBeenCalledTimes(1);

    expect(res.body.data.kept).toBe('inbound');
    expect(res.body.data.inboundActionsSynced).toBe(true);
    expect(await direction(agent.id)).toBe('UNI');
  });

  it('refuses a face that cannot be read, and writes nothing', async () => {
    const { workspace, agent } = await biAgent();
    // No `inbound.config` on the include read: nothing to keep.
    withFace(null);

    const res = await request(app)
      .patch(url(workspace, agent.id))
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ direction: 'UNI', confirm: true, keep: 'inbound' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('KEEP_INBOUND_UNREADABLE');
    nothingWritten();
    expect(await direction(agent.id)).toBe('BI');
  });

  it('refuses when the face read itself fails, and writes nothing', async () => {
    const { workspace, agent } = await biAgent();
    vi.mocked(client.getAgent).mockRejectedValue(new Error('upstream down'));

    const res = await request(app)
      .patch(url(workspace, agent.id))
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ direction: 'UNI', confirm: true, keep: 'inbound' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('KEEP_INBOUND_UNREADABLE');
    nothingWritten();
    expect(await direction(agent.id)).toBe('BI');
  });

  it("refuses a face whose actions came back as no list, rather than clearing the base's", async () => {
    const { workspace, agent } = await biAgent();
    withFace();
    // A read that carried no `hooks` array. Replacing the base with "none"
    // would silently delete its actions and call that keeping the face's.
    vi.mocked(client.getInboundLifecycleHooks).mockResolvedValue({});

    const res = await request(app)
      .patch(url(workspace, agent.id))
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ direction: 'UNI', confirm: true, keep: 'inbound' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('KEEP_INBOUND_UNREADABLE');
    nothingWritten();
    expect(await direction(agent.id)).toBe('BI');
  });

  it('refuses a face with an empty prompt, and writes nothing', async () => {
    const { workspace, agent } = await biAgent();
    withFace({ ...faceConfigBody, prompt: '   ' });

    const res = await request(app)
      .patch(url(workspace, agent.id))
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ direction: 'UNI', confirm: true, keep: 'inbound' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('KEEP_INBOUND_EMPTY');
    nothingWritten();
    expect(await direction(agent.id)).toBe('BI');
  });

  it('refuses a BI agent with no face to keep, and writes nothing', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, 'BI', false);
    withFace();

    const res = await request(app)
      .patch(url(workspace, agent.id))
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ direction: 'UNI', confirm: true, keep: 'inbound' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('KEEP_INBOUND_UNREADABLE');
    nothingWritten();
    expect(await direction(agent.id)).toBe('BI');
  });

  it('answers 501 when the base replace-all is not deployed, and changes nothing else', async () => {
    const { workspace, agent } = await biAgent();
    withFace();
    vi.mocked(client.getInboundLifecycleHooks).mockResolvedValue({ hooks: faceHooks });
    const { ApiError } = await import('../src/lib/errors.js');
    // What the adapter throws for the catch-all `{ error: 'Not found' }`.
    vi.mocked(client.replaceAgentLifecycleHooks).mockRejectedValue(
      new ApiError(
        501,
        'KEEP_INBOUND_UNAVAILABLE',
        'Keeping the inbound persona needs a platform update that is not live yet. ' +
          'Keep the outbound persona, or try again later.',
      ),
    );

    const res = await confirmedUni(workspace, agent.id, 'inbound');

    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('KEEP_INBOUND_UNAVAILABLE');
    expect(res.body.error.message).toBe(
      'Keeping the inbound persona needs a platform update that is not live yet. ' +
        'Keep the outbound persona, or try again later.',
    );
    expect(vi.mocked(client.updateAgent)).not.toHaveBeenCalled();
    expect(vi.mocked(client.updateAgentInbound)).not.toHaveBeenCalled();
    expect(vi.mocked(client.replaceInboundLifecycleHooks)).not.toHaveBeenCalled();
    expect(await direction(agent.id)).toBe('BI');
  });

  it("passes the base replace-all's 422 through, and changes nothing else", async () => {
    const { workspace, agent } = await biAgent();
    withFace();
    vi.mocked(client.getInboundLifecycleHooks).mockResolvedValue({ hooks: faceHooks });
    const { ApiError } = await import('../src/lib/errors.js');
    const issues = [{ field: 'hooks[0].toolFn', code: 'UNKNOWN_FN', message: 'no such fn' }];
    // What the adapter throws for the bare `{ error: 'VALIDATION_FAILED', issues }`.
    vi.mocked(client.replaceAgentLifecycleHooks).mockRejectedValue(
      new ApiError(422, 'VALIDATION_FAILED' as never, 'The voice platform rejected those values.', {
        issues,
      }),
    );

    const res = await confirmedUni(workspace, agent.id, 'inbound');

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.details).toEqual({ issues });
    expect(vi.mocked(client.updateAgent)).not.toHaveBeenCalled();
    expect(vi.mocked(client.updateAgentInbound)).not.toHaveBeenCalled();
    expect(vi.mocked(client.replaceInboundLifecycleHooks)).not.toHaveBeenCalled();
    expect(await direction(agent.id)).toBe('BI');
  });

  it('puts the outbound actions back and answers 502 when the base config write fails', async () => {
    const { workspace, agent } = await biAgent();
    withFace();
    vi.mocked(client.getInboundLifecycleHooks).mockResolvedValue({ hooks: faceHooks });
    vi.mocked(client.updateAgent).mockRejectedValue(new Error('upstream down'));

    const res = await confirmedUni(workspace, agent.id, 'inbound');

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('KEEP_INBOUND_FAILED');
    expect(res.body.error.message).toBe(
      'The inbound persona could not be moved onto the agent, so nothing was changed.',
    );
    // The face's actions, then the base's own put back.
    expect(vi.mocked(client.replaceAgentLifecycleHooks)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.updateAgentInbound)).not.toHaveBeenCalled();
    expect(vi.mocked(client.replaceInboundLifecycleHooks)).not.toHaveBeenCalled();
    expect(await direction(agent.id)).toBe('BI');
  });

  it.each([
    ['UNI → BI', 'UNI' as const, 'BI' as const, 'inbound'],
    ['UNI → BI keeping outbound', 'UNI' as const, 'BI' as const, 'outbound'],
    ['a UNI no-op', 'UNI' as const, 'UNI' as const, 'inbound'],
    ['a BI no-op', 'BI' as const, 'BI' as const, 'outbound'],
  ])('refuses keep on %s', async (_label, from, to, keep) => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeAgent(workspace, from);

    const res = await request(app)
      .patch(url(workspace, agent.id))
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ direction: to, confirm: true, keep });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(vi.mocked(client.setAgentInbound)).not.toHaveBeenCalled();
    nothingWritten();
    expect(await direction(agent.id)).toBe(from);
  });

  it('refuses a keep that is not a persona', async () => {
    const { workspace, agent } = await biAgent();

    const res = await request(app)
      .patch(url(workspace, agent.id))
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ direction: 'UNI', confirm: true, keep: 'both' });

    expect(res.status).toBe(400);
    nothingWritten();
  });

  it('404s another workspace\'s agent before reading anything', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const bobs = await makeWorkspace(bob, 'Bob Co');
    const agent = await makeAgent(workspace, 'BI');
    withFace();

    await request(app)
      .patch(url(bobs, agent.id))
      .set(...as('user_bob', 'bob@ezo.test'))
      .send({ direction: 'UNI', confirm: true, keep: 'inbound' })
      .expect(404);

    expect(vi.mocked(client.getAgent)).not.toHaveBeenCalled();
    nothingWritten();
  });
});
