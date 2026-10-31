import { describe, expect, it } from 'vitest';
import {
  MAX_STORED_EXTRACTION_KEYS,
  MAX_STORED_EXTRACTION_VALUE_CHARS,
  boundExtractionValues,
} from '../src/lib/extractionCapture.js';

/**
 * What a finished call's extraction results are allowed to become in our own
 * column.
 *
 * The keys are the customer's own — no allow-list here could name them — so
 * the shape upstream sends is the shape we would store, and left alone that
 * puts the size of a row in this database in a third party's hands. Bounded on
 * the way in rather than on the way out: a read-time bound still stores the
 * blob, and the reason to bound it is that it is stored.
 */
describe('boundExtractionValues', () => {
  it('keeps a flat record of answers as they came', () => {
    expect(boundExtractionValues({ lead_stage: 'hot', budget: 50000, interested: true }))
      .toEqual({ lead_stage: 'hot', budget: 50000, interested: true });
  });

  it('reads nothing but a plain object as no answers at all', () => {
    expect(boundExtractionValues(null)).toBeNull();
    expect(boundExtractionValues(undefined)).toBeNull();
    expect(boundExtractionValues('hot')).toBeNull();
    expect(boundExtractionValues(['hot'])).toBeNull();
  });

  /** An extraction that ran and returned nothing is a real answer — the call
   *  happened and the agent found none of its keys — and it is a different
   *  fact from an extraction that never ran. */
  it('keeps an empty result as an empty record rather than as nothing', () => {
    expect(boundExtractionValues({})).toEqual({});
  });

  it('keeps structure where a key nests', () => {
    expect(boundExtractionValues({ address: { city: 'Pune' }, tags: ['a', 'b'] }))
      .toEqual({ address: { city: 'Pune' }, tags: ['a', 'b'] });
  });

  it('truncates a value too large to be anybody’s real answer, visibly', () => {
    const bounded = boundExtractionValues({ notes: 'x'.repeat(MAX_STORED_EXTRACTION_VALUE_CHARS + 50) });

    const notes = bounded!.notes as string;
    expect(notes).toHaveLength(MAX_STORED_EXTRACTION_VALUE_CHARS);
    // Visibly truncated rather than dropped: the key still says it was set.
    expect(notes.endsWith('…')).toBe(true);
  });

  it('keeps the first keys and drops the rest rather than storing an unbounded blob', () => {
    const wide = Object.fromEntries(
      Array.from({ length: MAX_STORED_EXTRACTION_KEYS + 10 }, (_, i) => [`k${i}`, i]),
    );

    expect(Object.keys(boundExtractionValues(wide)!)).toHaveLength(MAX_STORED_EXTRACTION_KEYS);
  });

  /** Not a JSON value, so Prisma will not store one — and a key present with
   *  no value is the same absence as a key that is not there. */
  it('drops a key whose value is undefined', () => {
    expect(boundExtractionValues({ lead_stage: 'hot', missing: undefined })).toEqual({
      lead_stage: 'hot',
    });
  });

  /** Upstream should never send one and might. A blob that cannot be written
   *  must not take the charge down with it. */
  it('replaces a value it cannot serialize', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(boundExtractionValues({ loop: circular })).toEqual({ loop: '[unreadable]' });
  });
});
