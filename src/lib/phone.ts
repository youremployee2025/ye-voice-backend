/**
 * The single phone-number canonicalizer. Every number entering the system
 * passes through here before it is stored.
 *
 * `/max`, deliberately — NOT the default entry point. The default ships `min`
 * metadata, whose isValid() degrades to little more than a length check in
 * several countries: with it, every 10-digit string is "valid" in India,
 * '5555555555' included, and the type is unknown. `max` carries the full
 * per-type patterns. The extra metadata is irrelevant server-side and is the
 * only reason to use a parser here rather than a regular expression.
 */
import {
  parsePhoneNumberFromString,
  isSupportedCountry,
  type CountryCode,
} from 'libphonenumber-js/max';

export type { CountryCode };

/**
 * A leading '+' is optional and may only appear at position 0. Letters,
 * extensions and an interior '+' are rejected outright rather than stripped —
 * silently deleting characters is how a label or a vanity number turns into a
 * different dial target.
 */
const HARMLESS_FORMAT = /^\+?[\d\s().-]+$/;

export function isCountryCode(value: string): value is CountryCode {
  return isSupportedCountry(value);
}

/**
 * Canonicalizes a phone number to E.164, or returns null.
 *
 * `defaultCountry` is consulted ONLY for input carrying no country of its own,
 * so it can never override an explicit country code.
 *
 * The result is gated on isValid(), not isPossible(): '+9109518550' is country
 * code +91 followed by an 8-digit stub, which satisfies the E.164 *shape* while
 * being no phone number at all. Shape is not validity, and a number that passes
 * a shape check fails later, at dial time, far from the upload that stored it.
 */
export function canonicalizeE164(raw: string, defaultCountry?: CountryCode): string | null {
  const trimmed = raw.trim();
  if (!trimmed || !HARMLESS_FORMAT.test(trimmed)) return null;

  const compact = trimmed.replace(/[\s().-]/g, '');
  if (!compact) return null;

  // '00' is the international call prefix; what follows it is E.164.
  const input = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;

  const parsed = parsePhoneNumberFromString(input, defaultCountry);
  if (parsed?.isValid()) return parsed.number;

  // Digit-only input that is really E.164 minus its '+'. Providers and
  // spreadsheet exports drop it constantly, so rejecting these would fail
  // ordinary uploads for no benefit. It does not reintroduce country
  // invention: the result must still be parser-valid, so '9109518550' ->
  // '+9109518550' stays rejected.
  if (!input.startsWith('+')) {
    const asE164 = parsePhoneNumberFromString(`+${input}`);
    if (asE164?.isValid()) return asE164.number;
  }

  return null;
}
