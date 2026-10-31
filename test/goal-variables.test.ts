import { describe, expect, it } from 'vitest';
import {
  FOLLOW_UP_NOTE,
  GOAL_VARIABLE_NAMES,
  goalVariables,
  previousCallSentence,
} from '../src/lib/goalVariables.js';

const VARIABLE = 'next_call_instructions_vocobaseplatform';

describe('goalVariables', () => {
  it('sends nothing on a first conversation', () => {
    expect(goalVariables(null)).toEqual({});
    expect(goalVariables({ memory: null })).toEqual({});
    expect(goalVariables({ memory: '   ' })).toEqual({});
    // A timestamp with no memory is still a first conversation: only a
    // recorded memory says somebody was spoken to.
    expect(goalVariables({ memory: null, callTimestamp: '2026-09-02T14:30+05' })).toEqual({});
  });

  /**
   * The one variable carries the whole object, assembled by YE: its own
   * standing continuation order, when the last call happened, and the memory
   * that call left. The order cannot live in the prompt — the prompt is
   * written once at campaign start and would then say it on a first call too.
   */
  it('sends the frame, the time and the instructions as one JSON object', () => {
    const memory = 'Dropped after the first report number; resume there.';
    const sent = goalVariables({ memory, callTimestamp: '2026-09-02T14:30+05' });

    expect(Object.keys(sent)).toEqual([VARIABLE]);
    expect(JSON.parse(sent[VARIABLE]!)).toEqual({
      note: FOLLOW_UP_NOTE,
      previous_call_end_timestamp: 'Previous call ended at 2026-09-02T14:30+05',
      instructions: memory,
    });
  });

  /**
   * A record written with no readable timestamp carries no
   * `previous_call_end_timestamp` at all, rather than a sentence that trails
   * off after "at": the opener then has nothing to name, which is the honest
   * state.
   */
  it('omits the time when the last call left none', () => {
    const memory = 'Resume from the budget question.';
    for (const record of [
      { memory },
      { memory, callTimestamp: null },
      { memory, callTimestamp: '   ' },
    ]) {
      expect(JSON.parse(goalVariables(record)[VARIABLE]!)).toEqual({
        note: FOLLOW_UP_NOTE,
        instructions: memory,
      });
    }
  });

  it('states the follow-up frame in YE’s own words, and states no steps', () => {
    expect(FOLLOW_UP_NOTE).toBe(
      'Last call was incomplete. THIS IS A FOLLOW-UP CALL. You have already spoken to this ' +
        'person before. Do not restart the conversation from scratch. Use the instructions ' +
        'below to continue from where the previous call stopped.',
    );
    // The steps are the instructions key's to write, per contact and per
    // drop. Contender D stated them here, generically, and lost turn 1 in
    // nine of sixteen drop cells (`h2h-D-menu-skip`).
    expect(FOLLOW_UP_NOTE).not.toContain('Step 1');
    // No trailing full stop: the sentence is a field's value, not prose,
    // and the specification writes it without one.
    expect(previousCallSentence('2026-09-02T14:30+05')).toBe(
      'Previous call ended at 2026-09-02T14:30+05',
    );
  });

  /** The model's half arrives with quotes, arrows and newlines in it — a
   *  summary of a call quotes what was said — so it has to survive escaping
   *  rather than run into the order. */
  it('escapes instructions carrying quotes, arrows and newlines', () => {
    const memory = 'Step 1: "Hi Priya" → if the user agrees\nStep 2: "Shall we carry on?"';
    const value = goalVariables({ memory })[VARIABLE]!;

    expect(JSON.parse(value).instructions).toBe(memory);
    // Escaped, not raw: a bare newline inside a JSON string is not JSON, and
    // an unescaped quote would let the memory close the field it sits in.
    expect(value).toContain('\\n');
    expect(value).toContain('\\"Hi Priya\\"');
  });

  it('is pretty-printed, so the model reads labelled fields', () => {
    const value = goalVariables({
      memory: 'Resume from the budget question.',
      callTimestamp: '2026-09-02T14:30+05',
    })[VARIABLE]!;

    expect(value.startsWith('{\n')).toBe(true);
    expect(value).toContain('\n  "note": ');
    expect(value).toContain('\n  "previous_call_end_timestamp": ');
    expect(value).toContain('\n  "instructions": ');
  });

  it('trims the memory and the timestamp it sends', () => {
    const value = goalVariables({
      memory: '\n Resume from the budget question. \n',
      callTimestamp: '  2026-09-02T14:30+05  ',
    })[VARIABLE]!;

    const parsed = JSON.parse(value);
    expect(parsed.instructions).toBe('Resume from the budget question.');
    expect(parsed.previous_call_end_timestamp).toBe('Previous call ended at 2026-09-02T14:30+05');
  });

  it('names exactly the one reserved variable', () => {
    expect([...GOAL_VARIABLE_NAMES]).toEqual(['next_call_instructions_vocobaseplatform']);
  });
});
