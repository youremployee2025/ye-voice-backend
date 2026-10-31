import { Prisma, type Agent } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { ApiError } from '../lib/errors.js';
import { agentIsUsable } from '../lib/agentVisibility.js';
import { planTestSession } from '../lib/testSessionStart.js';
import { startWebSession } from '../adapter/vocobase.js';

/**
 * Opening and releasing a browser test session.
 *
 * The Test button on the agent page: a live WebRTC call to one agent, billed by
 * the platform per minute exactly as a dial is. Everything careful in this file
 * follows from that one fact — a control that spends money needs its caps
 * enforced by the database rather than by the order two statements happen to run
 * in.
 *
 * ## Two concurrency caps, and why there are two
 *
 * **One live session per workspace**, held by a partial unique index on
 * `TestSession(workspaceId) WHERE status = 'ACTIVE'`. A counted check would let
 * two clicks through: the count and the insert are separate statements, and
 * Postgres runs READ COMMITTED, so both see zero. The index cannot.
 *
 * **`TEST_SESSION_MAX_CONCURRENT` across the whole platform**, because the
 * first cap bounds nothing that matters. Every test takes a line from the same
 * concurrency pool the dialer runs on — the platform's default allotment is
 * five — so enough workspaces testing at once would starve outbound dialing
 * with no campaign doing anything wrong and nothing on any screen saying why.
 *
 * That second one IS a counted check, and deliberately: it is a soft ceiling on
 * a shared resource rather than a per-tenant guarantee, the count runs inside
 * the same transaction as the insert, and being one over it for a moment costs
 * a queued call rather than a correctness failure. Folding it into
 * `concurrency.ts` was rejected — that module counts `CallAttempt` rows in one
 * raw claim statement on the dispatcher's hot path, and widening it to a union
 * across two tables to bound a draw already capped at two is a change to the
 * dialer to solve a problem outside it.
 */

/** The one shape both refusals for an unusable agent share. A retired agent and
 *  one that has left the workspace are the same fact to the reader — the agent
 *  cannot take calls — and the same remedy. */
function agentUnusable(): ApiError {
  return new ApiError(
    409,
    'AGENT_NOT_USABLE',
    'This agent is no longer available in this workspace and cannot take calls.',
  );
}

export interface StartedTestSession {
  /** The LOCAL row id. The platform's session id stays inside this backend. */
  id: string;
  roomUrl: string;
  token: string;
  /** Carried to the browser so its cap and this service's gate cannot drift. */
  maxDurationSecs: number;
}

/**
 * Opens one browser test session against an agent.
 *
 * Three writes, in this order and no other:
 *
 * 1. Insert `ACTIVE`, holding the slot. **Before** the platform is called, so a
 *    burst of clicks costs one upstream request rather than one per click — and
 *    so the caps are decided by the database rather than by a network race.
 * 2. `POST /sessions/webrtc`. A refusal marks the row `FAILED` and frees the
 *    slot, or one outage would lock a workspace out of testing until the reaper
 *    came round.
 * 3. Stamp the platform's session id. A session we cannot name is one we can
 *    never settle, so a failure here is reported rather than swallowed.
 */
export async function startTestSession(input: {
  workspace: { id: string; ownerAccountId: string };
  agent: Agent;
  startedByAccountId: string;
  variables?: Record<string, string>;
}): Promise<StartedTestSession> {
  const { workspace, agent, startedByAccountId } = input;

  // Re-checked here rather than trusted from the route, for the reason the
  // dialer re-resolves its agent every pass: staff unassign and sync retires
  // through UPDATEs no foreign key can see.
  if (!agentIsUsable(agent, workspace.id)) throw agentUnusable();

  const plan = await planTestSession(workspace.ownerAccountId, agent);

  const session = await prisma.$transaction(async (tx) => {
    const live = await tx.testSession.count({ where: { status: { in: ['ACTIVE'] } } });

    if (live >= env.testSessionMaxConcurrent) {
      throw new ApiError(
        409,
        'TEST_SESSION_UNAVAILABLE',
        'All test lines are busy right now. Try again in a moment.',
      );
    }

    /**
     * The balance, read inside the transaction and compared against the WHOLE
     * cap rather than one pulse.
     *
     * A session that cannot be paid for in full should not start: the browser
     * can hold the line for the entire `TEST_SESSION_MAX_SECS`, and finding out
     * at the far end — after the minutes are spent — is a shortfall rather than
     * a refusal. It makes the shortfall path in settlement unreachable except
     * under concurrent spend, which is why that path still exists.
     */
    const owner = await tx.account.findUniqueOrThrow({
      where: { id: workspace.ownerAccountId },
      select: { credits: true },
    });

    if (owner.credits < plan.maxCostCredits) {
      throw new ApiError(
        402,
        'INSUFFICIENT_CREDITS',
        'This workspace does not have enough credits to run a test. Top up to continue.',
      );
    }

    try {
      return await tx.testSession.create({
        data: {
          workspaceId: workspace.id,
          accountId: workspace.ownerAccountId,
          agentId: agent.id,
          startedByAccountId,
          status: 'ACTIVE',
          tierId: plan.tierId,
          tierSlug: plan.tierSlug,
          rateCreditsPerMin: plan.rateCreditsPerMin,
          billingIncrementSecs: plan.billingIncrementSecs,
        },
      });
    } catch (err) {
      // The partial unique index refusing a second live session. Caught rather
      // than pre-counted, because a count here would be the check-then-act the
      // index exists to make impossible.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ApiError(
          409,
          'TEST_SESSION_IN_PROGRESS',
          'A test is already running in this workspace. End it before starting another.',
        );
      }

      throw err;
    }
  });

  let started;

  try {
    started = await startWebSession({
      agent_id: agent.externalId,
      // Absent rather than `{}` when nothing was filled in: an empty object and
      // an absent key are different requests upstream.
      ...(input.variables && Object.keys(input.variables).length > 0
        ? { variables: input.variables }
        : {}),
    });
  } catch (err) {
    await release(session.id);
    throw err;
  }

  const sessionId = started.session_id;
  const roomUrl = started.daily_room_url;
  const token = started.daily_token;

  if (!sessionId || !roomUrl || !token) {
    await release(session.id);

    throw new ApiError(
      502,
      'TEST_SESSION_STARTED_UNTRACKED',
      'The test started but could not be recorded. Contact support rather than trying again.',
    );
  }

  try {
    await prisma.testSession.update({
      where: { id: session.id },
      data: { upstreamSessionId: sessionId },
    });
  } catch {
    // Retried once, then reported. The stamp is what every settlement path
    // finds this row by, so an unstamped row is a session that will be closed
    // as ABANDONED and never charged — which is worth one loud failure rather
    // than a silent one.
    try {
      await prisma.testSession.update({
        where: { id: session.id },
        data: { upstreamSessionId: sessionId },
      });
    } catch (err) {
      console.error(`[test-session] could not record session ${session.id}:`, err);
      await release(session.id);

      throw new ApiError(
        502,
        'TEST_SESSION_STARTED_UNTRACKED',
        'The test started but could not be recorded. Contact support rather than trying again.',
      );
    }
  }

  return { id: session.id, roomUrl, token, maxDurationSecs: env.testSessionMaxSecs };
}

/**
 * Marks a session that never opened `FAILED`, freeing the workspace's slot.
 *
 * Never throws: it runs on paths that are already reporting a failure, and one
 * that reported a second, different failure would tell the reader the wrong
 * thing about what went wrong.
 */
async function release(id: string): Promise<void> {
  try {
    await prisma.testSession.update({
      where: { id },
      data: { status: 'FAILED', endedAt: new Date(), resolvedAt: new Date(), chargedAt: new Date() },
    });
  } catch (err) {
    console.error(`[test-session] could not release slot for ${id}:`, err);
  }
}

/**
 * Records that the browser let go.
 *
 * Moves `ACTIVE → ENDING`, which frees the workspace's slot immediately —
 * without it, a workspace could not start a second test until the reaper came
 * round. **It charges nothing.** What a session cost is the platform's to
 * report; a route that settled on the caller's say-so would bill whatever a
 * browser claimed.
 *
 * A session belonging to another workspace, one already ended, and a
 * nonexistent id all answer the same 404 — a 403 would confirm the id names
 * something real, which is the rule every other surface here holds.
 */
export async function endTestSession(workspaceId: string, id: string): Promise<void> {
  const ended = await prisma.testSession.updateMany({
    where: { id, workspaceId, status: 'ACTIVE' },
    data: { status: 'ENDING', endedAt: new Date() },
  });

  if (ended.count === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'That test session is not running.');
  }
}
