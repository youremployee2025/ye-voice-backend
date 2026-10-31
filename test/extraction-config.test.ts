import { describe, expect, it } from 'vitest';
import {
  CALLBACK_AT_KEY,
  CALLBACK_REQUESTED_AT_KEY,
  EXTRACTION_TYPES,
  MAX_EXTRACTION_KEYS,
  MAX_EXTRACTION_KEY_DESCRIPTION_CHARS,
  MAX_EXTRACTION_KEY_VALUES,
  MAX_EXTRACTION_KEY_VALUE_CHARS,
  MAX_EXTRACTION_PROMPT_CHARS,
  extractionConfigSchema,
  storedKeyNames,
} from '../src/lib/extractionConfig.js';
import { parseBody } from '../src/lib/validate.js';

/**
 * This service's copy of the platform's post-call extraction rules.
 *
 * Every case names a rule the platform's own write validation enforces. Where
 * the two could drift, the platform's rule is the expectation written here.
 */

function config(overrides: Record<string, unknown> = {}) {
  return {
    prompt: 'Extract the following from the conversation.',
    keys: [{ name: 'intent', type: 'string' }],
    ...overrides,
  };
}

function parse(value: unknown, stored?: ReadonlySet<string>) {
  return parseBody(extractionConfigSchema(stored), value);
}

describe('the config as a whole', () => {
  it('accepts a minimal config', () => {
    expect(parse(config())).toMatchObject({
      prompt: 'Extract the following from the conversation.',
      keys: [{ name: 'intent', type: 'string' }],
    });
  });

  it('accepts null, which clears the config', () => {
    expect(parse(null)).toBeNull();
  });

  it('rejects an array', () => {
    expect(() => parse([])).toThrow();
  });

  it('rejects a config with no prompt', () => {
    const value = config();
    delete (value as Record<string, unknown>).prompt;

    expect(() => parse(value)).toThrow(/prompt/);
  });

  it(`rejects a prompt longer than ${MAX_EXTRACTION_PROMPT_CHARS} characters`, () => {
    expect(() => parse(config({ prompt: 'a'.repeat(MAX_EXTRACTION_PROMPT_CHARS + 1) }))).toThrow(
      /prompt/,
    );
  });

  it('accepts a prompt at the limit', () => {
    const prompt = 'a'.repeat(MAX_EXTRACTION_PROMPT_CHARS);

    expect(parse(config({ prompt }))?.prompt).toBe(prompt);
  });

  it('accepts an empty keys list — a prompt with nothing pinned yet', () => {
    expect(parse(config({ keys: [] }))?.keys).toEqual([]);
  });

  it(`rejects more than ${MAX_EXTRACTION_KEYS} keys`, () => {
    const keys = Array.from({ length: MAX_EXTRACTION_KEYS + 1 }, (_, index) => ({
      name: `field_${index}`,
      type: 'string',
    }));

    expect(() => parse(config({ keys }))).toThrow();
  });

  it('drops a property the platform does not accept', () => {
    const parsed = parse(config({ model: 'gpt-4' }));

    expect(parsed).not.toHaveProperty('model');
  });
});

/**
 * Two toggles, deliberately distinct and easy to conflate. `inlineEnabled`
 * says the extraction runs in the bot at the end of each call; the agent's
 * separate `extraction_enabled` says the feature is on at all.
 */
describe('inlineEnabled', () => {
  it('defaults to true when absent, so a round trip cannot silently flip it', () => {
    expect(parse(config())?.inlineEnabled).toBe(true);
  });

  it('keeps an explicit false', () => {
    expect(parse(config({ inlineEnabled: false }))?.inlineEnabled).toBe(false);
  });

  it('rejects a non-boolean', () => {
    expect(() => parse(config({ inlineEnabled: 'yes' }))).toThrow(/inlineEnabled/);
  });
});

describe('includeToolLogs', () => {
  it('is optional and absent when not given', () => {
    expect(parse(config())).not.toHaveProperty('includeToolLogs');
  });

  it('keeps an explicit value', () => {
    expect(parse(config({ includeToolLogs: true }))?.includeToolLogs).toBe(true);
  });

  it('rejects a non-boolean', () => {
    expect(() => parse(config({ includeToolLogs: 1 }))).toThrow(/includeToolLogs/);
  });
});

describe('a key', () => {
  const key = (overrides: Record<string, unknown> = {}) => ({
    name: 'intent',
    type: 'string',
    ...overrides,
  });

  it.each(['intent', '_intent', 'Intent2', 'call_back_reason'])(
    'accepts the name %o',
    (name) => {
      expect(parse(config({ keys: [key({ name })] }))?.keys[0].name).toBe(name);
    },
  );

  it.each(['2intent', 'call-back', 'call back', '', 'inténtion'])(
    'rejects the name %o',
    (name) => {
      expect(() => parse(config({ keys: [key({ name })] }))).toThrow(/name/);
    },
  );

  it('rejects duplicate names, naming the offending index', () => {
    expect(() => parse(config({ keys: [key(), key()] }))).toThrow(/1/);
  });

  it.each(EXTRACTION_TYPES)('accepts the type %o', (type) => {
    expect(parse(config({ keys: [key({ type })] }))?.keys[0].type).toBe(type);
  });

  it.each(['text', 'float', 'object', ''])('rejects the type %o', (type) => {
    expect(() => parse(config({ keys: [key({ type })] }))).toThrow(/type/);
  });

  it('rejects a missing type', () => {
    expect(() => parse(config({ keys: [{ name: 'intent' }] }))).toThrow(/type/);
  });

  it(`rejects a description longer than ${MAX_EXTRACTION_KEY_DESCRIPTION_CHARS} characters`, () => {
    const description = 'a'.repeat(MAX_EXTRACTION_KEY_DESCRIPTION_CHARS + 1);

    expect(() => parse(config({ keys: [key({ description })] }))).toThrow(/description/);
  });

  /**
   * Pinned against the number, not the constant: the cap was 500, which was a
   * sentence, and a description has to hold the rule for filling the field in.
   * A test written against the constant alone passes at any value and would
   * not notice the cap being put back.
   */
  it('accepts a description of 2000 characters', () => {
    const description = 'a'.repeat(2000);

    expect(parse(config({ keys: [key({ description })] }))?.keys[0].description).toHaveLength(
      2000,
    );
  });

  it('rejects a non-boolean analytics flag', () => {
    expect(() => parse(config({ keys: [key({ analytics: 'yes' })] }))).toThrow(/analytics/);
  });

  it('drops a property the platform does not accept', () => {
    const parsed = parse(config({ keys: [key({ required: true })] }));

    expect(parsed?.keys[0]).not.toHaveProperty('required');
  });
});

/**
 * A key's pinned answers. Present and non-empty, the model picks from the
 * list instead of inventing; absent or empty, the buckets are whatever
 * actually came back.
 */
describe('pinned answers', () => {
  const withValues = (values: unknown) =>
    config({ keys: [{ name: 'intent', type: 'string', analytics: true, values }] });

  it('preserves the order given, since the readout uses it', () => {
    const values = ['Interested', 'Not interested', 'Call back later'];

    expect(parse(withValues(values))?.keys[0].values).toEqual(values);
  });

  it(`rejects more than ${MAX_EXTRACTION_KEY_VALUES} answers`, () => {
    const values = Array.from({ length: MAX_EXTRACTION_KEY_VALUES + 1 }, (_, i) => `Answer ${i}`);

    expect(() => parse(withValues(values))).toThrow();
  });

  it.each(['', '   '])('rejects the blank answer %o', (value) => {
    expect(() => parse(withValues(['Interested', value]))).toThrow();
  });

  it(`rejects an answer longer than ${MAX_EXTRACTION_KEY_VALUE_CHARS} characters`, () => {
    expect(() => parse(withValues(['a'.repeat(MAX_EXTRACTION_KEY_VALUE_CHARS + 1)]))).toThrow();
  });

  /**
   * Matched the way the readout matches them. The chart collapses `Hot` and
   * `hot` into one bucket, so pinning both would promise a distinction that
   * is not honoured — rejected here rather than silently deduped later.
   */
  it('rejects answers differing only in case', () => {
    expect(() => parse(withValues(['Hot', 'hot']))).toThrow();
  });

  it('rejects answers differing only in surrounding whitespace', () => {
    expect(() => parse(withValues(['Hot', ' Hot ']))).toThrow();
  });

  it('trims each answer', () => {
    expect(parse(withValues(['  Interested  ']))?.keys[0].values).toEqual(['Interested']);
  });

  it('rejects a non-string answer', () => {
    expect(() => parse(withValues([1]))).toThrow();
  });
});

/**
 * `callback_at` is injected by the platform for campaign calls, so nobody may
 * newly define it. An agent that already stores it keeps it — a reservation
 * is a rule about what may be *added*, and applying it unconditionally would
 * make re-saving such an agent fail, locking its owner out of editing
 * anything else on it.
 */
describe('the reserved name', () => {
  const reserved = config({ keys: [{ name: CALLBACK_AT_KEY, type: 'datetime' }] });

  it('is rejected when nothing on the row already defines it', () => {
    expect(() => parse(reserved)).toThrow(new RegExp(CALLBACK_AT_KEY));
  });

  it('is rejected when the row stores other keys but not this one', () => {
    expect(() => parse(reserved, new Set(['intent']))).toThrow(new RegExp(CALLBACK_AT_KEY));
  });

  it('is accepted when the row already stores it', () => {
    expect(parse(reserved, new Set([CALLBACK_AT_KEY]))?.keys[0].name).toBe(CALLBACK_AT_KEY);
  });

  /**
   * YE's own callback key, attached to a campaign's agent as a managed set.
   * A key of this name defined by hand would merge ahead of the managed one and
   * silently replace its type and its description, so a campaign would go on
   * booking callbacks off whatever a differently-worded prompt returned.
   */
  describe('the key campaigns book callbacks from', () => {
    const ours = config({ keys: [{ name: CALLBACK_REQUESTED_AT_KEY, type: 'datetime' }] });

    it('is rejected, and says who reserved it', () => {
      expect(() => parse(ours)).toThrow(/campaign callbacks/);
    });

    it('is kept by an agent that already defines it', () => {
      expect(parse(ours, new Set([CALLBACK_REQUESTED_AT_KEY]))?.keys[0].name).toBe(
        CALLBACK_REQUESTED_AT_KEY,
      );
    });
  });
});

describe('storedKeyNames', () => {
  it('reads the names out of a stored config', () => {
    const stored = { prompt: 'x', keys: [{ name: 'intent' }, { name: CALLBACK_AT_KEY }] };

    expect(storedKeyNames(stored)).toEqual(new Set(['intent', CALLBACK_AT_KEY]));
  });

  it('is empty for a config that was never set', () => {
    expect(storedKeyNames(null)).toEqual(new Set());
  });

  it('is empty for a snapshot of an unexpected shape', () => {
    expect(storedKeyNames({ keys: 'nope' })).toEqual(new Set());
  });
});

describe('reserved goal keys', () => {
  it('names the seven call-note keys and the callback key as reserved', async () => {
    const { RESERVED_EXTRACTION_KEYS, GOAL_MANAGED_EXTRACTION_KEYS, CALL_NOTE_KEYS } = await import(
      '../src/lib/extractionConfig.js'
    );
    expect([...CALL_NOTE_KEYS]).toEqual([
      'call_outcome_vocobaseplatform',
      'call_outcome_reason_vocobaseplatform',
      'immediate_callback_needed_vocobaseplatform',
      'immediate_callback_needed_reason_vocobaseplatform',
      'callback_requested_time_vocobaseplatform',
      'next_call_instructions_vocobaseplatform',
      'call_end_timestamp_vocobaseplatform',
    ]);
    for (const key of CALL_NOTE_KEYS) expect(RESERVED_EXTRACTION_KEYS.has(key)).toBe(true);
    expect(RESERVED_EXTRACTION_KEYS.has('callback_requested_at')).toBe(true);
    expect(RESERVED_EXTRACTION_KEYS.has('callback_at')).toBe(true);
    expect(RESERVED_EXTRACTION_KEYS.has('do_not_call')).toBe(false);
    expect(RESERVED_EXTRACTION_KEYS.has('call_summary')).toBe(false);
    expect([...GOAL_MANAGED_EXTRACTION_KEYS]).toEqual([...CALL_NOTE_KEYS]);
  });

  /** The previous contract's five names stay reserved: an agent still carrying
   *  them is grandfathered by `stored`, and a partner cannot claim a name whose
   *  meaning an earlier release fixed. They are no longer what goals manage. */
  it('keeps the retired verdict keys reserved but not managed', async () => {
    const { RESERVED_EXTRACTION_KEYS, GOAL_MANAGED_EXTRACTION_KEYS } = await import(
      '../src/lib/extractionConfig.js'
    );
    for (const key of ['goal_achieved', 'goal_missing', 'next_action', 'next_action_reason', 'memory']) {
      expect(RESERVED_EXTRACTION_KEYS.has(key)).toBe(true);
      expect(GOAL_MANAGED_EXTRACTION_KEYS.has(key)).toBe(false);
    }
  });

  it('refuses a user-defined call-note key by name', async () => {
    const { extractionConfigSchema } = await import('../src/lib/extractionConfig.js');
    const result = extractionConfigSchema().safeParse({
      prompt: 'x',
      keys: [{ name: 'next_call_instructions_vocobaseplatform', type: 'string' }],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('reserved by campaign goals');
  });

  /**
   * The call note's own earlier key names. Reserved after each rename for the
   * sharpest reason of the lot: a partner allowed to claim one would have
   * their key merged ahead of a set an earlier release already put on the
   * agent, and the value deciding what the next call is told about the last
   * one — or when the last one was — would be theirs.
   */
  it('keeps the call note’s previous key names reserved but not managed', async () => {
    const { RESERVED_EXTRACTION_KEYS, GOAL_MANAGED_EXTRACTION_KEYS, extractionConfigSchema } =
      await import('../src/lib/extractionConfig.js');

    for (const old of [
      'context_for_next_call_vocobaseplatform',
      'memory_for_next_call_vocobaseplatform',
      'call_timestamp_vocobaseplatform',
      // Contender H's callback-type key, retired under contender I: the
      // engine derives `CallbackType` from the two plain questions instead.
      'callback_type_vocobaseplatform',
    ]) {
      expect(RESERVED_EXTRACTION_KEYS.has(old)).toBe(true);
      expect(GOAL_MANAGED_EXTRACTION_KEYS.has(old)).toBe(false);

      const result = extractionConfigSchema().safeParse({
        prompt: 'x',
        keys: [{ name: old, type: 'string' }],
      });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain('reserved by campaign goals');
    }
  });

  it('still refuses a retired verdict key by name', async () => {
    const { extractionConfigSchema } = await import('../src/lib/extractionConfig.js');
    const result = extractionConfigSchema().safeParse({
      prompt: 'x',
      keys: [{ name: 'memory', type: 'string' }],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('reserved by campaign goals');
  });
});
