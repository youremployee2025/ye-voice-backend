import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A short-lived credential for one call's recording, and nothing else.
 *
 * It exists because an `<audio>` element cannot send an `Authorization`
 * header. The browser needs a URL it can hand straight to the media player,
 * and the three obvious ways to produce one are all worse:
 *
 * - **Redirect to the platform's presigned URL.** That URL names the
 *   supplier's storage, stays valid for seven days, knows nothing about
 *   workspace membership, and cannot be revoked.
 * - **Put the Clerk session token in the query string.** URLs reach access
 *   logs, `Referer` headers and browser history. A session token there is the
 *   whole account, for its full lifetime, in the least protected place.
 * - **Download the audio as a blob first.** No progressive playback and no
 *   seeking until an hour of audio has finished transferring.
 *
 * So: a token this service signs, scoped to one workspace and one call,
 * expiring in two minutes. Leaked, it buys the bearer one recording they could
 * already hear, for about as long as it takes to notice.
 *
 * It authenticates only. Whether the workspace may see that call is still
 * decided on every request by the same visibility check every other route
 * uses — the token never stands in for authorization.
 */

/** Long enough to start playback on a slow connection, short enough that a
 *  copied URL is stale before it can be shared. */
const TTL_MS = 120_000;

export interface RecordingTokenClaims {
  workspaceId: string;
  callId: string;
}

/** Compact single-letter keys: this rides in a query string on every play. */
interface Payload {
  w: string;
  c: string;
  /** Expiry, epoch ms. */
  e: number;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function signRecordingToken(
  claims: RecordingTokenClaims,
  secret: string,
  now: number = Date.now(),
): string {
  const payload: Payload = {
    w: claims.workspaceId,
    c: claims.callId,
    e: now + TTL_MS,
  };

  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');

  return `${encoded}.${sign(encoded, secret)}`;
}

/**
 * The claims a token carries, or `null`.
 *
 * `null` for every failure — expired, forged, malformed, or a service with no
 * secret configured. An unconfigured secret rejecting everything is the same
 * rule the staff-token guard holds: a missing secret must not mean an open
 * door.
 *
 * The signature covers the expiry as well as the call, so neither can be
 * edited, and the comparison is constant-time so the signature cannot be
 * recovered a byte at a time.
 */
export function verifyRecordingToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): RecordingTokenClaims | null {
  if (!secret) return null;
  if (typeof token !== 'string' || !token) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encoded, signature] = parts;
  if (!encoded || !signature) return null;

  const expected = sign(encoded, secret);
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  // Length is checked first because timingSafeEqual throws on a mismatch, and
  // a thrown error here would be a 500 where a rejection belongs.
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;

  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Payload;
  } catch {
    return null;
  }

  if (typeof payload?.w !== 'string' || typeof payload?.c !== 'string') return null;
  if (typeof payload?.e !== 'number' || payload.e <= now) return null;

  return { workspaceId: payload.w, callId: payload.c };
}
