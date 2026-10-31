import { describe, expect, it } from 'vitest';
import type { RequestHandler } from 'express';
import { createRateLimiter } from '../src/middleware/rateLimit.js';

/**
 * These drive the middleware directly rather than over HTTP. What is under
 * test here is bookkeeping — counting, expiry, per-caller isolation — and
 * routing it through supertest means one ephemeral server per request, which
 * occasionally loses a request to a socket reset and makes a deterministic
 * claim look flaky. The HTTP wiring is covered by admin-rate-limit.test.ts.
 */

/** A clock the test drives by hand, so nothing here waits on wall time. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

interface Outcome {
  /** Whether the request was passed down the stack. */
  allowed: boolean;
  status: number;
  retryAfter?: string;
}

/**
 * Invokes the middleware with just the request surface it touches.
 *
 * `answeredWith` is the status the stack below settles on, which the limiter
 * only learns from the response's `finish` event — so the fake emits it, and
 * the failure budget is exercised the way express would drive it.
 */
function call(
  limiter: RequestHandler,
  caller = 'anonymous',
  answeredWith = 200,
): Outcome {
  const req = {
    header: (name: string) => (name.toLowerCase() === 'x-caller' ? caller : undefined),
    ip: '::1',
  };

  const outcome: Outcome = { allowed: false, status: 200 };
  const finishListeners: Array<() => void> = [];

  const res = {
    statusCode: answeredWith,
    setHeader: (name: string, value: string) => {
      if (name.toLowerCase() === 'retry-after') outcome.retryAfter = value;
    },
    status(code: number) {
      outcome.status = code;
      this.statusCode = code;
      return this;
    },
    json: () => res,
    on(event: string, listener: () => void) {
      if (event === 'finish') finishListeners.push(listener);
      return this;
    },
  };

  limiter(req as never, res as never, () => { outcome.allowed = true; });

  // Every response finishes, refused or served.
  for (const listener of finishListeners) listener();

  return outcome;
}

function limiterFor(limit: number, now: () => number, failureLimit?: number) {
  return createRateLimiter({
    limit,
    ...(failureLimit === undefined ? {} : { failureLimit }),
    windowMs: 60_000,
    now,
    keyOf: (req) => req.header('x-caller') ?? 'anonymous',
  });
}

describe('createRateLimiter', () => {
  it('allows requests up to the limit', () => {
    const limiter = limiterFor(3, fakeClock().now);

    for (let i = 0; i < 3; i += 1) {
      expect(call(limiter).allowed).toBe(true);
    }
  });

  it('rejects the request past the limit with 429', () => {
    const limiter = limiterFor(2, fakeClock().now);

    call(limiter);
    call(limiter);
    const blocked = call(limiter);

    expect(blocked.allowed).toBe(false);
    expect(blocked.status).toBe(429);
  });

  it('tells the caller when to come back', () => {
    const clock = fakeClock();
    const limiter = limiterFor(1, clock.now);

    call(limiter);
    clock.advance(15_000);

    // 60s window opened at the first hit, 15s consumed — 45s left.
    expect(call(limiter).retryAfter).toBe('45');
  });

  it('lets the caller back in once the window rolls over', () => {
    const clock = fakeClock();
    const limiter = limiterFor(1, clock.now);

    expect(call(limiter).allowed).toBe(true);
    expect(call(limiter).allowed).toBe(false);

    clock.advance(60_001);

    expect(call(limiter).allowed).toBe(true);
  });

  it('counts each caller separately', () => {
    const limiter = limiterFor(1, fakeClock().now);

    expect(call(limiter, 'a').allowed).toBe(true);
    expect(call(limiter, 'b').allowed).toBe(true);
    expect(call(limiter, 'a').allowed).toBe(false);
  });

  it('does not grow without bound as callers come and go', () => {
    const clock = fakeClock();
    const limiter = limiterFor(5, clock.now);

    for (let i = 0; i < 50; i += 1) call(limiter, `caller-${i}`);
    expect(limiter.size()).toBe(50);

    // Every one of those windows has expired by now.
    clock.advance(60_001);
    call(limiter, 'fresh');

    expect(limiter.size()).toBe(1);
  });
});

describe('createRateLimiter edge cases', () => {
  it('admits nothing at a limit of zero', () => {
    // The first request for a key used to be waved through before `limit` was
    // consulted, so zero still admitted one request per caller per window — a
    // kill switch that did not quite switch off.
    const limiter = limiterFor(0, fakeClock().now);

    const first = call(limiter, 'someone');

    expect(first.allowed).toBe(false);
    expect(first.status).toBe(429);
  });

  it('counts the first request for a key against the limit', () => {
    const limiter = limiterFor(1, fakeClock().now);

    expect(call(limiter, 'someone').allowed).toBe(true);
    expect(call(limiter, 'someone').allowed).toBe(false);
  });

  it('never advertises a negative Retry-After', () => {
    const clock = fakeClock();
    const limiter = limiterFor(1, clock.now);

    call(limiter, 'someone');
    // Past the window's end, but pruning runs on the same tick, so the header
    // must still be a sane number rather than a negative one.
    clock.advance(59_999);
    const blocked = call(limiter, 'someone');

    expect(Number(blocked.retryAfter)).toBeGreaterThanOrEqual(0);
  });
});

describe('the failure budget', () => {
  it('turns a caller away after too many rejected tokens, well inside the general cap', () => {
    const clock = fakeClock();
    const limiter = limiterFor(100, clock.now, 3);

    // Three rejections are spent; the limiter learns each on the way out, so
    // the fourth request is the first it can refuse.
    for (let i = 0; i < 3; i += 1) {
      expect(call(limiter, 'guesser', 401).allowed).toBe(true);
    }

    const blocked = call(limiter, 'guesser', 401);
    expect(blocked.allowed).toBe(false);
    expect(blocked.status).toBe(429);
  });

  it('does not spend the failure budget on requests that succeed', () => {
    const clock = fakeClock();
    const limiter = limiterFor(100, clock.now, 3);

    for (let i = 0; i < 20; i += 1) {
      expect(call(limiter, 'console', 200).allowed).toBe(true);
    }
  });

  it('keeps the general cap, so guessing right is not unlimited reach', () => {
    const clock = fakeClock();
    const limiter = limiterFor(3, clock.now, 10);

    for (let i = 0; i < 3; i += 1) {
      expect(call(limiter, 'lucky', 200).allowed).toBe(true);
    }

    expect(call(limiter, 'lucky', 200).status).toBe(429);
  });

  it('lets a locked-out caller back in once the window rolls over', () => {
    const clock = fakeClock();
    const limiter = limiterFor(100, clock.now, 2);

    call(limiter, 'guesser', 401);
    call(limiter, 'guesser', 401);
    expect(call(limiter, 'guesser', 401).status).toBe(429);

    clock.advance(60_000);
    expect(call(limiter, 'guesser', 401).allowed).toBe(true);
  });

  it('falls back to one budget when no failure limit is configured', () => {
    const clock = fakeClock();
    const limiter = limiterFor(3, clock.now);

    for (let i = 0; i < 3; i += 1) {
      expect(call(limiter, 'guesser', 401).allowed).toBe(true);
    }

    expect(call(limiter, 'guesser', 401).status).toBe(429);
  });
});
