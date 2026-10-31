import { Router } from 'express';
import { Prisma, type CampaignStatus } from '@prisma/client';
import multer from 'multer';
import { z } from 'zod';
import { accountOf, requireAuth } from '../middleware/auth.js';
import { requireMembership, workspaceOf } from '../middleware/workspace.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { parseBody } from '../lib/validate.js';
import {
  assertAgentAssignable,
  assertRotationAssignable,
  CAMPAIGN_INCLUDE,
  campaignInWorkspace,
  rotationOf,
  serializeCampaign,
  serializeCampaignContact,
  serializeInboundCall,
  type CampaignWithAgent,
} from '../lib/campaign.js';
import {
  CONTACT_QUEUES,
  contactQueueFilter,
  contactQueueOrder,
  HAS_BEEN_DIALED_SQL,
} from '../lib/campaignQueue.js';
import {
  campaignOutcomes,
  reachedContactsFilter,
  zeroFilledDispositions,
} from '../lib/campaignOutcomes.js';
import { campaignLeadBuckets } from '../lib/campaignBuckets.js';
import {
  clampCampaignConfig,
  LIVE_CONTACT_STATUSES,
  nextCopyName,
  NON_COPYABLE_CAMPAIGN_COLUMNS,
  stopCampaign,
  sweepContactsOverDialBudget,
  sweepContactsOverFollowUpBudget,
  sweepContactsOverRetryBudget,
} from '../lib/campaignLifecycle.js';
import { totalDialsFor } from '../lib/dialBudget.js';
import { contactSearchFilter } from '../lib/contactSearch.js';
import {
  addContactsToCampaign,
  isAdditiveVariableMapUpdate,
  MAX_CONTACTS_PER_REQUEST,
  STOPPED_CAMPAIGN_TOPUP_ERROR,
} from '../lib/campaignTopup.js';
import {
  DEFAULT_CONCURRENCY_LIMIT,
  DEFAULT_RETRY_CONCURRENCY,
  validateCallbackEnabled,
  validateConcurrencyUpdate,
  validateGoalEnabled,
  validateGoalPolicy,
  validateRetryConfig,
  validateLeadBuckets,
  validateVariableMap,
  validateCampaignType,
  isInboundFacing,
} from '../lib/campaignConfig.js';
import { runInboundStart, releaseInboundClaims } from '../lib/inboundStart.js';
import { storedKeyNames } from '../lib/extractionConfig.js';
import { readRecord } from '../lib/upstream.js';
import { agentIsUsable } from '../lib/agentVisibility.js';
import { IS_HELD } from '../lib/phoneNumberVisibility.js';
import { isCountryCode, type CountryCode } from '../lib/phone.js';
import { CsvError, parseContactsCsv } from '../lib/contacts-csv.js';
import { CustomExportFieldsError, parseCustomExportFields, streamCustomCsv } from '../services/campaignCustomExport.js';
import { parseAnalyticsRange } from '../lib/analyticsQuery.js';
import { notify } from '../lib/notify.js';
import {
  assertCampaignDialable,
  campaignStartChecks,
  ensureCallerNumberReady,
} from '../lib/campaignStart.js';
import { prepareCampaignAgent } from '../services/campaignExtraction.js';
import { releaseGoalPromptBlock } from '../services/campaignPrompt.js';
import { startCampaign } from '../services/campaignStart.js';
import { campaignContactJourney } from '../services/campaignJourney.js';
import { accountInFlight, campaignInFlight, resolveAccountConcurrency } from '../lib/concurrency.js';
import { evaluateWindow, restrictedDays } from '../lib/dialingWindow.js';
import { paginated, parsePagination } from '../lib/pagination.js';
import { toDisplayCredits } from '../lib/credits.js';
import {
  EMPTY_INBOUND_OUTCOMES,
  INBOUND_BUCKET_MINUTES,
  inboundBuckets,
  inboundByContact,
  ALL_TIME,
  inboundCredits,
  inboundFirstCallAt,
  inboundOutcomeBreakdown,
  inboundOutcomes,
  floorToBucket,
  type ContactInboundSummary,
} from '../lib/campaignInboundStats.js';
import { env } from '../lib/env.js';
import { serializeCallAttempt } from '../lib/serialize.js';
import { once } from 'node:events';
import { streamLeadsCsv } from '../services/campaignLeadsExport.js';
import { streamCallsCsv } from '../services/campaignCallsExport.js';

export const campaignRoutes: Router = Router();

/**
 * Every status a campaign row can hold, as the list filter accepts them.
 *
 * `CREDIT_EXHAUSTED` is here because it is a status a campaign *is*, not only
 * one an operator can choose: the dispatcher writes it when the owner's balance
 * runs out, and the campaigns page offers it as its own tab. Listing only the
 * statuses a person can set turned that tab into a 400.
 */
const CAMPAIGN_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'STOPPED',
  'CREDIT_EXHAUSTED',
] as const;

const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM, e.g. 09:00.');

const timezone = z.string().refine(
  (value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Use an IANA timezone, e.g. Asia/Kolkata.' },
);

const countryCode = z
  .string()
  .transform((value) => value.toUpperCase())
  .refine(isCountryCode, { message: 'Use an ISO-3166 alpha-2 country code, e.g. IN.' });

/**
 * The weekdays a campaign dials on, 0 = Sunday … 6 = Saturday.
 *
 * **`null` is accepted and normalised to `[]` right here**, so it is an alias
 * rather than a second state: nothing downstream — the change list, the write,
 * the column, which stays `NOT NULL` — ever sees one. Every other field of the
 * window is `.nullable()`, and a form clearing the whole window sends four
 * nulls; a 400 on the one field whose empty value already means "no
 * restriction" would be refusing the clearest thing the caller could have
 * said.
 *
 * A duplicate is refused rather than deduped, the rule `wonBuckets` follows: a
 * body naming Monday twice was assembled by something that thinks it is
 * sending seven days, and quietly accepting six is how that goes unnoticed.
 */
const dialDays = z
  .array(z.number().int().min(0).max(6))
  .max(7)
  .refine((days) => new Set(days).size === days.length, {
    message: 'Name each day at most once.',
  })
  .nullable()
  .transform((days) => days ?? []);

/**
 * The fields whose shape a schema can settle on its own.
 *
 * The dialing policy is deliberately absent: `campaignConfig.ts` owns
 * `retryCount`, `cooldownMinutes`, `retryDelaysMinutes`, `concurrencyLimit`,
 * `retryConcurrency`, `retrySharePercent`, `callbackEnabled` and
 * `variableMap` — and the four
 * inert goal knobs it still accepts for compatibility — because those
 * either clamp, cross-reference each other, or need an error naming the exact
 * bound — none of which a per-field schema can express, and two places
 * deciding the same range is how the create path and the update path start
 * accepting different campaigns.
 */
const baseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  // No length cap: it is a note, and a cap somebody picked would truncate a
  // handover document the operator wrote for their own team.
  description: z.string().nullable(),
  agentId: z.string().trim().min(1).max(191).nullable(),
  phoneNumberId: z.string().trim().min(1).max(191).nullable(),
  phoneNumberIds: z.array(z.string().trim().min(1).max(191)),
  fromTime: timeOfDay.nullable(),
  toTime: timeOfDay.nullable(),
  timezone: timezone.nullable(),
  dialDays,
  defaultCountry: countryCode.nullable(),
});

const updateSchema = baseSchema.partial();
const createSchema = baseSchema.partial().required({ name: true });

/**
 * The window a new campaign gets when the caller does not choose one.
 *
 * A campaign with no window dials around the clock, and "around the clock" is
 * not something anybody chose — it is what happens when three columns are left
 * null. A working day in a real timezone is the honest default, and an
 * operator who wants more can widen it deliberately.
 *
 * Applied per field and only when the key is absent. An explicit `null` is a
 * caller saying "no start time", which the API has always allowed and the
 * dispatcher already refuses to dial on.
 */
const DEFAULT_FROM_TIME = '09:00';
const DEFAULT_TO_TIME = '21:00';
const DEFAULT_TIMYENE = 'Asia/Kolkata';

type ConfigBody = z.infer<typeof updateSchema>;

/** Trimmed, and empty means unset — so "set to nothing" and "never set" are
 *  one state rather than two that render identically. */
function describedAs(description: string | null | undefined): { description?: string | null } {
  if (description === undefined) return {};

  return { description: description?.trim() ? description.trim() : null };
}

/**
 * The rotation this request asks for, or `undefined` when it asks for none.
 *
 * `phoneNumberId` is the legacy single-number field and is read as a rotation
 * of one, so the two can never disagree: a caller that sets only the old field
 * still gets join rows, and a caller that sets only the new one still gets the
 * legacy pointer updated. Leaving them independent would let a campaign dial
 * from a number its own payload does not name.
 */
function requestedRotation(data: ConfigBody): string[] | undefined {
  if (data.phoneNumberIds !== undefined) return data.phoneNumberIds;
  if (data.phoneNumberId !== undefined) return data.phoneNumberId === null ? [] : [data.phoneNumberId];

  return undefined;
}

function sameRotation(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** Join rows for a rotation, positioned by the order the caller gave. */
function rotationRows(phoneNumberIds: readonly string[]) {
  return phoneNumberIds.map((phoneNumberId, position) => ({ phoneNumberId, position }));
}

/**
 * The whole dialing policy, validated in one place for create and update
 * alike.
 *
 * Read off the **raw** body rather than the parsed one: the validators refuse
 * a numeric string where a schema would coerce it, and a schema that stripped
 * the field first would leave them nothing to refuse.
 *
 * `current` is the concurrency pair the update is merging into — the stored
 * row on update, the column defaults on create — because `retryConcurrency`
 * is a reservation inside `concurrencyLimit` and neither can be judged alone.
 */
function campaignConfigFrom(
  body: unknown,
  current: { concurrencyLimit: number; retryConcurrency: number },
) {
  return {
    ...validateRetryConfig(body),
    ...validateConcurrencyUpdate(body, current),
    ...validateCallbackEnabled(body),
    ...validateVariableMap(body),
    ...validateGoalEnabled(body),
    ...validateGoalPolicy(body),
  };
}

/**
 * The lead-bucket settings, validated against the agent the request leaves
 * behind.
 *
 * Async and separate from `campaignConfigFrom` because it is the one setting
 * whose legal values live on another row: `leadBucketKey` names an extraction
 * key the AGENT declares, and the agent may be arriving in this very request.
 * Folding it into the sync validator would mean either reading every agent's
 * cached config on every campaign write, or checking the key against the agent
 * the campaign is about to stop using.
 *
 * The read only happens when a key is actually being set. A campaign write
 * that says nothing about buckets — which is nearly all of them — costs
 * nothing extra.
 */
async function leadBucketsFrom(
  body: unknown,
  current: { leadBucketKey: string | null; wonBuckets: string[] },
  agentId: string | null,
  /**
   * Whether this request moves the campaign to a different agent.
   *
   * A stored key is re-checked when it does, even though the body says nothing
   * about buckets. A key the NEW agent does not extract matches no call's
   * extraction, so the campaign silently reports zero leads for ever — which
   * is precisely the failure the key check exists to prevent, arriving through
   * the one door that was not checking. The operator's way through is to drop
   * the key in the same request, which is them saying they no longer want this
   * campaign sorted.
   */
  changingAgent = false,
): Promise<ReturnType<typeof validateLeadBuckets>> {
  const supplied = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

  // The read costs an extra query, so it only happens when a key is actually
  // in play: one is being set, or one is stored and the agent under it moves.
  const checking = Boolean(supplied.leadBucketKey) || (changingAgent && current.leadBucketKey !== null);

  const agentKeys = checking ? await agentExtractionKeys(agentId) : new Set<string>();

  const update = validateLeadBuckets(body, { agentKeys, current });

  /**
   * The stored key, judged against the agent the request leaves behind.
   *
   * Only when the body did not speak for itself — a supplied key was already
   * checked above, and a supplied `null` is a deliberate clear.
   */
  if (changingAgent && update.leadBucketKey === undefined && current.leadBucketKey !== null) {
    validateLeadBuckets(
      { leadBucketKey: current.leadBucketKey },
      { agentKeys, current: { leadBucketKey: null, wonBuckets: [] } },
    );
  }

  return update;
}

/**
 * The extraction key names an agent declares, out of the cached config.
 *
 * A snapshot of an upstream record, so a shape this service cannot read is no
 * keys rather than an error — the same rule `storedKeyNames` states for the
 * agent editor. The consequence is a refusal naming an empty list, which is
 * the honest answer when we cannot see what the agent extracts.
 *
 * Callers MUST have established that this agent is the caller's to use — the
 * key names in a refusal are the agent's configuration, and answering with
 * them for an id from another workspace would say whether that agent exists.
 */
async function agentExtractionKeys(agentId: string | null): Promise<ReadonlySet<string>> {
  if (!agentId) return new Set();

  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { rawConfig: true },
  });

  return storedKeyNames(readRecord(agent?.rawConfig, ['extraction_config', 'extractionConfig']));
}

/**
 * The statuses a campaign's dialing policy may still be tuned in, and the
 * fields that may be tuned.
 *
 * The list is short because it is exactly the settings the dispatcher re-reads
 * on every pass and stamps onto nothing. Changing how many retries a contact
 * gets, or how long the wait is, changes only what the *next* claim does;
 * changing the agent, the numbers or the variable map changes what a call
 * already placed was placed against, and there is no honest way to apply that
 * retroactively.
 */
/**
 * The statuses that still accept a change to how the campaign paces itself.
 *
 * RUNNING is here, and it is the case worth spelling out: everything on the
 * field list below is re-read by the dispatcher on its next pass and stamped
 * onto nothing, so changing one describes the calls that have NOT been placed
 * and contradicts none that have. A campaign an operator has to stop in order
 * to give it another line is a campaign they stop.
 */
const MID_CAMPAIGN_EDITABLE_STATUSES: readonly string[] = [
  'RUNNING',
  'PAUSED',
  'CREDIT_EXHAUSTED',
];

const MID_CAMPAIGN_EDITABLE_FIELDS: readonly string[] = [
  'retryCount',
  'cooldownMinutes',
  'retryDelaysMinutes',
  'callbackEnabled',
  // The follow-up lane's three settings, LIVE since 2026-09-09 and listed
  // here for the reason `retryCount` is: the dispatcher re-reads all three on
  // its next pass and none of them contradicts a call already placed, so an
  // operator can slow a campaign that is following people up too hard without
  // pausing it. Lowering `maxGoalFollowUps` also runs a sweep, exactly as
  // lowering `retryCount` does.
  'maxGoalFollowUps',
  'followUpDelayHours',
  'maxDialsPerDay',
  // The goal switch and the two knobs still beside it. INERT since 2026-09-06
  // — the engine reads neither column — and still listed so that a save from
  // an older dashboard build, which sends all five on every edit of the
  // campaign panel, is accepted rather than refused as an edit this status
  // does not allow.
  'goalEnabled',
  'maxTotalDials',
  'immediateCallbackMinutes',
  /**
   * The two pacing knobs, and the rotation.
   *
   * `concurrencyLimit` is re-read by the sweep every pass and
   * `phoneNumberIds` by `resolveDialRotation` every pass, so both take effect
   * on the next tick with nothing to migrate and no call to contradict.
   *
   * `retryConcurrency` is not optional company for the limit. It is a
   * reservation INSIDE it, and `validateConcurrencyUpdate` refuses lowering
   * the limit below a reservation the body leaves alone — rightly, since
   * rewriting one field because another moved is how a setting stops meaning
   * what it says. Listed alone, the limit could be raised and never lowered
   * again: the fix needs both fields and the gate would accept one.
   */
  'concurrencyLimit',
  'retryConcurrency',
  'phoneNumberIds',
];

function sameLadder(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((minutes, index) => minutes === b[index]);
}

/**
 * Two day lists describing the same window.
 *
 * Order-insensitive, unlike `sameLadder` beside it, and the difference is not
 * an inconsistency: a retry ladder's order IS its meaning — element *i* is the
 * wait before retry *i+1* — while a day list is a set, and Monday-then-Friday
 * and Friday-then-Monday are one window.
 *
 * Compared through `restrictedDays`, the same reading the dispatcher's gate
 * uses, rather than over the raw arrays: `[]` and all seven days are one state
 * with one meaning — no restriction — and calling that a change refuses a
 * paused campaign the harmless edit of ticking the last box, with a
 * CAMPAIGN_CONFIG_LOCKED naming a window nobody narrowed. The gate and the
 * change list must agree about what a window IS, or the API refuses edits the
 * dispatcher would not have noticed.
 */
function sameDays(a: readonly number[] | null, b: readonly number[] | null): boolean {
  const left = restrictedDays(a);
  const right = restrictedDays(b);

  if (left === null || right === null) return left === right;

  return left.size === right.size && [...left].every((day) => right.has(day));
}

/**
 * The fields this request would actually change, named as the API names them.
 *
 * **Changed, not merely present.** The dashboard sends the whole form back on
 * every save, so a rule written on presence would refuse every edit to a
 * campaign that has left DRAFT — including the ones it means to allow. It
 * would also make the two agent/number locks, which have always compared
 * against the stored value, disagree with the gate standing beside them.
 *
 * Nothing is ignored: a field carrying a *different* value is named in the
 * refusal, because a field that appears to save and does not is the worst of
 * the three outcomes.
 */
function changedBy(
  campaign: CampaignWithAgent,
  data: ConfigBody,
  config: ReturnType<typeof campaignConfigFrom>,
  changingAgent: boolean,
  changingNumbers: boolean,
  changingType: boolean,
): string[] {
  const changed: string[] = [];

  const differs = (field: keyof ConfigBody) =>
    data[field] !== undefined && data[field] !== campaign[field as keyof CampaignWithAgent];

  // DRAFT-only, and it gets there for free: `type` is not in
  // MID_CAMPAIGN_EDITABLE_FIELDS, so naming it here locks it everywhere but
  // DRAFT — the same way agentId and phoneNumberIds are locked. What the
  // campaign IS decides the meaning of every call it places or answers.
  if (changingType) changed.push('type');

  if (differs('name')) changed.push('name');
  if (describedAs(data.description).description !== undefined
    && describedAs(data.description).description !== campaign.description) {
    changed.push('description');
  }
  if (changingAgent) changed.push('agentId');
  if (changingNumbers) changed.push('phoneNumberIds');
  for (const field of ['fromTime', 'toTime', 'timezone', 'defaultCountry'] as const) {
    if (differs(field)) changed.push(field);
  }

  // Compared by content, never by identity: `differs` is `!==`, and two arrays
  // holding the same days are never `!==`-equal — so the window's day list
  // would be reported as changed on every save, and a PATCH that touched
  // nothing would be refused on a campaign that has left DRAFT.
  //
  // Order-insensitively as well, because the set is what the dispatcher reads:
  // a form that emits Monday-first and one that emits Sunday-first describe the
  // same window, and calling that a change refuses an edit nobody made.
  if (data.dialDays !== undefined && !sameDays(data.dialDays, campaign.dialDays)) {
    changed.push('dialDays');
  }

  /**
   * `retrySharePercent` is deliberately absent from this list, so a request
   * that changes only it reaches `assertEditable` with nothing changed and is
   * allowed in every status — RUNNING included.
   *
   * It is the one dispatcher setting that cannot contradict a call already
   * placed. `retryCount` is here because lowering it has to stop a retry
   * already waiting, and `retryConcurrency` because it moves the boundary
   * between the fresh list and everything else. The share moves neither: it
   * decides which of two lanes the *next* claim draws from out of slots that
   * were already going to be spent, and the sweep re-reads it every pass. An
   * operator watching a campaign starve its retries has to be able to re-pace
   * it without pausing the campaign to do so, which is the whole reason the
   * setting exists.
   *
   * Same treatment and same reasoning as the lead-bucket settings; see
   * `assertEditable`.
   */
  for (const field of ['retryCount', 'cooldownMinutes', 'concurrencyLimit', 'retryConcurrency', 'callbackEnabled', 'goalEnabled', 'maxTotalDials', 'maxGoalFollowUps', 'followUpDelayHours', 'maxDialsPerDay', 'immediateCallbackMinutes'] as const) {
    if (config[field] !== undefined && config[field] !== campaign[field]) changed.push(field);
  }

  if (config.retryDelaysMinutes !== undefined
    && !sameLadder(config.retryDelaysMinutes, campaign.retryDelaysMinutes)) {
    changed.push('retryDelaysMinutes');
  }

  // Compared as JSON: the map is a flat object of strings, so serialising it is
  // a faithful equality test and a deep-compare helper nobody else needs is not.
  if (config.variableMap !== undefined
    && JSON.stringify(config.variableMap) !== JSON.stringify(campaign.variableMap ?? Prisma.DbNull)) {
    changed.push('variableMap');
  }

  return changed;
}

/**
 * Refuses an edit the campaign's status does not allow.
 *
 * Three doors:
 *
 * - **DRAFT** — everything. Nothing has been dialed, so nothing can be
 *   contradicted.
 * - **PAUSED / CREDIT_EXHAUSTED** — the dispatcher-policy settings only: the
 *   retry ladder, the callback switch, and the goal switch with the four
 *   knobs that pace it.
 * - **An additive variable map, in any status that was not stopped** — the
 *   importer's import → assign → save-mapping flow has to survive a re-upload
 *   landing on a campaign that finished while the operator was in the file
 *   picker. Additive is what makes it safe; see `isAdditiveVariableMapUpdate`.
 *
 * Everything else is read-only. A body that changes nothing is not an edit and
 * is never refused, whatever the status.
 *
 * `retrySharePercent` is absent from all of this too, and for the same reason
 * the lead-bucket settings are: `changedBy` never names it, so a request that
 * changes only it is allowed in every status. It re-paces the next claim and
 * contradicts no call already placed — see the note in `changedBy`.
 *
 * The lead-bucket settings are absent from all of this, and deliberately: they
 * are never named by `changedBy`, so a request that changes only them reaches
 * here with nothing changed and is allowed in every status. They contradict no
 * call already placed — membership is computed at read time out of what each
 * call extracted, so choosing a key re-reads history rather than changing what
 * any call did. A request that ALSO carries a locked field is still refused,
 * and the refusal names the locked field alone.
 */
function assertEditable(campaign: CampaignWithAgent, changed: string[], body: unknown): void {
  if (changed.length === 0 || campaign.status === 'DRAFT') return;

  const additiveMapOnly =
    changed.length === 1 &&
    changed[0] === 'variableMap' &&
    // Keyed on the column, not the status: `complete` relabels a stopped
    // campaign, and a status-keyed rule would be a two-click bypass of itself.
    campaign.stoppedAt === null &&
    isAdditiveVariableMapUpdate(campaign.variableMap, (body as { variableMap?: unknown })?.variableMap);

  if (additiveMapOnly) return;

  const midCampaign = MID_CAMPAIGN_EDITABLE_STATUSES.includes(campaign.status);

  const locked = midCampaign
    ? changed.filter((field) => !MID_CAMPAIGN_EDITABLE_FIELDS.includes(field))
    : changed;

  if (locked.length === 0) return;

  throw new ApiError(
    400,
    'CAMPAIGN_CONFIG_LOCKED',
    `Cannot change ${locked.join(', ')} on a ${campaign.status.toLowerCase()} campaign. ` +
      `Once a campaign has left DRAFT only ${MID_CAMPAIGN_EDITABLE_FIELDS.join(', ')} can be ` +
      'edited, and only while it is running, paused or out of credits — stop this campaign and ' +
      'create a new one to change anything else. New variable-map entries may be added to any ' +
      'campaign that was not stopped.',
  );
}

/**
 * A live inbound campaign answers on the DIDs it claimed at start.
 *
 * `claimInboundDids` runs once, inside `runInboundStart`; `releaseInboundClaims`
 * runs at pause and at stop. **Nothing re-claims on a settings save.** So a
 * PATCH that changed this list would leave `CampaignInboundClaim` pointing at
 * the old number: the campaign goes on answering a DID its own settings no
 * longer name, the new number rings through to whatever the platform's default
 * is, and the save reports success with nothing on any screen saying it did not
 * take. That is the worst of the three outcomes — worse than refusing, and
 * worse than failing loudly.
 *
 * Refused rather than made to re-claim, because re-claiming mid-flight is a
 * different feature: the claim is all-or-nothing across every DID, so taking it
 * again means a window in which the campaign answers on neither number. Stop
 * the campaign, change the number, start it again.
 *
 * `isInboundFacing`, not `isInboundOnly` — a BOTH campaign holds the same claim
 * and breaks the same way.
 *
 * OUTBOUND is untouched, and that is why `phoneNumberIds` is in
 * `MID_CAMPAIGN_EDITABLE_FIELDS` at all: rotating caller-ID mid-campaign is
 * re-read by `resolveDialRotation` on the dispatcher's next pass and
 * contradicts no call already placed, since what a dial went out from is
 * stamped on its own attempt row.
 *
 * Keyed on `changed`, which `changedBy` computes by comparing against the
 * stored rotation — so resubmitting the numbers a campaign already holds, in
 * the order it holds them, is not a change and is not refused. The dashboard
 * posts the whole form back on every save; a presence-keyed rule would refuse
 * every edit an operator is still allowed to make.
 */
function assertInboundNumbersUnchanged(campaign: CampaignWithAgent, changed: string[]): void {
  if (!changed.includes('phoneNumberIds')) return;
  if (!isInboundFacing(campaign.type)) return;
  if (!MID_CAMPAIGN_EDITABLE_STATUSES.includes(campaign.status)) return;

  throw new ApiError(
    400,
    'CAMPAIGN_INBOUND_NUMBERS_LOCKED',
    'A campaign that answers calls holds its numbers from the moment it starts. ' +
      'Stop the campaign to change which numbers it answers on, then start it again.',
  );
}

const listQuerySchema = z.object({
  status: z.enum(CAMPAIGN_STATUSES).optional(),
});

campaignRoutes.get(
  '/:workspaceId/campaigns',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const { status } = parseBody(listQuerySchema, req.query);

    const campaigns = await prisma.campaign.findMany({
      where: { workspaceId: workspaceOf(req).id, ...(status ? { status } : {}) },
      // The agent joins here rather than per row: a list of fifty campaigns
      // is still one query.
      include: { ...CAMPAIGN_INCLUDE.include, _count: { select: { contacts: true } } },
      orderBy: { createdAt: 'desc' },
    });

    /**
     * The outcome mix for the whole page in one grouped query, never one
     * `/stats` call per row: fifty campaigns would be fifty round trips of five
     * aggregates each, on a list whose whole job is to load quickly.
     */
    /**
     * Both aggregates for the whole page, side by side. The bucket readout is
     * one statement for every row that sorts its leads, and it asks nothing at
     * all when none of them do.
     */
    // The inbound figures ride beside the two, for the rows that answer calls
    // only — one grouped statement, and none at all on a page of OUTBOUND
    // campaigns.
    const [outcomes, leadBuckets, inbound] = await Promise.all([
      campaignOutcomes(campaigns.map((c) => c.id)),
      campaignLeadBuckets(campaigns),
      inboundOutcomes(campaigns.filter((c) => isInboundFacing(c.type)).map((c) => c.id)),
    ]);

    res.json({
      success: true,
      data: {
        campaigns: campaigns.map((c) => ({
          ...serializeCampaign(c, c._count.contacts),
          outcomes: { ...outcomes[c.id]!, ...(inbound[c.id] ? { inbound: inbound[c.id] } : {}) },
          leadBuckets: leadBuckets[c.id]!,
        })),
      },
    });
  }),
);

campaignRoutes.post(
  '/:workspaceId/campaigns',
  requireAuth,
  requireMembership('ADMIN'),
  asyncHandler(async (req, res) => {
    const workspaceId = workspaceOf(req).id;
    const data = parseBody(createSchema, req.body);

    // Validated against the column defaults, because that is the state this
    // create will leave behind for anything the body does not carry.
    const config = campaignConfigFrom(req.body, {
      concurrencyLimit: DEFAULT_CONCURRENCY_LIMIT,
      retryConcurrency: DEFAULT_RETRY_CONCURRENCY,
    });

    if (data.agentId) await assertAgentAssignable(workspaceId, data.agentId);

    const rotation = requestedRotation(data) ?? [];
    await assertRotationAssignable(workspaceId, rotation);

    // After `assertAgentAssignable`, never before: a refusal names the agent's
    // extraction keys, and answering with them for an id from another
    // workspace would say whether that agent exists.
    const buckets = await leadBucketsFrom(
      req.body,
      { leadBucketKey: null, wonBuckets: [] },
      data.agentId ?? null,
    );

    // The direction. Only the value is judged: an INBOUND/BOTH campaign no
    // longer needs an agent with an inbound face at create time — the start
    // builds one (`ensureInboundFace`) — so the agent is not read. An absent
    // type leaves the column's OUTBOUND default.
    const type = validateCampaignType(req.body);

    const campaign = await prisma.campaign.create({
      data: {
        workspaceId,
        name: data.name,
        agentId: data.agentId ?? null,
        ...describedAs(data.description),
        ...config,
        ...buckets,
        ...type,
        // Per field and only where the caller was silent — see the constants.
        fromTime: data.fromTime === undefined ? DEFAULT_FROM_TIME : data.fromTime,
        toTime: data.toTime === undefined ? DEFAULT_TO_TIME : data.toTime,
        timezone: data.timezone === undefined ? DEFAULT_TIMYENE : data.timezone,
        // No default beside the three above: those exist because "around the
        // clock" is not something anybody chose, where every day of the week
        // IS the ordinary intent — and a campaign silently created not dialing
        // at weekends would be a restriction nobody asked for.
        dialDays: data.dialDays ?? [],
        defaultCountry: data.defaultCountry ?? null,
        // The legacy pointer is the head of the rotation, always, so nothing
        // has to remember to keep the two in step later.
        phoneNumberId: rotation[0] ?? null,
        dialNumbers: { create: rotationRows(rotation) },
      },
      ...CAMPAIGN_INCLUDE,
    });

    res.status(201).json({ success: true, data: serializeCampaign(campaign, 0) });
  }),
);

/**
 * What `start` would do about this campaign, without doing any of it.
 *
 * The review screen an operator passes through on the way to Start reads this,
 * so the answer must be the one the start itself would give: it comes from
 * `campaignStartChecks`, the same list `assertCampaignDialable` throws the
 * first entry of. Nothing here writes, and nothing reaches the platform.
 *
 * `requireMembership()` rather than `ADMIN`: this is a read, and reads on this
 * surface are membership-wide while the mutation beside it is not. A MEMBER who
 * cannot press Start can still see why it would be refused, which is the same
 * bargain the campaign detail route already makes.
 *
 * A missing goal is **not** reported as blocked. A campaign without one is a
 * perfectly ordinary campaign, and the screen shows the goal row empty rather
 * than inventing a gate the server does not have.
 */
campaignRoutes.get(
  '/:workspaceId/campaigns/:campaignId/preflight',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);
    const checks = await campaignStartChecks(campaign);

    res.json({
      success: true,
      data: {
        ok: checks.every((check) => check.status === 'ok'),
        // `httpStatus` stays behind: it is how this service refuses a start,
        // not something a screen has any use for. `code` travels because the
        // dashboard already keys its copy on these.
        checks: checks.map(({ key, label, status, detail, code }) => ({
          key,
          label,
          status,
          detail,
          code,
        })),
      },
    });
  }),
);

campaignRoutes.get(
  '/:workspaceId/campaigns/:campaignId',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);

    /**
     * The same aggregate the list carries, for the one campaign.
     *
     * The detail page used to derive its bar from `/stats`, whose disposition
     * groupBy has no status filter — a contact cooling down between retries
     * still carries the outcome of its last dial, so it was counted once as an
     * outcome and again in the undialed remainder. `/stats` is documented as
     * counts that deliberately do not partition, so it stays as it is and the
     * page reads the aggregate that does.
     */
    const [contactCount, outcomes, leadBuckets] = await Promise.all([
      prisma.campaignContact.count({ where: { campaignId: campaign.id } }),
      campaignOutcomes([campaign.id]),
      campaignLeadBuckets([campaign]),
    ]);

    res.json({
      success: true,
      data: {
        ...serializeCampaign(campaign, contactCount),
        outcomes: outcomes[campaign.id]!,
        leadBuckets: leadBuckets[campaign.id]!,
      },
    });
  }),
);

campaignRoutes.patch(
  '/:workspaceId/campaigns/:campaignId',
  requireAuth,
  requireMembership('ADMIN'),
  asyncHandler(async (req, res) => {
    const workspaceId = workspaceOf(req).id;
    const campaign = await campaignInWorkspace(workspaceId, req.params.campaignId!);
    const data = parseBody(updateSchema, req.body);

    /**
     * The agent a campaign mid-dial holds, refused with its own code.
     *
     * `assertEditable` below would refuse this too — a running campaign is
     * read-only. This one keeps its own 409 and its own code because the
     * dashboard keys on it, and because this is the pair that voids the
     * invariant the relations exist to hold: `start` checks the agent once and
     * nothing looks again, so a PATCH that swapped it mid-dial would leave the
     * campaign dialing with an agent no gate ever saw.
     *
     * A resubmit that carries the agent it already has is not a change, so it
     * is not refused — the dashboard sends the whole form, and a locked field
     * must not make every other edit fail.
     */
    const changingAgent = data.agentId !== undefined && data.agentId !== campaign.agentId;

    if (changingAgent && campaign.status === 'RUNNING') {
      throw new ApiError(
        409,
        'CAMPAIGN_AGENT_LOCKED',
        'A running campaign cannot change the agent it dials with. Stop it and create a new ' +
          'campaign to dial with a different agent.',
      );
    }

    /**
     * The rotation, compared as an ordered list — the order IS the rotation,
     * so re-ordering it is a change.
     *
     * Deliberately without the agent's companion lock. The numbers are
     * re-read by `resolveDialRotation` on every dispatcher pass, so a campaign
     * mid-dial picks up a new list on its next tick; what a call already
     * placed went out from is on the attempt row and is not this list's to
     * rewrite.
     */
    const rotation = requestedRotation(data);
    const changingNumbers =
      rotation !== undefined && !sameRotation(rotation, rotationOf(campaign));

    /**
     * A live campaign must keep at least one number.
     *
     * With attachments and none usable the dispatcher HOLDS, and with none at
     * all it has nothing to dial from: either way the campaign stays RUNNING,
     * places no calls, and says nothing anywhere about why the count stopped
     * moving. A DRAFT is exempt — a form on its way to a choice passes through
     * the empty state, and `start` is the gate for that.
     *
     * Keyed on the REQUESTED list being empty rather than on "would leave
     * nothing usable": an attached number that has been deactivated is a
     * supplier-side fact that may resolve itself by the next pass, and
     * refusing the save over it would block the operator from fixing the very
     * thing they opened the form for.
     */
    if (
      changingNumbers &&
      rotation!.length === 0 &&
      MID_CAMPAIGN_EDITABLE_STATUSES.includes(campaign.status)
    ) {
      throw new ApiError(
        409,
        'CAMPAIGN_NEEDS_PHONE_NUMBER',
        'A campaign that has started must keep at least one number to dial from. Add a ' +
          'replacement before removing the last one, or stop the campaign.',
      );
    }

    const config = campaignConfigFrom(req.body, campaign);

    // Raw compare for the gate — the enum is checked by `validateCampaignType`
    // after the gate, so a body illegal for two reasons reports the general
    // lock first.
    const suppliedType = (req.body as { type?: unknown } | null)?.type;
    const changingType = suppliedType !== undefined && suppliedType !== campaign.type;

    const changed = changedBy(campaign, data, config, changingAgent, changingNumbers, changingType);

    assertEditable(campaign, changed, req.body);
    // After `assertEditable`, so a body illegal for two reasons reports the
    // general lock first: the remedy for that one is the same and its message
    // is the one an operator already knows.
    assertInboundNumbersUnchanged(campaign, changed);

    // Only when the field is present and non-null. An absent field changes
    // nothing, and clearing the agent is not a reference to validate.
    if (data.agentId) {
      await assertAgentAssignable(campaign.workspaceId, data.agentId);
    }

    if (rotation !== undefined) {
      await assertRotationAssignable(campaign.workspaceId, rotation);
    }

    /**
     * The bucket settings, checked against the agent this request LEAVES
     * BEHIND rather than the one the campaign has now — an operator switching
     * agent and key together is describing one coherent campaign, and checking
     * the new key against the old agent would refuse it.
     *
     * After the assignability check above, so that a refusal listing the
     * agent's extraction keys can only ever list an agent this caller may use.
     */
    const buckets = await leadBucketsFrom(
      req.body,
      campaign,
      data.agentId === undefined ? campaign.agentId : data.agentId,
      changingAgent,
    );

    // Direction: the value alone. The agent this request leaves behind is not
    // consulted — its face is the start's business, not the save's.
    const typeUpdate = validateCampaignType(req.body);

    const { description, phoneNumberId: _legacy, phoneNumberIds: _rotation, ...scalars } = data;

    const updated = await prisma.$transaction(async (tx) => {
      /**
       * The campaign row first, in the order every other writer takes it —
       * `stop`, the top-up, the callback re-arm and the dispatcher's
       * completion pass. The sweep below adds rows to the finished pile, and
       * without the lock a callback booking can slip a contact back onto the
       * queue between the sweep and the counter that describes it.
       */
      await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${campaign.id} FOR UPDATE`;

      /**
       * Contacts the new retry budget has already stranded.
       *
       * Run whenever `retryCount` is supplied rather than only when it drops:
       * a no-op UPDATE is cheaper than reasoning about which direction the
       * number moved, and it heals rows an earlier lowering left behind.
       */
      const swept =
        config.retryCount === undefined
          ? 0
          : await sweepContactsOverRetryBudget(tx, campaign.id, config.retryCount);

      /**
       * The same, for the absolute dial cap — its exact analogue, and run for
       * the same reason: the claim refuses a contact whose placed dials have
       * reached the dial budget in EVERY lane, so a lowered budget leaves
       * those rows PENDING for ever, counted as remaining work by the
       * completion pass, and the campaign can never complete either.
       *
       * Keyed on EITHER lane budget, because the dial cap is derived from
       * both (`totalDialsFor` = `retryCount + maxGoalFollowUps + 1`) and
       * lowering either one lowers it. Each unsupplied side falls back to the
       * stored value, so a body carrying one of the two still computes the cap
       * the campaign will actually run under. The two sweeps close different
       * holes — a contact may be inside the retry reservation and past the
       * dial cap, an armed `CALLBACK` being exactly that — so both run, on the
       * one edit that can move either.
       */
      /**
       * The retry sweep's twin, one lane over: a reached contact waiting on a
       * follow-up the lowered `maxGoalFollowUps` no longer covers. Same hole,
       * same remedy — the claim refuses the row and nothing else would ever
       * settle it. Run on a raise too, for the reason the retry sweep is: a
       * no-op UPDATE is cheaper than reasoning about which way the number
       * moved, and it heals rows an earlier lowering left behind.
       */
      const strandedFollowUps =
        config.maxGoalFollowUps === undefined
          ? 0
          : await sweepContactsOverFollowUpBudget(tx, campaign.id, config.maxGoalFollowUps);

      const outOfReach =
        config.retryCount === undefined && config.maxGoalFollowUps === undefined
          ? 0
          : await sweepContactsOverDialBudget(
              tx,
              campaign.id,
              totalDialsFor({
                retryCount: config.retryCount ?? campaign.retryCount,
                maxGoalFollowUps: config.maxGoalFollowUps ?? campaign.maxGoalFollowUps,
              }),
            );

      /**
       * Replaced wholesale rather than reconciled row by row.
       *
       * The list the caller sent is the rotation, positions included, and a
       * diff would have to invent an order for anything it kept. Deleting
       * first also sidesteps the unique on `(campaignId, position)`, which a
       * partial rewrite collides with the moment two numbers swap places.
       */
      if (rotation !== undefined) {
        await tx.campaignPhoneNumber.deleteMany({ where: { campaignId: campaign.id } });

        if (rotation.length > 0) {
          await tx.campaignPhoneNumber.createMany({
            data: rotationRows(rotation).map((row) => ({ campaignId: campaign.id, ...row })),
          });
        }
      }

      return tx.campaign.update({
        where: { id: campaign.id },
        data: {
          ...scalars,
          ...describedAs(description),
          ...config,
          ...buckets,
          ...typeUpdate,
          ...(rotation === undefined ? {} : { phoneNumberId: rotation[0] ?? null }),
          // In the same transaction as the sweep it counts. A status change
          // without its counter leaves the stats page disagreeing with the
          // contact list permanently.
          ...(swept + strandedFollowUps + outOfReach > 0
            ? { skippedCount: { increment: swept + strandedFollowUps + outOfReach } }
            : {}),
        },
        ...CAMPAIGN_INCLUDE,
      });
    });

    /**
     * No agent preparation here, and there is nothing left for one to close.
     *
     * `prepareCampaignAgent` attaches the managed extraction set and writes
     * the managed block into the agent's prompt, and this route used to run it
     * whenever an edit turned a switch ON after the campaign had started: the
     * preparation was tied to the TRANSITION rather than to the setting that
     * needed it, so a campaign could be left dialing with an agent that could
     * not answer the questions its new setting depended on.
     *
     * Neither switch can move any more. `callbackEnabled` is accepted and
     * never written (see `validateCallbackEnabled`); `goalEnabled` is written
     * and read by nothing, because every campaign follows a conversation up.
     * So there is no edit that can leave an agent behind its campaign, and the
     * three holders of the invariant that remain are the ones that always did
     * the work: `start`, `resume`, and the boot sweep in
     * `campaignAgentSweep`, which re-prepares every RUNNING campaign.
     *
     * Written out rather than left as an `if` nothing can enter: a condition
     * that is always false is a claim about two columns somebody will one day
     * make writable again, and the note is what tells them to put this back.
     */

    const contactCount = await prisma.campaignContact.count({
      where: { campaignId: campaign.id },
    });

    res.json({ success: true, data: serializeCampaign(updated, contactCount) });
  }),
);

/**
 * Deletes a campaign, from any status.
 *
 * Deliberately unrestricted. A campaign is the customer's own record of an
 * intention, and asking them to stop one before they may remove it is two
 * clicks for one decision — the refusal that used to live here was protecting
 * a cascade that no longer exists.
 *
 * What survives is what somebody was billed for. `CallAttempt` rows are the
 * record of telephone calls: their campaign pointers are `SetNull`, so the
 * history and its ledger entries stand while the queue behind them goes. Calls
 * still connected finish normally, and a late webhook resolves against the
 * attempt row it always did — `dialerOutcome` reads those pointers defensively
 * for exactly this case.
 *
 * The lock is taken first, in the order every other campaign writer takes it,
 * so a dispatcher pass or a callback booking cannot be halfway through adding
 * work to a row that is about to disappear.
 */
campaignRoutes.delete(
  '/:workspaceId/campaigns/:campaignId',
  requireAuth,
  requireMembership('ADMIN'),
  asyncHandler(async (req, res) => {
    const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);

    // Before the delete: the claim rows cascade with the campaign, but the
    // upstream unbind cannot be done by a cascade, and once the rows are gone
    // their DIDs' platform ids are unreadable. So release first — read the
    // claims, unbind each number, delete the claim rows — then delete the
    // campaign (whose cascade now finds nothing left to remove).
    await releaseInboundClaims(campaign.id);

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${campaign.id} FOR UPDATE`;

      // CampaignContact and the rotation rows cascade. The Contact rows are the
      // workspace's own and outlive any one campaign, so they stay.
      await tx.campaign.delete({ where: { id: campaign.id } });
    });

    // A delete is an end like a stop, and a deleted campaign is no longer a
    // reason for its agent to carry the managed block. After the transaction,
    // so the release's count of live campaigns on the agent no longer sees
    // this one, and gated inside on there being no other — agents are
    // many-to-one with campaigns. Nothing in it can throw.
    if (campaign.agentId !== null) {
      await releaseGoalPromptBlock(campaign.agentId, workspaceOf(req).id);
    }

    res.json({ success: true, data: { id: campaign.id, deleted: true } });
  }),
);

/**
 * Copies a campaign's configuration into a fresh DRAFT.
 *
 * ## Copy by omission
 *
 * The whole source row is read and the columns that must not travel are
 * deleted from it — the inverse of picking the fields to copy. A hand-written
 * list is a list somebody forgets to extend: the column added next month would
 * silently reset itself on every clone, and the first report of it would be a
 * customer asking why their copy dials differently from the campaign it was
 * copied from.
 *
 * ## Re-validated as things are now, re-clamped as they were then
 *
 * The agent and every attached number are re-resolved against the workspace at
 * this instant, because a campaign that ran in March may name an agent since
 * retired and a DID since released — and a copy of it would be a campaign that
 * cannot start, refused later with an error about a choice the operator never
 * made. The numbers, in contrast, are clamped rather than refused: see
 * `clampCampaignConfig`.
 */
campaignRoutes.post(
  '/:workspaceId/campaigns/:campaignId/duplicate',
  requireAuth,
  requireMembership('ADMIN'),
  asyncHandler(async (req, res) => {
    const workspaceId = workspaceOf(req).id;
    const campaign = await campaignInWorkspace(workspaceId, req.params.campaignId!);
    const requestedName = (req.body as { name?: unknown } | undefined)?.name;

    // Absent is "name it for me". Present and unusable is a mistake worth
    // reporting, rather than a silent fall back to the generated name.
    if (requestedName !== undefined && (typeof requestedName !== 'string' || !requestedName.trim())) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'name must be a non-empty string.');
    }

    // Not a null check: staff unassign an agent by clearing its workspace and
    // retire it by setting a status, neither of which the foreign key sees.
    if (campaign.agentId !== null && !agentIsUsable(campaign.agent, campaign.workspaceId)) {
      throw new ApiError(
        400,
        'CAMPAIGN_AGENT_NOT_FOUND',
        "This campaign's agent is no longer available in this workspace, so it cannot be " +
          'duplicated. Create a new campaign with an agent you can use.',
      );
    }

    const rotation = rotationOf(campaign);

    const usable = await prisma.phoneNumber.count({
      where: { id: { in: rotation }, workspaceId, ...IS_HELD },
    });

    // Counted rather than named: which of the numbers went is not something the
    // operator can act on differently, and naming a DID this workspace no
    // longer holds would report a number back to somebody who lost it.
    if (usable < rotation.length) {
      throw new ApiError(
        400,
        'CAMPAIGN_PHONE_NUMBER_NOT_FOUND',
        'A phone number this campaign dials from is no longer available in this workspace, ' +
          'so it cannot be duplicated. Create a new campaign with the numbers you hold now.',
      );
    }

    /**
     * Read again, without the includes.
     *
     * `campaignInWorkspace` joins the agent, the number and the rotation, and
     * spreading that into a create would carry three relation objects into a
     * payload that wants columns. This read is the row itself, which is what
     * "copy by omission" needs to be honest about.
     */
    const source = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    const copyable: Record<string, unknown> = { ...source };

    for (const column of NON_COPYABLE_CAMPAIGN_COLUMNS) delete copyable[column];

    // Omitted rather than passed as `null`: the column's "no mapping" state is
    // SQL NULL, and Prisma refuses a bare null for a Json field.
    if (copyable.variableMap === null) delete copyable.variableMap;

    Object.assign(copyable, clampCampaignConfig(source));

    const name = requestedName?.trim() ?? (await nextCopyName(workspaceId, source.name));

    // One nested create. Prisma wraps nested writes in a transaction, so there
    // is no instant at which a duplicate exists holding only some of its
    // numbers.
    const clone = await prisma.campaign.create({
      data: {
        ...(copyable as Prisma.CampaignUncheckedCreateInput),
        workspaceId,
        name,
        status: 'DRAFT',
        phoneNumberId: rotation[0] ?? null,
        dialNumbers: { create: rotationRows(rotation) },
      },
      ...CAMPAIGN_INCLUDE,
    });

    res.status(201).json({ success: true, data: serializeCampaign(clone, 0) });
  }),
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

// The path ends in a literal ':upload'. The colon is escaped because the
// router would otherwise read `:upload` as a route parameter.
campaignRoutes.post(
  '/:workspaceId/campaigns/:campaignId/contacts\\:upload',
  requireAuth,
  // Ahead of multer on purpose: an unauthorized caller never gets their file
  // buffered into memory.
  requireMembership('ADMIN'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);

    /**
     * Checked here as well as inside the core, and on the column rather than
     * the status.
     *
     * Here, so a stopped campaign's upload is refused before ten thousand rows
     * are parsed and turned into `Contact` records nothing will dial. Inside
     * the core too, because between the two a stop can land — the core's copy
     * is the one that is actually authoritative, under the lock.
     */
    if (campaign.stoppedAt !== null) {
      throw new ApiError(400, 'CAMPAIGN_CONTACTS_LOCKED', STOPPED_CAMPAIGN_TOPUP_ERROR);
    }

    if (!req.file) {
      throw new ApiError(400, 'CSV_FILE_REQUIRED', 'Attach a CSV file in the "file" field.');
    }

    let parsed;
    try {
      parsed = parseContactsCsv(
        req.file.buffer,
        (campaign.defaultCountry ?? undefined) as CountryCode | undefined,
      );
    } catch (error) {
      if (error instanceof CsvError) throw new ApiError(400, error.code, error.message);
      throw error;
    }

    const contactIds: string[] = [];

    for (const row of parsed.rows) {
      // Looked up on the per-workspace key, so a phone another workspace
      // already holds is a different contact entirely rather than a collision.
      const existing = await prisma.contact.findUnique({
        where: { workspaceId_phone: { workspaceId: campaign.workspaceId, phone: row.phone } },
      });

      // A later file updates the columns it carries and leaves the rest
      // standing. Replacing the whole object would let a narrower export drop
      // variables the dispatcher needs, and an operator re-uploading a
      // phone-only list has not asked to forget anything. Clearing a value
      // therefore means editing it in the file, not omitting the column.
      //
      // Tags are the one field replaced rather than merged when the file
      // carries them: they are a segmentation the operator maintains, and a
      // union would make removing one impossible through the only door that
      // sets them.
      const contact = existing
        ? await prisma.contact.update({
            where: { id: existing.id },
            data: {
              ...(row.name ? { name: row.name } : {}),
              ...(row.email ? { email: row.email } : {}),
              ...(row.tags.length > 0 ? { tags: row.tags } : {}),
              metadata: {
                ...(existing.metadata as Record<string, string>),
                ...row.metadata,
              },
            },
          })
        : await prisma.contact.create({
            data: {
              workspaceId: campaign.workspaceId,
              phone: row.phone,
              name: row.name,
              email: row.email,
              tags: row.tags,
              metadata: row.metadata,
            },
          });

      contactIds.push(contact.id);
    }

    /**
     * Linked through the same core the JSON top-up uses.
     *
     * The unique on `(campaignId, contactId)` is what turns a repeat into a
     * duplicate rather than a second row — and therefore a second call — and
     * the core is where the campaign lock, the `totalContacts` maintenance and
     * the re-open of a finished campaign all live. A second implementation
     * here is a second set of counters to drift.
     */
    const outcome = await addContactsToCampaign({ campaignId: campaign.id, contactIds });

    if (!outcome.ok) throw new ApiError(outcome.status, outcome.code, outcome.message);

    res.json({ success: true, data: { ...outcome.result, invalid: parsed.invalid } });
  }),
);

/**
 * The three ways to resolve "which contacts", exactly one of which a request
 * may name.
 *
 * `selectAll` mirrors the picker's own query rather than asking the dashboard
 * to page through ten thousand ids and send them back: "select all matching"
 * has to mean the same set on the server that the operator saw on the screen,
 * and a client-assembled list drifts from it the moment anything is imported
 * between the two requests.
 */
const topupSchema = z.object({
  contactIds: z.array(z.string().trim().min(1).max(191)).optional(),
  tagFilter: z.array(z.string().trim().min(1)).optional(),
  selectAll: z.literal(true).optional(),
  search: z.string().trim().min(1).optional(),
});

campaignRoutes.post(
  '/:workspaceId/campaigns/:campaignId/contacts',
  requireAuth,
  requireMembership('ADMIN'),
  asyncHandler(async (req, res) => {
    const workspaceId = workspaceOf(req).id;
    const campaign = await campaignInWorkspace(workspaceId, req.params.campaignId!);
    const body = parseBody(topupSchema, req.body);

    const branches = [body.contactIds, body.tagFilter, body.selectAll].filter(
      (branch) => branch !== undefined,
    );

    if (branches.length !== 1) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Provide contactIds, tagFilter or selectAll.');
    }

    let contactIds: string[];
    // Set only when the match was larger than one request may carry, so the
    // dashboard can say "10,000 of 42,000 added" rather than silently adding a
    // prefix of the list the operator selected.
    let totalMatching: number | undefined;

    if (body.contactIds !== undefined) {
      if (body.contactIds.length > MAX_CONTACTS_PER_REQUEST) {
        throw new ApiError(
          400,
          'VALIDATION_ERROR',
          `Cannot add more than ${MAX_CONTACTS_PER_REQUEST} contacts per request.`,
        );
      }

      // Re-resolved inside the workspace. An id from another workspace's
      // library finds nothing and is simply not added — the same 404-shaped
      // silence every other cross-workspace reference gets.
      contactIds = (
        await prisma.contact.findMany({
          where: { id: { in: body.contactIds }, workspaceId },
          select: { id: true },
        })
      ).map((row) => row.id);
    } else {
      const where: Prisma.ContactWhereInput =
        body.tagFilter !== undefined
          ? { workspaceId, tags: { hasSome: body.tagFilter } }
          : {
              workspaceId,
              // The picker's own query: this workspace's contacts that are not
              // already on this campaign.
              campaignContacts: { none: { campaignId: campaign.id } },
              ...(body.search
                ? {
                    OR: [
                      { name: { contains: body.search, mode: 'insensitive' } },
                      { phone: { contains: body.search } },
                    ],
                  }
                : {}),
            };

      const [matched, total] = await Promise.all([
        prisma.contact.findMany({ where, select: { id: true }, take: MAX_CONTACTS_PER_REQUEST }),
        prisma.contact.count({ where }),
      ]);

      contactIds = matched.map((row) => row.id);
      if (total > MAX_CONTACTS_PER_REQUEST) totalMatching = total;
    }

    /**
     * Nothing matched.
     *
     * `selectAll` is the one branch where that is an ordinary outcome rather
     * than a mistake: pressing "select all" on a campaign that already holds
     * every contact in the library is a thing operators do, twice, and
     * answering it with a 400 would read as a broken button. Naming ids or a
     * tag that match nothing is a request that did not do what it said.
     */
    if (contactIds.length === 0) {
      if (body.selectAll) {
        res.json({ success: true, data: { added: 0, duplicates: 0, reopened: false } });
        return;
      }

      throw new ApiError(400, 'NOT_FOUND', 'No matching contacts found.');
    }

    const outcome = await addContactsToCampaign({ campaignId: campaign.id, contactIds });

    if (!outcome.ok) throw new ApiError(outcome.status, outcome.code, outcome.message);

    res.json({
      success: true,
      data: {
        ...outcome.result,
        ...(totalMatching === undefined
          ? {}
          : {
              totalMatching,
              warning:
                `${totalMatching} contacts matched; the first ${MAX_CONTACTS_PER_REQUEST} were ` +
                'added. Run this again to add the rest.',
            }),
      },
    });
  }),
);

/**
 * Every status a contact can hold, in the enum's own order.
 *
 * It drives two things at once — the `?status=` filter and the stats
 * zero-fill — so a status missing from it is a bucket the list cannot name and
 * a row the stats page silently loses. `SKIPPED` is the one that made that
 * concrete: `stop` and the retry-lowering sweep both write it, so it is where a
 * stopped campaign's entire queue goes, and it belongs here for the same reason
 * the other six do.
 */
const CONTACT_STATUSES = [
  'PENDING',
  'QUEUED',
  'CALLING',
  'COMPLETED',
  'FAILED',
  'EXCLUDED',
  'SKIPPED',
] as const;

/**
 * `?limit` and `?offset`, not a cursor.
 *
 * Prisma's `cursor` is applied **after** the `where`, so a cursor row that does
 * not satisfy the filter still positions the page — which on a scoped list is a
 * way to learn that a row id exists in somebody else's campaign. The queue
 * views make it untenable for a second reason too: they sort on
 * `nextEligibleAt` and `callbackAt`, and a cursor keyed on the id cannot page a
 * sort it is not part of.
 */
const contactQuerySchema = z.object({
  status: z.enum(CONTACT_STATUSES).optional(),
  /** The roster's search box: a phone fragment however it was typed, or a
   *  name. Bounded because it reaches a `LIKE` — see `contactSearchFilter`. */
  search: z.string().trim().min(1).max(100).optional(),
  queue: z
    .enum(CONTACT_QUEUES, {
      // Named rather than left to the default text: the whole value of a 400
      // here is that it says which queues exist.
      message: `queue must be one of: ${CONTACT_QUEUES.join(', ')}.`,
    })
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

campaignRoutes.get(
  '/:workspaceId/campaigns/:campaignId/contacts',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);
    const { status, queue, search, limit, offset } = parseBody(contactQuerySchema, req.query);

    /**
     * The queue filter is **ANDed**, never merged.
     *
     * Every queue already implies `status: 'PENDING'`, so spreading it beside
     * an explicit `?status=` would have one of the two silently win. Under an
     * `AND` the two compose: agreeing narrows to the queue, disagreeing
     * narrows to nothing, and both are answers rather than accidents.
     */
    const contactFilter = search ? contactSearchFilter(search) : null;

    const where: Prisma.CampaignContactWhereInput = {
      campaignId: campaign.id,
      ...(status ? { status } : {}),
      ...(queue ? { AND: [contactQueueFilter(queue, new Date())] } : {}),
      // ANDed with everything above, like the queue: a search inside a filtered
      // view narrows that view rather than escaping it, and `total` narrows
      // with it so the pager describes the search rather than the roster.
      ...(contactFilter ? { contact: contactFilter } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.campaignContact.findMany({
        where,
        include: { contact: true },
        orderBy: contactQueueOrder(queue),
        skip: offset,
        take: limit,
      }),
      prisma.campaignContact.count({ where }),
    ]);

    /**
     * The goal context for the page, so each row can say what the agent knows
     * about this person and what it decided last time.
     *
     * One `IN` query over the page's ids — never per row — and only when the
     * campaign has a goal: a campaign without one pays nothing, and its rows
     * carry `goal: null` so the dashboard can tell "no goal" from "nothing
     * learned yet".
     *
     * A goal campaign's contact with no record yet is the second of those, and
     * gets the empty record rather than null: a null `memory` (the call note
     * the next dial renders), and an empty note — never null — because YE
     * derives the note on every recorded attempt, so "" means "no attempt has
     * resolved yet" and the page never has to guess which kind of absence it
     * is looking at. `goalMissing` stays in the shape for the page and is null
     * under the call-note contract; it goes when the dashboard's labels do.
     */
    const goalById = new Map<
      string,
      { memory: string | null; lastCallNote: string; goalMissing: string | null }
    >();

    if (rows.length > 0) {
      const records = await prisma.campaignContactGoal.findMany({
        where: { campaignContactId: { in: rows.map((row) => row.id) } },
        select: {
          campaignContactId: true,
          memory: true,
          lastCallNote: true,
          goalMissing: true,
        },
      });

      for (const record of records) {
        goalById.set(record.campaignContactId, {
          memory: record.memory,
          lastCallNote: record.lastCallNote,
          goalMissing: record.goalMissing,
        });
      }
    }

    const EMPTY_GOAL = { memory: null, lastCallNote: '', goalMissing: null };

    /**
     * What each of these people has CALLED IN, for a campaign that answers.
     * One grouped read for the page, and none — key absent, not zeroed — on
     * an OUTBOUND campaign, where "0 calls received" would read as a fact
     * about a person rather than about the campaign type.
     */
    const inboundById =
      isInboundFacing(campaign.type) && rows.length > 0
        ? await inboundByContact(rows.map((row) => row.id))
        : new Map<string, ContactInboundSummary>();

    // Frozen: one shared object is handed to every contact without calls, and
    // a caller that mutated it would rewrite the row for all of them.
    const EMPTY_INBOUND: ContactInboundSummary = Object.freeze({
      calls: 0,
      talkSecs: 0,
      lastCallAt: null,
    });

    res.json({
      success: true,
      data: {
        contacts: rows.map((row) => ({
          ...serializeCampaignContact(row),
          goal: goalById.get(row.id) ?? EMPTY_GOAL,
          ...(isInboundFacing(campaign.type) ? { inbound: inboundById.get(row.id) ?? EMPTY_INBOUND } : {}),
        })),
        total,
      },
    });
  }),
);

/**
 * One contact's history on one campaign.
 *
 * The campaign is resolved first, so an id from another workspace is a 404
 * before anything else is read; the join row is then re-asserted against that
 * campaign inside the service, because the path id could name a contact on a
 * different campaign the same workspace owns.
 */
campaignRoutes.get(
  '/:workspaceId/campaigns/:campaignId/contacts/:campaignContactId/journey',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);

    const journey = await campaignContactJourney(campaign, req.params.campaignContactId!);

    res.json({ success: true, data: journey });
  }),
);

campaignRoutes.delete(
  '/:workspaceId/campaigns/:campaignId/contacts/:campaignContactId',
  requireAuth,
  requireMembership('ADMIN'),
  asyncHandler(async (req, res) => {
    const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);

    // Scoped to this campaign, so a row id from another list cannot be reached.
    const link = await prisma.campaignContact.findFirst({
      where: { id: req.params.campaignContactId!, campaignId: campaign.id },
    });

    if (!link) {
      throw new ApiError(404, 'NOT_FOUND', 'Contact not found on this campaign.');
    }

    const updated = await prisma.$transaction(async (tx) => {
      // The campaign row first, in the order every other counter writer takes
      // it. `totalContacts` is read by the stats page instead of a COUNT, so
      // it has to move in the same transaction as the row it describes.
      await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${campaign.id} FOR UPDATE`;

      // Excluded, not deleted. The row is the record that this person was on
      // this list; removing it would let the next upload re-add and dial them,
      // which is the outcome the operator was trying to prevent.
      //
      // Guarded on the status so a repeated exclude is a no-op rather than a
      // second decrement — the dashboard's retry must not shrink the total.
      const excluded = await tx.campaignContact.updateMany({
        where: { id: link.id, status: { not: 'EXCLUDED' } },
        data: { status: 'EXCLUDED' },
      });

      if (excluded.count > 0) {
        // Floored rather than decremented blindly: a counter that has drifted
        // must not be driven negative by the correction.
        await tx.campaign.updateMany({
          where: { id: campaign.id, totalContacts: { gt: 0 } },
          data: { totalContacts: { decrement: excluded.count } },
        });
      }

      return tx.campaignContact.findUniqueOrThrow({ where: { id: link.id } });
    });

    res.json({ success: true, data: { id: updated.id, status: updated.status } });
  }),
);

campaignRoutes.get(
  '/:workspaceId/campaigns/:campaignId/stats',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);

    const now = new Date();

    const [grouped, byDisposition, duration] = await Promise.all([
      /**
       * The status counts, the PENDING dial-split and the pending callbacks,
       * in **one** statement.
       *
       * Raw because the two must share a snapshot. As two Prisma statements in
       * this `Promise.all` they take separate connections and separate READ
       * COMMITTED snapshots, and the payload then ships a split that can
       * overflow the number it splits: `byStatus.PENDING` from one instant
       * beside a `waiting` pair from another, three keys apart in one object.
       *
       * Not an exotic race, either — the transition that causes it is the goal
       * follow-up re-arm. A goal campaign moves contacts `CALLING → PENDING`
       * with `followUpCount` incremented continuously, so every such transition
       * adds a row the filtered count sees and an earlier status snapshot could
       * not. That is steady state on exactly the campaign type this split
       * exists to describe.
       *
       * One `GROUP BY` is also one round trip and one snapshot rather than
       * two, and it retires the floor that used to guard the subtraction: the
       * remainder cannot go negative when both sides are counted over the same
       * rows. **It is not a claim about cheaper rows.** `CampaignContact`
       * carries four indexes on this campaign — `[campaignId, status]`,
       * `[campaignId, status, nextEligibleAt]`, `[campaignId, callbackAt]` and
       * `campaign_contacts_arm_lane_idx` on `[campaignId, status, armKind]`,
       * which covers the callback FILTER's arm — but `lastAttemptAt` is in
       * none of them, so this statement reads the heap whichever plan the
       * grouping takes. One round trip and one snapshot is the whole of the
       * argument, and it is enough.
       *
       * The filter is `HAS_BEEN_DIALED_SQL` — one predicate over
       * `lastAttemptAt`, shared with the list's `outcomes` bar, the analytics
       * funnel and the bucket report, so no two panels of this dashboard can
       * disagree about whether a contact has been rung. See that constant for
       * why it is that column and not the dial counters.
       *
       * **`callbacksPending` rides here for the same reason and not a weaker
       * one.** The payload asserts it as a **subset** of `waiting.betweenCalls`
       * — an armed callback is PENDING and was armed by a call that stamped
       * `lastAttemptAt`, so it is counted in both — and a subset relation
       * between two statements on two
       * connections is not a relation at all: a booking landing between them
       * arms a contact `CALLING → PENDING`, which the later count sees and the
       * earlier split does not, and the payload then ships a subset larger than
       * the set. That is the same steady-state transition this statement exists
       * to survive.
       *
       * Its filter carries `status = 'PENDING'` explicitly. Reading it out of
       * the PENDING group makes that redundant today, and it is written anyway:
       * a settled contact keeps `callbackAt` as history of a promise already
       * kept, so a reader who later sums this column across the groups would
       * otherwise be counting promises nobody is waiting on.
       *
       * It counts **future commitments, not the dispatch backlog**. A callback
       * whose time has already passed but which the dispatcher has not claimed
       * — a paused campaign, a closed window — is work in hand rather than a
       * promise still ahead, and `?queue=callback_overdue` is where it belongs.
       *
       * Gated on the arm and not on `callbackAt` alone. That column is history
       * on a row the retry ladder has since re-armed, so a contact promised a
       * call last week, called, and now cooling down between silences counted
       * here as a promise still outstanding. `CALLBACK` is the arm the booking
       * writes and nothing else does, so the tile counts promises the queue
       * will actually keep.
       */
      prisma.$queryRaw<
        Array<{ status: string; total: bigint; betweenCalls: bigint; callbacksPending: bigint }>
      >`
        SELECT cc.status,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE ${HAS_BEEN_DIALED_SQL}) AS "betweenCalls",
               COUNT(*) FILTER (
                 WHERE cc.status = 'PENDING'
                   AND cc."armKind" = 'CALLBACK'
                   AND cc."callbackAt" > ${now}
               ) AS "callbacksPending"
        FROM "CampaignContact" cc
        WHERE cc."campaignId" = ${campaign.id}
        GROUP BY cc.status`,
      /**
       * The last outcome each contact reached, normalised at resolution time
       * and copied onto the join row. Nulls come back as their own group and
       * are dropped here — a contact nothing has dialled has no outcome to
       * report, which is a different thing from one whose outcome we do not
       * recognise.
       */
      prisma.campaignContact.groupBy({
        by: ['disposition'],
        where: { campaignId: campaign.id },
        _count: { _all: true },
      }),
      /**
       * How long a conversation lasts on this campaign.
       *
       * Measured over the attempts of contacts that **completed**, because
       * there is no per-contact duration column to average: a contact's dials
       * are the calls, and a contact that never got through would otherwise
       * drag the number toward zero with a ring nobody answered.
       */
      prisma.callAttempt.aggregate({
        _avg: { durationSecs: true },
        where: { campaignId: campaign.id, campaignContact: { status: 'COMPLETED' } },
      }),
    ]);

    // Seed every status at zero, so the response shape is stable and the UI
    // renders a fixed set of rows rather than only what happens to be present.
    const byStatus: Record<string, number> = Object.fromEntries(
      CONTACT_STATUSES.map((s) => [s, 0]),
    );
    let total = 0;
    // PENDING rows with a counter moved, off the same snapshot as `byStatus`
    // above — which is what lets `waiting` below subtract rather than floor.
    let betweenCalls = 0;
    // Callbacks armed for a time still ahead — see the statement above for why
    // the arm and not `callbackAt` alone decides that. Off the same row as
    // `betweenCalls`, so the subset the payload claims between them is a subset
    // of a set read at the same instant.
    let callbacksPending = 0;

    for (const group of grouped) {
      const count = Number(group.total);

      byStatus[group.status] = count;
      total += count;

      if (group.status === 'PENDING') {
        betweenCalls = Number(group.betweenCalls);
        callbacksPending = Number(group.callbacksPending);
      }
    }

    /**
     * The nine, seeded at zero, and a home for everything else.
     *
     * The platform's disposition vocabulary grows without this service
     * deploying, so a value outside the nine is expected rather than
     * exceptional. Dropping it would report a campaign as having reached fewer
     * people than it did; adding a tenth row would reflow the page the first
     * time a carrier is onboarded. It is counted, labelled, and kept out of the
     * fixed set.
     */
    const dispositions = zeroFilledDispositions();
    let settledUnknown = 0;

    for (const group of byDisposition) {
      if (group.disposition === null) continue;

      if (group.disposition in dispositions) dispositions[group.disposition] = group._count._all;
      else settledUnknown += group._count._all;
    }

    /**
     * The live block, beside the counts the Stats tab already had.
     *
     * `total` and `byStatus` keep their exact shape: the tab shipped against
     * them, and widening a payload must not move what is already in it.
     */
    const owner = await prisma.account.findUniqueOrThrow({
      where: { id: (await prisma.workspace.findUniqueOrThrow({
        where: { id: campaign.workspaceId },
        select: { ownerAccountId: true },
      })).ownerAccountId },
      select: { id: true, concurrencyLimit: true },
    });

    const [inFlight, accountCalls, spend, leadBuckets, totalAttempts, reached] = await Promise.all([
      campaignInFlight(prisma, campaign.id),
      accountInFlight(prisma, owner.id),
      /**
       * Summed from the LEDGER, not from the attempts.
       *
       * The ledger is what the money actually did; `CallAttempt.costCredits`
       * also records what was *owed* on a shortfall, which was never charged.
       * Adding those in would show a workspace spending credits it still has.
       */
      prisma.creditTransaction.aggregate({
        _sum: { amount: true },
        where: { type: 'CALL_USAGE', callAttempt: { campaignId: campaign.id } },
      }),
      campaignLeadBuckets([campaign]),
      /**
       * Dials placed, over the campaign's life.
       *
       * Attempt ROWS, not `CampaignContact.attempts`: that column counts
       * retries CONSUMED — the first dial does not increment it and neither
       * does a callback — so summing it would undercount every contact by at
       * least one. This is the same count the attempts route already runs.
       */
      prisma.callAttempt.count({ where: { campaignId: campaign.id } }),
      /**
       * Leads this campaign has had a conversation with, over its life.
       *
       * Counted over the ATTEMPTS (`reachedContactsFilter`) rather than summed
       * out of the reached tier of `dispositions` below, and the two are
       * deliberately different numbers rather than one figure computed twice.
       * Those groups partition contacts by the outcome of their LAST dial,
       * which is what a bar over the roster has to do; this counts a
       * conversation that happened, which no later voicemail can take back. On
       * a campaign whose goal follow-ups keep re-dialling people it has already
       * spoken to, this is the larger figure and the one an operator means by
       * "how many did we reach".
       *
       * Published here so the Overview strip stops summing that tier itself:
       * the sum and the analytics tab's `lifetime.reached` were two readouts of
       * one sentence arrived at two ways, and they disagreed on every campaign
       * that follows anybody up.
       */
      prisma.campaignContact.count({ where: reachedContactsFilter(campaign.id) }),
    ]);

    /**
     * The goal tile numbers, computed only when the switch is on — `goal:
     * null` otherwise, so the tab can tell "no goal" from "no data".
     *
     * `achieved` groups `goalAchieved` among SETTLED contacts (anything the
     * queue is done with — not PENDING, QUEUED or CALLING, the dispatcher's
     * own definition of unfinished): `true`/`false` are the resolution's
     * verdicts, and `pending` is settled without one — excluded, swept, or
     * failed without ever connecting.
     *
     * One aggregate, and no distribution beside it. The bot judges the goal
     * against the agent's own prompt, so there is no per-key readout to fold:
     * "was this conversation finished" has exactly one honest answer per
     * contact, which is the verdict, and the tile reports the three states of
     * that. The per-contact prose — what the agent knows, what it still needs
     * — is on the contacts list and the journey, where a paragraph can be read.
     *
     * No wording travels with the numbers. The campaign owns the decision to
     * follow up and the agent's prompt owns what "finished" means, so a
     * campaign-shaped goal string here would be a caption for a rule this row
     * does not hold.
     */
    let goal: {
      achieved: { achieved: number; notAchieved: number; pending: number };
    } | null = null;

    {
      const achievedGroups = await prisma.campaignContact.groupBy({
        by: ['goalAchieved'],
        where: {
          campaignId: campaign.id,
          status: { notIn: ['PENDING', 'QUEUED', 'CALLING'] },
        },
        _count: { _all: true },
      });

      const achieved = { achieved: 0, notAchieved: 0, pending: 0 };

      for (const group of achievedGroups) {
        if (group.goalAchieved === true) achieved.achieved = group._count._all;
        else if (group.goalAchieved === false) achieved.notAchieved = group._count._all;
        else achieved.pending = group._count._all;
      }

      goal = { achieved };
    }

    const window = evaluateWindow(campaign, now);

    // What the campaign has RECEIVED, for the rows that answer. Absent, never
    // zeroed, on an OUTBOUND campaign: a zero would say it answers nothing.
    //
    // `billedCalls` travels beside `credits` because it is the denominator of
    // it, and a campaign holding imported history has a different one from
    // `calls`. Reading `25.9 credits` against `137 calls` is what makes an
    // exactly correct tile read as broken.
    const inbound = isInboundFacing(campaign.type)
      ? await (async () => {
          // `ALL_TIME`, deliberately. `/stats` reports the campaign's whole
          // life — a strip that silently became month-to-date would be a
          // regression an operator sees as numbers that fell overnight. The
          // range-scoped reading is the analytics report's.
          const { credits, billedCalls } = await inboundCredits(
            campaign.workspaceId,
            campaign.id,
            owner.id,
            ALL_TIME,
          );

          return {
            ...((await inboundOutcomes([campaign.id]))[campaign.id] ?? EMPTY_INBOUND_OUTCOMES),
            credits: toDisplayCredits(credits),
            billedCalls,
          };
        })()
      : null;

    res.json({
      success: true,
      data: {
        total,
        byStatus,
        ...(inbound ? { inbound } : {}),
        // Counts contacts that **reached a call**, so it deliberately does not
        // sum to the status counts beside it. Grouped by the LAST dial's
        // outcome — see `reached` below, which asks a different question of the
        // same campaign and is expected to be the larger number.
        dispositions,
        /**
         * Leads spoken to at any point, from `reachedContactsFilter`.
         *
         * The strip's headline figure, and NOT the reached tier of
         * `dispositions` summed: that tier is the last dial's outcome, so it
         * FALLS when a follow-up lands in voicemail. This one cannot fall.
         * `lifetime.reached` on the analytics report is the same count from the
         * same filter, so the two tabs cannot disagree about one sentence.
         */
        reached,
        settledUnknown,
        callbacksPending,
        /**
         * `byStatus.PENDING`, split by whether this contact has ever been
         * dialled — `lastAttemptAt`, the same column the analytics funnel and
         * the bucket panel read. Two situations a single "waiting" row
         * conflates, and the page reads them as different sentences: work
         * nobody has started, and work already in hand.
         *
         * `neverCalled` therefore means "no dial was ever attempted on this
         * contact", not "no counter has moved": a contact the dialer claimed
         * and handed back — a failed launch, a stale claim, a rate-limited
         * sweep — is `betweenCalls`, which is what the other two panels
         * already say about it.
         *
         * **`betweenCalls` is not "cooling down between dials".** That is the
         * `retry` queue's narrower question. This one also matches an armed
         * callback and a goal follow-up, which `campaignQueue.ts` argues at
         * length are different questions with different clocks — so the honest
         * reading is the broad one: somebody has dialled this contact, and it
         * is waiting to be dialled again for *some* reason. `?queue=` is where
         * a reader asks which.
         *
         * **`callbacksPending` above is a subset of `betweenCalls`**, not a
         * sibling of it: a callback is booked by a call, so the contact
         * carries `lastAttemptAt` and is counted in both. The two are
         * different cuts of the same population and must never be added or
         * subtracted. That relation is
         * asserted here as a property, so it is read from the same statement
         * and the same snapshot — across two, a booking landing between them
         * ships a subset larger than the set it is a subset of.
         *
         * Exact, not floored: all three numbers come from the one statement
         * above, so the remainder is a subtraction within a single snapshot
         * rather than across two.
         */
        waiting: { neverCalled: byStatus.PENDING - betweenCalls, betweenCalls },
        /**
         * Where this campaign's leads landed, computed at read time from what
         * each call extracted.
         *
         * Present and empty on a campaign that does not bucket, never absent:
         * a dashboard cannot tell a field that was omitted from a campaign
         * whose leads nobody sorted, and the first reads as a broken payload.
         */
        leadBuckets: leadBuckets[campaign.id]!,
        // Null on a campaign with no goal, never an empty object: the two
        // states mean different tabs, and the dashboard keys on which one.
        goal,
        // Dials placed over the campaign's life. Attempt rows, so a callback
        // and a first dial each count once — unlike `CampaignContact.attempts`,
        // which counts retries consumed and would undercount both.
        totalAttempts,
        avgDuration: duration._avg.durationSecs,
        // From the ledger, for the reason `dialer.spendCredits` is: an attempt
        // also records what was owed on a shortfall and never taken.
        totalCredits: toDisplayCredits(-(spend._sum.amount ?? 0n)),
        dialer: {
          // So the page can say "dialing is off on this deployment" rather
          // than showing a campaign that will never move and explaining
          // nothing.
          enabled: env.dialerEnabled,
          inFlight,
          campaignConcurrency: campaign.concurrencyLimit,
          accountInFlight: accountCalls,
          accountConcurrency: resolveAccountConcurrency(owner),
          // Negated: ledger amounts are signed and a charge is negative, but
          // "spent" is a positive quantity on a page.
          spendCredits: toDisplayCredits(-(spend._sum.amount ?? 0n)),
          window:
            window.state === 'closed'
              ? { state: window.state, opensAt: window.opensAt }
              : { state: window.state },
        },
      },
    });
  }),
);

/**
 * One campaign's call attempts, newest first.
 *
 * Its own route rather than a field on `/stats`, matching the billing
 * surface's split: the counts are read once per page load, and this is
 * paginated and re-read on its own.
 */
campaignRoutes.get(
  '/:workspaceId/campaigns/:campaignId/attempts',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);
    const { page, limit, skip, take } = parsePagination(req.query as Record<string, unknown>);

    const [items, total] = await Promise.all([
      prisma.callAttempt.findMany({
        where: { campaignId: campaign.id },
        include: { campaignContact: { include: { contact: { select: { phone: true, name: true } } } } },
        // A timestamp AND the id. Attempts claimed in one pass share a
        // millisecond, and offset paging over an unstable sort shows a row on
        // two pages while hiding another.
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      prisma.callAttempt.count({ where: { campaignId: campaign.id } }),
    ]);

    res.json({
      success: true,
      data: { items: items.map(serializeCallAttempt), page, limit, total },
    });
  }),
);

/**
 * The calls an inbound-facing campaign has received, newest first, with the
 * caller resolved once per page. Member-read like every other campaign read;
 * an OUTBOUND campaign answers an empty page rather than a refusal, because
 * "no calls received" is true of it and a 4xx would make the tab an error.
 */
campaignRoutes.get(
  '/:workspaceId/campaigns/:campaignId/inbound-calls',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);
    const { page, limit, skip, take } = parsePagination(req.query as Record<string, unknown>);

    const [rows, total] = await Promise.all([
      prisma.campaignInboundCall.findMany({
        where: { campaignId: campaign.id },
        orderBy: [{ arrivedAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      prisma.campaignInboundCall.count({ where: { campaignId: campaign.id } }),
    ]);

    const contactIds = [...new Set(rows.map((r) => r.contactId).filter((id): id is string => id !== null))];
    // Workspace-scoped, though the ids come from rows of a campaign already
    // gated by `campaignInWorkspace`: every other contact read in this file
    // reaches them through the relation, and keeping the scope local means the
    // next reader does not have to trace the gate to know this one is safe.
    const contacts = contactIds.length
      ? await prisma.contact.findMany({
          where: { id: { in: contactIds }, workspaceId: workspaceOf(req).id },
          select: { id: true, name: true },
        })
      : [];
    const byId = new Map(contacts.map((c) => [c.id, c]));

    res.json({
      success: true,
      data: paginated(
        rows.map((row) => serializeInboundCall(row, row.contactId ? (byId.get(row.contactId) ?? null) : null)),
        total,
        { page, limit, skip, take },
      ),
    });
  }),
);

/**
 * When an inbound-facing campaign's calls arrived, in fixed buckets.
 *
 * One response behind BOTH charts on the Overview — today hour by hour, and
 * the last fortnight day by day — which is why it is a bucket grid rather than
 * a per-day series like the analytics report's. The grid is UTC and carries no
 * time zone, and the reader assembles its own local hours and days out of it.
 *
 * **That is the point, not a shortcut.** Every IANA offset is a whole multiple
 * of fifteen minutes, so a local hour anywhere is exactly four of these
 * buckets and a local day exactly ninety-six — one grid answers both charts,
 * where bucketing by day here would need a second grouping for the hourly half
 * and two groupings of one window is how two charts on one page come to
 * disagree. The client does that arithmetic with its own `Intl`, which accepts
 * the `Asia/Calcutta` spelling Chrome in India reports.
 *
 * A zone is not needed here, rather than unavailable: `resolvePgTimeZone`
 * would resolve one safely, and this path does not ask the question.
 *
 * `days + 1` days are returned for the same reason: a caller assembling `days`
 * whole LOCAL days out of a UTC grid needs up to fourteen hours of slack on
 * either side of them. The extra day is not decoration and the response says
 * how many days were asked for so a reader can find its own window inside it.
 *
 * Member-read, and an OUTBOUND campaign answers a window of zeroes rather than
 * a refusal — "no calls received" is true of it, and a 4xx would make the tab
 * an error. `firstCallAt` is lifetime beside it, because "nobody rang this
 * fortnight" and "nobody has ever rung this number" want different sentences
 * and a window of zeroes cannot tell them apart.
 */
const ACTIVITY_DEFAULT_DAYS = 14;
const ACTIVITY_MAX_DAYS = 90;

campaignRoutes.get(
  '/:workspaceId/campaigns/:campaignId/inbound-activity',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const workspaceId = workspaceOf(req).id;
    const campaign = await campaignInWorkspace(workspaceId, req.params.campaignId!);

    // Clamped rather than refused, and junk falls back to the default. This is
    // a chart: the shape of the URL is not something the reader chose, and a
    // 400 would replace a fortnight of bars with an error message.
    // An EMPTY `?days=` reads as absent rather than as the minimum. `Number('')`
    // is 0, which is finite, so the bare parameter used to take the clamp
    // branch and answer with a one-day window where the documented default is
    // a fortnight.
    const rawDays = (req.query as Record<string, unknown>).days;
    const asked = typeof rawDays === 'string' && rawDays.trim() === '' ? NaN : Number(rawDays);
    const days = Number.isFinite(asked)
      ? Math.min(ACTIVITY_MAX_DAYS, Math.max(1, Math.trunc(asked)))
      : ACTIVITY_DEFAULT_DAYS;

    const bucketMs = INBOUND_BUCKET_MINUTES * 60_000;
    // The bucket the current instant is in, whole: a call that arrived two
    // minutes ago belongs on the chart, and an exclusive end at `now` would
    // drop it until the quarter-hour turned over.
    const until = new Date(floorToBucket(new Date()).getTime() + bucketMs);
    const since = new Date(until.getTime() - (days + 1) * 24 * 60 * 60 * 1000);

    // The breakdown covers the DAYS ASKED FOR, never the slack day beside
    // them. The grid carries one extra day so a client can carve whole LOCAL
    // days out of a UTC one; no client ever draws it. Counted here, it put a
    // verdict total on the card that the bars beside it — under the same
    // stated window — could not add up to: on a DID taking seventy-five calls
    // a day, roughly a hundred calls of daylight between two figures one line
    // apart, which is the disagreement this endpoint's single-grid design
    // exists to prevent.
    //
    // Whole UTC days, not the reader's local ones, because this route takes no
    // zone. That leaves the two windows up to fourteen hours out of step at
    // the far edge instead of thirty-four, and both now describe "the last N
    // days" to within a partial day rather than differing by more than one.
    // Exact agreement needs the caller's zone; `resolvePgTimeZone` is how, and
    // this grid is what it would fold.
    const outcomesFrom = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);

    const [buckets, outcomes, firstCallAt] = await Promise.all([
      inboundBuckets(workspaceId, campaign.id, since, until),
      // Its range is inclusive at both ends where the buckets are half-open,
      // so the end is pulled back a millisecond rather than left to disagree
      // with the bars beside it by one call on one quarter-hour a day.
      inboundOutcomeBreakdown(workspaceId, campaign.id, {
        from: outcomesFrom,
        to: new Date(until.getTime() - 1),
      }),
      inboundFirstCallAt(workspaceId, campaign.id),
    ]);

    res.json({
      success: true,
      data: {
        days,
        bucketMinutes: INBOUND_BUCKET_MINUTES,
        since: since.toISOString(),
        until: until.toISOString(),
        buckets,
        outcomes,
        firstCallAt,
      },
    });
  }),
);

/**
 * Relabelling a stopped campaign as complete.
 *
 * Its own route rather than a row in the table below, because almost none of
 * what it does is a state transition: three of its four refusals are about
 * *why* the campaign is not stoppable-then-completable, and one of them counts
 * telephones that are still off the hook.
 *
 * Nothing else moves. No contact changes status, no counter moves, and
 * `completedAt` keeps the instant the stop gave it — that IS when the campaign
 * stopped running, and rewriting it to now would put a duration on the clock
 * that no call spent. `stoppedAt` stays set, so top-up and callback booking go
 * on refusing exactly as they did while the row read STOPPED.
 */
campaignRoutes.post(
  '/:workspaceId/campaigns/:campaignId/complete',
  requireAuth,
  requireMembership('ADMIN'),
  asyncHandler(async (req, res) => {
    const workspaceId = workspaceOf(req).id;
    const campaign = await campaignInWorkspace(workspaceId, req.params.campaignId!);

    if (campaign.status === 'COMPLETED') {
      throw new ApiError(
        400,
        'INVALID_CAMPAIGN_TRANSITION',
        'This campaign is already marked complete.',
      );
    }

    if (campaign.status !== 'STOPPED') {
      throw new ApiError(
        400,
        'INVALID_CAMPAIGN_TRANSITION',
        'Only a stopped campaign can be marked complete. A live campaign completes on its ' +
          'own once every contact has been dialed.',
      );
    }

    const live = await prisma.campaignContact.count({
      where: { campaignId: campaign.id, status: { in: [...LIVE_CONTACT_STATUSES] } },
    });

    // The count is in the message because the remedy is to wait, and how long
    // is the only thing the operator wants to know.
    if (live > 0) {
      throw new ApiError(
        409,
        'CAMPAIGN_CALLS_IN_FLIGHT',
        `${live} call${live === 1 ? ' is' : 's are'} still connected on this campaign. ` +
          'Mark it complete once they finish — usually a few minutes.',
      );
    }

    // Guarded on the status this decision was taken against. Between the count
    // above and this write a callback booking may have re-opened the campaign,
    // and completing it on top of that would cancel a call somebody expects.
    const moved = await prisma.campaign.updateMany({
      where: { id: campaign.id, status: 'STOPPED' },
      // The relabel retires the stop; "Stopped by X." must not outlive it
      // onto a page that says the campaign finished.
      data: { status: 'COMPLETED', haltReason: null },
    });

    if (moved.count === 0) {
      throw new ApiError(
        409,
        'INVALID_CAMPAIGN_TRANSITION',
        'Campaign status changed — reload and try again.',
      );
    }

    // The same release a stop performs: a completed campaign is no longer a
    // reason for its agent to carry the managed block. Gated inside on there
    // being no other live campaign on that agent, because one agent may serve
    // several at once.
    if (campaign.agentId) {
      await releaseGoalPromptBlock(campaign.agentId, workspaceId);
    }

    const updated = await prisma.campaign.findUniqueOrThrow({
      where: { id: campaign.id },
      ...CAMPAIGN_INCLUDE,
    });

    void notify(
      workspaceId,
      'ALL_MEMBERS',
      'campaign.completed',
      `${updated.name} was marked complete`,
      `${accountOf(req).email} marked this stopped campaign complete.`,
      `/campaigns/${updated.id}`,
    );

    res.json({ success: true, data: serializeCampaign(updated) });
  }),
);

/**
 * Start, which is the one lifecycle action with a second caller.
 *
 * Everything it does lives in `campaignStart.ts`, so the schedule scanner runs
 * the identical routine — including the gates, which are the whole point. A
 * campaign started at 3am by a schedule must be refused for the same reasons
 * one started by hand at 3pm would be.
 */
campaignRoutes.post(
  '/:workspaceId/campaigns/:campaignId/start',
  requireAuth,
  requireMembership('ADMIN'),
  asyncHandler(async (req, res) => {
    const outcome = await startCampaign({
      campaignId: req.params.campaignId!,
      workspaceId: workspaceOf(req).id,
      overrides: req.body,
      actorEmail: accountOf(req).email,
    });

    if (!outcome.ok) throw new ApiError(outcome.status, outcome.code, outcome.message);

    res.json({ success: true, data: serializeCampaign(outcome.campaign) });
  }),
);

/**
 * Scheduling a start for later.
 *
 * **Deliberately checks nothing but the time.** No agent, no contacts, no
 * credits, no numbers: "schedule the campaign now, upload the list tonight" is
 * a thing operators do, and refusing here would make the feature useless to
 * them. Every one of those gates runs when the schedule fires, and a refusal
 * lands in `scheduleError` where the operator can read it in the morning.
 *
 * A column rather than a timer, because a restart loses a timer and a campaign
 * that quietly never starts is indistinguishable from one nobody scheduled.
 */
campaignRoutes.post(
  '/:workspaceId/campaigns/:campaignId/schedule',
  requireAuth,
  requireMembership('ADMIN'),
  asyncHandler(async (req, res) => {
    const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);
    const startAt = (req.body as { startAt?: unknown } | undefined)?.startAt;

    // A string or a number of milliseconds — both are what a client naturally
    // has. Anything else is not a date, whatever `new Date` would make of it.
    if (typeof startAt !== 'string' && typeof startAt !== 'number') {
      throw new ApiError(400, 'VALIDATION_ERROR', 'startAt must be a valid date-time.');
    }

    const when = new Date(startAt);

    if (Number.isNaN(when.getTime())) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'startAt must be a valid date-time.');
    }

    if (when.getTime() <= Date.now()) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'startAt must be in the future.');
    }

    if (campaign.status !== 'DRAFT') {
      throw new ApiError(
        400,
        'INVALID_CAMPAIGN_TRANSITION',
        'Can only schedule DRAFT campaigns.',
      );
    }

    // Re-posting reschedules, and clears whatever the last attempt failed on —
    // an error about a start that is no longer the one being waited for is
    // worse than none.
    const updated = await prisma.campaign.update({
      where: { id: campaign.id },
      data: { scheduledStartAt: when, scheduleError: null },
      ...CAMPAIGN_INCLUDE,
    });

    res.json({ success: true, data: serializeCampaign(updated) });
  }),
);

/**
 * Cancels a schedule, from any status.
 *
 * Both columns, because they are one fact between them: a schedule that has
 * been cancelled has no error to report either, and leaving the message behind
 * would have the page explaining a failure of something nobody is waiting for.
 */
campaignRoutes.delete(
  '/:workspaceId/campaigns/:campaignId/schedule',
  requireAuth,
  requireMembership('ADMIN'),
  asyncHandler(async (req, res) => {
    const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);

    const updated = await prisma.campaign.update({
      where: { id: campaign.id },
      data: { scheduledStartAt: null, scheduleError: null },
      ...CAMPAIGN_INCLUDE,
    });

    res.json({ success: true, data: serializeCampaign(updated) });
  }),
);

interface Transition {
  from: readonly CampaignStatus[];
  to: CampaignStatus;
  /** The verb in the past tense, for prose only: a customer-facing 409 and the
   *  sentence in the feed. Spelled out rather than derived, because
   *  `${action}ed` reads "pauseed". Reword it freely — nothing matches on it. */
  past: string;
  /** The persisted notification type, matched on by other code. Deliberately
   *  NOT derived from `past`: a tag that is stored in every row and an English
   *  string that exists to be reworded must not be the same string, or editing
   *  the error copy silently renames the event with no migration and no
   *  compile error. */
  event: string;
  /** Whether an agent must be wired up before the campaign may run. */
  requiresAgent: boolean;
  /** Whether the campaign must still have something left to dial. */
  requiresPending: boolean;
  /**
   * Whether this transition puts the campaign into a state where the dialer
   * will pick it up. Both transitions to RUNNING must pass the same gates:
   * `resume` reaches exactly the state `start` does, and a second list would
   * eventually let one of them through with fewer checks.
   */
  startsDialing: boolean;
  /**
   * The clocks this action stamps beside the status.
   *
   * Data rather than a branch in the handler, for the reason the rest of the
   * table is: an action whose timestamp is written somewhere other than here is
   * one that eventually stops being written at all.
   */
  stamp?: (now: Date, actor: string) => Prisma.CampaignUncheckedUpdateInput;
  /**
   * The whole write, for an action that is more than a status change.
   *
   * `stop` empties the queue and counts what it emptied, under a lock other
   * writers order themselves against — none of which fits in `stamp`.
   */
  write?: (campaignId: string, now: Date, actor: string) => Promise<CampaignWithAgent>;
}

/**
 * The whole lifecycle, as data. An action attempted from a status it does not
 * list is a 409 rather than a silent no-op: pausing an already-stopped
 * campaign means the operator is looking at stale state and should be told.
 *
 * `start` is deliberately absent. It is the one action with a second caller —
 * the schedule scanner — and it therefore lives in `campaignStart.ts`, where
 * both doors run the identical routine. A row here that duplicated its gates
 * is exactly the drift that service exists to prevent.
 */
const TRANSITIONS: Record<string, Transition> = {
  pause: {
    from: ['RUNNING'],
    to: 'PAUSED',
    past: 'paused',
    event: 'campaign.paused',
    requiresAgent: false,
    requiresPending: false,
    startsDialing: false,
    // The reason is the person: the campaign page says who, the way the
    // notification does.
    stamp: (now, actor) => ({ pausedAt: now, haltReason: `Paused by ${actor}.` }),
  },
  // resume deliberately drops requiresPending: a campaign paused near its end
  // can have every remaining contact already in flight, and refusing to resume
  // it would be wrong.
  // CREDIT_EXHAUSTED is a from-state for resume and stop alike. The dispatcher
  // writes it when the owner's balance falls below the float, and it is the
  // operator's own campaign: a status only the dialer can write and no route
  // accepts is a campaign stranded by a top-up nobody could act on.
  resume: {
    from: ['PAUSED', 'CREDIT_EXHAUSTED'],
    to: 'RUNNING',
    past: 'resumed',
    event: 'campaign.resumed',
    requiresAgent: true,
    requiresPending: false,
    startsDialing: true,
    // Cleared rather than left standing: the column answers "paused since
    // when", and a resumed campaign is not paused.
    stamp: () => ({ pausedAt: null, haltReason: null }),
  },
  stop: {
    from: ['DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'CREDIT_EXHAUSTED'],
    to: 'STOPPED',
    past: 'stopped',
    event: 'campaign.stopped',
    requiresAgent: false,
    requiresPending: false,
    startsDialing: false,
    write: stopCampaign,
  },
};

for (const [action, transition] of Object.entries(TRANSITIONS)) {
  campaignRoutes.post(
    `/:workspaceId/campaigns/:campaignId/${action}`,
    requireAuth,
    requireMembership('ADMIN'),
    asyncHandler(async (req, res) => {
      const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);

      if (!transition.from.includes(campaign.status)) {
        throw new ApiError(
          409,
          'INVALID_CAMPAIGN_TRANSITION',
          `A ${campaign.status.toLowerCase()} campaign cannot be ${transition.past}.`,
        );
      }

      // Not a null check. `agentId` being set proves only that an Agent row
      // exists — staff unassign by setting `Agent.workspaceId = null` and sync
      // retires by setting `status`, both UPDATEs the foreign key cannot see,
      // so a campaign can hold a perfectly valid id for an agent it cannot use.
      //
      // Read from the row `campaignInWorkspace` already joined rather than
      // queried again: a second read is not only wasted, it is taken at a
      // different instant, so the gate and the response it returns could
      // disagree about the same campaign within one request.
      //
      // Every cause lands on the same code and message deliberately: the remedy
      // is to pick an agent whichever it was, and a second code would only ask
      // the operator to tell apart situations with one fix.
      if (transition.requiresAgent && !agentIsUsable(campaign.agent, campaign.workspaceId)) {
        throw new ApiError(
          409,
          'CAMPAIGN_AGENT_REQUIRED',
          'Assign an agent before starting this campaign.',
        );
      }

      if (transition.requiresPending) {
        const pending = await prisma.campaignContact.count({
          where: { campaignId: campaign.id, status: 'PENDING' },
        });

        // A campaign with nothing to dial is not running, it is misconfigured,
        // and the operator should learn that here rather than from an empty
        // report later.
        if (pending === 0) {
          throw new ApiError(
            409,
            'CAMPAIGN_REQUIRES_PENDING_CONTACTS',
            'Add at least one contact before starting this campaign.',
          );
        }
      }

      /**
       * The dialer's own gates, and then the one thing `start` does upstream.
       *
       * Local checks first and the platform call last, so a start that is
       * going to be refused never writes to a partner account every customer
       * shares — no routing built for a campaign that cannot run.
       *
       * This is where `start` stopped being state-only. The campaigns slice
       * said the dialer would decide whether a caller number is required; it
       * is, and `assertCampaignDialable` is where that is enforced.
       */
      // Validated against the stored pair, so a resume can shift slots between
      // the lanes on its way back into dialing. Only for the transitions that
      // reach RUNNING: a pause has no next claim to size.
      const concurrency = transition.startsDialing
        ? validateConcurrencyUpdate(req.body, campaign)
        : {};

      if (transition.startsDialing) {
        // A pure INBOUND campaign answers rather than dials, so the outbound
        // gates do not apply to it; BOTH runs both, and so does resume, using
        // the identical inbound gate + claim as start (`runInboundStart`).
        if (campaign.type === 'OUTBOUND' || campaign.type === 'BOTH') {
          await assertCampaignDialable(campaign);
          await ensureCallerNumberReady(campaign.phoneNumber!.did);
        }
        await runInboundStart(campaign);
      }

      const now = new Date();

      const actor = accountOf(req).email;
      const updated = transition.write
        ? await transition.write(campaign.id, now, actor)
        : await prisma.campaign.update({
            where: { id: campaign.id },
            data: { status: transition.to, ...transition.stamp?.(now, actor), ...concurrency },
            ...CAMPAIGN_INCLUDE,
          });

      /**
       * The things a campaign needs upstream that are not about placing the
       * call: the extraction key that lets a finished call say a callback was
       * asked for, and — for a goal campaign — the verdict set plus the
       * managed block in the agent's prompt.
       *
       * **After** the transition, deliberately. Every write is idempotent and
       * safe to re-run on every start and resume, and none may ever fail one
       * — a campaign that cannot book callbacks still dials, and refusing to
       * start it over this would be the worse outcome. Failures notify.
       */
      if (transition.startsDialing && campaign.agent) {
        // Read on its own rather than widened into `CAMPAIGN_INCLUDE`: the
        // platform's id for an agent is not a campaign field, and an include
        // that grows for one caller is one careless spread away from a response.
        const agent = await prisma.agent.findUnique({
          where: { id: campaign.agent.id },
          select: { externalId: true },
        });

        if (agent) {
          await prepareCampaignAgent(agent.externalId, workspaceOf(req).id, updated);
        }
      }

      /**
       * And the mirror, on the way out. A stopped campaign gives the block
       * back to its agent — but only once no other RUNNING, PAUSED or
       * CREDIT_EXHAUSTED campaign in the workspace still points at it,
       * which `releaseGoalPromptBlock` checks after the write above has
       * already moved this one to STOPPED. Nothing in it can throw: a stop is
       * the action an operator presses when something is already wrong, and
       * it must not depend on the platform being reachable.
       */
      if (transition.to === 'STOPPED' && campaign.agentId) {
        await releaseGoalPromptBlock(campaign.agentId, workspaceOf(req).id);
      }

      /**
       * Every exit from RUNNING gives back the DIDs this campaign was answering
       * on (design §5.2): the claims are deleted and each number is unbound
       * upstream, so an inbound call on it is rejected rather than answered by a
       * campaign that has stopped. Pause releases too — a paused inbound
       * campaign can lose its numbers to a rival, which is the deliberate trap
       * the pause warning (Task 20) exists to surface.
       *
       * Idempotent and safe for OUTBOUND (no claims). Only for transitions that
       * leave RUNNING; resume, which enters it, has already re-claimed above.
       */
      if (transition.to !== 'RUNNING') {
        await releaseInboundClaims(campaign.id);
      }

      // One emitter for the whole loop rather than four copies: the action
      // name is already the verb, and "why is this campaign not dialling" is
      // a question a MEMBER can act on, so the whole workspace sees it.
      void notify(
        workspaceOf(req).id,
        'ALL_MEMBERS',
        transition.event,
        `${updated.name} was ${transition.past}`,
        `${accountOf(req).email} ${transition.past} this campaign.`,
        `/campaigns/${updated.id}`,
      );

      res.json({ success: true, data: serializeCampaign(updated) });
    }),
  );
}


/**
 * The campaign exports: the leads sheet and the call-detail sheet.
 *
 * Two files rather than one, because they answer two questions and a reader
 * needs a different one of them depending on what they are doing. The leads
 * sheet is one row per person — where they stand, what the conversation
 * extracted, and the variables the dial went out with — and is the worklist an
 * operator sorts and filters. The call detail is one row per dial and is what
 * reconciles against the carrier call-for-call.
 *
 * Both are at header parity with the export this product replaces, so either
 * is a drop-in for anything already reading those files.
 *
 * **Member reads**, following the analytics export and every other read on this
 * surface: nothing in a workspace's own call history is sensitive to a MEMBER
 * that an ADMIN should see instead, and a MEMBER operating campaigns is exactly
 * the person who needs the file.
 */

/**
 * A campaign's name, reduced to something that may go in a header.
 *
 * The name is the customer's own text and may hold a comma, a quote or a
 * newline — the reason the analytics export uses a workspace's slug rather
 * than its name for the same job. There is no campaign slug, so this is the
 * reduction: word characters survive, runs of anything else become one
 * underscore, and the result is bounded.
 */
function filenameSafe(name: string): string {
  const reduced = name.replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

  return reduced === '' ? 'campaign' : reduced;
}

/** `YYYYMMDD_HHMMSS`, the stamp the reference filenames carry. */
function filenameStamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
}

/**
 * Streams one export to the response.
 *
 * Shared by both routes because the response handling — not the rows — is
 * what they have in common, and it is the half with the trap in it: once the
 * header row is out the status line has gone with it, so a failure mid-stream
 * can only be signalled by destroying the connection. Ending normally would
 * hand the reader a truncated file that opens perfectly well and is missing
 * rows, which is the one outcome forbidden on every listing in this service.
 */
async function streamExport(
  res: Parameters<Parameters<typeof asyncHandler>[0]>[1],
  filename: string,
  run: (sink: {
    write: (chunk: string) => boolean;
    drain: () => Promise<void>;
    aborted: () => boolean;
  }) => Promise<void>,
): Promise<void> {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // One customer's lead list, leaving through a URL a shared cache has no way
  // to scope. Nothing about it belongs in one.
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200);

  try {
    await run({
      write: (chunk) => res.write(chunk),
      // Honoured rather than ignored: without it a slow client has the whole
      // export accumulate in this process's socket buffer, and "no row cap"
      // becomes an unbounded allocation rather than a long download. Raced
      // against `close`, because a reader who shuts the tab never drains and
      // awaiting drain alone would suspend the walk for the life of the
      // process.
      drain: () => Promise.race([once(res, 'drain'), once(res, 'close')]).then(() => undefined),
      aborted: () => res.destroyed || res.writableEnded,
    });
  } catch (error) {
    res.destroy(error instanceof Error ? error : undefined);
    throw error;
  }

  res.end();
}

campaignRoutes.get(
  '/:workspaceId/campaigns/:campaignId/export/leads',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    // Resolved against the workspace first, and a foreign id, an unmapped one
    // and nonsense all 404 alike — `campaignInWorkspace` is the same lookup
    // every other campaign route runs, so an export can never be the one
    // surface that widens what a caller may read.
    const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);

    const filename = `${filenameSafe(campaign.name)}_leads_${filenameStamp(new Date())}.csv`;

    await streamExport(res, filename, (sink) =>
      streamLeadsCsv(campaign.id, sink, { appUrl: env.dashboardUrl }),
    );
  }),
);

campaignRoutes.get(
  '/:workspaceId/campaigns/:campaignId/export/calls',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);

    const filename = `ai_call_detail_${campaign.id}_${filenameStamp(new Date())}.csv`;

    await streamExport(res, filename, (sink) =>
      streamCallsCsv(campaign.id, sink, { appUrl: env.dashboardUrl }),
    );
  }),
);

/**
 * The custom export: one row per dial, the column groups named in `?fields=`.
 *
 * Both parameters are validated BEFORE the campaign lookup and before any
 * header goes out, because once the CSV header is written the status line is
 * gone with it — a refusal has to happen while a 400 is still possible.
 *
 * `from`/`to` are optional and filter `startedAt`; absent, the whole campaign
 * is walked. Present, they go through the analytics parser so a bare day and
 * a zoned instant mean the same thing here as on every chart.
 */
campaignRoutes.get(
  '/:workspaceId/campaigns/:campaignId/export/custom',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    let fields;
    try {
      fields = parseCustomExportFields(req.query.fields);
    } catch (error) {
      if (error instanceof CustomExportFieldsError) {
        throw new ApiError(400, 'VALIDATION_ERROR', error.message);
      }
      throw error;
    }

    const range =
      req.query.from !== undefined || req.query.to !== undefined
        ? parseAnalyticsRange(req.query as Record<string, unknown>)
        : undefined;

    const campaign = await campaignInWorkspace(workspaceOf(req).id, req.params.campaignId!);

    const filename = `${filenameSafe(campaign.name)}_custom_${filenameStamp(new Date())}.csv`;

    await streamExport(res, filename, (sink) =>
      streamCustomCsv(campaign.id, sink, { fields, range, appUrl: env.dashboardUrl }),
    );
  }),
);
