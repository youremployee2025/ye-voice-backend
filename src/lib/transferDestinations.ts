import { z } from 'zod';
import { canonicalizeE164 } from './phone.js';

/**
 * This service's copy of the platform's transfer-destination rules.
 *
 * A **list of named destinations** the agent's transfer tool picks between
 * mid-call. When it is non-empty the platform prefers it over the single
 * `transfer_number`; when it is empty or absent the single number is used.
 * That is a runtime preference upstream, not a write-time constraint — both
 * fields persist independently, which is what lets a workspace empty its
 * catalogue and get its single number back.
 *
 * **`null` and `[]` are different values.** `null` clears the catalogue; `[]`
 * says it was configured and then emptied. Every consumer branches on
 * `length > 0` rather than on nullness, so folding one into the other would
 * make a saved-then-emptied catalogue behave unlike one that was never set.
 *
 * Restated here rather than approximated, for the reason the rest of this
 * service restates the platform's limits: an invalid catalogue fails in this
 * process with a message naming the field and the offending entry, instead of
 * spending an upstream call to be told the same thing less precisely.
 */

export const MAX_TRANSFER_DESTINATIONS = 20;
export const MAX_DESTINATION_KEY_CHARS = 40;
export const MAX_DESTINATION_LABEL_CHARS = 100;
export const MAX_DESTINATION_DESCRIPTION_CHARS = 500;

/** The tool's enum value upstream, so it is an identifier and not prose. */
const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

export interface TransferDestination {
  /** Stable id — becomes the transfer tool's enum value. */
  key: string;
  /** Short human name, shown in the dashboard and nowhere else. */
  label: string;
  /** E.164, or a `{{variable}}` template resolved per call. */
  number: string;
  /** Tells the model *when* to pick this one. */
  llmDescription: string;
}

/**
 * A number carrying `{{` is a template. It is resolved per call against
 * session variables, so there is nothing here to canonicalize and any attempt
 * would mangle it.
 */
export function isTemplatedNumber(value: string): boolean {
  return value.includes('{{');
}

/**
 * Non-blank once trimmed, and within a limit measured on the trimmed value —
 * so trailing spaces cannot be used to smuggle a field past a length check,
 * and cannot be the difference between a valid label and an invalid one.
 */
function trimmed(max: number, field: string) {
  return z
    .string({ error: `${field} is required.` })
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, { message: `${field} cannot be empty.` })
    .refine((value) => value.length <= max, {
      message: `${field} must be at most ${max} characters.`,
    });
}

const key = trimmed(MAX_DESTINATION_KEY_CHARS, 'key').refine(
  (value) => KEY_PATTERN.test(value),
  { message: 'key must start with a letter and use only lowercase letters, digits and underscores.' },
);

/**
 * A literal is canonicalized; a template is left exactly as written.
 *
 * Gated on the same `canonicalizeE164` every other number in this system
 * passes through, so a destination cannot hold a number a campaign contact
 * could not. A number that merely passes the E.164 *shape* is not a phone
 * number, and one that fails later — at dial time, with a caller on the line —
 * is the failure this check exists to move to save time.
 */
const number = trimmed(4_096, 'number').superRefine((value, ctx) => {
  if (isTemplatedNumber(value)) return;
  if (canonicalizeE164(value)) return;

  ctx.addIssue({
    code: 'custom',
    message:
      'number must be a valid phone number in E.164 form, like +919876543210, ' +
      'or a {{template}} filled in at call time.',
  });
});

/**
 * One entry, rebuilt field by field.
 *
 * `.strip()` rather than `.loose()`, unlike the agent payload: this is a JSON
 * column re-read on every call path, and an unrecognised property would be
 * persisted verbatim and then travel with the agent forever. There is no
 * upstream-adds-a-field case to accommodate, because this shape is stored
 * rather than proxied.
 */
const destination = z
  .object({
    key,
    label: trimmed(MAX_DESTINATION_LABEL_CHARS, 'label'),
    number,
    llmDescription: trimmed(MAX_DESTINATION_DESCRIPTION_CHARS, 'llmDescription'),
  })
  .strip()
  .transform(
    (entry): TransferDestination => ({
      key: entry.key,
      label: entry.label,
      number: isTemplatedNumber(entry.number)
        ? entry.number
        : (canonicalizeE164(entry.number) ?? entry.number),
      llmDescription: entry.llmDescription,
    }),
  );

/**
 * The catalogue.
 *
 * Uniqueness is checked after each entry has been parsed, so the key compared
 * is the trimmed one that will actually be stored — checking the raw input
 * would let `"sales"` and `"sales "` through as two entries that become one.
 * The issue is attached to the offending index, because with twenty entries
 * knowing *which* one collides is most of the message's value.
 */
export const transferDestinationsSchema = z
  .array(destination)
  .max(MAX_TRANSFER_DESTINATIONS, {
    message: `A maximum of ${MAX_TRANSFER_DESTINATIONS} transfer destinations is allowed.`,
  })
  .superRefine((entries, ctx) => {
    const seen = new Map<string, number>();

    entries.forEach((entry, index) => {
      const first = seen.get(entry.key);
      if (first !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'key'],
          message: `key "${entry.key}" is already used by destination ${first + 1}.`,
        });
        return;
      }
      seen.set(entry.key, index);
    });
  })
  .nullable();
