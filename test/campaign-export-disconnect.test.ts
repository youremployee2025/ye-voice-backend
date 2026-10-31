import { describe, expect, it } from 'vitest';
import { disconnectColumns } from '../src/lib/campaignExportColumns.js';

/**
 * `Disconnect Reason Key` and `Call Disconnected By`, in the vocabulary of the
 * export this replaces.
 *
 * The pairing is not invented here. Cross-tabulating the reference export's
 * 5,328 rows leaves those two columns a pure function of each other, with only
 * four combinations occurring across the whole file:
 *
 *   user            → Customer
 *   voicebot_hangup → AI Assistant
 *   (none)          → System        on a call that rang and was not picked up
 *   (none)          → (none)        on a call that failed outright
 *
 * `Telephony Disposition` is deliberately NOT derived here. In that same file
 * the `user` key splits across two of its values — 1,250 "User connection
 * lost" against 28 "User disconnected" — so it is a function of the hangup
 * CAUSE as well as the source, and no cause distribution has been verified
 * yet. A guess in a column an operator reconciles against the carrier is worse
 * than a blank.
 */
describe('disconnectColumns', () => {
  /**
   * **The vocabulary is the platform's, and it is not the one SIP semantics
   * suggest.** `backend/docs/partner-hangup-source.md` is explicit:
   *
   *   caller  — "The person on the other end hung up."
   *   system  — "The agent ended the call."
   *
   * Read as an outbound SIP originator, `caller` looks like our own bot and
   * `system` like neither party. Both readings are wrong, and on voicelink —
   * which emits only these two, 49%/51% — they are wrong on every connected
   * call in the export.
   */
  it('reads caller as the person who was called', () => {
    expect(disconnectColumns({ hangupSource: 'caller', disposition: 'completed' })).toEqual({
      reasonKey: 'user',
      disconnectedBy: 'Customer',
    });
  });

  it('reads system as the agent ending the call', () => {
    expect(disconnectColumns({ hangupSource: 'system', disposition: 'completed' })).toEqual({
      reasonKey: 'voicebot_hangup',
      disconnectedBy: 'AI Assistant',
    });
  });

  /** "The dialled leg released the call" — the person, on carriers that
   *  distinguish the two legs at the switch. */
  it('reads callee as the customer too', () => {
    expect(disconnectColumns({ hangupSource: 'callee', disposition: 'completed' })).toEqual({
      reasonKey: 'user',
      disconnectedBy: 'Customer',
    });
  });

  /** Neither party ended it: the network tore it down, or an API call did.
   *  Attributed to the system, which is the bucket that means "not a party". */
  it('reads a carrier or api teardown as the system', () => {
    expect(disconnectColumns({ hangupSource: 'carrier', disposition: 'failed' })).toEqual({
      reasonKey: '',
      disconnectedBy: 'System',
    });
    expect(disconnectColumns({ hangupSource: 'api', disposition: 'completed' })).toEqual({
      reasonKey: '',
      disconnectedBy: 'System',
    });
  });

  /** The platform documents these as meaning the teardown failed or it did not
   *  recognise the carrier's value — "treat as unattributed, same as null". */
  it('treats error and unknown as unattributed, as the platform instructs', () => {
    for (const source of ['error', 'unknown']) {
      expect(disconnectColumns({ hangupSource: source, disposition: 'completed' })).toEqual({
        reasonKey: '',
        disconnectedBy: '',
      });
    }
  });

  /** Nobody picked up, so nobody hung up: the platform gave up on the call. */
  it('reads an unsourced no-answer as the system', () => {
    expect(disconnectColumns({ hangupSource: null, disposition: 'no_answer' })).toEqual({
      reasonKey: '',
      disconnectedBy: 'System',
    });
  });

  /** A call that never reached a carrier has no disconnection to attribute.
   *  The reference file leaves both columns blank on every one of its 590. */
  it('leaves both columns empty on a call that failed outright', () => {
    expect(disconnectColumns({ hangupSource: null, disposition: 'failed' })).toEqual({
      reasonKey: '',
      disconnectedBy: '',
    });
  });

  it('leaves both columns empty on a launch that never left', () => {
    expect(
      disconnectColumns({ hangupSource: null, disposition: null, launchError: 'refused' }),
    ).toEqual({ reasonKey: '', disconnectedBy: '' });
  });

  /**
   * **An unsourced call that a person answered is NOT the system's doing.**
   *
   * `hangup_source` is a PROVIDER difference, not a regression: measured on
   * 2026-09-08, `vobiz` carried one on 283 of 284 sampled calls and
   * `voicelink` on 0 of 516, with both present on 2026-08-20. This service
   * dials `voicelink` exclusively and the detail endpoint carries it no more
   * than the listing does, so this branch is not the rare fallback it was
   * written as: it is the path EVERY row takes.
   *
   * That makes over-claiming here expensive. The reference file attributes an
   * unsourced row exactly two ways — `no_answer` to the system, `failed` to
   * nobody — and contains no unsourced completed call at all, so reading
   * "somebody answered and we were not told who hung up" as "the system hung
   * up" is an extrapolation past the data onto thousands of rows. A
   * conversation ends because one of the two parties ended it; which one is
   * exactly what we no longer know.
   */
  it('does not credit the system for a conversation it was not told the end of', () => {
    expect(disconnectColumns({ hangupSource: null, disposition: 'completed' })).toEqual({
      reasonKey: '',
      disconnectedBy: '',
    });
  });

  /** Same argument: a machine picked up and somebody ended the call. Which
   *  one is unknown, and the reference file never attributes this case. */
  it('does not credit the system for an unsourced voicemail', () => {
    expect(disconnectColumns({ hangupSource: null, disposition: 'voicemail' })).toEqual({
      reasonKey: '',
      disconnectedBy: '',
    });
  });

  /** The one unsourced attribution the reference DOES make, and the only one
   *  kept: nobody picked up, so nobody hung up — the platform gave up. */
  it('still credits the system when nobody was ever on the line', () => {
    expect(disconnectColumns({ hangupSource: null, disposition: 'busy' })).toEqual({
      reasonKey: '',
      disconnectedBy: 'System',
    });
  });

  /**
   * The published vocabulary is the platform's and grows without this service
   * deploying — the same reason `disposition` is never an enum here. An
   * unrecognised source is reported as unattributed rather than bucketed into
   * whichever recognised value looks closest.
   */
  it('does not guess at a hangup source it does not recognise', () => {
    expect(
      disconnectColumns({ hangupSource: 'carrier_gateway_7', disposition: 'completed' }),
    ).toEqual({ reasonKey: '', disconnectedBy: '' });
  });
});

/**
 * The platform's `end_call_reason`: the BOT's own account of the ending, set
 * on every answered call. It is read FIRST — the bot witnessed the ending,
 * `hangup_source` was inferred per leg — and it maps onto the same four
 * combinations the reference file uses; nothing new is emitted.
 */
describe('end_call_reason', () => {
  it.each([
    ['CUSTOMER_HUNG_UP', { reasonKey: 'user', disconnectedBy: 'Customer' }],
    ['COMPLETED', { reasonKey: 'voicebot_hangup', disconnectedBy: 'AI Assistant' }],
    ['TRANSFERRED', { reasonKey: 'voicebot_hangup', disconnectedBy: 'AI Assistant' }],
    ['NO_ANSWER', { reasonKey: '', disconnectedBy: 'System' }],
    ['BUSY', { reasonKey: '', disconnectedBy: 'System' }],
    ['NETWORK_ERROR', { reasonKey: '', disconnectedBy: '' }],
    ['SYSTEM_ERROR', { reasonKey: '', disconnectedBy: '' }],
    ['UNKNOWN', { reasonKey: '', disconnectedBy: '' }],
    ['SOMETHING_NEW', { reasonKey: '', disconnectedBy: '' }],
  ])('%s', (endCallReason, expected) => {
    expect(disconnectColumns({ endCallReason, hangupSource: null, disposition: 'completed' })).toEqual(expected);
  });

  it('outranks a hangup_source that disagrees', () => {
    expect(disconnectColumns({ endCallReason: 'CUSTOMER_HUNG_UP', hangupSource: 'system', disposition: 'completed' }))
      .toEqual({ reasonKey: 'user', disconnectedBy: 'Customer' });
  });

  /**
   * A reason that says nothing about who hung up leaves the question to the
   * evidence that does — the same answer as no reason at all. Three cases the
   * platform actually produces: it derives the reason from the Q.850 cause
   * but the disposition without it, so INVALID_NUMBER arrives beside
   * `no_answer`; the listing derives UNKNOWN for every connected call before
   * it stored the bot's report; and a voicemail is never attributed.
   */
  it('a reason with no attribution falls through to the source', () => {
    expect(disconnectColumns({ endCallReason: 'UNKNOWN', hangupSource: 'caller', disposition: 'completed' }))
      .toEqual({ reasonKey: 'user', disconnectedBy: 'Customer' });
    expect(disconnectColumns({ endCallReason: 'SOMETHING_NEW', hangupSource: 'system', disposition: 'completed' }))
      .toEqual({ reasonKey: 'voicebot_hangup', disconnectedBy: 'AI Assistant' });
  });

  it('a number verdict beside a no_answer disposition still reads System, as before the reason shipped', () => {
    expect(disconnectColumns({ endCallReason: 'INVALID_NUMBER', hangupSource: null, disposition: 'no_answer' }))
      .toEqual({ reasonKey: '', disconnectedBy: 'System' });
  });

  it('VOICEMAIL and SCREENER stay unattributed, the rule the disposition path already holds', () => {
    for (const endCallReason of ['VOICEMAIL', 'SCREENER']) {
      expect(disconnectColumns({ endCallReason, hangupSource: null, disposition: 'voicemail' }))
        .toEqual({ reasonKey: '', disconnectedBy: '' });
    }
  });

  it('falls back to hangup_source on a row settled before the column existed', () => {
    expect(disconnectColumns({ endCallReason: null, hangupSource: 'system', disposition: 'completed' }))
      .toEqual({ reasonKey: 'voicebot_hangup', disconnectedBy: 'AI Assistant' });
  });

  it('a launch that never left still disconnected nothing', () => {
    expect(disconnectColumns({ endCallReason: 'COMPLETED', hangupSource: null, disposition: null, launchError: 'x' }))
      .toEqual({ reasonKey: '', disconnectedBy: '' });
  });

  it('is case-insensitive like the source', () => {
    expect(disconnectColumns({ endCallReason: 'customer_hung_up', hangupSource: null, disposition: 'completed' }))
      .toEqual({ reasonKey: 'user', disconnectedBy: 'Customer' });
  });
});
