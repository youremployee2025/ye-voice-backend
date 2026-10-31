/**
 * The key that ties a call back to the campaign that placed it.
 *
 * A call carries no campaign id. Nowhere in the voice platform's call surface
 * is there a field for one, and there is no join to ask for. What the platform
 * offers instead is `client_reference_id`: a free-text field the *caller*
 * fills in at dial time and gets back on the call and in the completion
 * webhook. Every integrator uses it for exactly this, namespacing its own ids
 * into the string.
 *
 * So that is what this platform does too. The dialer stamps
 * `ezo:<campaignId>:<campaignContactId>`; this module reads it back.
 *
 * **Why this field and not pre-call variables.** Variables can carry the same
 * ids and are the other half of the convention, but they are returned only on
 * a call's *detail*. `client_reference_id` is on the **list** row, and a
 * listing that has to fetch a detail per row to know whose campaign a call
 * belonged to is not a listing. Anything that filters or groups by campaign
 * keys off this; variables can only decorate a call already fetched.
 *
 * **The dialer stamps it, and stamps a fourth segment.** A contact is dialed
 * once plus `Campaign.retryCount` retries, and the platform documents
 * `client_reference_id` as a per-account **idempotency key**: a repeated value
 * replays the original call instead of dialing again. A three-segment key
 * would therefore make every retry a replay of the first attempt, and retries
 * would silently never happen — a campaign reporting three attempts having
 * rung the phone once.
 *
 * So the dialer's key is `ezo:<campaignId>:<campaignContactId>:<attemptId>`,
 * and the parser accepts **three or four** segments. The call-history surface
 * reads the first two and is unchanged; only the dialer sets or reads the
 * fourth.
 */

const NAMESPACE = 'ezo';
const SEPARATOR = ':';

export interface CallCorrelation {
  campaignId: string;
  campaignContactId: string;
  /**
   * Null for a three-segment key. Only the dialer writes the fourth segment,
   * and only the dialer's own paths read it — the call-history surface asks
   * which campaign a call belonged to, which the first two segments answer.
   */
  attemptId: string | null;
}

/**
 * The key the dialer stamps into `client_reference_id` when placing a call.
 *
 * Pass the attempt id. It is optional only so that the three-segment form
 * stays expressible and testable; every call this platform places carries
 * four segments, because the platform treats a repeated reference as a request
 * to replay the original call rather than to dial again.
 */
export function formatCorrelationId(
  campaignId: string,
  campaignContactId: string,
  attemptId?: string,
): string {
  const parts = [NAMESPACE, campaignId, campaignContactId];
  if (attemptId) parts.push(attemptId);

  return parts.join(SEPARATOR);
}

/**
 * Reads our key back, or `null` for anything else.
 *
 * Strict on purpose, in both directions. The partner account is shared and
 * this field is where *every* caller puts its correlation ids, so a loose
 * parser would claim a stranger's key and attribute their call to one of our
 * campaigns — a false statement rendered as fact on a customer's screen.
 *
 * And a key with our prefix but the wrong shape is not partially read. Taking
 * the second segment of `ezo:cmp_1` as a campaign id would resolve a campaign
 * from a string that does not name a contact, which is how a malformed key
 * becomes a plausible-looking row.
 */
export function parseCorrelationId(value: unknown): CallCorrelation | null {
  if (typeof value !== 'string' || value === '') return null;

  const parts = value.split(SEPARATOR);
  // Three or four. Four is what the dialer writes; three is what the key
  // looked like before attempts existed, and calls stamped with it are still
  // in the account's history.
  if (parts.length !== 3 && parts.length !== 4) return null;

  const [namespace, campaignId, campaignContactId, attemptId] = parts;
  if (namespace !== NAMESPACE) return null;
  if (!campaignId || !campaignContactId) return null;
  // A fourth segment that is present but empty is a malformed key, not a
  // three-segment one. Reading it as three would resolve an attempt-less
  // correlation from a string that was trying to name an attempt.
  if (parts.length === 4 && !attemptId) return null;

  return { campaignId, campaignContactId, attemptId: attemptId ?? null };
}
