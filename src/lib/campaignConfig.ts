import { Prisma, type CampaignType } from '@prisma/client';
import { RESERVED_VARIABLE_MESSAGE, isReservedVariableName } from './contextVariables.js';
import { ApiError } from './errors.js';
import { GOAL_MANAGED_EXTRACTION_KEYS } from './extractionConfig.js';

/**
 * The campaign dialing-policy validators.
 *
 * **Out-of-range values are rejected, not clamped.** A caller who asked for
 * fifty retries and silently got twenty would be billed for a campaign they
 * did not describe, and would have no way to discover it short of counting
 * calls. The refusal names the field and the bounds so the caller can fix the
 * request rather than guess at it.
 *
 * There is exactly one exception, `concurrencyLimit`, and it is documented
 * where it happens.
 *
 * **Nothing is coerced.** Every check is on the value's own type, so a
 * numeric string is a refusal rather than a number. Coercion here would mean
 * the settings that decide how often a stranger's phone rings are decided by a
 * type the caller did not send — and `"false"`, which is truthy, would switch
 * callbacks on for somebody who switched them off.
 *
 * Each validator returns only the fields the body actually supplied, so one
 * function serves both create and partial update: an absent field and an
 * explicit `null` both mean "leave it alone". `variableMap` is the single
 * exception — a mapping genuinely can be cleared — and it says so below.
 */

/** Also the maximum length of the retry ladder: an entry past the last retry
 *  would describe a wait that never happens. */
export const MAX_RETRY_COUNT = 20;

/** One week, for the cooldown and for every ladder entry. */
export const MAX_DELAY_MINUTES = 10080;

export const MIN_CONCURRENCY_LIMIT = 1;
/**
 * The most simultaneous calls one campaign may hold.
 *
 * Not a capacity grant: `Account.concurrencyLimit` is what YE sells and is
 * the ceiling that actually binds, so a campaign set to fifty on an account
 * allotted eight dials eight. This number is the customer's own fairness knob
 * between their campaigns, and it is set where an operator can express what
 * their allotment already permits.
 */
export const MAX_CONCURRENCY_LIMIT = 50;

/**
 * The two concurrency columns' own defaults, mirrored here.
 *
 * A create has no stored row to merge against, and `retryConcurrency` can only
 * be judged against the limit it reserves from — so the create path needs the
 * values the database is about to supply. Kept beside the bounds they are
 * checked with, and asserted against a freshly created row in
 * `test/migration-parity.test.ts`, so a change to one without the other fails
 * rather than drifts.
 */
export const DEFAULT_CONCURRENCY_LIMIT = 2;
export const DEFAULT_RETRY_CONCURRENCY = 0;

/** What the prompt interpolator accepts as a variable name. */
export const VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function invalid(message: string): never {
  throw new ApiError(400, 'VALIDATION_ERROR', message);
}

/** A real JavaScript integer, and nothing that merely looks like one. */
function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return isInteger(value) && value >= min && value <= max;
}

/** Whether a field was supplied at all. `null` reads as "not supplied" for
 *  every field except `variableMap`, which is the only one that can be
 *  meaningfully cleared. */
function supplied(body: Record<string, unknown>, field: string): boolean {
  return body[field] !== undefined && body[field] !== null;
}

/** Bodies reach these validators straight off the request, so they may be
 *  anything at all. A non-object carries no fields, which is the same as an
 *  empty one. */
function fieldsOf(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

export const CAMPAIGN_TYPES = ['OUTBOUND', 'INBOUND', 'BOTH'] as const;

/** An INBOUND or BOTH campaign answers calls; OUTBOUND only places them. Only
 *  the first two claim DIDs and need an agent that can answer. */
export function isInboundFacing(type: CampaignType): boolean {
  return type === 'INBOUND' || type === 'BOTH';
}

/**
 * The campaign's direction.
 *
 * INBOUND/BOTH no longer require the agent to already have an inbound face.
 * A uni-directional agent answers as readily as it dials, and whether a second
 * upstream configuration exists is plumbing the backend builds when something
 * first needs it — `ensureInboundFace`, called from `runInboundStart`. What
 * stops a campaign answering with an agent that cannot answer is therefore the
 * START, which creates the face or refuses, and not this validator, which
 * would have refused the configuration that leads there. With that rule gone
 * there is nothing left to judge against — no stored type, no agent — so this
 * takes the body alone. The 422 `CAMPAIGN_AGENT_INBOUND_NOT_ENABLED` it used
 * to raise stays in the error union only so a dashboard still branching on it
 * typechecks for the release the two are out of step.
 *
 * The DRAFT-only rule is NOT enforced here — it lives in the route's
 * `changedBy`/`assertEditable` gate, alongside the agent and number locks,
 * because "may this field change now" is a status question the whole edit gate
 * answers together. This validator only decides whether a supplied value is
 * one of the three, and returns `{}` when none was supplied.
 */
export function validateCampaignType(body: unknown): { type?: CampaignType } {
  const fields = fieldsOf(body);

  let type: CampaignType | undefined;
  if (supplied(fields, 'type')) {
    if (typeof fields.type !== 'string' || !CAMPAIGN_TYPES.includes(fields.type as CampaignType)) {
      invalid(`type must be one of: ${CAMPAIGN_TYPES.join(', ')}.`);
    }
    type = fields.type as CampaignType;
  }

  return type === undefined ? {} : { type };
}

export interface RetryConfigUpdate {
  retryCount?: number;
  cooldownMinutes?: number;
  retryDelaysMinutes?: number[];
}

/**
 * The wait before the next dial of a contact that has been dialled before,
 * in minutes — the retry cooldown ladder, in ONE place.
 *
 * Element *i* of the ladder is the wait before retry *i+1*, so the index is
 * the count of retries **already consumed**, which is what
 * `CampaignContact.attempts` holds before the re-arm increments it. A ladder
 * shorter than the budget is normal; the entries that run out fall back to
 * `cooldownMinutes`.
 *
 * Two callers, deliberately sharing one function rather than one expression
 * written twice. Since 2026-09-06 a goal follow-up that is neither immediate
 * nor a promised time waits exactly what a no-answer waits: the goal stopped
 * having a delay of its own, and the only way to be sure the two cannot drift
 * apart later is for there to be a single definition of what the wait is.
 *
 * `attempts` is the retry counter and not the dial ordinal. A follow-up does
 * not spend a retry, so a contact followed up three times still indexes the
 * ladder at the retry it is actually on — which is the honest reading: the
 * ladder describes how patient to be with a number, and a conversation that
 * happened is not evidence the number is unreachable.
 */
export function retryWaitMinutes(
  campaign: { retryDelaysMinutes: readonly number[]; cooldownMinutes: number },
  attempts: number,
): number {
  return campaign.retryDelaysMinutes[attempts] ?? campaign.cooldownMinutes;
}

/**
 * The retry policy: how many retries, how long between them, and the ladder
 * that overrides the gap for the first few.
 */
export function validateRetryConfig(body: unknown): RetryConfigUpdate {
  const fields = fieldsOf(body);
  const data: RetryConfigUpdate = {};

  if (supplied(fields, 'retryCount')) {
    const value = fields.retryCount;

    if (!isIntegerInRange(value, 0, MAX_RETRY_COUNT)) {
      invalid(
        `retryCount must be an integer between 0 and ${MAX_RETRY_COUNT} (0 disables retries).`,
      );
    }

    data.retryCount = value;
  }

  if (supplied(fields, 'cooldownMinutes')) {
    const value = fields.cooldownMinutes;

    // Lower bound 1, unlike the ladder's 0. A zero fallback is the dispatcher
    // re-dialing a number the moment it hung up, for every retry a campaign
    // ever makes.
    if (!isIntegerInRange(value, 1, MAX_DELAY_MINUTES)) {
      invalid(`cooldownMinutes must be an integer between 1 and ${MAX_DELAY_MINUTES}.`);
    }

    data.cooldownMinutes = value;
  }

  if (supplied(fields, 'retryDelaysMinutes')) {
    const value = fields.retryDelaysMinutes;

    if (!Array.isArray(value)) invalid('retryDelaysMinutes must be an array of integers.');

    if (value.length > MAX_RETRY_COUNT) {
      invalid(`retryDelaysMinutes must have at most ${MAX_RETRY_COUNT} entries.`);
    }

    // 0 IS legal here: "dial again on the next tick" is a thing an operator
    // may deliberately want for the first retry after a busy signal.
    if (!value.every((entry) => isIntegerInRange(entry, 0, MAX_DELAY_MINUTES))) {
      invalid(`retryDelaysMinutes entries must be integers between 0 and ${MAX_DELAY_MINUTES}.`);
    }

    data.retryDelaysMinutes = value as number[];
  }

  return data;
}

export interface ConcurrencyUpdate {
  concurrencyLimit?: number;
  retryConcurrency?: number;
  retrySharePercent?: number;
}

/**
 * The two concurrency fields, validated against the state the update will
 * actually leave behind.
 *
 * `retryConcurrency` is a reservation *inside* `concurrencyLimit`, so the two
 * cannot be checked separately: a request raising both would otherwise be
 * refused for a ceiling it was itself raising, and a request lowering only the
 * ceiling would leave a reservation larger than the pool it reserves from.
 */
export function validateConcurrencyUpdate(
  body: unknown,
  current: { concurrencyLimit: number; retryConcurrency: number },
): ConcurrencyUpdate {
  const fields = fieldsOf(body);
  const data: ConcurrencyUpdate = {};

  if (supplied(fields, 'concurrencyLimit')) {
    const value = fields.concurrencyLimit;

    if (!isInteger(value)) invalid('concurrencyLimit must be an integer.');

    /**
     * **The one field that clamps.** Every other bound here is a refusal; this
     * one has clamped to [1,10] since the column existed, and dashboards have
     * been sending values outside it for as long. Turning that into a refusal
     * now would break callers to enforce a rule they were never told about —
     * which is a worse trade than the one the refusals elsewhere make, because
     * the range is small enough that a clamped value still describes roughly
     * the campaign that was asked for.
     */
    data.concurrencyLimit = Math.max(
      MIN_CONCURRENCY_LIMIT,
      Math.min(value, MAX_CONCURRENCY_LIMIT),
    );
  }

  /**
   * The retry share, checked entirely on its own.
   *
   * **There is no cross-field rule here, and that is the point of storing one
   * number.** The urgent lanes get `100 - retrySharePercent`, so the two
   * shares are the same fact written once and cannot be set to disagree —
   * there is no second column to merge against, nothing to re-check when a
   * neighbouring field moves, and no stored pair that can drift apart between
   * writes. Contrast `retryConcurrency` below, which reserves slots *inside*
   * `concurrencyLimit` and therefore drags the whole merged-state dance with
   * it.
   *
   * Ahead of that pair rather than beside it, because the branch below returns
   * early once it has read its field.
   */
  if (supplied(fields, 'retrySharePercent')) {
    const value = fields.retrySharePercent;

    if (!isIntegerInRange(value, 0, 100)) {
      invalid('retrySharePercent must be an integer between 0 and 100.');
    }

    data.retrySharePercent = value;
  }

  // The MERGED state: what the limit will be after this update, not what the
  // body happened to carry and not what is stored.
  const finalLimit = data.concurrencyLimit ?? current.concurrencyLimit;

  if (supplied(fields, 'retryConcurrency')) {
    const value = fields.retryConcurrency;

    if (!isIntegerInRange(value, 0, finalLimit)) {
      invalid(
        `retryConcurrency must be an integer between 0 and concurrencyLimit (${finalLimit}).`,
      );
    }

    data.retryConcurrency = value;

    return data;
  }

  /**
   * Lowering the ceiling under a reservation the caller did not touch.
   *
   * Refused rather than quietly lowering the reservation with it: the
   * reservation is a promise about how this campaign shares its lines, and
   * rewriting one field because another moved is how a setting stops meaning
   * what it says. The message names both, because the fix needs both.
   *
   * Only reachable when `concurrencyLimit` was supplied — a body touching
   * neither field never errors, even over a stored pair that already
   * disagrees. An unrelated rename must not fail on numbers that drifted long
   * before this request.
   */
  if (data.concurrencyLimit !== undefined && current.retryConcurrency > finalLimit) {
    invalid(
      `concurrencyLimit (${finalLimit}) cannot be lower than the campaign’s ` +
        `retryConcurrency (${current.retryConcurrency}); lower retryConcurrency too.`,
    );
  }

  return data;
}

/**
 * Accepted, type-checked, and never written.
 *
 * Callbacks are on for every campaign: the switch is off every screen, and the
 * `false`s that were stored are backfilled. So the only body that still
 * carries this field is one a dashboard from before that release assembled,
 * and neither of the two obvious answers is right for it. A 400 fails a save
 * the operator did make, on a field they cannot even see. Storing the value
 * leaves a campaign refusing callbacks with no control left anywhere able to
 * turn them back on — which is exactly the state the backfill existed to
 * clear, recreated one PATCH at a time.
 *
 * So the field is accepted and discarded, and the campaign keeps the `true`
 * the column defaults to. It stays on the mid-campaign allow-list for the same
 * reason: a stale form posting the whole body back should be a no-op, not a
 * 409 naming a field nobody chose to send.
 *
 * The **type** is still refused, because `"false"` is truthy and a body
 * carrying it was built by something that believes it is turning a setting
 * off. Saying so is how that gets noticed rather than silently ignored along
 * with everything else. The validator is kept whole rather than deleted, so
 * re-introducing the control is putting the write back rather than writing
 * this again.
 */
export function validateCallbackEnabled(body: unknown): { callbackEnabled?: boolean } {
  const fields = fieldsOf(body);

  if (!supplied(fields, 'callbackEnabled')) return {};

  if (typeof fields.callbackEnabled !== 'boolean') invalid('callbackEnabled must be a boolean.');

  return {};
}

export interface VariableMapUpdate {
  variableMap?: Prisma.InputJsonValue | typeof Prisma.DbNull;
}

/**
 * The CSV-column-to-agent-variable mapping.
 *
 * Keys are deliberately unrestricted: they are whatever the customer's
 * spreadsheet calls its columns, and a header with a space or a currency sign
 * in it is not an error. Values are agent variable names, which the prompt
 * interpolates by name, so they are the half that has a grammar.
 *
 * `null` is the one clear in this module, and it writes SQL NULL rather than
 * JSON `null`. The dispatcher's "is there a mapping" test is
 * `variableMap IS NULL`, and a JSON null answers it wrongly while looking
 * identical in every response body — so the translation lives here rather than
 * at each call site, where it is one forgotten conversion away from a campaign
 * that maps nothing and claims otherwise.
 */
export function validateVariableMap(body: unknown): VariableMapUpdate {
  const fields = fieldsOf(body);

  if (fields.variableMap === undefined) return {};
  if (fields.variableMap === null) return { variableMap: Prisma.DbNull };

  const map = fields.variableMap;

  if (typeof map !== 'object' || Array.isArray(map)) invalid('variableMap must be a flat object.');

  for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
    if (typeof value !== 'string' || !VARIABLE_NAME_PATTERN.test(value)) {
      invalid(
        `variableMap['${key}'] must be a valid agent variable name ` +
          '(^[a-zA-Z_][a-zA-Z0-9_]*$).',
      );
    }

    // The COLUMN may be called anything the customer's spreadsheet calls it;
    // the variable it maps to may not be one the dialer supplies. A map that
    // won this collision would silently redirect whatever a post-call action
    // keys on the name.
    if (isReservedVariableName(value)) {
      invalid(`variableMap['${key}']: ${RESERVED_VARIABLE_MESSAGE}`);
    }
  }

  return { variableMap: map as Prisma.InputJsonValue };
}

// The goal policy's bounds, and the three settings they bound are no longer
// one thing. `maxTotalDials` and `immediateCallbackMinutes` are still
// compatibility-only: nothing reads either column, the ceiling being
// `totalDialsFor` and the resume gap the fixed `IMMEDIATE_CALLBACK_MINUTES`,
// and their bounds survive so an older dashboard build is not 400ed.
// `maxGoalFollowUps` and `followUpDelayHours` are LIVE AGAIN as of 2026-09-09:
// they are the follow-up lane's own budget and wait, spent by a contact who
// has answered. `maxDialsPerDay` is new in the same release.
export const MIN_MAX_TOTAL_DIALS = 1;
export const MAX_MAX_TOTAL_DIALS = 50;
/** Follow-ups after the first conversation. Deliberately narrower than
 *  `MAX_MAX_TOTAL_DIALS`: this is the budget that irritates a person who
 *  already answered, and it is not the retry ladder's ceiling — those retries
 *  are forfeited the moment somebody picks up.
 *
 *  Fifteen rather than the five this shipped at, raised on request. The
 *  touchbase campaigns it was written for were already following contacts up
 *  to FOURTEEN times under the one-budget rule, so any ceiling below that
 *  would have made the new control unable to express what those campaigns
 *  were doing — and would have stranded the rows already past it. */
export const MAX_GOAL_FOLLOW_UPS_CEILING = 15;
export const MIN_FOLLOW_UP_DELAY_HOURS = 1;
/** One week, matching `MAX_DELAY_MINUTES` in spirit and in span. */
export const MAX_FOLLOW_UP_DELAY_HOURS = 168;
export const MIN_MAX_DIALS_PER_DAY = 1;
export const MAX_MAX_DIALS_PER_DAY = 10;
export const DEFAULT_MAX_DIALS_PER_DAY = 2;
/** An `immediate` callback is minutes away, never hours: two hours is already
 *  a different conversation, and one minute is the floor a dropped line needs
 *  to clear before the redial lands. */
export const MIN_IMMEDIATE_CALLBACK_MINUTES = 1;
export const MAX_IMMEDIATE_CALLBACK_MINUTES = 120;
/**
 * How long after a dropped conversation the engine picks it back up.
 *
 * A constant since 2026-09-06, not a knob. The person whose call cut out is
 * still sitting there, and the right answer to "how long do we leave them" is
 * the same on every campaign — long enough for a dropped line to settle,
 * short enough that the conversation is still the one they were having. There
 * was nothing an operator learned by tuning it, and a column they could set
 * to two hours was a way to turn a resume into something else entirely.
 *
 * The `immediateCallbackMinutes` column is still accepted and still written,
 * so an older dashboard build cannot 400; the engine reads this instead.
 */
export const IMMEDIATE_CALLBACK_MINUTES = 3;
/**
 * A contact is resumed at `IMMEDIATE_CALLBACK_MINUTES` once an hour. A second
 * `immediate` inside this window — the resumed call dropped again, or the
 * model answers "yes" to every abrupt ending — re-arms a full window out from
 * the moment it lands, still on the resume lane, rather than ringing the same
 * phone every five minutes for as long as the budget lasts. Fixed rather than
 * a knob, as the gap beside it now is too.
 */
export const IMMEDIATE_REPEAT_WINDOW_MINUTES = 60;

export interface GoalPolicyUpdate {
  maxTotalDials?: number;
  maxGoalFollowUps?: number;
  followUpDelayHours?: number;
  immediateCallbackMinutes?: number;
  maxDialsPerDay?: number;
}

/**
 * The follow-up policy: three live settings and two compatibility fields.
 *
 * LIVE. `maxGoalFollowUps` is how many more calls a contact may get once
 * somebody has ANSWERED — spent by every dial after that first conversation,
 * answered or not — and `followUpDelayHours` is the wait between them, rolled
 * into the campaign's dialing window. `maxDialsPerDay` caps placed dials
 * against one contact in a campaign-local calendar day, enforced by the claim
 * alone. All three read again since 2026-09-09.
 *
 * COMPATIBILITY ONLY. `maxTotalDials` and `immediateCallbackMinutes` are still
 * accepted, still bounds-checked and still written to their columns, and
 * nothing has read either since 2026-09-06: the dial ceiling is
 * `totalDialsFor` (`retryCount + maxGoalFollowUps + 1`) and the resume gap is
 * the fixed `IMMEDIATE_CALLBACK_MINUTES`. A dashboard build from before that
 * release still sends both on every save of the campaign panel, and the two
 * deploy independently, so refusing them during the skew would break saves for
 * the cost of nothing.
 */
export function validateGoalPolicy(body: unknown): GoalPolicyUpdate {
  const fields = fieldsOf(body);
  const data: GoalPolicyUpdate = {};

  if (supplied(fields, 'maxTotalDials')) {
    const value = fields.maxTotalDials;

    if (!isIntegerInRange(value, MIN_MAX_TOTAL_DIALS, MAX_MAX_TOTAL_DIALS)) {
      invalid(
        `maxTotalDials must be an integer between ${MIN_MAX_TOTAL_DIALS} and ` +
          `${MAX_MAX_TOTAL_DIALS}.`,
      );
    }

    data.maxTotalDials = value;
  }

  if (supplied(fields, 'maxGoalFollowUps')) {
    const value = fields.maxGoalFollowUps;

    if (!isIntegerInRange(value, 0, MAX_GOAL_FOLLOW_UPS_CEILING)) {
      invalid(
        `maxGoalFollowUps must be an integer between 0 and ${MAX_GOAL_FOLLOW_UPS_CEILING} ` +
          '(0 stops after the first conversation).',
      );
    }

    data.maxGoalFollowUps = value;
  }

  if (supplied(fields, 'followUpDelayHours')) {
    const value = fields.followUpDelayHours;

    if (!isIntegerInRange(value, MIN_FOLLOW_UP_DELAY_HOURS, MAX_FOLLOW_UP_DELAY_HOURS)) {
      invalid(
        `followUpDelayHours must be an integer between ${MIN_FOLLOW_UP_DELAY_HOURS} and ` +
          `${MAX_FOLLOW_UP_DELAY_HOURS}.`,
      );
    }

    data.followUpDelayHours = value;
  }

  if (supplied(fields, 'immediateCallbackMinutes')) {
    const value = fields.immediateCallbackMinutes;

    if (
      !isIntegerInRange(value, MIN_IMMEDIATE_CALLBACK_MINUTES, MAX_IMMEDIATE_CALLBACK_MINUTES)
    ) {
      invalid(
        `immediateCallbackMinutes must be an integer between ` +
          `${MIN_IMMEDIATE_CALLBACK_MINUTES} and ${MAX_IMMEDIATE_CALLBACK_MINUTES}.`,
      );
    }

    data.immediateCallbackMinutes = value;
  }

  if (supplied(fields, 'maxDialsPerDay')) {
    const value = fields.maxDialsPerDay;

    if (!isIntegerInRange(value, MIN_MAX_DIALS_PER_DAY, MAX_MAX_DIALS_PER_DAY)) {
      invalid(
        `maxDialsPerDay must be an integer between ${MIN_MAX_DIALS_PER_DAY} and ` +
          `${MAX_MAX_DIALS_PER_DAY}.`,
      );
    }

    data.maxDialsPerDay = value;
  }

  return data;
}

/**
 * The goal switch, kept for COMPATIBILITY ONLY.
 *
 * Still accepted, still type-checked and still written to its column; since
 * 2026-09-06 nothing reads it. Every campaign follows a contact up until the
 * conversation is finished or its dial budget runs out, so there is no state
 * left for this to name — but an older dashboard build still sends it, and a
 * 400 during the deploy skew would break saves for the cost of nothing.
 *
 * What it used to mean, for the reader of the paragraphs below.
 *
 * Strictly a boolean, for the reason `callbackEnabled` is: `"false"` is truthy,
 * and reading it as "on" would leave a campaign chasing people the caller never
 * asked it to chase.
 *
 * There is nothing else to validate, because there is nothing else to say. The
 * objective itself lives in the agent's own prompt and always has since the
 * call-note contract — a dial carries one reserved variable and the goal is not
 * among them — so what the campaign owns is the decision to follow up, not the
 * words describing what "finished" means.
 *
 * **`goal` is read by nothing here, and that is deliberate.** The deprecated
 * prose column is accepted and ignored for one release: only the dashboard ever
 * sent it, no V2 partner surface exposes it, and the two deploy independently,
 * so refusing an unknown field during the skew would break saves for the cost
 * of nothing. Absent from this return, it is never written either — the caller
 * spreads what comes back and nothing else.
 */
export function validateGoalEnabled(body: unknown): { goalEnabled?: boolean } {
  const fields = fieldsOf(body);

  if (!supplied(fields, 'goalEnabled')) return {};

  if (typeof fields.goalEnabled !== 'boolean') invalid('goalEnabled must be a boolean.');

  return { goalEnabled: fields.goalEnabled };
}

/**
 * How many won buckets a campaign may name.
 *
 * The same ceiling the agent editor puts on a key's pinned answer list, and
 * deliberately so: a won bucket names one of those answers, and a campaign
 * that could name more of them than the key can have would be describing
 * values that cannot occur.
 */
export const MAX_WON_BUCKETS = 40;

/** One bucket name is a label, not a paragraph. Matches the agent editor's
 *  ceiling on a pinned answer for the same reason. */
export const MAX_BUCKET_NAME_CHARS = 100;

export interface LeadBucketUpdate {
  leadBucketKey?: string | null;
  wonBuckets?: string[];
}

export interface LeadBucketContext {
  /** The extraction key names this campaign's agent declares. Empty when the
   *  campaign has no agent, or when its agent extracts nothing. */
  agentKeys: ReadonlySet<string>;
  /** The stored row, because both fields are judged on the MERGED state: a won
   *  bucket names a value of the bucket key, and one request may set either
   *  half. */
  current: { leadBucketKey: string | null; wonBuckets: string[] };
}

/**
 * The lead-bucket settings: which extracted answer sorts this campaign's
 * contacts, and which of its values count as won.
 *
 * The two halves are checked differently, which is the mirror of `variableMap`
 * and for the same reason. A **key** names something the agent declares, so a
 * value outside that set is a typo we can catch — and left uncaught it would
 * bucket every contact into nothing and report zero leads rather than an
 * error. A **bucket** is whatever a language model actually wrote in reply;
 * an agent may pin its answers and is free not to, and "the buckets are
 * whatever came back" is a supported choice — so a won bucket cannot be
 * checked against a list that may not exist.
 *
 * `leadBucketKey` is the second field in this service that `null` clears
 * rather than skips. A campaign that stops bucketing is a real state and is
 * not the same as one that never bucketed.
 */
export function validateLeadBuckets(body: unknown, context: LeadBucketContext): LeadBucketUpdate {
  const fields = fieldsOf(body);
  const update: LeadBucketUpdate = {};

  if (fields.leadBucketKey !== undefined) {
    if (fields.leadBucketKey === null) update.leadBucketKey = null;
    else {
      if (typeof fields.leadBucketKey !== 'string' || fields.leadBucketKey === '') {
        invalid('leadBucketKey must be one of the agent’s extraction key names.');
      }

      // Before the agent-keys checks: a managed key is refused as machinery
      // even on an agent whose config happens to carry it grandfathered.
      //
      // The call-note keys only, never the whole reserved set: the two
      // callback keys were pickable here before goals existed, and a campaign
      // that stored one would otherwise 400 on every later PATCH — the
      // dashboard sends the whole form back — with no way to clear it.
      if (GOAL_MANAGED_EXTRACTION_KEYS.has(fields.leadBucketKey)) {
        invalid(
          `leadBucketKey “${fields.leadBucketKey}” is reserved for the campaign call note and cannot sort leads.`,
        );
      }

      if (context.agentKeys.size === 0) {
        invalid('leadBucketKey needs an agent with extraction keys. This campaign has none.');
      }

      if (!context.agentKeys.has(fields.leadBucketKey)) {
        // Names what IS available, because the operator's next question is
        // "then what can I pick" and a refusal that does not answer it sends
        // them to the agent editor to read the list by hand.
        invalid(
          `leadBucketKey “${fields.leadBucketKey}” is not one of the agent’s extraction keys. ` +
            `Available: ${[...context.agentKeys].sort().join(', ')}.`,
        );
      }

      update.leadBucketKey = fields.leadBucketKey;
    }
  }

  if (fields.wonBuckets !== undefined && fields.wonBuckets !== null) {
    if (!Array.isArray(fields.wonBuckets)) invalid('wonBuckets must be an array of names.');

    if (fields.wonBuckets.length > MAX_WON_BUCKETS) {
      invalid(`wonBuckets takes at most ${MAX_WON_BUCKETS} names.`);
    }

    const names: string[] = [];
    const seen = new Set<string>();

    for (const [index, raw] of fields.wonBuckets.entries()) {
      if (typeof raw !== 'string') invalid(`wonBuckets[${index}] must be a non-empty name.`);

      const name = raw.trim();

      if (name === '') invalid(`wonBuckets[${index}] must be a non-empty name.`);

      if (name.length > MAX_BUCKET_NAME_CHARS) {
        invalid(`wonBuckets[${index}] is longer than ${MAX_BUCKET_NAME_CHARS} characters.`);
      }

      // Case-insensitively, because the readout collapses `Hot` and `hot` into
      // one bucket — a model writing the same answer twice does not capitalise
      // it the same way twice — and a list naming both promises a distinction
      // the count does not honour.
      const folded = name.toLowerCase();

      if (seen.has(folded)) {
        invalid(
          `wonBuckets[${index}] repeats “${folded}”. ` +
            'Bucket names are matched without regard to case.',
        );
      }

      seen.add(folded);
      names.push(name);
    }

    update.wonBuckets = names;
  }

  /**
   * The cross-field rule, on the MERGED state rather than on the body.
   *
   * A won bucket names a value of the bucket key, so with no key there is
   * nothing for it to name. Refused rather than silently dropped: a campaign
   * left reporting no won leads beside a settings card that still lists them
   * is the failure that takes longest to notice.
   */
  const mergedKey = update.leadBucketKey !== undefined
    ? update.leadBucketKey
    : context.current.leadBucketKey;
  const mergedWon = update.wonBuckets ?? context.current.wonBuckets;

  if (mergedKey === null && mergedWon.length > 0) {
    invalid('wonBuckets needs a leadBucketKey. Choose the key these buckets are values of.');
  }

  return update;
}
