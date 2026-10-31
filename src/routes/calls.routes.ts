import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { fetchRecording, getCallRecordingUrl } from '../adapter/vocobase.js';
import { parseCallQuery } from '../lib/callQuery.js';
import { env } from '../lib/env.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { signRecordingToken, verifyRecordingToken } from '../lib/recordingToken.js';
import { readString } from '../lib/upstream.js';
import { requireAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { requireMembership, workspaceOf } from '../middleware/workspace.js';
import {
  findCallForRecording,
  getWorkspaceCall,
  listWorkspaceCalls,
} from '../services/callHistory.js';

/**
 * Read-only call history for a workspace.
 *
 * There is no write route here and no admin gate. Nothing on this surface can
 * cause a call — it renders what already happened — and nothing in a call's
 * record is sensitive to a MEMBER that an ADMIN should see instead.
 *
 * `:callId` is the **upstream** call id, which departs from the agents surface
 * where the local row id is on the wire and the platform's id stays inside the
 * backend. There is no mirror table here, so there is no local id to use; the
 * upstream id is the only handle that exists. It is an opaque UUID, useless
 * without the partner key, and every handler re-derives visibility from it
 * rather than trusting the caller obtained it from us.
 */
export const callRoutes: Router = Router();

/**
 * A per-workspace ceiling on the listing.
 *
 * One list request can read up to twenty upstream pages, against a rate limit
 * every workspace on the partner account shares. Without this, one reader
 * holding refresh spends everybody's budget.
 *
 * Keyed on the workspace rather than the caller, for the same reason the agent
 * sync limiter is: the resource protected is the workspace's share of a shared
 * limit, and keying on the account would let its members multiply it between
 * them.
 */
const listLimiter = createRateLimiter({
  limit: env.callListRateLimitMax,
  windowMs: 60_000,
  keyOf: (req) => workspaceOf(req).id,
});

/**
 * The single-call routes, which are cheap individually and not in a loop.
 *
 * Each spends one upstream read, against the same shared limit — so leaving
 * them open while capping the listing just moves the cheapest way to exhaust
 * it. Higher than the listing because one read is not twenty, and because a
 * reader opening rows in a busy list legitimately makes a lot of these.
 */
const detailLimiter = createRateLimiter({
  limit: env.callDetailRateLimitMax,
  windowMs: 60_000,
  keyOf: (req) => workspaceOf(req).id,
});

/**
 * Playback, keyed on the **path's** workspace.
 *
 * `workspaceOf` is unavailable here: a token-authenticated request resolved no
 * membership, and this route is deliberately reachable without a session. The
 * path parameter is the same value the token was checked against, so it is not
 * a caller's to choose freely.
 *
 * The ceiling is high because seeking is bursty — a player scrubbing a long
 * recording issues a run of Range requests in a second, and every one of them
 * is a legitimate request that must not be refused.
 *
 * All three limiters, like every other in this service, count in-process: with
 * N instances behind a load balancer the real ceiling is N x limit. That was an
 * acceptable trade for staff endpoints and is a weaker one here, on customer
 * traffic. A shared counter is the change to make, and it belongs in the
 * limiter rather than in this file.
 */
const recordingLimiter = createRateLimiter({
  limit: env.callRecordingRateLimitMax,
  windowMs: 60_000,
  keyOf: (req) => req.params.workspaceId,
});

/**
 * Resolves a filter that names a local resource, inside this workspace only.
 *
 * Absent is fine — the filter simply is not applied. An id that names nothing
 * *here* is a 404, never an empty list: answering "no calls match" for a real
 * id from another workspace and for pure nonsense alike sounds identical today,
 * but the first would start returning rows the moment that resource moved,
 * which makes the filter an existence oracle. The same rule the campaign and
 * agent surfaces already hold.
 */
async function assertFilterInWorkspace(
  workspaceId: string,
  agentId: string | null,
  campaignId: string | null,
): Promise<void> {
  if (agentId) {
    const agent = await prisma.agent.findFirst({
      where: { id: agentId, workspaceId },
      select: { id: true },
    });
    if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent not found.');
  }

  if (campaignId) {
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, workspaceId },
      select: { id: true },
    });
    if (!campaign) throw new ApiError(404, 'NOT_FOUND', 'Campaign not found.');
  }
}

callRoutes.get(
  '/:workspaceId/calls',
  requireAuth,
  // After membership: the limiter keys on the resolved workspace, and an
  // unauthenticated caller must not be able to spend a workspace's budget.
  requireMembership(),
  listLimiter,
  asyncHandler(async (req, res) => {
    const workspace = workspaceOf(req);
    const query = parseCallQuery(req.query as Record<string, unknown>);

    await assertFilterInWorkspace(workspace.id, query.agentId, query.campaignId);

    res.json({ success: true, data: await listWorkspaceCalls(workspace.id, query) });
  }),
);

callRoutes.get(
  '/:workspaceId/calls/:callId',
  requireAuth,
  requireMembership(),
  detailLimiter,
  asyncHandler(async (req, res) => {
    const call = await getWorkspaceCall(workspaceOf(req).id, req.params.callId);

    res.json({ success: true, data: call });
  }),
);

/**
 * Mints a token an `<audio>` element can carry, after proving the caller may
 * hear this recording.
 *
 * The visibility check happens **here**, before anything is signed. A token
 * minted without it would authenticate a request for somebody else's audio,
 * which is the whole failure this endpoint could introduce.
 *
 * Registered before `/:callId` cannot matter — the paths differ in depth — but
 * it is grouped with the recording route because the two are one feature.
 */
callRoutes.get(
  '/:workspaceId/calls/:callId/recording-token',
  requireAuth,
  requireMembership(),
  detailLimiter,
  asyncHandler(async (req, res) => {
    const workspace = workspaceOf(req);
    const call = await findCallForRecording(workspace.id, req.params.callId);

    const session = (call as { session?: unknown }).session;
    if (!readString(session, ['recording_url', 'recordingUrl'])) {
      throw new ApiError(404, 'RECORDING_NOT_AVAILABLE', 'There is no recording for this call.');
    }

    if (!env.recordingTokenSecret) {
      // Unconfigured is not "allowed": no secret means no valid token, and
      // saying so beats minting one that will be refused a moment later.
      //
      // Logged, because this is the one failure on this surface that is ours
      // rather than the platform's, and nothing else would ever say so —
      // ApiError is not logged by the error handler, so an unset secret would
      // otherwise present to everyone as recordings quietly never playing.
      console.error('RECORDING_TOKEN_SECRET is not set; recording playback is disabled.');
      throw new ApiError(
        502,
        'UPSTREAM_ERROR',
        'Recording playback is not configured on this service.',
      );
    }

    res.json({
      success: true,
      data: {
        token: signRecordingToken(
          { workspaceId: workspace.id, callId: req.params.callId },
          env.recordingTokenSecret,
        ),
        expiresIn: 120,
      },
    });
  }),
);

/**
 * Authenticates a recording request by `?token=`, as an alternative to the
 * session header a media element cannot send.
 *
 * It authenticates only. The handler still decides whether the call is this
 * workspace's, on every request, so a token never stands in for that — and a
 * call that leaves the workspace between minting and playing is refused. But
 * that check resolves the workspace's agents and campaigns and asks nothing
 * about the workspace itself, so the liveness `requireMembership` enforces on
 * every other route has to be enforced here too: this is the one
 * workspace-scoped route a request can reach without passing through it.
 *
 * The token names the workspace and the call it was minted for, and both must
 * match the path, so one recording's token cannot be pointed at another.
 */
function requireMembershipOrRecordingToken(): RequestHandler {
  return (req, res, next) => {
    const token = req.query.token;

    if (typeof token !== 'string' || token === '') {
      // No token: fall through to the ordinary session guards.
      requireAuth(req, res, (err?: unknown) => {
        if (err) return next(err);
        requireMembership()(req, res, next);
      });
      return;
    }

    void (async () => {
      const claims = verifyRecordingToken(token, env.recordingTokenSecret);

      if (
        !claims ||
        claims.workspaceId !== req.params.workspaceId ||
        claims.callId !== req.params.callId
      ) {
        throw new ApiError(401, 'UNAUTHORIZED', 'This recording link is invalid or has expired.');
      }

      // A token minted a moment before the workspace was deleted would
      // otherwise go on streaming audio for the rest of its two minutes.
      // Refused in the words an expired token gets: a link for a deleted
      // workspace must not be distinguishable from a stale one, which is the
      // same indistinguishability the claims check above maintains.
      const workspace = await prisma.workspace.findUnique({
        where: { id: claims.workspaceId },
        select: { deletedAt: true },
      });

      if (!workspace || workspace.deletedAt) {
        throw new ApiError(401, 'UNAUTHORIZED', 'This recording link is invalid or has expired.');
      }

      next();
    })().catch(next);
  };
}

/** Headers worth mirroring back. Everything else upstream sends is its own. */
const PASSTHROUGH_HEADERS = ['content-length', 'content-range'] as const;

/**
 * The content type, narrowed to something that is safe to serve from here.
 *
 * Object storage returns whatever type was set when the object was uploaded,
 * and this route serves from **this API's own origin** — reachable by direct
 * navigation, since the token rides in the query string. Forwarding an
 * arbitrary type would let a stored object decide how the browser treats
 * bytes coming from us. Audio is what this route is for; anything else is
 * served as an opaque download rather than refused, because a recording with
 * an odd type is still the customer's recording.
 */
function safeContentType(upstream: string | null): string {
  return upstream && /^audio\//i.test(upstream) ? upstream : 'application/octet-stream';
}

/**
 * Streams a call's recording through this service.
 *
 * A redirect to the presigned URL would be less code and is wrong three ways.
 * The URL names the supplier's storage, and which supplier sits under the
 * product is not a customer's to learn from a surface we control. It stays
 * valid for seven days and carries no notion of workspace membership, so once
 * forwarded it plays for a week to anyone holding it, long after the person who
 * obtained it left the workspace. And it cannot be revoked. Proxying keeps
 * every play inside the membership guard.
 *
 * The body is piped, never buffered — a recording is an hour of audio and this
 * process has other work to do.
 */
callRoutes.get(
  '/:workspaceId/calls/:callId/recording',
  requireMembershipOrRecordingToken(),
  recordingLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    // The path's workspace, not `workspaceOf(req)`: a token-authenticated
    // request resolved no membership. The token was checked against this same
    // parameter, and the visibility check below is what actually guards the
    // audio — so a probe for another workspace's recording never becomes a
    // request for it.
    const call = await findCallForRecording(req.params.workspaceId, req.params.callId);

    const session = (call as { session?: unknown }).session;
    if (!readString(session, ['recording_url', 'recordingUrl'])) {
      // Distinct from NOT_FOUND: the call is theirs and they may see it, there
      // is simply no audio. Conflating the two would have the dashboard report
      // a missing recording as a missing call.
      throw new ApiError(
        404,
        'RECORDING_NOT_AVAILABLE',
        'There is no recording for this call.',
      );
    }

    // Minted fresh rather than reusing the URL on the call: the one attached to
    // a detail response may be up to seven days old and already expired.
    const minted = await getCallRecordingUrl(req.params.callId);
    const url = minted.recording_url;
    if (!url) {
      throw new ApiError(404, 'RECORDING_NOT_AVAILABLE', 'There is no recording for this call.');
    }

    const range = req.headers.range;
    const upstream = await fetchRecording(url, typeof range === 'string' ? range : undefined);

    if (!upstream.ok && upstream.status !== 206) {
      // The signature was refused or the object is gone. The caller needs to
      // know the platform could not serve it — not that their call has no
      // recording, which is a different fact and would be a false one.
      console.error('Voice platform recording fetch failed:', upstream.status);
      throw new ApiError(502, 'UPSTREAM_ERROR', 'The voice platform could not return that recording.');
    }

    // Dropped when the body arrived encoded: fetch decodes on the way in, so
    // the length upstream sent describes bytes that are no longer what we are
    // about to write.
    const encoded = upstream.headers.get('content-encoding') !== null;

    for (const header of PASSTHROUGH_HEADERS) {
      if (encoded && header === 'content-length') continue;
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }

    res.setHeader('Content-Type', safeContentType(upstream.headers.get('content-type')));
    // Belt to the allow-list's braces: nothing here is to be sniffed into
    // something executable.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // A fixed name. The call id is upstream's and has no business in a header
    // that some clients write to disk.
    res.setHeader('Content-Disposition', 'inline; filename="recording.wav"');
    // The URL carries a credential and the body is a customer's call audio;
    // neither belongs in a shared cache.
    res.setHeader('Cache-Control', 'private, no-store');
    // Advertised whether or not this response is a partial one, or the player
    // never asks for a range and seeking silently does nothing.
    res.setHeader('Accept-Ranges', 'bytes');
    res.status(upstream.status);

    if (!upstream.body) {
      res.end();
      return;
    }

    const stream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);

    try {
      // `pipeline`, not `pipe`. `pipe` forwards no error from its source, and
      // an unhandled 'error' on a Readable is an uncaught exception — storage
      // dropping one connection would take the process down for every
      // workspace. It also tears the upstream socket down when a reader closes
      // the tab, so an hour of audio is not drained for nobody.
      await pipeline(stream, res);
    } catch {
      // The status line went out with the headers, so there is no way left to
      // report this. Destroying the connection is the only signal that the
      // body is short — ending it normally would present a truncated
      // recording as a complete one.
      res.destroy();
    }
  }),
);
