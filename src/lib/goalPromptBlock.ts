/**
 * The block YE writes into a goal campaign's agent prompt: a header and the
 * one variable the follow-up instruction renders under. The platform
 * substitutes `{{name}}` in the prompt from the variables a dial carries and
 * silently drops any it never mentions — so a variable YE sends but the
 * prompt does not name reaches nobody. This block is how the instruction is
 * guaranteed to be named; and when there is none the dial carries no
 * variable, so the header renders over nothing and the block is inert.
 *
 * The header says the block overrides everything else, and it is written by
 * YE rather than asked of the customer: the simulator's runs of 2026-09-02
 * showed the model acts on a concrete line to say far better than on a rule
 * to apply, and the instruction is exactly that line. The customer's prompt
 * is left untouched.
 *
 * The header no longer says "if any". It is unconditional — "# CRITICAL
 * CONTEXT (OVERRIDES ALL OTHER INSTRUCTIONS)" — because the conditional
 * reading was work the model had to do before it could act, and the same
 * conditional is expressed better by the variable's absence: on a first call
 * there is nothing under the header to override anything with. What tells
 * the model this is a continuation is inside the variable now
 * (`FOLLOW_UP_NOTE` in `goalVariables.ts`), not in the prompt,
 * because the prompt is written once at campaign start and cannot know which
 * kind of call is being dialled.
 *
 * The word is "CONTEXT", not "INSTRUCTION". Run D of the simulator tried
 * "INSTRUCTION" on the theory that the model was weighing the block against
 * the script as background it could take or leave; the run refuted it — what
 * carries the opening is the concrete line YE writes into the variable, not
 * the noun over it — and the design settled back on the wording measured
 * here (docs/plans/2026-09-03-call-note-design.md). The parenthetical is what
 * does the overriding, and it is unchanged.
 *
 * The text is identical for every campaign and every contact: everything
 * that varies is the variable, which is what lets one agent serve several
 * goal campaigns at once. The marker lines are what make the write
 * idempotent and the removal exact.
 */
/**
 * The markers name nobody. An operator reads this block in the agent's own
 * prompt editor, and the supplier's name has no business being in the words a
 * customer's agent is given — the same rule the customer-facing strings follow
 * everywhere else. What the markers have to do is be found again exactly, which
 * needs them to be unmistakable, not branded.
 *
 * They are generic prose, which is the price of that: a customer prompt that
 * happens to quote this whole block back — the marker, the header and the
 * variable, verbatim — defeats the idempotent early return and is left alone.
 * `hasIntactGoalBlock` is what gates it, and it tests the entire block rather
 * than the marker, so the quote has to be exact to reach that; a prompt merely
 * mentioning the marker line is rewritten like any other.
 */
export const NOTE_BLOCK_START = '[Call note — system managed, do not edit]';
export const NOTE_BLOCK_END = '[end call note]';

export const NOTE_PROMPT_BLOCK = [
  NOTE_BLOCK_START,
  '# CRITICAL CONTEXT (OVERRIDES ALL OTHER INSTRUCTIONS)',
  '',
  '{{next_call_instructions_vocobaseplatform}}',
  '',
  '========================================',
  NOTE_BLOCK_END,
].join('\n');

/**
 * Where the block goes. The end is the design's position — a note at the
 * end of the prompt is the last thing the model reads before the first turn.
 * The previous block went at the top because an appended block was not read
 * before the first turn (docs/plans/2026-09-02-campaign-simulator-run-1.md);
 * the header's wording is the new lever, and the simulator measures both
 * positions before this constant is final.
 */
export type NoteBlockPosition = 'top' | 'end';
export const NOTE_BLOCK_POSITION: NoteBlockPosition = 'top';

/**
 * Every marker pair this platform has ever written, newest first.
 *
 * An agent keeps its prompt upstream, so a marker rename cannot be fixed by a
 * migration here: the only thing that ever rewrites a stored prompt is the next
 * start or resume of a campaign using that agent. A pair dropped from this list
 * is therefore a block left on somebody's agent forever, with no code path left
 * that can find it — so pairs are only ever ADDED.
 *
 * The two entries below are, in order, the branded call-note markers this
 * release replaces, and the campaign-context block before it whose seven
 * variables nothing sends any more. Both are removed rather than stacked with.
 */
const LEGACY_BLOCKS: readonly (readonly [start: string, end: string])[] = [
  ['[EZO call note — managed by EZO, do not edit]', '[end EZO call note]'],
  ['[EZO campaign context — managed by EZO, do not edit]', '[end EZO campaign context]'],
];

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Any span between a pair of markers, edited or not. Lazy, so a prompt
 *  carrying two blocks loses each one to its own end marker rather than
 *  everything between the first start and the last end — the `g` flag takes
 *  the second. */
function spanOf(start: string, end: string): RegExp {
  // `[\r\n]` rather than `\n`: a prompt an operator pasted from a Windows
  // editor is CRLF throughout, and a span that eats only the line feeds leaves
  // the carriage returns behind — one stray `\r` per removal, accumulating for
  // as long as the agent keeps being started.
  return new RegExp(`[\\r\\n]*${escape(start)}[\\s\\S]*?${escape(end)}[\\r\\n]*`, 'g');
}

const BLOCK_SPANS = [
  spanOf(NOTE_BLOCK_START, NOTE_BLOCK_END),
  ...LEGACY_BLOCKS.map(([start, end]) => spanOf(start, end)),
];

/**
 * Whether a prompt still carries a block from a release before this one.
 *
 * Exported because the service's idempotent early return has to ask it too:
 * a prompt with this release's block intact at the top and a dead one
 * trailing below is not a prompt to leave alone, and a gate that asks only
 * `hasIntactGoalBlock` strands that block on the agent for ever.
 */
export function hasLegacyBlock(prompt: string): boolean {
  return LEGACY_BLOCKS.some(([start]) => prompt.includes(start));
}

/** How many times `needle` appears in `text`. Split rather than a regex: the
 *  markers' square brackets are a character class if the string is compiled as
 *  a pattern, so `new RegExp(marker)` counts letters rather than markers. */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/**
 * The previous release's block, verbatim: the same body between the branded
 * markers it superseded. Derived rather than typed out again, because the body
 * genuinely is the same text — only the two marker lines were rebranded — and
 * two copies of it would drift the moment the header is edited.
 */
const [PREVIOUS_START, PREVIOUS_END] = LEGACY_BLOCKS[0]!;

const PREVIOUS_NOTE_BLOCK = NOTE_PROMPT_BLOCK
  .replace(NOTE_BLOCK_START, PREVIOUS_START)
  .replace(NOTE_BLOCK_END, PREVIOUS_END);

/**
 * Whether a managed block is present and no longer says what the release that
 * wrote it wrote — somebody edited inside the markers.
 *
 * Both marker pairs are asked, not just this release's. An operator who typed
 * their own instructions inside the branded call-note block is in exactly the
 * position this notification exists for, and a rename that quietly stopped
 * looking there would discard their words without a word.
 *
 * The campaign-context pair before it is deliberately absent: its seven
 * variables are a contract nothing sends any more, so every prompt carrying
 * it is migrated rather than restored, and asking whether it was edited would
 * tell an ADMIN a story about a person who does not exist.
 *
 * **Counted, not merely present.** A prompt can carry an intact block AND an
 * edited one under the same markers — one agent, two campaigns, somebody
 * pasting — and a presence test answers "there is an intact block here" and
 * stops. The rewrite then strips the operator's own words out of the second
 * block without a word to anybody. More start markers than whole blocks means
 * at least one of them is not ours any more, whichever one it is.
 */
export function hasEditedManagedBlock(prompt: string): boolean {
  const text = normalised(prompt);

  if (occurrences(text, NOTE_BLOCK_START) > occurrences(text, NOTE_PROMPT_BLOCK)) return true;

  return occurrences(text, PREVIOUS_START) > occurrences(text, PREVIOUS_NOTE_BLOCK);
}

/**
 * Marker lines this platform writes are `[<what it is> … do not edit]`, and
 * every one it has ever written says either "call note" or "campaign context".
 * A line of that shape that is neither the current start marker nor one this
 * file supersedes is a marker no removal span can ever match — most plausibly
 * one of ours whose em-dash an editor normalised to a hyphen on the way
 * through.
 *
 * **Narrowed to this platform's own two subjects on purpose.** "Do not edit"
 * inside square brackets is an ordinary thing for an operator to write over
 * their own section — `[Company policy - do not edit]` — and claiming that as
 * a broken marker of ours would put an ADMIN notification on a prompt with
 * nothing wrong with it, on every start, for ever. A false alarm that repeats
 * is worse than the stacked block it is warning about, because it is the one
 * that teaches people to ignore the bell.
 *
 * There is nothing to be done about a real one here: the text is no longer the
 * text we wrote, so a span built from our constants will not find it, and
 * guessing at near-misses is how a block somebody put there deliberately gets
 * deleted. The block under it stacks beside the one this release writes and the
 * model reads the note twice — which is why it is worth a notification even
 * though it is not worth an edit.
 *
 * Deduplicated, so the notification that carries this list names each marker
 * once however many times the prompt repeats it.
 */
const MANAGED_MARKER_LINE = /^\[[^\]]*(?:call note|campaign context)[^\]]*do not edit\]$/gim;

export function unknownManagedMarkers(prompt: string): string[] {
  const known = new Set<string>([NOTE_BLOCK_START, ...LEGACY_BLOCKS.map(([start]) => start)]);

  return [
    ...new Set(
      [...prompt.matchAll(MANAGED_MARKER_LINE)]
        .map((match) => match[0]!)
        .filter((line) => !known.has(line)),
    ),
  ];
}

/**
 * The same prompt with one kind of line ending.
 *
 * Every question this file answers about a prompt is a substring test against
 * text joined with `\n`, and an operator who pasted into the agent's prompt
 * editor from Windows has CRLF throughout. Left alone, their intact block
 * matches nothing: it reads as absent, therefore as *edited*, and every start
 * rewrites the agent and tells an ADMIN somebody tampered with a block nobody
 * touched.
 *
 * Line endings are not content, so they are normalised before the content is
 * asked about. The write is `\n` either way — the block this file owns is
 * defined that way — and the prompt around it is normalised with it, which is
 * the price of comparing a stored prompt against a constant at all.
 */
function normalised(prompt: string): string {
  return prompt.includes('\r') ? prompt.replace(/\r\n/g, '\n') : prompt;
}

export function hasIntactGoalBlock(prompt: string): boolean {
  return normalised(prompt).includes(NOTE_PROMPT_BLOCK);
}

/** The prompt with every managed block — this release's and the previous
 *  one's — taken out, and the whitespace they brought with them. */
export function withoutGoalBlock(prompt: string): string {
  return BLOCK_SPANS
    .reduce((text, span) => text.replace(span, '\n\n'), prompt)
    .replace(/^[\r\n]+|[\r\n]+$/g, '');
}

/**
 * The prompt with exactly one intact block at `position`. Idempotent: a
 * prompt already ending (or starting) with the block is returned as it is,
 * so a resume rewrites nothing. Anything else — a stale block, a hand-edited
 * one, one at the other position, the previous release's — is removed first
 * and the block written fresh.
 */
export function withGoalBlock(prompt: string, position: NoteBlockPosition = NOTE_BLOCK_POSITION): string {
  // Normalised first, so a CRLF prompt whose block is already correct takes the
  // early return below instead of being rewritten on every start — see
  // `normalised`.
  prompt = normalised(prompt);

  const placed = position === 'top' ? prompt.startsWith(NOTE_PROMPT_BLOCK) : prompt.endsWith(NOTE_PROMPT_BLOCK);
  // `hasLegacyBlock`, never one named marker: a prompt that already carries
  // this release's block can still be trailing an older one, and returning it
  // untouched would strand that block on the agent for good — the next start
  // would take this same early exit and never look inside again.
  if (placed && prompt.split(NOTE_BLOCK_START).length === 2 && !hasLegacyBlock(prompt)) return prompt;
  const bare = withoutGoalBlock(prompt);
  if (bare === '') return NOTE_PROMPT_BLOCK;
  return position === 'top' ? `${NOTE_PROMPT_BLOCK}\n\n${bare}` : `${bare}\n\n${NOTE_PROMPT_BLOCK}`;
}
