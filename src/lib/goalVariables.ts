/**
 * The variable contract: the one reserved variable a dial of a goal campaign
 * carries, rendered from the context record. Pure and total — a render
 * failure here would be a dial that never leaves.
 *
 * One variable, sent only when a follow-up instruction exists. On a first
 * conversation the dial carries nothing from YE at all: no goal, no call
 * number, no memory paragraph. The platform then renders the block's
 * placeholder empty, and the model sees a header over nothing. Rendering a
 * sentence like "first call" instead was tried under an earlier contract and
 * the model did not act on it; an absence needs no reasoning.
 *
 * This is the value the YE-managed prompt block interpolates; the block
 * itself lives in `goalPromptBlock.ts` and must name exactly this.
 */
export const GOAL_VARIABLE_NAMES = ['next_call_instructions_vocobaseplatform'] as const;
export type GoalVariableName = (typeof GOAL_VARIABLE_NAMES)[number];

/**
 * The standing sentence that frames whatever the last call wrote: the last
 * call was incomplete, this is a follow-up, do not start over, use what
 * follows.
 *
 * YE's words, not the bot's. The bot is asked for the steps; a model also
 * asked to restate "this is a follow-up" on every call is a model that will
 * eventually not, and the one call it forgets is the one that opens cold.
 *
 * What this frame must NOT do is state the opening steps itself. That was
 * measured on 2026-09-04 (`h2h-D-menu-skip`): moving the steps here, stated
 * generically for every call, lost turn 1 in nine of sixteen drop cells. The
 * steps belong in the instructions key, where the bot writes them as concrete
 * lines for this contact and this drop.
 */
export const FOLLOW_UP_NOTE =
  'Last call was incomplete. THIS IS A FOLLOW-UP CALL. You have already spoken to this ' +
  'person before. Do not restart the conversation from scratch. Use the instructions below ' +
  'to continue from where the previous call stopped.';

/** The sentence carrying the last call's end timestamp, as the value reads
 *  it. No trailing full stop: it is a field's value rather than prose, and
 *  the model's own timestamp may end in a zone name the stop would run into. */
export function previousCallSentence(timestamp: string): string {
  return `Previous call ended at ${timestamp}`;
}

/**
 * What the render needs of the record: the instruction, which lives in
 * `memory`, and when the call that wrote it ended. The timestamp is the
 * bot's own answer to `call_end_timestamp_vocobaseplatform` on that same call
 * — paired with the instruction by attempt, so a record can never play back
 * one call's instruction under another call's clock.
 */
export interface GoalRecordSnapshot {
  memory: string | null;
  /** Raw, as the model wrote it. Null when it said nothing readable, and
   *  then the value simply carries no `previous_call_end_timestamp`: a
   *  missing field is a fact the opener does not have, where an empty one is
   *  a sentence that trails off after "at". */
  callTimestamp?: string | null;
}

export function goalVariables(
  record: GoalRecordSnapshot | null,
): Partial<Record<GoalVariableName, string>> {
  const note = record?.memory?.trim();
  // A note means a conversation happened; silences leave it null, so a retry
  // after voicemail still carries nothing and is an opening call.
  if (!note) return {};

  const timestamp = record?.callTimestamp?.trim();

  /*
   * Why YE assembles the JSON here rather than writing the frame into the
   * prompt.
   *
   * The prompt block is written once, at campaign start, and is identical for
   * every campaign and every contact — that is what lets one agent serve
   * several goal campaigns at once. A "Last call was incomplete. THIS IS A
   * FOLLOW-UP CALL" sentence sitting in the prompt would therefore stand on a
   * first call too, telling the model it has already spoken to somebody it
   * has never dialled. YE is the only party that knows which kind of call
   * this is: the record says whether a conversation happened at all. So the
   * frame, the timestamp and the bot's own steps are assembled into one value
   * here, and a first dial sends no value.
   *
   * JSON rather than concatenated prose because the bot's half is model
   * output: by design it contains double quotes, arrows and newlines — the
   * key description asks for `Step 1: "…" → if the user agrees → Step 2: "…"`.
   * `JSON.stringify` escapes all of it, so the fields cannot run together and
   * a stray quote cannot make YE's frame read as part of the model's
   * instructions.
   */
  const value = JSON.stringify(
    {
      note: FOLLOW_UP_NOTE,
      ...(timestamp ? { previous_call_end_timestamp: previousCallSentence(timestamp) } : {}),
      instructions: note,
    },
    null,
    2,
  );
  return { next_call_instructions_vocobaseplatform: value };
}
