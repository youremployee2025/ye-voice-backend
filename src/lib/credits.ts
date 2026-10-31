/**
 * Credit units.
 *
 * Credits are held as `BigInt` with a 10000x internal multiplier, so 1 display
 * credit is 10000n and 0.01 display credits is 100n. This module is the only
 * place that multiplier appears; nothing else may scale a credit value.
 *
 * Parsing is done on the decimal string by hand rather than through `Number`.
 * `Number('0.07') * 10000` is 699.9999999999999, and rounding that back is
 * exactly the precision loss the multiplier exists to prevent — on the one
 * kind of value where being off by a hundredth is a billing dispute.
 */

/** 10^4, so the smallest representable credit is 0.0001. */
export const CREDIT_MULTIPLIER = 10_000n;

/** Decimal digits the multiplier can hold. */
const SCALE = 4;

/**
 * Postgres `int8`, which is what a `BigInt` column is.
 *
 * The regex below accepts arbitrarily many digits, so without this a validated
 * money field could still parse cleanly and then fail at the write with an
 * unhandled Prisma error — a 500 on an input the route had already promised to
 * check. Rejecting here keeps the failure a 400, where it belongs.
 */
const MAX_INTERNAL = 9_223_372_036_854_775_807n;

/**
 * A plain non-negative decimal. Deliberately narrow: no sign, no exponent, no
 * separators. `1e3` and `+1` are things a person could mean several ways, and
 * a price is not a value to guess at.
 */
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * Display credits ("500", "0.01") to internal units.
 *
 * Throws rather than returning null: every caller is either validating input
 * it is about to reject or reading a configured price at boot, and both want
 * the failure loud. A price that silently parsed to zero would rent numbers
 * out for free.
 */
export function toInternalCredits(display: string): bigint {
  const match = DECIMAL.exec(display.trim());

  if (!match) {
    throw new Error(`Not a credit amount: ${JSON.stringify(display)}`);
  }

  const [, whole, fraction = ''] = match;

  if (fraction.length > SCALE) {
    throw new Error(
      `Credit amounts carry at most ${SCALE} decimal places; got ${JSON.stringify(display)}`,
    );
  }

  const internal = BigInt(whole! + fraction.padEnd(SCALE, '0'));

  if (internal > MAX_INTERNAL) {
    throw new Error(`Credit amount is out of range: ${JSON.stringify(display)}`);
  }

  return internal;
}

/**
 * Internal units to a display string.
 *
 * A string, not a number: `BigInt` is not JSON-serializable and a float cannot
 * carry a large balance without losing the hundredths. Trailing zeros in the
 * fraction are trimmed so a whole number reads as "500" rather than "500.0000".
 */
export function toDisplayCredits(internal: bigint): string {
  // The sign is handled separately so it never lands inside the digits:
  // -1n / 10000n is 0n in BigInt division, and formatting the pieces of a
  // negative value independently produces "-0.-0001".
  const negative = internal < 0n;
  const magnitude = negative ? -internal : internal;

  const whole = magnitude / CREDIT_MULTIPLIER;
  const fraction = (magnitude % CREDIT_MULTIPLIER).toString().padStart(SCALE, '0').replace(/0+$/, '');

  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * A signed adjustment ("25", "-0.5") to internal units.
 *
 * Separate from `toInternalCredits` because a sign is meaningful in exactly one
 * place — a staff credit correction — and nowhere else. A price, a balance and
 * a charge amount are all magnitudes, and letting them parse a leading `-`
 * would turn a typo into a refund.
 *
 * Zero is rejected: it would write a ledger row that documents no change,
 * which is worse than nothing because it looks like something happened.
 */
export function parseSignedCredits(display: string): bigint {
  const trimmed = display.trim();
  const negative = trimmed.startsWith('-');
  const magnitude = toInternalCredits(negative ? trimmed.slice(1) : trimmed);

  if (magnitude === 0n) {
    throw new Error('A credit adjustment of zero changes nothing.');
  }

  return negative ? -magnitude : magnitude;
}
