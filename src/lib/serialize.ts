import { attemptReason } from './attemptReason.js';
import type {
  CallAttempt,
  Account,
  Agent,
  Campaign,
  CreditTransaction,
  PhoneNumber,
  SuperAdminAction,
  Workspace,
  WorkspaceInvite,
  WorkspaceMember,
  WorkspaceRole,
} from '@prisma/client';
import { toDisplayCredits } from './credits.js';
import { endReasonLabel, normaliseEndCallReason } from './endCallReason.js';
import { buildBilling, buildTimeline, type TimelineAttempt } from './callTimeline.js';
import { readBoolean, readNumber, readRecord, readString, readStringArray } from './upstream.js';

export function serializeAccount(account: Account) {
  return {
    id: account.id,
    email: account.email,
    name: account.name,
    imageUrl: account.imageUrl,
    isSuperAdmin: account.isSuperAdmin,
    // Display credits, through the one converter that owns the multiplier.
    //
    // This used to be a bare `.toString()`, which emitted the raw internal
    // value: the same balance came back as "5000000" here and "500" from
    // `/billing`, and the dashboard rendered both. A balance that reads
    // 10000x differently depending on which endpoint answered is the exact
    // billing dispute `credits.ts` exists to prevent, and nothing else may
    // scale a credit value.
    credits: toDisplayCredits(account.credits),
    createdAt: account.createdAt,
  };
}

/** A workspace as seen by one member — role and ownership flattened on. */
export function serializeMembership(
  workspace: Workspace,
  role: WorkspaceRole,
  accountId: string,
  superAdmin = false,
) {
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    color: workspace.color,
    role,
    isOwner: superAdmin || workspace.ownerAccountId === accountId,
    createdAt: workspace.createdAt,
  };
}

export function serializeInvite(invite: WorkspaceInvite & { workspace?: Workspace }) {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    status: invite.status,
    createdAt: invite.createdAt,
    ...(invite.workspace
      ? {
          workspace: {
            id: invite.workspace.id,
            name: invite.workspace.name,
            slug: invite.workspace.slug,
            color: invite.workspace.color,
          },
        }
      : {}),
  };
}

/**
 * An agent as a workspace sees it. `id` is the local row id — the upstream
 * agent id stays inside the backend, so nothing the dashboard holds can be
 * used to address Vocobase directly.
 */
export function serializeAgentSummary(agent: Agent) {
  return {
    id: agent.id,
    name: agent.name,
    agent_type: agent.agentType,
    // Whether this agent has an inbound face. Surfaced on the summary so the
    // campaign form can offer inbound campaigns only against agents that can
    // answer — and, per the design, offer the rest with the reason and the fix
    // rather than hiding them.
    inbound_enabled: agent.inboundEnabled,
    // What the agent is FOR, and therefore whether the dashboard edits one
    // persona or two. YE's own column, never mirrored from the platform —
    // `inbound_enabled` beside it is the platform's fact about whether a face
    // exists, and the two can legitimately disagree when staff disable a face
    // upstream directly.
    direction: agent.direction,
    status: agent.status,
    // The resolved name when the catalogue had one, else the raw voice id.
    voice: agent.voiceName ?? agent.voiceId,
    language: agent.language,
    document_count: agent.documentCount,
    last_synced_at: agent.lastSyncedAt,
  };
}

/**
 * Configuration fields the detail view is allowed to show.
 *
 * An allow-list, not a filter, and deliberately so: the cached snapshot is the
 * whole upstream record, which carries the upstream agent id and whatever
 * fields Vocobase adds next — webhook URLs, callback tokens, partner ids.
 * Passing it through would hand all of that to every workspace member the
 * moment upstream started sending it, with no code change here and no test
 * failing. Adding a field to this list is a deliberate act.
 *
 * It must also cover **every field the update payload accepts**. An editable
 * field whose current value cannot be read renders blank in a form and
 * overwrites the real value the moment someone saves — so the two lists are
 * held against each other by a test rather than by memory.
 */
export const VISIBLE_CONFIG_KEYS = [
  'timezone',
  'intro_message',
  'prompt',
  'spoken_languages',
  'enable_recording',
  'max_call_duration_secs',
  'user_idle_enabled',
  'voicemail_detection_enabled',
  'screener_handling_enabled',
  'voicemail_message',
  'transfer_enabled',
  'transfer_number',
  'transfer_destinations',
  'transfer_message',
  'transfer_instructions',
  'end_call_enabled',
  'end_call_message',
  'end_call_instructions',
  'extraction_enabled',
  'extraction_config',
  'kb_enable_llm_processing',
  'kb_llm_system_prompt',
  'project_id',
  'background_audio_id',
  'background_audio_volume',
] as const;

function visibleConfig(rawConfig: Agent['rawConfig']): Record<string, unknown> | null {
  if (typeof rawConfig !== 'object' || rawConfig === null || Array.isArray(rawConfig)) {
    return null;
  }

  const source = rawConfig as Record<string, unknown>;
  const visible: Record<string, unknown> = {};

  for (const key of VISIBLE_CONFIG_KEYS) {
    if (key in source) visible[key] = source[key];
  }

  /**
   * The two structured keys, rebuilt rather than copied.
   *
   * Emitted unconditionally — as `null` when the snapshot has neither — where
   * every scalar above is emitted only when present. Both are editable, and an
   * editable field whose current value cannot be read renders blank in a form
   * and overwrites the real value the moment someone saves. A key that is
   * sometimes absent is a key a form has to guess about.
   */
  visible.transfer_destinations = serializeTransferDestinations(source.transfer_destinations);
  visible.extraction_config = serializeExtractionConfig(source.extraction_config);

  return visible;
}

/**
 * The transfer destination catalogue, rebuilt entry by entry.
 *
 * `null` for anything that is not an array, so a corrupted or unexpected
 * snapshot reads as "no catalogue" rather than throwing on a page whose only
 * job is to show an agent. An entry that is not an object is dropped rather
 * than emitted as a hole the UI would have to render around.
 *
 * `[]` survives as `[]`: an emptied catalogue and one that was never
 * configured are different facts, and the transfer editor branches on which.
 */
function serializeTransferDestinations(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;

  return value
    .filter((entry): entry is Record<string, unknown> => isPlainObject(entry))
    .map((entry) => ({
      key: readString(entry, ['key']),
      label: readString(entry, ['label']),
      number: readString(entry, ['number']),
      llmDescription: readString(entry, ['llmDescription', 'llm_description']),
    }));
}

/**
 * The extraction config, rebuilt field by field.
 *
 * `keys` carries the customer's own field names, so their *values* cannot be
 * allow-listed — but their shape can, and is. `values` is the pinned answer
 * list and its order is meaningful, so it is filtered rather than sorted or
 * deduped here; the write path already refused a list that could not hold.
 */
function serializeExtractionConfig(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;

  const keys = Array.isArray(value.keys) ? value.keys : [];

  return {
    prompt: readString(value, ['prompt']),
    keys: keys.filter(isPlainObject).map((key) => {
      const projected: Record<string, unknown> = {
        name: readString(key, ['name']),
        type: readString(key, ['type']),
      };

      // Optional upstream, and optional here. Emitting `description: null` on
      // a key that has none would make a round trip through the editor add a
      // field the platform never held.
      const description = readString(key, ['description']);
      if (description !== null) projected.description = description;

      const analytics = readBoolean(key, ['analytics']);
      if (analytics !== null) projected.analytics = analytics;

      if (Array.isArray(key.values)) {
        projected.values = key.values.filter((entry): entry is string => typeof entry === 'string');
      }

      return projected;
    }),
    includeToolLogs: readBoolean(value, ['includeToolLogs', 'include_tool_logs']),
    inlineEnabled: readBoolean(value, ['inlineEnabled', 'inline_enabled']),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The summary plus the configuration fields a workspace may see. */
/**
 * The inbound face's live configuration, through the same allow-list the
 * outbound config uses.
 *
 * The face is a second, independent configuration on the same agent — same
 * shape, same editable fields — so it is projected the same way and carries
 * the same guarantee: a field the editor can write can be read back, and
 * nothing the platform adds next leaks by default. `null` when there is no
 * inbound config yet (the face was never enabled).
 */
export function serializeInboundConfig(inbound: unknown): Record<string, unknown> | null {
  const config = visibleConfig(inbound as Agent['rawConfig']);
  if (!config) return null;

  // `voice_id` and `variables` are editable but sit outside `visibleConfig`'s
  // scalar allow-list, exactly as `serializeAgentDetail` adds them on top of it
  // for the outbound side. An editable field that cannot be read back renders
  // blank and overwrites the real value on save, so both must be present.
  const source = inbound as Record<string, unknown>;
  return {
    ...config,
    voice_id: typeof source.voice_id === 'string' ? source.voice_id : null,
    variables: Array.isArray(source.variables) ? source.variables : [],
  };
}

export function serializeAgentDetail(agent: Agent) {
  return {
    ...serializeAgentSummary(agent),
    // Alongside `voice`, not instead of it. `voice` is the resolved *name*, for
    // display; `voice_id` is the value the update payload takes. Emitting only
    // the name meant the one writable field with a separate display form could
    // not be read back at all: a voice picker had nothing to select, so it
    // showed "Choose a voice" on an agent whose voice was named in the header
    // directly above it.
    voice_id: agent.voiceId,
    variables: agent.variables,
    config: visibleConfig(agent.rawConfig),
  };
}

/**
 * Live sub-resource projection.
 *
 * `documents`, `functions` and `tools` are proxied straight from Vocobase, so
 * they carry the same hazard `VISIBLE_CONFIG_KEYS` exists to contain — with
 * none of the protection, because a proxied row is upstream's shape rather
 * than a column set this repo chose. Passing rows through would publish the
 * upstream agent id, `connectionId`, and whatever integration fields Vocobase
 * adds next, to every workspace member, with no code change here.
 *
 * So the rows are rebuilt rather than filtered: a field absent from the spec
 * below cannot appear in the response however upstream shapes it, and a field
 * whose type changes degrades to `null` instead of passing an object through.
 * Upstream identifiers are omitted entirely — a read-only surface offers no
 * action to take on a document, so their id buys the dashboard nothing and
 * costs it the thing isolation is for.
 */
export interface VisibleField {
  /** Key emitted to the dashboard. */
  key: string;
  /** Upstream spellings in preference order. Casing is not uniform across
   *  Vocobase endpoints, so both are accepted rather than assumed. */
  from?: string[];
  read: 'string' | 'number' | 'boolean';
}

function project(row: unknown, fields: VisibleField[]): Record<string, unknown> {
  const visible: Record<string, unknown> = {};

  for (const field of fields) {
    const keys = field.from ?? [field.key];
    visible[field.key] =
      field.read === 'string'
        ? readString(row, keys)
        : field.read === 'number'
          ? readNumber(row, keys)
          : readBoolean(row, keys);
  }

  return visible;
}

/**
 * The voice catalogue, as a workspace sees it.
 *
 * `id` is emitted here, unlike every other upstream identifier on this surface,
 * because it is the value the update payload takes: a voice picker that could
 * not name its choice would be decorative. It addresses a platform-wide
 * catalogue entry rather than anything belonging to a workspace, so it leaks
 * nothing about who else is on the platform.
 */
const VOICE_FIELDS: VisibleField[] = [
  { key: 'id', read: 'string' },
  { key: 'name', from: ['display_name', 'displayName', 'name'], read: 'string' },
  // Both are platform-wide catalogue attributes. They name nothing about any
  // workspace and leak nothing about who else is on the platform — the same
  // reasoning that already lets a voice's `id` through — and the picker
  // groups by one and explains with the other.
  { key: 'description', read: 'string' },
  { key: 'language', read: 'string' },
  { key: 'gender', read: 'string' },
  /**
   * The tier band this voice belongs to. Emitted so the picker can group by
   * plan without a second request, and because a workspace that has just been
   * given a tier should be able to see which voices arrived with it.
   *
   * A slug names a platform-wide catalogue band, not anything belonging to a
   * workspace, so it leaks nothing about who else is on the platform — the
   * same reasoning that lets `id` through.
   */
  { key: 'tier', read: 'string' },
];

/**
 * The voice catalogue as a workspace sees it.
 *
 * `tierNames` maps a tier slug to the label held in the local mirror. A slug
 * the mirror does not know emits `tier_name: null` rather than the raw slug:
 * "va-1-pro" is an internal key, and printing it as though it were a product
 * name is how internal vocabulary escapes onto a customer's screen. The
 * filtering that decides which rows reach here at all happens before this —
 * see `tiersForAccount`.
 */
export function serializeVoices(
  rows: unknown[],
  tierNames: Map<string, string> = new Map(),
): Record<string, unknown>[] {
  return serializeSubResource(rows, VOICE_FIELDS).map((voice) => ({
    ...voice,
    tier_name: typeof voice.tier === 'string' ? (tierNames.get(voice.tier) ?? null) : null,
  }));
}

const DOCUMENT_FIELDS: VisibleField[] = [
  { key: 'name', from: ['name', 'file_name', 'fileName', 'title'], read: 'string' },
  { key: 'description', read: 'string' },
  { key: 'type', from: ['type', 'document_type', 'documentType'], read: 'string' },
  { key: 'status', read: 'string' },
  { key: 'file_size', from: ['file_size', 'fileSize', 'size'], read: 'number' },
  { key: 'mime_type', from: ['mime_type', 'mimeType'], read: 'string' },
];

/**
 * A knowledge-base source as the workspace sees it.
 *
 * `id` is emitted, unlike on the read-only surface this replaces: unlinking a
 * source requires naming it, and the id is useless without the mapping that
 * proves ownership — the guard, not the secrecy, is what isolates it.
 */
const AGENT_DOCUMENT_FIELDS: VisibleField[] = [
  { key: 'id', from: ['id', 'document_id', 'documentId'], read: 'string' },
  { key: 'name', from: ['name', 'file_name', 'fileName', 'title'], read: 'string' },
  { key: 'description', read: 'string' },
  { key: 'type', from: ['type', 'document_type', 'documentType'], read: 'string' },
  { key: 'status', read: 'string' },
  { key: 'file_size', from: ['file_size', 'fileSize', 'size'], read: 'number' },
  { key: 'mime_type', from: ['mime_type', 'mimeType'], read: 'string' },
  { key: 'linked_at', from: ['linked_at', 'linkedAt', 'created_at'], read: 'string' },
];

/**
 * Merges the document list with the sync-status list.
 *
 * A row whose sync state is absent reports `null`, never `"synced"`. The two
 * are not the same claim: one says the agent can read the source, the other
 * says nobody knows — and defaulting the second to the first tells the reader
 * their agent knows something it may not.
 */
export function serializeAgentDocuments(
  documents: unknown[],
  syncRows: unknown[],
  ownedIds: Set<string>,
): Record<string, unknown>[] {
  const syncById = new Map<string, unknown>();
  for (const row of syncRows) {
    const id = readString(row, ['id', 'document_id', 'documentId']);
    if (id) syncById.set(id, row);
  }

  return documents.map((row) => {
    const projected = project(row, AGENT_DOCUMENT_FIELDS);
    const id = typeof projected.id === 'string' ? projected.id : null;
    const sync = id ? syncById.get(id) : undefined;

    return {
      ...projected,
      sync_status: readString(sync, ['sync_status', 'syncStatus', 'status']),
      synced_at: readString(sync, ['synced_at', 'syncedAt']),
      sync_error: readString(sync, ['sync_error', 'syncError']),
      // Whether this workspace may detach it — see the note on the route.
      removable: id !== null && ownedIds.has(id),
    };
  });
}

/**
 * A dictionary as its owning workspace sees it.
 *
 * `id` is emitted because attaching one requires naming it; the mapping, not
 * secrecy, is what stops another workspace using it. `terms` is deliberately
 * absent from the summary — a library listing does not need every workspace's
 * word lists in it, and the detail call fetches them for the one being opened.
 */
const DICTIONARY_FIELDS: VisibleField[] = [
  { key: 'id', read: 'string' },
  { key: 'name', read: 'string' },
  { key: 'description', read: 'string' },
  { key: 'term_count', from: ['term_count', 'termCount'], read: 'number' },
  { key: 'char_count', from: ['char_count', 'charCount'], read: 'number' },
  {
    key: 'attached_agent_count',
    from: ['attached_agent_count', 'attachedAgentCount'],
    read: 'number',
  },
];

/**
 * Fields that name someone else's business, blanked on a row this workspace
 * does not own.
 *
 * An agent can be lent from one workspace to another by staff, and the pooled
 * resources attached to it do not move with it — so an agent-scoped listing
 * can genuinely contain another customer's dictionary or function. Hiding
 * those rows would misreport what the agent actually listens for and calls,
 * which is the reason these listings are not intersected. Showing them whole
 * published a function's endpoint URL — an internal address on someone else's
 * network — and a dictionary's full term list, which is a product catalogue.
 *
 * So the row stays and its identifying content goes, with `owned: false`
 * saying why. Ownership already decides what may be acted on; this makes it
 * decide what may be read as well.
 */
export function redactUnowned(
  row: Record<string, unknown>,
  owned: boolean,
  sensitive: string[],
): Record<string, unknown> {
  if (owned) return { ...row, owned: true };

  const redacted: Record<string, unknown> = { ...row, owned: false };
  for (const key of sensitive) {
    redacted[key] = Array.isArray(redacted[key]) ? [] : null;
  }
  return redacted;
}

/** A dictionary attached to an agent, with its terms withheld unless this
 *  workspace owns it. The counts stay: they are what makes the character
 *  budget add up, and they name nothing. */
export function serializeAttachedDictionaries(
  rows: unknown[],
  ownedIds: Set<string>,
): Record<string, unknown>[] {
  return serializeDictionaries(rows).map((row) =>
    redactUnowned(row, typeof row.id === 'string' && ownedIds.has(row.id), ['terms']),
  );
}

/** A function attached to an agent, with the endpoint it calls withheld unless
 *  this workspace owns it. */
export function serializeAttachedFunctions(
  rows: unknown[],
  ownedIds: Set<string>,
): Record<string, unknown>[] {
  return rows
    .map((row) => ({ ...project(row, FUNCTION_FIELDS), id: readString(row, ['id']) }))
    .map((row) =>
      redactUnowned(row, typeof row.id === 'string' && ownedIds.has(row.id), ['url', 'method']),
    );
}

export function serializeDictionaries(rows: unknown[]): Record<string, unknown>[] {
  return rows.map((row) => ({
    ...project(row, DICTIONARY_FIELDS),
    // Terms arrive only on the detail call; a summary row reports an empty
    // list rather than omitting the key, so the UI never has to branch.
    terms: readStringArray(row, ['terms']),
  }));
}

const FUNCTION_FIELDS: VisibleField[] = [
  { key: 'name', from: ['name', 'function_name', 'functionName'], read: 'string' },
  { key: 'description', read: 'string' },
  { key: 'method', from: ['method', 'http_method', 'httpMethod'], read: 'string' },
  { key: 'url', from: ['url', 'endpoint', 'endpoint_url', 'endpointUrl'], read: 'string' },
  { key: 'enabled', read: 'boolean' },
];

/**
 * A function definition as its owning workspace sees it.
 *
 * `header_keys` and no `headers`: a header **value** is write-only. It travels
 * upstream on create and update and is never returned, so there is nothing to
 * render — and a field that carried one would put a customer's API credential
 * into a browser response.
 */
const FUNCTION_DEFINITION_FIELDS: VisibleField[] = [
  { key: 'id', read: 'string' },
  { key: 'name', read: 'string' },
  { key: 'description', read: 'string' },
  { key: 'method', from: ['method', 'http_method', 'httpMethod'], read: 'string' },
  { key: 'url', read: 'string' },
  { key: 'timeout', read: 'number' },
  { key: 'error_message', from: ['error_message', 'errorMessage'], read: 'string' },
  { key: 'enabled', read: 'boolean' },
];

export function serializeFunctions(rows: unknown[]): Record<string, unknown>[] {
  return rows.map((row) => ({
    ...project(row, FUNCTION_DEFINITION_FIELDS),
    header_keys: readStringArray(row, ['header_keys', 'headerKeys']),
    started_messages: readStringArray(row, ['started_messages', 'startedMessages']),
    // Schemas are structured rather than scalar, so they are rebuilt rather
    // than read through a field spec — but still to a fixed shape, never
    // passed through.
    input_schema: readSchemaFields(row, ['input_schema', 'inputSchema']),
    output_schema: readSchemaFields(row, ['output_schema', 'outputSchema']),
  }));
}

/** An argument list, rebuilt field by field. Anything unrecognised is dropped
 *  rather than forwarded, the same rule the scalar allow-lists follow. */
function readSchemaFields(row: unknown, keys: string[]): Record<string, unknown>[] {
  const source = typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : null;
  if (!source) return [];

  for (const key of keys) {
    const value = source[key];
    if (!Array.isArray(value)) continue;

    return value.map((field) => ({
      name: readString(field, ['name']),
      type: readString(field, ['type']),
      description: readString(field, ['description']),
    }));
  }

  return [];
}

const TOOL_FIELDS: VisibleField[] = [
  { key: 'toolSlug', from: ['toolSlug', 'tool_slug'], read: 'string' },
  { key: 'toolName', from: ['toolName', 'tool_name'], read: 'string' },
  { key: 'enabled', read: 'boolean' },
  // `connectionId` is deliberately absent from the *response*. It is read
  // internally — `connectionIdOf` below — because narrowing this list to the
  // workspace's own connections is the only thing standing between one
  // customer and every other customer's connected account address. Reading it
  // to filter is required; emitting it is not, and it addresses an integration
  // record no workspace member should hold.
  // Blanked on an unowned row — see TOOL_SENSITIVE. It reads as a harmless
  // state word, but on a row this workspace does not own it is the live
  // health of another customer's connected account.
  { key: 'connectionStatus', from: ['connectionStatus', 'connection_status'], read: 'string' },
  { key: 'providerEmail', from: ['providerEmail', 'provider_email'], read: 'string' },
];

/**
 * What a tools row must give up when its connection is not this workspace's.
 *
 * Lives here, beside the allow-list it shadows, for the reason the dictionary
 * and function lists keep theirs here: a field added to `TOOL_FIELDS` for the
 * picker is added two lines above this one, where the question "and is it safe
 * on a row we are redacting?" is unavoidable. Held in a route in another file,
 * it was not.
 *
 * `connectionStatus` is on the list for the same reason `providerEmail` is.
 * It reads as a harmless state word — ACTIVE, EXPIRED — and on the
 * workspace's own row it is exactly that. On a row it does not own it is the
 * live OAuth health of another customer's connected account: a member holding
 * a lent agent could watch it flip EXPIRED → ACTIVE and know when that
 * customer reconnected. Redaction only ever touches unowned rows, so the UI
 * keeps the health signal everywhere it is entitled to one.
 */
export const TOOL_SENSITIVE = ['providerEmail', 'connectionStatus'];

/**
 * The connection an upstream tools row is bound to, or `null` for a row with
 * no connection behind it at all — a built-in like `end_call`.
 *
 * Upstream returns one row per connection in the whole partner account, not
 * per tool this agent uses, so this id is what decides whether a row belongs
 * to the caller at all.
 *
 * **No `id` fallback, deliberately.** On the *connections* surface `id` is the
 * connection's own id and reading it is right; on a *tools* row it is the row's
 * id, and a tools row is free to carry one. Falling back to it meant a built-in
 * never read as `null`, so the moment upstream added `{ id: 'tool_row_88' }`
 * the carve-out below stopped firing, the id failed to match any mapped
 * `CONNECTION`, and the workspace's own `end_call` served as `owned: false` —
 * labelled someone else's, with its switch taken away. A missing connection id
 * must stay distinguishable from an unowned one.
 */
export function connectionIdOf(row: unknown): string | null {
  return readString(row, ['connectionId', 'connection_id']);
}

/**
 * An eligible connection, as the tool picker sees it.
 *
 * `id` is emitted here and nowhere else on this surface: binding a tool to a
 * specific connection requires naming it, and the row has already been proven
 * to belong to the caller's workspace by the time it is serialized.
 */
const CONNECTION_FIELDS: VisibleField[] = [
  { key: 'id', read: 'string' },
  { key: 'toolSlug', from: ['toolSlug', 'tool_slug'], read: 'string' },
  { key: 'toolName', from: ['toolName', 'tool_name'], read: 'string' },
  { key: 'status', read: 'string' },
  { key: 'providerEmail', from: ['providerEmail', 'provider_email'], read: 'string' },
];

export function serializeConnections(rows: unknown[]): Record<string, unknown>[] {
  return serializeSubResource(rows, CONNECTION_FIELDS);
}

/**
 * A lifecycle hook — a pre-call or post-call action — as a workspace member
 * may read it.
 *
 * Rebuilt, never passed through, and in two shapes decided by `owned`.
 *
 * **An unowned row** is one staff configured against a pool connection or
 * another workspace's function. It keeps the summary it has always had: the
 * facts that describe what runs on their calls — stage, name, a source
 * *label* ("google_sheets · lookup_row"), whether a failure blocks the call,
 * which variables it supplies, and whether that list is everything the hook
 * returns (`declares_fields`) or only the part it names. The `input`
 * template and the source ids stay behind, because they name a spreadsheet
 * and a connection that are not this workspace's to read.
 *
 * **An owned row** is the workspace's own configuration, so it comes back in
 * full — `tool_slug`, `tool_fn`, `function_id`, `input`, `skip_unless`. This
 * is what the editor loads to let somebody change it, and withholding the
 * template from its author would leave a form that can only overwrite what it
 * cannot show.
 *
 * `owned` is carried on **both** shapes rather than inferred from a missing
 * `input`: a hook with an empty template and a hook that is somebody else's
 * are different facts, and a dashboard that cannot tell them apart renders
 * the second as an editable blank.
 *
 * The predicate is a required argument on purpose. It was tempting to default
 * it to "everything is owned" and let the one existing caller stay untouched;
 * that default is the unsafe one, and every future caller would have
 * inherited it silently.
 */
export function serializeLifecycleHooks(
  rows: unknown[],
  owned: (row: unknown) => boolean,
): Record<string, unknown>[] {
  return rows
    // A null, a bare string, a number: not an action. Rebuilding one into a
    // row of nulls whose `source` reads "function" asserts a fact about
    // garbage, and the surface it feeds is the one that exists to say
    // truthfully what runs around a call.
    .filter((row): row is Record<string, unknown> => isUpstreamRow(row))
    // Run order. The platform sequences on `position`, and a reader asking
    // what runs before what — or which action supplies a variable, when two
    // supply it — is answered wrongly by payload order.
    .sort(byPosition)
    .map((row) => {
    const stage = readString(row, ['stage']);
    const toolSlug = readString(row, ['toolSlug', 'tool_slug']);
    const toolFn = readString(row, ['toolFn', 'tool_fn']);

    const isOwned = owned(row);

    return {
      id: readString(row, ['id']),
      stage: stage ? stage.toLowerCase() : null,
      position: readNumber(row, ['position']),
      name: readString(row, ['name']),
      source: toolSlug ? (toolFn ? `${toolSlug} · ${toolFn}` : toolSlug) : 'function',
      expose_as: readString(row, ['exposeAs', 'expose_as']),
      supplies: hookSupplies(row, stage),
      declares_fields: hookDeclaresFields(row),
      required: readBoolean(row, ['required']),
      timeout_ms: readNumber(row, ['timeoutMs', 'timeout_ms']),
      enabled: readBoolean(row, ['enabled']),
      owned: isOwned,
      ...(isOwned
        ? {
            tool_slug: toolSlug,
            tool_fn: toolFn,
            function_id: readString(row, ['functionId', 'function_id']),
            // The template as the platform holds it. Not rebuilt field by
            // field: its shape is the source's, the catalogue of sources is
            // upstream's, and an allow-list here would silently drop the
            // input of every source added after it was written.
            input: readRecord(row, ['input']) ?? {},
            skip_unless: readStringArray(row, ['skipUnless', 'skip_unless']),
          }
        : {}),
    };
    });
}

/**
 * An upstream list entry that is a row at all.
 *
 * A null, a bare string, a number: rebuilding one of those into a row of
 * nulls asserts a fact about garbage, on surfaces whose whole job is to say
 * truthfully what an agent runs. Shared by the hook list and the tools list —
 * the tools list needs it now that "no connection id" is a real answer
 * (a built-in) rather than the thing that happened to drop malformed entries.
 */
export function isUpstreamRow(row: unknown): row is Record<string, unknown> {
  return typeof row === 'object' && row !== null && !Array.isArray(row);
}

/** Ascending by `position`; a hook the platform did not sequence sorts last,
 *  in the order it arrived. */
function byPosition(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const left = readNumber(a, ['position']);
  const right = readNumber(b, ['position']);
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

/**
 * The mapped columns of a hook's input template, if it has any.
 *
 * Read in one place because two facts on the serialized row turn on it —
 * `supplies` and `declares_fields` — and a reader that disagreed with the flag
 * qualifying it would be worse than either alone.
 */
function hookColumns(row: unknown): unknown[] {
  const input = readRecord(row, ['input']);
  return input && Array.isArray(input.columns) ? input.columns : [];
}

/**
 * Whether the hook ENUMERATES the fields it returns.
 *
 * The distinction the consumer cannot make for itself, and it decides how a
 * name missing from `supplies` reads. A sheet `lookup_row` lists its output
 * columns, so a reference to something absent from that list renders empty on
 * every call and is a genuine typo. A CRM or store lookup returns an opaque
 * upstream object under `expose_as`, so the same absence proves nothing —
 * the field may well be there at call time. Collapsing the two either way is
 * wrong: one hides real typos, the other flags every working reference.
 *
 * The column *headers* still stay behind — the flag says a list exists, not
 * what is on it, and the list names the customer sheet's layout.
 *
 * A fact about the row's configuration, so it is not gated on stage the way
 * `supplies` is: a post-call sheet append enumerates its columns too, and
 * whether that is worth asking about is what `stage` answers.
 */
function hookDeclaresFields(row: unknown): boolean {
  // An empty list is a source that enumerates and maps nothing, not an opaque
  // one — but calling it an enumeration would let the dashboard flag every
  // reference to it, so it reads as "nothing to check against".
  return hookColumns(row).length > 0;
}

/**
 * The variable names a pre-call hook feeds into the call, so the Variables
 * surface can say where a value comes from. A sheet lookup names one variable
 * per mapped column; any pre-call hook also exposes its whole result under
 * `expose_as`. The column *headers* stay behind — they name the customer
 * sheet's layout, which is the input template's business, not this row's.
 *
 * Pre-call only, and the stage argument is what enforces it. A post-call hook
 * runs after the call is over and supplies it nothing; listing its variables
 * here advertised, on the Variables surface, a value that never exists while
 * the agent is speaking. Names are de-duplicated: two columns mapped to one
 * variable is one variable, and the reader is being told what exists, not how
 * many ways the template arrives at it.
 */
function hookSupplies(row: unknown, stage: string | null): string[] {
  if (stage?.toLowerCase() !== 'pre_call') return [];

  const supplies = new Set<string>();

  for (const column of hookColumns(row)) {
    const variable = readString(column, ['variable']);
    if (variable) supplies.add(variable);
  }

  const exposeAs = readString(row, ['exposeAs', 'expose_as']);
  if (exposeAs) supplies.add(exposeAs);

  return [...supplies];
}

export const SUB_RESOURCE_FIELDS = {
  tools: TOOL_FIELDS,
} as const;

/** Rebuilds each upstream row to the allow-listed shape. */
export function serializeSubResource(
  rows: unknown[],
  fields: VisibleField[],
): Record<string, unknown>[] {
  return rows.map((row) => project(row, fields));
}

/**
 * The staff projections.
 *
 * Deliberately wider than everything above: these rows are read by the people
 * who operate the platform, and the identifiers a customer must never hold —
 * the Clerk user id, an agent's upstream id — are exactly what staff need in
 * order to match a row here against a row in another console. That width is
 * why they sit behind their own guard, and why no workspace route may reuse
 * them.
 *
 * Credit values are display strings, as everywhere: BigInt is not JSON
 * serializable and a float loses the hundredths on the one kind of value where
 * being off by one is a billing dispute.
 */

/** Staff need the upstream id — it is how an agent here is matched to the one
 *  in the voice platform's own console. */
export function serializeAgentForStaff(agent: Agent & { workspace?: Workspace | null }) {
  return {
    ...serializeAgentSummary(agent),
    external_id: agent.externalId,
    workspace: agent.workspace
      ? { id: agent.workspace.id, name: agent.workspace.name, slug: agent.workspace.slug }
      : null,
  };
}

type AccountCounts = { ownedWorkspaces: number; memberships: number };

export function serializeAccountForStaff(account: Account & { _count?: AccountCounts }) {
  return {
    id: account.id,
    clerk_user_id: account.clerkUserId,
    email: account.email,
    name: account.name,
    image_url: account.imageUrl,
    credits: toDisplayCredits(account.credits),
    is_super_admin: account.isSuperAdmin,
    // Counts come from the database rather than from measuring a loaded
    // relation: a listing that loads every workspace to call `.length` grows
    // with the platform instead of with the page.
    workspace_count: account._count?.ownedWorkspaces ?? 0,
    membership_count: account._count?.memberships ?? 0,
    created_at: account.createdAt,
  };
}

/**
 * `account` is who ACTED and `subject_account` is who it was done TO, and at
 * most one of them is ever set: a bypassed request has an actor and no
 * subject, a grant has a subject and no actor (the staff console holds one
 * shared token, so the request names nobody). A console rendering "who" must
 * read both and say which — a row with a null `account` is not a row with a
 * missing actor, it is one where naming an actor would be an invention.
 */
export function serializeSuperAdminAction(
  row: SuperAdminAction & {
    account: { id: string; email: string; name: string | null } | null;
    subjectAccount: { id: string; email: string; name: string | null } | null;
    workspace: { id: string; name: string; slug: string } | null;
  },
) {
  return {
    id: row.id,
    method: row.method,
    path: row.path,
    status: row.status,
    created_at: row.createdAt,
    account: row.account,
    subject_account: row.subjectAccount,
    workspace: row.workspace,
  };
}

type WorkspaceCounts = { members: number; agents: number; campaigns: number };

export function serializeWorkspaceForStaff(
  workspace: Workspace & { owner?: Account | null; _count?: WorkspaceCounts },
) {
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    color: workspace.color,
    owner: workspace.owner
      ? { id: workspace.owner.id, email: workspace.owner.email, name: workspace.owner.name }
      : null,
    member_count: workspace._count?.members ?? 0,
    agent_count: workspace._count?.agents ?? 0,
    campaign_count: workspace._count?.campaigns ?? 0,
    created_at: workspace.createdAt,
    // Staff see deleted workspaces; customers do not. Recovery is a staff
    // action against the database and nothing else — no trash UI, no restore
    // endpoint — so this console is the only place the fact is visible at all,
    // and a listing that cannot show it makes a deleted workspace
    // indistinguishable from a live one on the surface that exists to tell
    // them apart.
    deleted_at: workspace.deletedAt,
  };
}

/** One member row of a workspace, from the staff side: who, and with what role. */
export function serializeMemberForStaff(member: WorkspaceMember & { account: Account }) {
  return {
    id: member.id,
    role: member.role,
    joined_at: member.createdAt,
    account: {
      id: member.account.id,
      email: member.account.email,
      name: member.account.name,
    },
  };
}

/** An account's membership, seen from the account rather than the workspace. */
export function serializeMembershipForStaff(member: WorkspaceMember & { workspace: Workspace }) {
  return {
    id: member.id,
    role: member.role,
    joined_at: member.createdAt,
    is_owner: member.workspace.ownerAccountId === member.accountId,
    workspace: {
      id: member.workspace.id,
      name: member.workspace.name,
      slug: member.workspace.slug,
    },
  };
}

/** A campaign as the staff console lists it: name and state, nothing dialable. */
export function serializeCampaignForStaff(campaign: Campaign) {
  return {
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    created_at: campaign.createdAt,
  };
}

/**
 * A DID as the workspace holding it sees it.
 *
 * Credit values are decimal strings throughout: BigInt is not JSON
 * serializable, and a float would lose the hundredths the internal multiplier
 * exists to protect — on the one kind of value where that is a billing
 * dispute.
 */
export function serializePhoneNumber(number: PhoneNumber, monthlyPrice: bigint) {
  return {
    id: number.id,
    did: number.did,
    country_code: number.countryCode,
    number_type: number.numberType,
    status: number.status,
    monthly_price_credits: toDisplayCredits(monthlyPrice),
    rented_at: number.rentedAt,
    next_renewal_at: number.nextRenewalAt,
    // Non-null while a renewal charge is failing. The number still belongs to
    // this workspace and still rings; the grace window is measured from here.
    past_due_since: number.pastDueSince,
  };
}

/**
 * A DID in the shared pool.
 *
 * Deliberately narrower than the above. The pool is the one cross-workspace
 * read in this slice — every member of every workspace may see what is
 * rentable — so a row carries the number, its price, and why it is free.
 * Never a workspace id, never the provider's own id, never `rawProvider`.
 */
export function serializeAvailablePhoneNumber(number: PhoneNumber, monthlyPrice: bigint) {
  return {
    id: number.id,
    did: number.did,
    country_code: number.countryCode,
    number_type: number.numberType,
    monthly_price_credits: toDisplayCredits(monthlyPrice),
    released_for_nonpayment: number.status === 'RELEASED_NONPAYMENT',
  };
}

/**
 * One line of the ledger, for a workspace's billing history and for the staff
 * console alike.
 *
 * `phone_number` is always present because a workspace's history is mostly DID
 * charges and a missing key would read as a different kind of row. `account`
 * is present only on the global staff listing: on one account's own history,
 * repeating it on every row would say nothing.
 *
 * There is deliberately **no `balance_after`**. A running balance can only be
 * reconstructed by summing a complete contiguous series, while this list is
 * filtered — a figure derived from a subset would name a balance the account
 * was never in. Emitting one honestly needs a `balanceAfter` column written
 * inside the same transaction as the balance change.
 */
/**
 * The include every ledger read passes for its `callAttempt`.
 *
 * One constant rather than four copies of a `select`: a route that forgot a
 * column would emit `billed_secs: null` on a charge that has one, which is
 * indistinguishable from a charge written before increments existed — a
 * missing include would read as history rather than as a bug.
 */
export const LEDGER_CALL = {
  select: { durationSecs: true, billedSecs: true, billingIncrementSecs: true },
} as const;

export function serializeLedgerRow(
  row: CreditTransaction & {
    account?: Account;
    phoneNumber?: PhoneNumber | null;
    callAttempt?: Pick<CallAttempt, 'durationSecs' | 'billedSecs' | 'billingIncrementSecs'> | null;
  },
) {
  return {
    id: row.id,
    amount: toDisplayCredits(row.amount),
    type: row.type,
    reference: row.reference,
    note: row.note,
    created_at: row.createdAt,
    // Null when the DID has since been deleted — the row still records the
    // charge, which is the point of an append-only ledger.
    phone_number: row.phoneNumber
      ? { id: row.phoneNumber.id, did: row.phoneNumber.did }
      : null,
    /**
     * What the call behind this charge actually was, for the rows that are
     * calls. Null on every other kind — a grant is not a call, and an object
     * of nulls would read as a call nobody recorded.
     *
     * Read through the relation rather than copied onto the ledger row.
     * `callAttempt` is `onDelete: Restrict`, so a charge can never lose its
     * referent, and a second copy of these three facts would be a second
     * account of one call with no constraint keeping the two equal. An
     * append-only ledger exists to be audited; two disagreeing records of one
     * charge is worse than one.
     *
     * `billed_secs` and `billing_increment_secs` are null on every charge
     * settled before billing increments existed. That is NOT zero and NOT
     * "the same as the duration" — readers say the figure was not recorded.
     */
    call: row.callAttempt
      ? {
          duration_secs: row.callAttempt.durationSecs,
          billed_secs: row.callAttempt.billedSecs,
          billing_increment_secs: row.callAttempt.billingIncrementSecs,
        }
      : null,
    ...(row.account
      ? { account: { id: row.account.id, email: row.account.email, name: row.account.name } }
      : {}),
  };
}

/** Staff need the provider's own id and status — it is how a number here is
 *  matched to the one in the telephony account. */
export function serializePhoneNumberForStaff(
  number: PhoneNumber & { workspace?: Workspace | null },
  monthlyPrice: bigint,
) {
  return {
    ...serializePhoneNumber(number, monthlyPrice),
    external_id: number.externalId,
    provider: number.provider,
    provider_status: number.providerStatus,
    provider_expires_at: number.providerExpiresAt,
    last_synced_at: number.lastSyncedAt,
    /** Null when staff have not priced this DID and the global default applies. */
    price_is_default: number.monthlyPriceCredits === null,
    /**
     * What the current renter actually pays, which is not necessarily the
     * catalog price above: a rental snapshots its price, so re-pricing a DID
     * changes what the next renter pays and nothing about this one. Staff need
     * to see both or a price edit looks like it did nothing.
     */
    rented_price_credits:
      number.rentedPriceCredits === null ? null : toDisplayCredits(number.rentedPriceCredits),
    workspace: number.workspace
      ? { id: number.workspace.id, name: number.workspace.name, slug: number.workspace.slug }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Call history
// ---------------------------------------------------------------------------

/**
 * A call as a workspace sees it.
 *
 * These rows come off a partner account every workspace shares, so the
 * projection is an allow-list rather than a redaction — a field is absent
 * unless it was chosen. Four upstream fields are deliberately never emitted:
 *
 * - `client_reference_id` is where **every** integrator on the account writes
 *   its own internal ids. Echoing it verbatim hands one customer a fragment of
 *   another's CRM. It is read for campaign correlation and then dropped.
 * - `session_id`, `connection_id` and `agent_id` are upstream handles. The
 *   agent arrives as a resolved local `{ id, name }`, so nothing the dashboard
 *   holds can be used to address the voice platform directly.
 * - `provider` names the carrier that placed the call. Which supplier sits
 *   under the product is not a customer's to learn from a call log — the same
 *   rule that keeps "Vocobase" out of every message string.
 * - `credits_used` is what **this platform** was billed, not what the workspace
 *   pays. Putting it on a customer's screen publishes the margin.
 *
 * Two fields on the detail are the exception and are named here rather than
 * left to be discovered: `variables` and `extraction` are projected wholesale,
 * because their keys are the customer's own and no allow-list here could know
 * them. They are the only place upstream decides the shape of what we emit, so
 * they are bounded instead — see `bounded()`.
 */
export interface CallParties {
  agent: { id: string; name: string } | null;
  campaign: { id: string; name: string } | null;
}

/** Keys kept from a customer-shaped blob. Pre-call variables are a handful of
 *  short strings; nothing legitimate comes near this. */
const MAX_BLOB_KEYS = 100;

/** Serialized characters kept per value, for the same reason. */
const MAX_BLOB_VALUE = 4096;

/**
 * An upstream blob, bounded.
 *
 * `variables` and `extraction` are the two fields whose shape upstream decides
 * rather than this file — their keys are the customer's own, so no allow-list
 * here could name them. Left untouched they are unbounded in depth, key count
 * and length, and they land in a page that renders them as a list, which puts
 * the size of a customer's browser payload in a third party's hands.
 *
 * Structure is kept where it fits: `extraction` nests meaningfully, and
 * flattening it would cost the reader the shape of their own data. Only a
 * value too large to be anybody's real answer is replaced, and it is replaced
 * with a visibly truncated string rather than dropped, so the key still says
 * it was set.
 */
function bounded(record: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!record) return null;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record).slice(0, MAX_BLOB_KEYS)) {
    let text: string;
    try {
      text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
    } catch {
      // Circular, which upstream should never send and might.
      out[key] = '[unreadable]';
      continue;
    }

    out[key] =
      text.length <= MAX_BLOB_VALUE ? value : `${text.slice(0, MAX_BLOB_VALUE - 1)}…`;
  }

  return out;
}

export function serializeCallSummary(call: unknown, parties: CallParties) {
  return {
    id: readString(call, ['call_id', 'callId', 'id']),
    direction: readString(call, ['direction']),
    fromNumber: readString(call, ['from_number', 'fromNumber']),
    toNumber: readString(call, ['to_number', 'toNumber']),
    status: readString(call, ['status']),
    disposition: readString(call, ['disposition']),
    answeredBy: readString(call, ['answered_by', 'answeredBy']),
    // Null, never 0. Zero seconds is a call that connected and said nothing;
    // unknown is a different fact and rendering it as zero is a claim.
    durationSeconds: readNumber(call, ['duration_seconds', 'durationSeconds']),
    startedAt: readString(call, ['started_at', 'startedAt']),
    endedAt: readString(call, ['ended_at', 'endedAt']),
    agent: parties.agent,
    campaign: parties.campaign,
  };
}

export type Transcript =
  | { kind: 'turns'; turns: Array<{ role: string; content: string; timestamp: string | null }> }
  | { kind: 'unavailable'; reason: 'not_connected' | null };

/**
 * Reads the transcript field, which is not always a transcript.
 *
 * The documented shape is an array of `{ role, content, timestamp }`. In real
 * payloads it also arrives as an **object** explaining why there is no
 * conversation — `{ error, provider, terminal_reason, provider_call_id }` on a
 * call that never connected — and as `null` on one still being processed.
 *
 * The union exists so the renderer cannot conflate them. An error object
 * reaching a transcript view as `Object.entries` is a pane of carrier
 * diagnostics presented as something the customer said.
 *
 * The reason is reduced to a flag rather than passed through. Upstream's text
 * names the carrier and its internals, which is neither the customer's to read
 * nor stable enough to render.
 */
export function normalizeTranscript(value: unknown): Transcript {
  const turns = Array.isArray(value) ? value : null;

  if (turns && turns.length > 0) {
    const mapped = turns
      .map((turn) => ({
        role: readString(turn, ['role']) ?? 'unknown',
        content: readString(turn, ['content', 'text']),
        timestamp: readString(turn, ['timestamp', 'at']),
      }))
      // A turn with no words is not a turn. Kept, it renders as an empty
      // bubble that reads as a silence nobody recorded.
      .filter((turn): turn is { role: string; content: string; timestamp: string | null } =>
        turn.content !== null,
      );

    if (mapped.length > 0) return { kind: 'turns', turns: mapped };
  }

  const failure = readRecord({ value }, ['value']);
  const terminal = failure ? readString(failure, ['terminal_reason', 'terminalReason']) : null;
  const error = failure ? readString(failure, ['error']) : null;

  return { kind: 'unavailable', reason: terminal || error ? 'not_connected' : null };
}

/**
 * One call, in full.
 *
 * `attempt` is the local `CallAttempt` this platform recorded when it dialled,
 * and it is **optional because it is genuinely often absent**: an attempt row
 * exists only for a call the dialer placed for a campaign. An inbound call, a
 * hand-placed one, or one on an agent whose traffic never came through the
 * dialer has none — so `billing` is null and `timelineSource` says `none`,
 * which is what lets the surface state that rather than render an empty list.
 *
 * The attempt is fetched only after the visibility check has already passed, so
 * nothing here can widen what a caller may see.
 */
export function serializeCallDetail(
  call: unknown,
  parties: CallParties,
  attempt: TimelineAttempt | null = null,
) {
  const session = readRecord(call, ['session']);

  return {
    ...serializeCallSummary(call, parties),
    /**
     * What this workspace was charged — `CallAttempt.costCredits`, in display
     * units — and never upstream's `credits_used`, which is what the supplier
     * billed this platform and would publish the margin.
     */
    billing: buildBilling(attempt),
    /** Status transitions, oldest first. Empty when nothing recorded them. */
    timeline: buildTimeline(attempt),
    /**
     * Where the timeline came from, so an empty one is never mistaken for a
     * call that did nothing. `none` means no attempt was recorded for this
     * call, which is the ordinary case for inbound and hand-placed calls.
     */
    timelineSource: attempt ? ('attempt' as const) : ('none' as const),
    hangupCause: readString(call, ['hangup_cause', 'hangupCause']),
    hangupSource: readString(call, ['hangup_source', 'hangupSource']),
    // The platform's one-vocabulary ending, live off the detail like the two
    // deprecated fields above it, plus the words the screen prints. The token
    // travels so nothing downstream has to re-derive it; the label is null for
    // a value this service has no words for yet, and the screen hides the row.
    endCallReason: normaliseEndCallReason(readString(call, ['end_call_reason', 'endCallReason'])),
    endReason: endReasonLabel(readString(call, ['end_call_reason', 'endCallReason'])),
    billDurationSeconds: readNumber(call, ['bill_duration_seconds', 'billDurationSeconds']),
    transcript: normalizeTranscript(session ? session.transcript : null),
    // Pre-call variables the caller supplied. Absent is `{}`, matching
    // upstream, which omits the key rather than sending an empty object.
    variables: bounded(readRecord(session, ['variables'])) ?? {},
    extraction: bounded(readRecord(session, ['extraction'])),
    /**
     * Whether audio exists — not where it is. The presigned URL upstream
     * returns names the supplier's storage, outlives the caller's membership
     * by seven days, and cannot be revoked; the dashboard asks this service
     * for the bytes instead. See the recording route.
     */
    recordingAvailable: session ? readString(session, ['recording_url', 'recordingUrl']) !== null : false,
    /** False while post-call work may still populate transcript and recording,
     *  so the UI can say "still processing" rather than "none". */
    processingComplete:
      readBoolean(session, ['processing_complete', 'processingComplete']) ?? false,
  };
}

/**
 * One call attempt, for a campaign's own attempts feed.
 *
 * An **allow-list**, exactly as the calls surface's projection is and for the
 * same reason: this row carries the platform's own handles for a call, which
 * are worth nothing to a customer and a good deal to anybody assembling a
 * picture of a shared partner account.
 *
 * Never emitted:
 *
 * - `upstreamCallId` / `upstreamSessionId` — the platform's handles. The calls
 *   surface withholds exactly these two.
 * - `tierId` / `rateCreditsPerMin` — what a minute costs belongs on the
 *   billing plan card, not on every row of a feed, and a tier id is an
 *   internal key.
 * - `accountId` / `workspaceId` — resolved scoping, not payload.
 *
 * `costCredits` **is** emitted, because it is what this workspace was charged.
 * That is the opposite of the calls surface's `credits_used`, which is what
 * the platform billed YE and would publish the margin.
 */
export function serializeCallAttempt(
  attempt: CallAttempt & {
    campaignContact?: { contact: { phone: string; name: string | null } } | null;
  },
) {
  return {
    id: attempt.id,
    attempt_no: attempt.attemptNo,
    status: attempt.status,
    // Verbatim free text, all four. The dashboard renders an unrecognised
    // value as itself rather than through a list that is stale the next time a
    // carrier is added.
    disposition: attempt.disposition,
    upstream_status: attempt.upstreamStatus,
    answered_by: attempt.answeredBy,
    hangup_cause: attempt.hangupCause,
    // The cause's successor and the sentence for it; see the call detail.
    end_call_reason: attempt.endCallReason,
    end_reason: endReasonLabel(attempt.endCallReason),
    started_at: attempt.startedAt,
    answered_at: attempt.answeredAt,
    ended_at: attempt.endedAt,
    duration_secs: attempt.durationSecs,
    /**
     * What was actually charged for: the duration rounded UP to the account's
     * billing increment. Both travel, and neither substitutes for the other —
     * a row carrying only the billed figure cannot answer "why is this a
     * minute when the call was forty-seven seconds".
     *
     * Null on a call settled before increments existed, and rendered as
     * unrecorded rather than as zero or as the duration.
     */
    billed_secs: attempt.billedSecs,
    billing_increment_secs: attempt.billingIncrementSecs,
    /**
     * Null until the call is settled. On a shortfall this is what was **owed
     * and never taken**, which is why `shortfall` travels beside it rather
     * than being inferred from the number — a reader seeing only the amount
     * would conclude they had been charged.
     */
    cost_credits: attempt.costCredits === null ? null : toDisplayCredits(attempt.costCredits),
    shortfall: attempt.shortfall,
    // Why a claim never became a call. Shown because the person reading this
    // feed is the one who can act on it.
    launch_error: attempt.launchError,
    // Why a call the platform accepted produced nothing: its own `error_code`
    // and message, verbatim. Null on every dial the carrier decided.
    error_code: attempt.errorCode,
    error_message: attempt.errorMessage,
    // The one line the dashboard prints about a failure: a sentence, never a
    // code. Null when the disposition already says it all.
    failure_reason: attemptReason(attempt),
    contact: attempt.campaignContact
      ? { phone: attempt.campaignContact.contact.phone, name: attempt.campaignContact.contact.name }
      : null,
  };
}
