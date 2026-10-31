import { describe, expect, it } from 'vitest';
import type { CallNote } from '../src/lib/goalRecord.js';
import {
  MAX_CALL_NOTE_CHARS,
  MAX_CALL_TIMESTAMP_CHARS,
  deriveLastCallNote,
  hasSpokenAttempt,
  isEmptyValue,
  nextActionOf,
  readCallNote,
  readGoalLog,
} from '../src/lib/goalRecord.js';

const NO_NOTE = {
  outcome: null,
  reason: null,
  callbackType: null,
  callbackRequestedTime: null,
  immediateCallbackNeeded: null,
  immediateCallbackReason: null,
  note: null,
  callTimestamp: null,
};

describe('readCallNote', () => {
  it('reads a full note, deriving "requested" from a real time', () => {
    expect(
      readCallNote({
        call_outcome_vocobaseplatform: 'incomplete',
        call_outcome_reason_vocobaseplatform: 'asked for a callback',
        immediate_callback_needed_vocobaseplatform: 'no',
        immediate_callback_needed_reason_vocobaseplatform: 'call ended normally',
        callback_requested_time_vocobaseplatform: '2026-09-08T17:00+05',
        next_call_instructions_vocobaseplatform: 'She asked me to call back about the budget.',
        call_end_timestamp_vocobaseplatform: '2026-09-04T11:20+05',
      }),
    ).toEqual({
      outcome: 'incomplete',
      reason: 'asked for a callback',
      callbackType: 'requested',
      callbackRequestedTime: '2026-09-08T17:00+05',
      immediateCallbackNeeded: false,
      immediateCallbackReason: 'call ended normally',
      note: 'She asked me to call back about the budget.',
      callTimestamp: '2026-09-04T11:20+05',
    });
  });

  it('reads the pinned outcome case-insensitively and anything else as null', () => {
    expect(readCallNote({ call_outcome_vocobaseplatform: ' COMPLETED ' }).outcome).toBe('completed');
    expect(readCallNote({ call_outcome_vocobaseplatform: 'Stop' }).outcome).toBe('stop');
    expect(readCallNote({ call_outcome_vocobaseplatform: 'maybe later' }).outcome).toBeNull();
    expect(readCallNote({ call_outcome_vocobaseplatform: true }).outcome).toBeNull();
    expect(readCallNote({ callback_requested_time_vocobaseplatform: 42 }).callbackRequestedTime).toBeNull();
    expect(readCallNote({ call_outcome_reason_vocobaseplatform: ['x'] }).reason).toBeNull();
    expect(readCallNote({ next_call_instructions_vocobaseplatform: {} }).note).toBeNull();
    expect(readCallNote({ call_end_timestamp_vocobaseplatform: 42 }).callTimestamp).toBeNull();
    expect(readCallNote({ call_end_timestamp_vocobaseplatform: ' 2026-09-04T11:20+05 ' }).callTimestamp)
      .toBe('2026-09-04T11:20+05');
  });

  /**
   * `immediate_callback_needed_vocobaseplatform` is shipped as a string
   * pinned to "yes"/"no" — matching its own description — but `readCallNote`
   * also accepts a JSON `true`/`false`, in case the platform type is later
   * changed to `boolean` (see the operator note in the PR body).
   */
  describe('immediate_callback_needed_vocobaseplatform', () => {
    it('reads "yes"/"YES"/true as needed', () => {
      for (const value of ['yes', 'YES', ' Yes ', true]) {
        expect(readCallNote({ immediate_callback_needed_vocobaseplatform: value }).immediateCallbackNeeded)
          .toBe(true);
      }
    });

    it('reads "no"/"NO"/false as not needed', () => {
      for (const value of ['no', 'NO', ' No ', false]) {
        expect(readCallNote({ immediate_callback_needed_vocobaseplatform: value }).immediateCallbackNeeded)
          .toBe(false);
      }
    });

    it('reads anything else, and the null word, as not answered', () => {
      expect(readCallNote({ immediate_callback_needed_vocobaseplatform: 'maybe' }).immediateCallbackNeeded)
        .toBeNull();
      expect(readCallNote({ immediate_callback_needed_vocobaseplatform: 'null' }).immediateCallbackNeeded)
        .toBeNull();
      expect(readCallNote({ immediate_callback_needed_vocobaseplatform: 7 }).immediateCallbackNeeded)
        .toBeNull();
    });
  });

  /**
   * `CallNote.callbackType` is derived, not read — contender I retired the
   * callback-type key. See `deriveCallbackType`'s own docstring in
   * `src/lib/goalRecord.ts` for the rule this pins.
   */
  describe('deriving callbackType', () => {
    it('is null when the outcome is stop or completed, whatever else was said', () => {
      expect(
        readCallNote({
          call_outcome_vocobaseplatform: 'stop',
          immediate_callback_needed_vocobaseplatform: 'yes',
          callback_requested_time_vocobaseplatform: '2026-09-08T17:00+05',
        }).callbackType,
      ).toBeNull();
      expect(
        readCallNote({
          call_outcome_vocobaseplatform: 'completed',
          immediate_callback_needed_vocobaseplatform: 'yes',
        }).callbackType,
      ).toBeNull();
    });

    /**
     * A note written under contender H or G carries the retired
     * `callback_type_vocobaseplatform` and none of I's keys: calls in flight
     * across the deploy, and every stored extraction the re-extract report
     * reads back as its "old" verdict. It is read by H's rule — the type is
     * the gate, and a time beside a non-requested type is ignored.
     */
    it('reads a legacy callback_type when the note carries no immediate flag', () => {
      const legacy = (callback_type_vocobaseplatform: string, time = 'null') => ({
        call_outcome_vocobaseplatform: 'incomplete',
        callback_type_vocobaseplatform,
        callback_requested_time_vocobaseplatform: time,
      });
      expect(readCallNote(legacy('immediate')).callbackType).toBe('immediate');
      expect(readCallNote(legacy('flexible', '2026-09-08T17:00+05')).callbackType).toBe('flexible');
      expect(readCallNote(legacy('requested', '2026-09-08T17:00+05')).callbackType).toBe('requested');
      expect(readCallNote(legacy('nonsense')).callbackType).toBe('flexible');
    });

    it("ignores a legacy callback_type once the note answers I's flag, even unreadably", () => {
      expect(
        readCallNote({
          call_outcome_vocobaseplatform: 'incomplete',
          callback_type_vocobaseplatform: 'immediate',
          immediate_callback_needed_vocobaseplatform: 'no',
        }).callbackType,
      ).toBe('flexible');
      expect(
        readCallNote({
          call_outcome_vocobaseplatform: 'incomplete',
          callback_type_vocobaseplatform: 'immediate',
          immediate_callback_needed_vocobaseplatform: 'maybe',
        }).callbackType,
      ).toBe('flexible');
    });

    it('is "requested" off a real callback_requested_time alone', () => {
      expect(
        readCallNote({
          call_outcome_vocobaseplatform: 'incomplete',
          callback_requested_time_vocobaseplatform: '2026-09-08T17:00+05',
        }).callbackType,
      ).toBe('requested');
    });

    it('is "immediate" when immediate_callback_needed is yes and no real time was given', () => {
      expect(
        readCallNote({
          call_outcome_vocobaseplatform: 'incomplete',
          immediate_callback_needed_vocobaseplatform: 'yes',
        }).callbackType,
      ).toBe('immediate');
    });

    it('is "flexible" when neither a real time nor immediate=yes is present', () => {
      expect(readCallNote({ call_outcome_vocobaseplatform: 'incomplete' }).callbackType).toBe('flexible');
      expect(
        readCallNote({
          call_outcome_vocobaseplatform: 'incomplete',
          immediate_callback_needed_vocobaseplatform: 'no',
        }).callbackType,
      ).toBe('flexible');
      expect(
        readCallNote({
          call_outcome_vocobaseplatform: 'incomplete',
          callback_requested_time_vocobaseplatform: 'not a real time',
        }).callbackType,
      ).toBe('flexible');
    });

    /** No outcome is no note — the same reading a silence gets — so an
     *  extraction that came back empty logs what one that never came back
     *  logs, and the re-extract report prints `none` for both. */
    it('is null for no outcome at all, like a silence', () => {
      expect(readCallNote({}).callbackType).toBeNull();
      expect(readCallNote({}).callbackType).toBe(readCallNote(null).callbackType);
    });

    it('is "flexible" for an incomplete that said nothing else', () => {
      expect(
        readCallNote({ call_outcome_vocobaseplatform: 'incomplete' }).callbackType,
      ).toBe('flexible');
    });

    /**
     * The precedence rule: an explicit, parseable time beats
     * `immediate_callback_needed == "yes"`. The key's own description tells
     * the model to null the time out when immediate is "yes", so a real time
     * arriving anyway means the model disobeyed that instruction — and the
     * concrete promise should win over the flag it was told to defer to.
     * This matches contender H's own precedence, where an explicit callback
     * request always took priority over "immediate" or "flexible".
     */
    it('lets a real requested time beat immediate_callback_needed = yes', () => {
      expect(
        readCallNote({
          call_outcome_vocobaseplatform: 'incomplete',
          immediate_callback_needed_vocobaseplatform: 'yes',
          callback_requested_time_vocobaseplatform: '2026-09-08T17:00+05',
        }).callbackType,
      ).toBe('requested');
    });
  });

  /**
   * The key descriptions tell the model to answer the literal word "null"
   * when there is nothing to say, so that word is null for every key — in
   * any case and behind any whitespace, because a model's "Null" or "null\n"
   * is the same answer, and read as a value it would become an opening line
   * the next call recites or a callback time the booking tries to parse.
   */
  it('reads the literal string "null" as null for every key, in any case or whitespace', () => {
    for (const spelling of ['null', 'NULL', ' Null ', '\nnull\t']) {
      expect(
        readCallNote({
          call_outcome_vocobaseplatform: spelling,
          call_outcome_reason_vocobaseplatform: spelling,
          immediate_callback_needed_vocobaseplatform: spelling,
          immediate_callback_needed_reason_vocobaseplatform: spelling,
          callback_requested_time_vocobaseplatform: spelling,
          next_call_instructions_vocobaseplatform: spelling,
          call_end_timestamp_vocobaseplatform: spelling,
        }),
      ).toEqual(NO_NOTE);
    }
  });

  it('reads blank and filler text as no text', () => {
    expect(readCallNote({ call_outcome_reason_vocobaseplatform: '   ' }).reason).toBeNull();
    expect(readCallNote({ next_call_instructions_vocobaseplatform: 'n/a' }).note).toBeNull();
    expect(readCallNote({ callback_requested_time_vocobaseplatform: '' }).callbackRequestedTime).toBeNull();
    expect(readCallNote({ callback_requested_time_vocobaseplatform: ' 2026-09-08T17:00+05 ' }).callbackRequestedTime)
      .toBe('2026-09-08T17:00+05');
  });

  it('cuts the note at the ceiling', () => {
    expect(MAX_CALL_NOTE_CHARS).toBe(1200);
    expect(readCallNote({ next_call_instructions_vocobaseplatform: 'x'.repeat(3000) }).note).toHaveLength(1200);
  });

  /** The timestamp goes verbatim into the next dial's prompt, so a model
   *  that answers with a paragraph instead of one value is cut too. */
  it('cuts the timestamp at its own, much smaller ceiling', () => {
    expect(MAX_CALL_TIMESTAMP_CHARS).toBe(60);
    expect(readCallNote({ call_end_timestamp_vocobaseplatform: 'x'.repeat(300) }).callTimestamp)
      .toHaveLength(60);
  });

  /** The cap counts characters the way the description given to the model
   *  does. Cut on a UTF-16 unit it can split an emoji in half and hand the
   *  next dial's prompt a lone surrogate — a byte sequence that is not text. */
  it('cuts the note on a character, never inside a surrogate pair', () => {
    const exact = `${'a'.repeat(MAX_CALL_NOTE_CHARS - 1)}😀`; // 1200 characters, 1201 UTF-16 units
    expect(readCallNote({ next_call_instructions_vocobaseplatform: exact }).note).toBe(exact);

    const over = `${'a'.repeat(MAX_CALL_NOTE_CHARS)}😀`;
    expect(readCallNote({ next_call_instructions_vocobaseplatform: over }).note).toBe('a'.repeat(MAX_CALL_NOTE_CHARS));
  });

  it('is all-null for no extraction at all', () => {
    expect(readCallNote(null)).toEqual(NO_NOTE);
    expect(readCallNote(undefined).outcome).toBeNull();
    expect(readCallNote('garbage').outcome).toBeNull();
    expect(readCallNote(['incomplete']).outcome).toBeNull();
  });
});

describe('nextActionOf', () => {
  const note = (outcome: CallNote['outcome'], callbackType: CallNote['callbackType'] = null): CallNote => ({
    ...NO_NOTE,
    outcome,
    callbackType,
  });

  it('maps the outcome and derived callback type onto the dashboard’s four words', () => {
    expect(nextActionOf(note('completed'))).toBe('done');
    expect(nextActionOf(note('completed', 'requested'))).toBe('done');
    expect(nextActionOf(note('stop', 'requested'))).toBe('stop');
    expect(nextActionOf(note('incomplete', 'requested'))).toBe('call_back_at');
    expect(nextActionOf(note('incomplete', 'immediate'))).toBe('call_again');
    expect(nextActionOf(note('incomplete', 'flexible'))).toBe('call_again');
    expect(nextActionOf(note('incomplete'))).toBe('call_again');
    expect(nextActionOf(note(null, 'requested'))).toBeNull();
    expect(nextActionOf(readCallNote(null))).toBeNull();
  });
});

describe('deriveLastCallNote', () => {
  const silent = {
    status: null as string | null,
    disposition: null,
    answeredBy: null,
    callbackNote: null,
    note: readCallNote(null),
  };

  it('names the silence', () => {
    expect(deriveLastCallNote({ ...silent, disposition: 'voicemail' })).toBe('reached voicemail');
    expect(deriveLastCallNote({ ...silent, disposition: 'busy' })).toBe('the line was busy');
    expect(deriveLastCallNote({ ...silent, answeredBy: 'machine' })).toBe('reached voicemail');
    expect(deriveLastCallNote({ ...silent, disposition: 'user_hangup_no_speech' })).toBe(
      'call dropped with no conversation',
    );
  });

  /**
   * `no_answer`, `busy` and `failed` classify by status alone: the platform
   * sends them with no disposition and no `answered_by`, and a note that
   * read only those two fields fell through to "spoke, but no outcome was
   * recorded" — a conversation claimed on a phone nobody picked up, fed to
   * the model on the next dial.
   */
  it('names a silence the status alone reports', () => {
    expect(deriveLastCallNote({ ...silent, status: 'no_answer' })).toBe('the call was not answered');
    expect(deriveLastCallNote({ ...silent, status: 'busy' })).toBe('the line was busy');
    expect(deriveLastCallNote({ ...silent, status: 'failed' })).toBe('the call could not be connected');
    // A completed status says nothing on its own; the fields beside it do.
    expect(deriveLastCallNote({ ...silent, status: 'completed', answeredBy: 'human' })).toBe(
      'spoke, but no outcome was recorded',
    );
  });

  /**
   * An attempt the reaper abandoned: no status, no disposition, no
   * `answered_by`, no note. "Spoke" would put a conversation nobody can
   * vouch for in front of the model on the next dial.
   */
  it('says nothing was reported when nothing was', () => {
    expect(deriveLastCallNote(silent)).toBe('no outcome was reported for the call');
    // The bot's own word still counts for a call the platform never described.
    expect(
      deriveLastCallNote({ ...silent, note: readCallNote({ call_outcome_vocobaseplatform: 'completed' }) }),
    ).toBe('spoke, completed');
  });

  it('leads with a promise', () => {
    expect(deriveLastCallNote({ ...silent, disposition: 'completed', callbackNote: 'tomorrow 5pm' })).toBe(
      'spoke, asked to be called back: tomorrow 5pm',
    );
  });

  it('says what the bot decided about a conversation', () => {
    const spoke = { ...silent, disposition: 'completed', answeredBy: 'human' };
    const decided = (values: Record<string, unknown>) =>
      deriveLastCallNote({ ...spoke, note: readCallNote(values) });

    expect(decided({ call_outcome_vocobaseplatform: 'completed', call_outcome_reason_vocobaseplatform: 'gave a budget' }))
      .toBe('spoke, completed: gave a budget');
    expect(decided({ call_outcome_vocobaseplatform: 'completed' }))
      .toBe('spoke, completed');
    expect(decided({ call_outcome_vocobaseplatform: 'stop', call_outcome_reason_vocobaseplatform: 'not interested' }))
      .toBe('spoke, asked not to be called: not interested');
    expect(decided({
      call_outcome_vocobaseplatform: 'incomplete',
      callback_requested_time_vocobaseplatform: '2026-09-08T17:00+05',
    })).toBe('spoke, asked to be called back: 2026-09-08T17:00+05');
    expect(decided({
      call_outcome_vocobaseplatform: 'incomplete',
      immediate_callback_needed_vocobaseplatform: 'yes',
      call_outcome_reason_vocobaseplatform: 'line cut out',
    })).toBe('spoke, call dropped mid-conversation: line cut out');
    expect(decided({
      call_outcome_vocobaseplatform: 'incomplete',
      immediate_callback_needed_vocobaseplatform: 'no',
      call_outcome_reason_vocobaseplatform: 'busy at work',
    })).toBe('spoke, worth calling again: busy at work');
    expect(decided({ call_outcome_vocobaseplatform: 'incomplete' }))
      .toBe('spoke, worth calling again');
    expect(decided({}))
      .toBe('spoke, but no outcome was recorded');

    // The "time not given" fallback is defensive, for a stored attempt-log
    // entry from an earlier release (or a hand-built one) whose `requested`
    // callback type carries no time — a shape fresh derivation can no longer
    // produce (`requested` now only comes off a real, parseable time), but
    // one `deriveLastCallNote` must still describe sensibly if it is ever
    // handed one.
    expect(
      deriveLastCallNote({
        ...spoke,
        note: { ...readCallNote(null), outcome: 'incomplete', callbackType: 'requested' },
      }),
    ).toBe('spoke, asked to be called back: time not given');
  });
});

describe('readGoalLog', () => {
  it('keeps the note fields and drops malformed entries', () => {
    const log = readGoalLog([
      {
        attemptNo: 1, kind: 'fresh', disposition: 'completed', answeredBy: 'human',
        outcome: 'incomplete', callbackType: 'requested', callbackRequestedTime: '2026-09-08T17:00+05', reason: 'busy',
        immediateCallbackNeeded: false, immediateCallbackReason: 'call ended normally',
      },
      { attemptNo: 2, kind: 'follow_up', disposition: 'voicemail', answeredBy: 'machine' },
      { kind: 'retry' },
      'junk',
    ]);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({
      attemptNo: 1, outcome: 'incomplete', callbackType: 'requested',
      callbackRequestedTime: '2026-09-08T17:00+05', reason: 'busy',
      immediateCallbackNeeded: false, immediateCallbackReason: 'call ended normally',
    });
    expect(log[1]).toMatchObject({
      attemptNo: 2, outcome: null, callbackType: null, callbackRequestedTime: null, reason: null,
      immediateCallbackNeeded: null, immediateCallbackReason: null,
    });
  });

  /** An entry another release wrote, or a model that answered outside the
   *  pinned list, reads as no decision — the same rule as `kind`. */
  it('re-judges the outcome, callback type and immediate flag against the vocabulary', () => {
    const log = readGoalLog([
      { attemptNo: 1, kind: 'fresh', outcome: 'DONE', callbackType: 'later', immediateCallbackNeeded: 'sure', nextAction: 'done' },
      { attemptNo: 2, kind: 'fresh', outcome: ' Completed ', callbackType: 'FLEXIBLE', immediateCallbackNeeded: 'YES' },
    ]);
    expect(log[0]).toMatchObject({ outcome: null, callbackType: null, immediateCallbackNeeded: null });
    expect(log[1]).toMatchObject({ outcome: 'completed', callbackType: 'flexible', immediateCallbackNeeded: true });
  });
});

describe('hasSpokenAttempt', () => {
  const spoke = (entry: Record<string, unknown>) =>
    hasSpokenAttempt(readGoalLog([{ attemptNo: 1, kind: 'fresh', ...entry }]));

  it('needs a conversation, not merely an entry', () => {
    // A busy signal as the platform reports it: by status, with no disposition.
    expect(spoke({ status: 'busy', disposition: null, answeredBy: null })).toBe(false);
    expect(spoke({ disposition: 'completed', answeredBy: 'human' })).toBe(true);
  });

  /**
   * The dialer's predicate, not the reporting one. `classifyOutcome` in
   * `lib/callOutcome` files `user_hangup_no_speech` under `answered` for the
   * breakdown — the phone was picked up — while the dialer retries it as a
   * silence, because nobody said anything. The settle that reads this must
   * agree with the dialer about what a conversation is, or a contact whose
   * every dial was a wordless pick-up gets a verdict on a conversation that
   * never happened.
   */
  it('judges by the dialer’s rule: a wordless pick-up is not a conversation', () => {
    expect(spoke({ disposition: 'user_hangup_no_speech', answeredBy: 'human' })).toBe(false);
    expect(spoke({ disposition: 'voicemail', answeredBy: 'human' })).toBe(false);
    expect(spoke({ disposition: null, answeredBy: 'human' })).toBe(true);
  });

  it('reads a silence the status alone reports', () => {
    expect(spoke({ status: 'no_answer', disposition: null, answeredBy: null })).toBe(false);
    expect(spoke({ status: 'busy', disposition: null, answeredBy: null })).toBe(false);
    expect(spoke({ status: 'completed', disposition: 'completed', answeredBy: null })).toBe(true);
  });
});

describe('isEmptyValue', () => {
  it('reads filler words as empty and real answers as answers', () => {
    expect(isEmptyValue('N/A')).toBe(true);
    expect(isEmptyValue('0')).toBe(false);
    expect(isEmptyValue([])).toBe(true);
  });
});
