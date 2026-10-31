import { describe, expect, it } from 'vitest';
import {
  MAX_TRANSFER_DESTINATIONS,
  MAX_DESTINATION_KEY_CHARS,
  MAX_DESTINATION_LABEL_CHARS,
  MAX_DESTINATION_DESCRIPTION_CHARS,
  transferDestinationsSchema,
} from '../src/lib/transferDestinations.js';
import { parseBody } from '../src/lib/validate.js';

/**
 * This service's copy of the platform's transfer-destination rules.
 *
 * Restated rather than approximated. Every case below names a rule the
 * platform's own write validation enforces; where the two could drift, the
 * platform's rule is the expectation written here. The point of the copy is
 * that an invalid catalogue fails in this process with a message naming the
 * field and the offending entry, rather than spending an upstream round trip
 * to be told the same thing less precisely.
 */

function destination(overrides: Record<string, unknown> = {}) {
  return {
    key: 'sales_desk',
    label: 'Sales desk',
    number: '+919876543210',
    llmDescription: 'Pricing, quotes and new business.',
    ...overrides,
  };
}

/** The schema is used as a field of a larger body, so it is parsed on its own
 *  here through the same helper the routes use. */
function parse(value: unknown) {
  return parseBody(transferDestinationsSchema, value);
}

describe('the catalogue as a whole', () => {
  it('accepts a single well-formed destination', () => {
    expect(parse([destination()])).toEqual([destination()]);
  });

  it('accepts null, which clears the catalogue', () => {
    expect(parse(null)).toBeNull();
  });

  /**
   * `[]` is a real value — "the catalogue was emptied" — and is not the same
   * claim as `null`. Folding one into the other would make an emptied
   * catalogue silently behave like one that was never configured, which is
   * exactly the distinction every consumer branches on.
   */
  it('accepts an empty array and keeps it an empty array', () => {
    expect(parse([])).toEqual([]);
  });

  it('rejects a value that is neither an array nor null', () => {
    expect(() => parse({ key: 'sales_desk' })).toThrow();
  });

  it(`rejects more than ${MAX_TRANSFER_DESTINATIONS} entries`, () => {
    const many = Array.from({ length: MAX_TRANSFER_DESTINATIONS + 1 }, (_, index) =>
      destination({ key: `desk_${index}` }),
    );

    expect(() => parse(many)).toThrow();
  });

  it(`accepts exactly ${MAX_TRANSFER_DESTINATIONS} entries`, () => {
    const many = Array.from({ length: MAX_TRANSFER_DESTINATIONS }, (_, index) =>
      destination({ key: `desk_${index}` }),
    );

    expect(parse(many)).toHaveLength(MAX_TRANSFER_DESTINATIONS);
  });

  it('preserves the order it was given, since that is the order the model sees', () => {
    const parsed = parse([
      destination({ key: 'first', label: 'First' }),
      destination({ key: 'second', label: 'Second' }),
      destination({ key: 'third', label: 'Third' }),
    ]);

    expect(parsed?.map((entry) => entry.key)).toEqual(['first', 'second', 'third']);
  });
});

describe('key', () => {
  it('rejects a missing key', () => {
    const entry = destination();
    delete (entry as Record<string, unknown>).key;

    expect(() => parse([entry])).toThrow(/key/);
  });

  it.each(['Sales', 'sales-desk', '1sales', '_sales', 'sales desk', ''])(
    'rejects the key %o',
    (key) => {
      expect(() => parse([destination({ key })])).toThrow(/key/);
    },
  );

  it.each(['s', 'sales', 'sales_desk', 'desk2', 'a1_b2'])('accepts the key %o', (key) => {
    expect(parse([destination({ key })])?.[0].key).toBe(key);
  });

  it(`rejects a key longer than ${MAX_DESTINATION_KEY_CHARS} characters`, () => {
    const key = `a${'b'.repeat(MAX_DESTINATION_KEY_CHARS)}`;

    expect(() => parse([destination({ key })])).toThrow(/key/);
  });

  /**
   * Duplicate keys are the one whole-array rule. The key becomes the tool's
   * enum value upstream, so two entries sharing one make a branch the model
   * cannot address unambiguously.
   */
  it('rejects a duplicate key, naming the offending index', () => {
    expect(() =>
      parse([destination({ key: 'sales' }), destination({ key: 'sales', label: 'Other' })]),
    ).toThrow(/1/);
  });

  it('trims surrounding whitespace from a key', () => {
    expect(parse([destination({ key: '  sales_desk  ' })])?.[0].key).toBe('sales_desk');
  });
});

describe('label', () => {
  it('rejects a missing label', () => {
    const entry = destination();
    delete (entry as Record<string, unknown>).label;

    expect(() => parse([entry])).toThrow(/label/);
  });

  it.each(['', '   '])('rejects the blank label %o', (label) => {
    expect(() => parse([destination({ label })])).toThrow(/label/);
  });

  it(`rejects a label longer than ${MAX_DESTINATION_LABEL_CHARS} characters`, () => {
    expect(() => parse([destination({ label: 'a'.repeat(MAX_DESTINATION_LABEL_CHARS + 1) })])).toThrow(
      /label/,
    );
  });

  it('trims surrounding whitespace from a label', () => {
    expect(parse([destination({ label: '  Sales desk  ' })])?.[0].label).toBe('Sales desk');
  });
});

/**
 * Required, deliberately, and unlike most optional copy on this surface.
 *
 * With no description the model has nothing but the key to choose on, and
 * picking the wrong branch — routing a caller to the wrong team, mid-call — is
 * the failure this whole feature exists to prevent.
 */
describe('llmDescription', () => {
  it('rejects a missing description', () => {
    const entry = destination();
    delete (entry as Record<string, unknown>).llmDescription;

    expect(() => parse([entry])).toThrow(/llmDescription/);
  });

  it.each(['', '   '])('rejects the blank description %o', (llmDescription) => {
    expect(() => parse([destination({ llmDescription })])).toThrow(/llmDescription/);
  });

  it(`rejects a description longer than ${MAX_DESTINATION_DESCRIPTION_CHARS} characters`, () => {
    const llmDescription = 'a'.repeat(MAX_DESTINATION_DESCRIPTION_CHARS + 1);

    expect(() => parse([destination({ llmDescription })])).toThrow(/llmDescription/);
  });
});

describe('number', () => {
  it('rejects a missing number', () => {
    const entry = destination();
    delete (entry as Record<string, unknown>).number;

    expect(() => parse([entry])).toThrow(/number/);
  });

  it.each(['', '   '])('rejects the blank number %o', (number) => {
    expect(() => parse([destination({ number })])).toThrow(/number/);
  });

  /**
   * Canonicalized at save time so operator-typed cosmetic spacing never
   * reaches the dial path — and so one number typed two ways is one number
   * rather than two.
   */
  it('canonicalizes a literal number to E.164', () => {
    expect(parse([destination({ number: '+91 98765 43210' })])?.[0].number).toBe('+919876543210');
  });

  it.each([
    ['+9109518550', 'country code followed by a stub'],
    ['not a number', 'letters'],
    ['+91 98765 4321+0', 'an interior plus'],
  ])('rejects %o — %s', (number) => {
    expect(() => parse([destination({ number })])).toThrow(/number/);
  });

  /**
   * A template resolves per call against session variables, so there is
   * nothing to canonicalize at save time and any attempt would mangle it.
   */
  it('passes a templated number through untouched', () => {
    expect(parse([destination({ number: '{{manager_phone}}' })])?.[0].number).toBe(
      '{{manager_phone}}',
    );
  });

  it('does not canonicalize a number that merely contains a template', () => {
    const number = '+91{{area_code}}43210';

    expect(parse([destination({ number })])?.[0].number).toBe(number);
  });
});

/**
 * The normalizer doubles as the property whitelist for a JSON column that is
 * re-read on every call path. Built field by field rather than spread: a
 * spread would persist whatever the caller sent verbatim.
 */
describe('unknown properties', () => {
  it('drops a property the platform does not accept', () => {
    const parsed = parse([destination({ webhook_url: 'https://example.invalid/hook' })]);

    expect(parsed?.[0]).toEqual(destination());
    expect(parsed?.[0]).not.toHaveProperty('webhook_url');
  });

  it('emits exactly the four fields the platform stores', () => {
    expect(Object.keys(parse([destination()])?.[0] ?? {}).sort()).toEqual([
      'key',
      'label',
      'llmDescription',
      'number',
    ]);
  });
});
