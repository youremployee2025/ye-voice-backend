import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { fail } from '../lib/errors.js';

/**
 * A fixed-window request limiter.
 *
 * This exists for `/api/admin/*`, whose only credential is a shared secret in
 * a header. Constant-time comparison stops the secret leaking through timing,
 * but nothing stops a caller simply trying secrets quickly — so the guard is
 * paired with a cap on how fast anyone may try.
 *
 * Two budgets, per key, per window, because the traffic has two shapes and one
 * number cannot serve both. A stranger guessing the token produces 401s and
 * must be stopped within a handful of them. The staff console produces
 * successful reads — and produces all of them from ONE address, because every
 * page fetches on its server rather than in the browser, so every operator
 * shares a key. Counting both against a single small cap meant the console
 * throttled itself long before it inconvenienced a guesser.
 *
 * So `failureLimit` counts only requests that end in 401 and is deliberately
 * tight; `limit` counts everything and is loose enough for a console but still
 * finite, so a caller who guesses right does not thereby get unlimited reach.
 * Exceeding either closes the window for both.
 *
 * Deliberately in-process and dependency-free. State lives in one map per
 * limiter, which means each instance of the service enforces its own budget:
 * with N instances behind a load balancer the effective ceiling is N x limit.
 * That is the right trade for staff endpoints, which see a handful of
 * requests a day; moving the counter to shared storage is the change to make
 * if this is ever mounted on customer traffic.
 *
 * Built around injected `now` and `keyOf` for the same reason the staff guard
 * takes an explicit secret: a limiter tested against wall time is a limiter
 * whose tests are timing-dependent.
 */

export interface RateLimiterOptions {
  /** Requests permitted per window, per key, whatever their outcome. */
  limit: number;
  /**
   * Requests ending in 401 permitted per window, per key.
   *
   * This is the anti-guessing cap, and the only one that needs to be small.
   * Omitted, it falls back to `limit`, which is the old single-budget
   * behaviour.
   */
  failureLimit?: number;
  windowMs: number;
  /** Injectable clock. Defaults to the real one. */
  now?: () => number;
  /** Identifies the caller. Defaults to the request's remote address. */
  keyOf?: (req: Request) => string;
}

/** An express middleware that also reports how many windows it is tracking. */
export interface RateLimiter extends RequestHandler {
  /** Live window count — exposed so the pruning behaviour is observable. */
  size(): number;
}

interface Window {
  /** When the current window opened. */
  startedAt: number;
  count: number;
  /** How many of those ended in 401. */
  failures: number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { limit, windowMs } = options;
  const failureLimit = options.failureLimit ?? limit;
  const now = options.now ?? Date.now;
  const keyOf = options.keyOf ?? ((req: Request) => req.ip ?? 'unknown');

  const windows = new Map<string, Window>();

  /** Drops windows that have rolled over, so a stream of one-shot callers
   *  cannot grow the map forever. The map only ever holds callers seen within
   *  the last window, which bounds it — but this is a full scan on every
   *  request, so it is cheap at staff volume and not at customer volume. A
   *  limiter mounted on customer traffic wants a shared store anyway; that
   *  move is the point at which this sweep should go too. */
  function prune(at: number): void {
    for (const [key, window] of windows) {
      if (at - window.startedAt >= windowMs) windows.delete(key);
    }
  }

  const middleware = function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const at = now();
    prune(at);

    const key = keyOf(req);
    // Counting and checking share one path deliberately. When the first
    // request for a key was admitted before consulting `limit`, a limit of 0
    // still let one request per key per window through — a kill switch that
    // does not quite switch off.
    const window = windows.get(key) ?? { startedAt: at, count: 0, failures: 0 };
    window.count += 1;
    windows.set(key, window);

    if (window.count > limit || window.failures >= failureLimit) {
      const retryAfterMs = window.startedAt + windowMs - at;
      res.setHeader('Retry-After', String(Math.max(0, Math.ceil(retryAfterMs / 1000))));
      fail(res, 429, 'RATE_LIMITED', 'Too many requests. Try again shortly.');
      return;
    }

    // The outcome is only known once the guard downstream has answered, so the
    // failure is counted on the way out and spent by the NEXT request. That is
    // an off-by-one in the guesser's favour of exactly one attempt, which is
    // the right trade for not having the limiter guess at what the guard will
    // decide.
    res.on('finish', () => {
      if (res.statusCode === 401) window.failures += 1;
    });

    next();
  } as RateLimiter;

  middleware.size = () => windows.size;

  return middleware;
}
