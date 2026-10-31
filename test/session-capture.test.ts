import { describe, expect, it } from 'vitest';
import {
  boundTranscript,
  boundVariables,
  MAX_STORED_TRANSCRIPT_CHARS,
  MAX_STORED_TRANSCRIPT_TURNS,
  MAX_STORED_VARIABLES,
} from '../src/lib/sessionCapture.js';

/**
 * A finished call's conversation, bounded for storage.
 *
 * The same argument `extractionCapture` makes: this is free text a third party
 * produces, stored verbatim it puts the size of this database in their hands,
 * and it is bounded on the way IN because the reason to bound it at all is
 * that it is stored.
 */
describe('boundTranscript', () => {
  it('keeps the turns, under the names each row used', () => {
    expect(
      boundTranscript([
        { role: 'assistant', content: 'Hello?', timestamp: '2026-09-04T11:36:35Z' },
        { speaker: 'user', text: 'Yes, speaking.' },
      ]),
    ).toEqual([
      { role: 'assistant', content: 'Hello?', timestamp: '2026-09-04T11:36:35Z' },
      { role: 'user', content: 'Yes, speaking.', timestamp: null },
    ]);
  });

  /**
   * The transcript field is not always a transcript: a call that never
   * connected arrives as an OBJECT describing the failure. Stored under a
   * column named `transcript` that becomes carrier diagnostics rendered as
   * something the customer said — the exact hazard `normalizeTranscript`
   * exists to prevent on the read side.
   */
  it('stores nothing for a call that never connected', () => {
    expect(
      boundTranscript({ error: 'no answer', provider: 'acme', terminal_reason: 'CANCELLED' }),
    ).toBeNull();
  });

  it('stores nothing when the call is still being processed', () => {
    expect(boundTranscript(null)).toBeNull();
    expect(boundTranscript(undefined)).toBeNull();
  });

  /** An empty array is a real and different fact from a missing one: the call
   *  connected and nobody said anything. Null would claim we never looked. */
  it('keeps an empty conversation as an empty conversation', () => {
    expect(boundTranscript([])).toEqual([]);
  });

  /** A turn with no words is not a turn. Kept, it reads as a silence somebody
   *  recorded; and a non-object turn would store `[object Object]` as speech. */
  it('drops a turn that carries no words, and one that is not a turn at all', () => {
    expect(boundTranscript([{ role: 'user' }, 'nonsense', { role: 'user', content: 'Hi' }])).toEqual([
      { role: 'user', content: 'Hi', timestamp: null },
    ]);
  });

  it('caps the number of turns and says it did', () => {
    const many = Array.from({ length: MAX_STORED_TRANSCRIPT_TURNS + 50 }, (_, i) => ({
      role: 'user',
      content: `turn ${i}`,
    }));

    const stored = boundTranscript(many) as { role: string; content: string }[];

    expect(stored).toHaveLength(MAX_STORED_TRANSCRIPT_TURNS + 1);
    expect(stored[stored.length - 1]!.role).toBe('system');
    expect(stored[stored.length - 1]!.content).toContain('truncated');
  });

  /** One runaway turn must not become the whole budget. */
  it('caps the characters in a single turn', () => {
    const stored = boundTranscript([{ role: 'user', content: 'x'.repeat(1_000_000) }]) as {
      content: string;
    }[];

    expect(stored[0]!.content.length).toBeLessThanOrEqual(MAX_STORED_TRANSCRIPT_CHARS);
    expect(stored[0]!.content.endsWith('…')).toBe(true);
  });
});

/**
 * The pre-call variables a dial went out with.
 *
 * These need their own bound rather than the extraction's. That one caps at
 * 50 keys, and its reasoning is specific to extraction: `MAX_EXTRACTION_KEYS`
 * is the ceiling the agent editor enforces on the config that produces them,
 * so a wider result did not come from a config this service would accept.
 *
 * **Nothing bounds a variable payload that way.** Production calls measured on
 * 2026-09-08 carry **101** variables — a hundred `tb_*` columns from the
 * customer's own CSV, plus `external_id` and the managed call-note key. Bounded
 * at 50 they lose half their columns, alphabetically, with nothing on the row
 * saying so.
 */
describe('boundVariables', () => {
  it('keeps a real production payload whole', () => {
    const many = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [`tb_column_${String(i).padStart(3, '0')}`, `value ${i}`]),
    );

    const stored = boundVariables(many) as Record<string, unknown>;

    expect(Object.keys(stored)).toHaveLength(101);
    expect(stored.tb_column_100).toBe('value 100');
  });

  it('still bounds a payload nobody could have sent on purpose', () => {
    const absurd = Object.fromEntries(
      Array.from({ length: MAX_STORED_VARIABLES + 50 }, (_, i) => [`k${i}`, 'v']),
    );

    expect(Object.keys(boundVariables(absurd) as object)).toHaveLength(MAX_STORED_VARIABLES);
  });

  it('truncates one runaway value rather than dropping the key', () => {
    const stored = boundVariables({ notes: 'x'.repeat(50_000) }) as Record<string, string>;

    expect(stored.notes.endsWith('…')).toBe(true);
    expect(stored.notes.length).toBeLessThan(50_000);
  });

  /** Absent and empty are different: a campaign that maps no columns sends no
   *  variables, which is a thing it does. */
  it('keeps an empty payload as an empty payload', () => {
    expect(boundVariables({})).toEqual({});
  });

  it('stores nothing for a payload that is not an object', () => {
    expect(boundVariables(null)).toBeNull();
    expect(boundVariables('nonsense')).toBeNull();
  });
});
