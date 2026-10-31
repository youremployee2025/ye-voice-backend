import { describe, expect, it } from 'vitest';
import { renderBatch, renderReport, stripMarkers, tally } from '../src/lib/reextraction/report.js';
import type { RunRow } from '../src/lib/reextraction/report.js';

/**
 * The document an operator decides on.
 *
 * The run itself is careful and reversible; this is the only part of it a
 * person actually reads, and every decision it supports is one it has to make
 * legible — which verdicts moved, which conversations were not judged and why,
 * and above all which contacts a reopened `stop` has NOT actually freed,
 * because those are the ones that look re-armed and will be swept out again on
 * the next dispatcher pass.
 *
 * Rendered from rows rather than from the database, so every case here is a
 * few lines of data and none of them needs a campaign.
 */

const base: RunRow = {
  campaignContactId: 'ck_one',
  phoneTail: '4321',
  attemptNo: 2,
  oldOutcome: 'stop',
  oldCallbackType: null,
  newOutcome: 'incomplete',
  newCallbackType: 'requested',
  oldStatus: 'COMPLETED',
  newPlan: 'callback',
  reopenedStop: true,
  stillListed: false,
};

const row = (fields: Partial<RunRow> = {}): RunRow => ({ ...base, ...fields });

const report = (fields: Partial<Parameters<typeof renderReport>[0]> = {}): string =>
  renderReport({
    campaign: { id: 'cmp_1', name: 'Touchbase September' },
    runId: 'rx_a1b2',
    apply: false,
    batchSize: 20,
    concurrency: 4,
    startedAt: new Date('2026-09-05T06:00:00Z'),
    timezone: 'Europe/London',
    timezoneDefaulted: false,
    rows: [row()],
    notSelected: [],
    outcome: { kind: 'completed' },
    ...fields,
  });

describe('the header', () => {
  it('names the campaign beside its id, the run, and the batching', () => {
    const markdown = report();

    expect(markdown).toContain('Touchbase September');
    expect(markdown).toContain('cmp_1');
    expect(markdown).toContain('rx_a1b2');
    expect(markdown).toContain('2026-09-05T06:00:00.000Z');
    expect(markdown).toContain('batch size 20');
    expect(markdown).toContain('concurrency 4');
  });

  /**
   * Which clock every relative time in every transcript was resolved against.
   * A campaign that names no zone is anchored in India by default, and that
   * default has to be stated: it is five and a half hours of difference to
   * every callback the run booked, and it is not written down anywhere else.
   */
  it('says which zone the calls were anchored in', () => {
    const markdown = report({ timezone: 'Europe/London', timezoneDefaulted: false });

    expect(markdown).toContain('Europe/London');
    expect(markdown).not.toContain('names no timezone');
  });

  it('says so when the campaign named no zone and the default stood in', () => {
    const markdown = report({ timezone: 'Asia/Kolkata', timezoneDefaulted: true });

    expect(markdown).toContain('Asia/Kolkata');
    expect(markdown).toContain('names no timezone');
  });

  /** The one fact an operator checks before believing anything below it. */
  it('says which mode the run was in', () => {
    expect(report({ apply: false })).toContain('DRY RUN');
    expect(report({ apply: false })).not.toContain('APPLY');
    expect(report({ apply: true })).toContain('APPLY');
  });
});

describe('the row table', () => {
  it('carries one row per conversation, with the plan it earned', () => {
    const markdown = report({
      rows: [row({ campaignContactId: 'ck_two', phoneTail: '9876', newPlan: 'follow_up' })],
    });

    expect(markdown).toContain('ck_two');
    expect(markdown).toContain('9876');
    expect(markdown).toContain('follow_up');
  });

  /** A skip has to say which skip. `no_prompt_snapshot` and `not_json` are two
   *  different pieces of news, and only one of them is worth a retry. */
  it('names the reason beside a skipped row', () => {
    const markdown = report({
      rows: [row({ newPlan: 'skipped', skipReason: 'session_not_found' })],
    });

    expect(markdown).toContain('session_not_found');
  });

  it('carries the message of a row that failed', () => {
    expect(report({ rows: [row({ newPlan: 'skipped', error: 'socket hang up' })] })).toContain(
      'socket hang up',
    );
  });
});

describe('the totals', () => {
  it('groups the judged rows by the transition their outcome made', () => {
    const totals = tally(
      [
        row({ oldOutcome: 'stop', newOutcome: 'incomplete' }),
        row({ oldOutcome: 'stop', newOutcome: 'incomplete' }),
        row({ oldOutcome: null, newOutcome: 'completed', newPlan: 'completed' }),
      ],
      [],
    );

    expect(totals).toMatchObject({
      'transition:stop→incomplete': 2,
      'transition:none→completed': 1,
    });
  });

  /**
   * A skipped row is not a transition. It carries whatever outcome it always
   * had, and counting that as "stop→stop" would report a run as having
   * confirmed a verdict it never asked about.
   */
  it('groups the skips by their own reason and never as a transition', () => {
    const totals = tally(
      [
        row({ newPlan: 'skipped', skipReason: 'not_json' }),
        row({ newPlan: 'skipped', skipReason: 'empty_transcript' }),
        row({ newPlan: 'skipped', skipReason: 'not_json' }),
        row({ newPlan: 'skipped', error: 'socket hang up' }),
      ],
      [],
    );

    expect(totals).toEqual({
      'skip:not_json': 2,
      'skip:empty_transcript': 1,
      error: 1,
    });
  });

  /**
   * A reply that named no outcome is not a contact that moved to having no
   * arm. Counted as `stop→none` it would read, forty rows deep, as forty
   * contacts the run had disarmed — when in fact the run wrote nothing at all
   * for them and each still holds the verdict it always had.
   */
  it('counts a reply that named no outcome under its own key', () => {
    const totals = tally(
      [
        row({ newPlan: 'no_verdict', newOutcome: null, newCallbackType: null }),
        row({ newPlan: 'no_verdict', newOutcome: null, newCallbackType: null, oldOutcome: null }),
      ],
      [],
    );

    expect(totals).toEqual({ 'no_verdict:stop': 1, 'no_verdict:none': 1 });
  });

  /** Contacts the selection never handed over are still the operator's
   *  problem — an `excluded` one is manual work — so they are counted. */
  it('counts the contacts the selection never handed over', () => {
    const totals = tally([], [
      { campaignContactId: 'ck_a', reason: 'excluded' },
      { campaignContactId: 'ck_b', reason: 'never_reached' },
      { campaignContactId: 'ck_c', reason: 'excluded' },
    ]);

    expect(totals).toEqual({ 'not_selected:excluded': 2, 'not_selected:never_reached': 1 });
  });

  it('renders every group it was given', () => {
    const markdown = report({
      rows: [row(), row({ newPlan: 'skipped', skipReason: 'not_json' })],
      notSelected: [{ campaignContactId: 'ck_a', reason: 'excluded' }],
    });

    expect(markdown).toContain('transition:stop→incomplete');
    expect(markdown).toContain('skip:not_json');
    expect(markdown).toContain('not_selected:excluded');
  });
});

/**
 * The section the whole review turns on.
 *
 * A reopened `stop` whose number is still on the do-not-call list is NOT
 * dialable: the run deletes only the row its own withdrawn verdict created, and
 * an uploaded opt-out — or another contact on the same number — survives it and
 * has the dispatcher sweep this contact straight back out. Listing the two
 * together would tell an operator that a thousand contacts are back when some
 * of them need a row cleared by hand first.
 */
describe('reopened stops', () => {
  it('separates the ones that are dialable from the ones still listed', () => {
    const markdown = report({
      rows: [
        row({ campaignContactId: 'ck_free', stillListed: false }),
        row({ campaignContactId: 'ck_listed', phoneTail: '9876', stillListed: true }),
      ],
    });

    // Read inside the section only: both contacts also appear in the table of
    // every conversation above it, which says nothing about which half of the
    // reopened list they are in.
    const section = markdown.slice(markdown.indexOf('## Reopened stops'));
    const free = section.indexOf('ck_free');
    const listed = section.indexOf('ck_listed');
    const heading = section.indexOf('Reopened but still listed');

    expect(free).toBeGreaterThan(-1);
    expect(listed).toBeGreaterThan(heading);
    expect(free).toBeLessThan(heading);
  });

  /** "Dialable" is two conditions, not one, and the second is invisible in the
   *  row: a contact past its retry or dial budget is never claimed either. */
  it('says what dialable means, budgets included', () => {
    const markdown = report();

    expect(markdown).toContain('budget');
    expect(markdown).toContain('over_budget');
  });

  it('says how many are in each half', () => {
    const markdown = report({
      rows: [row({ stillListed: true }), row({ campaignContactId: 'ck_two' })],
    });

    expect(markdown).toContain('Dialable again (1)');
    expect(markdown).toContain('Reopened but still listed (1)');
  });

  /** A contact whose verdict was never `stop`, and one whose new verdict is a
   *  `stop` again, are not reopenings. */
  it('lists nothing when no stop was reversed', () => {
    expect(report({ rows: [row({ reopenedStop: false })] })).toContain('No stop was reopened');
  });

  /**
   * A conversation re-judged by an EARLIER run carries this tool's own
   * bookkeeping in its stored extraction. Printed beside the new verdict those
   * two keys are noise in every row of a re-run, and they are not anything the
   * model ever said.
   */
  it('drops the run markers from the old note it prints', () => {
    const markdown = report({
      rows: [
        row({
          oldExtraction: {
            call_outcome_vocobaseplatform: 'stop',
            _reextractedBy: 'rx_previous',
            _reextractedAt: '2026-09-01T00:00:00.000Z',
          },
        }),
      ],
    });

    expect(markdown).toContain('call_outcome_vocobaseplatform');
    expect(markdown).not.toContain('_reextractedBy');
    expect(markdown).not.toContain('rx_previous');
  });

  it('leaves a note that carries no markers exactly as it is', () => {
    expect(stripMarkers({ a: 1, _b: 2 })).toEqual({ a: 1 });
    expect(stripMarkers('not an object')).toBe('not an object');
    expect(stripMarkers(null)).toBeNull();
  });
});

/**
 * The last line is the one an operator reads first when a run was long, and it
 * is the difference between "this is the whole campaign" and "this is the first
 * forty contacts of it".
 */
describe('the closing line', () => {
  it('says the run finished', () => {
    expect(report({ outcome: { kind: 'completed' } })).toContain('Run completed');
  });

  it('says which batch it stopped after when the operator stopped it', () => {
    expect(report({ outcome: { kind: 'stopped', batchNo: 1, reason: 'operator' } })).toContain(
      'Stopped after batch 1',
    );
  });

  /** A batch mostly of failures is a model that is down, not a campaign that
   *  is odd, and the batch was deliberately left unapplied. */
  it('says a batch was abandoned and left unapplied', () => {
    const markdown = report({
      outcome: { kind: 'stopped', batchNo: 2, reason: 'batch_abandoned' },
    });

    expect(markdown).toContain('Stopped at batch 2');
    expect(markdown).toContain('unapplied');
  });

  /** A prompt that could not be asked — a closed stdin, an interrupt — is not
   *  an operator saying yes. The run ends, and the report survives. */
  it('says the confirmation prompt itself failed', () => {
    const markdown = report({
      outcome: { kind: 'stopped', batchNo: 1, reason: 'confirm_failed' },
    });

    expect(markdown).toContain('Stopped after batch 1');
    expect(markdown).toContain('could not be asked');
  });

  it('names the refusal that aborted it', () => {
    const markdown = report({
      outcome: { kind: 'aborted', batchNo: 3, reason: 'campaign_is_live: RUNNING' },
    });

    expect(markdown).toContain('Aborted');
    expect(markdown).toContain('campaign_is_live: RUNNING');
  });
});

describe('the batch print', () => {
  it('carries the batch number, its rows and the running totals', () => {
    const line = renderBatch({
      batchNo: 2,
      rows: [row({ campaignContactId: 'ck_two' })],
      totals: { 'transition:stop→incomplete': 3 },
    });

    expect(line).toContain('Batch 2');
    expect(line).toContain('ck_two');
    expect(line).toContain('transition:stop→incomplete');
    expect(line).toContain('3');
  });
});
