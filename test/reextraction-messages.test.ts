import { describe, expect, it } from 'vitest';
import { CALL_NOTE_KEYS } from '../src/lib/extractionConfig.js';
import { CALL_NOTE_DESCRIPTIONS } from '../src/services/campaignExtraction.js';
import { buildMessages, dateTimeLine, extractionInstruction } from '../src/lib/reextraction/messages.js';
import { ReextractionSkip } from '../src/lib/reextraction/skip.js';

const IST = 'Asia/Kolkata';

/** A real instant, so the weekday and the offset in the assertions below are
 *  facts about the calendar rather than about the formatter. 2026-09-04 is a
 *  Friday, 10:00 in Kolkata and 00:30 the same morning in New York. */
const ENDED = new Date('2026-09-04T04:30:00Z');

const PROMPT = 'You are Riya, calling on behalf of YE.';

describe('the extraction instruction', () => {
  /**
   * The shape the simulator measured H with: one opening line, one line per
   * call-note key in the order they are declared, one closing line. Pinned as
   * a whole rather than by substring — the instruction is the experiment, and
   * a line added or reordered here is a different experiment.
   */
  it('asks for one JSON object with exactly the seven call-note keys', () => {
    const lines = extractionInstruction().split('\n');

    expect(lines[0]).toBe(
      'The call has ended. Based on the conversation above and your instructions, ' +
        'return ONE JSON object with exactly these keys and nothing else:',
    );
    expect(lines.at(-1)).toBe('Use null for anything you cannot determine.');
    expect(lines).toHaveLength(CALL_NOTE_KEYS.length + 2);

    for (const [index, key] of CALL_NOTE_KEYS.entries()) {
      expect(lines[index + 1]!.startsWith(`- ${key} (`)).toBe(true);
    }
  });

  /**
   * Production's words, not a paraphrase of them. The whole point of the
   * re-extraction is that these conversations are judged by the contract the
   * platform now ships, so the descriptions are read from
   * `CALL_NOTE_DESCRIPTIONS` and a copy here would let the two drift.
   */
  it("carries production's description for every key", () => {
    const instruction = extractionInstruction();

    for (const key of CALL_NOTE_KEYS) {
      expect(instruction).toContain(CALL_NOTE_DESCRIPTIONS[key].description);
    }
  });

  /** The two keys with a pinned vocabulary state it beside their type, the
   *  way the set does upstream; the other five state a bare type. */
  it('pins the allowed values of the two keys that have them', () => {
    const instruction = extractionInstruction();

    expect(instruction).toContain(
      '- call_outcome_vocobaseplatform (string, one of: incomplete, stop, completed): ',
    );
    expect(instruction).toContain(
      '- immediate_callback_needed_vocobaseplatform (string, one of: yes, no): ',
    );
    expect(instruction).toContain('- call_outcome_reason_vocobaseplatform (string): ');
  });
});

describe('the date-time line', () => {
  /**
   * The model is being asked about a call that ended months ago, and every
   * relative time in the transcript ("next Tuesday") has to resolve against
   * that moment rather than against today. The wall clock is the campaign's
   * own zone, because that is the clock the conversation was held on.
   */
  it("renders the end of the call in the campaign's zone", () => {
    expect(dateTimeLine(ENDED, IST)).toBe(
      'DATE-TIME CONTEXT: This call ended on Friday, 4 September 2026 at 10:00 ' +
        '(Asia/Kolkata, UTC+05:30). Resolve every relative date or time in the transcript ' +
        'against that moment and return absolute values; never invent a date.',
    );
  });

  /** The same instant in another zone is another wall clock and another
   *  offset — including, here, another calendar hour of the same day. */
  it('moves the wall clock and the offset with the zone', () => {
    expect(dateTimeLine(ENDED, 'America/New_York')).toContain(
      'This call ended on Friday, 4 September 2026 at 00:30 (America/New_York, UTC-04:00).',
    );
  });

  /**
   * The offset is the one the zone was on THAT DAY, not the one it is on now.
   *
   * These campaigns are re-judged months after they ran, and a zone that keeps
   * summer time is on two different offsets across a single autumn. Taken from
   * the offset the run happens to execute under, a January call would be handed
   * to the model an hour out — and an hour is the difference between "ten in
   * the morning" and a callback booked for nine.
   */
  it('states the offset the zone was on when the call ended', () => {
    const january = new Date('2026-01-15T05:30:00Z');

    expect(dateTimeLine(january, 'America/New_York')).toContain(
      'This call ended on Thursday, 15 January 2026 at 00:30 (America/New_York, UTC-05:00).',
    );
    expect(dateTimeLine(ENDED, 'America/New_York')).toContain('(America/New_York, UTC-04:00).');
  });

  /** `Intl` reports a bare "GMT" for a zone with no offset, which is not an
   *  offset at all; the line still has to name one. */
  it('states a zero offset for UTC rather than an empty one', () => {
    expect(dateTimeLine(ENDED, 'UTC')).toContain('at 04:30 (UTC, UTC+00:00).');
  });
});

describe('the messages', () => {
  const turns = [
    { role: 'assistant', content: 'Hello, is this Priya?' },
    { role: 'user', content: 'Yes, speaking.' },
  ];

  it('puts the prompt snapshot first and the instruction last', () => {
    const messages = buildMessages({ systemPrompt: PROMPT, transcript: turns, endedAt: ENDED, timezone: IST });

    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({ role: 'system', content: PROMPT });
    expect(messages[1]).toEqual({ role: 'assistant', content: 'Hello, is this Priya?' });
    expect(messages[2]).toEqual({ role: 'user', content: 'Yes, speaking.' });
    expect(messages[3]!.role).toBe('user');
    expect(messages[3]!.content).toBe(`${dateTimeLine(ENDED, IST)}\n\n${extractionInstruction()}`);
  });

  /**
   * The dump's transcripts are not all written in one vocabulary. Everything
   * the bot said has to reach the model as an assistant turn or the model
   * reads its own words as the lead's — and an unrecognised role is read as
   * the lead's, because the one thing that must never happen is a lead's
   * refusal arriving as something the agent said.
   */
  it('maps every spelling of the two speakers', () => {
    const messages = buildMessages({
      systemPrompt: PROMPT,
      transcript: [
        { role: 'agent', content: 'a' },
        { role: 'bot', content: 'b' },
        { role: 'customer', content: 'c' },
        { role: 'caller', content: 'd' },
        { role: 'Assistant', content: 'e' },
        { role: 'narrator', content: 'f' },
      ],
      endedAt: ENDED,
      timezone: IST,
    });

    expect(messages.slice(1, -1).map((m) => m.role)).toEqual([
      'assistant',
      'assistant',
      'user',
      'user',
      'assistant',
      'user',
    ]);
  });

  /**
   * A dump with no transcript is a call there is nothing to re-judge. Asking
   * the model anyway would get a confident verdict about a conversation it
   * never saw, and that verdict would re-arm a contact.
   */
  it('refuses to build messages for a call with no transcript', () => {
    const build = () =>
      buildMessages({ systemPrompt: PROMPT, transcript: [], endedAt: ENDED, timezone: IST });

    expect(build).toThrow(ReextractionSkip);
    expect(build).toThrow(/empty_transcript/);

    try {
      build();
      expect.unreachable('expected a skip');
    } catch (error) {
      expect((error as ReextractionSkip).reason).toBe('empty_transcript');
    }
  });

  /** Blank turns are not a transcript either — a dump that carries two empty
   *  strings has the same nothing in it as one that carries no turns. */
  it('reads a transcript of blank turns as no transcript', () => {
    expect(() =>
      buildMessages({
        systemPrompt: PROMPT,
        transcript: [{ role: 'assistant', content: '  ' }],
        endedAt: ENDED,
        timezone: IST,
      }),
    ).toThrow(ReextractionSkip);
  });
});
