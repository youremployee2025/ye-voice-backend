import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The context record writer, against the real database.
 *
 * Everything here is about *ordering*: the record is written once per attempt
 * by a queue that redelivers, so the same attempt can land twice and two
 * attempts can land out of order. The call note and the last-call line each
 * have to follow the latest ATTEMPT rather than the latest delivery, and a
 * replay has to leave the row byte-identical — which is what lets the
 * resolution read it without asking how many times it was written.
 */

import { prisma } from '../src/lib/prisma.js';
import { memoryCallTimestamp, recordAttempt } from '../src/services/goalContext.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeAgent, makeWorkspace } from './helpers.js';

let contactId: string;

beforeEach(async () => {
  await truncateAll();
  const account = await makeAccount(`gc${Math.random().toString(36).slice(2, 7)}`);
  const ws = await makeWorkspace(account, 'Ctx');
  const agent = await makeAgent(ws, 'caller');
  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: ws.id,
      name: 'G',
      agentId: agent.id,
      status: 'RUNNING',
      goalEnabled: true,
    },
  });
  const contact = await prisma.contact.create({
    data: { workspaceId: ws.id, phone: '+919000000001' },
  });
  contactId = (
    await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id, status: 'QUEUED' },
    })
  ).id;
});

afterEach(truncateAll);

const record = () =>
  prisma.campaignContactGoal.findUniqueOrThrow({ where: { campaignContactId: contactId } });

/** The seven keys as the bot answers them. Every field has a default the
 *  description asks for when there is nothing to say, so a case names only
 *  what it is about. No `callback_type` key any more — the default answers
 *  ("no" and "null") derive `callbackType: 'flexible'`, same as before. */
const said = (over: Record<string, unknown> = {}) => ({
  call_outcome_vocobaseplatform: 'incomplete',
  call_outcome_reason_vocobaseplatform: 'null',
  immediate_callback_needed_vocobaseplatform: 'no',
  immediate_callback_needed_reason_vocobaseplatform: 'null',
  callback_requested_time_vocobaseplatform: 'null',
  next_call_instructions_vocobaseplatform: 'null',
  ...over,
});

const conversation = (
  attemptNo: number,
  values: Record<string, unknown> | null,
  kind: 'fresh' | 'follow_up' = 'follow_up',
) => ({
  campaignContactId: contactId,
  attemptNo,
  kind,
  status: 'completed' as string | null,
  disposition: 'completed' as string | null,
  answeredBy: 'human' as string | null,
  extraction: values as unknown,
  callbackNote: null as string | null,
  durationSecs: 30,
});

const silence = (attemptNo: number) => ({
  ...conversation(attemptNo, null),
  disposition: 'voicemail',
  answeredBy: 'machine',
  extraction: null,
});

describe('recordAttempt', () => {
  it('writes the note, the last-call line and a log entry', async () => {
    await recordAttempt(
      conversation(
        1,
        said({
          call_outcome_reason_vocobaseplatform: 'busy at work',
          next_call_instructions_vocobaseplatform: 'Open with: "Hi Priya, is now better?" Then wait.',
        }),
        'fresh',
      ),
    );

    const r = await record();
    expect(r.memory).toBe('Open with: "Hi Priya, is now better?" Then wait.');
    expect(r.memoryAttempt).toBe(1);
    expect(r.lastCallNote).toBe('spoke, worth calling again: busy at work');
    // Nothing writes the missing line under this contract.
    expect(r.goalMissing).toBeNull();
    expect(r.attemptLog).toEqual([
      expect.objectContaining({
        attemptNo: 1,
        kind: 'fresh',
        outcome: 'incomplete',
        callbackType: 'flexible',
        callbackRequestedTime: null,
        reason: 'busy at work',
      }),
    ]);
  });

  /** The literal word "null" is what the descriptions tell the model to
   *  write when there is nothing to say, so it reads as nothing said — for
   *  the note above all, or the next call would be told to open with "null". */
  it('reads "null" as no note, and leaves the last one standing', async () => {
    await recordAttempt(
      conversation(1, said({ next_call_instructions_vocobaseplatform: 'Resume from the budget.' }), 'fresh'),
    );
    await recordAttempt(conversation(2, said({ next_call_instructions_vocobaseplatform: 'null' })));

    const r = await record();
    expect(r.memory).toBe('Resume from the budget.');
    expect(r.memoryAttempt).toBe(1);
    expect((r.attemptLog as { attemptNo: number }[]).map((e) => e.attemptNo)).toEqual([1, 2]);
  });

  /**
   * The timestamp rides on the entry rather than in a column of its own,
   * because it belongs to one attempt: `memoryCallTimestamp` reads it back
   * from the attempt that wrote the memory, and a record whose latest
   * attempt is a silence must not lend that silence's clock to the earlier
   * conversation's account.
   */
  it('keeps the call timestamp on its own attempt, and pairs it with the memory', async () => {
    await recordAttempt(
      conversation(
        1,
        said({
          next_call_instructions_vocobaseplatform: 'Dropped after the first report number.',
          call_end_timestamp_vocobaseplatform: '2026-09-02T14:30+05',
        }),
        'fresh',
      ),
    );
    await recordAttempt(silence(2));

    const r = await record();
    expect(r.memoryAttempt).toBe(1);
    expect(r.attemptLog).toEqual([
      expect.objectContaining({ attemptNo: 1, callTimestamp: '2026-09-02T14:30+05' }),
      expect.objectContaining({ attemptNo: 2, callTimestamp: null }),
    ]);
    expect(memoryCallTimestamp({ memoryAttempt: r.memoryAttempt, attemptLog: r.attemptLog }))
      .toBe('2026-09-02T14:30+05');
  });

  it('has no timestamp to carry when no attempt wrote the memory', async () => {
    await recordAttempt(silence(1));

    const r = await record();
    expect(r.memoryAttempt).toBeNull();
    expect(memoryCallTimestamp({ memoryAttempt: r.memoryAttempt, attemptLog: r.attemptLog })).toBeNull();
  });

  it('keeps the requested time raw on the entry, and renders it in the last-call line', async () => {
    await recordAttempt(
      conversation(
        1,
        said({
          callback_requested_time_vocobaseplatform: '2026-09-08T17:00+05',
        }),
        'fresh',
      ),
    );

    const r = await record();
    expect(r.lastCallNote).toBe('spoke, asked to be called back: 2026-09-08T17:00+05');
    expect(r.attemptLog).toEqual([
      expect.objectContaining({
        outcome: 'incomplete',
        callbackType: 'requested',
        callbackRequestedTime: '2026-09-08T17:00+05',
      }),
    ]);
  });

  it('a voicemail keeps the note and replaces only the last-call line', async () => {
    await recordAttempt(
      conversation(1, said({ next_call_instructions_vocobaseplatform: 'Priya.' }), 'fresh'),
    );
    await recordAttempt(silence(2));

    const r = await record();
    expect(r.memory).toBe('Priya.');
    expect(r.memoryAttempt).toBe(1);
    expect(r.lastCallNote).toBe('reached voicemail');
    expect((r.attemptLog as unknown[]).length).toBe(2);
    expect((r.attemptLog as Record<string, unknown>[])[1]).toMatchObject({
      attemptNo: 2, outcome: null, callbackType: null, callbackRequestedTime: null, reason: null,
    });
  });

  it('a voicemail the extractor wrote a note on does not overwrite the conversation', async () => {
    // The post-call model fills in every key it is given whether or not
    // anybody spoke (27 of 843 contacts on the September campaigns, PR #48),
    // so a voicemail's extraction can arrive carrying a confident next-call
    // note about a conversation that never happened. That note must not
    // replace the one the real conversation left.
    await recordAttempt(
      conversation(1, said({ next_call_instructions_vocobaseplatform: 'Priya.' }), 'fresh'),
    );
    await recordAttempt({
      ...silence(2),
      extraction: said({
        next_call_instructions_vocobaseplatform: 'PREVIOUS CALL SUMMARY: reached a voicemail greeting.',
      }),
    });

    const r = await record();
    expect(r.memory).toBe('Priya.');
    expect(r.memoryAttempt).toBe(1);
    expect(r.lastCallNote).toBe('reached voicemail');
  });

  it('a call nobody answered is not written up as a conversation', async () => {
    await recordAttempt(
      conversation(1, said({ next_call_instructions_vocobaseplatform: 'Priya.' }), 'fresh'),
    );
    await recordAttempt({
      ...conversation(2, null),
      // What the platform sends for a ring-out: the status, and nothing else.
      status: 'no_answer',
      disposition: null,
      answeredBy: null,
      extraction: null,
    });

    const r = await record();
    expect(r.memory).toBe('Priya.');
    expect(r.lastCallNote).toBe('the call was not answered');
  });

  it('records each outcome in the last-call line', async () => {
    await recordAttempt(
      conversation(1, said({ call_outcome_vocobaseplatform: 'completed', call_outcome_reason_vocobaseplatform: 'budget given' }), 'fresh'),
    );
    expect((await record()).lastCallNote).toBe('spoke, completed: budget given');

    await recordAttempt(
      conversation(2, said({ call_outcome_vocobaseplatform: 'stop', call_outcome_reason_vocobaseplatform: 'wrong number' })),
    );
    expect((await record()).lastCallNote).toBe('spoke, asked not to be called: wrong number');

    await recordAttempt(
      conversation(3, said({ immediate_callback_needed_vocobaseplatform: 'yes' })),
    );
    expect((await record()).lastCallNote).toBe('spoke, call dropped mid-conversation');

    await recordAttempt(conversation(4, { call_outcome_vocobaseplatform: 'ring me' }));
    expect((await record()).lastCallNote).toBe('spoke, but no outcome was recorded');
  });

  it('a stale redelivery cannot put an older note over a newer one', async () => {
    await recordAttempt(conversation(1, said({ next_call_instructions_vocobaseplatform: 'first' }), 'fresh'));
    await recordAttempt(conversation(2, said({ next_call_instructions_vocobaseplatform: 'second' })));
    await recordAttempt(conversation(1, said({ next_call_instructions_vocobaseplatform: 'first again' }), 'fresh'));

    const r = await record();
    expect(r.memory).toBe('second');
    expect(r.memoryAttempt).toBe(2);
    expect((r.attemptLog as { attemptNo: number }[]).map((e) => e.attemptNo)).toEqual([1, 2]);
  });

  it('a stale redelivery cannot put an older last-call line over a newer one', async () => {
    await recordAttempt(conversation(1, said({ next_call_instructions_vocobaseplatform: 'first' }), 'fresh'));
    await recordAttempt(silence(2));
    await recordAttempt(conversation(1, said({ next_call_instructions_vocobaseplatform: 'first' }), 'fresh'));

    expect((await record()).lastCallNote).toBe('reached voicemail');
  });

  it('replaying an attempt is byte-identical', async () => {
    const values = said({ call_outcome_vocobaseplatform: 'completed', next_call_instructions_vocobaseplatform: 'x' });
    await recordAttempt(conversation(1, values, 'fresh'));
    const a = await record();
    await recordAttempt(conversation(1, values, 'fresh'));
    const b = await record();

    expect({ ...b, updatedAt: null }).toEqual({ ...a, updatedAt: null });
  });

  it('the booked callback note wins the last-call line', async () => {
    await recordAttempt({
      ...conversation(1, said({ callback_requested_time_vocobaseplatform: '2026-09-08T17:00+05' }), 'fresh'),
      callbackNote: 'Tuesday 4pm',
    });

    expect((await record()).lastCallNote).toBe('spoke, asked to be called back: Tuesday 4pm');
  });
});
