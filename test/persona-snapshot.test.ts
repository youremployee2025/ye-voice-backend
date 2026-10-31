import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';

/**
 * The two halves of "an overwrite is never silent or unrecoverable":
 * the diff an operator confirms against, and the snapshot taken before any
 * side of a persona is written over.
 *
 * Mocked platform shapes, as the adapter hands them over (producer lines in the
 * Vocobase backend):
 *  - `getAgent(id)` → the V2 agent record, `toV2AgentResponse(agent)` plus
 *    `inbound: { enabled }` (`routes/v2/agent.routes.ts:374-382`).
 *  - `getAgent(id, { includeInbound: true })` → the same record with the face
 *    nested as `inbound: { enabled, config }`, where `config` is the face's own
 *    `toV2AgentResponse` minus `id`, `agent_name` and `inbound`
 *    (`routes/v2/agent.routes.ts:357-382`).
 *  - `getAgentLifecycleHooks(id)` → the bare `{ hooks }` document of Prisma
 *    `AgentLifecycleHook` rows (`routes/v2/lifecycle-hooks.routes.ts:64-67`).
 *  - `getInboundLifecycleHooks(id)` → `{ hooks }`, the face route's
 *    `{ success, data: { hooks } }` after `unwrap`, each row re-parented by
 *    `asParent` (`routes/v2/inbound-lifecycle-hooks.routes.ts:130-135`).
 */

vi.mock('../src/adapter/vocobase.js', () => ({
  getAgent: vi.fn(),
  getAgentLifecycleHooks: vi.fn(),
  getInboundLifecycleHooks: vi.fn(),
  updateAgent: vi.fn(),
  updateAgentInbound: vi.fn(),
  replaceInboundLifecycleHooks: vi.fn(),
  replaceAgentLifecycleHooks: vi.fn(),
}));

const client = await import('../src/adapter/vocobase.js');
const {
  buildDirectionPreview,
  personaConfig,
  readPersonas,
  takePersonaSnapshot,
  PERSONA_SNAPSHOTS_KEPT,
  PersonaUnreadable,
} = await import('../src/lib/personaSnapshot.js');

const baseConfig = {
  id: 'ext-1',
  agent_name: 'Dhandha Support Triage',
  status: 'active',
  project_id: 'proj-base',
  voice_id: 'voice-base',
  variables: ['lead_id'],
  prompt: 'Qualify the lead.',
  intro_message: 'Hi, this is Dhandha.',
  transfer_enabled: true,
  transfer_destinations: [
    { key: 'sales', label: 'Sales desk', number: '+919876543210', llmDescription: 'Buying intent' },
  ],
  extraction_enabled: true,
  extraction_config: {
    prompt: 'Extract.',
    keys: [
      { name: 'budget', type: 'string', description: 'Budget' },
      { name: 'city', type: 'string' },
    ],
    inlineEnabled: true,
  },
};

const faceConfig = {
  ...baseConfig,
  project_id: 'proj-face',
  prompt: 'Triage the inbound caller.',
  intro_message: 'Thanks for calling support.',
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

function personas(
  over: {
    base?: Record<string, unknown>;
    face?: Record<string, unknown>;
    baseHooks?: Record<string, unknown>[];
    faceHooks?: Record<string, unknown>[];
  } = {},
) {
  return {
    base: { raw: over.base ?? baseConfig, hookRows: over.baseHooks ?? [hookRow()] },
    face: { raw: over.face ?? baseConfig, hookRows: over.faceHooks ?? [hookRow()] },
  };
}

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('personaConfig', () => {
  it('projects the editable keys plus voice and variables, never the project', () => {
    const config = personaConfig(baseConfig);

    expect(config.prompt).toBe('Qualify the lead.');
    expect(config.voice_id).toBe('voice-base');
    expect(config.variables).toEqual(['lead_id']);
    expect(config).not.toHaveProperty('project_id');
    expect(config).not.toHaveProperty('agent_name');
    expect(config).not.toHaveProperty('id');
  });

  it('reads an absent key as null, so absent and cleared compare equal', () => {
    const config = personaConfig({ prompt: 'x' });
    expect(config.transfer_message).toBeNull();
    expect(personaConfig({ prompt: 'x', transfer_message: null })).toEqual(config);
  });
});

describe('buildDirectionPreview', () => {
  it('reports identical sides with empty lists and still fingerprints both choices', () => {
    const preview = buildDirectionPreview(personas());

    expect(preview.identical).toBe(true);
    for (const side of [preview.keep_outbound, preview.keep_inbound]) {
      expect(side.fields).toEqual([]);
      expect(side.actions).toEqual({ removed: [], added: [], changed: [] });
      expect(side.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(preview.keep_outbound.replaced).toBe('inbound');
    expect(preview.keep_inbound.replaced).toBe('outbound');
    expect(preview.keep_outbound.fingerprint).not.toBe(preview.keep_inbound.fingerprint);
  });

  it('ignores the timezone, which no overwrite writes', () => {
    const preview = buildDirectionPreview({
      base: { raw: { ...baseConfig, timezone: 'Asia/Kolkata' }, hookRows: [] },
      face: { raw: { ...baseConfig, timezone: 'Europe/London' }, hookRows: [] },
    });

    expect(preview.identical).toBe(true);
  });

  it('ignores the face project, which the overwrite never writes', () => {
    const preview = buildDirectionPreview(
      personas({ face: { ...baseConfig, project_id: 'proj-face' } }),
    );
    expect(preview.identical).toBe(true);
  });

  /**
   * The incident: a BI → UNI move replaced the prompt and greeting, switched
   * transfer off and deleted every extraction field. Each of those has to be
   * named in the diff, in words, before anybody confirms.
   */
  it('names the prompt, greeting, transfer and extraction differences, per side', () => {
    const face = {
      ...faceConfig,
      transfer_enabled: false,
      transfer_destinations: [],
      extraction_config: {
        prompt: 'Extract.',
        keys: [
          { name: 'issue', type: 'string' },
          { name: 'severity', type: 'string' },
        ],
        inlineEnabled: true,
      },
    };
    const preview = buildDirectionPreview(personas({ face }));

    expect(preview.identical).toBe(false);
    const byField = Object.fromEntries(preview.keep_outbound.fields.map((f) => [f.field, f]));

    // keep_outbound replaces the INBOUND side: current is the face, incoming the base.
    expect(byField.prompt).toMatchObject({
      label: 'Prompt',
      current: 'Triage the inbound caller.',
      incoming: 'Qualify the lead.',
    });
    expect(byField.intro_message).toMatchObject({
      label: 'Greeting',
      current: 'Thanks for calling support.',
      incoming: 'Hi, this is Dhandha.',
    });
    expect(byField.transfer_enabled).toMatchObject({ current: 'Off', incoming: 'On' });
    expect(byField.transfer_destinations).toMatchObject({
      current: 'None',
      incoming: 'Sales desk (+919876543210)',
    });
    // Key names, not raw JSON.
    expect(byField.extraction_config).toMatchObject({
      current: 'issue, severity',
      incoming: 'budget, city',
    });
    expect(Object.keys(byField).sort()).toEqual(
      ['extraction_config', 'intro_message', 'prompt', 'transfer_destinations', 'transfer_enabled'].sort(),
    );

    // keep_inbound is the mirror image: the base is replaced by the face.
    const inbound = Object.fromEntries(preview.keep_inbound.fields.map((f) => [f.field, f]));
    expect(inbound.prompt).toMatchObject({
      current: 'Qualify the lead.',
      incoming: 'Triage the inbound caller.',
    });
  });

  it('truncates a display value to 300 characters', () => {
    const preview = buildDirectionPreview(
      personas({ face: { ...baseConfig, prompt: 'p'.repeat(5000) } }),
    );
    const prompt = preview.keep_outbound.fields.find((f) => f.field === 'prompt')!;
    expect(prompt.current.length).toBe(300);
    expect(prompt.current.endsWith('…')).toBe(true);
  });

  it('lists added, removed and changed actions', () => {
    const shared = hookRow({ id: 'a', name: 'Look up lead' });
    const baseOnly = hookRow({
      id: 'b',
      stage: 'POST_CALL',
      toolSlug: null,
      toolFn: null,
      functionId: 'fn-crm',
      name: 'Push to CRM',
    });
    const faceOnly = hookRow({ id: 'c', stage: 'POST_CALL', toolFn: 'append_row', name: 'Log call' });
    const faceShared = hookRow({ id: 'a2', name: 'Look up lead', timeoutMs: 9000 });

    const preview = buildDirectionPreview(
      personas({ baseHooks: [shared, baseOnly], faceHooks: [faceShared, faceOnly] }),
    );

    expect(preview.identical).toBe(false);
    // keep_outbound: the face's list is replaced with the base's.
    expect(preview.keep_outbound.actions).toEqual({
      removed: [{ stage: 'POST_CALL', name: 'Log call', source: 'google_sheets:append_row' }],
      added: [{ stage: 'POST_CALL', name: 'Push to CRM', source: 'fn-crm' }],
      changed: [{ stage: 'PRE_CALL', name: 'Look up lead', source: 'google_sheets:lookup_row' }],
    });
    expect(preview.keep_inbound.actions).toEqual({
      removed: [{ stage: 'POST_CALL', name: 'Push to CRM', source: 'fn-crm' }],
      added: [{ stage: 'POST_CALL', name: 'Log call', source: 'google_sheets:append_row' }],
      changed: [{ stage: 'PRE_CALL', name: 'Look up lead', source: 'google_sheets:lookup_row' }],
    });
  });

  it('reads a paused or conditioned action as changed', () => {
    const preview = buildDirectionPreview(
      personas({ faceHooks: [hookRow({ enabled: false, skipUnless: ['extraction.x'] })] }),
    );
    expect(preview.keep_outbound.actions.changed).toHaveLength(1);
  });

  it('ignores key order inside the structured fields and the hook rows', () => {
    const reordered = {
      ...baseConfig,
      transfer_destinations: [
        { llmDescription: 'Buying intent', number: '+919876543210', label: 'Sales desk', key: 'sales' },
      ],
      extraction_config: {
        inlineEnabled: true,
        keys: [
          { type: 'string', description: 'Budget', name: 'budget' },
          { type: 'string', name: 'city' },
        ],
        prompt: 'Extract.',
      },
    };
    const row = hookRow();
    // Top-level keys reversed, and — the part only a canonical sort catches —
    // the keys inside `input`, which is carried across verbatim.
    const reorderedRow = {
      ...Object.fromEntries(Object.entries(row).reverse()),
      input: { matchColumn: 'phone', spreadsheetId: 'sheet-1' },
    };

    const preview = buildDirectionPreview(
      personas({ face: reordered, faceHooks: [reorderedRow] }),
    );
    expect(preview.identical).toBe(true);
  });

  it('changes every fingerprint when either side changes', () => {
    const before = buildDirectionPreview(personas());
    const faceEdit = buildDirectionPreview(personas({ face: { ...baseConfig, prompt: 'new' } }));
    const baseEdit = buildDirectionPreview(personas({ base: { ...baseConfig, prompt: 'new' } }));
    const faceHookEdit = buildDirectionPreview(personas({ faceHooks: [] }));
    const baseHookEdit = buildDirectionPreview(personas({ baseHooks: [] }));

    for (const after of [faceEdit, baseEdit, faceHookEdit, baseHookEdit]) {
      expect(after.keep_outbound.fingerprint).not.toBe(before.keep_outbound.fingerprint);
      expect(after.keep_inbound.fingerprint).not.toBe(before.keep_inbound.fingerprint);
    }
    // And it is stable: the same two sides fingerprint the same.
    expect(buildDirectionPreview(personas()).keep_outbound.fingerprint).toBe(
      before.keep_outbound.fingerprint,
    );
  });
});

describe('readPersonas', () => {
  function mockPlatform(face: Record<string, unknown> | null) {
    vi.mocked(client.getAgent).mockImplementation(async (_id, opts) => ({
      ...baseConfig,
      inbound: opts?.includeInbound && face ? { enabled: true, config: face } : { enabled: true },
    }));
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({ hooks: [hookRow()] });
    vi.mocked(client.getInboundLifecycleHooks).mockResolvedValue({ hooks: [] });
  }

  it('reads the base, the face and both hook lists', async () => {
    mockPlatform(faceConfig);

    const read = await readPersonas('ext-1');

    expect(vi.mocked(client.getAgent)).toHaveBeenCalledWith('ext-1');
    expect(vi.mocked(client.getAgent)).toHaveBeenCalledWith('ext-1', { includeInbound: true });
    expect(read.base.raw.prompt).toBe('Qualify the lead.');
    expect(read.face.raw.prompt).toBe('Triage the inbound caller.');
    expect(read.base.hookRows).toHaveLength(1);
    expect(read.face.hookRows).toEqual([]);
  });

  it('refuses a face that carried no prompt, naming the inbound side', async () => {
    mockPlatform(null);

    const err = await readPersonas('ext-1').catch((e) => e);
    expect(err).toBeInstanceOf(PersonaUnreadable);
    expect(err.sides).toEqual(['INBOUND']);
  });

  it('refuses a hook read that carried no list, never reading it as empty', async () => {
    mockPlatform(faceConfig);
    vi.mocked(client.getAgentLifecycleHooks).mockResolvedValue({} as never);

    const err = await readPersonas('ext-1').catch((e) => e);
    expect(err).toBeInstanceOf(PersonaUnreadable);
    expect(err.sides).toEqual(['OUTBOUND']);
  });
});

describe('takePersonaSnapshot', () => {
  async function agentRow() {
    const alice = await makeAccount('alice');
    const workspace = await makeWorkspace(alice, 'Alice Co');
    const agent = await prisma.agent.create({
      data: { externalId: 'ext-1', name: 'Dhandha', workspaceId: workspace.id, direction: 'BI' },
    });
    return { alice, workspace, agent };
  }

  it('stores the full projection and replayable hook bodies, with the workspace at the time', async () => {
    const { alice, workspace, agent } = await agentRow();
    const long = 'x'.repeat(2000);

    const snapshot = await takePersonaSnapshot({
      agentId: agent.id,
      externalId: agent.externalId,
      side: 'INBOUND',
      reason: 'DIRECTION_UNI_KEEP_OUTBOUND',
      takenByUserId: alice.id,
      persona: { raw: { ...faceConfig, prompt: long }, hookRows: [hookRow()] },
    });

    const row = await prisma.agentPersonaSnapshot.findUniqueOrThrow({ where: { id: snapshot.id } });
    expect(row.workspaceId).toBe(workspace.id);
    expect(row.side).toBe('INBOUND');
    expect(row.reason).toBe('DIRECTION_UNI_KEEP_OUTBOUND');
    expect(row.takenByUserId).toBe(alice.id);
    // Untruncated: this is what a restore writes back.
    expect((row.config as Record<string, unknown>).prompt).toBe(long);
    expect(row.hooks).toEqual([
      {
        stage: 'PRE_CALL',
        name: 'Look up lead',
        toolSlug: 'google_sheets',
        toolFn: 'lookup_row',
        input: { spreadsheetId: 'sheet-1', matchColumn: 'phone' },
        exposeAs: 'lead',
        required: false,
        timeoutMs: 3000,
        enabled: true,
        skipUnless: [],
      },
    ]);
  });

  it('reads the side itself when it is not handed one', async () => {
    const { agent } = await agentRow();
    vi.mocked(client.getAgent).mockResolvedValue({
      ...baseConfig,
      inbound: { enabled: true, config: faceConfig },
    });
    vi.mocked(client.getInboundLifecycleHooks).mockResolvedValue({ hooks: [] });

    const snapshot = await takePersonaSnapshot({
      agentId: agent.id,
      externalId: agent.externalId,
      side: 'INBOUND',
      reason: 'INBOUND_START_REVIVE',
    });

    const row = await prisma.agentPersonaSnapshot.findUniqueOrThrow({ where: { id: snapshot.id } });
    expect((row.config as Record<string, unknown>).prompt).toBe('Triage the inbound caller.');
    expect(row.takenByUserId).toBeNull();
  });

  it('refuses, writing nothing, when the side cannot be read', async () => {
    const { agent } = await agentRow();
    vi.mocked(client.getAgent).mockRejectedValue(new Error('socket hang up'));
    vi.mocked(client.getInboundLifecycleHooks).mockResolvedValue({ hooks: [] });

    await expect(
      takePersonaSnapshot({
        agentId: agent.id,
        externalId: agent.externalId,
        side: 'INBOUND',
        reason: 'INBOUND_START_REVIVE',
      }),
    ).rejects.toThrow();
    expect(await prisma.agentPersonaSnapshot.count()).toBe(0);
  });

  it(`keeps the newest ${20} per agent and side, and leaves the other side alone`, async () => {
    const { agent } = await agentRow();
    expect(PERSONA_SNAPSHOTS_KEPT).toBe(20);
    // Each one different: an unchanged side is not saved twice.
    const persona = (i: number) => ({ raw: { ...faceConfig, prompt: `Version ${i}` }, hookRows: [] });

    // One on the other side first: pruning INBOUND must not touch it.
    await takePersonaSnapshot({
      agentId: agent.id,
      externalId: agent.externalId,
      side: 'OUTBOUND',
      reason: 'RESTORE',
      persona: persona(-1),
    });

    const ids: string[] = [];
    for (let i = 0; i < 23; i += 1) {
      const snap = await takePersonaSnapshot({
        agentId: agent.id,
        externalId: agent.externalId,
        side: 'INBOUND',
        reason: 'RESTORE',
        persona: persona(i),
      });
      ids.push(snap.id);
    }

    const left = await prisma.agentPersonaSnapshot.findMany({
      where: { agentId: agent.id, side: 'INBOUND' },
      select: { id: true },
    });
    expect(left).toHaveLength(20);
    expect(new Set(left.map((r) => r.id))).toEqual(new Set(ids.slice(3)));
    expect(await prisma.agentPersonaSnapshot.count({ where: { side: 'OUTBOUND' } })).toBe(1);
  });

  it('saves an unchanged side once, so retries cannot push older history out', async () => {
    const { agent } = await agentRow();
    const persona = { raw: faceConfig, hookRows: [hookRow()] };
    const take = () =>
      takePersonaSnapshot({
        agentId: agent.id,
        externalId: agent.externalId,
        side: 'INBOUND',
        reason: 'DIRECTION_UNI_KEEP_OUTBOUND',
        persona,
      });

    const first = await take();
    const second = await take();

    expect(second.id).toBe(first.id);
    expect(await prisma.agentPersonaSnapshot.count()).toBe(1);
  });

  it('saves again once the side has changed since its newest snapshot', async () => {
    const { agent } = await agentRow();
    const take = (prompt: string) =>
      takePersonaSnapshot({
        agentId: agent.id,
        externalId: agent.externalId,
        side: 'INBOUND',
        reason: 'RESTORE',
        persona: { raw: { ...faceConfig, prompt }, hookRows: [] },
      });

    await take('One.');
    await take('Two.');
    await take('One.');

    expect(await prisma.agentPersonaSnapshot.count()).toBe(3);
  });

  it('never prunes the snapshot it is told to keep, however old', async () => {
    const { agent } = await agentRow();
    const ids: string[] = [];
    for (let i = 0; i < PERSONA_SNAPSHOTS_KEPT; i += 1) {
      const snap = await takePersonaSnapshot({
        agentId: agent.id,
        externalId: agent.externalId,
        side: 'INBOUND',
        reason: 'RESTORE',
        persona: { raw: { ...faceConfig, prompt: `Version ${i}` }, hookRows: [] },
      });
      ids.push(snap.id);
    }

    await takePersonaSnapshot({
      agentId: agent.id,
      externalId: agent.externalId,
      side: 'INBOUND',
      reason: 'RESTORE',
      persona: { raw: { ...faceConfig, prompt: 'Current.' }, hookRows: [] },
      keepId: ids[0],
    });

    const left = new Set(
      (await prisma.agentPersonaSnapshot.findMany({ select: { id: true } })).map((r) => r.id),
    );
    expect(left.has(ids[0])).toBe(true);
    // The next-oldest goes instead.
    expect(left.has(ids[1])).toBe(false);
    expect(left.size).toBe(PERSONA_SNAPSHOTS_KEPT);
  });
});
