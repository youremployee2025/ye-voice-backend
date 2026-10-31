import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Agent } from '@prisma/client';
import { env } from '../lib/env.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { parseBody } from '../lib/validate.js';
import { accountOf } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { requireMembership, workspaceOf } from '../middleware/workspace.js';
import { endTestSession, startTestSession } from '../services/testSession.js';

/**
 * Starting and ending a browser test session against one agent.
 *
 * Open to **any member**, following the agent surface it hangs off: the
 * permission matrix already grants members "use agents, campaigns and
 * sessions", and testing an agent you are allowed to edit is not a larger act
 * than editing it. What bounds the spend is the limiter below, the balance gate
 * and the two concurrency caps — not the role, which is the right place to
 * bound it: an ADMIN looping the button would cost exactly as much.
 *
 * `:sessionId` is the **local** row id. The platform's own session id stays
 * inside this backend, the same class of upstream handle `serialize.ts` keeps
 * off the wire. The room URL and token do reach the browser, necessarily —
 * they are what the client connects to — and both are single-use and scoped to
 * one room.
 */
export const testSessionRoutes: Router = Router();

/**
 * How fast one workspace may open test sessions.
 *
 * The platform documents **ten starts a minute per key**, and the key is the
 * partner account every YE customer shares. Six leaves headroom for the rest
 * of the platform while being far more than a person testing a prompt reaches.
 *
 * Keyed on the workspace rather than the caller, for the reason `writeLimiter`
 * gives: the budget being protected belongs to the workspace, and keying on the
 * caller would let its members multiply it between them.
 */
const startLimiter = createRateLimiter({
  limit: 6,
  windowMs: 60_000,
  keyOf: (req) => workspaceOf(req).id,
});

/**
 * Pre-call variables, bounded here rather than left to the platform.
 *
 * Fifty is the ceiling the agent editor puts on an extraction key list and is
 * comfortably past what any prompt declares; the value length is generous
 * because a variable can legitimately carry a sentence. Every value must be a
 * **string** — the platform substitutes them into a prompt, and a number
 * arriving here is a client bug worth naming rather than coercing.
 */
const startBody = z.object({
  variables: z
    .record(z.string().min(1).max(64), z.string().max(1000))
    .refine((v) => Object.keys(v).length <= 50, {
      message: 'At most 50 pre-call variables may be supplied.',
    })
    .optional(),
});

async function agentInWorkspace(req: Request): Promise<Agent> {
  const agent = await prisma.agent.findFirst({
    where: { id: req.params.agentId, workspaceId: workspaceOf(req).id },
  });

  if (!agent) {
    throw new ApiError(404, 'NOT_FOUND', 'Agent not found.');
  }

  return agent;
}

testSessionRoutes.post(
  '/:workspaceId/agents/:agentId/test-session',
  requireAuth,
  requireMembership(),
  startLimiter,
  asyncHandler(async (req, res) => {
    // The agent is resolved before the body is parsed, the same order the agent
    // PATCH uses: a malformed body aimed at an invisible agent should answer
    // 404 rather than 400, or the shape of the refusal maps the id space.
    const agent = await agentInWorkspace(req);
    const { variables } = parseBody(startBody, req.body);
    const workspace = workspaceOf(req);

    const started = await startTestSession({
      workspace: { id: workspace.id, ownerAccountId: workspace.ownerAccountId },
      agent,
      startedByAccountId: accountOf(req).id,
      variables,
    });

    res.status(201).json({
      success: true,
      data: {
        id: started.id,
        room_url: started.roomUrl,
        token: started.token,
        // Returned rather than published as a build-time value, so the
        // browser's cap and this service's gate cannot drift apart.
        max_duration_secs: started.maxDurationSecs,
      },
    });
  }),
);

testSessionRoutes.post(
  '/:workspaceId/test-sessions/:sessionId/end',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    // Deliberately not rate limited beyond the app's own defaults. Refusing an
    // end is refusing to free a line the customer is being billed for, and the
    // route writes one row and calls nothing upstream.
    await endTestSession(workspaceOf(req).id, String(req.params.sessionId));

    res.status(204).end();
  }),
);

/** Exported for the tests that assert the cap is the configured one rather
 *  than a number this file invented. */
export const TEST_SESSION_MAX_SECS = env.testSessionMaxSecs;
