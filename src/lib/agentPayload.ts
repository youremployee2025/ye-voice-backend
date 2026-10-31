import { z } from 'zod';
import { RESERVED_VARIABLE_MESSAGE, isReservedVariableName } from './contextVariables.js';
import { canonicalizeE164 } from './phone.js';
import { extractionConfigSchema } from './extractionConfig.js';
import { transferDestinationsSchema } from './transferDestinations.js';

/**
 * This service's copy of the fields Vocobase accepts on an agent.
 *
 * Two properties matter, and neither is "validate the input" in the usual
 * sense.
 *
 * **Nothing is invented.** Every field below appears in the platform's own
 * create/update contract. A control the UI could offer but the API would
 * ignore is worse than no control: it reports success and changes nothing.
 * Adding a field here is a deliberate act, the same way adding one to
 * `VISIBLE_CONFIG_KEYS` is.
 *
 * **Nothing unaccepted is forwarded.** `language`, `status`, `document_count`
 * and the timestamps are read-only upstream — `language` follows `voice_id`,
 * the rest are platform-managed. They are stripped rather than rejected,
 * because a dashboard that round-trips an object it just read should not have
 * to remember which of its own fields are writable.
 *
 * Limits are the platform's, restated. They are here so an over-long prompt
 * fails in this process with a message naming the field, rather than spending
 * an upstream call to be told the same thing.
 */

const NAME_MAX = 50;
const PROMPT_MAX = 120_000;
const MESSAGE_MAX = 500;
const INSTRUCTIONS_MAX = 2_000;

const CALL_DURATION_MIN = 60;
const CALL_DURATION_MAX = 3_600;

const AGENT_TYPES = ['inbound', 'outbound'] as const;

/** The platform's supported set. A language outside it is a typo, not a
 *  feature request — accepting it would fail upstream with a vaguer message. */
const LANGUAGES = ['en', 'hi', 'hinglish', 'mr', 'te', 'ta', 'kn', 'ml', 'gu', 'pa', 'bn'] as const;

/** A variable name the prompt can substitute. */
const VARIABLE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** `null` is a real value on these: it means "clear what is set", which is
 *  distinct from omitting the key, which means "leave it alone". */
const message = z.string().max(MESSAGE_MAX).nullable();
const instructions = z.string().max(INSTRUCTIONS_MAX).nullable();

/**
 * A number that will be dialed, canonicalized on the way in.
 *
 * The same `canonicalizeE164` every other number in this system passes
 * through, so a transfer target cannot hold a number a campaign contact
 * could not. Canonicalizing here rather than storing what was typed keeps one
 * number from becoming two — '+91 98765 43210' and '+919876543210' are the
 * same destination, and a surface that stores both will eventually compare
 * them.
 */
const phoneNumber = z
  .string()
  .nullable()
  .transform((value, ctx) => {
    if (value === null) return null;

    const canonical = canonicalizeE164(value);
    if (canonical) return canonical;

    ctx.addIssue({
      code: 'custom',
      message: 'must be a valid phone number in E.164 form, like +919876543210.',
    });
    return z.NEVER;
  });

/** Fields both create and update accept, all optional in both. */
const optionalFields = {
  intro_message: message,
  spoken_languages: z.array(z.enum(LANGUAGES)).min(1).max(2),
  voicemail_detection_enabled: z.boolean(),
  screener_handling_enabled: z.boolean(),
  voicemail_message: message,
  project_id: z.string().min(1).nullable(),
  enable_recording: z.boolean(),
  kb_enable_llm_processing: z.boolean(),
  kb_llm_system_prompt: z.string().max(PROMPT_MAX).nullable(),
  end_call_enabled: z.boolean(),
  end_call_message: message,
  end_call_instructions: instructions,
  transfer_enabled: z.boolean(),
  transfer_number: phoneNumber,
  transfer_destinations: transferDestinationsSchema,
  transfer_message: message,
  transfer_instructions: instructions,
  user_idle_enabled: z.boolean(),
  extraction_enabled: z.boolean(),
  max_call_duration_secs: z.number().int().min(CALL_DURATION_MIN).max(CALL_DURATION_MAX).nullable(),
  background_audio_id: z.string().min(1).nullable(),
  background_audio_volume: z.number().min(0).max(1).nullable(),
};

/**
 * One definition, used by create and update alike — see the note in
 * `createAgentSchema`.
 *
 * The `ezo_` refusal is the same rule the campaign's CSV column map holds,
 * and for the same reason: the dialer stamps `ezo_campaign_id` and three
 * siblings onto every outbound campaign call, and what makes them
 * trustworthy to a post-call action's template is that nothing else can be
 * called this. Declared here as well, the name would go upstream as a
 * per-call variable and the platform would have two sources for one key.
 */
const VARIABLES = z
  .array(
    z
      .string()
      .regex(VARIABLE_NAME)
      .refine((name) => !isReservedVariableName(name), {
        message: RESERVED_VARIABLE_MESSAGE,
      }),
  )
  .max(200);

export const createAgentSchema = z
  .object({
    agent_name: z.string().min(1).max(NAME_MAX),
    prompt: z.string().min(1).max(PROMPT_MAX),
    voice_id: z.string().min(1),
    agent_type: z.enum(AGENT_TYPES),
    // Declared here as well as in `declared` below. It was in one and not the
    // other, and `.loose()` means an undeclared key is *kept* while unvalidated
    // — so a create could forward any shape at all, of any size, straight to
    // the platform, while the identical payload on update was correctly
    // refused. The two lists must agree or this file's stated invariant
    // ("nothing unaccepted is forwarded") is not true.
    variables: VARIABLES.optional(),
    ...Object.fromEntries(
      Object.entries(optionalFields).map(([key, schema]) => [key, schema.optional()]),
    ),
  })
  // Strip, not `.strict()`: the platform may add fields, and a create that
  // started failing because upstream grew a key would be a strange outage.
  .loose()
  .transform((value) => stripUnknown(value));

/**
 * Update: every field optional, at least one required.
 *
 * The "at least one" check runs **after** unknown keys are dropped, so a body
 * carrying only read-only fields is refused here rather than forwarded as an
 * empty object — which the platform rejects with a message naming nothing the
 * caller actually sent.
 */
export function updateAgentSchema(storedExtractionKeys?: ReadonlySet<string>) {
  return z
    .object({
      agent_name: z.string().min(1).max(NAME_MAX).optional(),
      prompt: z.string().min(1).max(PROMPT_MAX).optional(),
      voice_id: z.string().min(1).optional(),
      agent_type: z.enum(AGENT_TYPES).optional(),
      variables: VARIABLES.nullable().optional(),
      // Update only. The platform's create route reads `extraction_enabled`
      // and nothing else about extraction, so a create carrying a config
      // would report success and store nothing.
      extraction_config: extractionConfigSchema(storedExtractionKeys).optional(),
      ...Object.fromEntries(
        Object.entries(optionalFields).map(([key, schema]) => [key, schema.optional()]),
      ),
    })
    .loose()
    .transform((value) => stripUnknown(value, UPDATE_ONLY_FIELDS))
    .refine((value) => Object.keys(value).length > 0, {
      message: 'Provide at least one field to update.',
    });
}

/**
 * Fields the update accepts and the create does not.
 *
 * One list, consulted by `stripUnknown` and by `WRITABLE_AGENT_FIELDS`, so a
 * field cannot be writable-but-unreadable — the failure the agreement test
 * exists to catch.
 */
const UPDATE_ONLY_FIELDS = ['extraction_config'] as const;

/** Keeps only keys the schema declares — the transform that makes "stripped,
 *  not rejected" true, since `.loose()` would otherwise pass extras through. */
function stripUnknown<T extends Record<string, unknown>>(
  value: T,
  extra: readonly string[] = [],
): T {
  const declared = new Set<string>([
    'agent_name',
    'prompt',
    'voice_id',
    'agent_type',
    'variables',
    ...Object.keys(optionalFields),
    ...extra,
  ]);

  return Object.fromEntries(
    Object.entries(value).filter(([key]) => declared.has(key)),
  ) as T;
}

/**
 * Every field a workspace may write.
 *
 * Exported so a test can hold it against the read allow-list. An editable
 * field whose current value cannot be read renders blank in a form and
 * overwrites the real value on save, so the two lists must agree — and the
 * test that checks it is cheaper than remembering.
 */
export const WRITABLE_AGENT_FIELDS = [
  'agent_name',
  'prompt',
  'voice_id',
  'agent_type',
  'variables',
  ...Object.keys(optionalFields),
  ...UPDATE_ONLY_FIELDS,
] as const;

/**
 * The writable fields the platform accepts `null` for — "clear what is set",
 * as distinct from omitting the key, which means "leave it alone".
 *
 * Derived from the schema rather than listed, for the same reason
 * `WRITABLE_AGENT_FIELDS` is: a hand-kept second list drifts the moment a
 * field gains or loses its `.nullable()`, and the drift is silent. Asking the
 * schema costs one parse per field, once, at import.
 */
export const CLEARABLE_AGENT_FIELDS: ReadonlySet<string> = new Set(
  WRITABLE_AGENT_FIELDS.filter((key) => updateAgentSchema().safeParse({ [key]: null }).success),
);

export type CreateAgentInput = z.infer<typeof createAgentSchema>;
export type UpdateAgentInput = z.infer<ReturnType<typeof updateAgentSchema>>;
