import { describe, expect, it } from 'vitest';
import { parseCallQuery } from '../src/lib/callQuery.js';
import { ApiError } from '../src/lib/errors.js';

function reject(query: Record<string, unknown>): ApiError {
  try {
    parseCallQuery(query);
  } catch (err) {
    return err as ApiError;
  }
  throw new Error('expected parseCallQuery to reject');
}

describe('parseCallQuery — paging', () => {
  it('defaults to the first page of twenty-five', () => {
    const query = parseCallQuery({});

    expect(query.page).toBe(1);
    expect(query.limit).toBe(25);
    expect(query.skip).toBe(0);
    expect(query.take).toBe(25);
  });

  it('skips whole pages of the filtered stream', () => {
    const query = parseCallQuery({ page: '3', limit: '10' });

    expect(query.skip).toBe(20);
    expect(query.take).toBe(10);
  });

  it('clamps an oversized limit rather than refusing it', () => {
    expect(parseCallQuery({ limit: '5000' }).limit).toBe(100);
  });

  it('refuses a malformed page instead of falling back to the first', () => {
    // A listing that quietly shows page 1's rows under page 4's heading is
    // worse than one that refuses.
    expect(reject({ page: 'two' }).status).toBe(400);
    expect(reject({ page: '0' }).code).toBe('VALIDATION_ERROR');
    expect(reject({ page: '-1' }).code).toBe('VALIDATION_ERROR');
    expect(reject({ page: '1.5' }).code).toBe('VALIDATION_ERROR');
  });

  it('refuses a malformed limit', () => {
    expect(reject({ limit: 'all' }).status).toBe(400);
    expect(reject({ limit: '0' }).status).toBe(400);
  });
});

describe('parseCallQuery — date range', () => {
  it('accepts a full ISO timestamp', () => {
    const query = parseCallQuery({ from: '2026-08-01T09:30:00.000Z' });

    expect(query.from?.toISOString()).toBe('2026-08-01T09:30:00.000Z');
  });

  it('reads a date-only from as the start of that day', () => {
    expect(parseCallQuery({ from: '2026-08-01' }).from?.toISOString()).toBe(
      '2026-08-01T00:00:00.000Z',
    );
  });

  it('reads a date-only to as the end of that day, so one day includes itself', () => {
    // Without this, ?from=2026-08-01&to=2026-08-01 is an empty range and the
    // reader concludes nothing happened that day.
    expect(parseCallQuery({ from: '2026-08-01', to: '2026-08-01' }).to?.toISOString()).toBe(
      '2026-08-01T23:59:59.999Z',
    );
  });

  it('leaves both bounds null when neither is given', () => {
    const query = parseCallQuery({});

    expect(query.from).toBeNull();
    expect(query.to).toBeNull();
  });

  it('refuses an unparseable date', () => {
    expect(reject({ from: 'yesterday' }).status).toBe(400);
    expect(reject({ to: '2026-13-45' }).status).toBe(400);
  });

  it('accepts a timestamp carrying an explicit offset', () => {
    expect(parseCallQuery({ from: '2026-08-01T00:00:00+05:30' }).from?.toISOString()).toBe(
      '2026-07-31T18:30:00.000Z',
    );
  });

  it('refuses a timestamp with no timezone, whatever the server clock is set to', () => {
    // `2026-08-01T00:00` is what `<input type="datetime-local">` emits, and
    // `new Date()` reads it in the server's own zone — so the same query would
    // answer differently on two deploys of the same code. Refusing is the only
    // reading that cannot be silently wrong.
    expect(reject({ from: '2026-08-01T00:00' }).status).toBe(400);
    expect(reject({ to: '2026-08-01T12:00:00' }).status).toBe(400);
  });

  it('refuses forms Date happens to accept but ISO 8601 does not', () => {
    // Each of these parses, and each parses in the server's zone or to
    // something the caller plainly did not ask for.
    expect(reject({ from: '08/01/2026' }).status).toBe(400);
    expect(reject({ from: '2026' }).status).toBe(400);
    expect(reject({ from: 'Aug 1 2026' }).status).toBe(400);
  });

  it('refuses a range that ends before it begins', () => {
    const error = reject({ from: '2026-08-10', to: '2026-08-01' });

    expect(error.status).toBe(400);
    expect(error.code).toBe('VALIDATION_ERROR');
  });
});

describe('parseCallQuery — status and disposition', () => {
  it('carries status and disposition as free text', () => {
    const query = parseCallQuery({ status: 'completed', disposition: 'voicemail' });

    expect(query.status).toBe('completed');
    expect(query.disposition).toBe('voicemail');
  });

  it('accepts a value no published enum contains', () => {
    // These are provider-controlled: a carrier onboarded next month may report
    // a disposition nothing here has heard of, and it must filter rather than
    // 400.
    const query = parseCallQuery({ disposition: 'carrier_specific_thing' });

    expect(query.disposition).toBe('carrier_specific_thing');
  });

  it('folds case so the filter matches however upstream spells it', () => {
    expect(parseCallQuery({ status: 'COMPLETED' }).status).toBe('completed');
  });

  it('treats a blank filter as no filter', () => {
    const query = parseCallQuery({ status: '   ', disposition: '' });

    expect(query.status).toBeNull();
    expect(query.disposition).toBeNull();
  });
});

describe('parseCallQuery — resource filters', () => {
  it('carries agent and campaign ids through untouched', () => {
    const query = parseCallQuery({ agentId: 'agt_1', campaignId: 'cmp_1' });

    expect(query.agentId).toBe('agt_1');
    expect(query.campaignId).toBe('cmp_1');
  });

  it('treats a blank id as absent', () => {
    expect(parseCallQuery({ agentId: '  ' }).agentId).toBeNull();
  });

  it('refuses a repeated parameter rather than guessing which one was meant', () => {
    // Express parses ?agentId=a&agentId=b into an array.
    expect(reject({ agentId: ['a', 'b'] }).status).toBe(400);
  });
});
