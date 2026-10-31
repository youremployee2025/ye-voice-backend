/**
 * The chat the model is shown to re-judge one finished call.
 *
 * Nothing here talks to a network or a database: given a prompt snapshot and
 * a transcript, it produces the exact message list the simulator used to
 * measure contender H, so a verdict this run writes is comparable with the
 * verdicts H was scored on. That is the whole reason this is a module with
 * tests rather than a few template literals inside the script — the messages
 * *are* the experiment, and a line added to them quietly is a different
 * experiment with the same name.
 *
 * The key descriptions are read from production's `CALL_NOTE_DESCRIPTIONS`
 * rather than copied. The campaigns are being re-judged precisely because the
 * contract changed; a copy here would let this tool go on asking the old
 * question after the next edit to the contract.
 */
import { CALL_NOTE_KEYS } from '../extractionConfig.js';
import { CALL_NOTE_DESCRIPTIONS } from '../../services/campaignExtraction.js';
import { ReextractionSkip } from './skip.js';

/** One turn as the session dump carries it, before the role is normalised. */
export interface DumpTranscriptTurn {
  role: string;
  content: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * The trailing user message, in the shape the simulator asked it in: one
 * opening line, one line per call-note key, one closing line.
 *
 * A key with a pinned vocabulary states it beside its type, exactly as the
 * managed set does upstream, so the model reads the same two sources of truth
 * about an allowed value that it reads on a live call.
 */
export function extractionInstruction(): string {
  return [
    'The call has ended. Based on the conversation above and your instructions, ' +
      'return ONE JSON object with exactly these keys and nothing else:',
    ...CALL_NOTE_KEYS.map((key) => {
      const description = CALL_NOTE_DESCRIPTIONS[key];
      const type = description.values
        ? `${description.type}, one of: ${description.values.join(', ')}`
        : description.type;

      return `- ${key} (${type}): ${description.description}`;
    }),
    'Use null for anything you cannot determine.',
  ].join('\n');
}

/**
 * The zone's offset at an instant as `+05:30`.
 *
 * `Intl` reports the offset as `GMT+05:30`, and for a zone that is on zero it
 * reports the bare word `GMT` — no offset at all. The line below has to name
 * one either way, so a missing offset reads as zero rather than as an empty
 * string that would make the sentence say "UTC" twice and mean neither.
 */
function offsetOf(zoneName: string): string {
  return /GMT([+-]\d{2}:\d{2})/.exec(zoneName)?.[1] ?? '+00:00';
}

/**
 * When the call ended, in the campaign's own zone, as the one line that
 * anchors every relative time in the transcript.
 *
 * This is the whole difference between re-extracting a call and extracting
 * it live. A live extraction runs seconds after the hang-up, so "next
 * Tuesday" resolves against the model's own sense of now and lands right.
 * This run happens months later: without this line, the same words resolve
 * against today and book a callback into a week the conversation never
 * mentioned.
 *
 * The zone is the campaign's rather than UTC because it is the clock the
 * conversation was held on — "ten in the morning" in the transcript means ten
 * in the morning where the lead was.
 */
export function dateTimeLine(endedAt: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(endedAt);

  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';

  const when =
    `${part('weekday')}, ${part('day')} ${part('month')} ${part('year')} ` +
    `at ${part('hour')}:${part('minute')} (${timezone}, UTC${offsetOf(part('timeZoneName'))})`;

  return (
    `DATE-TIME CONTEXT: This call ended on ${when}. Resolve every relative date or time ` +
    'in the transcript against that moment and return absolute values; never invent a date.'
  );
}

/**
 * Which side of the conversation a turn is, whatever the dump called it.
 *
 * Not symmetrical, deliberately. Everything the bot said must arrive as an
 * assistant turn or the model reads its own words as the lead's; a role
 * nobody here recognises is read as the lead's, because a lead's refusal
 * arriving as something the agent said is the one misreading that would turn
 * a `stop` into a callback.
 */
function roleOf(role: string): 'user' | 'assistant' {
  return ['assistant', 'agent', 'bot'].includes(role.trim().toLowerCase()) ? 'assistant' : 'user';
}

/**
 * The full message list: the prompt the call actually ran with, the
 * conversation, then the date-time anchor and the instruction as one user
 * turn.
 *
 * A call with nothing said on it is skipped rather than sent. A model asked
 * to judge an empty conversation answers anyway, confidently, and that answer
 * would re-arm a contact.
 */
export function buildMessages(input: {
  systemPrompt: string;
  transcript: DumpTranscriptTurn[];
  endedAt: Date;
  timezone: string;
}): ChatMessage[] {
  const turns = input.transcript.filter((turn) => turn.content.trim() !== '');

  if (turns.length === 0) throw new ReextractionSkip('empty_transcript');

  return [
    { role: 'system', content: input.systemPrompt },
    ...turns.map((turn): ChatMessage => ({ role: roleOf(turn.role), content: turn.content })),
    {
      role: 'user',
      content: `${dateTimeLine(input.endedAt, input.timezone)}\n\n${extractionInstruction()}`,
    },
  ];
}
