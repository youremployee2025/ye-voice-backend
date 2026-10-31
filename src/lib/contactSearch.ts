import type { Prisma } from '@prisma/client';
import { canonicalizeE164 } from './phone.js';

/**
 * The shortest run of digits that is treated as a phone fragment at all.
 *
 * `contains` on one or two digits is not a search: `0` is inside most stored
 * numbers, so it answers the roster and calls it a result. Below this the
 * digits are left to the name half, where they still match a contact called
 * "Site 7".
 */
const MIN_PHONE_FRAGMENT = 3;

/**
 * `%` and `_` are LIKE's own wildcards, and Prisma passes the value of
 * `contains` into the pattern without escaping them. Unescaped, a lone `%`
 * typed in the box is `ILIKE '%%%'` — every named contact on the campaign,
 * returned under a `total` that agrees, which reads as a search result rather
 * than as the whole roster.
 *
 * Postgres LIKE takes backslash as its escape by default, and the pattern is
 * always `%…%`, so a trailing backslash escapes the appended `%` rather than
 * dangling at the end of the pattern.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * What an operator typed in a contact search box, as a filter over `Contact`.
 *
 * **Phone first, and forgiving about how a phone is written.** Numbers are
 * stored E.164 (`+919320333688`) and arrive in the box any other way: off a
 * spreadsheet with spaces, off a caller ID with brackets, dictated with dashes,
 * with or without the country code, and often with the national trunk zero an
 * Indian operator says out loud. Matched as typed, every one of those returns
 * "no contacts" for a number that is plainly on the list — which reads as a
 * broken list rather than as a box being fussy.
 *
 * So the query is read at two confidences, and they are not mixed:
 *
 * **A number that names its own country is matched whole.** Anything the
 * shared `canonicalizeE164` accepts — the same parser every number *entering*
 * the system is stored through — is compared against the stored E.164 exactly.
 * That is what makes `+44 (0)7911 123456` find `+447911123456`: the trunk zero
 * sits after the country code, where no amount of stripping at the front of
 * the string reaches it, and libphonenumber already knows it is a dialling
 * instruction rather than a digit. Searching with a hand-rolled regex while
 * storing with a real parser is what made those numbers unfindable.
 *
 * Matching them whole is also what stops a country code standing in for
 * somebody else's digits: `+919876543210` *contains* the US number
 * `19876543210`, so a substring search for a US contact answers an Indian one.
 *
 * **Anything else is a fragment**, and fragments stay substrings — a remembered
 * `33688` is a search of its own, and a bare national number finds its contact
 * whatever country code was stored in front of it. The trunk zero is offered
 * both ways here too, since a fragment carries no country to place it against.
 *
 * The name half is a case-insensitive substring, which is what every other
 * list in this service means by search. Email is deliberately not searched:
 * the column is optional, mostly empty on imported rows, and a hit on it would
 * be a row the operator cannot see the reason for.
 *
 * Returns `null` only for a query with no digits and no text left to match on,
 * so a caller spreads it rather than filtering on an empty `OR` — which Prisma
 * reads as "match nothing" and would answer an empty roster.
 */
export function contactSearchFilter(search: string): Prisma.ContactWhereInput | null {
  const text = search.trim();
  const digits = text.replace(/\D/g, '');

  const or: Prisma.ContactWhereInput[] = [];

  // A query that spells out its own country is a claim about WHICH country,
  // and is never matched loosely. A bare national string is not such a claim:
  // '+' is what separates "this is the number" from "these are some of its
  // digits".
  const international = text.startsWith('+') || text.startsWith('00');

  if (international) {
    const canonical = canonicalizeE164(text);

    if (canonical) {
      or.push({ phone: canonical });
    } else if (digits.length >= MIN_PHONE_FRAGMENT) {
      /*
       * A number the parser will not accept — half-typed, or a real number
       * whose country the library does not believe in (`+1 987` is not an
       * allocated US area code, and `+1-987-654-3210` is exactly the search
       * that an unanchored substring answers with `+919876543210`). Anchored
       * at the front, so a country code can never stand in for another
       * country's digits, and still a prefix, so typing one is a search.
       */
      or.push({ phone: { startsWith: `+${digits}` } });
    }
  } else if (digits.length >= MIN_PHONE_FRAGMENT) {
    or.push({ phone: { contains: digits } });

    // A trunk zero at the front of a national fragment ('09320333688'), and
    // one written after a country code the fragment carries without a '+'
    // ('44 (0)7911...'), which the leading strip cannot reach.
    for (const variant of [digits.replace(/^0+/, ''), digits.replace(/^(\d{1,3})0+/, '$1')]) {
      if (variant.length >= MIN_PHONE_FRAGMENT && variant !== digits) {
        or.push({ phone: { contains: variant } });
      }
    }
  }

  if (text) or.push({ name: { contains: escapeLike(text), mode: 'insensitive' } });

  return or.length > 0 ? { OR: or } : null;
}
