import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { as, makeAccount, makeWorkspace } from './helpers.js';

/**
 * A persona overwrite is never silent and never unrecoverable.
 *
 * On 2026-09-21 a BI → UNI move on "Dhandha Support Triage" wrote the outbound
 * persona over a different inbound one — prompt, greeting, transfer off, all
 * six extraction fields gone — and 194 inbound calls lost their extraction.
 * So: a server-computed diff with a fingerprinted confirm and no default when
 * the sides differ; a snapshot before every overwrite; and a restore.
 *
 * Mocked platform shapes, as the adapter hands them to the routes (producer
 * lines in the Vocobase backend):
 *  - `getAgent(id)` → `{ ...toV2AgentResponse(agent), inbound: { enabled } }`
 *    (`routes/v2/agent.routes.ts:374-382`).
 *  - `getAgent(id, { includeInbound: true })` → the same, with the face's own
 *    `toV2AgentResponse` minus `id`/`agent_name`/`inbound` nested as
 *    `inbound: { enabled, config }` (`routes/v2/agent.routes.ts:357-382`).
 *  - `getAgentLifecycleHooks(id)` → bare `{ hooks }` of Prisma
 *    `AgentLifecycleHook` rows (`routes/v2/lifecycle-hooks.routes.ts:64-67`).
 *  - `getInboundLifecycleHooks(id)` → `{ hooks }` after `unwrap` of
 *    `{ success, data: { hooks } }` (`routes/v2/inbound-lifecycle-hooks.routes.ts:130-135`).
 *  - `replaceInboundLifecycleHooks` → `{ hooks }` after `unwrap`
 *    (`routes/v2/inbound-lifecycle-hooks.routes.ts:181-186`).
 *  - `replaceAgentLifecycleHooks` → bare `{ hooks }`
 *    (`routes/v2/lifecycle-hooks.routes.ts:92`).
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

const BASE = {
  id: 'ext-1',
  agent_name: 'Dhandha Support Triage',
  status: 'active',
  project_id: 'proj-base',
  voice_id: 'voice-base',
  language: 'en',
  variables: ['lead_id'],
  prompt: 'Qualify the outbound lead.',
  intro_message: 'Hi, this is Dhandha calling.',
  transfer_enabled: false,
  extraction_enabled: true,
  extraction_config: {
    prompt: 'Extract.',
    keys: [{ name: 'budget', type: 'string' }],
    inlineEnabled: true,
  },
};

/** The inbound persona the incident destroyed: its own prompt, transfer on, six fields. */
const FACE = {
  status: 'active',
  project_id: 'proj-face',
  voice_id: 'voice-base',
  language: 'en',
  variables: ['lead_id'],
  prompt: 'Triage the support caller.',
  intro_message: 'Thanks for calling Dhandha support.',
  transfer_enabled: true,
  transfer_destinations: [
    { key: 'tier2', label: 'Tier 2', number: '+919876543210', llmDescription: 'Escalations' },
  ],
  extraction_enabled: true,
  extraction_config: {
    prompt: 'Extract the ticket.',
    keys: ['issue', 'severity', 'product', 'order_id', 'city', 'callback'].map((name) => ({
      name,
      type: 'string',
    })),
    inlineEnabled: true,
  },
};

function hookRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'h-1',
    agentId: 'ext-1',
    stage: 'PRE_CALL',
    position: 0,
    toolSlug: 'google_sheets',
    toolFn: 'lookup_row',
    functionId: null,
    name: 'Look up lead',
    input: { spreadsheetId: 'sheet-1', matchColumn: 'phone' },
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

/** What the platform holds right now; the mocks read these live. */
const platform = {
  base: BASE as Record<string, unknown>,
  face: FACE as Record<string, unknown> | null,
  baseHooks: [hookRow()] as Record<string, unknown>[],
  faceHooks: [hookRow({ id: 'fh-1', name: 'Look up caller', exposeAs: 'caller' })] as Record<
    string,
    unknown
  >[],
};

function resetPlatform() {
  platform.base = BASE;
  platform.face = FACE;
  platform.baseHooks = [hookRow()];
  platform.faceHooks = [hookRow({ id: 'fh-1', name: 'Look up caller', exposeAs: 'caller' })];
}

async function setup(direction: 'UNI' | 'BI' = 'BI', inboundEnabled = direction === 'BI') {
  const alice = await makeAccount('alice');
  const workspace = await makeWorkspace(alice, 'Alice Co');
  const agent = await prisma.agent.create({
    data: {
      externalId: 'ext-1',
      name: 'Dhandha Support Triage',
      status: 'active',
      workspaceId: workspace.id,
      direction,
      inboundEnabled,
    },
  });
  return { alice, workspace, agent };
}

const asAlice = () => as('user_alice', 'alice@ezo.test');

beforeEach(async () => {
  await truncateAll();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  resetPlatform();
  vi.mocked(client.listVoices).mockResolvedValue({ voices: [] });
  vi.mocked(client.getAgent).mockImplementation(async (_id, opts) => ({
    ...platform.base,
    inbound:
      opts?.includeInbound && platform.face
        ? { enabled: true, config: platform.face }
        : { enabled: platform.face !== null },
  }));
  vi.mocked(client.getAgentLifecycleHooks).mockImplementation(async () => ({
    hooks: platform.baseHooks,
  }));
  vi.mocked(client.getInboundLifecycleHooks).mockImplementation(async () => ({
    hooks: platform.faceHooks,
  }));
  vi.mocked(client.updateAgent).mockImplementation(async () => platform.base);
  vi.mocked(client.updateAgentInbound).mockImplementation(async () => ({}));
  vi.mocked(client.setAgentInbound).mockResolvedValue({});
  vi.mocked(client.replaceInboundLifecycleHooks).mockResolvedValue({ hooks: [] });
  vi.mocked(client.replaceAgentLifecycleHooks).mockResolvedValue({ hooks: [] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const previewUrl = (workspace: Workspace, agentId: string) =>
  `/api/workspaces/${workspace.id}/agents/${agentId}/direction/preview?to=UNI`;

describe('GET .../direction/preview', () => {
  it('answers identical, with empty lists and both fingerprints, when the sides match', async () => {
    const { workspace, agent } = await setup();
    platform.face = BASE;
    platform.faceHooks = platform.baseHooks;

    const res = await request(app).get(previewUrl(workspace, agent.id)).set(...asAlice()).expect(200);

    expect(res.body.data.identical).toBe(true);
    for (const key of ['keep_outbound', 'keep_inbound']) {
      expect(res.body.data[key].fields).toEqual([]);
      expect(res.body.data[key].actions).toEqual({ removed: [], added: [], changed: [] });
      expect(res.body.data[key].fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('reads all four live and names what each choice replaces', async () => {
    const { workspace, agent } = await setup();

    const res = await request(app).get(previewUrl(workspace, agent.id)).set(...asAlice()).expect(200);

    expect(vi.mocked(client.getAgent)).toHaveBeenCalledWith('ext-1');
    expect(vi.mocked(client.getAgent)).toHaveBeenCalledWith('ext-1', { includeInbound: true });
    expect(vi.mocked(client.getAgentLifecycleHooks)).toHaveBeenCalledWith('ext-1');
    expect(vi.mocked(client.getInboundLifecycleHooks)).toHaveBeenCalledWith('ext-1');

    const { identical, keep_outbound: out } = res.body.data;
    expect(identical).toBe(false);
    expect(out.replaced).toBe('inbound');
    const fields = Object.fromEntries(out.fields.map((f: { field: string }) => [f.field, f]));
    expect(fields.prompt).toEqual({
      field: 'prompt',
      label: 'Prompt',
      current: 'Triage the support caller.',
      incoming: 'Qualify the outbound lead.',
    });
    expect(fields.transfer_enabled).toMatchObject({ current: 'On', incoming: 'Off' });
    expect(fields.extraction_config).toMatchObject({
      current: 'issue, severity, product, order_id, city, callback',
      incoming: 'budget',
    });
    expect(out.actions).toEqual({
      removed: [{ stage: 'PRE_CALL', name: 'Look up caller', source: 'google_sheets:lookup_row' }],
      added: [{ stage: 'PRE_CALL', name: 'Look up lead', source: 'google_sheets:lookup_row' }],
      changed: [],
    });
    expect(res.body.data.keep_inbound.replaced).toBe('outbound');
  });

  it('writes nothing', async () => {
    const { workspace, agent } = await setup();
    await request(app).get(previewUrl(workspace, agent.id)).set(...asAlice()).expect(200);

    expect(vi.mocked(client.updateAgent)).not.toHaveBeenCalled();
    expect(vi.mocked(client.updateAgentInbound)).not.toHaveBeenCalled();
    expect(vi.mocked(client.replaceInboundLifecycleHooks)).not.toHaveBeenCalled();
    expect(vi.mocked(client.replaceAgentLifecycleHooks)).not.toHaveBeenCalled();
    expect(await prisma.agentPersonaSnapshot.count()).toBe(0);
  });

  it.each([
    ['a UNI agent', 'UNI' as const, false],
    ['a UNI agent with a face', 'UNI' as const, true],
    ['a BI agent whose face is off', 'BI' as const, false],
  ])('refuses %s with 409, reading nothing', async (_label, direction, inboundEnabled) => {
    const { workspace, agent } = await setup(direction, inboundEnabled);

    const res = await request(app).get(previewUrl(workspace, agent.id)).set(...asAlice());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toBe(
      'Only a bi-directional agent with an inbound setup has two sides to compare.',
    );
    expect(vi.mocked(client.getAgent)).not.toHaveBeenCalled();
  });

  it('refuses a target other than UNI', async () => {
    const { workspace, agent } = await setup();
    await request(app)
      .get(`/api/workspaces/${workspace.id}/agents/${agent.id}/direction/preview?to=BI`)
      .set(...asAlice())
      .expect(400);
  });

  it('answers 502 when a side cannot be read, never a diff against nothing', async () => {
    const { workspace, agent } = await setup();
    platform.face = null;

    const res = await request(app).get(previewUrl(workspace, agent.id)).set(...asAlice());
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_ERROR');
  });

  it("404s another workspace's agent before reading anything", async () => {
    const { agent } = await setup();
    const bob = await makeAccount('bob');
    const bobs = await makeWorkspace(bob, 'Bob Co');

    await request(app).get(previewUrl(bobs, agent.id)).set(...as('user_bob', 'bob@ezo.test')).expect(404);
    expect(vi.mocked(client.getAgent)).not.toHaveBeenCalled();
  });
});

const directionUrl = (workspace: Workspace, agentId: string) =>
  `/api/workspaces/${workspace.id}/agents/${agentId}/direction`;

async function preview(workspace: Workspace, agentId: string) {
  const res = await request(app).get(previewUrl(workspace, agentId)).set(...asAlice()).expect(200);
  return res.body.data;
}

function nothingOverwritten() {
  expect(vi.mocked(client.updateAgent)).not.toHaveBeenCalled();
  expect(vi.mocked(client.updateAgentInbound)).not.toHaveBeenCalled();
  expect(vi.mocked(client.replaceInboundLifecycleHooks)).not.toHaveBeenCalled();
  expect(vi.mocked(client.replaceAgentLifecycleHooks)).not.toHaveBeenCalled();
}

async function directionOf(agentId: string) {
  return (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).direction;
}

/** Records, at each overwrite, how many snapshots existed — so "before" is asserted, not assumed. */
function countSnapshotsAtWrites() {
  const seen: Record<string, number> = {};
  const at = (name: string) => async () => {
    seen[name] ??= await prisma.agentPersonaSnapshot.count();
  };
  vi.mocked(client.updateAgentInbound).mockImplementation(async () => {
    await at('updateAgentInbound')();
    return {};
  });
  vi.mocked(client.replaceAgentLifecycleHooks).mockImplementation(async () => {
    await at('replaceAgentLifecycleHooks')();
    return { hooks: [] };
  });
  vi.mocked(client.updateAgent).mockImplementation(async () => {
    await at('updateAgent')();
    return platform.base;
  });
  return seen;
}

describe('PATCH .../direction BI → UNI over two sides that differ', () => {
  it('refuses a missing keep with 409 and the preview, and writes nothing', async () => {
    const { workspace, agent } = await setup();
    const expected = await preview(workspace, agent.id);
    vi.clearAllMocks();

    const res = await request(app)
      .patch(directionUrl(workspace, agent.id))
      .set(...asAlice())
      .send({ direction: 'UNI', confirm: true });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OVERWRITE_CONFIRM_REQUIRED');
    // A sibling of `error`, the way CONFIRM_REQUIRED carries its details.
    expect(res.body.details).toEqual(expected);
    nothingOverwritten();
    expect(await prisma.agentPersonaSnapshot.count()).toBe(0);
    expect(await directionOf(agent.id)).toBe('BI');
  });

  it('refuses a keep without a fingerprint the same way', async () => {
    const { workspace, agent } = await setup();

    const res = await request(app)
      .patch(directionUrl(workspace, agent.id))
      .set(...asAlice())
      .send({ direction: 'UNI', confirm: true, keep: 'outbound' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OVERWRITE_CONFIRM_REQUIRED');
    expect(res.body.details.identical).toBe(false);
    nothingOverwritten();
    expect(await directionOf(agent.id)).toBe('BI');
  });

  it('still asks the plain confirm first', async () => {
    const { workspace, agent } = await setup();

    const res = await request(app)
      .patch(directionUrl(workspace, agent.id))
      .set(...asAlice())
      .send({ direction: 'UNI' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFIRM_REQUIRED');
    expect(vi.mocked(client.getAgent)).not.toHaveBeenCalled();
  });

  it('refuses a fingerprint the face has moved on from, with the fresh preview', async () => {
    const { workspace, agent } = await setup();
    const before = await preview(workspace, agent.id);
    // Somebody edits the inbound prompt while the dialog is open.
    platform.face = { ...FACE, prompt: 'Edited while you looked.' };
    vi.clearAllMocks();

    const res = await request(app)
      .patch(directionUrl(workspace, agent.id))
      .set(...asAlice())
      .send({
        direction: 'UNI',
        confirm: true,
        keep: 'outbound',
        fingerprint: before.keep_outbound.fingerprint,
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DIRECTION_PREVIEW_STALE');
    expect(res.body.details.keep_outbound.fingerprint).not.toBe(before.keep_outbound.fingerprint);
    const prompt = res.body.details.keep_outbound.fields.find(
      (f: { field: string }) => f.field === 'prompt',
    );
    expect(prompt.current).toBe('Edited while you looked.');
    nothingOverwritten();
    expect(await prisma.agentPersonaSnapshot.count()).toBe(0);
    expect(await directionOf(agent.id)).toBe('BI');
  });

  it("refuses the other choice's fingerprint", async () => {
    const { workspace, agent } = await setup();
    const before = await preview(workspace, agent.id);

    const res = await request(app)
      .patch(directionUrl(workspace, agent.id))
      .set(...asAlice())
      .send({
        direction: 'UNI',
        confirm: true,
        keep: 'outbound',
        fingerprint: before.keep_inbound.fingerprint,
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DIRECTION_PREVIEW_STALE');
    nothingOverwritten();
  });

  it('keeps outbound on the right fingerprint, snapshotting the INBOUND side first', async () => {
    const { alice, workspace, agent } = await setup();
    const { keep_outbound } = await preview(workspace, agent.id);
    const seen = countSnapshotsAtWrites();

    const res = await request(app)
      .patch(directionUrl(workspace, agent.id))
      .set(...asAlice())
      .send({ direction: 'UNI', confirm: true, keep: 'outbound', fingerprint: keep_outbound.fingerprint });

    expect(res.status).toBe(200);
    expect(res.body.data.kept).toBe('outbound');
    expect(await directionOf(agent.id)).toBe('UNI');

    const snaps = await prisma.agentPersonaSnapshot.findMany();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      agentId: agent.id,
      workspaceId: workspace.id,
      side: 'INBOUND',
      reason: 'DIRECTION_UNI_KEEP_OUTBOUND',
      takenByUserId: alice.id,
    });
    const config = snaps[0].config as Record<string, unknown>;
    expect(config.prompt).toBe('Triage the support caller.');
    expect((config.extraction_config as { keys: unknown[] }).keys).toHaveLength(6);
    expect((snaps[0].hooks as Array<{ name: string }>).map((h) => h.name)).toEqual(['Look up caller']);
    // Saved before the face was written over.
    expect(seen.updateAgentInbound).toBe(1);
  });

  it('keeps inbound on the right fingerprint, snapshotting the OUTBOUND side first', async () => {
    const { workspace, agent } = await setup();
    const { keep_inbound } = await preview(workspace, agent.id);
    const seen = countSnapshotsAtWrites();

    const res = await request(app)
      .patch(directionUrl(workspace, agent.id))
      .set(...asAlice())
      .send({ direction: 'UNI', confirm: true, keep: 'inbound', fingerprint: keep_inbound.fingerprint });

    expect(res.status).toBe(200);
    expect(res.body.data.kept).toBe('inbound');

    // Both sides: the base is written over now, and the face is written over
    // from the base straight after — from a copy that may not carry all of it.
    const snaps = await prisma.agentPersonaSnapshot.findMany({ orderBy: { side: 'asc' } });
    expect(snaps.map((s) => [s.side, s.reason])).toEqual([
      ['OUTBOUND', 'DIRECTION_UNI_KEEP_INBOUND'],
      ['INBOUND', 'DIRECTION_UNI_KEEP_INBOUND'],
    ]);
    expect((snaps[0].config as Record<string, unknown>).prompt).toBe('Qualify the outbound lead.');
    expect((snaps[0].hooks as Array<{ name: string }>).map((h) => h.name)).toEqual(['Look up lead']);
    expect((snaps[1].config as Record<string, unknown>).prompt).toBe('Triage the support caller.');
    expect((snaps[1].hooks as Array<{ name: string }>).map((h) => h.name)).toEqual(['Look up caller']);
    // Before the first write to either side.
    expect(seen.replaceAgentLifecycleHooks).toBe(2);
    expect(seen.updateAgent).toBe(2);
    expect(seen.updateAgentInbound).toBe(2);
  });

  it('needs no keep or fingerprint when the sides are identical, and still snapshots', async () => {
    const { workspace, agent } = await setup();
    platform.face = BASE;
    platform.faceHooks = platform.baseHooks;

    const res = await request(app)
      .patch(directionUrl(workspace, agent.id))
      .set(...asAlice())
      .send({ direction: 'UNI', confirm: true });

    expect(res.status).toBe(200);
    expect(res.body.data.kept).toBe('outbound');
    const snaps = await prisma.agentPersonaSnapshot.findMany();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ side: 'INBOUND', reason: 'DIRECTION_UNI_KEEP_OUTBOUND' });
  });

  it('refuses keeping an inbound persona the base cannot take in full, writing nothing', async () => {
    const { workspace, agent } = await setup();
    platform.face = {
      ...FACE,
      extraction_config: { prompt: 'Extract.', keys: [{ name: 'issue', type: 'not-a-type' }] },
    };
    const { keep_inbound } = await preview(workspace, agent.id);

    const res = await request(app)
      .patch(directionUrl(workspace, agent.id))
      .set(...asAlice())
      .send({ direction: 'UNI', confirm: true, keep: 'inbound', fingerprint: keep_inbound.fingerprint });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('KEEP_INBOUND_FIELDS_REFUSED');
    expect(res.body.details).toEqual({ fields: ['Extraction fields'] });
    expect(res.body.error.message).toMatch(/Extraction fields/);
    nothingOverwritten();
    expect(await directionOf(agent.id)).toBe('BI');
  });

  it('keeps inbound when a field this service refuses holds the same value on both sides', async () => {
    // The platform stores "no language picked" as []; this service's schema
    // takes 1-2. Dropping it loses nothing when the base holds the same.
    const { workspace, agent } = await setup();
    platform.base = { ...BASE, spoken_languages: [] };
    platform.face = { ...FACE, spoken_languages: [] };
    const { keep_inbound } = await preview(workspace, agent.id);

    const res = await request(app)
      .patch(directionUrl(workspace, agent.id))
      .set(...asAlice())
      .send({ direction: 'UNI', confirm: true, keep: 'inbound', fingerprint: keep_inbound.fingerprint });

    expect(res.status).toBe(200);
    expect(res.body.data.kept).toBe('inbound');
    expect(vi.mocked(client.updateAgent).mock.calls[0][1]).not.toHaveProperty('spoken_languages');
  });

  it('still refuses when that refused field differs, since the inbound value would be lost', async () => {
    const { workspace, agent } = await setup();
    platform.base = { ...BASE, spoken_languages: ['en'] };
    platform.face = { ...FACE, spoken_languages: [] };
    const { keep_inbound } = await preview(workspace, agent.id);

    const res = await request(app)
      .patch(directionUrl(workspace, agent.id))
      .set(...asAlice())
      .send({ direction: 'UNI', confirm: true, keep: 'inbound', fingerprint: keep_inbound.fingerprint });

    expect(res.status).toBe(422);
    expect(res.body.details).toEqual({ fields: ['Languages'] });
    nothingOverwritten();
  });

  it('puts the outbound actions back when the configuration write fails, and changes nothing', async () => {
    const { workspace, agent } = await setup();
    const { keep_inbound } = await preview(workspace, agent.id);
    vi.mocked(client.updateAgent).mockRejectedValue(new Error('socket hang up'));

    const res = await request(app)
      .patch(directionUrl(workspace, agent.id))
      .set(...asAlice())
      .send({ direction: 'UNI', confirm: true, keep: 'inbound', fingerprint: keep_inbound.fingerprint });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('KEEP_INBOUND_FAILED');
    const puts = vi.mocked(client.replaceAgentLifecycleHooks).mock.calls;
    expect(puts).toHaveLength(2);
    expect(puts[0][1].map((h) => h.name)).toEqual(['Look up caller']);
    expect(puts[1][1].map((h) => h.name)).toEqual(['Look up lead']);
    // The face is never reached.
    expect(vi.mocked(client.updateAgentInbound)).not.toHaveBeenCalled();
    expect(vi.mocked(client.replaceInboundLifecycleHooks)).not.toHaveBeenCalled();
    expect(await directionOf(agent.id)).toBe('BI');
  });

  it('answers KEEP_INBOUND_PARTIAL, pointing at the restore, when the actions cannot be put back', async () => {
    const { workspace, agent } = await setup();
    const { keep_inbound } = await preview(workspace, agent.id);
    vi.mocked(client.updateAgent).mockRejectedValue(new Error('socket hang up'));
    vi.mocked(client.replaceAgentLifecycleHooks)
      .mockResolvedValueOnce({ hooks: [] })
      .mockRejectedValueOnce(new Error('socket hang up'));

    const res = await request(app)
      .patch(directionUrl(workspace, agent.id))
      .set(...asAlice())
      .send({ direction: 'UNI', confirm: true, keep: 'inbound', fingerprint: keep_inbound.fingerprint });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('KEEP_INBOUND_PARTIAL');
    expect(res.body.error.message).toMatch(/restore/i);
    expect(vi.mocked(client.updateAgentInbound)).not.toHaveBeenCalled();
    expect(await directionOf(agent.id)).toBe('BI');
  });

  it('writes nothing to the base when keeping inbound over identical sides', async () => {
    const { workspace, agent } = await setup();
    platform.face = BASE;
    platform.faceHooks = platform.baseHooks;

    const res = await request(app)
      .patch(directionUrl(workspace, agent.id))
      .set(...asAlice())
      .send({ direction: 'UNI', confirm: true, keep: 'inbound' });

    expect(res.status).toBe(200);
    expect(vi.mocked(client.replaceAgentLifecycleHooks)).not.toHaveBeenCalled();
    expect(vi.mocked(client.updateAgent)).not.toHaveBeenCalled();
  });

  it('answers 502 SNAPSHOT_FAILED and overwrites nothing when the snapshot cannot be written', async () => {
    const { workspace, agent } = await setup();
    const { keep_outbound } = await preview(workspace, agent.id);
    vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('connection reset'));

    const res = await request(app)
      .patch(directionUrl(workspace, agent.id))
      .set(...asAlice())
      .send({ direction: 'UNI', confirm: true, keep: 'outbound', fingerprint: keep_outbound.fingerprint });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('SNAPSHOT_FAILED');
    expect(res.body.error.message).toBe(
      'Nothing was changed: the current setup could not be saved first.',
    );
    nothingOverwritten();
    expect(await directionOf(agent.id)).toBe('BI');
  });

  it('answers 502 SNAPSHOT_FAILED when the face cannot be read to save it', async () => {
    const { workspace, agent } = await setup();
    platform.face = null;

    const res = await request(app)
      .patch(directionUrl(workspace, agent.id))
      .set(...asAlice())
      .send({ direction: 'UNI', confirm: true, keep: 'outbound' });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('SNAPSHOT_FAILED');
    nothingOverwritten();
    expect(await directionOf(agent.id)).toBe('BI');
  });

  it('refuses a fingerprint on any move other than BI to UNI', async () => {
    const { workspace, agent } = await setup('UNI');

    const res = await request(app)
      .patch(directionUrl(workspace, agent.id))
      .set(...asAlice())
      .send({ direction: 'BI', fingerprint: 'a'.repeat(64) });

    expect(res.status).toBe(400);
    expect(vi.mocked(client.setAgentInbound)).not.toHaveBeenCalled();
  });
});

describe('PATCH .../direction UNI → BI over a switched-off face', () => {
  it('snapshots the revived face before writing the base over it', async () => {
    const { workspace, agent } = await setup('UNI', false);
    const seen = countSnapshotsAtWrites();

    const res = await request(app)
      .patch(directionUrl(workspace, agent.id))
      .set(...asAlice())
      .send({ direction: 'BI' });

    expect(res.status).toBe(200);
    const snaps = await prisma.agentPersonaSnapshot.findMany();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ side: 'INBOUND', reason: 'DIRECTION_BI_REVIVE' });
    expect((snaps[0].config as Record<string, unknown>).prompt).toBe('Triage the support caller.');
    // After the enable (which revives it), before the overwrite.
    expect(vi.mocked(client.setAgentInbound).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(client.updateAgentInbound).mock.invocationCallOrder[0],
    );
    expect(seen.updateAgentInbound).toBe(1);
  });

  it('answers 502 SNAPSHOT_FAILED and overwrites nothing when the revived face cannot be read', async () => {
    const { workspace, agent } = await setup('UNI', false);
    platform.face = null;

    const res = await request(app)
      .patch(directionUrl(workspace, agent.id))
      .set(...asAlice())
      .send({ direction: 'BI' });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('SNAPSHOT_FAILED');
    expect(vi.mocked(client.updateAgentInbound)).not.toHaveBeenCalled();
    expect(vi.mocked(client.replaceInboundLifecycleHooks)).not.toHaveBeenCalled();
    expect(await directionOf(agent.id)).toBe('UNI');
  });
});

const snapshotsUrl = (workspace: Workspace, agentId: string) =>
  `/api/workspaces/${workspace.id}/agents/${agentId}/persona-snapshots`;
const restoreUrl = (workspace: Workspace, agentId: string, snapshotId: string) =>
  `${snapshotsUrl(workspace, agentId)}/${snapshotId}/restore`;

/** A stored snapshot, written as `takePersonaSnapshot` writes one. */
async function storedSnapshot(
  agentId: string,
  workspaceId: string | null,
  side: 'OUTBOUND' | 'INBOUND',
  over: { config?: Record<string, unknown>; hooks?: unknown[]; createdAt?: Date; takenByUserId?: string } = {},
) {
  const { personaConfig } = await import('../src/lib/personaSnapshot.js');
  const { hookRowToFaceCopy } = await import('../src/lib/faceMirror.js');
  return prisma.agentPersonaSnapshot.create({
    data: {
      agentId,
      workspaceId,
      side,
      reason: side === 'INBOUND' ? 'DIRECTION_UNI_KEEP_OUTBOUND' : 'DIRECTION_UNI_KEEP_INBOUND',
      config: (over.config ?? personaConfig(side === 'INBOUND' ? FACE : BASE)) as object,
      hooks: (over.hooks ??
        [hookRowToFaceCopy(hookRow({ name: side === 'INBOUND' ? 'Look up caller' : 'Look up lead' }))]) as object[],
      takenByUserId: over.takenByUserId ?? null,
      ...(over.createdAt ? { createdAt: over.createdAt } : {}),
    },
  });
}

describe('GET .../persona-snapshots', () => {
  it('lists newest first, with who took each and what it holds', async () => {
    const { alice, workspace, agent } = await setup();
    const older = await storedSnapshot(agent.id, workspace.id, 'INBOUND', {
      createdAt: new Date('2026-09-20T10:00:00Z'),
      takenByUserId: alice.id,
    });
    const newer = await storedSnapshot(agent.id, workspace.id, 'OUTBOUND', {
      createdAt: new Date('2026-09-21T10:00:00Z'),
    });

    const res = await request(app).get(snapshotsUrl(workspace, agent.id)).set(...asAlice()).expect(200);

    expect(res.body.data.map((r: { id: string }) => r.id)).toEqual([newer.id, older.id]);
    expect(res.body.data[1]).toEqual({
      id: older.id,
      side: 'INBOUND',
      reason: 'DIRECTION_UNI_KEEP_OUTBOUND',
      created_at: '2026-09-20T10:00:00.000Z',
      taken_by: 'alice',
      summary: {
        prompt_preview: 'Triage the support caller.',
        intro_message: 'Thanks for calling Dhandha support.',
        extraction_keys: ['issue', 'severity', 'product', 'order_id', 'city', 'callback'],
        transfer_enabled: true,
        actions: [{ stage: 'PRE_CALL', name: 'Look up caller' }],
      },
    });
    expect(res.body.data[0].taken_by).toBeNull();
  });

  it('cuts the prompt preview at 160 characters', async () => {
    const { workspace, agent } = await setup();
    const { personaConfig } = await import('../src/lib/personaSnapshot.js');
    await storedSnapshot(agent.id, workspace.id, 'INBOUND', {
      config: personaConfig({ ...FACE, prompt: 'q'.repeat(1000) }),
    });

    const res = await request(app).get(snapshotsUrl(workspace, agent.id)).set(...asAlice()).expect(200);
    expect(res.body.data[0].summary.prompt_preview).toBe('q'.repeat(160));
  });

  /**
   * A lent agent moves between workspaces with its snapshots attached; the
   * ones taken while another workspace held it hold that workspace's persona
   * and actions, and must not follow the agent.
   */
  it("never lists snapshots taken while the agent was another workspace's", async () => {
    const { workspace, agent } = await setup();
    const bob = await makeAccount('bob');
    const bobs = await makeWorkspace(bob, 'Bob Co');
    await storedSnapshot(agent.id, bobs.id, 'INBOUND');
    const mine = await storedSnapshot(agent.id, workspace.id, 'INBOUND');

    const res = await request(app).get(snapshotsUrl(workspace, agent.id)).set(...asAlice()).expect(200);
    expect(res.body.data.map((r: { id: string }) => r.id)).toEqual([mine.id]);
  });

  it("404s another workspace's agent", async () => {
    const { workspace, agent } = await setup();
    await storedSnapshot(agent.id, workspace.id, 'INBOUND');
    const bob = await makeAccount('bob');
    const bobs = await makeWorkspace(bob, 'Bob Co');

    await request(app)
      .get(snapshotsUrl(bobs, agent.id))
      .set(...as('user_bob', 'bob@ezo.test'))
      .expect(404);
  });
});

describe('POST .../persona-snapshots/:snapshotId/restore', () => {
  it('restores an INBOUND snapshot onto a BI face, saving the current face first', async () => {
    const { alice, workspace, agent } = await setup();
    const snap = await storedSnapshot(agent.id, workspace.id, 'INBOUND');
    // Since the snapshot, the face was overwritten — the incident.
    platform.face = { ...BASE };
    platform.faceHooks = [hookRow({ name: 'Overwritten action' })];
    const seen = countSnapshotsAtWrites();

    const res = await request(app).post(restoreUrl(workspace, agent.id, snap.id)).set(...asAlice());

    expect(res.status).toBe(200);
    expect(res.body.data.restored).toEqual({ id: snap.id, side: 'INBOUND' });
    expect(res.body.data.inboundActionsSynced).toBe(true);

    // The config, all of it, including the six extraction fields.
    expect(vi.mocked(client.updateAgentInbound)).toHaveBeenCalledTimes(1);
    const [id, body] = vi.mocked(client.updateAgentInbound).mock.calls[0];
    expect(id).toBe('ext-1');
    expect(body).toMatchObject({
      prompt: 'Triage the support caller.',
      intro_message: 'Thanks for calling Dhandha support.',
      transfer_enabled: true,
      extraction_enabled: true,
      extraction_config: {
        prompt: 'Extract the ticket.',
        keys: FACE.extraction_config.keys,
        inlineEnabled: true,
      },
      transfer_destinations: FACE.transfer_destinations,
    });
    expect(body).not.toHaveProperty('agent_name');
    expect(body).not.toHaveProperty('project_id');

    // Then the hooks, replayed as stored.
    expect(vi.mocked(client.replaceInboundLifecycleHooks)).toHaveBeenCalledWith('ext-1', snap.hooks);
    expect(vi.mocked(client.updateAgentInbound).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(client.replaceInboundLifecycleHooks).mock.invocationCallOrder[0],
    );
    // The base is not touched.
    expect(vi.mocked(client.updateAgent)).not.toHaveBeenCalled();
    expect(vi.mocked(client.replaceAgentLifecycleHooks)).not.toHaveBeenCalled();

    // The state it replaced is itself saved, so the restore can be undone.
    expect(seen.updateAgentInbound).toBe(2);
    const undo = await prisma.agentPersonaSnapshot.findFirstOrThrow({ where: { reason: 'RESTORE' } });
    expect(undo).toMatchObject({ side: 'INBOUND', takenByUserId: alice.id, workspaceId: workspace.id });
    expect((undo.config as Record<string, unknown>).prompt).toBe('Qualify the outbound lead.');
    expect((undo.hooks as Array<{ name: string }>).map((h) => h.name)).toEqual(['Overwritten action']);
  });

  it.each([
    ['a UNI agent', 'UNI' as const, false],
    ['a UNI agent with a face', 'UNI' as const, true],
    ['a BI agent whose face is off', 'BI' as const, false],
  ])('refuses an INBOUND restore on %s with 409 RESTORE_NEEDS_BI', async (_l, direction, inboundEnabled) => {
    const { workspace, agent } = await setup(direction, inboundEnabled);
    const snap = await storedSnapshot(agent.id, workspace.id, 'INBOUND');

    const res = await request(app).post(restoreUrl(workspace, agent.id, snap.id)).set(...asAlice());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RESTORE_NEEDS_BI');
    expect(res.body.error.message).toBe(
      'Make this agent bi-directional first, then restore its inbound setup.',
    );
    nothingOverwritten();
    expect(await prisma.agentPersonaSnapshot.count()).toBe(1);
  });

  it('restores an OUTBOUND snapshot onto a UNI agent and re-syncs its face', async () => {
    const { workspace, agent } = await setup('UNI', true);
    const snap = await storedSnapshot(agent.id, workspace.id, 'OUTBOUND');
    platform.base = { ...BASE, prompt: 'Somebody rewrote this.' };

    const res = await request(app).post(restoreUrl(workspace, agent.id, snap.id)).set(...asAlice());

    expect(res.status).toBe(200);
    expect(res.body.data.restored).toEqual({ id: snap.id, side: 'OUTBOUND' });
    expect(res.body.data.actionsRestored).toBe(true);
    expect(res.body.data.inboundConfigSynced).toBe(true);
    expect(res.body.data.inboundActionsSynced).toBe(true);

    expect(vi.mocked(client.updateAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.updateAgent).mock.calls[0][1]).toMatchObject({
      prompt: 'Qualify the outbound lead.',
    });
    expect(vi.mocked(client.replaceAgentLifecycleHooks)).toHaveBeenCalledWith('ext-1', snap.hooks);

    // One persona: the face gets the same config, and the base's actions.
    expect(vi.mocked(client.updateAgentInbound)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.updateAgentInbound).mock.calls[0][1]).toMatchObject({
      prompt: 'Qualify the outbound lead.',
    });
    expect(vi.mocked(client.replaceInboundLifecycleHooks)).toHaveBeenCalledTimes(1);
    // Actions first: the one write that can be refused outright (the route
    // not deployed yet) goes before anything that cannot be taken back.
    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0];
    expect(order(vi.mocked(client.replaceAgentLifecycleHooks))).toBeLessThan(
      order(vi.mocked(client.updateAgent)),
    );
    expect(order(vi.mocked(client.updateAgent))).toBeLessThan(
      order(vi.mocked(client.updateAgentInbound)),
    );

    // Both sides saved: the face is written over by the mirror as well.
    const undos = await prisma.agentPersonaSnapshot.findMany({
      where: { reason: 'RESTORE' },
      orderBy: { side: 'asc' },
    });
    expect(undos.map((u) => u.side)).toEqual(['OUTBOUND', 'INBOUND']);
    expect((undos[0].config as Record<string, unknown>).prompt).toBe('Somebody rewrote this.');
  });

  it('restores an OUTBOUND snapshot onto a BI agent without touching its face', async () => {
    const { workspace, agent } = await setup('BI', true);
    const snap = await storedSnapshot(agent.id, workspace.id, 'OUTBOUND');

    const res = await request(app).post(restoreUrl(workspace, agent.id, snap.id)).set(...asAlice());

    expect(res.status).toBe(200);
    expect(vi.mocked(client.updateAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.updateAgentInbound)).not.toHaveBeenCalled();
    expect(vi.mocked(client.replaceInboundLifecycleHooks)).not.toHaveBeenCalled();
    expect(res.body.data).not.toHaveProperty('inboundActionsSynced');
  });

  it('reports an inbound hooks failure without failing the restored config', async () => {
    const { workspace, agent } = await setup();
    const snap = await storedSnapshot(agent.id, workspace.id, 'INBOUND');
    const { ApiError } = await import('../src/lib/errors.js');
    vi.mocked(client.replaceInboundLifecycleHooks).mockRejectedValue(
      new ApiError(422, 'VALIDATION_FAILED' as never, 'One or more hooks are invalid'),
    );

    const res = await request(app).post(restoreUrl(workspace, agent.id, snap.id)).set(...asAlice());

    expect(res.status).toBe(200);
    expect(vi.mocked(client.updateAgentInbound)).toHaveBeenCalledTimes(1);
    expect(res.body.data.inboundActionsSynced).toBe(false);
    expect(res.body.data.inboundActionsError).toBe('One or more hooks are invalid');
  });

  it('refuses an OUTBOUND restore whose actions fail, writing no configuration', async () => {
    const { workspace, agent } = await setup('BI', true);
    const snap = await storedSnapshot(agent.id, workspace.id, 'OUTBOUND');
    vi.mocked(client.replaceAgentLifecycleHooks).mockRejectedValue(new Error('socket hang up'));

    const res = await request(app).post(restoreUrl(workspace, agent.id, snap.id)).set(...asAlice());

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('RESTORE_FAILED');
    expect(vi.mocked(client.updateAgent)).not.toHaveBeenCalled();
    expect(vi.mocked(client.updateAgentInbound)).not.toHaveBeenCalled();
  });

  it('refuses an OUTBOUND restore with 501 while the platform lacks the actions route', async () => {
    const { workspace, agent } = await setup('BI', true);
    const snap = await storedSnapshot(agent.id, workspace.id, 'OUTBOUND');
    const { ApiError } = await import('../src/lib/errors.js');
    vi.mocked(client.replaceAgentLifecycleHooks).mockRejectedValue(
      new ApiError(501, 'KEEP_INBOUND_UNAVAILABLE', 'needs a platform update'),
    );

    const res = await request(app).post(restoreUrl(workspace, agent.id, snap.id)).set(...asAlice());

    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('RESTORE_UNAVAILABLE');
    expect(res.body.error.message).toMatch(/platform update/);
    expect(vi.mocked(client.updateAgent)).not.toHaveBeenCalled();
  });

  it('answers 502 RESTORE_PARTIAL when the actions landed and the configuration did not', async () => {
    const { workspace, agent } = await setup('BI', true);
    const snap = await storedSnapshot(agent.id, workspace.id, 'OUTBOUND');
    vi.mocked(client.updateAgent).mockRejectedValue(new Error('socket hang up'));

    const res = await request(app).post(restoreUrl(workspace, agent.id, snap.id)).set(...asAlice());

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('RESTORE_PARTIAL');
    expect(vi.mocked(client.replaceAgentLifecycleHooks)).toHaveBeenCalledTimes(1);
  });

  it('restores the oldest of a full history, and keeps it restorable', async () => {
    const { workspace, agent } = await setup();
    const snaps = [];
    for (let i = 0; i < 20; i += 1) {
      snaps.push(
        await storedSnapshot(agent.id, workspace.id, 'INBOUND', {
          config: { ...(await import('../src/lib/personaSnapshot.js')).personaConfig(FACE), prompt: `v${i}` },
          createdAt: new Date(Date.UTC(2026, 8, 1, 0, i)),
        }),
      );
    }
    const oldest = snaps[0];
    vi.mocked(client.updateAgentInbound).mockRejectedValueOnce(new Error('socket hang up'));

    const failed = await request(app).post(restoreUrl(workspace, agent.id, oldest.id)).set(...asAlice());
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(await prisma.agentPersonaSnapshot.findUnique({ where: { id: oldest.id } })).not.toBeNull();

    const res = await request(app).post(restoreUrl(workspace, agent.id, oldest.id)).set(...asAlice());
    expect(res.status).toBe(200);
    expect(vi.mocked(client.updateAgentInbound).mock.calls.at(-1)?.[1]).toMatchObject({ prompt: 'v0' });
    expect(await prisma.agentPersonaSnapshot.findUnique({ where: { id: oldest.id } })).not.toBeNull();
  });

  it('names the fields the platform would not take back, and says it restored nothing else', async () => {
    const { workspace, agent } = await setup();
    const { personaConfig } = await import('../src/lib/personaSnapshot.js');
    const config = personaConfig(FACE);
    config.extraction_config = {
      prompt: 'Extract.',
      keys: [{ name: 'issue', type: 'not-a-type' }],
    };
    const snap = await storedSnapshot(agent.id, workspace.id, 'INBOUND', { config });

    const res = await request(app).post(restoreUrl(workspace, agent.id, snap.id)).set(...asAlice());

    expect(res.status).toBe(200);
    expect(res.body.data.notRestored).toEqual(['Extraction fields']);
    expect(vi.mocked(client.updateAgentInbound).mock.calls[0][1]).not.toHaveProperty('extraction_config');
  });

  it('does not list a refused field the side already holds', async () => {
    const { workspace, agent } = await setup();
    const { personaConfig } = await import('../src/lib/personaSnapshot.js');
    platform.face = { ...FACE, spoken_languages: [] };
    const snap = await storedSnapshot(agent.id, workspace.id, 'INBOUND', {
      config: { ...personaConfig(FACE), spoken_languages: [], prompt: 'Older.' },
    });

    const res = await request(app).post(restoreUrl(workspace, agent.id, snap.id)).set(...asAlice());

    expect(res.status).toBe(200);
    expect(res.body.data.notRestored).toEqual([]);
  });

  it('answers an empty notRestored when everything came back', async () => {
    const { workspace, agent } = await setup();
    const snap = await storedSnapshot(agent.id, workspace.id, 'INBOUND');

    const res = await request(app).post(restoreUrl(workspace, agent.id, snap.id)).set(...asAlice());

    expect(res.status).toBe(200);
    expect(res.body.data.notRestored).toEqual([]);
  });

  it('answers 502 SNAPSHOT_FAILED, writing nothing, when the current state cannot be saved', async () => {
    const { workspace, agent } = await setup();
    const snap = await storedSnapshot(agent.id, workspace.id, 'INBOUND');
    platform.face = null;

    const res = await request(app).post(restoreUrl(workspace, agent.id, snap.id)).set(...asAlice());

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('SNAPSHOT_FAILED');
    nothingOverwritten();
  });

  it("404s a snapshot of another workspace's agent", async () => {
    const { workspace, agent } = await setup();
    const bob = await makeAccount('bob');
    const bobs = await makeWorkspace(bob, 'Bob Co');
    const bobsAgent = await prisma.agent.create({
      data: { externalId: 'ext-bob', name: 'Bob agent', workspaceId: bobs.id, direction: 'BI', inboundEnabled: true },
    });
    const bobsSnap = await storedSnapshot(bobsAgent.id, bobs.id, 'INBOUND');

    const res = await request(app).post(restoreUrl(workspace, agent.id, bobsSnap.id)).set(...asAlice());

    expect(res.status).toBe(404);
    nothingOverwritten();
  });

  it('404s a snapshot taken while the agent was in another workspace', async () => {
    const { workspace, agent } = await setup();
    const bob = await makeAccount('bob');
    const bobs = await makeWorkspace(bob, 'Bob Co');
    const theirs = await storedSnapshot(agent.id, bobs.id, 'INBOUND');

    const res = await request(app).post(restoreUrl(workspace, agent.id, theirs.id)).set(...asAlice());

    expect(res.status).toBe(404);
    nothingOverwritten();
  });
});
