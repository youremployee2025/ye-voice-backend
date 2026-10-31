import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { addMember, as, makeAccount, makeWorkspace } from './helpers.js';

// No test may reach the real partner API — it is production and holds live
// customer agents.
vi.mock('../src/adapter/vocobase.js', () => ({
  listAgents: vi.fn(),
  listVoices: vi.fn(),
  getAgent: vi.fn(),
  updateAgent: vi.fn(),
  setAgentInbound: vi.fn(),
  updateAgentInbound: vi.fn(),
}));

const client = await import('../src/adapter/vocobase.js');
const { createApp } = await import('../src/app.js');
const { ApiError } = await import('../src/lib/errors.js');

const app = createApp();

/** The agent as the platform returns it on a read, with the inbound face flag. */
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

async function makeInbounddableAgent(workspace: Workspace, externalId = 'ext-1') {
  return prisma.agent.create({
    data: { externalId, name: 'Support Line', status: 'active', workspaceId: workspace.id },
  });
}

beforeEach(async () => {
  await truncateAll();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.mocked(client.listVoices).mockResolvedValue({ voices: [] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('PATCH /api/workspaces/:id/agents/:agentId/inbound', () => {
  it('enables the inbound face and mirrors it, idempotently', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeInbounddableAgent(workspace);
    vi.mocked(client.setAgentInbound).mockResolvedValue(upstreamAgent({ inbound: { enabled: true } }));
    vi.mocked(client.getAgent).mockResolvedValue(upstreamAgent({ inbound: { enabled: true } }));

    const send = () =>
      request(app)
        .patch(`/api/workspaces/${workspace.id}/agents/${agent.id}/inbound`)
        .set(...as('user_alice', 'alice@ezo.test'))
        .send({ enabled: true });

    const first = await send();
    expect(first.status).toBe(200);
    expect(vi.mocked(client.setAgentInbound)).toHaveBeenCalledWith('ext-1', true, undefined);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).inboundEnabled).toBe(true);

    // Idempotent: a second enable is another clean 200, not a conflict.
    const second = await send();
    expect(second.status).toBe(200);
  });

  it('returns 409 CONFIRM_REQUIRED with its details intact on a disable without confirm', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeInbounddableAgent(workspace);
    const details = {
      phone_numbers: [{ id: 'pn-1', did: '+919000000001' }],
      campaigns: [{ id: 'c-1', name: 'Support' }],
    };
    vi.mocked(client.setAgentInbound).mockRejectedValue(
      new ApiError(409, 'CONFIRM_REQUIRED', 'Confirm to unlink these numbers and campaigns.', details),
    );

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/agents/${agent.id}/inbound`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ enabled: false });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFIRM_REQUIRED');
    // A sibling of `error`, not nested — this is the documented parsing trap.
    expect(res.body.details).toEqual(details);
    // The mirror is untouched: the write never happened.
    expect(vi.mocked(client.getAgent)).not.toHaveBeenCalled();
  });

  it('disables with confirm and mirrors the face off', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeInbounddableAgent(workspace);
    await prisma.agent.update({ where: { id: agent.id }, data: { inboundEnabled: true } });
    vi.mocked(client.setAgentInbound).mockResolvedValue(upstreamAgent({ inbound: { enabled: false } }));
    vi.mocked(client.getAgent).mockResolvedValue(upstreamAgent({ inbound: { enabled: false } }));

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/agents/${agent.id}/inbound`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ enabled: false, confirm: true });

    expect(res.status).toBe(200);
    expect(vi.mocked(client.setAgentInbound)).toHaveBeenCalledWith('ext-1', false, true);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).inboundEnabled).toBe(false);
  });

  it('lets a MEMBER toggle inbound, matching the agent-surface deviation', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await addMember(workspace, bob, 'MEMBER');
    const agent = await makeInbounddableAgent(workspace);
    vi.mocked(client.setAgentInbound).mockResolvedValue(upstreamAgent({ inbound: { enabled: true } }));
    vi.mocked(client.getAgent).mockResolvedValue(upstreamAgent({ inbound: { enabled: true } }));

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/agents/${agent.id}/inbound`)
      .set(...as('user_bob', 'bob@ezo.test'))
      .send({ enabled: true });

    expect(res.status).toBe(200);
  });

  it('404s an agent that is not this workspace, without calling upstream', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const mine = await makeWorkspace(alice, 'Alice Co');
    const theirs = await makeWorkspace(bob, 'Bob Co');
    const agent = await makeInbounddableAgent(theirs, 'ext-theirs');

    const res = await request(app)
      .patch(`/api/workspaces/${mine.id}/agents/${agent.id}/inbound`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ enabled: true });

    expect(res.status).toBe(404);
    expect(vi.mocked(client.setAgentInbound)).not.toHaveBeenCalled();
  });
});

describe('GET /api/workspaces/:id/agents/:agentId?include=inbound', () => {
  it('attaches the live inbound configuration', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeInbounddableAgent(workspace);
    vi.mocked(client.getAgent).mockResolvedValue(
      upstreamAgent({ inbound: { prompt: 'Answer the support line.', voice_id: 'voice-2' } }),
    );

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}?include=inbound`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(vi.mocked(client.getAgent)).toHaveBeenCalledWith('ext-1', { includeInbound: true });
    expect(res.body.data.inbound).toMatchObject({ prompt: 'Answer the support line.', voice_id: 'voice-2' });
  });

  /**
   * The shape the platform actually sends.
   *
   * `?include=inbound` answers `inbound: { enabled, config }` — the face's
   * configuration is NESTED under `config`, not flat beside `enabled`. Read
   * flat, every field comes back absent and `visibleConfig` hands out a
   * perfectly well-formed object with nothing in it: not `null`, so no null
   * check on any caller can tell "this face is empty" from "we looked in the
   * wrong place". The editor then renders blank boxes over a live persona and
   * the next Save writes them over it.
   *
   * Verified against production on 2026-09-21: the plain agent read returns
   * `inbound: { enabled: true }`, and `?include=inbound` returns
   * `inbound: { enabled: true, config: { … } }`.
   */
  it('reads the face from the nested `config` the platform sends', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeInbounddableAgent(workspace);
    vi.mocked(client.getAgent).mockResolvedValue(
      upstreamAgent({
        prompt: 'Dial politely.',
        inbound: {
          enabled: true,
          config: {
            prompt: 'Answer the support line.',
            intro_message: 'Thanks for calling.',
            voice_id: 'voice-2',
            variables: ['account_number'],
          },
        },
      }),
    );

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}?include=inbound`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data.inbound).toMatchObject({
      prompt: 'Answer the support line.',
      intro_message: 'Thanks for calling.',
      voice_id: 'voice-2',
      variables: ['account_number'],
    });
    // And not the agent's own configuration, which is the other way to be wrong.
    expect(res.body.data.inbound.prompt).not.toBe('Dial politely.');
  });

  /**
   * The face's own variable list is read from the same wrapper, so a write
   * that cannot see it sends the caller's list as the whole truth and drops
   * every name the face declares. `Agent.variables` is a dial allow-list, so a
   * dropped name is a value the bot never receives on an inbound call.
   */
  it("unions an inbound write against the face's own declared variables", async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeInbounddableAgent(workspace);
    vi.mocked(client.getAgent).mockResolvedValue(
      upstreamAgent({
        variables: ['lead_id'],
        inbound: { enabled: true, config: { prompt: 'Answer.', variables: ['account_number'] } },
      }),
    );

    await request(app)
      .put(`/api/workspaces/${workspace.id}/agents/${agent.id}/inbound/config`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ prompt: 'Answer warmly.', variables: ['callback_number'] })
      .expect(200);

    const sent = vi.mocked(client.updateAgentInbound).mock.calls[0][1] as Record<string, unknown>;
    expect(sent.variables).toEqual(expect.arrayContaining(['callback_number', 'account_number']));
    // The PARENT's list must not be imported onto the face.
    expect(sent.variables).not.toContain('lead_id');
  });

  it('does not reach upstream without the include flag', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeInbounddableAgent(workspace);

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data.inbound).toBeUndefined();
    expect(vi.mocked(client.getAgent)).not.toHaveBeenCalled();
  });
});

describe('PUT /api/workspaces/:id/agents/:agentId/inbound/config', () => {
  it('writes the inbound config, stripping fields the platform ignores', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeInbounddableAgent(workspace);
    vi.mocked(client.updateAgentInbound).mockResolvedValue({ prompt: 'Answer the support line.' });

    const res = await request(app)
      .put(`/api/workspaces/${workspace.id}/agents/${agent.id}/inbound/config`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ prompt: 'Answer the support line.', voice_id: 'voice-2', agent_name: 'x', project_id: 'p' });

    expect(res.status).toBe(200);
    const sent = vi.mocked(client.updateAgentInbound).mock.calls[0];
    expect(sent[0]).toBe('ext-1');
    // agent_name and project_id are accepted and ignored upstream — do not send
    // fields we know are discarded.
    expect(sent[1]).not.toHaveProperty('agent_name');
    expect(sent[1]).not.toHaveProperty('project_id');
    expect(sent[1]).toMatchObject({ prompt: 'Answer the support line.', voice_id: 'voice-2' });
  });

  it('answers the saved face config, not the `inbound` flag every agent body carries', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeInbounddableAgent(workspace);
    // What the platform really answers: the face as `toV2AgentResponse` shapes
    // any agent — flat fields, plus the `inbound: { enabled }` block it has put
    // on every agent body since 2026-09-10 (Vocobase `routes/v2/agent.routes.ts`
    // `toV2AgentResponse`, returned by `updateAgentHandler` at ~:1990).
    const extraction = {
      keys: [{ name: 'issue', type: 'string', description: 'What the caller needs.' }],
    };
    vi.mocked(client.updateAgentInbound).mockResolvedValue({
      id: 'face-1',
      prompt: 'Answer the support line.',
      intro_message: 'Thanks for calling.',
      extraction_enabled: true,
      extraction_config: extraction,
      variables: ['caller_name'],
      inbound: { enabled: false },
    });

    const res = await request(app)
      .put(`/api/workspaces/${workspace.id}/agents/${agent.id}/inbound/config`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ prompt: 'Answer the support line.' });

    expect(res.status).toBe(200);
    expect(res.body.data.prompt).toBe('Answer the support line.');
    expect(res.body.data.intro_message).toBe('Thanks for calling.');
    expect(res.body.data.extraction_enabled).toBe(true);
    expect(res.body.data.extraction_config.keys.map((k: { name: string }) => k.name)).toEqual([
      'issue',
    ]);
    expect(res.body.data.variables).toEqual(['caller_name']);
  });

  it('passes upstream INBOUND_NOT_ENABLED through when the face does not exist yet', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeInbounddableAgent(workspace);
    vi.mocked(client.updateAgentInbound).mockRejectedValue(
      new ApiError(404, 'INBOUND_NOT_ENABLED', 'Enable inbound for this agent first.'),
    );

    const res = await request(app)
      .put(`/api/workspaces/${workspace.id}/agents/${agent.id}/inbound/config`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ prompt: 'Answer the support line.' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('INBOUND_NOT_ENABLED');
  });

  it('lets a MEMBER write the inbound config', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    await addMember(workspace, bob, 'MEMBER');
    const agent = await makeInbounddableAgent(workspace);
    vi.mocked(client.updateAgentInbound).mockResolvedValue({ prompt: 'Hello.' });

    const res = await request(app)
      .put(`/api/workspaces/${workspace.id}/agents/${agent.id}/inbound/config`)
      .set(...as('user_bob', 'bob@ezo.test'))
      .send({ prompt: 'Hello.' });

    expect(res.status).toBe(200);
  });

  /**
   * The platform's config write is a PUT: a supplied `variables` replaces the
   * array wholesale. The caller's copy of the face is always older than the
   * write, so sending it verbatim deletes any name declared upstream since —
   * and an undeclared name is a value the dial never sends, so the placeholder
   * renders empty on every inbound call afterwards.
   */
  it("unions variables with the face's own, not the parent's", async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeInbounddableAgent(workspace);

    vi.mocked(client.getAgent).mockResolvedValue(
      upstreamAgent({
        // The parent's list is a DIFFERENT list. It must not leak into the
        // face's write, in either direction.
        variables: ['parent_only'],
        inbound: { enabled: true, variables: ['callee_name', 'added_upstream'] },
      }),
    );
    vi.mocked(client.updateAgentInbound).mockResolvedValue({ prompt: 'Hello.' });

    const res = await request(app)
      .put(`/api/workspaces/${workspace.id}/agents/${agent.id}/inbound/config`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ variables: ['callee_name'] });

    expect(res.status).toBe(200);
    expect(vi.mocked(client.getAgent)).toHaveBeenCalledWith('ext-1', { includeInbound: true });
    // The caller's own order first — those are the deliberate ones — then the
    // names only the face holds.
    expect(vi.mocked(client.updateAgentInbound).mock.calls[0][1]).toMatchObject({
      variables: ['callee_name', 'added_upstream'],
    });
  });

  /** A prompt-only write is the common edit and must still cost one upstream
   *  call, not two. */
  it('costs no upstream read when the body carries no variables', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeInbounddableAgent(workspace);
    vi.mocked(client.updateAgentInbound).mockResolvedValue({ prompt: 'Answer warmly.' });

    const res = await request(app)
      .put(`/api/workspaces/${workspace.id}/agents/${agent.id}/inbound/config`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ prompt: 'Answer warmly.' });

    expect(res.status).toBe(200);
    expect(vi.mocked(client.getAgent)).not.toHaveBeenCalled();
  });

  /** A face that was never enabled holds no names to keep — and the read that
   *  discovers that must not throw on the way past a null `inbound`. */
  it('sends the caller list unchanged when the face declares nothing', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeInbounddableAgent(workspace);

    // The parent deliberately declares a name of its own. Without it the
    // fixture cannot tell the null-face path from a fallback to the parent's
    // list — both would send `['callee_name']` and the test would pass either
    // way, over the exact confusion this side parameter exists to prevent.
    vi.mocked(client.getAgent).mockResolvedValue(
      upstreamAgent({ variables: ['parent_only'], inbound: null }),
    );
    vi.mocked(client.updateAgentInbound).mockResolvedValue({ prompt: 'Hello.' });

    const res = await request(app)
      .put(`/api/workspaces/${workspace.id}/agents/${agent.id}/inbound/config`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ variables: ['callee_name'] });

    expect(res.status).toBe(200);
    expect(vi.mocked(client.updateAgentInbound).mock.calls[0][1]).toMatchObject({
      variables: ['callee_name'],
    });
  });

  /** An enabled face whose record upstream will not hand back is a read we
   *  failed, not a face with nothing to keep. The write still goes as given —
   *  narrowing somebody's list on a guess is worse — but it is said out loud,
   *  because a silent truncation here is the failure this route exists to end. */
  it('warns rather than passing silently when an enabled face reads back bare', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeInbounddableAgent(workspace);
    await prisma.agent.update({ where: { id: agent.id }, data: { inboundEnabled: true } });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The face's names at the top level, with no `inbound` key — the bare shape
    // this handler's own response projection says upstream sometimes returns.
    vi.mocked(client.getAgent).mockResolvedValue(
      upstreamAgent({ variables: ['face_a', 'face_b'] }),
    );
    vi.mocked(client.updateAgentInbound).mockResolvedValue({ prompt: 'Hello.' });

    const res = await request(app)
      .put(`/api/workspaces/${workspace.id}/agents/${agent.id}/inbound/config`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ variables: ['callee_name'] });

    expect(res.status).toBe(200);
    expect(vi.mocked(client.updateAgentInbound).mock.calls[0][1]).toMatchObject({
      variables: ['callee_name'],
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('returned no inbound record'));
  });

  /** The degradation path. A read we could not make must not be read as a face
   *  that declares nothing: the caller's list goes up exactly as typed, never
   *  emptied, and the failure is logged. */
  it('sends the caller list as given when the face cannot be read at all', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeInbounddableAgent(workspace);
    await prisma.agent.update({ where: { id: agent.id }, data: { inboundEnabled: true } });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(client.getAgent).mockRejectedValue(new Error('upstream unavailable'));
    vi.mocked(client.updateAgentInbound).mockResolvedValue({ prompt: 'Hello.' });

    const res = await request(app)
      .put(`/api/workspaces/${workspace.id}/agents/${agent.id}/inbound/config`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ variables: ['callee_name', 'callee_city'] });

    expect(res.status).toBe(200);
    expect(vi.mocked(client.updateAgentInbound).mock.calls[0][1]).toMatchObject({
      variables: ['callee_name', 'callee_city'],
    });
    expect(warn).toHaveBeenCalled();
  });
});

/**
 * The mirror is conditional on `Agent.direction`. `UNI` is one persona served
 * through two configurations, so a save goes to both; `BI` is two personas, so
 * it must go to neither — mirroring there would overwrite the inbound
 * extraction somebody had just written. See `test/agent-direction.test.ts` for
 * the `BI` half and for a `UNI` agent that has no face yet.
 */
describe('PATCH agent extraction writes both sides on a UNI agent with a face', () => {
  const extractionConfig = {
    prompt: 'Extract the budget.',
    keys: [{ name: 'budget', type: 'string' }],
  };

  it('mirrors extraction to the inbound side on a UNI agent with a face', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeInbounddableAgent(workspace);
    await prisma.agent.update({
      where: { id: agent.id },
      data: { inboundEnabled: true, direction: 'UNI' },
    });
    vi.mocked(client.updateAgent).mockResolvedValue(upstreamAgent());
    vi.mocked(client.updateAgentInbound).mockResolvedValue({ extraction_config: extractionConfig });
    vi.mocked(client.getAgent).mockResolvedValue(upstreamAgent());

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/agents/${agent.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ extraction_config: extractionConfig });

    expect(res.status).toBe(200);
    // Both sides, identical extraction — this is the drift trap from design §11,
    // and in UNI mode the whole configuration is kept in step this way.
    expect(vi.mocked(client.updateAgent).mock.calls[0][1]).toMatchObject({
      extraction_config: extractionConfig,
    });
    expect(vi.mocked(client.updateAgentInbound).mock.calls[0][1]).toMatchObject({
      extraction_config: extractionConfig,
    });
    expect(res.body.data.inboundConfigSynced).toBe(true);
  });

  it('issues one call on an agent without an inbound face', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeInbounddableAgent(workspace); // inboundEnabled false
    vi.mocked(client.updateAgent).mockResolvedValue(upstreamAgent());
    vi.mocked(client.getAgent).mockResolvedValue(upstreamAgent());

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/agents/${agent.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ extraction_config: extractionConfig });

    expect(res.status).toBe(200);
    expect(vi.mocked(client.updateAgentInbound)).not.toHaveBeenCalled();
    // No inbound side attempted, so no flag either.
    expect(res.body.data.inboundConfigSynced).toBeUndefined();
  });

  it('still 200s but flags inboundConfigSynced false when the second write fails', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeInbounddableAgent(workspace);
    await prisma.agent.update({
      where: { id: agent.id },
      data: { inboundEnabled: true, direction: 'UNI' },
    });
    vi.mocked(client.updateAgent).mockResolvedValue(upstreamAgent());
    vi.mocked(client.updateAgentInbound).mockRejectedValue(
      new ApiError(502, 'UPSTREAM_ERROR', 'The voice platform could not complete that request.'),
    );
    vi.mocked(client.getAgent).mockResolvedValue(upstreamAgent());

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/agents/${agent.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ extraction_config: extractionConfig });

    // The first write must not roll back, and this must not read as a clean
    // success — the two sides diverged and the operator has to be told.
    expect(res.status).toBe(200);
    expect(res.body.data.inboundConfigSynced).toBe(false);
    expect(res.body.data.inboundConfigError).toBeTruthy();
  });

  /**
   * The `BI` half of the same question. "Has a face but mirrors nothing" used
   * to be reachable with the mode left at its default, because that default
   * was `OUTBOUND`; it is `UNI` now, which mirrors, so the only state that
   * writes one side is the one that means two personas — and it means it for
   * a prompt exactly as much as for an extraction.
   */
  it('does not touch the inbound side for a non-extraction edit on a BI agent', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeInbounddableAgent(workspace);
    await prisma.agent.update({
      where: { id: agent.id },
      data: { inboundEnabled: true, direction: 'BI' },
    });
    vi.mocked(client.updateAgent).mockResolvedValue(upstreamAgent());
    vi.mocked(client.getAgent).mockResolvedValue(upstreamAgent());

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/agents/${agent.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ prompt: 'Just the prompt.' });

    expect(res.status).toBe(200);
    expect(vi.mocked(client.updateAgentInbound)).not.toHaveBeenCalled();
  });

  /**
   * And the `UNI` half: the mirror is the whole body, not the extraction
   * alone. One editor is on screen, so a face left on an older prompt would
   * make the agent say something nothing on the page accounts for.
   */
  it('mirrors a prompt-only edit on a UNI agent with a face', async () => {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await makeInbounddableAgent(workspace);
    await prisma.agent.update({
      where: { id: agent.id },
      data: { inboundEnabled: true, direction: 'UNI' },
    });
    vi.mocked(client.updateAgent).mockResolvedValue(upstreamAgent());
    vi.mocked(client.updateAgentInbound).mockResolvedValue(upstreamAgent());
    vi.mocked(client.getAgent).mockResolvedValue(upstreamAgent());

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/agents/${agent.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ prompt: 'Just the prompt.' });

    expect(res.status).toBe(200);
    expect(vi.mocked(client.updateAgentInbound).mock.calls[0][1]).toMatchObject({
      prompt: 'Just the prompt.',
    });
  });
});
