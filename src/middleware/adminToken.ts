import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../lib/env.js';
import { fail } from '../lib/errors.js';

/**
 * Guards `/api/admin/*`, which serves YE staff rather than customer accounts
 * and so does not go through Clerk. The caller presents a shared secret in
 * `X-Admin-Token`.
 *
 * This is deliberately the simplest thing that is not weak: one secret, held
 * server-side, compared in constant time. It is a placeholder for real staff
 * authentication, not a design to build more roles on top of.
 */

const HEADER = 'x-admin-token';

/** Constant-time comparison. `timingSafeEqual` throws on length mismatch, so
 *  length is checked first — that leaks only the length, never the content. */
function matches(candidate: string, secret: string): boolean {
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(secret, 'utf8');

  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

/**
 * Built around an explicit secret so the guard can be exercised without
 * mutating process-wide environment state — configuring it through
 * `process.env` forced tests to reset the module registry between cases, which
 * made a security check's own tests timing-dependent.
 */
/**
 * Marks a request whose token this guard has already accepted.
 *
 * The staff surface is composed of several routers behind one mount, and each
 * keeps its own `use(requireStaffToken)` so that no router can ever be mounted
 * somewhere else and arrive unguarded. That means the guard runs once per
 * router per request. Re-verifying a secret four times is not expensive, but it
 * is four times the work for one answer, so the answer is remembered for the
 * life of the request. Set only after a successful comparison; nothing clears
 * it, and nothing outside this module writes it.
 */
const VERIFIED = Symbol('staffTokenVerified');

export function createStaffTokenGuard(secret: string) {
  return function requireStaffToken(req: Request, res: Response, next: NextFunction): void {
    if ((req as Request & { [VERIFIED]?: true })[VERIFIED]) {
      next();
      return;
    }

    // An unconfigured secret closes the door rather than opening it: a
    // deployment that forgot the variable must not expose staff endpoints.
    if (!secret) {
      console.error('ADMIN_STAFF_TOKEN is not configured — refusing all admin requests.');
      fail(res, 401, 'UNAUTHORIZED', 'Staff authentication required.');
      return;
    }

    const presented = req.header(HEADER);

    if (!presented || !matches(presented, secret)) {
      fail(res, 401, 'UNAUTHORIZED', 'Staff authentication required.');
      return;
    }

    (req as Request & { [VERIFIED]?: true })[VERIFIED] = true;
    next();
  };
}

/** The guard the admin router mounts, reading the configured secret. */
export function requireStaffToken(req: Request, res: Response, next: NextFunction): void {
  createStaffTokenGuard(env.adminStaffToken)(req, res, next);
}
