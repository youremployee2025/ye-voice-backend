import { describe, expect, it } from 'vitest';
import { readCallNote } from '../src/lib/goalRecord.js';
import { parseCallNoteReply } from '../src/lib/reextraction/parse.js';

const FULL = {
  call_outcome_vocobaseplatform: 'incomplete',
  call_outcome_reason_vocobaseplatform: 'asked to call back Tuesday',
  immediate_callback_needed_vocobaseplatform: 'no',
  immediate_callback_needed_reason_vocobaseplatform: 'call ended normally',
  callback_requested_time_vocobaseplatform: '2026-09-08T10:00+05:30',
  next_call_instructions_vocobaseplatform: 'PREVIOUS CALL SUMMARY: …',
  call_end_timestamp_vocobaseplatform: '2026-09-04T10:04+05:30',
};

/** The values of a reply that reads, so a case about the values need not
 *  restate the discriminant every time. */
function valuesOf(text: string): Record<string, unknown> {
  const parsed = parseCallNoteReply(text);

  if (!parsed.ok) throw new Error(`expected a readable reply, got ${parsed.reason}`);

  return parsed.values;
}

describe('a reply that is one JSON object', () => {
  it('keeps the seven call-note keys', () => {
    expect(valuesOf(JSON.stringify(FULL))).toEqual(FULL);
  });

  /** Models fence JSON whether or not they were asked to, with and without a
   *  language tag, and with whitespace either side of the fence. */
  it('reads a fenced reply', () => {
    expect(valuesOf(`\`\`\`json\n${JSON.stringify(FULL)}\n\`\`\``)).toEqual(FULL);
    expect(valuesOf(`\n\`\`\`\n${JSON.stringify(FULL)}\n\`\`\`\n`)).toEqual(FULL);
  });

  /**
   * Only the managed keys survive. The platform would only ever forward the
   * keys its set defines, so a reply carrying an eighth key of the model's own
   * invention must land on the attempt as the same seven values a live call
   * would have left — anything else and the re-extracted row is a shape
   * nothing else in the system writes.
   */
  it('drops keys nobody asked for', () => {
    const values = valuesOf(JSON.stringify({ ...FULL, sentiment: 'warm', confidence: 0.9 }));

    expect(values).toEqual(FULL);
  });

  /**
   * The key descriptions ask the model for the literal word "null", and it
   * obliges — in any case, sometimes padded. Stored as the word, the callback
   * time would be a string the booking tries to parse and the instructions
   * would be an opening line the next call recites.
   */
  it('reads the literal word "null" as null', () => {
    const values = valuesOf(
      JSON.stringify({
        ...FULL,
        immediate_callback_needed_vocobaseplatform: 'null',
        callback_requested_time_vocobaseplatform: ' NULL ',
      }),
    );

    expect(values).toMatchObject({
      immediate_callback_needed_vocobaseplatform: null,
      callback_requested_time_vocobaseplatform: null,
    });
  });

  /** A key the model left out stays out, rather than arriving as an explicit
   *  null: absent and "answered null" are the same fact to `readCallNote`,
   *  and inventing the key would claim the model answered when it did not. */
  it('does not invent the keys the model omitted', () => {
    const answered = {
      call_outcome_vocobaseplatform: 'completed',
      call_outcome_reason_vocobaseplatform: 'signed up on the call',
      immediate_callback_needed_vocobaseplatform: null,
      immediate_callback_needed_reason_vocobaseplatform: null,
      callback_requested_time_vocobaseplatform: null,
      call_end_timestamp_vocobaseplatform: '2026-09-04T10:04+05:30',
    };
    const values = valuesOf(JSON.stringify(answered));

    // `toStrictEqual`, so the one absent key (`next_call_instructions`) is
    // absent rather than present and undefined — which is the whole of the
    // `in` guard the reader relies on, and the one thing `toEqual` would not
    // notice going.
    expect(values).toStrictEqual(answered);
  });

  /** What the run actually does with the values: hands them to production's
   *  own reader, so a parse that satisfies this file still has to satisfy the
   *  contract everything else in the campaign reads a note through. */
  it('produces values production can read as a call note', () => {
    const note = readCallNote(valuesOf(JSON.stringify(FULL)));

    expect(note.outcome).toBe('incomplete');
    // A real, parseable time derives `requested`, whatever the immediate
    // flag says — the precedence rule.
    expect(note.callbackType).toBe('requested');
    expect(note.callbackRequestedTime).toBe('2026-09-08T10:00+05:30');
    expect(note.immediateCallbackNeeded).toBe(false);
  });
});

/**
 * Strict on purpose, all of it. A reply that is not one JSON object becomes
 * no extraction at all and the contact is left exactly as it is. Guessing at
 * a half-parsed reply would re-arm somebody from a verdict nobody wrote.
 */
describe('a reply that is not one JSON object', () => {
  /**
   * Well-formed JSON of the wrong shape. Its own reason, because it is a
   * prompt problem rather than a flaky reply: a retry produces the same array
   * again, and a run report that said only "unreadable" would have an operator
   * retrying a thousand of them.
   */
  it('refuses an array, however well-formed', () => {
    expect(parseCallNoteReply(JSON.stringify([FULL]))).toEqual({
      ok: false,
      reason: 'not_an_object',
    });
  });

  it('refuses a bare scalar or a JSON null', () => {
    expect(parseCallNoteReply('null')).toEqual({ ok: false, reason: 'not_an_object' });
    expect(parseCallNoteReply('"incomplete"')).toEqual({ ok: false, reason: 'not_an_object' });
    expect(parseCallNoteReply('42')).toEqual({ ok: false, reason: 'not_an_object' });
  });

  /** Not JSON at all — prose, silence, or an answer cut off mid-object. The
   *  one refusal that is worth asking the model again about. */
  it('refuses prose, an empty reply, and a truncated object', () => {
    expect(parseCallNoteReply('The call went well and she asked for a callback.')).toEqual({
      ok: false,
      reason: 'not_json',
    });
    expect(parseCallNoteReply('')).toEqual({ ok: false, reason: 'not_json' });
    expect(parseCallNoteReply('{"call_outcome_vocobaseplatform": "incom')).toEqual({
      ok: false,
      reason: 'not_json',
    });
  });

  /**
   * A reply that names an outcome and almost nothing else.
   *
   * It parses, it carries managed keys, and it is the most dangerous shape
   * there is: the write is a whole-column replace, so storing a couple of
   * keys blanks the rest the attempt has held since the call — the memory the
   * next dial reads out loud among them. A model that answers this way has
   * lost the format rather than found a short answer, since the instruction
   * names every managed key and asks for null where there is nothing to say.
   * Contender I ships seven keys, so the floor recomputed from
   * `CALL_NOTE_KEYS.length` is 5 (`Math.ceil(7 * 4 / 6)`), not the four it
   * was against contender H's six.
   */
  it('refuses a reply that names an outcome and little else', () => {
    expect(parseCallNoteReply(JSON.stringify({ call_outcome_vocobaseplatform: 'stop' }))).toEqual({
      ok: false,
      reason: 'partial_reply',
    });
    expect(
      parseCallNoteReply(
        JSON.stringify({
          call_outcome_vocobaseplatform: 'incomplete',
          call_outcome_reason_vocobaseplatform: 'busy',
          immediate_callback_needed_vocobaseplatform: 'no',
        }),
      ),
    ).toEqual({ ok: false, reason: 'partial_reply' });
  });

  /** Five of the seven is enough: the model answered the question in the
   *  shape it was asked, having nothing to say for the two it left out. */
  it('accepts five of the seven', () => {
    expect(
      parseCallNoteReply(
        JSON.stringify({
          call_outcome_vocobaseplatform: 'incomplete',
          call_outcome_reason_vocobaseplatform: 'busy',
          immediate_callback_needed_vocobaseplatform: 'no',
          immediate_callback_needed_reason_vocobaseplatform: 'call ended normally',
          next_call_instructions_vocobaseplatform: 'Try again Thursday.',
        }),
      ).ok,
    ).toBe(true);
  });

  /**
   * Only a reply that named an OUTCOME is judged this way. One that did not is
   * `no_verdict` a moment later, which writes nothing either — and reading it
   * as a broken reply instead would send an operator to retry a model that
   * answered exactly as it should have.
   */
  it('does not call a short reply partial when it named no outcome', () => {
    expect(parseCallNoteReply(JSON.stringify({ call_outcome_reason_vocobaseplatform: 'unclear' })).ok).toBe(
      true,
    );
  });

  /** An object carrying none of the seven keys is a reply about something
   *  else. It parses, so it cannot be caught by JSON alone — and stored, it
   *  would blank every value the attempt already had. */
  it('refuses an object with none of the managed keys', () => {
    expect(parseCallNoteReply(JSON.stringify({ sentiment: 'warm' }))).toEqual({
      ok: false,
      reason: 'no_managed_keys',
    });
  });
});
