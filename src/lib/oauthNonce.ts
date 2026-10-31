import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { getQueueConnection } from './queue/connection.js';

/**
 * The one-time token that carries a connect flow's context across the OAuth
 * round trip.
 *
 * The return leg (`GET /integrations/google/return/:nonce`) is **public** — the
 * caller is a browser arriving from the platform's consent screen, with no
 * session this service can read and no header it can set. So the nonce is the
 * whole of the authentication, and everything that follows from that is here:
 *
 * - **32 random bytes**, base64url, from `crypto.randomBytes`. It authorises a
 *   write against a workspace, so it is sized like a credential rather than
 *   like an id.
 * - **Single use.** Read and delete are one `GETDEL`, so two browsers arriving
 *   with the same nonce cannot both claim a connection — the loser gets the
 *   expired answer, which is the truthful one.
 * - **Forty minutes, and the connect link is sized to fit inside it.** The
 *   platform can send the browser back for as long as the link lives plus the
 *   600 s its own OAuth state lives after the click, so the nonce has to
 *   outlast both or an admin whose connection succeeded is told it expired.
 *   See `NONCE_TTL_SECONDS` and `CONNECT_LINK_TTL_SECONDS`.
 *
 * In Redis rather than Postgres because it expires, is written once and read
 * once, and must not outlive the flow — all three of which a TTL gives for
 * free and a table would need a sweep for.
 */

const KEY_PREFIX = 'ezo:oauth:';

/**
 * How long the voice platform keeps its OAuth state once the admin has clicked
 * the link (`STATE_EXPIRY_SECONDS`, 600 s). The browser can still arrive back
 * here up to this long after the link itself has expired.
 */
export const PLATFORM_OAUTH_STATE_SECONDS = 600;

/**
 * How long a nonce lives. Long enough for a Google sign-in with a password and
 * a second factor, short enough that a link left in a browser history is not a
 * standing key.
 */
export const NONCE_TTL_SECONDS = 2400;

/**
 * The `expires_in_seconds` a connect link is minted with — derived from the
 * nonce, never set beside it, so the platform's last possible redirect
 * (link expiry + its own state expiry) still lands while the nonce is live.
 * At 2400 this is 1800, the platform's own default.
 */
export const CONNECT_LINK_TTL_SECONDS = NONCE_TTL_SECONDS - PLATFORM_OAUTH_STATE_SECONDS;

export interface ConnectNonce {
  workspaceId: string;
  slug: string;
  /** Who started it. Recorded for the log line that follows the connection —
   *  the return leg has no session of its own to say who this was. */
  accountId: string;
}

const key = (nonce: string) => `${KEY_PREFIX}${nonce}`;

/** How long a request waits for the shared connection to come up. */
const READY_TIMEOUT_MS = 5_000;

/**
 * The shared connection, once it can actually take a command.
 *
 * `getQueueConnection()` sets `enableOfflineQueue: false` — the right policy
 * for the dispatcher, where a command issued into a dead Redis must reject
 * rather than sit in a buffer under a tick that is awaiting it. The cost is
 * that ioredis also rejects a command issued during the ordinary few
 * milliseconds between construction and `ready`, and that window is opened by
 * the FIRST caller after boot. On the dispatcher's path that is a tick that
 * runs again in a minute; here it is an admin clicking Connect on a freshly
 * deployed instance, and "the integration is broken" is what they would learn.
 *
 * So this waits, rather than either swallowing the failure or turning the
 * offline queue back on for every other caller of that connection. Bounded, so
 * a Redis that is genuinely down fails the request instead of holding it open:
 * the retry strategy reconnects forever, which is what makes an unbounded wait
 * a hang rather than an error.
 */
async function ready(): Promise<Redis> {
  const redis = getQueueConnection();
  if (redis.status === 'ready') return redis;

  await new Promise<void>((resolve, reject) => {
    const settle = (err?: Error) => {
      clearTimeout(timer);
      redis.off('ready', onReady);
      redis.off('end', onEnd);
      if (err) reject(err);
      else resolve();
    };

    const onReady = () => settle();
    const onEnd = () => settle(new Error('Redis connection closed before it was ready'));
    const timer = setTimeout(
      () => settle(new Error('Redis did not become ready in time')),
      READY_TIMEOUT_MS,
    );

    redis.once('ready', onReady);
    redis.once('end', onEnd);
  });

  return redis;
}

/** Mints a nonce and stores the context behind it. Returns the nonce. */
export async function mintConnectNonce(context: ConnectNonce): Promise<string> {
  const nonce = randomBytes(32).toString('base64url');

  const redis = await ready();
  await redis.set(key(nonce), JSON.stringify(context), 'EX', NONCE_TTL_SECONDS);

  return nonce;
}

/**
 * Consumes a nonce, or answers null.
 *
 * Null covers expired, already used, and never minted — one answer, because
 * the caller is unauthenticated and telling those apart would say whether a
 * given nonce was ever real.
 */
export async function consumeConnectNonce(nonce: string): Promise<ConnectNonce | null> {
  const redis = await ready();
  const raw = await redis.getdel(key(nonce));
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const { workspaceId, slug, accountId } = parsed as Record<string, unknown>;
    if (typeof workspaceId !== 'string' || typeof slug !== 'string' || typeof accountId !== 'string') {
      return null;
    }

    return { workspaceId, slug, accountId };
  } catch {
    // Unparseable is the same as absent: there is nothing to act on either way.
    console.error('Connect nonce held an unreadable payload.');
    return null;
  }
}
