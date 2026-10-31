import { ApiError } from './errors.js';
import {
  getAgent,
  getAgentLifecycleHooks,
  replaceInboundLifecycleHooks,
  updateAgentInbound,
  type LifecycleHookWrite,
} from '../adapter/vocobase.js';
import { readArray, readBoolean, readNumber, readRecord, readString } from './upstream.js';
import { CLEARABLE_AGENT_FIELDS, updateAgentSchema, WRITABLE_AGENT_FIELDS } from './agentPayload.js';
import { storedKeyNames } from './extractionConfig.js';

/**
 * Bringing an agent's inbound face level with its base.
 *
 * A `UNI` agent is one persona served through two upstream configurations, so
 * whenever the face may hold something the base does not — the moment a `BI`
 * agent becomes `UNI` — it is overwritten from the base. The face's config and
 * its hooks are two separate platform resources: `PUT .../inbound/config`
 * writes scalar config and leaves the hooks exactly as they were, so a copy
 * that stopped at the config left the old inbound actions running under a
 * mode whose single editor does not show them.
 */

/**
 * The inbound face's configuration, out of whatever wrapper upstream put it in.
 *
 * `?include=inbound` answers `inbound: { enabled, config }` — the face's
 * configuration is NESTED under `config`, beside the flag rather than merged
 * with it. Read flat off `inbound`, none of the fields are found, and
 * `visibleConfig` then returns a perfectly well-formed object with nothing in
 * it. That object is not `null`, so no null check on any caller can tell "this
 * face is empty" from "we read it from the wrong place" — the editor renders
 * blank boxes over a live persona, and the next Save writes them over it.
 *
 * The bare form is accepted too. The face write's response has always been
 * documented as arriving either nested or bare, so this reads both rather than
 * betting on one, and the fallback is what stops an upstream that later
 * flattens the shape from silently emptying this again.
 *
 * One definition, used by every reader of the face: the GET that serves the
 * editor, the variable union that protects the names the face declares, the
 * write's own response, and the persona preview and snapshots. Three copies of
 * this unwrap is how two of them come to disagree.
 *
 * An `inbound` block holding nothing but `enabled` is not a face. Since
 * 2026-09-10 the platform puts `inbound: { enabled }` on every agent body it
 * serializes (`toV2AgentResponse`), the face included — so the face write's
 * response, which is the face itself answered bare, carries a bare flag under
 * that key. Taken as the face, it emptied every field the editor re-baselines
 * from, and the inbound tab showed a blank persona straight after a save that
 * had landed. Returning null here lets the write's `?? updated` read the body.
 */
export function faceConfig(upstream: unknown): Record<string, unknown> | null {
  const face = readRecord(upstream, ['inbound']);
  if (!face) return null;

  const nested = readRecord(face, ['config']);
  if (nested) return nested;

  return Object.keys(face).some((key) => key !== 'enabled') ? face : null;
}

/** What a hook copy did, in the shape the routes put on their response. */
export type FaceActionsSync =
  | { inboundActionsSynced: true }
  | { inboundActionsSynced: false; inboundActionsError: string };

/**
 * One base hook, re-expressed as the face's replace-all takes it.
 *
 * The base read answers Prisma `AgentLifecycleHook` rows (Vocobase
 * `routes/v2/lifecycle-hooks.routes.ts:66-67`); the face write reads the
 * fields `hookFromBody` names (`inbound-lifecycle-hooks.routes.ts:180-196`).
 * The row's own `id`, `agentId`, `position` and timestamps are not carried —
 * position is the array order, and the rest belong to the base. A null source
 * column is left off rather than sent, because the platform requires exactly
 * one source and reads a present key as a claim to be it.
 *
 * `enabled` and `skipUnless` are carried per row: without them a hook paused
 * on the base comes back running on the face (`enabled` defaults to true
 * upstream, `:192-194`), and one that runs only when the call booked a
 * callback runs on every call.
 */
export function hookRowToFaceCopy(row: Record<string, unknown>): LifecycleHookWrite {
  const stage = (readString(row, ['stage']) ?? '').toUpperCase();
  const copy: LifecycleHookWrite = {
    stage: stage === 'POST_CALL' ? 'POST_CALL' : 'PRE_CALL',
    name: readString(row, ['name']) ?? '',
    enabled: readBoolean(row, ['enabled']) ?? true,
  };

  const toolSlug = readString(row, ['toolSlug', 'tool_slug']);
  const toolFn = readString(row, ['toolFn', 'tool_fn']);
  const functionId = readString(row, ['functionId', 'function_id']);
  if (toolSlug !== null) copy.toolSlug = toolSlug;
  if (toolFn !== null) copy.toolFn = toolFn;
  if (functionId !== null) copy.functionId = functionId;

  const input = readRecord(row, ['input']);
  if (input !== null) copy.input = input;
  const exposeAs = readString(row, ['exposeAs', 'expose_as']);
  if (exposeAs !== null) copy.exposeAs = exposeAs;
  const required = readBoolean(row, ['required']);
  if (required !== null) copy.required = required;
  const timeoutMs = readNumber(row, ['timeoutMs', 'timeout_ms']);
  if (timeoutMs !== null) copy.timeoutMs = timeoutMs;
  const skipUnless = readArray(row, ['skipUnless', 'skip_unless']);
  if (skipUnless !== null) {
    copy.skipUnless = skipUnless.filter((v): v is string => typeof v === 'string');
  }

  return copy;
}

/**
 * Replaces the face's hooks with the base's, in the base's order.
 *
 * Throws on any failure, including a base that could not be read: an unread
 * base is never turned into an empty replace-all, which would clear the face.
 * The caller decides whether that failure is fatal.
 */
export async function copyBaseHooksToFace(externalId: string): Promise<void> {
  const { hooks } = await getAgentLifecycleHooks(externalId);
  if (!Array.isArray(hooks)) {
    throw new ApiError(502, 'UPSTREAM_ERROR', "The agent's actions could not be read.");
  }
  const rows = hooks.filter(
    (row): row is Record<string, unknown> => typeof row === 'object' && row !== null,
  );
  await replaceInboundLifecycleHooks(externalId, rows.map(hookRowToFaceCopy));
}

/**
 * `copyBaseHooksToFace`, best effort: the outcome is returned for the
 * response rather than thrown, and the failure is logged.
 */
export async function syncFaceActions(externalId: string): Promise<FaceActionsSync> {
  try {
    await copyBaseHooksToFace(externalId);
    return { inboundActionsSynced: true };
  } catch (err) {
    console.error(`[agents] could not copy ${externalId}'s actions onto its inbound face:`, err);
    return {
      inboundActionsSynced: false,
      inboundActionsError:
        err instanceof ApiError
          ? err.message
          : 'The inbound actions could not be updated, so they may differ from the outbound side.',
    };
  }
}

/**
 * The agent's own configuration, shaped as a body the face will accept.
 *
 * Read from the PLATFORM rather than from `rawConfig`, which this service
 * documents as a display cache and not a source of truth. The difference
 * matters here more than anywhere else on this surface: this write replaces a
 * persona somebody wrote, and doing it from a stale snapshot would restore an
 * older prompt over a newer one with nothing on screen to say so.
 *
 * `agent_name` and `project_id` are left out — the face's name tracks its
 * parent's and its project decides the call's pricing, so upstream discards
 * both — and a field the platform did not send is omitted rather than sent as
 * null, which would clear it on the face alone.
 */
export async function baseConfigForFace(externalId: string): Promise<Record<string, unknown>> {
  const upstream = (await getAgent(externalId)) as Record<string, unknown>;
  return writableConfigFrom(externalId, upstream, 'the inbound face');
}

/**
 * One side's configuration, shaped as an overwrite of the other side.
 *
 * The body `baseConfigForFace` builds from the base, and the one keeping the
 * inbound persona builds from the face for the base: the writable fields
 * only, never `agent_name` or `project_id`, an absent clearable field sent as
 * `null` so the destination is made EQUAL rather than patched, and each value
 * parsed on its own so one the schema refuses drops that field, not the move.
 *
 * `dropped`, when given, collects every key whose value was PRESENT and
 * refused. A dropped field leaves the destination's own value standing, so a
 * caller that promised the operator "this is replaced" — keeping the inbound
 * persona, a restore — must see the list rather than a log line.
 */
export function writableConfigFrom(
  externalId: string,
  upstream: Record<string, unknown>,
  destination: string,
  dropped?: string[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  // Reserved extraction names already on the base are grandfathered, exactly
  // as they are when somebody re-saves the agent itself: these keys are not
  // being added here, they are being carried across.
  const schema = updateAgentSchema(
    storedKeyNames(readRecord(upstream, ['extraction_config', 'extractionConfig'])),
  );

  for (const key of WRITABLE_AGENT_FIELDS) {
    if (key === 'agent_name' || key === 'project_id') continue;

    /**
     * An absent key is `null` where the platform takes one.
     *
     * This is an overwrite, not a patch: the face is being made EQUAL to the
     * base. A field the base has cleared and the face has set is a divergence
     * like any other, and omitting the key would leave the face's own value
     * standing under a mode whose single editor does not show it.
     *
     * Only where a null exists, though: `prompt`, `voice_id` and the booleans
     * have none, so a base that does not carry them cannot clear the face's.
     * That is a limitation of the platform's payload rather than of this
     * function, and better stated than papered over with an invented value.
     *
     * Consulting `CLEARABLE_AGENT_FIELDS` is not redundant with the parse
     * below, which would refuse a synthesized null anyway. It keeps the two
     * reasons a field can be dropped apart — "the base has it unset and it
     * cannot be cleared" is this service's own doing, where the parse is for a
     * value the PLATFORM sent that we will not forward. Without the check the
     * second one's warning would fire on every absent boolean of every
     * transition, which is how a real warning gets learned as noise.
     */
    const value =
      upstream[key] !== undefined ? upstream[key] : CLEARABLE_AGENT_FIELDS.has(key) ? null : undefined;

    if (value === undefined) continue;

    /**
     * Validated field by field, and a refusal drops that field rather than the
     * move.
     *
     * Every other write on this surface is parsed before it is forwarded, and
     * this one was not — it handed raw upstream JSON to the adapter, against
     * this file's stated invariant that nothing unaccepted is forwarded. But
     * the body is assembled from the PLATFORM's own response rather than sent
     * by a caller, so a value the schema will not take is the platform's data,
     * not the operator's mistake: `agent_type` is documented as frequently
     * null in real data, and refusing the whole transition over it would
     * strand exactly the agents that state is common on. Parsing one key at a
     * time also means the transforms still apply — a transfer number is
     * canonicalized on the way to the face just as on the way to the base.
     */
    const parsed = schema.safeParse({ [key]: value });

    if (parsed.success) {
      Object.assign(body, parsed.data);
    } else {
      if (upstream[key] != null) dropped?.push(key);
      console.warn(
        `[agents] ${externalId}: leaving ${key} off ${destination} — the platform's own value ` +
          `is one this service does not accept: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
  }

  return body;
}

/**
 * Makes the face equal to the base: its config, then its actions.
 *
 * Both halves throw. Used where a face that is not level must not be bound to
 * anything — the inbound start — and, with the actions half softened by the
 * caller, where the move itself is the product (`PATCH .../direction`).
 */
export async function overwriteFaceWithBase(externalId: string): Promise<void> {
  await updateAgentInbound(externalId, await baseConfigForFace(externalId));
  await copyBaseHooksToFace(externalId);
}
