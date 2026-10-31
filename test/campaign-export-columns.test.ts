import { describe, expect, it } from 'vitest';
import { splitExtractionKeys } from '../src/lib/campaignExportColumns.js';

/**
 * The Metric/Entity split, and the reserved-key filter.
 *
 * The rule is derived from the data rather than from configuration: a key with
 * a sibling `<key>_reason` is a Metric and carries a Reason column; a key with
 * no such sibling is an Entity and carries none. Verified against the Convin
 * export this replaces — all ten of its Metrics have a Reason and none of its
 * five Entities does — so this is the rule that reproduces that file, not an
 * approximation of it.
 */
describe('splitExtractionKeys', () => {
  it('files a key with a _reason sibling as a metric, and pairs the two', () => {
    const split = splitExtractionKeys(['Call_Outcome_tb', 'Call_Outcome_tb_reason']);

    expect(split.metrics).toEqual([{ key: 'Call_Outcome_tb', reasonKey: 'Call_Outcome_tb_reason' }]);
    expect(split.entities).toEqual([]);
  });

  it('files a key with no _reason sibling as an entity', () => {
    const split = splitExtractionKeys(['Customer_Voice']);

    expect(split.metrics).toEqual([]);
    expect(split.entities).toEqual(['Customer_Voice']);
  });

  /** A reason key is consumed by its parent and is never a column of its own —
   *  emitted as an entity it would appear twice under two headings. */
  it('never emits a reason key as an entity', () => {
    const split = splitExtractionKeys(['NPS_Score', 'NPS_Score_reason', 'Customer_Voice']);

    expect(split.metrics.map((m) => m.key)).toEqual(['NPS_Score']);
    expect(split.entities).toEqual(['Customer_Voice']);
  });

  /** YE's own machinery. Every one is already a first-class column on the row
   *  — goal_achieved, last_call_note, callbacks, arm_kind — so emitting it here
   *  puts two versions of one fact in the same row, one of them raw. */
  it('drops the reserved platform keys entirely', () => {
    const split = splitExtractionKeys([
      'call_outcome_vocobaseplatform',
      'call_outcome_reason_vocobaseplatform',
      'callback_requested_at',
      'callback_at',
      'budget',
    ]);

    expect(split.metrics).toEqual([]);
    expect(split.entities).toEqual(['budget']);
  });

  /** A stable header across two exports of the same campaign: the column order
   *  cannot depend on the order Postgres happened to return the keys in. */
  it('orders both groups alphabetically, whatever order the keys arrive in', () => {
    const split = splitExtractionKeys(['zeta', 'alpha', 'mid', 'mid_reason']);

    expect(split.metrics.map((m) => m.key)).toEqual(['mid']);
    expect(split.entities).toEqual(['alpha', 'zeta']);
  });
});
