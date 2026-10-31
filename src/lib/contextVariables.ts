/**
 * The campaign context every outbound dial carries, beside the note variable
 * in `goalVariables.ts`.
 *
 * Why it exists: the platform's lifecycle hooks render `{{path}}` templates
 * against the call's scope, and that scope has no idea a campaign exists. A
 * post-call action that appends the extraction to a sheet could not say which
 * campaign the row came from, and a function hook could not key its side on
 * the contact. These four make it possible without asking the platform to
 * learn what a campaign is: they are ordinary session variables, which is the
 * one channel the template scope already reads.
 *
 * **Inbound calls carry none of them.** Nothing dialled an inbound call, so
 * there is no campaign context to state; an inbound agent gets its context
 * from a pre-call lookup on `caller_phone` instead. Rendering these empty for
 * an inbound call would be worse than omitting them — a template writing a
 * blank campaign name into a sheet reads as a bug in the campaign, not as an
 * inbound call.
 *
 * Pure and total, like `goalVariables`: a render failure here would be a dial
 * that never leaves.
 */

/**
 * The reserved names, and the prefix that protects them.
 *
 * `ezo_` is reserved on every surface a variable name can be introduced from
 * — the agent's declared list and a campaign's CSV column map — because the
 * only thing that makes these trustworthy to a hook template is that nothing
 * else can be called this. A customer column named `ezo_campaign_id` that
 * won would silently redirect whatever a post-call action keys on it.
 *
 * The prefix is reserved rather than just the four names: the set will grow,
 * and a stored `variableMap` written before the fifth name existed would
 * otherwise start shadowing it on the deploy that added it.
 */
export const YE_VARIABLE_PREFIX = 'ezo_';

export const YE_CONTEXT_VARIABLE_NAMES = [
  'ezo_campaign_id',
  'ezo_campaign_name',
  'ezo_contact_id',
  'ezo_attempt_no',
] as const;

export type YeContextVariableName = (typeof YE_CONTEXT_VARIABLE_NAMES)[number];

/** Whether a name is YE's to supply, and so not the caller's to declare. */
export function isReservedVariableName(name: string): boolean {
  return name.toLowerCase().startsWith(YE_VARIABLE_PREFIX);
}

/** The sentence every surface that refuses one says, so they cannot drift. */
export const RESERVED_VARIABLE_MESSAGE =
  `Variable names starting with "${YE_VARIABLE_PREFIX}" are reserved: this platform supplies ` +
  'them on every outbound call (the campaign, the contact and the attempt number).';

export interface ContextSnapshot {
  campaign: { id: string; name: string };
  contact: { id: string };
  /** 1 for the first dial. The attempt's own ordinal, not a retry count:
   *  a reader counting calls counts from one. */
  attemptNo: number;
}

/**
 * All four, always — an outbound campaign dial is exactly the case where all
 * four are known.
 *
 * Strings, because the platform's variables are a string map and a number
 * sent as a number is a type the template renderer has to guess at. The
 * caller stringifies once, here, rather than every hook template doing it.
 */
export function contextVariables(
  snapshot: ContextSnapshot,
): Record<YeContextVariableName, string> {
  return {
    ezo_campaign_id: snapshot.campaign.id,
    ezo_campaign_name: snapshot.campaign.name,
    ezo_contact_id: snapshot.contact.id,
    ezo_attempt_no: String(snapshot.attemptNo),
  };
}
