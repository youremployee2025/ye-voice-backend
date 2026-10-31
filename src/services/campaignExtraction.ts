import { createHash } from 'node:crypto';
import {
  attachAgentExtractionSet,
  createExtractionSet,
  detachAgentExtractionSet,
  getAgent,
  listAgentExtractionSets,
  listExtractionSets,
  updateAgent,
} from '../adapter/vocobase.js';
import type { ExtractionSetsResponse, UpstreamRecord } from '../adapter/vocobase.js';
import { readArray, readBoolean, readRecord, readString } from '../lib/upstream.js';
import { notify } from '../lib/notify.js';
import { ensureGoalPromptBlock } from './campaignPrompt.js';
import {
  CALLBACK_REQUESTED_AT_KEY,
  CALL_NOTE_KEYS,
  CALL_OUTCOMES,
} from '../lib/extractionConfig.js';

/**
 * Making sure a campaign's agent carries the extraction keys YE manages.
 *
 * Nothing here books or blocks anything. Each routine puts one named key set
 * on the agent so the completed call carries the value at all — without the
 * callback key, `campaignCallback.ts` reads an extraction that never contains
 * a promise and a campaign with callbacks turned on quietly books none;
 * without the call-note set, a goal campaign's every call comes back with no
 * outcome and every contact is followed up to its cap.
 *
 * ## Why the keys are ours and named this
 *
 * The platform reserves `callback_at` for itself and rejects a partner
 * definition of it, and injects its own only on calls its own campaign product
 * originates — which ours are not, since YE dials plain V2 calls. So YE owns
 * keys of its own names, and reads the reserved one as a fallback only.
 *
 * ## Idempotent, and never in the way
 *
 * Safe to call on every start and every resume: each set is found by name
 * before it is created, the attach is idempotent upstream, and the agent's
 * master switch is only written when it is off. Every failure is caught,
 * logged and turned into a notification an ADMIN can act on — a campaign that
 * cannot book callbacks (or leave a call note) is a campaign that still dials,
 * and refusing to start it over this would be a worse outcome than the one it
 * is protecting against.
 *
 * ## And the name carries the content
 *
 * There is no way to update a set upstream, so a set found by a fixed name is
 * a set this service can never correct — every later edit to a description
 * here would be inert against a pool that already holds one of that name.
 * `versionedSetName` therefore suffixes the name with a fingerprint of the
 * keys, so an edited description is a different set and unchanged code is the
 * same set. `hasDrifted` is what decides whether the set already there counts,
 * and it answers "not drifted" to everything it cannot read — see its header
 * for why that direction is the only safe one.
 */

/**
 * The managed callback set. Found by name — suffixed with a fingerprint of its
 * keys, see `versionedSetName` — because the sets pool is partner-wide and
 * shared, so there is no id of ours to store.
 *
 * The name carries no supplier: an operator reads it in the agent's own
 * extraction editor, beside the keys they wrote themselves, and it follows the
 * same rule as every other customer-facing string here and the prompt block.
 */
export const CALLBACK_EXTRACTION_SET_NAME = 'Campaign callbacks';

export const CALLBACK_KEY_DESCRIPTION =
  'The absolute date and time the person asked to be called back, if they asked at all. ' +
  'Null if no callback was requested or no specific time was agreed. Include the UTC offset.';

/** The managed call-note set, attached when a goal campaign starts. */
export const CALL_NOTE_EXTRACTION_SET_NAME = 'Campaign call note';

/**
 * The names these two sets were created under before they were de-branded,
 * newest first.
 *
 * There is no rename endpoint upstream, so a rename is a NEW set: the old one
 * stays in the partner-wide pool and stays attached to every agent that ever
 * ran a campaign. Left there it is the same fault two versions of one set are
 * — the model asked the same question twice, under two names, and the answers
 * merged by whichever came back last — so the old name is matched by
 * `isVersionOf` exactly as a superseded fingerprint is, and detached once the
 * new set is on.
 *
 * A name dropped from one of these lists is a set left on somebody's agent
 * with no code path able to find it again, so entries are only ever ADDED —
 * the same rule the prompt block's marker pairs follow, and for the same
 * reason.
 */
const CALLBACK_SUPERSEDED_NAMES = ['EZO campaign callbacks'] as const;
const CALL_NOTE_SUPERSEDED_NAMES = ['EZO campaign call note'] as const;

/**
 * Sets earlier releases attached that this one no longer reads. Detached on
 * every goal start so an agent stops paying for extraction nothing consumes.
 * `YE campaign goals` is the verdict set the call note replaced: an agent
 * that served a goal campaign under that release still carries it, and a
 * model asked both sets' questions at once answers the old vocabulary
 * beside the new one for nobody.
 *
 * **The de-branding does not touch these, and the reason is not that they
 * belong to somebody else** — every one of them was written by an earlier
 * version of this file (`OPT_OUT_EXTRACTION_SET_NAME`, de9c926). It is that a
 * retired name is only ever DETACHED, never created: it is the handle on a set
 * already sitting on agents under exactly that spelling, and there is no
 * write that would ever produce a re-spelled one. Renaming an entry here
 * therefore strands the set it names — extracted for ever, with no code path
 * left able to ask for it by the name it actually has.
 *
 * The two sets this release still creates are a different case, because a
 * rename there does produce a new set: they are renamed, and the names they
 * had live in the superseded lists above, which is what detaches the old ones.
 */
export const RETIRED_EXTRACTION_SET_NAMES = [
  'EZO campaign opt-outs',
  'EZO call summaries',
  'EZO campaign goals',
] as const;

/**
 * The call-note keys' descriptions, verbatim from the specification. None
 * names a campaign: the descriptions are the platform's own wording for what
 * every call of a note campaign answers, and the goal itself reaches the
 * model through the customer's prompt, not through these.
 *
 * `values` pins the answers the outcome and the immediate-callback flag may
 * take. A prompt instruction upstream rather than a schema enum — the model
 * may still answer outside the list, or not at all, which is why
 * `readCallNote` re-judges every field on the way back in.
 *
 * Both pinned descriptions open by naming those same answers in prose
 * ("Allowed values: …"). The repetition is the specification's and is kept:
 * the pinned list is a field of the set, which the model may or may not be
 * shown, and the description is the sentence it certainly reads.
 *
 * ## How long a description may be
 *
 * `MAX_EXTRACTION_KEY_DESCRIPTION_CHARS` is **YE's** rule about what a
 * partner may send through `extractionConfigSchema`, not the platform's rule
 * about what a set may hold. These descriptions never pass through that
 * schema — they go straight to `createExtractionSet` — so the instructions
 * key's length is not a violation of it whatever that limit happens to be,
 * and the partner limit is the partners' business alone.
 *
 * The platform's own ceiling is unknown. A test caps the managed set at 1000
 * so a description cannot grow without somebody deciding to, and the live
 * handset rehearsal is what confirms the platform accepts this length: a set
 * it refuses is refused silently, and every call of the campaign then comes
 * back with no note. The instructions key is the longest at ~985 characters:
 * it carries the format of the two opening lines the next call recites, and
 * that format is the part the runs of 2026-09-03 and 2026-09-04 showed to be
 * load-bearing. Contender I's added closing sentence left it still under the
 * guard; the guard is what the next growth in it has to answer to.
 */
export const CALL_NOTE_DESCRIPTIONS: Record<
  (typeof CALL_NOTE_KEYS)[number],
  { type: string; description: string; values?: string[] }
> = {
  call_outcome_vocobaseplatform: {
    type: 'string',
    values: [...CALL_OUTCOMES],
    description:
      'Allowed values: "incomplete", "stop", or "completed". "incomplete" if the conversation is ' +
      'incomplete based on the agent prompt provided, hence a callback is needed. "stop" if the ' +
      'user does not want further contact, is the wrong person, or there is clearly no reason to ' +
      'call again. "completed" if the conversation is complete based on the agent prompt provided, ' +
      'hence does not need a callback.',
  },
  call_outcome_reason_vocobaseplatform: {
    type: 'string',
    description:
      'Reason for why you marked call_outcome_vocobaseplatform as "incomplete", "stop", or ' +
      '"completed", in 5 words or less.',
  },
  immediate_callback_needed_vocobaseplatform: {
    type: 'string',
    values: ['yes', 'no'],
    description:
      'Allowed values: "yes" or "no". Based on the conversation transcript, check whether the ' +
      'call ended abruptly in the middle of a conversation. Mark as "yes" if it did, and hence ' +
      'the system should trigger a callback immediately to resume the conversation. Otherwise, ' +
      'mark as "no" if the call seems to have ended intentionally, either by the user or the bot.',
  },
  immediate_callback_needed_reason_vocobaseplatform: {
    type: 'string',
    description:
      'Reason for why you marked immediate_callback_needed_vocobaseplatform as "yes" or "no", in ' +
      '5 words or less.',
  },
  callback_requested_time_vocobaseplatform: {
    type: 'string',
    description:
      'If the user has explicitly requested a time, generate the callback time accordingly. If ' +
      'the user requested a callback without specifying a time, suggest the most suitable time ' +
      'based on the calling window and the conversation context. Mark as "null" if (1) ' +
      'call_outcome_vocobaseplatform is marked as "stop" or "completed", or (2) ' +
      'immediate_callback_needed_vocobaseplatform is marked as "yes". Generate the callback time ' +
      'in YYYY-MM-DDTHH:mm±HH format only. Refer to the timestamp of when this call ended to ' +
      'schedule the callback correctly.',
  },
  /**
   * Step 1 sets the context as well as pointing at the previous call. That
   * clause is the whole of contender H's edit to this key; the five labelled
   * sections and the stated format of the two opening lines are G's.
   *
   * What Step 1 does **not** do is name when the previous call was. Run 1
   * measured the timestamp reaching every follow-up dial correctly and **0 of
   * 17 openers using it**: the bot writes Step 1 at the end of the previous
   * call, where the format tells it to stay generic, so the line it writes
   * cannot refer to a time and the next agent recites that line. A clause
   * asking for the time here was tried and is not part of the specification's
   * wording, which this description carries verbatim — the unused timestamp
   * is one of the questions contender H carries forward rather than closes.
   * See `docs/plans/2026-09-03-call-note-run-1.md`.
   *
   * Contender I's whole edit to this key is one closing sentence — "Frame
   * sentences in the second person while describing what this agent did in
   * the call." — appended after the existing KEEP IN MIND clause; everything
   * above is H's and G's, unchanged.
   */
  next_call_instructions_vocobaseplatform: {
    type: 'string',
    description:
      'Generate brief system instructions for the next call in less than 1,200 characters. Frame it ' +
      'like this: PREVIOUS CALL SUMMARY: [summary of the call and where exactly it stopped], ' +
      'ALREADY COVERED: [what has been discussed so far], RESUME FROM: [describe where the ' +
      'conversation should resume from], OPENING SCRIPT: [explicit instruction to skip the standard ' +
      'flow and exact lines to use for opening the next call in the following format: Step 1: ' +
      '“[short, generic one-liner that simply refers to the previous interaction to set the context ' +
      '(without going into specifics) and asks if we can continue]” → if the user agrees → Step 2: ' +
      '“[one-liner to set the context and continue from where the call stopped]”], KEEP IN MIND: ' +
      '[additional information such as user preferences, sentiment, or anything else that is ' +
      'important for the next call]. Do not include information that is not useful for the next ' +
      'call. Frame sentences in the second person while describing what this agent did in the call.',
  },
  call_end_timestamp_vocobaseplatform: {
    type: 'string',
    description: 'Give the timestamp of when the call ended in YYYY-MM-DDTHH:mm±HH format.',
  },
};

/** The sets in a listing, whichever envelope they arrived under. An
 *  unrecognised shape reads as no sets rather than throwing: this decides
 *  whether to create one, and creating a second is the recoverable mistake. */
function readSets(body: ExtractionSetsResponse | UpstreamRecord | null): UpstreamRecord[] {
  if (Array.isArray(body)) return body as UpstreamRecord[];
  if (!body) return [];

  for (const key of ['extraction_sets', 'extractionSets', 'sets', 'data']) {
    const value = (body as UpstreamRecord)[key];
    if (Array.isArray(value)) return value as UpstreamRecord[];
  }

  return [];
}

/** The id of a set, wherever the endpoint put it. */
function readSetId(body: UpstreamRecord | null): string | null {
  if (!body) return null;

  return (
    readString(body, ['id', 'extraction_set_id', 'set_id']) ??
    readString(readRecord(body, ['extraction_set']) ?? {}, ['id'])
  );
}

interface ManagedSet {
  name: string;
  /** The names this set was created under before, if it has been renamed.
   *  Matched the same way a superseded fingerprint is, and detached once the
   *  current set is attached — see `CALLBACK_SUPERSEDED_NAMES`. */
  supersedes?: readonly string[];
  description: string;
  /** `values` pins the answers a key may take. A prompt instruction rather
   *  than a schema enum upstream — the model may still answer outside it, or
   *  not at all, which is why every call-note field is re-judged on the way
   *  back in rather than trusted because it was pinned here. */
  keys: { name: string; type: string; description: string; values?: string[] }[];
}

/**
 * The callback set, for campaigns without a goal. The platform reserves the
 * name `callback_at` and refuses a partner key of it, so the time a person
 * asked to be called at can only arrive through a key of our own. A goal
 * campaign does not attach this one: its time rides in the call-note set,
 * under `callback_requested_time_vocobaseplatform`, and two keys asking one
 * question would give the booking two answers to choose between.
 */
const CALLBACK_SET: ManagedSet = {
  name: CALLBACK_EXTRACTION_SET_NAME,
  supersedes: CALLBACK_SUPERSEDED_NAMES,
  description: 'Lets a campaign book the call a lead asked for.',
  keys: [
    {
      name: CALLBACK_REQUESTED_AT_KEY,
      type: 'datetime',
      description: CALLBACK_KEY_DESCRIPTION,
    },
  ],
};

/**
 * A managed set's content, as one string, and the eight hex characters of it
 * that go in the set's name.
 *
 * The name is deliberately not part of what is hashed. The suffix is what the
 * hash names, so folding it back in would make each version's fingerprint
 * depend on the version before it and no two deployments of the same source
 * could agree on a name.
 *
 * There is no `updateExtractionSet` upstream, which is the whole reason this
 * exists: a set is found by name, and a name that never changes means every
 * later edit to `CALL_NOTE_DESCRIPTIONS` is inert against a pool that already
 * holds a set of that name. Deriving the name from the content instead makes
 * an edit a different set, and the same content the same set — so re-running
 * a start against unchanged code churns nothing.
 */
function setFingerprint(set: ManagedSet): string {
  const content = JSON.stringify([
    set.description,
    set.keys.map((key) => [key.name, key.type, key.description, key.values ?? []]),
  ]);

  return createHash('sha256').update(content).digest('hex').slice(0, 8);
}

function versionedSetName(set: ManagedSet): string {
  return `${set.name} (${setFingerprint(set)})`;
}

/**
 * The suffix, matched exactly rather than loosely.
 *
 * The sets pool is partner-wide, so a set somebody named "Campaign
 * callbacks (old)" by hand is in the same listing as ours. A prefix test would
 * claim it as a version of ours and detach it from an agent it was put on
 * deliberately; eight hex digits in brackets is a shape nobody types.
 */
const VERSION_SUFFIX = /^ \([0-9a-f]{8}\)$/;

function isNamed(name: string, base: string): boolean {
  return name === base || (name.startsWith(base) && VERSION_SUFFIX.test(name.slice(base.length)));
}

/**
 * Whether a set upstream is this managed set — under its current name or one
 * it was created under before, with or without a fingerprint.
 *
 * The superseded names go through the same exact-suffix test as the current
 * one, never a prefix match: "YE campaign callbacks (old)" is somebody's own
 * set in a pool every partner shares, and claiming it as a version of ours
 * detaches it from an agent it was put on deliberately.
 */
function isVersionOf(name: string, set: ManagedSet): boolean {
  return isNamed(name, set.name) || (set.supersedes ?? []).some((base) => isNamed(name, base));
}

/**
 * Whether the set upstream still says what this release says it says.
 *
 * ## Every unreadable answer is "not drifted", on purpose
 *
 * This decides whether to create a second set, and it runs on every campaign
 * start. Read the other way round, a listing shape this adapter does not
 * recognise — a summary listing that carries no keys, a field renamed
 * upstream, an envelope nobody has met — would read as "every key is
 * missing", and every start of every campaign would create another versioned
 * set and detach the one before it, for ever, against a partner pool every
 * customer shares.
 *
 * So the two failures are not symmetrical and this picks the recoverable one.
 * A set that has genuinely drifted and reads as current costs this release its
 * edit until somebody looks; a set that is current and reads as drifted costs
 * the pool a set per start. Only the first can be fixed after the fact.
 *
 * A key that is present on both sides and disagrees is the one case that is
 * read as drift, along with a key added or removed — those need no guessing
 * about the envelope.
 */
function hasDrifted(existing: UpstreamRecord, set: ManagedSet): boolean {
  const keys = readArray(existing, ['keys', 'extraction_keys', 'extractionKeys']);
  if (keys === null) return false;

  const description = readString(existing, ['description']);
  if (description !== null && description !== set.description) return true;

  const upstream = new Map<string, unknown>();

  for (const key of keys) {
    const name = readString(key, ['name']);
    if (name === null) return false;

    upstream.set(name, key);
  }

  if (upstream.size !== set.keys.length) return true;

  return set.keys.some((key) => {
    const found = upstream.get(key.name);
    if (found === undefined) return true;

    const keyDescription = readString(found, ['description']);
    if (keyDescription !== null && keyDescription !== key.description) return true;

    const type = readString(found, ['type']);
    if (type !== null && type !== key.type) return true;

    const values = readArray(found, ['values']);
    if (values === null || !values.every((value) => typeof value === 'string')) return false;

    // Compared element by element rather than through a joined string: any
    // separator is a value a list could legitimately contain, and the one
    // separator that cannot be typed is a literal NUL, which in source makes
    // this file read as binary to grep and every tool built on it.
    const wanted = key.values ?? [];
    return values.length !== wanted.length || values.some((value, i) => value !== wanted[i]);
  });
}

/**
 * Ensures one YE-managed set exists upstream, says what this release says,
 * and is attached to the agent. Throws on failure; turning that into a
 * notification is the public routines' job, because each names its own
 * consequence.
 */
async function ensureManagedSetAttached(agentExternalId: string, set: ManagedSet): Promise<void> {
  const pool = readSets(await listExtractionSets());
  const wantedName = versionedSetName(set);

  const named = (name: string): UpstreamRecord | undefined =>
    pool.find((candidate) => readString(candidate, ['name']) === name);

  /**
   * The set whose name already carries this content's fingerprint is reused
   * without being read: the suffix *is* the content.
   *
   * Failing that, the unversioned set — what every release before drift
   * detection created, and what production is carrying now. It is reused when
   * it still matches, which is the ordinary case and must cost nothing, and
   * left behind when it does not: a set created by a rehearsal or a staging
   * run under a draft description is exactly the case this branch exists for,
   * because that set is what production would otherwise silently inherit.
   */
  let attachedName = wantedName;
  let existing = named(wantedName);

  if (!existing) {
    const original = named(set.name);

    if (original && !hasDrifted(original, set)) {
      existing = original;
      attachedName = set.name;
    }
  }

  const setId = existing
    ? readSetId(existing)
    // Built field by field rather than spread: `supersedes` is this module's
    // own bookkeeping about names, not something the platform has any use for,
    // and an unknown field in a create body is a request an upstream that
    // validates its input is entitled to refuse.
    : readSetId(
        await createExtractionSet({
          name: wantedName,
          description: set.description,
          keys: set.keys,
        }),
      );

  if (!setId) throw new Error(`the voice platform returned no id for the "${set.name}" set`);

  const attached = readSets(await listAgentExtractionSets(agentExternalId));

  /**
   * The versions this agent carried before, taken off — BEFORE the new one
   * goes on, which is the only order the platform accepts.
   *
   * Two versions of one managed set cannot be attached together, and it is the
   * platform that says so rather than a preference of ours: an attach is
   * validated against every key name already on the agent and refused with 409
   * `EXTRACTION_KEY_CLASH` when one is taken. Every version of a managed set
   * defines the same names as the version before it — that is what makes it a
   * version — so the new one is refused for exactly as long as the old one is
   * attached.
   *
   * Attaching first therefore cannot work on any agent that has run an earlier
   * release: the attach throws, the detach never runs, and the agent keeps the
   * old wording for ever while every start logs a failure. Contender H was
   * created upstream at 14:50 IST on 2026-09-05 and refused four times that
   * way; every call of the campaign extracted under the previous release's
   * keys, and the renamed key it added never appeared at all.
   *
   * The window this opens — the agent asked nothing between the detach and the
   * attach — is the thing the old order was written to avoid, and it is not
   * avoidable: the platform will not hold both versions at once, so any order
   * that lands the new one takes the old one off first. It is also not a cost
   * the ordinary start pays. An agent carrying no version of this set detaches
   * nothing and has no window, and an agent already carrying THIS version
   * detaches nothing either, because `attachedName` is excluded below.
   *
   * Detached by name through the same routine the retired sets go through:
   * the name is all two versions of one managed set differ by, and it is the
   * only handle that routine takes.
   */
  const stale = attached
    .map((candidate) => readString(candidate, ['name']))
    .filter((name): name is string => name !== null && name !== attachedName && isVersionOf(name, set));

  for (const name of stale) {
    console.log(`[campaign] retiring "${name}" from ${agentExternalId}; it is not "${attachedName}"`);

    await ensureManagedSetDetached(agentExternalId, name);
  }

  // Attaching again is a 200 upstream rather than an error, so this check is
  // for the round trip rather than for correctness. Read from the listing
  // taken above: the only writes since are the detaches, and none of them can
  // have touched this set — `attachedName` is excluded from `stale`.
  if (!attached.some((candidate) => readSetId(candidate) === setId)) {
    await attachAgentExtractionSet(agentExternalId, setId);
  }
}

/**
 * Makes sure an YE-managed set is NOT on the agent — the mirror of the attach
 * above, and what keeps a set this service stopped reading from going on being
 * extracted for ever.
 *
 * An agent that ran under an earlier release still carries the sets that
 * release attached. Nothing consumes them now, so left alone they are the
 * customer paying for extraction work no surface in this service reads. Every
 * goal start sweeps them, because a start is the only moment this service is
 * certainly holding the agent's id and is already talking to the platform.
 *
 * One round trip in the ordinary case: the agent's own listing is asked first,
 * and an agent that does not carry a set of our name is already where it
 * should be. A listing that names none of its sets reads as "not attached" and
 * detaches nothing — the safe direction, since the alternative is removing a
 * set we cannot identify.
 */
async function ensureManagedSetDetached(agentExternalId: string, setName: string): Promise<void> {
  const attached = readSets(await listAgentExtractionSets(agentExternalId)).find(
    (candidate) => readString(candidate, ['name']) === setName,
  );

  const setId = readSetId(attached ?? null);

  if (!setId) return;

  await detachAgentExtractionSet(agentExternalId, setId);
}

/**
 * The agent's own master switch, which is not the same control as having
 * keys: an agent can carry the key with extraction off and extract nothing.
 * Only written when it is off, so a start does not touch an agent's config
 * on every press.
 */
async function ensureExtractionEnabled(agentExternalId: string): Promise<void> {
  if (readBoolean(await getAgent(agentExternalId), ['extraction_enabled']) !== true) {
    await updateAgent(agentExternalId, { extraction_enabled: true });
  }
}

/**
 * Ensures the agent carries the callback key, and that extraction is on.
 *
 * Returns whether it got there. The caller does not act on `false` beyond what
 * the notification already says — this must never block a transition.
 */
export async function ensureCallbackExtractionKey(
  agentExternalId: string,
  workspaceId: string,
  campaignName: string,
): Promise<boolean> {
  try {
    await ensureManagedSetAttached(agentExternalId, CALLBACK_SET);

    await ensureExtractionEnabled(agentExternalId);

    return true;
  } catch (err) {
    console.error(`[campaign] could not attach the callback extraction key to ${agentExternalId}:`, err);

    void notify(
      workspaceId,
      'ADMINS_ONLY',
      'campaign.callback_key_unavailable',
      `${campaignName} may not book callbacks`,
      'This campaign started, but its agent could not be set up to record a requested callback time. ' +
        'Calls will be placed as normal; callbacks asked for on them will not be booked.',
      '/campaigns',
    );

    return false;
  }
}

/**
 * The call-note set as it goes upstream. Built from the descriptions rather
 * than listed again, so the set the agent is given and the keys
 * `readCallNote` reads back cannot drift: the order is `CALL_NOTE_KEYS`'
 * order, and a key added to that tuple without a description here is a
 * compile error rather than a key the agent silently never gets asked.
 */
const CALL_NOTE_SET: ManagedSet = {
  name: CALL_NOTE_EXTRACTION_SET_NAME,
  supersedes: CALL_NOTE_SUPERSEDED_NAMES,
  description: 'Lets the campaign agent leave a note for the next call.',
  keys: CALL_NOTE_KEYS.map((name) => ({ name, ...CALL_NOTE_DESCRIPTIONS[name] })),
};

/**
 * Ensures a goal campaign's agent carries the call-note set, and sweeps off
 * the sets earlier releases attached — the verdict set among them, because
 * a model asked two sets' questions answers the old vocabulary for nobody.
 *
 * The callbacks set is neither attached nor detached here. Not attached,
 * because the note carries the callback time itself and two keys asking one
 * question would give the booking two answers; not detached, because agents
 * are many-to-one with campaigns and a plain campaign with callbacks on may
 * be dialing with this same agent — its bookings must not stop because a
 * goal campaign started beside it. A goal campaign's booking never reads
 * that key anyway (`callbackRawFrom`), so leaving it is harmless to this
 * campaign and necessary to the other.
 *
 * The same shape and the same promise as the callback attach above: idempotent
 * on every start and resume, and never able to fail one — a goal campaign
 * whose agent cannot leave a note still dials, every call comes back with no
 * outcome, and the notification is what tells an ADMIN why the readout is
 * empty.
 */
export async function ensureGoalExtractionKeys(
  agentExternalId: string,
  workspaceId: string,
  campaignName: string,
): Promise<boolean> {
  try {
    await ensureManagedSetAttached(agentExternalId, CALL_NOTE_SET);

    for (const retired of RETIRED_EXTRACTION_SET_NAMES) {
      await ensureManagedSetDetached(agentExternalId, retired);
    }

    await ensureExtractionEnabled(agentExternalId);

    return true;
  } catch (err) {
    console.error(`[campaign] could not attach the call-note keys to ${agentExternalId}:`, err);

    void notify(
      workspaceId,
      'ADMINS_ONLY',
      'campaign.goal_keys_unavailable',
      `${campaignName} may not leave call notes`,
      'This campaign started, but its agent could not be set up to leave a note at the ' +
        'end of a call. Calls will be placed as normal; no call will report its outcome, ' +
        'and the next call to each person will not be told what the last one learned.',
      '/campaigns',
    );

    return false;
  }
}

/**
 * Everything a campaign needs on its agent upstream, in one call shared by
 * start and resume.
 *
 * One routine rather than a branch at each door, for the reason `startCampaign`
 * itself exists: there are two ways into RUNNING — an operator pressing the
 * button and the schedule scanner firing at 3am — and a second copy of this
 * decision would drift the moment either gained a step.
 *
 * One branch since 2026-09-06, where there used to be two. The call-note set
 * is attached for EVERY campaign now: follow-ups are always on, and the set
 * carries the callback time itself, so there is no longer a campaign shape
 * that wants the plain callbacks key instead. `ensureCallbackExtractionKey`
 * survives as the narrower attach it always was, with no caller in the
 * campaign path.
 *
 * Each half is idempotent and none may fail the transition — every failure in
 * here is already a notification rather than a throw.
 */
export async function prepareCampaignAgent(
  agentExternalId: string,
  workspaceId: string,
  campaign: { name: string },
): Promise<void> {
  await ensureGoalExtractionKeys(agentExternalId, workspaceId, campaign.name);
  await ensureGoalPromptBlock(agentExternalId, workspaceId, campaign.name);
}
