/**
 * The platform's `end_call_reason`: one vocabulary for how a call ended, the
 * same on every carrier. Replaces `hangup_cause` (raw carrier text) and
 * `hangup_source` (per-leg attribution), both deprecated upstream.
 *
 * The values split in two. Unanswered calls resolve from the carrier
 * (BUSY … NOT_CONNECTED); answered calls resolve from the platform's own bot
 * (COMPLETED … SCREENER). SYSTEM_ERROR can come from either half. Verified
 * against the platform's `lib/end-call-reason.ts` on 2026-09-15.
 *
 * Read as free text everywhere, and every set below is an allow-list: the
 * platform says new values may be added, and an unlisted one must fall
 * through as "not one of these", never as an error.
 */

/** Upper-cased and trimmed, or null: a blank reason is no reason. */
export function normaliseEndCallReason(raw: string | null | undefined): string | null {
  const v = raw?.trim().toUpperCase();
  return v ? v : null;
}

/**
 * The carrier said the NUMBER is bad, not the moment. `INVALID_NUMBER` is
 * Q.850 1 / "unallocated" / "invalid destination"; `BLOCKED` is a carrier
 * "forbidden". Neither will complete on a later attempt either. Deliberately
 * not REJECTED (the callee declined once) or NETWORK_ERROR (the moment).
 */
const NUMBER_VERDICTS: ReadonlySet<string> = new Set(['INVALID_NUMBER', 'BLOCKED']);

export function isNumberVerdict(reason: string | null | undefined): boolean {
  const r = normaliseEndCallReason(reason);
  return r !== null && NUMBER_VERDICTS.has(r);
}

/**
 * The platform, not the carrier, ended it: a server restart, its telephony
 * wallet dry, the bot process torn down, or a connected call that failed
 * with no bot report. Beside nobody heard, the number was never tested.
 */
export function isPlatformFault(reason: string | null | undefined): boolean {
  return normaliseEndCallReason(reason) === 'SYSTEM_ERROR';
}

/**
 * Customer-facing words. The dashboard prints these and never the token —
 * the same rule `attemptReason` holds for failure sentences. COMPLETED is
 * "the assistant ended the call", which is what the platform's bot means by
 * it (`pipeline_finished`), and NOT "the call succeeded".
 */
const LABELS: Readonly<Record<string, string>> = {
  COMPLETED: 'The assistant ended the call',
  CUSTOMER_HUNG_UP: 'The customer hung up',
  TRANSFERRED: 'Transferred to a person',
  VOICEMAIL: 'Reached voicemail',
  SCREENER: 'A call screener answered',
  SYSTEM_ERROR: 'The voice platform ended the call',
  BUSY: 'The line was busy',
  NO_ANSWER: 'No answer',
  REJECTED: 'The call was declined',
  BLOCKED: 'The number is blocked',
  INVALID_NUMBER: 'Not a valid phone number',
  NETWORK_ERROR: 'The carrier could not connect the call',
  CANCELED: 'Canceled before it connected',
  NOT_CONNECTED: 'Did not connect',
  UNKNOWN: 'Not reported',
};

export function endReasonLabel(reason: string | null | undefined): string | null {
  const r = normaliseEndCallReason(reason);
  return r === null ? null : (LABELS[r] ?? null);
}
