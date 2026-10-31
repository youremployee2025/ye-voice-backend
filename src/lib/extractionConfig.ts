import { z } from 'zod';

/**
 * This service's copy of the platform's post-call extraction rules.
 *
 * An analysis prompt plus the fields to pull out of a finished call's
 * transcript. Restated here rather than approximated, for the same reason as
 * every other limit in this service: an invalid config fails in this process
 * with a message naming the field, instead of spending an upstream call to be
 * told the same thing less precisely.
 *
 * **Two toggles, and they are not the same switch.** The agent's own
 * `extraction_enabled` says the feature is on for this agent at all;
 * `inlineEnabled` here says the extraction runs in the bot at the end of each
 * call. Collapsing them into one control would make "on but not yet running"
 * unexpressible — and it is the state an agent is in while its config is
 * being written.
 */

export const MAX_EXTRACTION_PROMPT_CHARS = 50_000;
export const MAX_EXTRACTION_KEYS = 50;
/**
 * A key's description is the instruction the extraction model reads for that
 * one field, so it has to hold a real rule and not a label. Kept in step with
 * the platform's own cap: a description this service accepted and the platform
 * refused would fail on the upstream call, which is exactly what restating the
 * limit here exists to prevent.
 */
export const MAX_EXTRACTION_KEY_DESCRIPTION_CHARS = 2000;
/** A pinned list past this stops being a readout anyone can act on. */
export const MAX_EXTRACTION_KEY_VALUES = 40;
/** One pinned answer is a label, not a paragraph. */
export const MAX_EXTRACTION_KEY_VALUE_CHARS = 100;

export const EXTRACTION_TYPES = [
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'date',
  'datetime',
] as const;

export type ExtractionType = (typeof EXTRACTION_TYPES)[number];

/**
 * Injected by the platform on campaign calls. Nobody may newly define it —
 * see `extractionConfigSchema` for why an agent that already has one keeps it.
 */
export const CALLBACK_AT_KEY = 'callback_at';

/**
 * YE's own callback key, attached to a campaign's agent as a managed
 * extraction set at start. Reserved for the same reason as the platform's: a
 * user-defined key of this name would be merged ahead of the managed one and
 * silently replace its type and its description, so a campaign would go on
 * booking callbacks off whatever a differently-worded prompt returned.
 */
export const CALLBACK_REQUESTED_AT_KEY = 'callback_requested_at';

/**
 * The call note a goal campaign's agent returns at the end of every call,
 * attached as one managed set the way the callback key is. Six keys in the
 * platform's own vocabulary, suffixed `_vocobaseplatform` so they cannot
 * collide with anything a customer's prompt already extracts. Reserved
 * because each one is read as a decision: a user-defined outcome key would
 * decide who gets called again, and a user-defined memory key would become
 * what the next call is told about the last one.
 */
export const CALL_OUTCOME_KEY = 'call_outcome_vocobaseplatform';
export const CALL_OUTCOME_REASON_KEY = 'call_outcome_reason_vocobaseplatform';
/**
 * Contender I's two plain questions, which `readCallNote` derives
 * `CallbackType` from instead of reading a `callback_type` the model chose
 * from a three-way list. Shipped as strings pinned to `yes`/`no` rather than
 * as the platform's `boolean` type — see the operator note in the PR body —
 * so `readCallNote` also accepts JSON `true`/`false` in case the operator
 * later changes the platform type.
 */
export const IMMEDIATE_CALLBACK_NEEDED_KEY = 'immediate_callback_needed_vocobaseplatform';
export const IMMEDIATE_CALLBACK_NEEDED_REASON_KEY = 'immediate_callback_needed_reason_vocobaseplatform';
export const CALLBACK_REQUESTED_TIME_KEY = 'callback_requested_time_vocobaseplatform';
/**
 * What the last call left for the next one: a short account of the
 * conversation and where it should resume, not a script for the next agent
 * to recite. The standing order — that this is a continuation, and the three
 * steps it opens with — is YE's own words now, wrapped around this value at
 * dial time (`goalVariables.ts`), because a model asked to restate the order
 * on every call is a model that will eventually not.
 *
 * The name is the first thing the model reads about a field:
 * `next_call_instructions_…` asked for a script and got one, and the script
 * competed with the standing order rather than feeding it.
 */
export const NEXT_CALL_INSTRUCTIONS_KEY = 'next_call_instructions_vocobaseplatform';

/**
 * When this call **ended**, in the model's own words and the design's
 * `YYYY-MM-DDTHH:mm±HH` shape. Asked of the bot rather than taken from YE's
 * clock because it is the bot that was told the current date, time and zone
 * in its system instruction, so its answer is in the same frame as the
 * callback time beside it — and the callback time is now scheduled from this
 * value rather than from the prompt's clock, so the two must share a frame.
 * It is played back to the next call so the opener can say when the last one
 * was; a value YE cannot read is simply not played back.
 *
 * The end of the call, not "the current call": the earlier wording left the
 * model to pick an instant from a conversation that spans minutes, and the
 * only instant the callback arithmetic can be anchored to is the last one.
 */
export const CALL_END_TIMESTAMP_KEY = 'call_end_timestamp_vocobaseplatform';

export const CALL_NOTE_KEYS = [
  CALL_OUTCOME_KEY,
  CALL_OUTCOME_REASON_KEY,
  IMMEDIATE_CALLBACK_NEEDED_KEY,
  IMMEDIATE_CALLBACK_NEEDED_REASON_KEY,
  CALLBACK_REQUESTED_TIME_KEY,
  NEXT_CALL_INSTRUCTIONS_KEY,
  CALL_END_TIMESTAMP_KEY,
] as const;

/** What `call_outcome` may say. A prompt instruction, not a schema enum —
 *  the model may answer null or anything else, and that is "no outcome". */
export const CALL_OUTCOMES = ['incomplete', 'stop', 'completed'] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

/**
 * `CallNote.callbackType`'s own vocabulary. No longer read off an extraction
 * key — contender I removed `callback_type_vocobaseplatform` from the live
 * contract — but still the shape `readCallNote` derives from
 * `immediate_callback_needed_vocobaseplatform` and
 * `callback_requested_time_vocobaseplatform`, and still the shape carried on
 * `attemptLog`, the journey API and the dashboard's `JourneyGoal` type, so
 * every downstream reader keeps working unchanged.
 */
export const CALLBACK_TYPES = ['requested', 'immediate', 'flexible'] as const;
export type CallbackType = (typeof CALLBACK_TYPES)[number];

/**
 * The previous contract's verdict keys. Still reserved — an agent that
 * carries them is grandfathered through `stored`, and a partner may not
 * claim a name whose meaning an earlier release fixed — but no longer
 * managed: nothing attaches them and nothing reads them. Not exported:
 * the only surface that may know these names is the reservation map below,
 * and a name exported is a name something will eventually read again.
 */
const RETIRED_GOAL_VERDICT_KEYS = [
  'goal_achieved',
  'goal_missing',
  'next_action',
  'next_action_reason',
  'memory',
] as const;

/**
 * Contender H's callback-type key, READ but never attached. A note written
 * under H or G carries this and none of contender I's keys, and `readCallNote`
 * judges it by the contract it was written under — see `deriveCallbackType`
 * in `goalRecord.ts`. Retired below, so no configuration can name it.
 */
export const LEGACY_CALLBACK_TYPE_KEY = 'callback_type_vocobaseplatform';

/**
 * The call note's own earlier key names — the first two for
 * `NEXT_CALL_INSTRUCTIONS_KEY`, the third for `CALL_END_TIMESTAMP_KEY`.
 * Reserved for the same reason as the verdict keys, and more sharply: an
 * agent that ran a note campaign under an earlier release still has a set
 * defining one of them, and a partner allowed to claim the name would have a
 * key of theirs merged ahead of it — deciding what the next call is told
 * about the last one, or when the last one was. Each of these briefly had a
 * meaning a release fixed, which is what makes it unclaimable; not managed,
 * because nothing attaches them. `readCallNote` reads none of them but the
 * legacy callback type, and that only off a note written before contender I.
 */
const RETIRED_CALL_NOTE_KEYS = [
  'context_for_next_call_vocobaseplatform',
  'memory_for_next_call_vocobaseplatform',
  'call_timestamp_vocobaseplatform',
  // Contender H's callback-type key. Contender I derives `CallbackType`
  // instead of asking for it, so nothing attaches this name any more; it is
  // read only off a note written under H or G (`LEGACY_CALLBACK_TYPE_KEY`),
  // and it briefly had a meaning a release fixed, so it stays reserved.
  LEGACY_CALLBACK_TYPE_KEY,
] as const;

/**
 * The dashboard's four-word vocabulary for what a call decided. No longer an
 * extraction value — the bot answers the five call-note keys — but the
 * journey and the contacts list still show one of these, derived by
 * `nextActionOf` in `goalRecord.ts`, so the labels need not change in the
 * same release as the contract.
 */
export const NEXT_ACTIONS = ['done', 'call_again', 'call_back_at', 'stop'] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];

/** Name → who reserved it, because they are reserved by different parties
 *  and a customer reading the refusal should learn which. */
const RESERVED_KEY_NAMES: ReadonlyMap<string, string> = new Map([
  [CALLBACK_AT_KEY, 'the voice platform'],
  [CALLBACK_REQUESTED_AT_KEY, 'campaign callbacks'],
  ...CALL_NOTE_KEYS.map((key) => [key, 'campaign goals'] as const),
  ...RETIRED_GOAL_VERDICT_KEYS.map((key) => [key, 'campaign goals'] as const),
  ...RETIRED_CALL_NOTE_KEYS.map((key) => [key, 'campaign goals'] as const),
]);

/**
 * Every reserved name, for the surfaces that refuse them wholesale — a
 * campaign's `leadBucketKey` names what a call collected, and letting it name
 * a managed bookkeeping key would make the campaign's lead sort a fact about
 * the machinery rather than about the person.
 */
export const RESERVED_EXTRACTION_KEYS: ReadonlySet<string> = new Set(RESERVED_KEY_NAMES.keys());

/**
 * The subset campaign **goals** manage, and the only names `leadBucketKey`
 * refuses.
 *
 * Narrower than `RESERVED_EXTRACTION_KEYS` on purpose. The two callback keys
 * have been pickable as a bucket key since buckets shipped, and a campaign
 * storing one has to go on saving: the dashboard sends the whole form back on
 * every PATCH, so refusing them would 400 every later edit — a rename
 * included — of a campaign whose stored value the operator cannot change
 * without the very request being refused.
 */
export const GOAL_MANAGED_EXTRACTION_KEYS: ReadonlySet<string> = new Set(CALL_NOTE_KEYS);

/** The platform's variable-name shape: an identifier, not prose. */
const NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface ExtractionKey {
  name: string;
  type: ExtractionType;
  description?: string;
  /** Marks the key as choosable as a campaign's lead bucket. Opt-in, because
   *  most extracted fields are not a sortable dimension. */
  analytics?: boolean;
  /** The answers this key is pinned to, in the order the readout shows them.
   *  Absent or empty means the buckets are whatever actually came back. */
  values?: string[];
}

export interface ExtractionConfig {
  prompt: string;
  keys: ExtractionKey[];
  includeToolLogs?: boolean;
  inlineEnabled: boolean;
}

const name = z
  .string({ error: 'name is required.' })
  .refine((value) => NAME_PATTERN.test(value), {
    message: 'name must start with a letter or underscore and use only letters, digits and underscores.',
  });

/**
 * One pinned answer. Trimmed first, then measured, so trailing spaces are
 * neither a way past the length limit nor the difference between two answers.
 */
const answer = z
  .string({ error: 'each answer must be text.' })
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, { message: 'an answer cannot be empty.' })
  .refine((value) => value.length <= MAX_EXTRACTION_KEY_VALUE_CHARS, {
    message: `an answer must be at most ${MAX_EXTRACTION_KEY_VALUE_CHARS} characters.`,
  });

/**
 * Duplicates are matched the way the readout matches them — case-insensitively
 * on the trimmed value. The chart collapses `Hot` and `hot` into one bucket,
 * so pinning both would promise a distinction that is not honoured. Rejected
 * here rather than silently deduped later, because a pin that quietly loses an
 * entry is worse than one that says it cannot hold both.
 */
const answers = z
  .array(answer)
  .max(MAX_EXTRACTION_KEY_VALUES, {
    message: `A maximum of ${MAX_EXTRACTION_KEY_VALUES} pinned answers is allowed.`,
  })
  .superRefine((values, ctx) => {
    const seen = new Map<string, number>();

    values.forEach((value, index) => {
      const folded = value.toLowerCase();
      const first = seen.get(folded);
      if (first !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: `"${value}" repeats answer ${first + 1}; answers differing only in case are one bucket.`,
        });
        return;
      }
      seen.set(folded, index);
    });
  });

const extractionKey = z
  .object({
    name,
    type: z.enum(EXTRACTION_TYPES, {
      error: `type must be one of: ${EXTRACTION_TYPES.join(', ')}.`,
    }),
    description: z.string().max(MAX_EXTRACTION_KEY_DESCRIPTION_CHARS).optional(),
    analytics: z.boolean().optional(),
    values: answers.optional(),
  })
  // Stored, not proxied: an unrecognised property would be persisted verbatim
  // and travel with the agent, so it is dropped rather than kept.
  .strip();

/**
 * The config, with the reserved-name rule applied against what the row
 * already stores.
 *
 * `stored` carries the key names currently persisted on the agent. A
 * reservation is a rule about what may be **added**, so a name already on the
 * row passes. Applied unconditionally instead, re-posting an unchanged config
 * — which is what a plain Save does — would fail, locking the owner out of
 * editing anything else on that agent. Create paths pass nothing: a new row
 * has no history to grandfather.
 */
export function extractionConfigSchema(stored?: ReadonlySet<string>) {
  const grandfathered = stored ?? new Set<string>();

  return z
    .object({
      prompt: z.string({ error: 'prompt is required.' }).max(MAX_EXTRACTION_PROMPT_CHARS, {
        message: `prompt must be at most ${MAX_EXTRACTION_PROMPT_CHARS} characters.`,
      }),
      keys: z
        .array(extractionKey)
        .max(MAX_EXTRACTION_KEYS, {
          message: `A maximum of ${MAX_EXTRACTION_KEYS} fields is allowed.`,
        })
        .superRefine((keys, ctx) => {
          const seen = new Map<string, number>();

          keys.forEach((key, index) => {
            const reservedBy = RESERVED_KEY_NAMES.get(key.name);

            if (reservedBy !== undefined && !grandfathered.has(key.name)) {
              ctx.addIssue({
                code: 'custom',
                path: [index, 'name'],
                message: `name "${key.name}" is reserved by ${reservedBy}.`,
              });
            }

            const first = seen.get(key.name);
            if (first !== undefined) {
              ctx.addIssue({
                code: 'custom',
                path: [index, 'name'],
                message: `name "${key.name}" is already used by field ${first + 1}.`,
              });
              return;
            }
            seen.set(key.name, index);
          });
        }),
      includeToolLogs: z.boolean().optional(),
      // Persisted explicitly rather than left absent, so an API or UI round
      // trip cannot silently change what the platform defaults it to.
      inlineEnabled: z.boolean().default(true),
    })
    .strip()
    .nullable();
}

/**
 * The key names an agent's stored config already defines, for the grandfather
 * set above. Anything of an unexpected shape reads as no keys rather than
 * throwing: this is a cached snapshot of an upstream record, and a surface
 * that cannot read it must still let the agent be edited.
 */
export function storedKeyNames(config: unknown): ReadonlySet<string> {
  const keys =
    typeof config === 'object' && config !== null
      ? (config as { keys?: unknown }).keys
      : undefined;

  if (!Array.isArray(keys)) return new Set();

  const names = new Set<string>();
  for (const key of keys) {
    const value = typeof key === 'object' && key !== null ? (key as { name?: unknown }).name : null;
    if (typeof value === 'string') names.add(value);
  }

  return names;
}
