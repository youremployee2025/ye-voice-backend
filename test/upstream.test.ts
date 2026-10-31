import { describe, expect, it } from 'vitest';
import { readArray, readDigits, readNumber, readRecord, readString, readStringArray } from '../src/lib/upstream.js';

describe('readString', () => {
  it('returns the first key that holds a non-empty string', () => {
    expect(readString({ name: 'second', agent_name: 'first' }, ['agent_name', 'name'])).toBe('first');
  });

  it('falls through to the next key when the first is absent', () => {
    expect(readString({ name: 'second' }, ['agent_name', 'name'])).toBe('second');
  });

  it('treats a blank or whitespace-only string as absent', () => {
    expect(readString({ name: '   ' }, ['name'])).toBeNull();
  });

  it('ignores a value of the wrong type rather than coercing it', () => {
    expect(readString({ name: 42 }, ['name'])).toBeNull();
  });

  it('returns null for a missing key, a null record and a non-record', () => {
    expect(readString({}, ['name'])).toBeNull();
    expect(readString(null, ['name'])).toBeNull();
    expect(readString('not a record', ['name'])).toBeNull();
  });
});

describe('readNumber', () => {
  it('returns the first finite number among the keys', () => {
    expect(readNumber({ document_count: 3 }, ['document_count', 'documentCount'])).toBe(3);
  });

  it('accepts zero, which is a real count and not an absent value', () => {
    expect(readNumber({ document_count: 0 }, ['document_count'])).toBe(0);
  });

  it('rejects NaN and Infinity', () => {
    expect(readNumber({ n: Number.NaN }, ['n'])).toBeNull();
    expect(readNumber({ n: Number.POSITIVE_INFINITY }, ['n'])).toBeNull();
  });

  it('does not parse a numeric string', () => {
    expect(readNumber({ n: '3' }, ['n'])).toBeNull();
  });

  it('returns null for a missing key or a non-record', () => {
    expect(readNumber({}, ['n'])).toBeNull();
    expect(readNumber(undefined, ['n'])).toBeNull();
  });
});

describe('readStringArray', () => {
  it('returns the string entries of an array', () => {
    expect(readStringArray({ variables: ['a', 'b'] }, ['variables'])).toEqual(['a', 'b']);
  });

  it('drops entries that are not strings', () => {
    expect(readStringArray({ variables: ['a', 7, null, 'b'] }, ['variables'])).toEqual(['a', 'b']);
  });

  it('returns an empty array when the value is absent or not an array', () => {
    expect(readStringArray({}, ['variables'])).toEqual([]);
    expect(readStringArray({ variables: 'a,b' }, ['variables'])).toEqual([]);
    expect(readStringArray(null, ['variables'])).toEqual([]);
  });
});

describe('readDigits', () => {
  it('returns a string of digits unchanged', () => {
    expect(readDigits({ did_number: '919429390403' }, ['did_number'])).toBe('919429390403');
  });

  it('reads a JSON number, which is how the platform sends a DID', () => {
    expect(readDigits({ did_number: 919429390403 }, ['did_number'])).toBe('919429390403');
    expect(readDigits({ country_code: 91 }, ['country_code'])).toBe('91');
  });

  it('refuses a non-integer rather than truncating it into another number', () => {
    expect(readDigits({ id: 1.5 }, ['id'])).toBeNull();
  });

  it('refuses an integer too large to have survived JSON parsing intact', () => {
    expect(readDigits({ id: 1e21 }, ['id'])).toBeNull();
  });

  it('refuses anything that is not entirely digits', () => {
    expect(readDigits({ n: '+91 94293' }, ['n'])).toBeNull();
    expect(readDigits({ n: '91-94293' }, ['n'])).toBeNull();
    expect(readDigits({ n: '' }, ['n'])).toBeNull();
    expect(readDigits({ n: '  ' }, ['n'])).toBeNull();
    expect(readDigits({ n: true }, ['n'])).toBeNull();
    expect(readDigits({ n: null }, ['n'])).toBeNull();
    expect(readDigits({}, ['n'])).toBeNull();
    expect(readDigits(null, ['n'])).toBeNull();
  });

  it('takes the first key that holds one', () => {
    expect(readDigits({ a: 'x', b: 7 }, ['a', 'b'])).toBe('7');
  });

  it('refuses a negative number', () => {
    expect(readDigits({ n: -91 }, ['n'])).toBeNull();
  });
});

describe('readRecord', () => {
  it('returns the first key holding a plain object', () => {
    expect(readRecord({ a: 1, session: { id: 's' } }, ['session'])).toEqual({ id: 's' });
  });

  it('does not treat an array as a record', () => {
    // The transcript field arrives as an array of turns OR an object
    // describing why there is none. Confusing the two renders a failure as a
    // conversation.
    expect(readRecord({ transcript: [{ role: 'bot' }] }, ['transcript'])).toBeNull();
  });

  it('returns null for a missing key, a null value, and a non-record source', () => {
    expect(readRecord({ transcript: null }, ['transcript'])).toBeNull();
    expect(readRecord({}, ['transcript'])).toBeNull();
    expect(readRecord(null, ['transcript'])).toBeNull();
  });
});

describe('readArray', () => {
  it('returns the first key holding an array', () => {
    expect(readArray({ calls: [1, 2] }, ['calls'])).toEqual([1, 2]);
  });

  it('distinguishes an empty array from an absent one', () => {
    expect(readArray({ calls: [] }, ['calls'])).toEqual([]);
    expect(readArray({}, ['calls'])).toBeNull();
  });

  it('does not treat a record as an array', () => {
    expect(readArray({ transcript: { error: 'x' } }, ['transcript'])).toBeNull();
  });
});
