import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/adapter/vocobase.js', () => ({
  listExtractionSets: vi.fn(),
  createExtractionSet: vi.fn(),
  listAgentExtractionSets: vi.fn(),
  attachAgentExtractionSet: vi.fn(),
  detachAgentExtractionSet: vi.fn(),
  getAgent: vi.fn(),
  updateAgent: vi.fn(),
}));

const adapter = await import('../src/adapter/vocobase.js');
const {
  ensureCallbackExtractionKey,
  ensureGoalExtractionKeys,
  CALLBACK_EXTRACTION_SET_NAME,
  CALL_NOTE_EXTRACTION_SET_NAME,
  CALL_NOTE_DESCRIPTIONS,
  RETIRED_EXTRACTION_SET_NAMES,
} = await import('../src/services/campaignExtraction.js');
const {
  CALLBACK_REQUESTED_AT_KEY,
  CALL_END_TIMESTAMP_KEY,
  CALL_NOTE_KEYS,
  CALL_OUTCOMES,
} = await import('../src/lib/extractionConfig.js');
const { ApiError } = await import('../src/lib/errors.js');
const { prisma } = await import('../src/lib/prisma.js');
const { flushNotifications } = await import('../src/lib/notify.js');
const { truncateAll } = await import('./setup.js');
const { makeAccount, makeWorkspace } = await import('./helpers.js');

const listSets = vi.mocked(adapter.listExtractionSets);
const createSet = vi.mocked(adapter.createExtractionSet);
const listAgentSets = vi.mocked(adapter.listAgentExtractionSets);
const attachSet = vi.mocked(adapter.attachAgentExtractionSet);
const detachSet = vi.mocked(adapter.detachAgentExtractionSet);
const getAgent = vi.mocked(adapter.getAgent);
const updateAgent = vi.mocked(adapter.updateAgent);

const AGENT = 'ag_ezo_1';
let workspaceId = '';

const theSet = { id: 'set_cb', name: CALLBACK_EXTRACTION_SET_NAME };

/**
 * The name a managed set is created under.
 *
 * There is no way to update a set upstream, so the name carries eight hex
 * digits of the keys it holds: an edited description is a different set, and
 * unchanged code is the same set. The exact digits are not asserted anywhere —
 * pinning them would make every reword of a description a test edit as well,
 * which is the churn the fingerprint exists to make cheap — so the shape is
 * what is checked.
 */
const versioned = (base: string) =>
  new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\([0-9a-f]{8}\\)$`);

/** The call-note set as the platform would hand it back: every key of this
 *  release, with the descriptions this release ships. */
const upstreamNoteKeys = () =>
  CALL_NOTE_KEYS.map((name) => ({ name, ...CALL_NOTE_DESCRIPTIONS[name] }));

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});

  const account = await makeAccount(`ex${Math.random().toString(36).slice(2, 7)}`);
  workspaceId = (await makeWorkspace(account, 'Extractors')).id;

  listSets.mockResolvedValue({ extraction_sets: [theSet] });
  listAgentSets.mockResolvedValue({ extraction_sets: [theSet] });
  getAgent.mockResolvedValue({ extraction_enabled: true });
});

afterEach(async () => {
  await flushNotifications();
  await truncateAll();
  vi.restoreAllMocks();
});

const ensure = () => ensureCallbackExtractionKey(AGENT, workspaceId, 'Outreach');

/**
 * The set names and their descriptions are read by an operator in the agent's
 * own extraction editor and by every partner sharing the pool, so the
 * supplier's name has no business in them — the same rule the prompt block
 * and every customer-facing string follow.
 *
 * Asserted case-insensitively over the whole payload rather than the name
 * alone: the set description and every key description are just as visible,
 * and a reword could reintroduce it anywhere.
 */
describe('what the managed sets are called', () => {
  it('names neither set after the supplier', () => {
    expect(CALLBACK_EXTRACTION_SET_NAME.toLowerCase()).not.toContain('ezo');
    expect(CALL_NOTE_EXTRACTION_SET_NAME.toLowerCase()).not.toContain('ezo');
  });

  it('creates the callbacks set with no supplier name anywhere in it', async () => {
    listSets.mockResolvedValue({ extraction_sets: [] });
    createSet.mockResolvedValue({ id: 'set_new' });
    listAgentSets.mockResolvedValue({ extraction_sets: [] });

    await ensure();

    expect(JSON.stringify(createSet.mock.calls[0]![0]).toLowerCase()).not.toContain('ezo');
  });

  it('creates the call-note set with no supplier name anywhere in it', async () => {
    listSets.mockResolvedValue({ extraction_sets: [] });
    createSet.mockResolvedValue({ id: 'set_note' });
    listAgentSets.mockResolvedValue({ extraction_sets: [] });

    await ensureGoalExtractionKeys(AGENT, workspaceId, 'Goals');

    expect(JSON.stringify(createSet.mock.calls[0]![0]).toLowerCase()).not.toContain('ezo');
  });

  /**
   * The rename is only half done if the branded set stays attached. There is
   * no rename endpoint upstream, so the old set is a different set with a
   * different name, and an agent left carrying both is asked the same
   * question twice — once under each name — with the answers merged by
   * whichever came back last.
   *
   * The old names are written out verbatim rather than imported: they are the
   * strings on real agents upstream, and a constant would let the next rename
   * rewrite both sides of the assertion at once.
   */
  it('detaches the branded callbacks set it supersedes', async () => {
    const branded = { id: 'set_branded', name: 'YE campaign callbacks (a1b2c3d4)' };
    listSets.mockResolvedValue({ extraction_sets: [theSet, branded] });
    listAgentSets.mockResolvedValue({ extraction_sets: [theSet, branded] });

    await ensure();

    expect(detachSet).toHaveBeenCalledWith(AGENT, 'set_branded');
  });

  it('detaches the branded callbacks set that carried no version', async () => {
    const branded = { id: 'set_branded', name: 'YE campaign callbacks' };
    listSets.mockResolvedValue({ extraction_sets: [theSet, branded] });
    listAgentSets.mockResolvedValue({ extraction_sets: [theSet, branded] });

    await ensure();

    expect(detachSet).toHaveBeenCalledWith(AGENT, 'set_branded');
  });

  it('detaches the branded call-note set it supersedes', async () => {
    const note = { id: 'set_note', name: CALL_NOTE_EXTRACTION_SET_NAME };
    const branded = { id: 'set_branded', name: 'YE campaign call note (a1b2c3d4)' };
    listSets.mockResolvedValue({ extraction_sets: [note, branded] });
    listAgentSets.mockResolvedValue({ extraction_sets: [note, branded] });

    await ensureGoalExtractionKeys(AGENT, workspaceId, 'Goals');

    expect(detachSet).toHaveBeenCalledWith(AGENT, 'set_branded');
  });

  /** And still not a set somebody else named by hand. The suffix test is
   *  exact for the superseded names too, or "YE campaign callbacks (old)"
   *  in a partner-wide pool is detached from an agent it was put on
   *  deliberately. */
  it('leaves a hand-named lookalike of the old name alone', async () => {
    const other = { id: 'set_x', name: 'YE campaign callbacks (old)' };
    listSets.mockResolvedValue({ extraction_sets: [theSet, other] });
    listAgentSets.mockResolvedValue({ extraction_sets: [theSet, other] });

    await ensure();

    expect(detachSet).not.toHaveBeenCalled();
  });
});

describe('finding or creating the managed set', () => {
  it('reuses the set it already owns', async () => {
    await expect(ensure()).resolves.toBe(true);

    expect(createSet).not.toHaveBeenCalled();
  });

  it('creates it with one datetime key when it is not there', async () => {
    listSets.mockResolvedValue({ extraction_sets: [{ id: 'set_other', name: 'Lead quality' }] });
    createSet.mockResolvedValue({ id: 'set_new', name: CALLBACK_EXTRACTION_SET_NAME });
    listAgentSets.mockResolvedValue({ extraction_sets: [] });

    await expect(ensure()).resolves.toBe(true);

    expect(createSet).toHaveBeenCalledTimes(1);
    const body = createSet.mock.calls[0]![0];
    expect(body.name).toMatch(versioned(CALLBACK_EXTRACTION_SET_NAME));
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ name: CALLBACK_REQUESTED_AT_KEY, type: 'datetime' });
    // The description is the whole of the instruction the model follows.
    expect(body.keys[0]!.description).toMatch(/called back/i);
    expect(body.keys[0]!.description).toMatch(/offset/i);

    expect(attachSet).toHaveBeenCalledWith(AGENT, 'set_new');
  });

  /** The sets pool is partner-wide, so the listing carries every workspace's.
   *  Only ours, by name, is ever touched. */
  it('does not adopt another set that merely looks similar', async () => {
    listSets.mockResolvedValue({
      extraction_sets: [{ id: 'set_x', name: 'YE campaign callbacks (old)' }],
    });
    createSet.mockResolvedValue({ id: 'set_new' });
    listAgentSets.mockResolvedValue({ extraction_sets: [] });

    await ensure();

    expect(attachSet).toHaveBeenCalledWith(AGENT, 'set_new');
  });
});

describe('attaching it to the agent', () => {
  it('attaches when the agent does not carry it', async () => {
    listAgentSets.mockResolvedValue({ extraction_sets: [{ id: 'set_other' }] });

    await ensure();

    expect(attachSet).toHaveBeenCalledWith(AGENT, 'set_cb');
  });

  it('leaves an agent that already carries it alone', async () => {
    await ensure();

    expect(attachSet).not.toHaveBeenCalled();
  });
});

describe('the agent’s own master switch', () => {
  /** Carrying the key and having extraction on are different controls: an agent
   *  can hold the key with extraction off and extract nothing. */
  it('turns extraction on when it is off', async () => {
    getAgent.mockResolvedValue({ extraction_enabled: false });

    await ensure();

    expect(updateAgent).toHaveBeenCalledWith(AGENT, { extraction_enabled: true });
  });

  it('turns it on when the platform does not say either way', async () => {
    getAgent.mockResolvedValue({});

    await ensure();

    expect(updateAgent).toHaveBeenCalledWith(AGENT, { extraction_enabled: true });
  });

  it('does not rewrite an agent that already has it on', async () => {
    await ensure();

    expect(updateAgent).not.toHaveBeenCalled();
  });
});

describe('running it again', () => {
  it('is a no-op the second time', async () => {
    await ensure();
    await ensure();

    expect(createSet).not.toHaveBeenCalled();
    expect(attachSet).not.toHaveBeenCalled();
    expect(updateAgent).not.toHaveBeenCalled();
  });
});

describe('when the platform will not cooperate', () => {
  /**
   * A campaign that cannot book callbacks still dials. Refusing to start it
   * over this would be a worse outcome than the one it protects against, so the
   * failure is reported and never raised.
   */
  it('reports the failure to admins and does not throw', async () => {
    listSets.mockRejectedValue(new Error('upstream is down'));

    await expect(ensure()).resolves.toBe(false);

    await flushNotifications();
    const notification = await prisma.notification.findFirstOrThrow({
      where: { workspaceId, type: 'campaign.callback_key_unavailable' },
    });
    expect(notification.scope).toBe('ADMINS_ONLY');
    expect(notification.title).toContain('Outreach');
  });

  it('refuses to guess when a created set comes back with no id', async () => {
    listSets.mockResolvedValue({ extraction_sets: [] });
    createSet.mockResolvedValue({ name: CALLBACK_EXTRACTION_SET_NAME });

    await expect(ensure()).resolves.toBe(false);

    expect(attachSet).not.toHaveBeenCalled();
  });

  /** An envelope this adapter does not recognise reads as no sets, which
   *  creates one, rather than throwing on the start path. */
  it('survives a listing shaped in a way it does not know', async () => {
    listSets.mockResolvedValue({ unexpected: true } as never);
    createSet.mockResolvedValue({ id: 'set_new' });
    listAgentSets.mockResolvedValue({ unexpected: true } as never);

    await expect(ensure()).resolves.toBe(true);

    expect(attachSet).toHaveBeenCalledWith(AGENT, 'set_new');
  });
});


/**
 * The goal campaign's managed set: the five call-note keys the bot answers at
 * the end of every call, and nothing else of ours.
 *
 * The callbacks set is NOT attached beside it any more: the note carries the
 * callback time itself, under `callback_requested_time_vocobaseplatform`, and
 * two keys asking one question would give the booking two answers. Nor is it
 * detached — agents are many-to-one with campaigns, and a plain campaign with
 * callbacks on may be dialing with the same agent.
 */
describe('ensureGoalExtractionKeys', () => {
  const noteSet = { id: 'set_note', name: CALL_NOTE_EXTRACTION_SET_NAME };

  it('creates the call-note set once and attaches it, and only it', async () => {
    listSets.mockResolvedValue({ extraction_sets: [theSet] });
    // Nothing on the agent yet, so every attach is an observable round trip.
    listAgentSets.mockResolvedValue({ extraction_sets: [] });
    createSet.mockResolvedValue({ id: 'set_note' });

    const ok = await ensureGoalExtractionKeys(AGENT, workspaceId, 'Goals');

    expect(ok).toBe(true);
    expect(createSet).toHaveBeenCalledTimes(1);
    const body = createSet.mock.calls[0]![0] as { name: string; keys: { name: string }[] };
    expect(body.name).toMatch(versioned(CALL_NOTE_EXTRACTION_SET_NAME));
    expect(body.keys.map((k) => k.name)).toEqual([...CALL_NOTE_KEYS]);
    expect(attachSet).toHaveBeenCalledWith(AGENT, 'set_note');
    // The callbacks set does not ride along: the note carries the time.
    expect(attachSet).not.toHaveBeenCalledWith(AGENT, theSet.id);
    expect(attachSet).toHaveBeenCalledTimes(1);
  });

  /** The outcome and the immediate-callback flag are pinned lists in the
   *  prompt the model is given, not schema enums — but they have to reach
   *  the model at all. */
  it('pins the outcome and the immediate-callback flag', async () => {
    listSets.mockResolvedValue({ extraction_sets: [theSet] });
    listAgentSets.mockResolvedValue({ extraction_sets: [] });
    createSet.mockResolvedValue({ id: 'set_note' });

    await ensureGoalExtractionKeys(AGENT, workspaceId, 'Goals');

    const body = createSet.mock.calls[0]![0] as {
      keys: { name: string; type: string; values?: string[]; description: string }[];
    };
    const byName = new Map(body.keys.map((k) => [k.name, k]));
    expect(byName.get('call_outcome_vocobaseplatform')!.values).toEqual([...CALL_OUTCOMES]);
    expect(byName.get('immediate_callback_needed_vocobaseplatform')!.values).toEqual(['yes', 'no']);
    for (const key of body.keys) expect(key.type).toBe('string');
    // The descriptions are the specification's, verbatim: a spot check on
    // the phrases the decision turns on.
    const outcome = byName.get('call_outcome_vocobaseplatform')!.description;
    expect(outcome).toContain('Allowed values: "incomplete", "stop", or "completed".');
    // The outcome is defined against the agent's own prompt and tied to
    // whether a callback is needed, rather than to "a genuine follow-up":
    // the earlier wording had no objective in it, and the bot judged a
    // polite but uncommitted call complete.
    expect(outcome).toContain(
      '"incomplete" if the conversation is incomplete based on the agent prompt provided, ' +
        'hence a callback is needed.',
    );
    expect(outcome).toContain(
      '"completed" if the conversation is complete based on the agent prompt provided, ' +
        'hence does not need a callback.',
    );

    // The reason key now names the outcome key and its three values, rather
    // than H's generic five-word instruction with no reference to the key.
    const reason = byName.get('call_outcome_reason_vocobaseplatform')!.description;
    expect(reason).toBe(
      'Reason for why you marked call_outcome_vocobaseplatform as "incomplete", "stop", or ' +
        '"completed", in 5 words or less.',
    );

    // The callback-type key is retired: contender I asks two plain questions
    // instead, and the engine derives `CallbackType` from them
    // (`src/lib/goalRecord.ts`).
    expect(byName.has('callback_type_vocobaseplatform')).toBe(false);

    const immediate = byName.get('immediate_callback_needed_vocobaseplatform')!.description;
    expect(immediate).toBe(
      'Allowed values: "yes" or "no". Based on the conversation transcript, check whether the ' +
        'call ended abruptly in the middle of a conversation. Mark as "yes" if it did, and hence ' +
        'the system should trigger a callback immediately to resume the conversation. Otherwise, ' +
        'mark as "no" if the call seems to have ended intentionally, either by the user or the bot.',
    );

    const immediateReason = byName.get('immediate_callback_needed_reason_vocobaseplatform')!.description;
    expect(immediateReason).toBe(
      'Reason for why you marked immediate_callback_needed_vocobaseplatform as "yes" or "no", in ' +
        '5 words or less.',
    );

    // The null rule is restated in terms of the outcome and the new flag;
    // the format string keeps the minutes (the draft's `HH±HH` was a
    // dropped `:mm`, confirmed and restored).
    const callbackTime = byName.get('callback_requested_time_vocobaseplatform')!.description;
    expect(callbackTime).toContain('YYYY-MM-DDTHH:mm±HH');
    expect(callbackTime).toContain(
      'Mark as "null" if (1) call_outcome_vocobaseplatform is marked as "stop" or "completed", ' +
        'or (2) immediate_callback_needed_vocobaseplatform is marked as "yes".',
    );
    // Anchored to the call's own end rather than to the prompt's clock, so
    // the booking and the timestamp key share one frame.
    expect(callbackTime).toContain(
      'Refer to the timestamp of when this call ended to schedule the callback correctly.',
    );

    // The instructions key asks for the exact opening lines, in a stated
    // format. That format is the load-bearing part: contender D moved the
    // steps into YE's standing order and lost turn 1 in nine of sixteen
    // drop cells.
    const instructions = byName.get('next_call_instructions_vocobaseplatform')!.description;
    expect(instructions).toContain('less than 1,200 characters');
    expect(instructions).toContain('skip the standard flow');
    expect(instructions).toContain('→ if the user agrees → Step 2:');
    // Step 1 sets the context as well as pointing at the previous call. The
    // clause is the one part of the opener H rewords.
    expect(instructions).toContain(
      'simply refers to the previous interaction to set the context (without going into specifics)',
    );
    expect(instructions).toContain('Do not include information that is not useful for the next call');
    // Contender I's own addition: the closing sentence asking for second
    // person throughout.
    expect(instructions).toContain(
      'Frame sentences in the second person while describing what this agent did in the call.',
    );
    // The five labelled sections are contender F's whole difference from E,
    // which asked for the same points as running prose. Pinned so the frame
    // cannot be lost in a reword without somebody deciding to lose it.
    for (const section of [
      'PREVIOUS CALL SUMMARY:',
      'ALREADY COVERED:',
      'RESUME FROM:',
      'OPENING SCRIPT:',
      'KEEP IN MIND:',
    ]) {
      expect(instructions, section).toContain(section);
    }
    // And the timestamp key asks for one value in the design's shape, which
    // is what the next call's opener plays back — the end of the call, not
    // an unnamed instant somewhere inside it.
    expect(byName.get('call_end_timestamp_vocobaseplatform')!.description).toBe(
      'Give the timestamp of when the call ended in YYYY-MM-DDTHH:mm±HH format.',
    );
    // Step 1 still does not name *when* the previous call was. Run 1
    // measured the timestamp reaching every follow-up dial and 0 of 17
    // openers naming it, because Step 1 is written at the end of the
    // previous call under an instruction to stay generic. A clause asking
    // for the time here was tried and is not part of the specification's
    // wording, which this description carries verbatim — so the seventh key
    // remains one the platform must accept and no opener reads. Pinned as an
    // absence: the clause cannot come back without somebody deciding to
    // depart from the specification again.
    expect(instructions).not.toContain('also mention when it happened');
  });

  /**
   * A description the platform refuses is a campaign whose every call comes
   * back with no note, and the refusal is silent — so the managed set is
   * capped even though nothing local validates it.
   *
   * Deliberately unrelated to `MAX_EXTRACTION_KEY_DESCRIPTION_CHARS`. That is
   * YE's limit on what a **partner** may send through
   * `extractionConfigSchema`, and these descriptions never pass through it —
   * they go straight to `createExtractionSet` — so whatever that constant says
   * governs nothing here. It was 500 when this guard was written and is 2000
   * now (#33), and this number did not move for either, which is the point:
   * an assertion tying the two together would have been describing a
   * coincidence.
   *
   * **The platform's own ceiling is unverified** — 1000 is a guard against
   * unnoticed growth, not a known limit, and the live handset rehearsal is
   * what confirms this length is accepted. A description the platform refuses
   * is a campaign whose every call comes back with no note, silently.
   *
   * The instructions key is at 958 of it since the timestamp clause landed, so
   * this guard is close rather than notional: the next addition to that
   * description trips it, which is the point.
   */
  const MAX_MANAGED_DESCRIPTION_CHARS = 1000;

  it('keeps every managed description within the guard', () => {
    for (const name of CALL_NOTE_KEYS) {
      expect(CALL_NOTE_DESCRIPTIONS[name].description.length).toBeLessThanOrEqual(
        MAX_MANAGED_DESCRIPTION_CHARS,
      );
    }
  });

  /**
   * An agent that ran under an earlier release still carries the sets that
   * release attached — the verdict set among them. Nothing reads them now,
   * so leaving them on would be the customer paying for extraction no
   * surface consumes, and a model asked both vocabularies at once.
   */
  it('detaches the retired opt-out, summary and goal-verdict sets', async () => {
    expect(RETIRED_EXTRACTION_SET_NAMES).toContain('YE campaign goals');
    const legacy = [
      { id: 'set_old1', name: 'YE campaign opt-outs' },
      { id: 'set_old2', name: 'YE call summaries' },
      { id: 'set_old3', name: 'YE campaign goals' },
    ];
    const carried = [theSet, ...legacy, noteSet];
    listSets.mockResolvedValue({ extraction_sets: carried });
    listAgentSets.mockResolvedValue({ extraction_sets: carried });

    await ensureGoalExtractionKeys(AGENT, workspaceId, 'Goals');

    expect(detachSet).toHaveBeenCalledWith(AGENT, 'set_old1');
    expect(detachSet).toHaveBeenCalledWith(AGENT, 'set_old2');
    expect(detachSet).toHaveBeenCalledWith(AGENT, 'set_old3');
    expect(createSet).not.toHaveBeenCalled();
  });

  /** A plain campaign with callbacks on may share the agent; its bookings
   *  must not stop because a goal campaign started beside it. */
  it('leaves the callbacks set on an agent that carries it', async () => {
    const carried = [theSet, noteSet];
    listSets.mockResolvedValue({ extraction_sets: carried });
    listAgentSets.mockResolvedValue({ extraction_sets: carried });

    await ensureGoalExtractionKeys(AGENT, workspaceId, 'Goals');

    expect(detachSet).not.toHaveBeenCalledWith(AGENT, theSet.id);
    expect(attachSet).not.toHaveBeenCalled();
  });

  /** The same promise the callback attach makes: a goal campaign whose agent
   *  cannot leave a note still dials, and an ADMIN is told. */
  it('notifies and returns false on failure, never throws', async () => {
    listSets.mockRejectedValue(new Error('upstream down'));

    expect(await ensureGoalExtractionKeys(AGENT, workspaceId, 'Goals')).toBe(false);

    await flushNotifications();
    const n = await prisma.notification.findFirst({
      where: { workspaceId, type: 'campaign.goal_keys_unavailable' },
    });
    expect(n).not.toBeNull();
    expect(n!.scope).toBe('ADMINS_ONLY');
    expect(n!.title).toContain('Goals');
  });
});

/**
 * A set found by a fixed name is a set that can never be corrected: there is
 * no update endpoint upstream, so every later edit to `CALL_NOTE_DESCRIPTIONS`
 * would be inert against a pool that already holds one of that name — and the
 * pool is partner-wide, so a rehearsal or a staging run that creates the name
 * first with a draft description is what production silently inherits.
 *
 * The name therefore carries a fingerprint of the keys, and a set already
 * upstream is read before it is reused.
 */
describe('a managed set that has drifted from what this release ships', () => {
  const goals = () => ensureGoalExtractionKeys(AGENT, workspaceId, 'Goals');

  it('reuses a set whose keys still say what this release says', async () => {
    const live = {
      id: 'set_note_live',
      name: CALL_NOTE_EXTRACTION_SET_NAME,
      keys: upstreamNoteKeys(),
    };
    listSets.mockResolvedValue({ extraction_sets: [live] });
    listAgentSets.mockResolvedValue({ extraction_sets: [] });

    await goals();

    expect(createSet).not.toHaveBeenCalled();
    expect(attachSet).toHaveBeenCalledWith(AGENT, 'set_note_live');
    expect(detachSet).not.toHaveBeenCalled();
  });

  /** The staging-draft case, which is the one this exists for: the name is
   *  right, one description is somebody else's. */
  it('creates a new version when a description has drifted, and retires the old', async () => {
    const drifted = {
      id: 'set_note_draft',
      name: CALL_NOTE_EXTRACTION_SET_NAME,
      keys: upstreamNoteKeys().map((key) =>
        key.name === 'call_end_timestamp_vocobaseplatform'
          ? { ...key, description: 'a draft somebody left in the shared pool' }
          : key,
      ),
    };
    listSets.mockResolvedValue({ extraction_sets: [drifted] });
    listAgentSets.mockResolvedValue({ extraction_sets: [drifted] });
    createSet.mockResolvedValue({ id: 'set_note_v2' });

    await goals();

    expect(createSet).toHaveBeenCalledTimes(1);
    expect(createSet.mock.calls[0]![0].name).toMatch(versioned(CALL_NOTE_EXTRACTION_SET_NAME));
    // The old one comes off first: two versions of the same six keys cannot
    // be attached together, because the platform refuses an attach whose key
    // names are already claimed on the agent. See the ordering tests at the
    // foot of this file.
    expect(attachSet).toHaveBeenCalledWith(AGENT, 'set_note_v2');
    expect(detachSet).toHaveBeenCalledWith(AGENT, 'set_note_draft');
  });

  /** A key removed upstream is drift as surely as a reworded one: the model
   *  cannot answer a question it is not asked. */
  it('treats a missing key as drift', async () => {
    const short = {
      id: 'set_note_short',
      name: CALL_NOTE_EXTRACTION_SET_NAME,
      keys: upstreamNoteKeys().slice(1),
    };
    listSets.mockResolvedValue({ extraction_sets: [short] });
    listAgentSets.mockResolvedValue({ extraction_sets: [] });
    createSet.mockResolvedValue({ id: 'set_note_v2' });

    await goals();

    expect(createSet).toHaveBeenCalledTimes(1);
  });

  /**
   * The failure that would not be recoverable.
   *
   * Read as drift, an envelope this adapter cannot parse would have every
   * campaign start create another set against a pool every customer of the
   * platform shares — for ever, and with nothing saying so. Read as "current",
   * a set that really has drifted costs this release its edit until somebody
   * looks. The second is the one you can fix afterwards, so every unreadable
   * answer is "not drifted".
   */
  it('does not recreate a set whose keys it cannot read', async () => {
    const opaque = {
      id: 'set_note_live',
      name: CALL_NOTE_EXTRACTION_SET_NAME,
      key_definitions: upstreamNoteKeys(),
    };
    listSets.mockResolvedValue({ extraction_sets: [opaque] });
    listAgentSets.mockResolvedValue({ extraction_sets: [] });

    await goals();

    expect(createSet).not.toHaveBeenCalled();
    expect(attachSet).toHaveBeenCalledWith(AGENT, 'set_note_live');
  });

  it('does not recreate a set whose keys it cannot name', async () => {
    const opaque = {
      id: 'set_note_live',
      name: CALL_NOTE_EXTRACTION_SET_NAME,
      keys: upstreamNoteKeys().map(({ name, ...rest }) => ({ key: name, ...rest })),
    };
    listSets.mockResolvedValue({ extraction_sets: [opaque] });
    listAgentSets.mockResolvedValue({ extraction_sets: [] });

    await goals();

    expect(createSet).not.toHaveBeenCalled();
    expect(attachSet).toHaveBeenCalledWith(AGENT, 'set_note_live');
  });

  /** The fingerprint is of the content, so unchanged code must find its own
   *  set next time rather than making a second one. */
  it('reuses the versioned set a previous start created', async () => {
    listSets.mockResolvedValue({ extraction_sets: [] });
    listAgentSets.mockResolvedValue({ extraction_sets: [] });
    createSet.mockResolvedValue({ id: 'set_note_v2' });

    await goals();

    const created = createSet.mock.calls[0]![0].name;
    // What the pool holds on the next start, listed without its keys. The
    // name IS the content, so it is reused without being read.
    listSets.mockResolvedValue({ extraction_sets: [{ id: 'set_note_v2', name: created }] });

    await goals();

    expect(createSet).toHaveBeenCalledTimes(1);
  });

  /**
   * The pool is partner-wide, so a set somebody named by hand sits in the
   * same listing. Only the base name and the eight-hex-digit suffix are ours;
   * a prefix match would take a deliberately-attached set off an agent.
   */
  it('does not claim a similarly-named set as one of its own versions', async () => {
    const theirs = { id: 'set_theirs', name: `${CALL_NOTE_EXTRACTION_SET_NAME} (old)` };
    listSets.mockResolvedValue({ extraction_sets: [theirs] });
    listAgentSets.mockResolvedValue({ extraction_sets: [theirs] });
    createSet.mockResolvedValue({ id: 'set_note_v2' });

    await goals();

    expect(attachSet).toHaveBeenCalledWith(AGENT, 'set_note_v2');
    expect(detachSet).not.toHaveBeenCalledWith(AGENT, 'set_theirs');
  });
});

/**
 * Two versions of one managed set can never sit on an agent together, and the
 * platform is the one that says so: `attachSetToAgentAtomic` validates the
 * incoming set's key names against every name already on the agent and answers
 * 409 `EXTRACTION_KEY_CLASH` when any of them is taken. Every version of a
 * managed set defines the same names as the version before it, so the new one
 * is refused for exactly as long as the old one is attached.
 *
 * That makes the ORDER of the attach and the detach load-bearing rather than a
 * matter of taste, and it is the one thing a mock that always resolves cannot
 * show: contender H's set was created upstream at 14:50 IST on 2026-09-05,
 * refused four times, and never reached the agent — while this file was green.
 * So the rule is modelled here.
 */
describe('replacing a version of a managed set the agent already carries', () => {
  interface PoolSet {
    id: string;
    name: string;
    keys?: { name: string }[];
  }

  /**
   * The pool and the agent, behaving as the platform does: a listing that
   * reflects the writes, an attach that refuses a name another attached set
   * has claimed, and a detach that frees those names again. Re-attaching a set
   * the agent already carries is a success upstream, not a clash.
   */
  function platform(pool: PoolSet[], attachedIds: string[]) {
    const attached = new Set(attachedIds);
    const onAgent = (): PoolSet[] => pool.filter((candidate) => attached.has(candidate.id));

    listSets.mockImplementation(async () => ({ extraction_sets: pool }));
    listAgentSets.mockImplementation(async () => ({ extraction_sets: onAgent() }));

    let made = 0;
    createSet.mockImplementation(async (body) => {
      made += 1;
      const set: PoolSet = { id: `set_made_${made}`, name: body.name, keys: body.keys };
      pool.push(set);

      return { id: set.id };
    });

    attachSet.mockImplementation(async (_agent, setId) => {
      if (attached.has(setId)) return {};

      const claimed = new Map(
        onAgent().flatMap((set) => (set.keys ?? []).map((key) => [key.name, set.name] as const)),
      );

      for (const key of pool.find((candidate) => candidate.id === setId)?.keys ?? []) {
        const owner = claimed.get(key.name);

        if (owner !== undefined) {
          throw new ApiError(
            409,
            'NAME_TAKEN',
            `Key name clash: key '${key.name}' is already defined by set '${owner}'`,
          );
        }
      }

      attached.add(setId);

      return {};
    });

    detachSet.mockImplementation(async (_agent, setId) => {
      attached.delete(setId);
    });

    return {
      names: () => onAgent().map((set) => set.name),
      keys: () => onAgent().flatMap((set) => (set.keys ?? []).map((key) => key.name)),
    };
  }

  /** The previous release's set: this release's six keys, under the name the
   *  sixth had before contender H renamed it. Five names in common is all the
   *  clash needs; the rename is what made the failure visible. */
  const previousVersion = (): PoolSet => ({
    id: 'set_note_prev',
    name: `${CALL_NOTE_EXTRACTION_SET_NAME} (0123abcd)`,
    keys: upstreamNoteKeys().map((key) =>
      key.name === CALL_END_TIMESTAMP_KEY
        ? { ...key, name: 'call_timestamp_vocobaseplatform' }
        : key,
    ),
  });

  it('gets this release’s version onto an agent still carrying the last one', async () => {
    const previous = previousVersion();
    const agent = platform([theSet, previous], [theSet.id, previous.id]);

    expect(await ensureGoalExtractionKeys(AGENT, workspaceId, 'Goals')).toBe(true);

    // The key this release added is the proof the new set is what the model
    // will be asked: the platform merges by name, first wins, so five of the
    // six would look identical either way.
    expect(agent.keys()).toContain(CALL_END_TIMESTAMP_KEY);
    expect(agent.names()).not.toContain(previous.name);
    // A plain campaign with callbacks on may share this agent.
    expect(agent.names()).toContain(theSet.name);
  });

  /** The invariant, stated on its own so a later edit cannot quietly put the
   *  attach back in front: the platform holds one version at a time. */
  it('detaches the version it is replacing before it attaches this one', async () => {
    const previous = previousVersion();
    platform([theSet, previous], [theSet.id, previous.id]);

    await ensureGoalExtractionKeys(AGENT, workspaceId, 'Goals');

    expect(detachSet).toHaveBeenCalled();
    expect(attachSet).toHaveBeenCalled();
    expect(detachSet.mock.invocationCallOrder[0]!).toBeLessThan(
      attachSet.mock.invocationCallOrder[0]!,
    );
  });

  /** An agent carrying nothing of ours detaches nothing, so the ordering above
   *  costs the ordinary start no round trip and opens no window. */
  it('detaches nothing on an agent that carries no version of the set', async () => {
    const agent = platform([theSet], [theSet.id]);

    expect(await ensureGoalExtractionKeys(AGENT, workspaceId, 'Goals')).toBe(true);

    expect(detachSet).not.toHaveBeenCalled();
    expect(agent.keys()).toContain(CALL_END_TIMESTAMP_KEY);
  });
});
