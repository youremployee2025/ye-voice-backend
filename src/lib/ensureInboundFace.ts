import { ApiError } from './errors.js';
import { prisma } from './prisma.js';
import { getFaceDocumentSyncStatusForStart, setAgentInbound } from '../adapter/vocobase.js';
import { readNumber, readRecord } from './upstream.js';
import { overwriteFaceWithBase } from './faceMirror.js';
import { SnapshotAgentGone, takePersonaSnapshot } from './personaSnapshot.js';

/** How often the face's document sync state is re-read while it is built. */
const FACE_POLL_INTERVAL_MS = 500;
/** Wall-time bound on the wait, from the first read. Not a read count: a slow
 *  platform read must not stretch the wait past what one HTTP request holds,
 *  and each read is itself cut off at whatever is left of it. */
const FACE_POLL_DEADLINE_MS = 15_000;

const STILL_PREPARING =
  'The inbound configuration is still being prepared; try again in a minute';
const DOCUMENTS_FAILED =
  "Some of this agent's documents could not be prepared for inbound calls; " +
  're-upload them and try again';

/**
 * The agent shape this needs — exactly what `CAMPAIGN_INCLUDE` already
 * projects, so a campaign's joined agent can be passed straight in.
 */
export interface FaceableAgent {
  id: string;
  externalId: string;
  inboundEnabled: boolean;
  /** Decides whether a revived face is overwritten from the base. */
  direction: 'UNI' | 'BI';
}

/**
 * Makes sure the agent has an inbound face, creating one if it has none.
 *
 * **The face is created lazily, and this is the only place that does it on an
 * agent's behalf.** A uni-directional agent is one persona that answers as
 * readily as it dials, so whether a second upstream configuration exists is
 * plumbing rather than a product choice — but it is not free plumbing: the
 * platform deep-copies the knowledge base when a face is enabled, which is
 * why every agent does not simply get one. It is built the first time
 * something actually routes inbound to the agent, which today is exactly one
 * moment: an inbound-facing campaign starting.
 *
 * **Direction-agnostic on purpose.** A `BI` agent has a face by construction,
 * so this is a no-op for one; asking the mode here would add a second rule
 * that has to agree with `inboundEnabled` and could not be checked against it.
 * The column is the question, and it is the platform's own fact.
 *
 * The mirror is written immediately rather than left to the sync sweep. Sync
 * would get there, but every save of a `UNI` agent between now and then has to
 * write both sides, and a stale `false` would leave the new face on whatever
 * the deep copy caught while the one editor on screen said otherwise.
 *
 * A failure keeps `AGENT_INBOUND_NOT_ENABLED`, which is the code this path has
 * always answered with — its meaning moves from "turn Inbound on for this
 * agent first" to "the face could not be created or is not ready". 422 rather
 * than the 409 the surrounding start gates use: those refuse a campaign whose
 * own state is wrong, where this is a well-formed campaign whose referent the
 * platform would not build. Every refusal claims nothing.
 *
 * **The face's knowledge base is confirmed before anything is bound to it.**
 * The platform commits the face — and flips the parent's `inbound.enabled` —
 * inside the enable's own transaction, and only then queues the copied
 * documents `PENDING` (Vocobase `agentFace.service.ts:604-607`, `:616-636`).
 * So the agent read says "enabled" on the very first try, and it is the wrong
 * question: a DID bound in that window rings into a face that answers without
 * its knowledge base. The start instead reads the face's document sync state
 * (`GET /agent/:id/inbound/documents/sync-status`) every half second and
 * proceeds once `pending + syncing` is zero. A face with no documents
 * (`total` 0) is ready on the first read.
 *
 * Four refusals, all 422 `AGENT_INBOUND_NOT_ENABLED`:
 *
 * | Case | Message |
 * |---|---|
 * | the enable itself refused | the platform's sentence |
 * | still pending or syncing after fifteen seconds of wall time | "still being prepared; try again in a minute" |
 * | a read that rejected, or did not answer within the time left | the same — a platform blip is not the operator's to diagnose |
 * | settled, with `failed > 0` | "could not be prepared … re-upload them" — waiting will not fix it |
 *
 * The fifteen seconds is a true wall-clock bound: every read is raced against
 * the time remaining, so a read the platform never answers ends the wait at
 * the deadline rather than at the adapter's own timeout on top of it. Two
 * starts on the same agent both wait; the enable is idempotent upstream, so no
 * lock is needed.
 */
export async function ensureInboundFace(agent: FaceableAgent): Promise<FaceableAgent> {
  if (agent.inboundEnabled) return agent;

  try {
    await setAgentInbound(agent.externalId, true);
  } catch (err) {
    throw new ApiError(
      422,
      'AGENT_INBOUND_NOT_ENABLED',
      'This agent could not be set up to receive calls. ' +
        (err instanceof ApiError ? err.message : 'The voice platform refused the request.'),
    );
  }

  /**
   * A `UNI` agent's face is made equal to the base before anything waits on
   * it or is bound to it.
   *
   * The enable is a deep copy only when no face has ever existed. Over one
   * that was switched off it REVIVES that face unchanged, config and hooks
   * (Vocobase `agentFace.service.ts:426-438`) — and while it was off nothing
   * kept it level, because the UNI save mirror and the BI→UNI overwrite both
   * skip an agent with no live face. So without this the start would bind
   * live numbers to a persona the one editor on screen stopped showing weeks
   * ago. Config first, then actions; before the readiness wait, so the
   * numbers are bound to what the operator sees.
   *
   * Fail closed, unlike the direction route's best-effort actions copy: this
   * path is about to bind numbers, and a face that could not be brought level
   * answers them with exactly the stale persona this exists to prevent. The
   * enable is idempotent and so is the overwrite, so trying again repeats
   * both. A `BI` agent's face is its own persona and is revived as it was.
   *
   * **The revived face is saved first** (`INBOUND_START_REVIVE`). This path
   * asks nobody, so it never blocks on a diff — but what it overwrites may be
   * a persona somebody wrote, and a face that cannot be read or saved is not
   * overwritten: the start is refused with the same 422, nothing claimed.
   */
  if (agent.direction === 'UNI') {
    try {
      await takePersonaSnapshot({
        agentId: agent.id,
        externalId: agent.externalId,
        side: 'INBOUND',
        reason: 'INBOUND_START_REVIVE',
      });
    } catch (err) {
      if (err instanceof SnapshotAgentGone) {
        throw new ApiError(
          422,
          'AGENT_INBOUND_NOT_ENABLED',
          'This agent could not be set up to receive calls. The agent no longer exists.',
        );
      }
      console.error(`[inbound] could not save ${agent.externalId}'s face before overwriting it:`, err);
      throw new ApiError(
        422,
        'AGENT_INBOUND_NOT_ENABLED',
        'This agent could not be set up to receive calls. Its current inbound configuration ' +
          'could not be saved before being updated; try again.',
      );
    }

    try {
      await overwriteFaceWithBase(agent.externalId);
    } catch (err) {
      console.error(`[inbound] could not bring ${agent.externalId}'s face level with it:`, err);
      throw new ApiError(
        422,
        'AGENT_INBOUND_NOT_ENABLED',
        'This agent could not be set up to receive calls. Its inbound configuration could ' +
          'not be updated to match its outbound one; try again.',
      );
    }
  }

  await waitForInboundFace(agent.externalId);

  // `updateMany`, not `update`: the row was read at the top of the request and
  // may be gone by now. A missing row must not surface as a 500 from a missing
  // record — the face could not be set up for this agent, which is the refusal
  // this path already has, and nothing has been claimed yet. A write that fails
  // outright takes the same 422 but says so neutrally, and is logged: a
  // connection blip is not a deleted agent, and an operator told "no longer
  // exists" would go looking for one.
  let mirrored: number;
  try {
    ({ count: mirrored } = await prisma.agent.updateMany({
      where: { id: agent.id },
      data: { inboundEnabled: true },
    }));
  } catch (err) {
    console.error(`[inbound] face mirror write failed for agent ${agent.id}:`, err);
    throw new ApiError(
      422,
      'AGENT_INBOUND_NOT_ENABLED',
      'This agent could not be set up to receive calls. ' +
        'The inbound configuration could not be recorded; try again.',
    );
  }
  if (mirrored === 0) {
    throw new ApiError(
      422,
      'AGENT_INBOUND_NOT_ENABLED',
      'This agent could not be set up to receive calls. The agent no longer exists.',
    );
  }

  return { ...agent, inboundEnabled: true };
}

/** Rejects with the documented still-preparing refusal once `ms` has passed. */
function withinRemaining<T>(read: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineReached()), ms);
  });
  return Promise.race([read, expired]).finally(() => clearTimeout(timer));
}

class DeadlineReached extends Error {}

async function waitForInboundFace(externalId: string): Promise<void> {
  const started = Date.now();
  const deadline = started + FACE_POLL_DEADLINE_MS;
  let reads = 0;
  const refuse = (message: string) =>
    new ApiError(422, 'AGENT_INBOUND_NOT_ENABLED', message);

  for (;;) {
    // Always positive here: the check below the read refuses to sleep past
    // the deadline, so a read only ever begins with time left for it.
    const remaining = deadline - Date.now();

    let status: unknown;
    try {
      status = await withinRemaining(getFaceDocumentSyncStatusForStart(externalId), remaining);
    } catch (err) {
      if (err instanceof DeadlineReached) break;
      // Not a 502: the start is refused for the reason it is always refused
      // here, and the platform's failure is logged rather than shown.
      console.warn(`[inbound] face sync read failed for agent ${externalId}; start refused`, err);
      throw refuse(STILL_PREPARING);
    }
    reads += 1;

    const summary = readRecord(status, ['summary']);
    const pending = readNumber(summary, ['pending']) ?? 0;
    const syncing = readNumber(summary, ['syncing']) ?? 0;
    const failed = readNumber(summary, ['failed']) ?? 0;
    // A body with no readable summary is not a ready face: it is waited on
    // like a pending one, never read as "nothing left to sync".
    if (summary !== null && pending + syncing === 0) {
      if (failed > 0) throw refuse(DOCUMENTS_FAILED);
      return;
    }

    // Checked before the sleep, counting the sleep: no sleep is spent that
    // nothing will read after.
    if (Date.now() + FACE_POLL_INTERVAL_MS >= deadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, FACE_POLL_INTERVAL_MS));
  }
  // The one number the 422 cannot carry: how long the platform took. Logged
  // so the bound can be tuned from evidence rather than from complaints.
  console.warn(
    `[inbound] face for agent ${externalId} not ready after ${reads} reads ` +
      `over ${Date.now() - started} ms; start refused`,
  );
  throw refuse(STILL_PREPARING);
}
