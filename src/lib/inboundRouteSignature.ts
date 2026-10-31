import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

/**
 * Verifier for the inbound routing-policy callback.
 *
 * A sibling of `webhookSignature.ts` — the same HMAC shape,
 * `hmac_sha256(`${timestamp}.${rawBody}`)`, the same replay window, the same
 * two hard-won rules — but its OWN secret and header. The platform signs the
 * routing callback with `INBOUND_ROUTE_POLICY_SECRET` and sends the digest as
 * `X-Vocobase-Signature: v1=<hex>` with `X-Vocobase-Timestamp`. Keeping it
 * separate from the outcome-webhook verifier means the two secrets cannot be
 * confused for one another, and a rotation of one never silently accepts the
 * other.
 */

const PREFIX = 'v1=';
const MAX_SKEW_MS = 300_000;

export type InboundRouteVerificationFailure =
  | 'no_secret'
  | 'missing_headers'
  | 'stale_timestamp'
  | 'bad_signature';

export type InboundRouteVerificationResult =
  | { ok: true }
  | { ok: false; reason: InboundRouteVerificationFailure };

/**
 * Constant-time compare that checks length FIRST — `timingSafeEqual` throws on
 * buffers of unequal length, which would turn a forged signature into a 500
 * (an error the attacker can tell apart from a rejection). The length check
 * makes a mismatched signature a clean rejection.
 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * The platform signs THIS callback with `Date.now().toString()` — epoch
 * milliseconds — where the outcome webhook sends an ISO string. `new Date()`
 * over a digit string is NaN, so a verifier that only understood ISO would
 * reject every genuine routing callback as stale and the platform would fall
 * back to answering blank, silently. Digits are read as epoch ms (or seconds
 * when too short to be ms); anything else is tried as a date string.
 */
function parseTimestamp(header: string): number {
  if (/^\d+$/.test(header)) {
    const n = Number(header);
    // Ten digits is seconds until the year 2286; thirteen is milliseconds.
    return n < 1e11 ? n * 1000 : n;
  }
  return new Date(header).getTime();
}

export function verifyInboundRoute(
  rawBody: Buffer | string,
  signatureHeader: unknown,
  timestampHeader: unknown,
  now: Date = new Date(),
): InboundRouteVerificationResult {
  // An unset secret rejects everything, fail-closed — a missing secret must
  // never mean an open door, and must not stop the service starting either.
  if (!env.inboundRoutePolicySecret) return { ok: false, reason: 'no_secret' };

  if (typeof signatureHeader !== 'string' || typeof timestampHeader !== 'string') {
    return { ok: false, reason: 'missing_headers' };
  }

  const sentAt = parseTimestamp(timestampHeader);
  if (!Number.isFinite(sentAt)) return { ok: false, reason: 'stale_timestamp' };
  if (Math.abs(now.getTime() - sentAt) > MAX_SKEW_MS) return { ok: false, reason: 'stale_timestamp' };

  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected =
    PREFIX +
    createHmac('sha256', env.inboundRoutePolicySecret)
      .update(`${timestampHeader}.${body}`)
      .digest('hex');

  if (!safeEqual(signatureHeader, expected)) return { ok: false, reason: 'bad_signature' };

  return { ok: true };
}

/** Test-only mirror of the signing the platform does. */
export function signInboundRoute(rawBody: string, timestamp: string, secret: string): string {
  return PREFIX + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}
