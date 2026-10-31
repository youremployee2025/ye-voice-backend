import { describe, expect, it } from 'vitest';
import {
  NOTE_BLOCK_END,
  NOTE_BLOCK_POSITION,
  NOTE_BLOCK_START,
  NOTE_PROMPT_BLOCK,
  hasEditedManagedBlock,
  hasIntactGoalBlock,
  hasLegacyBlock,
  unknownManagedMarkers,
  withGoalBlock,
  withoutGoalBlock,
} from '../src/lib/goalPromptBlock.js';
import { GOAL_VARIABLE_NAMES } from '../src/lib/goalVariables.js';

const OLD_BLOCK = [
  '[EZO campaign context — managed by EZO, do not edit]',
  'Campaign goal: {{campaign_goal}}',
  'What you already know about them: {{memory}}',
  '[end EZO campaign context]',
].join('\n');

/**
 * The branded call-note markers this release replaced, written out verbatim
 * rather than imported.
 *
 * Deliberately a literal: the point of these tests is that the strings on
 * agents upstream are still found and removed, and a constant would let a
 * rename pass by rewriting both sides of the assertion at once. This text
 * exists on real prompts and cannot be changed by editing this file.
 */
const BRANDED_NOTE_BLOCK = [
  '[EZO call note — managed by EZO, do not edit]',
  '# CRITICAL CONTEXT (OVERRIDES ALL OTHER INSTRUCTIONS)',
  '',
  '{{next_call_instructions_vocobaseplatform}}',
  '',
  '========================================',
  '[end EZO call note]',
].join('\n');

describe('the note prompt block', () => {
  /**
   * The block is read by an operator in the agent's own prompt editor, so the
   * supplier's name must not be in it. Asserted case-insensitively and against
   * the whole block rather than the markers alone — the header and the rule
   * line are just as visible, and a future edit could reintroduce it anywhere.
   */
  it('carries the supplier name nowhere', () => {
    expect(NOTE_PROMPT_BLOCK.toLowerCase()).not.toContain('ezo');
    expect(NOTE_BLOCK_START.toLowerCase()).not.toContain('ezo');
    expect(NOTE_BLOCK_END.toLowerCase()).not.toContain('ezo');
  });

  it('names every goal variable and nothing else', () => {
    const used = [...NOTE_PROMPT_BLOCK.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
    expect(new Set(used)).toEqual(new Set(GOAL_VARIABLE_NAMES));
  });

  it('carries the header verbatim, between the markers', () => {
    expect(NOTE_PROMPT_BLOCK).toBe(
      [
        NOTE_BLOCK_START,
        '# CRITICAL CONTEXT (OVERRIDES ALL OTHER INSTRUCTIONS)',
        '',
        '{{next_call_instructions_vocobaseplatform}}',
        '',
        '========================================',
        NOTE_BLOCK_END,
      ].join('\n'),
    );
  });

  /** The header is unconditional, and the "if any" it used to carry is now
   *  the variable's absence: on a first call there is nothing under it. What
   *  says a call is a follow-up lives in the variable (`FOLLOW_UP_NOTE`),
   *  which is the only half of this that knows. */
  it('does not itself claim a previous call happened', () => {
    expect(NOTE_PROMPT_BLOCK).not.toContain('IF ANY');
    expect(NOTE_PROMPT_BLOCK).not.toContain('FOLLOW-UP');
    expect(NOTE_PROMPT_BLOCK).not.toContain('LAST CALL');
  });

  it('goes at the top of the prompt by default', () => {
    // Measured, not assumed: the simulator's S04 ran 0/3 with the note at
    // the end and 2/3 at the top (docs/plans/2026-09-03-call-note-run-1.md).
    expect(NOTE_BLOCK_POSITION).toBe('top');
  });

  it('prepends once and is idempotent', () => {
    const once = withGoalBlock('You are Asha.');
    expect(once).toBe(`${NOTE_PROMPT_BLOCK}\n\nYou are Asha.`);
    expect(withGoalBlock(once)).toBe(once);
  });

  it('appends when the position is the end', () => {
    const once = withGoalBlock('You are Asha.', 'end');
    expect(once).toBe(`You are Asha.\n\n${NOTE_PROMPT_BLOCK}`);
    expect(withGoalBlock(once, 'end')).toBe(once);
  });

  it('moves an intact block written at the other position', () => {
    const atTop = withGoalBlock('You are Asha.', 'top');
    const moved = withGoalBlock(atTop, 'end');
    expect(moved).toBe(`You are Asha.\n\n${NOTE_PROMPT_BLOCK}`);
    expect(moved.split(NOTE_BLOCK_START)).toHaveLength(2);
  });

  /**
   * And the direction production actually takes. The test above runs top → end,
   * which only happens if somebody changes `NOTE_BLOCK_POSITION`; the migration
   * a running install performs is the reverse — an agent provisioned by a
   * release that appended the block is written at the top on its next start —
   * and it is reachable at the default position, so it is the one that must not
   * be left to the other test's symmetry.
   */
  it('moves an intact block that an earlier release appended to the end', () => {
    const appended = `You are Asha.\n\n${NOTE_PROMPT_BLOCK}`;
    const moved = withGoalBlock(appended);
    expect(moved).toBe(`${NOTE_PROMPT_BLOCK}\n\nYou are Asha.`);
    expect(moved.split(NOTE_BLOCK_START)).toHaveLength(2);
  });

  it('replaces a stale or hand-edited block', () => {
    const edited = `Intro.\n\n${NOTE_BLOCK_START}\nsomething the operator typed\n${NOTE_BLOCK_END}\nOutro.`;
    expect(hasIntactGoalBlock(edited)).toBe(false);
    const fixed = withGoalBlock(edited);
    expect(hasIntactGoalBlock(fixed)).toBe(true);
    expect(fixed.endsWith('Intro.\n\nOutro.')).toBe(true);
    // Counted by splitting, not by a regex: the marker's square brackets are a
    // character class if it is compiled as a pattern, so `new RegExp(marker)`
    // would match every letter in it rather than the marker once.
    expect(fixed.split(NOTE_BLOCK_START)).toHaveLength(2);
  });

  /** An agent that served a goal campaign under the previous release carries
   *  the campaign-context block; the write replaces it rather than stacking
   *  a second managed block whose variables nothing sends any more. */
  it('replaces the previous release’s campaign-context block', () => {
    const carried = `${OLD_BLOCK}\n\nYou are Asha.`;
    const written = withGoalBlock(carried);
    expect(written).toBe(`${NOTE_PROMPT_BLOCK}\n\nYou are Asha.`);
    expect(written).not.toContain('[EZO campaign context');
    expect(withoutGoalBlock(carried)).toBe('You are Asha.');
  });

  /** The same block, at the position the release BEFORE that one wrote it.
   *  The campaign-context block only moved to the top on 2026-09-02, so an
   *  agent provisioned earlier and never restarted since carries it after the
   *  customer's own instructions — the oldest prompt this release can still be
   *  handed, and the one whose removal span has the most to get wrong. */
  it('replaces that block wherever the release that wrote it put it', () => {
    const carried = `You are Asha.\n\n${OLD_BLOCK}`;
    const written = withGoalBlock(carried);
    expect(written).toBe(`${NOTE_PROMPT_BLOCK}\n\nYou are Asha.`);
    expect(written).not.toContain('[EZO campaign context');
  });

  /**
   * The migration this release actually performs. Every agent serving a goal
   * campaign today carries the branded block; the write must replace it, not
   * stack a second managed block naming the same variable — two blocks would
   * both render, and the model would read the note twice under two headers.
   */
  it('replaces the branded call-note block it supersedes', () => {
    const carried = `${BRANDED_NOTE_BLOCK}\n\nYou are Asha.`;
    const written = withGoalBlock(carried);

    expect(written).toBe(`${NOTE_PROMPT_BLOCK}\n\nYou are Asha.`);
    expect(written).not.toContain('[EZO call note');
    expect(written).not.toContain('[end EZO call note]');
    expect(written.split(NOTE_BLOCK_START)).toHaveLength(2);
    expect(withoutGoalBlock(carried)).toBe('You are Asha.');
  });

  /**
   * The case the idempotent early return gets wrong if it checks one legacy
   * marker instead of all of them: this release's block is already at the top
   * and correct, so `withGoalBlock` is tempted to return the prompt untouched —
   * stranding the branded block below it for good, because the next start would
   * take the same exit and never look inside again.
   */
  it('strips a branded block still trailing an already-correct one', () => {
    const carried = `${NOTE_PROMPT_BLOCK}\n\nYou are Asha.\n\n${BRANDED_NOTE_BLOCK}`;
    const written = withGoalBlock(carried);

    expect(written).toBe(`${NOTE_PROMPT_BLOCK}\n\nYou are Asha.`);
    expect(written.toLowerCase()).not.toContain('ezo');
  });

  /** An agent that has been through both renames without a restart carries
   *  both dead blocks. Each loses its own span, and one block is written. */
  it('clears every superseded block at once', () => {
    const carried = `${OLD_BLOCK}\n\nYou are Asha.\n\n${BRANDED_NOTE_BLOCK}`;
    const written = withGoalBlock(carried);

    expect(written).toBe(`${NOTE_PROMPT_BLOCK}\n\nYou are Asha.`);
    expect(written.toLowerCase()).not.toContain('ezo');
    expect(written.split(NOTE_BLOCK_START)).toHaveLength(2);
  });

  it('removes the block and the whitespace it brought', () => {
    expect(withoutGoalBlock(withGoalBlock('You are Asha.'))).toBe('You are Asha.');
    expect(withoutGoalBlock(withGoalBlock('You are Asha.', 'top'))).toBe('You are Asha.');
    expect(withoutGoalBlock('No block here.')).toBe('No block here.');
  });


  /**
   * The marker pairs of every release before this one, named as such. The
   * service's idempotent early return has to ask this as well as
   * `hasIntactGoalBlock`, or a prompt carrying this release's block AND a
   * dead one below it is returned untouched for ever.
   */
  it('reports a superseded block as legacy', () => {
    expect(hasLegacyBlock(`${NOTE_PROMPT_BLOCK}\n\nAsha\n\n${BRANDED_NOTE_BLOCK}`)).toBe(true);
    expect(hasLegacyBlock(`${OLD_BLOCK}\n\nAsha`)).toBe(true);
    expect(hasLegacyBlock(withGoalBlock('Asha'))).toBe(false);
  });

  /**
   * A prompt whose line endings are CRLF — which is what an operator who
   * pasted from a Windows editor has upstream. The span and the trim have to
   * count `\r` as newline too, or every removal leaves the carriage returns
   * the block brought with it and the next one leaves two more.
   */
  it('leaves no stray carriage returns behind on a CRLF prompt', () => {
    const carried = `${BRANDED_NOTE_BLOCK}\n\nYou are Asha.`.replace(/\n/g, '\r\n');

    expect(withoutGoalBlock(carried)).toBe('You are Asha.');
    expect(withGoalBlock(carried)).toBe(`${NOTE_PROMPT_BLOCK}\n\nYou are Asha.`);
  });

  it('trims CRLF around a block written at the end', () => {
    const carried = `You are Asha.\n\n${BRANDED_NOTE_BLOCK}`.replace(/\n/g, '\r\n');

    expect(withoutGoalBlock(carried)).toBe('You are Asha.');
  });

  /**
   * The marker is prose, and prose survives a round trip through an editor
   * that normalises punctuation: an em-dash that came back as a hyphen is a
   * marker no removal span will ever match again, and the block below it
   * stacks under the one this release writes. Nothing here can remove it —
   * the text is no longer the text we wrote — so the only honest answer is to
   * name it and let an operator look.
   */
  it('names a managed marker it does not recognise', () => {
    const mangled = BRANDED_NOTE_BLOCK.replace('—', '-');

    expect(unknownManagedMarkers(`${NOTE_PROMPT_BLOCK}\n\nAsha\n\n${mangled}`)).toEqual([
      '[EZO call note - managed by EZO, do not edit]',
    ]);
  });

  it('names nothing for the markers it writes and the ones it supersedes', () => {
    expect(unknownManagedMarkers(withGoalBlock('Asha'))).toEqual([]);
    expect(unknownManagedMarkers(`${BRANDED_NOTE_BLOCK}\n\nAsha`)).toEqual([]);
    expect(unknownManagedMarkers(`${OLD_BLOCK}\n\nAsha`)).toEqual([]);
    expect(unknownManagedMarkers('You are Asha. Do not edit anything.')).toEqual([]);
  });

  /**
   * A customer's own bracketed line is not ours.
   *
   * "Do not edit" in square brackets is a thing an operator writes about their
   * own section, and claiming it would put an ADMIN notification on a prompt
   * with nothing wrong with it — every start, for ever. What this looks for is
   * the shape THIS platform has ever written: a call note or a campaign
   * context, marked do-not-edit.
   */
  it('leaves a customer’s own do-not-edit line alone', () => {
    for (const line of [
      '[Company policy - do not edit]',
      '[Legal disclaimer — approved by counsel, do not edit]',
      '[Pricing table, do not edit]',
    ]) {
      expect(unknownManagedMarkers(`Intro\n${line}\nOutro`), line).toEqual([]);
    }
  });

  /** Named once however often it appears, so the notification that carries
   *  this list does not repeat one marker three times. */
  it('names an unrecognised marker once', () => {
    const mangled = '[Call note - system managed, do not edit]';

    expect(unknownManagedMarkers(`${mangled}\nx\n${mangled}`)).toEqual([mangled]);
  });

  /**
   * The same block, from an operator who pastes into their prompt editor from
   * Windows.
   *
   * Every one of these tests is a string comparison against text joined with
   * `\n`, so a prompt that is CRLF throughout matches none of them: the block
   * reads as absent, which means it reads as *edited*, and the campaign's next
   * start rewrites the agent and tells an ADMIN somebody tampered with a block
   * nobody touched. Line endings are not content, and these three questions are
   * asked of the content.
   */
  describe('a prompt whose line endings are CRLF', () => {
    const crlf = (text: string) => text.replace(/\n/g, '\r\n');

    it('reads an intact block as intact', () => {
      expect(hasIntactGoalBlock(crlf(withGoalBlock('You are Asha.')))).toBe(true);
    });

    it('does not read an intact block as edited', () => {
      expect(hasEditedManagedBlock(crlf(withGoalBlock('You are Asha.')))).toBe(false);
      expect(hasEditedManagedBlock(crlf(`${BRANDED_NOTE_BLOCK}\n\nYou are Asha.`))).toBe(false);
    });

    it('rewrites nothing that is already correct', () => {
      expect(withGoalBlock(crlf(withGoalBlock('You are Asha.')))).toBe(
        withGoalBlock('You are Asha.'),
      );
    });

    /** And an edit inside the markers is still an edit, CRLF or not — the
     *  normalisation must not make everything look intact. */
    it('still sees an edit inside the markers', () => {
      const edited = NOTE_PROMPT_BLOCK.replace('OVERRIDES ALL OTHER INSTRUCTIONS', 'is optional');

      expect(hasEditedManagedBlock(crlf(`Intro\n\n${edited}`))).toBe(true);
    });
  });

  /**
   * An edited block BESIDE an intact one.
   *
   * A presence test answers "there is an intact block here" and stops, so the
   * operator's own words in the second block are stripped by the rewrite
   * without a word to anybody. Counted instead: more starts than whole blocks
   * means at least one of them is not ours any more.
   */
  describe('a duplicate block that was edited', () => {
    it('is reported even when an intact block stands beside it', () => {
      const carried = [
        NOTE_PROMPT_BLOCK,
        'You are Asha.',
        `${NOTE_BLOCK_START}\nsomething the operator typed\n${NOTE_BLOCK_END}`,
      ].join('\n\n');

      expect(hasIntactGoalBlock(carried)).toBe(true);
      expect(hasEditedManagedBlock(carried)).toBe(true);
    });

    it('is reported for the branded markers too', () => {
      const carried = [
        BRANDED_NOTE_BLOCK,
        'You are Asha.',
        '[EZO call note — managed by EZO, do not edit]\nmy own words\n[end EZO call note]',
      ].join('\n\n');

      expect(hasEditedManagedBlock(carried)).toBe(true);
    });

    it('says nothing about two untouched copies of the same block', () => {
      const carried = `${NOTE_PROMPT_BLOCK}\n\nYou are Asha.\n\n${NOTE_PROMPT_BLOCK}`;

      expect(hasEditedManagedBlock(carried)).toBe(false);
    });
  });

  it('reports absence as not intact', () => {
    expect(hasIntactGoalBlock('plain')).toBe(false);
  });
});
