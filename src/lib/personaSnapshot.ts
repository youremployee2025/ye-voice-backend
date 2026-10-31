import { createHash } from 'node:crypto';
import type { PersonaSide, PersonaSnapshotReason, Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { getAgent, getAgentLifecycleHooks, getInboundLifecycleHooks } from '../adapter/vocobase.js';
import { faceConfig, hookRowToFaceCopy, writableConfigFrom } from './faceMirror.js';
import type { LifecycleHookWrite } from '../adapter/vocobase.js';
import { serializeInboundConfig, VISIBLE_CONFIG_KEYS } from './serialize.js';

/**
 * An agent's two personas, compared before one is written over the other and
 * saved before either is.
 *
 * On 2026-09-21 a `BI → UNI` move on one agent wrote its outbound persona over
 * a completely different inbound one — prompt, greeting, transfer, and every
 * extraction field — and 194 inbound calls lost their extraction. Nothing
 * said what would be replaced, and nothing kept what was. This module is both
 * halves of the answer:
 *
 * - **The preview** (`buildDirectionPreview`) names every field and action
 *   the move would replace, for either choice of survivor, and fingerprints
 *   the exact state it compared, so a confirm is a confirm of THAT diff and
 *   not of whatever the agent became since.
 * - **The snapshot** (`takePersonaSnapshot`) saves the side about to be
 *   overwritten, and every overwrite refuses when it cannot save one first.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** How many snapshots are kept per agent and side. */
export const PERSONA_SNAPSHOTS_KEPT = 20;

/** Display values are cut here, so one prompt cannot fill the dialog. */
const DISPLAY_MAX = 300;

/**
 * The editable configuration, as the preview compares it and a snapshot
 * stores it: the keys `serializeInboundConfig` projects (the shared
 * `VISIBLE_CONFIG_KEYS` plus `voice_id` and `variables`), less `project_id`.
 *
 * `project_id` is left out because no overwrite writes it — the face's
 * project decides the call's pricing and upstream discards it — so a face on
 * its own project would read as "different" on every agent, forever.
 * `timezone` is left out for the same reason: it is displayed, never written
 * (it is not a writable agent field), so a diff naming it promised a
 * replacement that did not happen, and a restore could never bring it back.
 */
export const PERSONA_CONFIG_KEYS = [
  ...VISIBLE_CONFIG_KEYS.filter((key) => key !== 'project_id' && key !== 'timezone'),
  'voice_id',
  'variables',
] as const;

/** What an operator reads in the diff for each key. */
const FIELD_LABELS: Record<(typeof PERSONA_CONFIG_KEYS)[number], string> = {
  intro_message: 'Greeting',
  prompt: 'Prompt',
  spoken_languages: 'Languages',
  enable_recording: 'Call recording',
  max_call_duration_secs: 'Maximum call length (seconds)',
  user_idle_enabled: 'Idle check',
  voicemail_detection_enabled: 'Voicemail detection',
  screener_handling_enabled: 'Call screener handling',
  voicemail_message: 'Voicemail message',
  transfer_enabled: 'Call transfer',
  transfer_number: 'Transfer number',
  transfer_destinations: 'Transfer destinations',
  transfer_message: 'Transfer message',
  transfer_instructions: 'Transfer instructions',
  end_call_enabled: 'End call',
  end_call_message: 'End call message',
  end_call_instructions: 'End call instructions',
  extraction_enabled: 'Extraction',
  extraction_config: 'Extraction fields',
  kb_enable_llm_processing: 'Knowledge base processing',
  kb_llm_system_prompt: 'Knowledge base prompt',
  background_audio_id: 'Background audio',
  background_audio_volume: 'Background audio volume',
  voice_id: 'Voice',
  variables: 'Variables',
};

/** The operator's word for a configuration key, for a refusal that names it. */
export function personaFieldLabel(key: string): string {
  return (FIELD_LABELS as Record<string, string>)[key] ?? key;
}

/** One side as read from the platform: its configuration record, and its hook rows. */
export interface Persona {
  raw: Record<string, unknown>;
  hookRows: Record<string, unknown>[];
}

export interface Personas {
  base: Persona;
  face: Persona;
}

/** The agent row was gone when the snapshot went to record it. */
export class SnapshotAgentGone extends Error {
  constructor() {
    super('The agent no longer exists.');
    this.name = 'SnapshotAgentGone';
  }
}

/** A side that could not be read in full. Never turned into an empty persona. */
export class PersonaUnreadable extends Error {
  constructor(readonly sides: PersonaSide[]) {
    super(`Could not read the ${sides.join(' and ').toLowerCase()} persona.`);
    this.name = 'PersonaUnreadable';
  }
}

/**
 * The editable projection of one side's configuration.
 *
 * Every key is present, an absent one as `null`: an absent value and a
 * cleared one are the same state to an overwrite (it sends `null` for both),
 * so they must compare equal here. `transfer_destinations` and
 * `extraction_config` are rebuilt field by field by the serializer, so the
 * order the platform happened to send their keys in cannot count as a change.
 */
export function personaConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const projected = serializeInboundConfig(raw) ?? {};
  const config: Record<string, unknown> = {};
  for (const key of PERSONA_CONFIG_KEYS) {
    config[key] = projected[key] === undefined ? null : projected[key];
  }
  return config;
}

/** One action as the preview compares it. */
export interface HookProjection {
  stage: string;
  source: string;
  name: string;
  input: Record<string, unknown> | null;
  exposeAs: string | null;
  required: boolean | null;
  timeoutMs: number | null;
  enabled: boolean;
  skipUnless: string[];
}

export interface HookSummary {
  stage: string;
  name: string;
  source: string;
}

/** `toolSlug:toolFn` for a tool action, the function id for a custom one. */
function hookSource(hook: LifecycleHookWrite): string {
  if (hook.toolSlug && hook.toolFn) return `${hook.toolSlug}:${hook.toolFn}`;
  return hook.functionId ?? hook.toolSlug ?? '';
}

/**
 * A side's actions, in order, projected through the same body a copy would
 * write (`hookRowToFaceCopy`) — so the preview compares exactly what an
 * overwrite would carry across, and nothing it would drop.
 */
export function personaHooks(rows: Record<string, unknown>[]): HookProjection[] {
  return rows.map((row) => {
    const hook = hookRowToFaceCopy(row);
    return {
      stage: hook.stage,
      source: hookSource(hook),
      name: hook.name,
      input: hook.input ?? null,
      exposeAs: hook.exposeAs ?? null,
      required: hook.required ?? null,
      timeoutMs: hook.timeoutMs ?? null,
      enabled: hook.enabled ?? true,
      skipUnless: hook.skipUnless ?? [],
    };
  });
}

/** JSON with every object's keys sorted, so key order never reads as a change. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key]);
    return sorted;
  }
  return value;
}

export interface FieldChange {
  field: string;
  label: string;
  current: string;
  incoming: string;
}

export interface PreviewSide {
  fingerprint: string;
  replaced: 'inbound' | 'outbound';
  fields: FieldChange[];
  actions: { removed: HookSummary[]; added: HookSummary[]; changed: HookSummary[] };
}

export interface DirectionPreview {
  identical: boolean;
  keep_outbound: PreviewSide;
  keep_inbound: PreviewSide;
}

function truncate(text: string): string {
  return text.length > DISPLAY_MAX ? `${text.slice(0, DISPLAY_MAX - 1)}…` : text;
}

/** A value as the diff shows it: words, not JSON. */
function display(key: string, value: unknown): string {
  if (value === null || value === undefined) return 'Not set';

  if (key === 'extraction_config' && isRecord(value)) {
    const keys = Array.isArray(value.keys) ? value.keys : [];
    const names = keys
      .map((k) => (isRecord(k) && typeof k.name === 'string' ? k.name : null))
      .filter((name): name is string => name !== null);
    return truncate(names.length > 0 ? names.join(', ') : 'No fields');
  }

  if (key === 'transfer_destinations' && Array.isArray(value)) {
    if (value.length === 0) return 'None';
    return truncate(
      value
        .filter(isRecord)
        .map((d) => {
          const label =
            (typeof d.label === 'string' && d.label) || (typeof d.key === 'string' && d.key) || 'Destination';
          return `${label} (${typeof d.number === 'string' ? d.number : 'no number'})`;
        })
        .join('; '),
    );
  }

  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return truncate(value === '' ? 'Empty' : value);
  if (Array.isArray(value)) {
    return truncate(value.length === 0 ? 'None' : value.map((v) => String(v)).join(', '));
  }
  return truncate(JSON.stringify(value));
}

function fieldChanges(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const key of PERSONA_CONFIG_KEYS) {
    if (canonicalJson(current[key]) === canonicalJson(incoming[key])) continue;
    const currentText = display(key, current[key]);
    let incomingText = display(key, incoming[key]);
    // Two values that differ but read alike — extraction fields with the same
    // names and different descriptions — must still read as a change.
    if (currentText === incomingText) incomingText = truncate(`${incomingText} (settings differ)`);
    changes.push({ field: key, label: FIELD_LABELS[key], current: currentText, incoming: incomingText });
  }
  return changes;
}

const identityOf = (hook: HookProjection) => `${hook.stage}|${hook.source}|${hook.name}`;
const summaryOf = (hook: HookProjection): HookSummary => ({
  stage: hook.stage,
  name: hook.name,
  source: hook.source,
});

/**
 * What replacing `current` with `incoming` does to the actions.
 *
 * Paired by stage, source and name, first unused match in order. An unpaired
 * current action is `removed`, an unpaired incoming one `added`, and a pair
 * whose settings differ — or that sits at a different place in the run order —
 * is `changed`, listed under its incoming identity.
 */
function actionChanges(current: HookProjection[], incoming: HookProjection[]) {
  const used = new Set<number>();
  const pairs: Array<{ from: number; to: number }> = [];
  const removed: HookSummary[] = [];

  current.forEach((hook, from) => {
    const to = incoming.findIndex((candidate, i) => !used.has(i) && identityOf(candidate) === identityOf(hook));
    if (to === -1) {
      removed.push(summaryOf(hook));
      return;
    }
    used.add(to);
    pairs.push({ from, to });
  });

  const added = incoming.filter((_, i) => !used.has(i)).map(summaryOf);

  // Rank among the paired actions only, so an insertion elsewhere does not
  // mark every later action as moved.
  const byTo = [...pairs].sort((a, b) => a.to - b.to);
  const changed = pairs
    .filter((pair, rank) => {
      const moved = byTo[rank] !== pair;
      return moved || canonicalJson(current[pair.from]) !== canonicalJson(incoming[pair.to]);
    })
    .sort((a, b) => a.to - b.to)
    .map((pair) => summaryOf(incoming[pair.to]));

  return { removed, added, changed };
}

/**
 * The comparison `GET .../direction/preview` answers and `PATCH .../direction`
 * recomputes before it writes.
 *
 * `keep_outbound` replaces the INBOUND side: `current` is the face, `incoming`
 * the base. `keep_inbound` is the mirror image. Each carries its own
 * fingerprint — sha256 over the canonical JSON of both full projections, both
 * hook lists and the choice — so any change to either side, anywhere, makes a
 * confirm taken against the old comparison stale.
 */
export function buildDirectionPreview(personas: Personas): DirectionPreview {
  const baseConfig = personaConfig(personas.base.raw);
  const faceConfigProjection = personaConfig(personas.face.raw);
  const baseHooks = personaHooks(personas.base.hookRows);
  const faceHooks = personaHooks(personas.face.hookRows);

  const fingerprint = (keep: 'outbound' | 'inbound') =>
    createHash('sha256')
      .update(
        canonicalJson({
          baseConfig,
          faceConfig: faceConfigProjection,
          baseHooks,
          faceHooks,
          keep,
        }),
      )
      .digest('hex');

  const identical =
    canonicalJson(baseConfig) === canonicalJson(faceConfigProjection) &&
    canonicalJson(baseHooks) === canonicalJson(faceHooks);

  const side = (keep: 'outbound' | 'inbound'): PreviewSide => {
    const [current, incoming, currentHooks, incomingHooks] =
      keep === 'outbound'
        ? [faceConfigProjection, baseConfig, faceHooks, baseHooks]
        : [baseConfig, faceConfigProjection, baseHooks, faceHooks];
    return {
      fingerprint: fingerprint(keep),
      replaced: keep === 'outbound' ? 'inbound' : 'outbound',
      fields: identical ? [] : fieldChanges(current, incoming),
      actions: identical
        ? { removed: [], added: [], changed: [] }
        : actionChanges(currentHooks, incomingHooks),
    };
  };

  return { identical, keep_outbound: side('outbound'), keep_inbound: side('inbound') };
}

/**
 * One side, read live from the platform.
 *
 * A side is readable only with a configuration carrying a prompt and a hook
 * read that answered a list. Anything less — a failed read, a face record
 * with no config under it, a hook read with no array — throws rather than
 * turning into an empty persona: an empty snapshot is a snapshot that restores
 * nothing, and an empty preview side is a diff that hides the whole face.
 */
export async function readPersona(externalId: string, side: PersonaSide): Promise<Persona> {
  const [agent, hooks] = await Promise.all([
    side === 'INBOUND' ? getAgent(externalId, { includeInbound: true }) : getAgent(externalId),
    side === 'INBOUND' ? getInboundLifecycleHooks(externalId) : getAgentLifecycleHooks(externalId),
  ]).catch((err: unknown) => {
    console.error(`[persona] could not read ${externalId}'s ${side.toLowerCase()} persona:`, err);
    throw new PersonaUnreadable([side]);
  });

  const raw = side === 'INBOUND' ? faceConfig(agent) : isRecord(agent) ? agent : null;
  const list = isRecord(hooks) ? hooks.hooks : undefined;

  if (!raw || typeof raw.prompt !== 'string' || !Array.isArray(list)) {
    throw new PersonaUnreadable([side]);
  }

  return { raw, hookRows: list.filter(isRecord) };
}

/** Both sides, read together. Reports every side that failed, not just the first. */
export async function readPersonas(externalId: string): Promise<Personas> {
  const [base, face] = await Promise.allSettled([
    readPersona(externalId, 'OUTBOUND'),
    readPersona(externalId, 'INBOUND'),
  ]);

  const failed: PersonaSide[] = [];
  if (base.status === 'rejected') failed.push('OUTBOUND');
  if (face.status === 'rejected') failed.push('INBOUND');
  if (base.status === 'rejected' || face.status === 'rejected') throw new PersonaUnreadable(failed);

  return { base: base.value, face: face.value };
}

/**
 * Saves one side before it is overwritten, and prunes that side to the newest
 * `PERSONA_SNAPSHOTS_KEPT` in the same transaction.
 *
 * `persona` is what the caller already read — the direction route compares
 * and fingerprints a read, and the snapshot must be of that same read, not a
 * second one taken a moment later. Without it the side is read here.
 *
 * Throws on any failure, read or write. The caller refuses the overwrite:
 * an overwrite without a snapshot is exactly the incident.
 *
 * **An unchanged side is not saved twice.** When the newest snapshot of this
 * side already holds exactly this state, its id is answered instead. Without
 * that, every retry of a move or restore the platform keeps refusing saves one
 * more copy of the same state and prunes one real snapshot, so an outage
 * would quietly empty the history an operator is about to need.
 *
 * **`keepId` is never pruned.** A restore saves the current state before it
 * writes; were the snapshot being restored the oldest of a full side, that
 * save would delete it — and a platform failure after that loses the one copy
 * the operator was restoring from.
 */
export async function takePersonaSnapshot(args: {
  agentId: string;
  externalId: string;
  side: PersonaSide;
  reason: PersonaSnapshotReason;
  takenByUserId?: string | null;
  persona?: Persona;
  keepId?: string;
}): Promise<{ id: string }> {
  const persona = args.persona ?? (await readPersona(args.externalId, args.side));

  const config = personaConfig(persona.raw) as Prisma.InputJsonObject;
  const hooks = persona.hookRows.map(hookRowToFaceCopy) as unknown as Prisma.InputJsonArray;

  return prisma.$transaction(async (tx) => {
    const agent = await tx.agent.findUnique({
      where: { id: args.agentId },
      select: { workspaceId: true },
    });
    if (!agent) throw new SnapshotAgentGone();

    const newest = await tx.agentPersonaSnapshot.findFirst({
      where: { agentId: args.agentId, side: args.side, workspaceId: agent.workspaceId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, config: true, hooks: true },
    });
    if (
      newest &&
      canonicalJson(newest.config) === canonicalJson(config) &&
      canonicalJson(newest.hooks) === canonicalJson(hooks)
    ) {
      return { id: newest.id };
    }

    const created = await tx.agentPersonaSnapshot.create({
      data: {
        agentId: args.agentId,
        workspaceId: agent.workspaceId,
        side: args.side,
        reason: args.reason,
        config,
        hooks,
        takenByUserId: args.takenByUserId ?? null,
      },
      select: { id: true },
    });

    const rows = await tx.agentPersonaSnapshot.findMany({
      where: { agentId: args.agentId, side: args.side },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    // The kept one counts toward the 20 wherever it sits, so the next-oldest
    // goes in its place.
    const kept = rows.some((row) => row.id === args.keepId);
    const stale = rows
      .filter((row) => row.id !== args.keepId)
      .slice(kept ? PERSONA_SNAPSHOTS_KEPT - 1 : PERSONA_SNAPSHOTS_KEPT);
    if (stale.length > 0) {
      await tx.agentPersonaSnapshot.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
    }

    return created;
  });
}

/** The list row's summary of what a snapshot holds. */
export function snapshotSummary(config: unknown, hooks: unknown) {
  const cfg = isRecord(config) ? config : {};
  const extraction = isRecord(cfg.extraction_config) ? cfg.extraction_config : null;
  const keys = extraction && Array.isArray(extraction.keys) ? extraction.keys : [];

  return {
    prompt_preview: typeof cfg.prompt === 'string' ? cfg.prompt.slice(0, 160) : '',
    intro_message: typeof cfg.intro_message === 'string' ? cfg.intro_message : null,
    extraction_keys: keys
      .map((k) => (isRecord(k) && typeof k.name === 'string' ? k.name : null))
      .filter((name): name is string => name !== null),
    transfer_enabled: typeof cfg.transfer_enabled === 'boolean' ? cfg.transfer_enabled : null,
    actions: (Array.isArray(hooks) ? hooks : []).filter(isRecord).map((h) => ({
      stage: typeof h.stage === 'string' ? h.stage : '',
      name: typeof h.name === 'string' ? h.name : '',
    })),
  };
}

/**
 * A snapshot's configuration, shaped as an overwrite body.
 *
 * The stored projection carries the serializer's `null`s inside
 * `extraction_config` (`includeToolLogs`, `inlineEnabled`, `prompt`), which
 * the write schema refuses — and a refused `extraction_config` would be
 * dropped from the restore, which is the incident again. So those are
 * cleaned first; everything else goes through `writableConfigFrom` exactly as
 * a face copy does.
 */
export function restoreConfigBody(
  externalId: string,
  config: unknown,
  destination: string,
  dropped?: string[],
): Record<string, unknown> {
  const source: Record<string, unknown> = isRecord(config) ? { ...config } : {};
  const extraction = source.extraction_config;
  if (isRecord(extraction)) {
    const cleaned: Record<string, unknown> = {
      prompt: typeof extraction.prompt === 'string' ? extraction.prompt : '',
      keys: Array.isArray(extraction.keys) ? extraction.keys : [],
    };
    if (typeof extraction.includeToolLogs === 'boolean') cleaned.includeToolLogs = extraction.includeToolLogs;
    if (typeof extraction.inlineEnabled === 'boolean') cleaned.inlineEnabled = extraction.inlineEnabled;
    source.extraction_config = cleaned;
  }
  return writableConfigFrom(externalId, source, destination, dropped);
}
