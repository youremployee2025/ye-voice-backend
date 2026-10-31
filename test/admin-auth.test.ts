import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStaffTokenGuard } from '../src/middleware/adminToken.js';

const TOKEN = 'staff-token-value';

/**
 * The guard takes its secret directly, so these cases need no environment
 * mutation and no module-registry reset. An earlier version configured it
 * through process.env, which made the outcome depend on when other test files
 * happened to touch the same global — an unacceptable property for the tests
 * guarding an authentication check.
 *
 * They also drive the middleware directly rather than over HTTP, for the same
 * reason rate-limit.test.ts does. supertest stands up one ephemeral server per
 * request; under a full-suite run that occasionally loses a request to a
 * socket reset and reports a 400 the guard never produced. An authentication
 * test that fails a few times in a hundred for reasons unrelated to
 * authentication is a test people learn to re-run rather than read.
 */
interface Outcome {
  /** Whether the guard passed the request down the stack. */
  admitted: boolean;
  status: number;
  code?: string;
}

function callGuard(secret: string, presented?: string): Outcome {
  const guard = createStaffTokenGuard(secret);
  const outcome: Outcome = { admitted: false, status: 200 };

  const req = {
    header: (name: string) => (name.toLowerCase() === 'x-admin-token' ? presented : undefined),
  };

  const res = {
    status(code: number) { outcome.status = code; return this; },
    json(body: { error?: { code?: string } }) { outcome.code = body.error?.code; return this; },
  };

  guard(req as never, res as never, () => { outcome.admitted = true; });

  return outcome;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('requireStaffToken', () => {
  it('admits a request carrying the configured token', () => {
    expect(callGuard(TOKEN, TOKEN).admitted).toBe(true);
  });

  it('rejects a request with no token header', () => {
    const outcome = callGuard(TOKEN, undefined);

    expect(outcome.admitted).toBe(false);
    expect(outcome.status).toBe(401);
    expect(outcome.code).toBe('UNAUTHORIZED');
  });

  it('rejects a wrong token of the same length', () => {
    expect(callGuard(TOKEN, 'staff-token-wrong').admitted).toBe(false);
  });

  it('rejects a token of a different length without throwing', () => {
    // timingSafeEqual throws on mismatched lengths, so this must be handled
    // before the comparison rather than surfacing as a 500.
    const outcome = callGuard(TOKEN, 'short');

    expect(outcome.admitted).toBe(false);
    expect(outcome.status).toBe(401);
    expect(outcome.code).toBe('UNAUTHORIZED');
  });

  it('rejects a token that is a prefix of the real one', () => {
    expect(callGuard(TOKEN, TOKEN.slice(0, -1)).admitted).toBe(false);
  });

  it('rejects a token that extends the real one', () => {
    expect(callGuard(TOKEN, `${TOKEN}x`).admitted).toBe(false);
  });

  it('rejects every request when no staff token is configured', () => {
    // An unset secret must not mean an open door, so even a matching empty
    // header is refused.
    const outcome = callGuard('', '');

    expect(outcome.admitted).toBe(false);
    expect(outcome.status).toBe(401);
  });

  it('rejects a non-empty token when no staff token is configured', () => {
    expect(callGuard('', 'anything').admitted).toBe(false);
  });
});
