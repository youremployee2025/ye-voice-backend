import { env } from './env.js';
import type { CallNote } from './goalRecord.js';

/**
 * Whether an incomplete conversation takes the RESUME lane.
 *
 * The one place the rule lives. The live resolution (`resolveOutcome`) and the
 * re-extraction planner (`planRearm`) both used to derive it on their own, and
 * a kill switch added to one would have left the other resuming.
 *
 * The lane is keyed on the flag the model answered, not only on the derived
 * type. `callbackType` is derived without a clock, so a time that parses but
 * cannot be booked — the echoed call-end stamp is the common one, or a year
 * the model invented — reads as `requested`; the booking will refuse it, and
 * the drop signal must not be lost to a time nobody can keep. So a derived
 * `immediate` resumes outright, and a `requested` that the flag also backs
 * resumes only when its time will not book (`bookable` is the caller's own
 * `parseCallbackAt(...).ok`).
 *
 * With `IMMEDIATE_RESUME_ENABLED` off — the default — this is false for every
 * note, and each caller falls through to the follow-up it would give a
 * `flexible`. See the flag in `env.ts` for why.
 */
export function wantsResume(note: CallNote, bookable: boolean): boolean {
  if (!env.immediateResumeEnabled) return false;

  return (
    note.outcome === 'incomplete' &&
    (note.callbackType === 'immediate' || (note.immediateCallbackNeeded === true && !bookable))
  );
}
