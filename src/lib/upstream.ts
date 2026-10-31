/**
 * Readers for values coming off Vocobase's API.
 *
 * That API mixes snake_case and camelCase between endpoints, omits fields it
 * has no value for, and occasionally sends a different type than the schema
 * suggests. Every upstream field is read through these so a shape surprise
 * degrades to a missing value instead of throwing mid-request.
 *
 * Each takes the candidate keys in preference order, so a caller can accept
 * both spellings of a field in one call.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** First key holding a non-blank string, else null. A blank string is treated
 *  as absent — upstream sends "" where it means "not set". */
export function readString(source: unknown, keys: string[]): string | null {
  const record = asRecord(source);
  if (!record) return null;

  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }

  return null;
}

/** First key holding a finite number, else null. Zero is a real value here —
 *  a document count of 0 must not read as "unknown". */
export function readNumber(source: unknown, keys: string[]): number | null {
  const record = asRecord(source);
  if (!record) return null;

  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }

  return null;
}

/** String entries of the first key holding an array, else an empty array.
 *  Callers treat "no variables" and "a malformed variables field" alike. */
export function readStringArray(source: unknown, keys: string[]): string[] {
  const record = asRecord(source);
  if (!record) return [];

  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === 'string');
    }
  }

  return [];
}

/** First key holding a real boolean, else null. Deliberately strict: upstream
 *  sends `null` for "never configured", and coercing that to `false` would
 *  report an unset integration as switched off. */
export function readBoolean(source: unknown, keys: string[]): boolean | null {
  const record = asRecord(source);
  if (!record) return null;

  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
  }

  return null;
}

/**
 * First key holding a run of digits, as a string, else null.
 *
 * Exists because the platform sends `did_number` and `country_code` as JSON
 * *numbers* — `919429390403`, not `"919429390403"` — which every other reader
 * here rejects. The result is a string because that is what a phone number is;
 * arithmetic on a dial target is never wanted.
 *
 * Strict about integers on purpose. A float would be truncated into a
 * different, valid-looking telephone number, and one past `Number.MAX_SAFE_INTEGER`
 * was already mangled by `JSON.parse` before this saw it. Both are rejected
 * rather than repaired: a wrong number is worse than a missing one, because a
 * missing one is reported and a wrong one is dialled.
 */
/**
 * First key holding something that could be a telephone number, as text.
 *
 * Distinct from `readDigits` because the two want opposite things. An id or a
 * country code is digits and nothing else, and anything looser is a shape
 * surprise worth skipping. A DID is a *number*, and upstream may reasonably
 * send it as a JSON number (`919429390403`), already in E.164
 * (`"+919429390403"`), or formatted (`"+91 94293-90403"`).
 *
 * Reading all three through `readDigits` meant the strictest of them decided
 * for the rest: a listing that switched to E.164 strings skipped every row,
 * reported `{imported: 0, skipped: N}` with a 200, and logged nothing — while
 * `canonicalizeE164`, which handles `+`, spaces, dashes and a `00` prefix
 * correctly, sat one layer down and never saw them.
 *
 * The genuine protection is kept and applies only where it belongs: a JSON
 * *number* must be a safe integer, because a float would be truncated into a
 * different, valid-looking telephone number and anything past
 * `Number.MAX_SAFE_INTEGER` was mangled by `JSON.parse` before this saw it.
 * Strings carry no such hazard — they are handed on intact and the caller's
 * canonicalizer decides whether they are a phone number at all.
 */
export function readPhoneValue(source: unknown, keys: string[]): string | null {
  const record = asRecord(source);
  if (!record) return null;

  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
      continue;
    }

    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      return String(value);
    }
  }

  return null;
}

/**
 * First key holding an opaque identifier, as text.
 *
 * Accepts a string of any shape and a safe-integer number, because an id is
 * something to match on across runs rather than something to interpret.
 * `externalId` is `String?` in the schema and would hold anything; reading it
 * through `readDigits` meant an upstream that started sending `"did_2027"` or
 * a UUID skipped every row at once, with the same silent `{skipped: N}` a
 * healthy run reports.
 */
export function readIdentifier(source: unknown, keys: string[]): string | null {
  const record = asRecord(source);
  if (!record) return null;

  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  }

  return null;
}

export function readDigits(source: unknown, keys: string[]): string | null {
  const record = asRecord(source);
  if (!record) return null;

  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (/^\d+$/.test(trimmed)) return trimmed;
      continue;
    }

    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      return String(value);
    }
  }

  return null;
}

/** First key holding a plain object, else null. Arrays are not records —
 *  the transcript field arrives as either, and they mean opposite things. */
export function readRecord(source: unknown, keys: string[]): Record<string, unknown> | null {
  const record = asRecord(source);
  if (!record) return null;

  for (const key of keys) {
    const value = asRecord(record[key]);
    if (value) return value;
  }

  return null;
}

/** First key holding an array, else null. Distinguished from "absent" so a
 *  caller can tell an empty transcript from a missing one. */
export function readArray(source: unknown, keys: string[]): unknown[] | null {
  const record = asRecord(source);
  if (!record) return null;

  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }

  return null;
}
