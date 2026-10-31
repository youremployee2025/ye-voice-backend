import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  MAX_CONCURRENCY_LIMIT,
  MAX_DELAY_MINUTES,
  MAX_RETRY_COUNT,
  validateCallbackEnabled,
  validateConcurrencyUpdate,
  validateRetryConfig,
  validateLeadBuckets,
  validateVariableMap,
  MAX_WON_BUCKETS,
  MAX_BUCKET_NAME_CHARS,
  MAX_MAX_TOTAL_DIALS,
  MIN_MAX_TOTAL_DIALS,
  MAX_GOAL_FOLLOW_UPS_CEILING,
  MIN_FOLLOW_UP_DELAY_HOURS,
  MAX_FOLLOW_UP_DELAY_HOURS,
  MIN_IMMEDIATE_CALLBACK_MINUTES,
  MAX_IMMEDIATE_CALLBACK_MINUTES,
  validateGoalEnabled,
  validateGoalPolicy,
} from '../src/lib/campaignConfig.js';
import { ApiError } from '../src/lib/errors.js';
import { totalDialsFor } from '../src/lib/dialBudget.js';

/**
 * These validators are where "reject, don't clamp" is actually decided, so the
 * cases below pin the boundary values rather than sampling near them: a caller
 * who asked for fifty retries and silently got twenty would be billed for a
 * campaign they did not describe, and the only way that regression shows up is
 * a test that asserts the refusal.
 *
 * `concurrencyLimit` is the one field that clamps, and that is asserted just
 * as explicitly — an exception nobody wrote down becomes an inconsistency
 * somebody "fixes".
 */

function reject(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }

  throw new Error('expected the validator to refuse this input');
}

describe('validateRetryConfig', () => {
  it('treats an absent field as not supplied rather than as a reset', () => {
    expect(validateRetryConfig({})).toEqual({});
    // Explicit null is the same thing. Clearing a retry policy is not a
    // meaningful request — there is always a policy — so null is read as
    // "leave it alone" rather than as a value.
    expect(validateRetryConfig({ retryCount: null, cooldownMinutes: null })).toEqual({});
  });

  it('accepts a whole policy', () => {
    expect(
      validateRetryConfig({ retryCount: 3, cooldownMinutes: 15, retryDelaysMinutes: [5, 10, 0] }),
    ).toEqual({ retryCount: 3, cooldownMinutes: 15, retryDelaysMinutes: [5, 10, 0] });
  });

  it('accepts both ends of the retry range, 0 included', () => {
    expect(validateRetryConfig({ retryCount: 0 })).toEqual({ retryCount: 0 });
    expect(validateRetryConfig({ retryCount: MAX_RETRY_COUNT })).toEqual({ retryCount: 20 });
  });

  it('refuses a retry count outside the range, naming the field and the bounds', () => {
    for (const value of [-1, 21, 1000]) {
      expect(reject(() => validateRetryConfig({ retryCount: value })).message).toBe(
        'retryCount must be an integer between 0 and 20 (0 disables retries).',
      );
    }
  });

  it('refuses a fractional retry count', () => {
    expect(reject(() => validateRetryConfig({ retryCount: 2.5 })).status).toBe(400);
  });

  /**
   * No coercion anywhere. `"3"` is a number to `Number()` and to nobody else;
   * accepting it would mean the one field that decides how many times a
   * stranger's phone rings is decided by a type the caller did not send.
   */
  it('refuses a numeric string rather than coercing it', () => {
    expect(reject(() => validateRetryConfig({ retryCount: '3' })).status).toBe(400);
    expect(reject(() => validateRetryConfig({ cooldownMinutes: '30' })).status).toBe(400);
  });

  it('accepts both ends of the cooldown range', () => {
    expect(validateRetryConfig({ cooldownMinutes: 1 })).toEqual({ cooldownMinutes: 1 });
    expect(validateRetryConfig({ cooldownMinutes: MAX_DELAY_MINUTES })).toEqual({
      cooldownMinutes: 10080,
    });
  });

  /**
   * Zero is legal in the ladder and illegal here, and the asymmetry is the
   * point: an operator may deliberately want the first retry on the next tick
   * after a busy signal, and nobody wants that as the blanket fallback for
   * every retry a campaign ever makes.
   */
  it('refuses a zero cooldown while accepting a zero ladder entry', () => {
    expect(reject(() => validateRetryConfig({ cooldownMinutes: 0 })).message).toBe(
      'cooldownMinutes must be an integer between 1 and 10080.',
    );
    expect(validateRetryConfig({ retryDelaysMinutes: [0] })).toEqual({ retryDelaysMinutes: [0] });
  });

  it('accepts an empty ladder', () => {
    expect(validateRetryConfig({ retryDelaysMinutes: [] })).toEqual({ retryDelaysMinutes: [] });
  });

  it('refuses a ladder that is not an array', () => {
    expect(reject(() => validateRetryConfig({ retryDelaysMinutes: 5 })).message).toBe(
      'retryDelaysMinutes must be an array of integers.',
    );
    expect(reject(() => validateRetryConfig({ retryDelaysMinutes: { 0: 5 } })).status).toBe(400);
  });

  it('refuses a ladder longer than the retry ceiling', () => {
    const tooLong = Array.from({ length: MAX_RETRY_COUNT + 1 }, () => 5);

    expect(reject(() => validateRetryConfig({ retryDelaysMinutes: tooLong })).message).toBe(
      'retryDelaysMinutes must have at most 20 entries.',
    );
    expect(
      validateRetryConfig({ retryDelaysMinutes: tooLong.slice(0, MAX_RETRY_COUNT) })
        .retryDelaysMinutes,
    ).toHaveLength(20);
  });

  it('refuses a ladder entry outside the range', () => {
    for (const entry of [-1, 10081, 2.5, '5', null]) {
      expect(reject(() => validateRetryConfig({ retryDelaysMinutes: [5, entry] })).message).toBe(
        'retryDelaysMinutes entries must be integers between 0 and 10080.',
      );
    }
  });

  it('ignores a body that is not an object at all', () => {
    expect(validateRetryConfig(null)).toEqual({});
    expect(validateRetryConfig('nope')).toEqual({});
  });
});

describe('validateConcurrencyUpdate', () => {
  const current = { concurrencyLimit: 2, retryConcurrency: 0 };

  it('leaves an untouched body alone', () => {
    expect(validateConcurrencyUpdate({}, current)).toEqual({});
  });

  /**
   * The historical exception, kept deliberately. Everything else here refuses
   * an out-of-range value; this one field has always clamped, and changing
   * that would start refusing dashboards that have been sending 999 for as
   * long as the field has existed.
   */
  /**
   * The ceiling itself, asserted as a number.
   *
   * Every other test here reads the constant, so all of them would follow a
   * change to it silently. This is the one that says what the product
   * promises: a campaign may hold up to fifty simultaneous calls, bounded in
   * practice by the account's own allotment.
   */
  it('tops out at fifty simultaneous calls', () => {
    expect(MAX_CONCURRENCY_LIMIT).toBe(50);
    expect(validateConcurrencyUpdate({ concurrencyLimit: 50 }, current)).toEqual({
      concurrencyLimit: 50,
    });
  });

  it('clamps the concurrency limit rather than refusing it', () => {
    expect(validateConcurrencyUpdate({ concurrencyLimit: 999 }, current)).toEqual({
      concurrencyLimit: MAX_CONCURRENCY_LIMIT,
    });
    expect(validateConcurrencyUpdate({ concurrencyLimit: 0 }, current)).toEqual({
      concurrencyLimit: 1,
    });
    expect(validateConcurrencyUpdate({ concurrencyLimit: -5 }, current)).toEqual({
      concurrencyLimit: 1,
    });
  });

  it('still refuses a concurrency limit that is not an integer', () => {
    expect(reject(() => validateConcurrencyUpdate({ concurrencyLimit: 2.5 }, current)).message).toBe(
      'concurrencyLimit must be an integer.',
    );
    expect(reject(() => validateConcurrencyUpdate({ concurrencyLimit: '4' }, current)).status).toBe(
      400,
    );
  });

  it('accepts a retry reservation inside the merged limit', () => {
    expect(
      validateConcurrencyUpdate({ concurrencyLimit: 6, retryConcurrency: 6 }, current),
    ).toEqual({ concurrencyLimit: 6, retryConcurrency: 6 });
    expect(validateConcurrencyUpdate({ retryConcurrency: 0 }, current)).toEqual({
      retryConcurrency: 0,
    });
  });

  /**
   * Against the MERGED final state, never against the body alone. Checked
   * against the stored limit, a request that raises both would be refused for
   * a ceiling it was itself raising.
   */
  it('validates the reservation against the limit the same request sets', () => {
    expect(
      validateConcurrencyUpdate({ concurrencyLimit: 8, retryConcurrency: 7 }, current),
    ).toEqual({ concurrencyLimit: 8, retryConcurrency: 7 });

    // ...and against the stored limit when the request does not touch it.
    expect(
      reject(() => validateConcurrencyUpdate({ retryConcurrency: 5 }, current)).message,
    ).toBe('retryConcurrency must be an integer between 0 and concurrencyLimit (2).');
  });

  it('refuses a negative or fractional reservation', () => {
    expect(reject(() => validateConcurrencyUpdate({ retryConcurrency: -1 }, current)).status).toBe(
      400,
    );
    expect(reject(() => validateConcurrencyUpdate({ retryConcurrency: 1.5 }, current)).status).toBe(
      400,
    );
    expect(reject(() => validateConcurrencyUpdate({ retryConcurrency: '1' }, current)).status).toBe(
      400,
    );
  });

  /**
   * The retry share is one number and stands alone: the urgent share is
   * `100 - retrySharePercent`, so there is no second field for it to
   * contradict and nothing to merge it against.
   */
  it('accepts a retry share percent', () => {
    expect(validateConcurrencyUpdate({ retrySharePercent: 60 }, current)).toEqual({
      retrySharePercent: 60,
    });
  });

  it('refuses a share percent outside 0-100, or a fractional one', () => {
    expect(
      reject(() => validateConcurrencyUpdate({ retrySharePercent: 101 }, current)).status,
    ).toBe(400);
    expect(
      reject(() => validateConcurrencyUpdate({ retrySharePercent: 50.5 }, current)).status,
    ).toBe(400);
  });

  /**
   * Lowering the limit under a stored reservation is refused rather than
   * silently lowering the reservation with it: the reservation is a promise
   * about how the campaign shares its lines, and quietly rewriting one field
   * because another moved is how a setting stops meaning what it says.
   */
  it('refuses lowering the limit below the stored reservation, naming both', () => {
    const reserved = { concurrencyLimit: 8, retryConcurrency: 6 };

    expect(reject(() => validateConcurrencyUpdate({ concurrencyLimit: 4 }, reserved)).message).toBe(
      'concurrencyLimit (4) cannot be lower than the campaign’s retryConcurrency (6); lower retryConcurrency too.',
    );
  });

  it('accepts the same lowering when the reservation comes down with it', () => {
    const reserved = { concurrencyLimit: 8, retryConcurrency: 6 };

    expect(
      validateConcurrencyUpdate({ concurrencyLimit: 4, retryConcurrency: 3 }, reserved),
    ).toEqual({ concurrencyLimit: 4, retryConcurrency: 3 });
  });

  /**
   * A body touching neither field never errors, even over a stored pair that
   * is already inconsistent. Refusing here would make an unrelated rename fail
   * on a campaign whose numbers drifted years ago, with an error naming two
   * fields the caller never sent.
   */
  it('never errors on a body that touches neither field', () => {
    expect(validateConcurrencyUpdate({ name: 'Q3' }, { concurrencyLimit: 2, retryConcurrency: 9 }))
      .toEqual({});
  });

  it('reads the clamped limit, not the requested one, as the ceiling', () => {
    // 999 clamps to the ceiling, so a reservation AT the ceiling fits and one
    // above it does not — judged against the merged value, never the requested.
    expect(
      validateConcurrencyUpdate(
        { concurrencyLimit: 999, retryConcurrency: MAX_CONCURRENCY_LIMIT },
        current,
      ),
    ).toEqual({
      concurrencyLimit: MAX_CONCURRENCY_LIMIT,
      retryConcurrency: MAX_CONCURRENCY_LIMIT,
    });

    expect(
      reject(() =>
        validateConcurrencyUpdate(
          { concurrencyLimit: 999, retryConcurrency: MAX_CONCURRENCY_LIMIT + 1 },
          current,
        ),
      ).message,
    ).toBe(
      `retryConcurrency must be an integer between 0 and concurrencyLimit (${MAX_CONCURRENCY_LIMIT}).`,
    );
  });
});

describe('validateCallbackEnabled', () => {
  /**
   * Callbacks are on for every campaign and there is no control anywhere that
   * turns them off, so this validator writes nothing whatever it is sent. It
   * is not gone, and it is not a 400 either: a dashboard deployed either side
   * of this release still puts the field in the body, and both refusing it and
   * honouring it would be wrong — one breaks a save the operator did make, the
   * other applies a setting they cannot see or undo.
   */
  it('writes nothing, whichever boolean it is given', () => {
    expect(validateCallbackEnabled({ callbackEnabled: true })).toEqual({});
    expect(validateCallbackEnabled({ callbackEnabled: false })).toEqual({});
    expect(validateCallbackEnabled({})).toEqual({});
    expect(validateCallbackEnabled({ callbackEnabled: null })).toEqual({});
  });

  /**
   * The type is still checked, even though the value is discarded. A body
   * carrying `"false"` was assembled by something that believes it is turning
   * a setting off, and answering 200 to that is how the caller comes to
   * believe a switch exists.
   */
  it('refuses a string, a number and anything else that is not a boolean', () => {
    for (const value of ['false', 'true', 0, 1, [], {}]) {
      expect(reject(() => validateCallbackEnabled({ callbackEnabled: value })).message).toBe(
        'callbackEnabled must be a boolean.',
      );
    }
  });
});

describe('validateVariableMap', () => {
  it('accepts a flat map of column headers to variable names', () => {
    expect(validateVariableMap({ variableMap: { 'First Name': 'first_name', 'Deal $': 'deal' } }))
      .toEqual({ variableMap: { 'First Name': 'first_name', 'Deal $': 'deal' } });
  });

  it('accepts an empty map', () => {
    expect(validateVariableMap({ variableMap: {} })).toEqual({ variableMap: {} });
  });

  it('treats absence as not supplied', () => {
    expect(validateVariableMap({})).toEqual({});
  });

  /**
   * SQL NULL, not JSON null. The dispatcher's "is there a mapping" test is
   * `variableMap IS NULL`, and a JSON null answers it wrongly while looking
   * identical in every response body.
   */
  it('clears the mapping with SQL NULL when null is supplied', () => {
    expect(validateVariableMap({ variableMap: null })).toEqual({ variableMap: Prisma.DbNull });
  });

  it('refuses an array or a scalar', () => {
    for (const value of [[], ['a'], 'x', 5, true]) {
      expect(reject(() => validateVariableMap({ variableMap: value })).message).toBe(
        'variableMap must be a flat object.',
      );
    }
  });

  /**
   * Keys are free-form — they are whatever the customer's spreadsheet calls
   * its columns. Values are agent variable names, which the prompt interpolates
   * by name, so they are the half that has a grammar.
   */
  it('refuses a value that is not a usable variable name, naming the key', () => {
    expect(reject(() => validateVariableMap({ variableMap: { Name: '1st' } })).message).toBe(
      "variableMap['Name'] must be a valid agent variable name (^[a-zA-Z_][a-zA-Z0-9_]*$).",
    );

    for (const value of ['has space', 'has-dash', '', 'ü', 42, null, { a: 1 }]) {
      expect(reject(() => validateVariableMap({ variableMap: { Col: value } })).status).toBe(400);
    }
  });

  it('accepts leading underscores and digits after the first character', () => {
    expect(validateVariableMap({ variableMap: { A: '_x9', B: 'city2' } })).toEqual({
      variableMap: { A: '_x9', B: 'city2' },
    });
  });
});

/**
 * The lead-bucket settings: which extracted answer sorts this campaign's
 * contacts, and which of its values count as won.
 *
 * The key half has a grammar and the value half does not, which is the mirror
 * of `variableMap` and for the same reason. A key names something the agent
 * declares, so it can be checked; a bucket is whatever a language model
 * actually wrote in reply, and an agent that pins its answers is free not to —
 * "buckets are whatever came back" is a supported choice, so a won bucket
 * cannot be checked against a list that may not exist.
 */
describe('validateLeadBuckets', () => {
  const keys = new Set(['lead_stage', 'budget']);
  const unset = { leadBucketKey: null, wonBuckets: [] as string[] };
  const set = { leadBucketKey: 'lead_stage', wonBuckets: ['Hot'] };

  const check = (body: unknown, current = unset, agentKeys = keys) =>
    validateLeadBuckets(body, { agentKeys, current });

  it('treats absence as not supplied', () => {
    expect(check({})).toEqual({});
  });

  it('accepts a key the agent declares', () => {
    expect(check({ leadBucketKey: 'lead_stage' })).toEqual({ leadBucketKey: 'lead_stage' });
  });

  /**
   * A key the agent does not extract would bucket every contact into nothing,
   * and the campaign would report zero leads rather than an error. The refusal
   * names what is available, because the operator's next question is "then
   * what can I pick".
   */
  it('refuses a key the agent does not declare, and says which it does', () => {
    const message = reject(() => check({ leadBucketKey: 'temperature' })).message;

    expect(message).toContain("temperature");
    expect(message).toContain('budget, lead_stage');
  });

  it('refuses a key when the campaign has no agent to declare one', () => {
    expect(reject(() => check({ leadBucketKey: 'lead_stage' }, unset, new Set())).message)
      .toBe('leadBucketKey needs an agent with extraction keys. This campaign has none.');
  });

  it('refuses a key that is not a non-empty string', () => {
    for (const value of [5, true, [], {}, '']) {
      expect(reject(() => check({ leadBucketKey: value })).message)
        .toBe('leadBucketKey must be one of the agent’s extraction key names.');
    }
  });

  /** The second field in this service that can be meaningfully cleared. A
   *  campaign that stops bucketing is a real state, and it is not the same as
   *  one that never bucketed. */
  it('clears the key when null is supplied', () => {
    expect(check({ leadBucketKey: null, wonBuckets: [] }, set))
      .toEqual({ leadBucketKey: null, wonBuckets: [] });
  });

  it('keeps the won buckets in the order they were given', () => {
    expect(check({ wonBuckets: ['Hot', 'Warm'] }, set))
      .toEqual({ wonBuckets: ['Hot', 'Warm'] });
  });

  it('trims each bucket name', () => {
    expect(check({ wonBuckets: ['  Hot  '] }, set)).toEqual({ wonBuckets: ['Hot'] });
  });

  it('accepts an empty list of won buckets', () => {
    expect(check({ wonBuckets: [] }, set)).toEqual({ wonBuckets: [] });
  });

  /**
   * The readout collapses `Hot` and `hot` into one bucket, because a model
   * writing the same answer twice does not capitalise it the same way twice.
   * A list that names both promises a distinction the count does not honour.
   */
  it('refuses two won buckets that differ only in case', () => {
    expect(reject(() => check({ wonBuckets: ['Hot', 'hot'] }, set)).message)
      .toBe('wonBuckets[1] repeats “hot”. Bucket names are matched without regard to case.');
  });

  it('refuses a blank bucket name', () => {
    expect(reject(() => check({ wonBuckets: ['Hot', '   '] }, set)).message)
      .toBe('wonBuckets[1] must be a non-empty name.');
  });

  it('refuses anything but an array of strings', () => {
    for (const value of ['Hot', 5, {}, [5]]) {
      expect(() => check({ wonBuckets: value }, set)).toThrow(ApiError);
    }
  });

  it('refuses more won buckets than a readout can carry', () => {
    const many = Array.from({ length: MAX_WON_BUCKETS + 1 }, (_, i) => `b${i}`);

    expect(reject(() => check({ wonBuckets: many }, set)).message)
      .toBe(`wonBuckets takes at most ${MAX_WON_BUCKETS} names.`);
  });

  it('refuses a bucket name longer than an answer', () => {
    const long = 'x'.repeat(MAX_BUCKET_NAME_CHARS + 1);

    expect(reject(() => check({ wonBuckets: [long] }, set)).message)
      .toBe(`wonBuckets[0] is longer than ${MAX_BUCKET_NAME_CHARS} characters.`);
  });

  /**
   * Judged on the MERGED state, not on the body. A won bucket names a value of
   * the bucket key, so with no key there is nothing for it to name — and
   * silently dropping it would leave the campaign reporting no won leads with
   * a settings card that still lists them.
   */
  it('refuses won buckets on a campaign with no bucket key', () => {
    expect(reject(() => check({ wonBuckets: ['Hot'] }, unset)).message)
      .toBe('wonBuckets needs a leadBucketKey. Choose the key these buckets are values of.');
  });

  it('refuses clearing the key while its won buckets stand', () => {
    expect(reject(() => check({ leadBucketKey: null }, set)).message)
      .toBe('wonBuckets needs a leadBucketKey. Choose the key these buckets are values of.');
  });

  it('accepts won buckets set in the same request as the key they belong to', () => {
    expect(check({ leadBucketKey: 'budget', wonBuckets: ['high'] }, unset))
      .toEqual({ leadBucketKey: 'budget', wonBuckets: ['high'] });
  });

  /**
   * The bucket-key reservation is exactly the keys THIS feature manages,
   * and deliberately not every reserved name.
   *
   * `callback_at` and `callback_requested_at` were pickable as a bucket key
   * before goals existed, and a campaign storing one must go on saving: the
   * dashboard sends the whole form back on every PATCH, so widening the
   * refusal to them would 400 every subsequent edit — including a plain
   * rename — of a campaign nobody may now fix.
   */
  describe('the reserved-key refusal', () => {
    // The call-note keys a goal campaign's agent answers with — the set this
    // feature manages, and the whole of it.
    const managed = new Set([
      'call_outcome_vocobaseplatform',
      'call_outcome_reason_vocobaseplatform',
      'immediate_callback_needed_vocobaseplatform',
      'immediate_callback_needed_reason_vocobaseplatform',
      'callback_requested_time_vocobaseplatform',
      'next_call_instructions_vocobaseplatform',
    ]);

    for (const name of managed) {
      it(`refuses “${name}”, which campaign goals manage`, () => {
        const agentKeys = new Set([...keys, name]);

        expect(reject(() => check({ leadBucketKey: name }, unset, agentKeys)).message)
          .toBe(`leadBucketKey “${name}” is reserved for the campaign call note and cannot sort leads.`);
      });
    }

    /** The previous contract's verdict keys stay reserved for definition —
     *  nobody may claim a name whose meaning an earlier release fixed — but
     *  nothing manages them, so a campaign that stored one goes on saving. */
    for (const name of ['next_action', 'memory']) {
      it(`still accepts the retired “${name}” an agent may carry grandfathered`, () => {
        const agentKeys = new Set([...keys, name]);

        expect(check({ leadBucketKey: name }, unset, agentKeys)).toEqual({ leadBucketKey: name });
      });
    }

    for (const name of ['callback_at', 'callback_requested_at']) {
      it(`still accepts “${name}”, which campaigns could always bucket on`, () => {
        const agentKeys = new Set([...keys, name]);

        expect(check({ leadBucketKey: name }, unset, agentKeys)).toEqual({ leadBucketKey: name });
      });
    }
  });
});

/**
 * The goal policy's four knobs.
 *
 * Every one REJECTS rather than clamps — the file's rule, and the reason it
 * matters more here than anywhere else in it: `maxTotalDials` is a ceiling on
 * how many times a stranger's phone rings, and an operator who asked for three
 * and silently got six would have made six calls they did not describe.
 */
describe('validateGoalPolicy', () => {
  it('treats an absent field as not supplied rather than as a reset', () => {
    expect(validateGoalPolicy({})).toEqual({});
    // Explicit null is the same thing: there is always a policy, so clearing
    // one is not a meaningful request.
    expect(
      validateGoalPolicy({
        maxTotalDials: null,
        maxGoalFollowUps: null,
        followUpDelayHours: null,
        immediateCallbackMinutes: null,
        maxDialsPerDay: null,
      }),
    ).toEqual({});
  });

  it('accepts a whole policy', () => {
    expect(
      validateGoalPolicy({
        maxTotalDials: 4,
        maxGoalFollowUps: 1,
        followUpDelayHours: 6,
        immediateCallbackMinutes: 10,
      }),
    ).toEqual({
      maxTotalDials: 4,
      maxGoalFollowUps: 1,
      followUpDelayHours: 6,
      immediateCallbackMinutes: 10,
    });
  });

  describe('maxTotalDials', () => {
    it('accepts both bounds', () => {
      expect(validateGoalPolicy({ maxTotalDials: MIN_MAX_TOTAL_DIALS }).maxTotalDials).toBe(1);
      expect(validateGoalPolicy({ maxTotalDials: MAX_MAX_TOTAL_DIALS }).maxTotalDials).toBe(50);
    });

    /** Refused, never clamped: past the ceiling the Json attempt log was sized
     *  for, and past what the operator was shown. */
    it('refuses either side of them, naming the range', () => {
      for (const value of [0, -1, MAX_MAX_TOTAL_DIALS + 1, 100]) {
        expect(value).not.toBe(50);
        expect(reject(() => validateGoalPolicy({ maxTotalDials: value })).message)
          .toBe('maxTotalDials must be an integer between 1 and 50.');
      }
    });

    it('refuses a fraction and a numeric string', () => {
      for (const value of [2.5, '4', '', true, [], {}]) {
        expect(reject(() => validateGoalPolicy({ maxTotalDials: value })).message)
          .toBe('maxTotalDials must be an integer between 1 and 50.');
      }
    });
  });

  describe('maxGoalFollowUps', () => {
    /** Zero is a real setting and not an absent one: it means "one
     *  conversation and no more", which is a campaign somebody may want. */
    it('accepts zero, and says what zero means', () => {
      expect(validateGoalPolicy({ maxGoalFollowUps: 0 })).toEqual({ maxGoalFollowUps: 0 });
      expect(reject(() => validateGoalPolicy({ maxGoalFollowUps: -1 })).message)
        .toContain('0 stops after the first conversation');
    });

    /**
     * This budget is spent by somebody who has already ANSWERED, so it is
     *  deliberately smaller than the dial ceiling: a contact deep into its
     *  follow-ups is being pestered whatever the retry panel says.
     *
     * Fifteen rather than the five this shipped at, raised on request for the
     * touchbase campaigns, which were already following contacts up to
     * fourteen times under the one-budget rule — so a ceiling below that
     * could not express what those campaigns were doing. Still well below
     * `MAX_MAX_TOTAL_DIALS`, which is the property worth pinning: the moment
     * the two are equal, the follow-up budget has stopped being a narrower
     * bound than the dial ceiling and is a control that does nothing.
     */
    it('is capped at fifteen, well below the dial ceiling', () => {
      expect(MAX_GOAL_FOLLOW_UPS_CEILING).toBe(15);
      expect(MAX_GOAL_FOLLOW_UPS_CEILING).toBeLessThan(MAX_MAX_TOTAL_DIALS);
    });

    it('refuses more than fifteen', () => {
      expect(reject(() => validateGoalPolicy({ maxGoalFollowUps: 16 })).message)
        .toBe('maxGoalFollowUps must be an integer between 0 and 15 (0 stops after the first conversation).');
    });

    it('accepts the whole range', () => {
      for (const value of [0, 1, 5, 10, 15]) {
        expect(validateGoalPolicy({ maxGoalFollowUps: value })).toEqual({ maxGoalFollowUps: value });
      }
    });

    it('refuses a fraction and a numeric string', () => {
      for (const value of [1.5, '2', true]) {
        expect(reject(() => validateGoalPolicy({ maxGoalFollowUps: value })).message)
          .toContain('maxGoalFollowUps');
      }
    });
  });

  describe('maxDialsPerDay', () => {
    it('accepts 1 through 10', () => {
      for (const value of [1, 2, 10]) {
        expect(validateGoalPolicy({ maxDialsPerDay: value })).toEqual({ maxDialsPerDay: value });
      }
    });

    it.each([0, 11, 1.5, '2', true])('refuses %p', (value) => {
      expect(reject(() => validateGoalPolicy({ maxDialsPerDay: value })).message)
        .toBe('maxDialsPerDay must be an integer between 1 and 10.');
    });

    /** `null` is not a refusal here, and deliberately so: every field in this
     *  validator reads an explicit null as "leave it alone" (`supplied`), and
     *  a dashboard sending one for a field it does not draw yet must not 400. */
    it('is omitted when not supplied, and null is not supplied', () => {
      expect(validateGoalPolicy({})).toEqual({});
      expect(validateGoalPolicy({ maxDialsPerDay: null })).toEqual({});
    });
  });

  describe('followUpDelayHours', () => {
    /** Both bounds dialled explicitly: one hour is the floor because zero is a
     *  redial the instant a call hangs up, and a week is the span. */
    it('accepts both bounds', () => {
      expect(validateGoalPolicy({ followUpDelayHours: MIN_FOLLOW_UP_DELAY_HOURS })
        .followUpDelayHours).toBe(1);
      expect(validateGoalPolicy({ followUpDelayHours: MAX_FOLLOW_UP_DELAY_HOURS })
        .followUpDelayHours).toBe(168);
    });

    it('refuses either side of them, naming the range', () => {
      for (const value of [0, -1, MAX_FOLLOW_UP_DELAY_HOURS + 1]) {
        expect(reject(() => validateGoalPolicy({ followUpDelayHours: value })).message)
          .toBe('followUpDelayHours must be an integer between 1 and 168.');
      }
    });

    it('refuses a fraction and a numeric string', () => {
      for (const value of [1.5, '24', true]) {
        expect(reject(() => validateGoalPolicy({ followUpDelayHours: value })).message)
          .toContain('followUpDelayHours');
      }
    });
  });

  /**
   * The gap a dropped conversation resumes after, and the only knob in this
   * policy measured in minutes: the person is still sitting by the phone, so
   * the unit the operator types in has to be able to say "five". One minute is
   * the floor a redial needs to clear, and two hours is already a different
   * conversation rather than the same one continued.
   */
  describe('immediateCallbackMinutes', () => {
    it('accepts both bounds', () => {
      expect(validateGoalPolicy({ immediateCallbackMinutes: MIN_IMMEDIATE_CALLBACK_MINUTES })
        .immediateCallbackMinutes).toBe(1);
      expect(validateGoalPolicy({ immediateCallbackMinutes: MAX_IMMEDIATE_CALLBACK_MINUTES })
        .immediateCallbackMinutes).toBe(120);
    });

    /** 150 is in the list because a conformance scenario once seeded it — by
     *  writing the column through Prisma, which is the one path that does not
     *  come past here. A value only reachable that way is a branch production
     *  cannot enter, so the refusal is what says so. */
    it('refuses either side of them, naming the range', () => {
      for (const value of [0, -1, MAX_IMMEDIATE_CALLBACK_MINUTES + 1, 150]) {
        expect(reject(() => validateGoalPolicy({ immediateCallbackMinutes: value })).message)
          .toBe('immediateCallbackMinutes must be an integer between 1 and 120.');
      }
    });

    it('refuses a fraction and a numeric string', () => {
      for (const value of [1.5, '5', true]) {
        expect(reject(() => validateGoalPolicy({ immediateCallbackMinutes: value })).message)
          .toContain('immediateCallbackMinutes');
      }
    });
  });

  /** Meaningful before the switch is on — an operator may tune the knobs and
   *  turn it on afterwards — so nothing here reads `goalEnabled`. */
  it('never cross-references the goal switch', () => {
    expect(validateGoalPolicy({ maxTotalDials: 3, goalEnabled: true }))
      .toEqual({ maxTotalDials: 3 });
  });
});

/**
 * The goal, which is a switch.
 *
 * It was prose once, and the prose was interpolated into the agent's prompt.
 * The call-note contract stopped sending it — a dial carries one reserved
 * variable and the goal is not among them — so the only question the words
 * were left answering was whether there were any, and that is a boolean. What
 * "finished" means now lives in the agent's own prompt, which is why there is
 * nothing here to validate but the type.
 */
describe('validateGoalEnabled', () => {
  it('accepts either state and treats absence as not supplied', () => {
    expect(validateGoalEnabled({ goalEnabled: true })).toEqual({ goalEnabled: true });
    expect(validateGoalEnabled({ goalEnabled: false })).toEqual({ goalEnabled: false });
    expect(validateGoalEnabled({})).toEqual({});
    expect(validateGoalEnabled(null)).toEqual({});
    expect(validateGoalEnabled('not an object')).toEqual({});
    // `null` is not-supplied here, as it is for `callbackEnabled`: the switch
    // has two states and neither of them is absent, so a null leaves the
    // column exactly as it stands rather than choosing one.
    expect(validateGoalEnabled({ goalEnabled: null })).toEqual({});
  });

  /** The same rule `callbackEnabled` holds, and for the same reason: `"false"`
   *  is truthy, and reading it as "on" would leave the campaign chasing people
   *  the caller never asked it to chase. */
  it('refuses anything that is not a boolean', () => {
    for (const value of ['true', 'false', 1, 0, [], {}]) {
      expect(reject(() => validateGoalEnabled({ goalEnabled: value })).message)
        .toBe('goalEnabled must be a boolean.');
    }
  });

  /**
   * The deprecated prose column, accepted and ignored for one release.
   *
   * Only the dashboard ever sent it and no V2 partner surface exposes it, but
   * the two deploy independently: a 400 on an unknown field during the skew
   * would break saves for the cost of nothing. Absent from the return, it is
   * never written either — the routes spread what comes back and nothing else.
   */
  it('accepts and ignores the deprecated goal prose', () => {
    expect(validateGoalEnabled({ goal: 'Collect a budget' })).toEqual({});
    expect(validateGoalEnabled({ goal: 42 })).toEqual({});
    expect(validateGoalEnabled({ goal: null, goalEnabled: true }))
      .toEqual({ goalEnabled: true });
  });
});

describe('totalDialsFor', () => {
  /** Two lane budgets now, and this ceiling is their sum: the retries a
   *  never-reached number gets, plus the follow-ups a reached contact gets,
   *  plus the first call that starts both. */
  it('is the first call, the retries, and the follow-ups', () => {
    expect(totalDialsFor({ retryCount: 2, maxGoalFollowUps: 3 })).toBe(6);
  });

  it('ignores the stored maxTotalDials column', () => {
    expect(totalDialsFor({ retryCount: 0, maxGoalFollowUps: 0, maxTotalDials: 99 } as never)).toBe(1);
  });

  /** 20 retries + 15 follow-ups + 1 = 36, inside the fifty entries the Json
   *  attempt log is sized for. */
  it('stays inside the attempt log at both ceilings', () => {
    expect(totalDialsFor({ retryCount: MAX_RETRY_COUNT, maxGoalFollowUps: MAX_GOAL_FOLLOW_UPS_CEILING }))
      .toBeLessThanOrEqual(50);
  });
});

describe('validateVariableMap and the reserved ezo_ prefix', () => {
  it('refuses a column mapped onto a reserved name', () => {
    // The CSV column may be called anything; the VARIABLE it maps to may not
    // be one the dialer supplies. A map that won this collision would
    // silently redirect whatever a post-call action keys on it.
    expect(
      reject(() => validateVariableMap({ variableMap: { 'Campaign': 'ezo_campaign_id' } })).message,
    ).toContain('reserved');
  });

  it('refuses the prefix, not only the four names in use today', () => {
    expect(
      reject(() => validateVariableMap({ variableMap: { X: 'ezo_something_new' } })).status,
    ).toBe(400);
  });

  it('keeps accepting a name that merely begins with the same letters', () => {
    expect(validateVariableMap({ variableMap: { E: 'ezra', F: 'email' } })).toEqual({
      variableMap: { E: 'ezra', F: 'email' },
    });
  });
});
