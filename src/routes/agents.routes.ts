import { Router, type Request } from 'express';
import type { Agent } from '@prisma/client';
import {
  createAgent,
  getAgent,
  getAgentFunctions,
  getAgentTools,
  getAvailableConnections,
  getInboundLifecycleHooks,
  listVoices,
  replaceAgentLifecycleHooks,
  replaceInboundLifecycleHooks,
  setAgentInbound,
  type LifecycleHookWrite,
  setAgentTool,
  updateAgent,
  updateAgentInbound,
} from '../adapter/vocobase.js';
import { accountOf, requireAuth } from '../middleware/auth.js';
import { requireMembership, workspaceOf } from '../middleware/workspace.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import {
  serializeAgentDetail,
  serializeAgentSummary,
  serializeInboundConfig,
  serializeAttachedFunctions,
  serializeConnections,
  isUpstreamRow,
  redactUnowned,
  serializeSubResource,
  serializeVoices,
  SUB_RESOURCE_FIELDS,
  TOOL_SENSITIVE,
} from '../lib/serialize.js';
import { assignAgent, refreshAgent, syncWorkspaceAgents } from '../services/agentSync.js';
import {
  createAgentSchema,
  updateAgentSchema,
  WRITABLE_AGENT_FIELDS,
} from '../lib/agentPayload.js';
import { storedKeyNames } from '../lib/extractionConfig.js';
import { parseBody } from '../lib/validate.js';
import { readBoolean, readRecord, readString, readStringArray } from '../lib/upstream.js';
import { filterMapped, resourceInWorkspace } from '../lib/workspaceResource.js';
import { toolOwnership } from '../lib/toolOwnership.js';
import { tiersForAccount } from '../lib/tierPricing.js';
import { z } from 'zod';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { writeLimiter } from '../lib/writeLimiter.js';
import {
  baseConfigForFace,
  faceConfig,
  hookRowToFaceCopy,
  syncFaceActions,
  writableConfigFrom,
  type FaceActionsSync,
} from '../lib/faceMirror.js';
import {
  buildDirectionPreview,
  PERSONA_SNAPSHOTS_KEPT,
  canonicalJson,
  PersonaUnreadable,
  personaConfig,
  personaFieldLabel,
  readPersona,
  readPersonas,
  restoreConfigBody,
  snapshotSummary,
  takePersonaSnapshot,
  type Persona,
  type Personas,
} from '../lib/personaSnapshot.js';

/**
 * The agent surface for a workspace.
 *
 * **Every member may edit everything here** — prompt, settings, and removal
 * from the workspace. That is a deliberate deviation from the ADMIN gate
 * campaigns, members and billing use: an agent's prompt is the working
 * material of this product, and requiring an admin to change a sentence in one
 * would push every user toward being made an admin, which is worse for every
 * other permission. The blast radius is bounded — removal returns an agent to
 * the pool rather than destroying it, and nothing here spends credits or
 * reaches another workspace. Restricting it later is one `requireMembership('ADMIN')`.
 *
 * Every handler that names an agent resolves it through `agentInWorkspace`, so
 * ownership is a precondition of holding one rather than a check a new route
 * could forget.
 */

/** `enabled` is required and must be a real boolean: a missing one would
 *  otherwise read as `false` and silently switch a working tool off. */
const setToolSchema = z.object({
  enabled: z.boolean(),
  connection_id: z.string().min(1).optional(),
});

/** One sentence, used by both orphan paths, so they cannot drift apart. */
const CREATED_UNASSIGNED_MESSAGE =
  'The agent was created but could not be added to this workspace. ' +
  'Contact support rather than trying again, or you may end up with two.';
export const agentRoutes: Router = Router();

/**
 * Resolves the agent named in the route, scoped to the caller's workspace.
 *
 * Ownership is part of the lookup rather than a check after it, so there is no
 * path where a handler holds an agent it was not entitled to. An agent that
 * belongs to another workspace, or to none, is reported exactly as one that
 * does not exist: a 403 would confirm the id is real, which is the fact
 * isolation exists to withhold.
 */
export async function agentInWorkspace(req: Request): Promise<Agent> {
  const agent = await prisma.agent.findFirst({
    where: { id: req.params.agentId, workspaceId: workspaceOf(req).id },
  });

  if (!agent) {
    throw new ApiError(404, 'NOT_FOUND', 'Agent not found.');
  }

  return agent;
}

agentRoutes.get(
  '/:workspaceId/agents',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const agents = await prisma.agent.findMany({
      where: { workspaceId: workspaceOf(req).id },
      orderBy: { name: 'asc' },
    });

    res.json({ success: true, data: agents.map(serializeAgentSummary) });
  }),
);

/**
 * A second ceiling over the cooldown in `syncWorkspaceAgents`.
 *
 * The cooldown decides whether a refresh does upstream work; this decides how
 * often a caller may ask. Without it a rejected click still costs two queries,
 * so a member holding the button down turns one workspace into a load
 * generator against the database even while every attempt is refused.
 *
 * Keyed on the workspace rather than the caller: the resource being protected
 * is the workspace's share of an upstream rate limit every customer shares, and
 * keying on the account would let a workspace's members multiply it between
 * them.
 */
/**
 * The caller's `variables`, widened to keep names it could not have known about.
 *
 * `updateAgent` is a PUT: supplying `variables` replaces the array wholesale.
 * The caller builds its list from a copy of the agent that is already old — the
 * dashboard's is the local mirror, refreshed on a fifteen-minute timer and then
 * held for as long as the page stays open — so sending it verbatim deletes
 * every name added on the platform since that copy was taken, and the
 * `refreshAgent` on the next line mirrors the truncation so nothing ever looks
 * wrong. The variable then renders as an empty string on every call, which is
 * the exact failure this whole surface exists to prevent.
 *
 * So a supplied list is a statement about what to **add**, not about what to
 * remove: it is unioned with what the platform holds right now, re-read for
 * this write. The caller's own order comes first, because those are the
 * deliberate ones; a name only upstream keeps its place after them.
 *
 * This is not the derivation that was removed from this service. Nothing here
 * reads the prompt or guesses at a name — every name in the result was either
 * sent by the caller or is already on the agent. What it refuses to do is let a
 * caller drop a name by not knowing it existed.
 *
 * Three things it deliberately does not do:
 *
 * - **An explicit `null` still clears the list.** That is the documented way to
 *   empty it, and unioning onto a clear would make it impossible to perform.
 * - **A body with no `variables` key is untouched, and costs no GET.** A
 *   prompt-only PATCH carries none, so the common edit still makes one upstream
 *   call, not two.
 * - **A failed read leaves the caller's list exactly as sent.** Falling back to
 *   an empty union is the same data loss by another route; the caller's names
 *   are at least names somebody typed. The failure is logged, because a write
 *   that silently declined to protect something is the silence this surface is
 *   built to end.
 *
 * The 100-cap is the platform's and is not enforced here: the union can only
 * exceed it if the agent was already at it, in which case the write was going
 * to be refused whatever this function returned. Truncating instead would pick
 * which of somebody's variables to delete.
 */

async function unionWithUpstreamVariables(
  externalId: string,
  body: Record<string, unknown>,
  /**
   * Which of the agent's two configurations to union against.
   *
   * The inbound face holds its own list — copied at enable and diverging from
   * the parent's from that moment — so unioning an inbound write against the
   * parent would do both halves of the damage at once: drop the names the face
   * itself declares, and import names it never did.
   */
  side: 'outbound' | 'inbound' = 'outbound',
  /**
   * Whether a face is known to exist, from the local mirror. Consulted only on
   * the inbound side, to tell the two reasons upstream hands back no `inbound`
   * record apart: the face was never enabled, or it exists and we failed to
   * read it. The first has nothing to lose — the write that follows is what
   * creates the list. The second is the truncation this function exists to
   * prevent, so it is warned about rather than passing silently.
   */
  faceExists = false,
): Promise<Record<string, unknown>> {
  if (!Array.isArray(body.variables)) return body;

  const supplied = body.variables as string[];

  let upstream: string[];
  try {
    const agent = await getAgent(externalId, { includeInbound: side === 'inbound' });

    if (side === 'inbound') {
      const face = faceConfig(agent);

      if (!face && faceExists) {
        console.warn(
          `[agents] ${externalId}'s face is enabled but upstream returned no inbound ` +
            `record; sending ${supplied.join(', ')} as given, which may drop a name the ` +
            `face declares`,
        );

        return body;
      }

      upstream = readStringArray(face, ['variables']);
    } else {
      upstream = readStringArray(agent, ['variables']);
    }
  } catch (err) {
    console.warn(
      `[agents] could not read ${externalId}'s declared variables upstream; sending ` +
        `${supplied.join(', ')} as given, which may drop a name added on the platform:`,
      err,
    );

    return body;
  }

  const seen = new Set(supplied);
  const kept = upstream.filter((name) => !seen.has(name));

  if (kept.length === 0) return body;

  console.log(
    `[agents] ${externalId}: keeping ${kept.join(', ')}, declared on the platform since ` +
      `the caller last read this agent`,
  );

  return { ...body, variables: [...supplied, ...kept] };
}

const syncLimiter = createRateLimiter({
  limit: 10,
  windowMs: 60_000,
  keyOf: (req) => workspaceOf(req).id,
});

// Registered before `/:agentId`, or Express matches the literal "sync" as an
// agent id and the route becomes unreachable.
agentRoutes.post(
  '/:workspaceId/agents/sync',
  requireAuth,
  // After membership: the limiter keys on the resolved workspace, and an
  // unauthenticated caller must not be able to spend a workspace's budget.
  requireMembership(),
  syncLimiter,
  asyncHandler(async (req, res) => {
    const result = await syncWorkspaceAgents(workspaceOf(req).id);

    res.json({ success: true, data: result });
  }),
);

/**
 * The voice catalogue, narrowed to what this workspace's plan entitles it to.
 *
 * Fetched live rather than cached: it is the platform's, changes on their
 * schedule, and a stale list would offer a voice that no longer exists. An
 * unreachable catalogue surfaces as 502 rather than as an empty list — a voice
 * picker with no options and no explanation reads as a product with no voices.
 *
 * Three rules, each failing closed:
 *
 * - **Entitlement is the workspace OWNER's**, never the caller's. Credits
 *   belong to the Account and so does the plan; an ADMIN who is not the owner
 *   would otherwise be offered voices out of their own tiers and choose one
 *   the workspace is not on. The billing card and the rent dialog resolve the
 *   owner for the same reason.
 * - **A voice with no readable tier is offered to everybody.** It sits outside
 *   the tier system, and hiding it would take voices away from a product that
 *   has been offering them.
 * - **A tier slug the local mirror does not know is not entitlement.** The
 *   comparison is against the account's assigned slugs, which come from the
 *   mirror, so an unsynced band is withheld rather than assumed.
 *
 * One upstream call, filtered here. `?tier=` exists upstream and would mean
 * one request per held tier against a partner rate limit every workspace on
 * the platform shares — to assemble a list one unfiltered request already
 * contains.
 */
agentRoutes.get(
  '/:workspaceId/voices',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const workspace = workspaceOf(req);

    const [tiers, catalogue] = await Promise.all([
      tiersForAccount(workspace.ownerAccountId),
      listVoices(),
    ]);

    const entitled = new Set(tiers.map((tier) => tier.slug));
    const names = new Map(tiers.map((tier) => [tier.slug, tier.name]));

    const rows = (Array.isArray(catalogue.voices) ? catalogue.voices : []).filter((voice) => {
      const slug = readString(voice, ['tier']);

      // No tier at all: outside the system, offered to everybody. Otherwise
      // the slug must be one this account holds.
      return slug === null || entitled.has(slug);
    });

    res.json({ success: true, data: serializeVoices(rows, names) });
  }),
);

/**
 * Create, then assign, then answer.
 *
 * The only step that can leave a trace outside this process is the upstream
 * create, so the local write that follows is a single statement and is retried
 * once. A failure after upstream returned 201 means the agent exists in the
 * shared namespace belonging to nobody — an orphan. Reporting that as a plain
 * error would tell the caller nothing happened, and they would retry and make
 * a second one; reporting success would be worse. So it gets its own code,
 * whose message says the agent was created but could not be attached.
 *
 * No compensating upstream delete is attempted. That call can fail too, and a
 * failed rollback of a failed create is strictly worse than one orphan, which
 * the staff pool listing is built to display.
 */
agentRoutes.post(
  '/:workspaceId/agents',
  requireAuth,
  // Any member, deliberately — see the permission note in CLAUDE.md.
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const parsed = parseBody(createAgentSchema, req.body);
    const workspaceId = workspaceOf(req).id;

    /**
     * Recording is on for every agent this platform creates.
     *
     * Applied here rather than on the form, because "every agent made by YE"
     * includes the ones the V2 partner API creates and the ones a script
     * creates — a default living in the dashboard would cover one caller of
     * three, and the other two would inherit whatever the platform's own
     * default happens to be that month.
     *
     * **Only when the caller was silent.** An explicit `false` is honoured, so
     * this is a default and not an override; a caller that has decided not to
     * record has decided, and the field stays editable on the agent afterwards.
     */
    const withDefaults = { enable_recording: true, ...parsed };

    // `variables` goes upstream exactly as the caller sent it, or not at all.
    // This service used to declare every `{{placeholder}}` it could find in
    // the prompt, and could not do it correctly: a name a pre-call lifecycle
    // hook already supplies must NOT be declared as a per-call variable, and
    // nothing on this path reads the agent's hooks. See CLAUDE.md.
    const upstream = await createAgent(withDefaults);

    // Every other reader on this surface accepts both spellings; this one
    // accepted only `id`, so a platform that ever answered `agent_id` would
    // orphan *every* create — reported as AGENT_CREATED_UNASSIGNED, which is
    // the one error telling people not to retry.
    const externalId = readString(upstream, ['id', 'agent_id', 'agentId']);
    if (!externalId) {
      // Nothing can be assigned or reconciled without the id upstream just
      // minted, so this is the orphan case with no id to report.
      console.error('Agent create returned no id; the upstream agent is unattached.');
      throw new ApiError(502, 'AGENT_CREATED_UNASSIGNED', CREATED_UNASSIGNED_MESSAGE);
    }

    let agent;
    try {
      agent = await assignAgent(externalId, workspaceId, upstream);
    } catch (first) {
      console.error(`Could not assign newly created agent ${externalId}; retrying.`, first);
      // A short pause first. The likeliest reasons this failed — a connection
      // pool momentarily exhausted, a failover in progress — are all still
      // true a microsecond later, so an immediate retry is barely a retry at
      // all, and the cost of being wrong here is an orphaned agent.
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        agent = await assignAgent(externalId, workspaceId, upstream);
      } catch (second) {
        console.error(`Agent ${externalId} was created upstream but is unassigned.`, second);
        throw new ApiError(502, 'AGENT_CREATED_UNASSIGNED', CREATED_UNASSIGNED_MESSAGE);
      }
    }

    res.status(201).json({ success: true, data: serializeAgentDetail(agent) });
  }),
);

/** True when `?include=` names inbound — accepts a bare value or a comma list. */
function wantsInbound(include: unknown): boolean {
  if (typeof include !== 'string') return false;
  return include.split(',').some((part) => part.trim() === 'inbound');
}

agentRoutes.get(
  '/:workspaceId/agents/:agentId',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const agent = await agentInWorkspace(req);

    // The base detail is the mirror, as always — no upstream call. Only
    // `?include=inbound` fetches the live second configuration, so an ordinary
    // agent read costs nothing extra. `inbound` is null when the face was
    // never enabled.
    if (wantsInbound(req.query.include)) {
      const upstream = await getAgent(agent.externalId, { includeInbound: true });
      const inbound = serializeInboundConfig(faceConfig(upstream));
      res.json({ success: true, data: { ...serializeAgentDetail(agent), inbound } });
      return;
    }

    res.json({ success: true, data: serializeAgentDetail(agent) });
  }),
);

/**
 * Partial update. Only the keys supplied are changed, so two people editing
 * different fields do not overwrite each other.
 *
 * The mirror is refreshed before responding rather than afterwards: the caller
 * re-reads what it just changed, and a response built from the pre-write row
 * would show the old value and read as a failed save.
 *
 * **The agent is resolved before the body is parsed**, which is the reverse of
 * the order everything else here uses, for two reasons. The update schema
 * needs the extraction key names the row already stores, so that a name the
 * platform reserves is refused when it is being *added* and accepted when the
 * agent already carries it — without which re-saving such an agent fails and
 * locks its owner out of editing anything else on it. And it means a malformed
 * body aimed at an agent the caller cannot see answers 404 rather than 400,
 * so the two errors cannot be used to sort agent ids into real and unreal.
 */
agentRoutes.patch(
  '/:workspaceId/agents/:agentId',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const agent = await agentInWorkspace(req);
    const stored = storedKeyNames(
      readRecord(agent.rawConfig, ['extraction_config', 'extractionConfig']),
    );
    const parsed = parseBody(updateAgentSchema(stored), req.body);

    // No derived `variables` here either: nothing on this path reads the
    // prompt. A list the caller DID send is unioned with the platform's own,
    // because `updateAgent` is a PUT and the caller's copy of the agent is
    // always older than this write — see `unionWithUpstreamVariables`. A
    // prompt-only PATCH carries no `variables`, so it costs no extra read and
    // cannot touch the names the agent already declares. See CLAUDE.md.
    await updateAgent(agent.externalId, await unionWithUpstreamVariables(agent.externalId, parsed));

    /**
     * Whether this write also goes to the face, and how much of it.
     *
     * `UNI` is a single persona served through two upstream configurations,
     * so the WHOLE body goes to both: one editor is on screen, and a face
     * left on an older prompt would make the agent say something nothing on
     * the page accounts for. A `UNI` agent with no face yet has nothing to
     * write to — it grows one the first time something routes inbound to it,
     * and every save from then on writes both sides.
     *
     * `BI` writes the face **not at all**, extraction included. That is the
     * mode: the two sides are edited independently, so mirroring this write
     * would silently overwrite the inbound extraction somebody had just
     * entered — a worse failure than the drift design §11 mirrors against, and
     * one they could not see coming. The drift is instead made visible on the
     * Extraction tab, which names the keys the two sides disagree on.
     */
    const mirrored = agent.inboundEnabled && agent.direction === 'UNI' ? parsed : null;

    // A failure on the inbound side must NOT roll back the outbound write (the
    // change the operator asked for did happen) and must NOT report a clean
    // success (the two sides diverged and someone has to reconcile them). So it
    // is caught, and surfaced as `inboundConfigSynced: false` with the reason.
    let inboundSync: { synced: boolean; error?: string } | undefined;
    // `agent_name` and `project_id` are stripped: the face's name tracks its
    // parent's and its project decides pricing, so upstream discards both
    // rather than applying them.
    //
    // The strip can empty the body — a rename is `{ agent_name }` and nothing
    // else — and the platform's update takes every field as optional but
    // requires at least one. So the emptied body is not sent: it would 400,
    // and the route would report `inboundConfigSynced: false` over a save that
    // carried nothing capable of diverging.
    const { agent_name: _name, project_id: _project, ...face } = mirrored ?? {};
    if (mirrored && Object.keys(face).length > 0) {
      try {
        await updateAgentInbound(
          agent.externalId,
          // `agent.inboundEnabled` is proven true by `mirrored`, and saying
          // so is what tells the two silences apart: a face that was never
          // enabled has no variable list to lose, where a face that exists and
          // could not be read is the truncation that function prevents. Left
          // to its default this write would drop the names the face declares
          // with nothing said — and a name the face does not declare is a
          // value the dial never sends on an inbound call.
          await unionWithUpstreamVariables(
            agent.externalId,
            face,
            'inbound',
            agent.inboundEnabled,
          ),
        );
        inboundSync = { synced: true };
      } catch (err) {
        console.error(`[agents] inbound sync failed for ${agent.externalId}:`, err);
        inboundSync = {
          synced: false,
          error:
            err instanceof ApiError
              ? err.message
              : 'The inbound configuration could not be updated, so it may differ from ' +
                'the outbound side.',
        };
      }
    }

    const refreshed = await refreshAgent(agent.externalId);

    res.json({
      success: true,
      data: {
        ...serializeAgentDetail(refreshed),
        ...(inboundSync
          ? {
              inboundConfigSynced: inboundSync.synced,
              ...(inboundSync.error ? { inboundConfigError: inboundSync.error } : {}),
            }
          : {}),
      },
    });
  }),
);

/**
 * How many personas the agent is edited as: `UNI` (one) or `BI` (two).
 *
 * `confirm` is YE's own, not the platform's. Nothing on this route disables a
 * face any more, so the platform's disable two-step is unreachable from here;
 * what needs confirming is `BI → UNI`, which overwrites the inbound persona
 * with the outbound one.
 *
 * A retired three-mode value is refused by this enum rather than translated.
 * The dashboard ships first and reads both vocabularies for one release, so an
 * older build may still post `BOTH` — but `OUTBOUND` and `INBOUND` both mean
 * `UNI` while differing in whether a face should exist, and quietly picking
 * one would move an agent's upstream state off a word the caller did not mean.
 */
const setDirectionSchema = z.object({
  direction: z.enum(['UNI', 'BI']),
  confirm: z.boolean().optional(),
  /**
   * Which persona survives a `BI → UNI` move. Omitted is `'outbound'`, the
   * move as it has always been. Meaningless on any other move, so it is
   * refused there rather than ignored: a caller that sent it believed
   * something would be kept.
   */
  keep: z.enum(['outbound', 'inbound']).optional(),
  /**
   * The `fingerprint` of the preview side the caller confirmed
   * (`GET .../direction/preview`). Required with `keep` whenever the two
   * sides differ; refused, like `keep`, on every other move.
   */
  fingerprint: z.string().min(1).max(128).optional(),
});

const SNAPSHOT_FAILED_MESSAGE = 'Nothing was changed: the current setup could not be saved first.';

/** A snapshot the caller could not do without: any failure refuses the overwrite. */
async function snapshotOrRefuse(args: Parameters<typeof takePersonaSnapshot>[0]): Promise<void> {
  try {
    await takePersonaSnapshot(args);
  } catch (err) {
    console.error(
      `[agents] could not snapshot ${args.externalId}'s ${args.side.toLowerCase()} side before ` +
        `an overwrite (${args.reason}); refusing it:`,
      err,
    );
    throw new ApiError(502, 'SNAPSHOT_FAILED', SNAPSHOT_FAILED_MESSAGE);
  }
}

const KEEP_INBOUND_UNREADABLE_MESSAGE =
  "This agent's inbound persona could not be read, so it cannot be kept. Nothing was changed.";

/**
 * Makes the BASE the inbound persona, ahead of the `BI → UNI` overwrite that
 * then copies the base back over the face — so both sides end as the face.
 *
 * Handed the face the route already read, compared and fingerprinted, so what
 * is written is exactly what the operator confirmed. Every refusal that needs
 * no write — no face, an unreadable one, an empty prompt — has already been
 * made by the route, before the snapshot.
 *
 * The actions go before the configuration on purpose. The base replace-all is
 * the newer platform route and the likelier to be missing or to refuse, and
 * both of those then happen while nothing has changed yet.
 *
 * **A config write that fails after the actions landed is rolled back.** Left
 * as it was, the base would run the inbound actions under the outbound prompt
 * on every live outbound call, and a retry would compare — and offer to keep —
 * that mixed persona as "outbound". So the base's own actions, from the read
 * the operator confirmed, are put back, and the move answers `KEEP_INBOUND_FAILED`
 * with nothing changed. Only when that too fails is it `KEEP_INBOUND_PARTIAL`,
 * which names the snapshot that undoes it.
 */
async function keepInboundPersona(
  agent: Agent,
  personas: Personas,
  body: Record<string, unknown>,
): Promise<void> {
  await replaceAgentLifecycleHooks(agent.externalId, personas.face.hookRows.map(hookRowToFaceCopy));

  try {
    await updateAgent(agent.externalId, await unionWithUpstreamVariables(agent.externalId, body));
  } catch (err) {
    console.error(
      `[agents] ${agent.externalId}: inbound actions moved to the base but its config was not; ` +
        'putting the outbound actions back:',
      err,
    );
    const reason = err instanceof ApiError ? ` ${err.message}` : '';
    try {
      await replaceAgentLifecycleHooks(
        agent.externalId,
        personas.base.hookRows.map(hookRowToFaceCopy),
      );
    } catch (rollbackErr) {
      console.error(`[agents] ${agent.externalId}: could not put the outbound actions back:`, rollbackErr);
      throw new ApiError(
        502,
        'KEEP_INBOUND_PARTIAL',
        "The inbound actions were moved onto the outbound side, but its configuration was not, and " +
          'the outbound actions could not be put back. The direction is unchanged. Restore the ' +
          'outbound setup saved just now from Saved setups to undo this.' +
          reason,
      );
    }
    throw new ApiError(
      502,
      'KEEP_INBOUND_FAILED',
      "The inbound persona could not be moved onto the agent, so nothing was changed." + reason,
    );
  }

  await refreshAgent(agent.externalId);
}

/**
 * Reads both sides of a `BI → UNI` move, decides whether the caller has
 * confirmed THIS diff, and saves the side about to go — all before anything
 * is written. Returns the survivor and the face as read.
 *
 * - **No default when the sides differ.** `keep` and `fingerprint` are both
 *   required, and the fingerprint must be the one this request recomputes
 *   from what the platform holds now, for that `keep`. Missing either is 409
 *   `OVERWRITE_CONFIRM_REQUIRED`; a mismatch is 409 `DIRECTION_PREVIEW_STALE`.
 *   Both carry the fresh preview in `details`. The client's copy is never
 *   trusted.
 * - **Identical sides** keep today's behaviour: `keep` defaults to
 *   `'outbound'` and no fingerprint is needed, since nothing is lost.
 * - **The snapshot is of the same read the fingerprint was checked against**,
 *   and any failure to read or save it refuses the move (502 `SNAPSHOT_FAILED`).
 *
 * `keep: 'inbound'`'s own refusals (an unreadable face, an empty prompt) keep
 * their codes and are made here too, ahead of the gate — and so is the one
 * the diff cannot show: **a face field the base will not take.** The config
 * that would be written is built here, and a field the write schema refuses
 * would be left at the base's value and then copied over the face, erasing
 * the very persona being kept. That is 422 `KEEP_INBOUND_FIELDS_REFUSED`,
 * naming the fields, with nothing written.
 *
 * Keeping inbound saves BOTH sides: the base is written over first, and the
 * face straight after from the base.
 */
async function confirmNarrowing(
  req: Request,
  agent: Agent,
  keep: 'outbound' | 'inbound' | undefined,
  fingerprint: string | undefined,
): Promise<{
  kept: 'outbound' | 'inbound';
  identical: boolean;
  personas: Personas;
  baseBody: Record<string, unknown> | null;
}> {
  let personas: Personas;
  try {
    personas = await readPersonas(agent.externalId);
  } catch (err) {
    const faceFailed = err instanceof PersonaUnreadable && err.sides.includes('INBOUND');
    if (keep === 'inbound' && faceFailed) {
      throw new ApiError(422, 'KEEP_INBOUND_UNREADABLE', KEEP_INBOUND_UNREADABLE_MESSAGE);
    }
    throw new ApiError(502, 'SNAPSHOT_FAILED', SNAPSHOT_FAILED_MESSAGE);
  }

  if (keep === 'inbound' && String(personas.face.raw.prompt).trim() === '') {
    throw new ApiError(
      422,
      'KEEP_INBOUND_EMPTY',
      "This agent's inbound persona has no prompt, so there is nothing to keep. Nothing was changed.",
    );
  }

  const preview = buildDirectionPreview(personas);

  if (!preview.identical) {
    if (keep === undefined || fingerprint === undefined) {
      throw new ApiError(
        409,
        'OVERWRITE_CONFIRM_REQUIRED',
        "This agent's outbound and inbound setups differ. Choose which one to keep, and confirm " +
          'what will be replaced.',
        preview,
      );
    }
    const expected = keep === 'inbound' ? preview.keep_inbound : preview.keep_outbound;
    if (fingerprint !== expected.fingerprint) {
      throw new ApiError(
        409,
        'DIRECTION_PREVIEW_STALE',
        'This agent changed since the comparison was made. Review the new comparison and ' +
          'confirm again.',
        preview,
      );
    }
  }

  const kept = keep ?? 'outbound';

  let baseBody: Record<string, unknown> | null = null;
  if (kept === 'inbound' && !preview.identical) {
    const dropped: string[] = [];
    baseBody = writableConfigFrom(agent.externalId, personas.face.raw, 'the agent', dropped);
    // A dropped field leaves the base's value standing; that loses something
    // only when the base's value is not already the face's. The platform
    // stores "no language picked" as `[]`, which this service's schema
    // refuses, on both sides of most agents — refusing over that blocked a
    // move that would have lost nothing.
    const baseProjection = personaConfig(personas.base.raw);
    const faceProjection = personaConfig(personas.face.raw);
    const lost = dropped.filter(
      (key) => canonicalJson(baseProjection[key]) !== canonicalJson(faceProjection[key]),
    );
    if (lost.length > 0) {
      const fields = lost.map(personaFieldLabel);
      throw new ApiError(
        422,
        'KEEP_INBOUND_FIELDS_REFUSED',
        `The inbound persona cannot be kept whole: ${fields.join(', ')} ` +
          `${fields.length === 1 ? 'holds a value' : 'hold values'} the outbound side does not accept. ` +
          'Fix them on the inbound tab first. Nothing was changed.',
        { fields },
      );
    }
  }

  const reason = kept === 'outbound' ? 'DIRECTION_UNI_KEEP_OUTBOUND' : 'DIRECTION_UNI_KEEP_INBOUND';
  if (kept === 'inbound') {
    await snapshotOrRefuse({
      agentId: agent.id,
      externalId: agent.externalId,
      side: 'OUTBOUND',
      reason,
      takenByUserId: accountOf(req).id,
      persona: personas.base,
    });
  }
  await snapshotOrRefuse({
    agentId: agent.id,
    externalId: agent.externalId,
    side: 'INBOUND',
    reason,
    takenByUserId: accountOf(req).id,
    persona: personas.face,
  });

  return { kept, identical: preview.identical, personas, baseBody };
}

/**
 * What a `BI → UNI` move would replace, for either choice of survivor.
 *
 * Read live — the base (`getAgent`), the face (`getAgent(…, { includeInbound:
 * true })`), and both hook lists — never from the mirror, because what is
 * being confirmed is exactly what the platform holds now. The answer is
 * `buildDirectionPreview`'s: `identical`, and per choice the fields and
 * actions it replaces plus the fingerprint `PATCH .../direction` must be sent
 * back with. It writes nothing.
 *
 * Only a `BI` agent with a live face has two sides; anything else is a 409
 * `VALIDATION_ERROR`, and a side that cannot be read is a 502 rather than a
 * diff against nothing.
 */
agentRoutes.get(
  '/:workspaceId/agents/:agentId/direction/preview',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const agent = await agentInWorkspace(req);

    if (req.query.to !== 'UNI') {
      throw new ApiError(400, 'VALIDATION_ERROR', 'to must be UNI: only that move replaces a persona.');
    }
    if (agent.direction !== 'BI' || !agent.inboundEnabled) {
      throw new ApiError(
        409,
        'VALIDATION_ERROR',
        'Only a bi-directional agent with an inbound setup has two sides to compare.',
      );
    }

    let personas: Personas;
    try {
      personas = await readPersonas(agent.externalId);
    } catch {
      throw new ApiError(502, 'UPSTREAM_ERROR', "This agent's current setup could not be read.");
    }

    res.json({ success: true, data: buildDirectionPreview(personas) });
  }),
);

/**
 * Moves an agent between one persona and two, doing whatever that costs
 * upstream.
 *
 * The column is YE's and the face is the platform's, so a move is at most one
 * act — and **never a disable**, which is the property that collapses six
 * moves into two:
 *
 * | From → To | Upstream | Confirmed |
 * |---|---|---|
 * | `UNI` → `BI` | with no live face, enable one and write the base's config and actions over it (a revived face comes back unchanged, so the enable alone is not a copy); otherwise nothing, since they already match and simply stop being kept so | no |
 * | `BI` → `UNI` | write the base config over the face, then replace its actions with the base's (best effort, `inboundActionsSynced`), if a face exists; with `keep: 'inbound'`, first make the base the face (`keepInboundPersona`) | **yes** |
 *
 * **Nothing here ever turns a face off.** Numbers stay linked, inbound
 * campaigns keep running, and turning an agent bi-directional and back loses
 * nothing but the inbound edits the confirm warns about — so the platform's
 * `CONFIRM_REQUIRED` two-step, which guards a disable, is unreachable from
 * this route and its passthrough branch is gone. The `confirm` this route asks
 * for is YE's own and guards the overwrite instead.
 *
 * **The confirm is not gated on a face existing.** A `BI` agent whose face
 * staff turned off upstream is still asked, because otherwise the dialog
 * appears or not according to a platform fact the operator did not change and
 * cannot see. Asking when nothing would be lost costs a click; not asking when
 * something would be costs somebody's inbound persona.
 *
 * **The column moves only after the upstream act succeeds.** A mode saying
 * `BI` over a face that was never enabled offers an editor for a configuration
 * that does not exist.
 *
 * A member may do this, matching the deliberate agent-surface deviation the
 * rest of this file documents.
 */
agentRoutes.patch(
  '/:workspaceId/agents/:agentId/direction',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const agent = await agentInWorkspace(req);
    const { direction, confirm, keep, fingerprint } = parseBody(setDirectionSchema, req.body);

    // Before the no-op return: a UNI agent asked to stay UNI "keeping inbound"
    // was sent by a caller who believed a persona would be chosen.
    const narrowing = agent.direction === 'BI' && direction === 'UNI';
    if ((keep !== undefined || fingerprint !== undefined) && !narrowing) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        'keep and fingerprint choose which persona survives making a bi-directional agent ' +
          'uni-directional, and apply to no other change.',
      );
    }

    if (direction === agent.direction) {
      res.json({ success: true, data: serializeAgentDetail(agent) });
      return;
    }

    /**
     * `BI → UNI` is the one move that destroys something a person wrote: the
     * two personas become one, and the outbound one wins. So it is the one
     * move that asks first — before any upstream act, so a refusal leaves the
     * platform exactly as it was.
     *
     * YE's code, not the platform's passthrough: the shape is the same one
     * the dashboard already renders for an inbound disable, and `details`
     * names what would be lost rather than the numbers a disable would
     * unlink, because no number is unlinked here.
     */
    if (direction === 'UNI' && !confirm) {
      throw new ApiError(
        409,
        'CONFIRM_REQUIRED',
        'Making this agent uni-directional replaces its inbound persona with its outbound ' +
          'one. The inbound configuration is overwritten and cannot be recovered.',
        { overwrites: 'inbound' },
      );
    }

    // Going bi-directional needs a second configuration to exist, and both
    // sides must START identical. Over a face that is on there is nothing to
    // do: this UNI agent's saves have been writing both sides, so all that
    // changes is that this service stops keeping them so. With no live face
    // the enable runs — idempotent upstream, and no `confirm`, since this is
    // not a disable — and it is a deep copy of the base ONLY when no face has
    // ever existed. Over one that was switched off it revives that face
    // unchanged, config and hooks (Vocobase `agentFace.service.ts:426-438`):
    // whatever persona it held before this agent stopped being kept level with
    // it. So the base is written over it either way — config, then actions.
    // The config write is fatal, as on the way back down, and the actions copy
    // is best effort and flagged.
    let actionsSync: FaceActionsSync | undefined;
    if (direction === 'BI' && !agent.inboundEnabled) {
      await setAgentInbound(agent.externalId, true);
      // The enable has revived whatever the face held; save it before the
      // base goes over it. A face that cannot be saved is not overwritten.
      await snapshotOrRefuse({
        agentId: agent.id,
        externalId: agent.externalId,
        side: 'INBOUND',
        reason: 'DIRECTION_BI_REVIVE',
        takenByUserId: accountOf(req).id,
      });
      await updateAgentInbound(agent.externalId, await baseConfigForFace(agent.externalId));
      actionsSync = await syncFaceActions(agent.externalId);
    }

    // Coming back to one persona writes the base over the face, which is what
    // the confirm above warned about. Skipped when there is no face: a `BI`
    // agent whose face staff turned off upstream has nothing to overwrite, and
    // this route does not create one on the way DOWN — a uni-directional agent
    // gets a face only when something actually routes inbound to it.
    //
    // The config write does not touch the face's hooks, so they are replaced
    // with the base's too — otherwise the old inbound actions keep running
    // under a mode whose one editor does not show them. Best effort, like the
    // UNI save mirror: the persona was overwritten and the move goes ahead, and
    // a failed copy rides on the response as `inboundActionsSynced: false`.
    let kept: 'outbound' | 'inbound' | undefined;
    if (narrowing && agent.inboundEnabled) {
      const confirmed = await confirmNarrowing(req, agent, keep, fingerprint);
      kept = confirmed.kept;
      // Identical sides: the base already is the inbound persona.
      if (confirmed.baseBody) await keepInboundPersona(agent, confirmed.personas, confirmed.baseBody);
    } else if (narrowing) {
      // No live face: nothing to compare, save or keep.
      if (keep === 'inbound') {
        throw new ApiError(422, 'KEEP_INBOUND_UNREADABLE', 'This agent has no inbound persona to keep.');
      }
      kept = 'outbound';
    }

    if (direction === 'UNI' && agent.inboundEnabled) {
      await updateAgentInbound(agent.externalId, await baseConfigForFace(agent.externalId));
      actionsSync = await syncFaceActions(agent.externalId);
    }

    /**
     * Conditional on the mode this request decided from.
     *
     * Every branch above was chosen from the row read at the top of the
     * handler, and an unconditional write would let a second move that landed
     * in the meantime be overwritten by a decision taken before it existed.
     * A `BI → UNI` overwrite and a `UNI → BI` enable can interleave so that the
     * column says `BI` while the face has just been written over with the base
     * — two personas on record, one of them silently erased — and nothing
     * would detect or repair it.
     *
     * The loser is told rather than silently retried: the upstream half of its
     * move may well have happened, so what it should do next depends on where
     * the agent actually ended up.
     */
    const moved = await prisma.agent.updateMany({
      where: { id: agent.id, direction: agent.direction },
      data: { direction },
    });

    if (moved.count === 0) {
      throw new ApiError(
        409,
        'DIRECTION_CHANGED',
        'This agent\'s direction was changed by someone else while this was in flight. ' +
          'Re-read the agent and try again.',
      );
    }

    const refreshed = await refreshAgent(agent.externalId);

    res.json({
      success: true,
      data: { ...serializeAgentDetail(refreshed), ...actionsSync, ...(kept ? { kept } : {}) },
    });
  }),
);

/**
 * The saved sides of this agent's persona, newest first.
 *
 * Scoped to the snapshots taken while the agent was THIS workspace's
 * (`workspaceId` at snapshot time), not merely to the agent: an agent is lent
 * and moves between workspaces, and a snapshot taken before it moved holds
 * the previous tenant's prompt and actions — spreadsheet ids, function ids —
 * which must not follow it. A foreign agent 404s through `agentInWorkspace`.
 *
 * `taken_by` is the account's name, or its email, when one took it; an
 * automatic path (an inbound start) records nobody and answers `null`.
 */
agentRoutes.get(
  '/:workspaceId/agents/:agentId/persona-snapshots',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const agent = await agentInWorkspace(req);

    const rows = await prisma.agentPersonaSnapshot.findMany({
      where: { agentId: agent.id, workspaceId: workspaceOf(req).id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // Both sides are pruned to this many, so this is every row there is.
      take: PERSONA_SNAPSHOTS_KEPT * 2,
    });

    const takerIds = [...new Set(rows.map((r) => r.takenByUserId).filter((id): id is string => !!id))];
    const takers = new Map(
      (
        await prisma.account.findMany({
          where: { id: { in: takerIds } },
          select: { id: true, name: true, email: true },
        })
      ).map((a) => [a.id, a.name || a.email]),
    );

    res.json({
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        side: row.side,
        reason: row.reason,
        created_at: row.createdAt.toISOString(),
        taken_by: (row.takenByUserId && takers.get(row.takenByUserId)) || null,
        summary: snapshotSummary(row.config, row.hooks),
      })),
    });
  }),
);

/** A hook write that must not fail the config write before it: its outcome, not its error. */
async function hooksOutcome(
  write: () => Promise<unknown>,
  what: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await write();
    return { ok: true };
  } catch (err) {
    console.error(`[agents] could not restore ${what}:`, err);
    const error =
      err instanceof ApiError
        ? err.message
        : 'The actions could not be restored, so they may still differ from the saved setup.';
    return { ok: false, error };
  }
}

/**
 * Puts one saved side back.
 *
 * **The side's current state is saved first** (`RESTORE`), so a restore can
 * itself be undone, and one that cannot be saved does not happen (502
 * `SNAPSHOT_FAILED`). That save never prunes the snapshot being restored, so
 * a restore the platform then refuses can be tried again. On a `UNI` agent
 * with a face, an OUTBOUND restore also writes the face, so the face is saved
 * too.
 *
 * | Side | First | Then | And |
 * |---|---|---|---|
 * | `INBOUND` | `updateAgentInbound` (fatal) | the face replace-all, best effort (`inboundActionsSynced`) | needs a `BI` agent with a live face, else 409 `RESTORE_NEEDS_BI` |
 * | `OUTBOUND` | `replaceAgentLifecycleHooks` (fatal, nothing else written: 501 `RESTORE_UNAVAILABLE` / 502 `RESTORE_FAILED`) | `updateAgent` (502 `RESTORE_PARTIAL`) | on a `UNI` agent with a face, the face is re-synced as a UNI save does |
 *
 * The OUTBOUND order is the reverse of the INBOUND one because the base
 * replace-all is the newer platform route: until it is live everywhere, a
 * config-first restore would bring back the prompt and never the actions,
 * and report that as done.
 *
 * `notRestored` names every saved field the write schema refused. Such a
 * field keeps its current value, and the operator is told so rather than
 * handed a "restored" that is not.
 *
 * Variables are unioned with the platform's own list, the rule every write of
 * them follows here: a restore brings the saved names back and drops none
 * added since.
 *
 * A snapshot of another workspace's agent — or of this agent from before it
 * came to this workspace — is a 404.
 */
agentRoutes.post(
  '/:workspaceId/agents/:agentId/persona-snapshots/:snapshotId/restore',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const agent = await agentInWorkspace(req);

    const snapshot = await prisma.agentPersonaSnapshot.findFirst({
      where: { id: req.params.snapshotId, agentId: agent.id, workspaceId: workspaceOf(req).id },
    });
    if (!snapshot) throw new ApiError(404, 'NOT_FOUND', 'Snapshot not found.');

    if (snapshot.side === 'INBOUND' && !(agent.direction === 'BI' && agent.inboundEnabled)) {
      throw new ApiError(
        409,
        'RESTORE_NEEDS_BI',
        'Make this agent bi-directional first, then restore its inbound setup.',
      );
    }

    const mirrorsFace = snapshot.side === 'OUTBOUND' && agent.direction === 'UNI' && agent.inboundEnabled;

    // Read once: saved as the RESTORE snapshot, and compared against below.
    let current: Persona;
    try {
      current = await readPersona(agent.externalId, snapshot.side);
    } catch (err) {
      console.error(`[agents] could not read ${agent.externalId}'s ${snapshot.side} side to restore:`, err);
      throw new ApiError(502, 'SNAPSHOT_FAILED', SNAPSHOT_FAILED_MESSAGE);
    }

    await snapshotOrRefuse({
      agentId: agent.id,
      externalId: agent.externalId,
      side: snapshot.side,
      reason: 'RESTORE',
      takenByUserId: accountOf(req).id,
      keepId: snapshot.id,
      persona: current,
    });
    if (mirrorsFace) {
      await snapshotOrRefuse({
        agentId: agent.id,
        externalId: agent.externalId,
        side: 'INBOUND',
        reason: 'RESTORE',
        takenByUserId: accountOf(req).id,
      });
    }

    const hooks = (Array.isArray(snapshot.hooks) ? snapshot.hooks : []) as unknown as LifecycleHookWrite[];
    const dropped: string[] = [];
    let flags: Record<string, unknown> = {};

    if (snapshot.side === 'INBOUND') {
      const body = restoreConfigBody(agent.externalId, snapshot.config, 'the inbound face', dropped);
      await updateAgentInbound(
        agent.externalId,
        await unionWithUpstreamVariables(agent.externalId, body, 'inbound', true),
      );
      const outcome = await hooksOutcome(
        () => replaceInboundLifecycleHooks(agent.externalId, hooks),
        `${agent.externalId}'s inbound actions`,
      );
      flags = outcome.ok
        ? { inboundActionsSynced: true }
        : { inboundActionsSynced: false, inboundActionsError: outcome.error };
    } else {
      const body = restoreConfigBody(agent.externalId, snapshot.config, 'the agent', dropped);
      try {
        await replaceAgentLifecycleHooks(agent.externalId, hooks);
      } catch (err) {
        console.error(`[agents] could not restore ${agent.externalId}'s actions:`, err);
        if (err instanceof ApiError && err.code === 'KEEP_INBOUND_UNAVAILABLE') {
          throw new ApiError(
            501,
            'RESTORE_UNAVAILABLE',
            'Restoring the outbound setup needs a platform update that is not live yet. Nothing was changed.',
          );
        }
        throw new ApiError(
          502,
          'RESTORE_FAILED',
          'The saved actions could not be restored, so nothing was changed.' +
            (err instanceof ApiError ? ` ${err.message}` : ''),
        );
      }
      try {
        await updateAgent(agent.externalId, await unionWithUpstreamVariables(agent.externalId, body));
      } catch (err) {
        console.error(`[agents] actions restored but config not, for ${agent.externalId}:`, err);
        throw new ApiError(
          502,
          'RESTORE_PARTIAL',
          'The saved actions were restored, but the configuration was not. Try the restore again.' +
            (err instanceof ApiError ? ` ${err.message}` : ''),
        );
      }
      flags = { actionsRestored: true };

      if (mirrorsFace) {
        try {
          await updateAgentInbound(
            agent.externalId,
            await unionWithUpstreamVariables(agent.externalId, body, 'inbound', true),
          );
          flags.inboundConfigSynced = true;
        } catch (err) {
          console.error(`[agents] inbound sync failed restoring ${agent.externalId}:`, err);
          flags.inboundConfigSynced = false;
          flags.inboundConfigError =
            err instanceof ApiError
              ? err.message
              : 'The inbound configuration could not be updated, so it may differ from the ' +
                'outbound side.';
        }
        Object.assign(flags, await syncFaceActions(agent.externalId));
      }
    }

    const refreshed = await refreshAgent(agent.externalId);

    res.json({
      success: true,
      data: {
        ...serializeAgentDetail(refreshed),
        restored: { id: snapshot.id, side: snapshot.side },
        // Only a refused field whose saved value the side does not already hold.
        notRestored: dropped
          .filter((key) => {
            const saved = (snapshot.config as Record<string, unknown> | null)?.[key];
            return canonicalJson(personaConfig(current.raw)[key]) !== canonicalJson(saved ?? null);
          })
          .map(personaFieldLabel),
        ...flags,
      },
    });
  }),
);

/** `enabled` is required and strict: a missing one must not read as `false`
 *  and silently turn the inbound face off. `confirm` is the disable two-step. */
const setInboundSchema = z.object({
  enabled: z.boolean(),
  confirm: z.boolean().optional(),
});

/**
 * Turns the agent's inbound face on or off.
 *
 * A member may do this, matching the deliberate agent-surface deviation the
 * rest of this file documents. Enabling deep-copies the outbound configuration
 * upstream and is idempotent; disabling is a two-step confirm, and the platform
 * answers `CONFIRM_REQUIRED` with a `details` payload naming the numbers and
 * campaigns a disable would unlink — passed straight through by the adapter and
 * emitted by the error handler as a sibling of `error`.
 *
 * The mirror is refreshed before responding, like the agent PATCH above, so the
 * caller re-reads the state it just changed rather than the pre-write row.
 */
agentRoutes.patch(
  '/:workspaceId/agents/:agentId/inbound',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const agent = await agentInWorkspace(req);
    const { enabled, confirm } = parseBody(setInboundSchema, req.body);

    await setAgentInbound(agent.externalId, enabled, confirm);
    const refreshed = await refreshAgent(agent.externalId);

    res.json({ success: true, data: serializeAgentDetail(refreshed) });
  }),
);

/**
 * Writes the inbound face's configuration.
 *
 * The inbound config takes the same body as an outbound update, so the schema
 * is reused unchanged — including the extraction-key validation, keyed off the
 * names the mirror already stores. `agent_name` and `project_id` are accepted
 * and discarded upstream, so they are stripped here rather than sent: the
 * inbound face has no name or project of its own to set.
 *
 * Called before the face is enabled, the platform answers 404
 * `INBOUND_NOT_ENABLED`, passed through by the adapter rather than dressed up
 * as a missing agent.
 */
agentRoutes.put(
  '/:workspaceId/agents/:agentId/inbound/config',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const agent = await agentInWorkspace(req);
    const stored = storedKeyNames(
      readRecord(agent.rawConfig, ['extraction_config', 'extractionConfig']),
    );
    const parsed = parseBody(updateAgentSchema(stored), req.body);

    const { agent_name: _agentName, project_id: _projectId, ...payload } = parsed;
    const updated = await updateAgentInbound(
      agent.externalId,
      await unionWithUpstreamVariables(agent.externalId, payload, 'inbound', agent.inboundEnabled),
    );

    // The updated inbound config, projected through the same allow-list the
    // read uses. Upstream may return it bare or nested under `inbound`; accept
    // either so the response is the config the editor re-reads.
    const config = serializeInboundConfig(faceConfig(updated) ?? updated);
    res.json({ success: true, data: config });
  }),
);

/**
 * Removes the agent from this workspace. **Not** a delete.
 *
 * The mapping is cleared and the agent returns to the unassigned pool; the
 * upstream agent survives, along with every call that references it. Real
 * deletion is a staff act behind a confirm token, because a workspace cannot
 * know whether an agent it was lent is used elsewhere.
 *
 * Blocked while a campaign in *this* workspace still names the agent. Counted
 * rather than left to a foreign key: `Campaign.agentId` carries no constraint
 * yet, and a guard that only works once one exists is not a guard. It also
 * produces a message naming the campaigns, which a constraint violation
 * cannot.
 */
agentRoutes.delete(
  '/:workspaceId/agents/:agentId',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const agent = await agentInWorkspace(req);
    const workspaceId = workspaceOf(req).id;

    /**
     * The check and the write in one transaction.
     *
     * `Campaign.agentId` is deliberately not a relation, so the guard cannot be
     * expressed as a condition on the update and has to be a read followed by a
     * write. Run separately those two are a check-then-act: a campaign can take
     * the agent in between, and the workspace ends up with a campaign naming an
     * agent it no longer holds — the exact state the 409 exists to prevent,
     * reached by two ordinary requests overlapping.
     *
     * Scoped to this workspace, as before: another workspace's campaign naming
     * the same agent is not this caller's business and must not block them.
     */
    await prisma.$transaction(async (tx) => {
      const blocking = await tx.campaign.findMany({
        where: { workspaceId, agentId: agent.id },
        select: { name: true },
        orderBy: { name: 'asc' },
        take: 5,
      });

      if (blocking.length > 0) {
        throw new ApiError(
          409,
          'AGENT_IN_USE',
          `This agent is used by ${blocking.map((campaign) => campaign.name).join(', ')}. ` +
            'Change those campaigns first.',
        );
      }

      await tx.agent.update({ where: { id: agent.id }, data: { workspaceId: null } });
    });

    res.json({ success: true, data: { removed: true } });
  }),
);

/**
 * Documents, functions and tools are fetched live rather than cached: they
 * change independently of the agent record, and a stale integration list is
 * more misleading than a slow one.
 *
 * Each is written out rather than generated from a shared helper. All three
 * now merge per-row ownership into the response — which of these rows this
 * workspace owns, and what may be read of the ones it does not — and that is
 * not something a generic proxy can do. A helper that only fits the case none
 * of them are any more is a helper that has to be worked around.
 */

/**
 * The functions attached to this agent.
 *
 * Deliberately not a `liveCollection`. An agent is lent between workspaces by
 * staff and its attached functions do not move with it, so this list can hold
 * a function another customer defined — and `FUNCTION_FIELDS` carries `url`,
 * which is an address on that customer's own network, the very thing the
 * function *library* listing is intersected to protect.
 *
 * The row is not hidden: doing so would misreport what the agent can actually
 * call, and this list is how a reader finds that out. The endpoint is withheld
 * instead, and the row says `owned: false` so the UI can explain why rather
 * than render a blank that reads as a fault.
 */
agentRoutes.get(
  '/:workspaceId/agents/:agentId/functions',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const agent = await agentInWorkspace(req);
    const { functions } = await getAgentFunctions(agent.externalId);
    const rows = Array.isArray(functions) ? functions : [];

    const owned = await prisma.workspaceResource.findMany({
      where: {
        kind: 'FUNCTION',
        workspaceId: workspaceOf(req).id,
        externalId: { in: rows.map((row) => readString(row, ['id']) ?? '').filter(Boolean) },
      },
      select: { externalId: true },
    });

    res.json({
      success: true,
      data: serializeAttachedFunctions(rows, new Set(owned.map((row) => row.externalId))),
    });
  }),
);

/**
 * Refuses a write against a tool binding this workspace does not own.
 *
 * The two checks in the handler below guard the body — a named connection,
 * and an enable with none named. Neither fires on `{ enabled: false }`, so
 * until this existed the only thing stopping a member from switching off an
 * YE-managed binding was the dashboard declining to draw the switch: a
 * server-side rule enforced in the browser, and one that stops being enforced
 * at all the moment this backend ships ahead of the matching dashboard.
 *
 * Ownership is resolved through the same predicate the listing renders from,
 * so the read cannot promise a control the write refuses, or the reverse.
 *
 * Only *bound* rows are protected. An unbound row is not this workspace's
 * anything yet — enabling one is the `connection_id` path, which is already
 * checked — and a slug upstream does not know is left to upstream to reject.
 * A slug can arrive several times, one row per connection in the partner
 * account; the workspace's own binding being among them is what makes the
 * write theirs to make.
 */
async function requireOwnedBinding(
  externalId: string,
  slug: string,
  workspaceId: string,
): Promise<void> {
  const { tools } = await getAgentTools(externalId);
  const rows = Array.isArray(tools) ? tools : [];
  const bound = rows.filter(
    (row) =>
      readString(row, ['toolSlug', 'tool_slug']) === slug &&
      readBoolean(row, ['enabled']) === true,
  );

  if (bound.length === 0) return;

  const isOwned = await toolOwnership(bound, workspaceId);
  if (bound.some(isOwned)) return;

  // Deliberately the 404 every other unowned-resource refusal answers, and
  // deliberately not a message explaining that the binding exists but belongs
  // elsewhere: that a connection for this tool exists on the partner account
  // is exactly the fact a workspace without one must not be able to learn.
  throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Not found.');
}

/**
 * Tools, narrowed to the connections this workspace owns.
 *
 * Deliberately not a `liveCollection`: upstream returns one row per connection
 * in the **whole partner account**, with the connected account's email address
 * on each, regardless of which agent was asked about. Proxying that — which is
 * what this route used to do — served every workspace the integration owners
 * of every other workspace. The rows are intersected with mapped `CONNECTION`
 * resources before anything is serialized.
 *
 * A workspace with nothing mapped sees an empty list of *candidates*. That is
 * the correct answer, not an error: it cannot connect an integration itself,
 * so there is genuinely nothing to configure until staff map one.
 *
 * A tool that is **enabled on this agent** is different. The agent really
 * does call it on every call, and this list is how a reader finds that out —
 * hiding the row because the connection is unmapped misreported the agent as
 * having no integrations at all. So bound rows follow the rule the attached
 * function and dictionary listings follow: the row stays, the identifying
 * content goes. An unowned binding is serialized with `providerEmail`
 * withheld and `owned: false`, so the UI can explain the row is managed by
 * YE rather than render a blank that reads as a fault.
 */
agentRoutes.get(
  '/:workspaceId/agents/:agentId/tools',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const agent = await agentInWorkspace(req);
    const { tools } = await getAgentTools(agent.externalId);
    // Entries that are not rows are dropped before anything else looks at
    // them. A null or a bare string used to fall out of the connection
    // intersect by accident; now that "no connection id" is a real answer —
    // a built-in — garbage would otherwise serialize into a row of nulls
    // carrying a switch.
    const rows = (Array.isArray(tools) ? tools : []).filter(isUpstreamRow);
    const isOwned = await toolOwnership(rows, workspaceOf(req).id);

    // A row is shown when the agent actually calls it, or when it is the
    // workspace's to attach. Both halves of that second clause matter: a
    // connection this workspace owns, **or no connection at all**. A built-in
    // — end_call, transfer — has nothing to intersect with, so intersecting
    // dropped it the moment it was switched off, and the control that
    // switched it off was the last one able to switch it back on.
    const visible = rows.filter((row) => readBoolean(row, ['enabled']) === true || isOwned(row));

    // One pass, one serializer, one redaction — including for the rows that
    // are always owned. Hand-rolling `{ ...row, owned: true }` for those
    // coincided with `redactUnowned` only for as long as nobody added a field
    // to both `TOOL_FIELDS` and `TOOL_SENSITIVE`.
    res.json({
      success: true,
      data: serializeSubResource(visible, SUB_RESOURCE_FIELDS.tools).map((row, index) =>
        redactUnowned(row, isOwned(visible[index]), TOOL_SENSITIVE),
      ),
    });
  }),
);

/**
 * The connections a tool may be bound to, narrowed the same way.
 */
agentRoutes.get(
  '/:workspaceId/agents/:agentId/available-connections',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const agent = await agentInWorkspace(req);
    const { connections } = await getAvailableConnections(agent.externalId);

    const visible = await filterMapped(
      Array.isArray(connections) ? connections : [],
      'CONNECTION',
      workspaceOf(req).id,
      (row) => readString(row, ['id']),
    );

    res.json({ success: true, data: serializeConnections(visible) });
  }),
);

/**
 * Enables or disables one tool on this agent.
 *
 * When a connection is named it must be one this workspace owns — checked
 * here, before the upstream call, so a probe for another workspace's
 * connection never reaches the platform and never binds anything.
 *
 * **Enabling without naming one is refused.** Omitting `connection_id` lets
 * upstream fall back to its own default, and that default is chosen from the
 * partner account — a namespace holding every other workspace's OAuth
 * connections. A workspace with nothing mapped could therefore switch a tool
 * on and have the platform bind it to another customer's connected mailbox,
 * without ever naming an id this backend could have checked. Disabling has no
 * such reach and stays allowed on its own — **on a binding this workspace
 * owns**. A tool already bound to another workspace's connection is refused
 * whatever the body says, including the plain `{ enabled: false }` that names
 * nothing: the row is YE-managed, and read-only rendering in a dashboard is
 * not where that is decided.
 */
agentRoutes.put(
  '/:workspaceId/agents/:agentId/tools/:slug',
  requireAuth,
  requireMembership(),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(setToolSchema, req.body);
    const agent = await agentInWorkspace(req);

    if (body.connection_id) {
      await resourceInWorkspace('CONNECTION', body.connection_id, workspaceOf(req).id);
    } else if (body.enabled) {
      // Deliberately the same 404 an unowned connection gets rather than a
      // message explaining the default: which tools the partner account has a
      // connection for is exactly the fact a workspace with none of its own
      // must not be able to learn.
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        'connection_id is required to enable a tool. ' +
          'Choose one of this workspace\'s connections.',
      );
    }

    await requireOwnedBinding(agent.externalId, req.params.slug, workspaceOf(req).id);

    const result = await setAgentTool(agent.externalId, req.params.slug, body);

    res.json({
      success: true,
      data: { enabled: readBoolean(result, ['enabled']) ?? body.enabled },
    });
  }),
);
