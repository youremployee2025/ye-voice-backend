import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

/**
 * Verifying that a webhook came from the voice platform.
 *
 * This module is the only place a signature is checked. It is the whole of the
 * authentication on an endpoint that moves money: anything that gets past it
 * can close a call attempt and debit a customer.
 *
 * The scheme is the platform's: HMAC-SHA256 over `{timestamp}.{rawBody}`,
 * hex-encoded, carried as `X-Webhook-Signature: sha256=<hex>` with the
 * timestamp in `X-Webhook-Timestamp`.
 */

const PREFIX = 'sha256=';

/**
 * How far out of date a delivery may be.
 *
 * Without it a signature is valid forever, so one captured request can be
 * replayed indefinitely — and since the body carries a duration, a replayed
 * completion is a repeat charge. The `WebhookEvent` marker stops that
 * independently; this stops it earlier and more cheaply.
 *
 * Five minutes is the platform's own recommendation, and it is comfortably
 * larger than its retry jitter.
 */
const MAX_SKEW_MS = 300_000;

export type VerificationFailure =
  | 'no_secret'
  | 'missing_headers'
  | 'stale_timestamp'
  | 'bad_signature';

export type VerificationResult = { ok: true } | { ok: false; reason: VerificationFailure };

/**
 * Compares two strings without leaking how far they matched.
 *
 * `timingSafeEqual` **throws** on buffers of different lengths rather than
 * returning false, so the length check is not an optimisation — without it, a
 * signature of the wrong length crashes the route instead of being rejected,
 * which turns a forged request into a 500 and, with the platform's retry
 * policy, into five of them.
 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');

  if (left.length !== right.length) return false;

  return timingSafeEqual(left, right);
}

/**
 * Whether this delivery is genuine.
 *
 * `rawBody` must be the **exact bytes received**. A parsed-and-restringified
 * body is a different string — key order, whitespace and number formatting all
 * move — so the route mounts `express.raw` ahead of the JSON parser and hands
 * the buffer straight here.
 */
export function verifyWebhook(
  rawBody: Buffer | string,
  signatureHeader: unknown,
  timestampHeader: unknown,
  now: Date = new Date(),
): VerificationResult {
  /**
   * An unset secret rejects everything.
   *
   * The same rule `RECORDING_TOKEN_SECRET` and `ADMIN_STAFF_TOKEN` hold: a
   * missing secret must never mean an open door, and must not stop the service
   * starting either. Here it means outcomes stop arriving and calls stay in
   * flight until the reaper closes them — visible, recoverable, and vastly
   * better than an endpoint anybody can post a charge to.
   */
  if (!env.vocobaseWebhookSecret) return { ok: false, reason: 'no_secret' };

  if (typeof signatureHeader !== 'string' || typeof timestampHeader !== 'string') {
    return { ok: false, reason: 'missing_headers' };
  }

  const sentAt = new Date(timestampHeader).getTime();

  // `NaN` from an unparseable timestamp fails every comparison, so it is
  // tested for rather than relied upon to fall through the right way.
  if (!Number.isFinite(sentAt)) return { ok: false, reason: 'stale_timestamp' };
  if (Math.abs(now.getTime() - sentAt) > MAX_SKEW_MS) return { ok: false, reason: 'stale_timestamp' };

  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');

  /**
   * The current secret, and the one being rotated out if there is one.
   *
   * A secret is issued once upstream and shown again never, so rotating it is
   * mint → write → restart, and every delivery already in flight at the
   * restart is signed with the outgoing value. This endpoint closes call
   * attempts and charges credits, so a delivery dropped in that window holds a
   * line open until the reaper finds it. Accepting both closes the window.
   *
   * The current secret is tried first, so the steady state is one HMAC. The
   * guard above is unchanged and still runs before this: with the main secret
   * unset, nothing is accepted — an outgoing secret alone is a half-finished
   * rotation, and it must not be a door.
   */
  const candidates = env.vocobaseWebhookSecretPrevious
    ? [env.vocobaseWebhookSecret, env.vocobaseWebhookSecretPrevious]
    : [env.vocobaseWebhookSecret];

  const accepted = candidates.some((candidate) =>
    safeEqual(
      signatureHeader,
      PREFIX + createHmac('sha256', candidate).update(`${timestampHeader}.${body}`).digest('hex'),
    ),
  );

  if (!accepted) return { ok: false, reason: 'bad_signature' };

  return { ok: true };
}

/** Signs a payload the way the platform does. Test-only; nothing sends webhooks. */
export function signWebhook(rawBody: string, timestamp: string, secret: string): string {
  return PREFIX + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}
