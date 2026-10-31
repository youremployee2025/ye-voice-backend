import { beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { Campaign, CampaignContact, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';
import { runReextraction } from '../src/services/reextraction.service.js';
import type { RunOptions } from '../src/services/reextraction.service.js';
import type { ChatMessage } from '../src/lib/reextraction/messages.js';
import type { DumpResult } from '../src/lib/reextraction/dump.js';
import { ReextractionRefused, ReextractionSkip } from '../src/lib/reextraction/skip.js';

/**
 * The whole run, end to end, with the two things that leave the process
 * stubbed out.
 *
 * Everything the orchestrator decides is a decision about somebody's telephone
 * ringing, made a thousand times without a person watching: which conversations
 * a batch commits, which failure is one row's problem and which is the model
 * being down, and when to stop rather than press on. So the cases here are
 * about the seams — a fetch that throws, a batch that mostly fails, an operator
 * who says no, a campaign that goes live in the middle — rather than the happy
 * path, which is one assertion.
 *
 * `fetchDump` and `complete` are stubs by design and not by convenience: a run
 * that reached a real endpoint would be testing the endpoint's mood, and the
 * model is the one component whose answer this tool exists to replace.
 */

beforeEach(async () => {
  await truncateAll();
});

const NOW = new Date('2026-09-05T06:00:00Z');
const ENDED = new Date('2026-09-04T10:00:00Z');

/** What the old (G-era) extraction said: a stop, which is exactly what this run
 *  exists to revisit. */
const OLD_STOP = {
  call_outcome_vocobaseplatform: 'stop',
  call_outcome_reason_vocobaseplatform: 'sounded like a no',
};

const NEW_FOLLOW_UP = {
  call_outcome_vocobaseplatform: 'incomplete',
  call_outcome_reason_vocobaseplatform: 'asked to think about it',
  immediate_callback_needed_vocobaseplatform: 'no',
  immediate_callback_needed_reason_vocobaseplatform: 'call ended normally',
  next_call_instructions_vocobaseplatform: 'Ask whether the quote landed.',
};

/** Five keys, because a reply that names an outcome and little else is refused
 *  as `partial_reply`: the write is a whole-column replace. Contender I ships
 *  seven managed keys, so the floor is `Math.ceil(7 * 4 / 6) = 5`. */
const NEW_COMPLETED = {
  call_outcome_vocobaseplatform: 'completed',
  call_outcome_reason_vocobaseplatform: 'bought on the call',
  immediate_callback_needed_vocobaseplatform: null,
  immediate_callback_needed_reason_vocobaseplatform: null,
  call_end_timestamp_vocobaseplatform: '2026-09-04T10:04+05:30',
};

interface Seeded {
  ws: Workspace;
  campaign: Campaign;
  links: CampaignContact[];
  /** The number behind each contact, kept here so no case has to go back
   *  through the join to assert about a do-not-call row. */
  phones: Record<string, string>;
}

let seq = 0;

/**
 * A paused campaign whose contacts all spoke to somebody, each with one reached
 * attempt carrying a session id the dump stub answers for.
 */
async function seed(
  count: number,
  options: {
    campaign?: Partial<Campaign>;
    contact?: Partial<CampaignContact>;
    extraction?: unknown;
  } = {},
): Promise<Seeded> {
  seq += 1;
  const owner = await makeAccount(`owner${seq}`);
  const ws = await makeWorkspace(owner, `Co ${seq}`);
  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: ws.id,
      name: 'Touchbase September',
      status: 'PAUSED',
      goalEnabled: true,
      // Roomy on purpose: the seeded contacts carry `followUpCount: 2`, and
      // the planner refuses on the FOLLOW-UP budget since 2026-09-09. Left at
      // the column default of 2 every case in this file would be
      // `over_budget`. The one case that is about the refusal names its own.
      maxGoalFollowUps: 5,
      ...options.campaign,
    },
  });

  const links: CampaignContact[] = [];
  const phones: Record<string, string> = {};

  for (let index = 0; index < count; index += 1) {
    seq += 1;
    const contact = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: `+9198765${String(10000 + seq).padStart(5, '0')}` },
    });
    const link = await prisma.campaignContact.create({
      data: {
        campaignId: campaign.id,
        contactId: contact.id,
        status: 'COMPLETED',
        goalAchieved: false,
        followUpCount: 2,
        ...options.contact,
      },
    });

    await prisma.callAttempt.create({
      data: {
        campaignId: campaign.id,
        campaignContactId: link.id,
        workspaceId: ws.id,
        accountId: owner.id,
        attemptNo: 1,
        kind: 'first',
        status: 'COMPLETED',
        upstreamStatus: 'completed',
        disposition: 'completed',
        answeredBy: 'human',
        durationSecs: 84,
        upstreamCallId: `call_${link.id}`,
        upstreamSessionId: `sess_${link.id}`,
        resolvedAt: ENDED,
        extraction: (options.extraction ?? OLD_STOP) as object,
      },
    });

    links.push(link);
    phones[link.id] = contact.phone;
  }

  return { ws, campaign, links, phones };
}

/** The session a message list is about, read back out of the transcript the
 *  dump stub put in it. */
const MARK = 'this call is ';

function sessionOf(messages: ChatMessage[]): string {
  const turn = messages.find((message) => message.content.startsWith(MARK));

  if (!turn) throw new Error('stub complete: no marked turn in the messages');

  return turn.content.slice(MARK.length);
}

const dumpFor = (sessionId: string): DumpResult => ({
  transcript: [
    { role: 'assistant', content: 'Good morning, this is YE Voice AI.' },
    { role: 'customer', content: `${MARK}${sessionId}` },
  ],
  systemPrompt: 'You are calling about a quote.',
  endedAt: ENDED,
});

type Reply = unknown | (() => never);

interface Stubs {
  fetchDump: RunOptions['fetchDump'];
  complete: RunOptions['complete'];
  asked: string[];
  logged: string[];
}

/**
 * The two seams, keyed by session id so a case can make exactly one
 * conversation behave badly.
 *
 * A reply may be a value (serialised as the model would have), a string (sent
 * verbatim, for the unreadable cases), or a function that throws.
 */
function stubs(options: {
  replies?: Record<string, Reply>;
  default?: Reply;
  dumps?: Record<string, () => never>;
}): Stubs {
  const asked: string[] = [];
  const logged: string[] = [];

  const answer = (sessionId: string): string => {
    const reply = options.replies?.[sessionId] ?? options.default ?? NEW_FOLLOW_UP;

    if (typeof reply === 'function') return (reply as () => never)();

    return typeof reply === 'string' ? reply : JSON.stringify(reply);
  };

  return {
    asked,
    logged,
    fetchDump: async (sessionId: string) => {
      const thrower = options.dumps?.[sessionId];

      if (thrower) thrower();

      return dumpFor(sessionId);
    },
    complete: async (messages: ChatMessage[]) => {
      const sessionId = sessionOf(messages);

      asked.push(sessionId);

      return answer(sessionId);
    },
  };
}

const run = (
  campaignId: string,
  stub: Stubs,
  options: Partial<RunOptions> = {},
  db?: PrismaClient,
  lockSession?: PrismaClient,
) =>
  runReextraction(
    {
      campaignId,
      apply: false,
      force: false,
      concurrency: 4,
      now: NOW,
      runId: 'rx_test',
      fetchDump: stub.fetchDump,
      complete: stub.complete,
      log: (line) => stub.logged.push(line),
      ...options,
    },
    db,
    lockSession,
  );

const sessionFor = (link: CampaignContact): string => `sess_${link.id}`;

/** Everything a dry run must not have touched. */
async function snapshot(campaign: Campaign) {
  return {
    contacts: await prisma.campaignContact.findMany({
      where: { campaignId: campaign.id },
      orderBy: { id: 'asc' },
    }),
    attempts: await prisma.callAttempt.findMany({
      where: { campaignId: campaign.id },
      orderBy: { id: 'asc' },
      select: { id: true, extraction: true },
    }),
    campaign: await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } }),
    dnc: await prisma.doNotCall.findMany({ where: { campaignId: campaign.id } }),
    goals: await prisma.campaignContactGoal.findMany({}),
  };
}

const reload = (link: CampaignContact) =>
  prisma.campaignContact.findUniqueOrThrow({ where: { id: link.id } });

describe('a dry run', () => {
  it('judges every conversation and writes nothing at all', async () => {
    const { campaign, links } = await seed(3);
    const before = await snapshot(campaign);

    const report = await run(campaign.id, stubs({}));

    expect(report.rows).toHaveLength(3);
    expect(report.rows.map((row) => row.campaignContactId)).toEqual(
      [...links].map((link) => link.id).sort(),
    );
    expect(report.rows.every((row) => row.newPlan === 'follow_up')).toBe(true);
    expect(await snapshot(campaign)).toEqual(before);
  });

  it('reports the old verdict beside the new one', async () => {
    const { campaign } = await seed(1);

    const report = await run(campaign.id, stubs({}));

    expect(report.rows[0]).toMatchObject({
      oldOutcome: 'stop',
      oldCallbackType: null,
      newOutcome: 'incomplete',
      newCallbackType: 'flexible',
      oldStatus: 'COMPLETED',
      reopenedStop: true,
    });
  });

  /** The header is what an operator checks before believing anything under it,
   *  and the mode is the line that says whether it already happened. */
  it('says DRY RUN in the report it renders', async () => {
    const { campaign } = await seed(1);

    const report = await run(campaign.id, stubs({}));

    expect(report.markdown).toContain('DRY RUN');
    expect(report.markdown).toContain('Touchbase September');
    expect(report.runId).toBe('rx_test');
  });
});

describe('an applying run', () => {
  it('re-arms the contact and stamps the run on the attempt', async () => {
    const { campaign, links } = await seed(1);

    const report = await run(campaign.id, stubs({}), { apply: true });

    expect(report.rows[0]!.newPlan).toBe('follow_up');
    expect(await reload(links[0]!)).toMatchObject({
      status: 'PENDING',
      armKind: 'FOLLOW_UP',
      followUpCount: 0,
      nextEligibleAt: NOW,
    });

    const attempt = await prisma.callAttempt.findFirstOrThrow({
      where: { campaignContactId: links[0]!.id },
    });

    expect(attempt.extraction).toMatchObject({
      ...NEW_FOLLOW_UP,
      _reextractedBy: 'rx_test',
      _reextractedAt: NOW.toISOString(),
    });
  });

  it('gives the campaign back the counter a re-armed contact was counted under', async () => {
    const { campaign } = await seed(2, { campaign: { completedCount: 2 } });

    await run(campaign.id, stubs({}), { apply: true });

    expect(
      await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } }),
    ).toMatchObject({ completedCount: 0 });
  });

  /**
   * The marker is what makes a run resumable: an operator whose run died at
   * contact six hundred re-runs it, and the six hundred already judged are not
   * paid for a second time.
   */
  it('leaves the rows an earlier run already judged alone', async () => {
    const { campaign } = await seed(2);

    await run(campaign.id, stubs({}), { apply: true });
    const second = await run(campaign.id, stubs({}), { apply: true });

    expect(second.rows).toHaveLength(2);
    expect(second.rows.every((row) => row.skipReason === 'already_reextracted')).toBe(true);
    expect(second.rows.every((row) => row.newPlan === 'skipped')).toBe(true);
  });

  it('judges them again when the operator forces it', async () => {
    const { campaign } = await seed(2);

    await run(campaign.id, stubs({}), { apply: true });
    const second = await run(campaign.id, stubs({ default: NEW_COMPLETED }), {
      apply: true,
      force: true,
    });

    expect(second.rows.every((row) => row.newPlan === 'completed')).toBe(true);
  });
});

describe('a conversation that cannot be judged', () => {
  /** A dump the platform no longer has is one row's news, not the run's. */
  it('records the skip and judges the rest', async () => {
    const { campaign, links } = await seed(3);
    const lost = sessionFor(links[1]!);
    const stub = stubs({
      dumps: {
        [lost]: () => {
          throw new ReextractionSkip('session_not_found', lost);
        },
      },
    });

    const report = await run(campaign.id, stub, { apply: true });

    const skipped = report.rows.find((row) => row.campaignContactId === links[1]!.id);

    expect(skipped).toMatchObject({ newPlan: 'skipped', skipReason: 'session_not_found' });
    expect(report.rows.filter((row) => row.newPlan === 'follow_up')).toHaveLength(2);
    expect(await reload(links[1]!)).toMatchObject({ status: 'COMPLETED', armKind: 'FRESH' });
  });

  /** Three refusals, not one `unparseable`: a model answering in prose is worth
   *  a retry and a reply of the wrong shape never will be. */
  it.each([
    ['sorry, I cannot help with that', 'not_json'],
    ['[1, 2, 3]', 'not_an_object'],
    ['{"something_else": 1}', 'no_managed_keys'],
  ])('names how the reply %s was unreadable', async (reply, reason) => {
    const { campaign, links } = await seed(1);
    const stub = stubs({ replies: { [sessionFor(links[0]!)]: reply } });

    const report = await run(campaign.id, stub, { apply: true });

    expect(report.rows[0]).toMatchObject({ newPlan: 'skipped', skipReason: reason });
    expect(await reload(links[0]!)).toMatchObject({ status: 'COMPLETED' });
  });

  /** A reply with no outcome has not answered the question the run asked. */
  it('leaves a contact whose reply named no outcome exactly as it was', async () => {
    const { campaign, links } = await seed(1);
    const stub = stubs({
      replies: { [sessionFor(links[0]!)]: { call_outcome_reason_vocobaseplatform: 'unclear' } },
    });

    const report = await run(campaign.id, stub, { apply: true });

    expect(report.rows[0]!.newPlan).toBe('no_verdict');
    expect(await reload(links[0]!)).toMatchObject({ status: 'COMPLETED', followUpCount: 2 });
  });

  /**
   * An error that is not a skip is this row's, and the message only: an
   * exception from the model client can carry a URL, and a report gets pasted
   * into chats.
   */
  it('records an error on its own row and judges the rest', async () => {
    const { campaign, links } = await seed(3);
    const stub = stubs({
      replies: {
        [sessionFor(links[2]!)]: () => {
          throw new Error('socket hang up');
        },
      },
    });

    const report = await run(campaign.id, stub, { apply: true });

    expect(report.rows.find((row) => row.campaignContactId === links[2]!.id)).toMatchObject({
      newPlan: 'skipped',
      error: 'socket hang up',
    });
    expect(await reload(links[2]!)).toMatchObject({ status: 'COMPLETED' });
    expect(await reload(links[0]!)).toMatchObject({ status: 'PENDING' });
  });
});

/**
 * A batch commits as a batch. Extraction runs for every conversation in it
 * first, and only then does anything get written — so a model that dies halfway
 * through a batch leaves a batch that was judged as a whole or not at all.
 */
describe('a batch that mostly failed', () => {
  it('still applies the batch when one conversation of four failed', async () => {
    const { campaign, links } = await seed(4);
    const stub = stubs({
      replies: {
        [sessionFor(links[0]!)]: () => {
          throw new Error('socket hang up');
        },
      },
    });

    const report = await run(campaign.id, stub, { apply: true, batchSize: 4 });

    expect(report.status).toBe('completed');
    expect(report.outcome).toEqual({ kind: 'completed' });
    expect(await reload(links[1]!)).toMatchObject({ status: 'PENDING' });
    expect(await reload(links[0]!)).toMatchObject({ status: 'COMPLETED' });
  });

  /**
   * A batch of one, or the trailing batch of two a campaign of forty-one ends
   * with, is not a sample. One failure in it is one conversation's news, and
   * abandoning the run on it would have `--batch 1` stop at the first dump the
   * platform no longer has.
   */
  it('does not abandon a batch too small to say anything about the model', async () => {
    const { campaign, links } = await seed(3);
    const stub = stubs({
      replies: {
        [sessionFor(links[1]!)]: () => {
          throw new Error('socket hang up');
        },
      },
    });

    const report = await run(campaign.id, stub, { apply: true, batchSize: 1 });

    expect(report.status).toBe('completed');
    expect(
      await prisma.campaignContact.count({ where: { campaignId: campaign.id, status: 'PENDING' } }),
    ).toBe(2);
  });

  /**
   * More than half of a batch failing is not four odd conversations, it is the
   * model being down — and the plan is explicit that an outage mid-batch leaves
   * the batch untouched. So nothing is written, and the run stops rather than
   * spending an hour recording the same failure a thousand times.
   */
  it('leaves the batch unapplied and stops the run', async () => {
    const { campaign, links } = await seed(4);
    const dead = () => {
      throw new Error('502 Bad Gateway');
    };
    const stub = stubs({
      replies: {
        [sessionFor(links[0]!)]: dead,
        [sessionFor(links[1]!)]: dead,
        [sessionFor(links[2]!)]: dead,
      },
    });

    const report = await run(campaign.id, stub, { apply: true, batchSize: 4 });

    expect(report.status).toBe('stopped');
    expect(report.outcome).toEqual({ kind: 'stopped', batchNo: 1, reason: 'batch_abandoned' });
    expect(report.markdown).toContain('unapplied');
    // The one conversation that WAS judged is not applied either, and says so.
    expect(report.rows.find((row) => row.campaignContactId === links[3]!.id)).toMatchObject({
      skipReason: 'batch_abandoned',
    });
    for (const link of links) expect(await reload(link)).toMatchObject({ status: 'COMPLETED' });
  });
});

describe('batching and the operator between batches', () => {
  /** The plan's case: five conversations, two at a time, an operator who says
   *  no after the first. Exactly two rows, and a report that says so. */
  it('stops cleanly when the operator declines the next batch', async () => {
    const { campaign } = await seed(5);
    const stub = stubs({});
    const seen: number[] = [];

    const report = await run(campaign.id, stub, {
      apply: true,
      batchSize: 2,
      confirmBatch: async ({ batchNo }) => {
        seen.push(batchNo);

        return batchNo < 1;
      },
    });

    expect(seen).toEqual([1]);
    expect(report.rows).toHaveLength(2);
    expect(stub.asked).toHaveLength(2);
    expect(report.status).toBe('stopped');
    // The reason is carried rather than inferred: an operator's `no` and a
    // model outage both end a run as `stopped`, and a caller deciding an exit
    // code has to be able to tell them apart without reading the rows.
    expect(report.outcome).toEqual({ kind: 'stopped', batchNo: 1, reason: 'operator' });
    expect(report.stoppedAfterBatch).toBe(1);
    expect(report.markdown).toContain('Stopped after batch 1');
  });

  /** Rows already applied stay applied; that is what the marker is for. */
  it('keeps what the batches before the stop wrote', async () => {
    const { campaign, links } = await seed(4);

    await run(campaign.id, stubs({}), {
      apply: true,
      batchSize: 2,
      confirmBatch: async ({ batchNo }) => batchNo < 1,
    });

    const armed = await prisma.campaignContact.count({
      where: { campaignId: campaign.id, status: 'PENDING' },
    });

    expect(armed).toBe(2);
  });

  /**
   * The report is written when the run ends, and a run that is killed never
   * ends. What it leaves behind is a database with hundreds of contacts re-armed
   * and do-not-call rows deleted, and no record of which — so the batches are
   * handed over as they land and the operator's file grows with them.
   */
  it('hands each batch over as it lands, with the header in front of the first', async () => {
    const { campaign } = await seed(4);
    const fragments: string[] = [];

    await run(campaign.id, stubs({}), { batchSize: 2, onBatch: (text) => fragments.push(text) });

    expect(fragments).toHaveLength(2);
    expect(fragments[0]).toContain('Touchbase September');
    expect(fragments[0]).toContain('Batch 1');
    expect(fragments[1]).toContain('Batch 2');
    expect(fragments[1]).not.toContain('Touchbase September');
  });

  /**
   * The append is a favour to a run that might be killed, not a condition of
   * it. A full disk or a read-only path must not take the finished report —
   * and every row already written — down with it.
   */
  it('carries on when the batch could not be appended', async () => {
    const { campaign } = await seed(4);
    const stub = stubs({});
    let calls = 0;

    const report = await run(campaign.id, stub, {
      batchSize: 2,
      onBatch: () => {
        calls += 1;

        if (calls === 1) throw new Error('ENOSPC: no space left on device');

        return undefined;
      },
    });

    expect(calls).toBe(2);
    expect(report.rows).toHaveLength(4);
    expect(report.status).toBe('completed');
    expect(stub.logged.join('\n')).toContain('ENOSPC');
  });

  /**
   * The ceiling an operator sets when they do not believe the new contract yet.
   *
   * A run that reopens six hundred stops is either a contract that was badly
   * wrong before or a prompt that is badly wrong now, and the difference is not
   * visible from inside the run. Stopping at a number the operator named leaves
   * the batches already applied applied, and the rest untouched.
   */
  it('stops before applying a batch that would pass the reopened-stop ceiling', async () => {
    const { campaign } = await seed(4);

    const report = await run(campaign.id, stubs({}), {
      apply: true,
      batchSize: 2,
      maxReopenedStops: 2,
    });

    expect(report.outcome).toEqual({
      kind: 'stopped',
      batchNo: 2,
      reason: 'reopened_cap',
      reopened: 4,
      ceiling: 2,
    });
    // The numbers, in the line an operator reads first: 4 reopened against a
    // ceiling of 2 is a different decision from 3 against 2.
    expect(report.markdown).toContain('ceiling of 2');
    expect(report.markdown).toContain('4 reopened');
    expect(
      await prisma.campaignContact.count({ where: { campaignId: campaign.id, status: 'PENDING' } }),
    ).toBe(2);
    // The batch that tripped it was judged and not written, and says so.
    expect(report.rows.filter((row) => row.skipReason === 'not_applied')).toHaveLength(2);
  });

  /**
   * In a dry run nothing was going to be written, so the rows keep their
   * reopened flag: the whole point of hitting the ceiling on a dry run is to
   * SEE which contacts tripped it before deciding whether to apply.
   */
  it('keeps the reopened rows visible when the ceiling trips a dry run', async () => {
    const { campaign } = await seed(4);

    const report = await run(campaign.id, stubs({}), { batchSize: 2, maxReopenedStops: 2 });

    expect(report.outcome).toMatchObject({ reason: 'reopened_cap' });
    expect(report.rows.filter((row) => row.reopenedStop)).toHaveLength(4);
    expect(report.rows.some((row) => row.skipReason === 'not_applied')).toBe(false);
    expect(report.markdown).toContain('Dialable again (4)');
  });

  it('prints each batch and the running totals as it goes', async () => {
    const { campaign } = await seed(4);
    const stub = stubs({});

    await run(campaign.id, stub, { batchSize: 2 });

    expect(stub.logged).toHaveLength(2);
    expect(stub.logged[0]).toContain('Batch 1');
    expect(stub.logged[1]).toContain('Batch 2');
    expect(stub.logged[1]).toContain('transition:stop→incomplete');
  });

  /**
   * The order is the selection's, ascending by contact id, and it is what makes
   * a stopped run resumable. A re-sort here would be silent and would have a
   * resumed run start somewhere else, so an order that is not ascending is
   * refused rather than fixed up.
   */
  it('refuses a selection that did not arrive in contact order', async () => {
    const { campaign } = await seed(3);
    const shuffled = {
      $queryRaw: prisma.$queryRaw.bind(prisma),
      campaign: prisma.campaign,
      callAttempt: prisma.callAttempt,
      campaignContact: {
        findMany: async (args: unknown) =>
          (await prisma.campaignContact.findMany(args as never)).reverse(),
      },
    } as unknown as PrismaClient;

    await expect(run(campaign.id, stubs({}), {}, shuffled)).rejects.toThrow(ReextractionRefused);
  });
});

describe('the campaign the run is pointed at', () => {
  /** Without a readable zone the date-time line resolves "next Tuesday" against
   *  nothing, and every booking the run makes is a guess. */
  it('refuses a campaign whose timezone is not a zone', async () => {
    const { campaign } = await seed(1, { campaign: { timezone: 'Mars/Olympus' } });

    await expect(run(campaign.id, stubs({}))).rejects.toMatchObject({
      name: 'ReextractionRefused',
      reason: 'bad_timezone',
    });
  });

  /**
   * A live campaign is refused for being live, whatever else is wrong with it.
   * Reported as a bad zone, an operator fixes the zone and runs it again —
   * against the same campaign a dispatcher is still dialing from.
   */
  it('refuses a live campaign before it complains about its zone', async () => {
    const { campaign } = await seed(1, {
      campaign: { status: 'RUNNING', timezone: 'Mars/Olympus' },
    });

    await expect(run(campaign.id, stubs({}))).rejects.toMatchObject({
      reason: 'campaign_is_live',
    });
  });

  it('anchors the call in the campaign zone, or in India when it has none', async () => {
    const { campaign } = await seed(1);
    const seenPrompts: ChatMessage[][] = [];
    const stub = stubs({});
    const complete: RunOptions['complete'] = async (messages) => {
      seenPrompts.push(messages);

      return stub.complete(messages);
    };

    await run(campaign.id, { ...stub, complete });

    expect(seenPrompts[0]!.at(-1)!.content).toContain('Asia/Kolkata');
  });

  /**
   * An operator who unpauses the campaign while the run is paused between
   * batches must not have the rest of it rewritten under a dispatcher that is
   * dialing from it. The refusal comes from the write, under the lock; the run
   * ends with the report it has.
   */
  it('aborts cleanly when the campaign goes live mid-run', async () => {
    const { campaign, links } = await seed(4);
    const stub = stubs({});
    let unpaused = false;
    const complete: RunOptions['complete'] = async (messages) => {
      const answer = await stub.complete(messages);

      // The first conversation of the second batch — the two of a batch are
      // judged concurrently, so the flag rather than the count decides, or
      // whichever of them finished second would find the count already past.
      if (!unpaused && stub.asked.length > 2) {
        unpaused = true;
        await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'RUNNING' } });
      }

      return answer;
    };

    const report = await run(campaign.id, { ...stub, complete }, { apply: true, batchSize: 2 });

    expect(report.status).toBe('aborted');
    expect(report.outcome).toMatchObject({ kind: 'aborted', batchNo: 2 });
    expect(report.markdown).toContain('campaign_is_live');

    // The first batch stands; the second was refused before it wrote anything.
    expect(
      await prisma.campaignContact.count({ where: { campaignId: campaign.id, status: 'PENDING' } }),
    ).toBe(2);
  });

  /**
   * The rows a refusal left unwritten must not be reported as re-armed.
   *
   * The abort comes from a write, so everything after it in that batch was
   * judged and never applied — and a row that says `follow_up` and sits under
   * "Dialable again" is a contact an operator will believe is back in the
   * queue when its status was never touched.
   */
  it('marks the rows the refusal left unwritten, and keeps them out of the reopened list', async () => {
    const { campaign } = await seed(4);
    const stub = stubs({});
    let unpaused = false;
    const complete: RunOptions['complete'] = async (messages) => {
      const answer = await stub.complete(messages);

      if (!unpaused && stub.asked.length > 2) {
        unpaused = true;
        await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'RUNNING' } });
      }

      return answer;
    };

    const report = await run(campaign.id, { ...stub, complete }, { apply: true, batchSize: 2 });

    const unwritten = report.rows.filter((row) => row.skipReason === 'not_applied');

    expect(unwritten).toHaveLength(2);
    expect(unwritten.every((row) => row.reopenedStop === false)).toBe(true);
    expect(unwritten.every((row) => row.newPlan === 'skipped')).toBe(true);
    expect(report.markdown).toContain('Dialable again (2)');
  });

  /**
   * Asking the operator is the one call in the loop this run does not own, and
   * a stdin that is closed or interrupted throws rather than answering. Losing
   * the report to that would lose the record of every row already applied —
   * which is the one document that says which ones they were.
   */
  it('keeps the report when the confirmation prompt itself fails', async () => {
    const { campaign } = await seed(4);

    const report = await run(campaign.id, stubs({}), {
      apply: true,
      batchSize: 2,
      confirmBatch: async () => {
        throw new Error('stdin closed');
      },
    });

    expect(report.status).toBe('stopped');
    expect(report.outcome).toEqual({ kind: 'stopped', batchNo: 1, reason: 'confirm_failed' });
    expect(report.stoppedAfterBatch).toBe(1);
    expect(report.rows).toHaveLength(2);
    expect(report.markdown).toContain('could not be asked');
    expect(
      await prisma.campaignContact.count({ where: { campaignId: campaign.id, status: 'PENDING' } }),
    ).toBe(2);
  });

  /**
   * One wrong token is one fact, and it is true of every session. A run that
   * recorded it per row would walk all thousand contacts, report a thousand
   * failures and exit clean — and with `--batch 2` the majority rule that
   * abandons a batch never even fires, because a batch of two is too small to
   * read. So the refusal ends the run on the first one.
   */
  it('aborts on the first dump the token was refused, whatever the batch size', async () => {
    const { campaign, links } = await seed(4);
    const stub = stubs({
      dumps: {
        [sessionFor(links[0]!)]: () => {
          throw new ReextractionRefused('dump_unauthorized', '401');
        },
      },
    });

    const report = await run(campaign.id, stub, { apply: true, batchSize: 2 });

    expect(report.status).toBe('aborted');
    expect(report.outcome).toMatchObject({ kind: 'aborted', batchNo: 1 });
    expect(report.markdown).toContain('dump_unauthorized');
    // Nothing was applied, including the conversation of that batch that was
    // judged perfectly well.
    expect(
      await prisma.campaignContact.count({ where: { campaignId: campaign.id, status: 'PENDING' } }),
    ).toBe(0);
    expect(stub.asked.length).toBeLessThan(4);
  });

  it('reports the contacts the selection never handed over', async () => {
    const { campaign, ws } = await seed(1);
    const contact = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+919000000001' },
    });
    const removed = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id, status: 'EXCLUDED' },
    });

    const report = await run(campaign.id, stubs({}));

    expect(report.notSelected).toEqual([
      { campaignContactId: removed.id, reason: 'excluded' },
    ]);
    expect(report.totals).toMatchObject({ 'not_selected:excluded': 1 });
  });
});

/**
 * Two runs of the same campaign at once would interleave their writes on the
 * same thousand rows: the second's selection reads contacts the first has
 * already re-armed, judges them again, and both spend the campaign's counters.
 * The second is refused instead.
 */
describe('a second run of the same campaign', () => {
  it('is refused while the first still holds it', async () => {
    const { campaign } = await seed(2);
    let letGo = (): void => {};
    const held = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    let running = (): void => {};
    const started = new Promise<void>((resolve) => {
      running = resolve;
    });
    const stub = stubs({});

    const first = run(campaign.id, {
      ...stub,
      fetchDump: async (sessionId) => {
        running();
        await held;

        return stub.fetchDump(sessionId);
      },
    });

    try {
      await started;

      const second = await run(campaign.id, stubs({})).catch((error: unknown) => error);

      expect(second).toBeInstanceOf(ReextractionRefused);
      expect(second).toMatchObject({ reason: 'run_in_progress' });
    } finally {
      letGo();
      await first;
    }
  });

  /**
   * And released when it ends, however it ends.
   *
   * Asserted against `pg_locks` rather than by starting a second run: that
   * would only show the lock was released by the time the second looked, not
   * that the release itself happened rather than the session closing behind
   * it. The suite runs its files serially against one database and nothing
   * else here takes an advisory lock, so the count is this run's.
   */
  const advisoryLocks = async (): Promise<number> => {
    const [row] = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory'`;

    return Number(row?.n ?? 0);
  };

  it('lets it go when the run finishes', async () => {
    const { campaign } = await seed(1);

    await run(campaign.id, stubs({}));

    expect(await advisoryLocks()).toBe(0);
  });

  it('lets it go when the run refuses', async () => {
    const { campaign } = await seed(1, { campaign: { timezone: 'Mars/Olympus' } });

    await expect(run(campaign.id, stubs({}))).rejects.toMatchObject({ reason: 'bad_timezone' });
    expect(await advisoryLocks()).toBe(0);
  });

  /**
   * The release has to land on the SESSION that took the lock. Prisma hands
   * each query to whichever pooled connection is free, so a run whose queries
   * were spread across the pool would, without a session of its own, issue the
   * unlock on a connection that never held the lock — Postgres answers false,
   * and the lock stays with the process until it exits.
   *
   * Spread on purpose here: every dump fetch floods the pool, so a release
   * without its own session has every chance of landing elsewhere, and ten runs
   * make that stray release a near certainty rather than a coin toss.
   */
  it('lets it go from a pool that spread the run over its connections', async () => {
    for (let i = 0; i < 10; i += 1) {
      const { campaign } = await seed(1);
      const stub = stubs({});

      await run(campaign.id, {
        ...stub,
        fetchDump: async (sessionId) => {
          await Promise.all(
            Array.from({ length: 8 }, () => prisma.$queryRaw`SELECT pg_sleep(0.01)::text AS z`),
          );

          return stub.fetchDump(sessionId);
        },
      });
    }

    expect(await advisoryLocks()).toBe(0);
  }, 30_000);
});

/**
 * Releasing the lock is bookkeeping, and bookkeeping must not become the error
 * a caller sees. The run below refuses a campaign that does not exist; that is
 * the refusal the operator has to be told about, not the unlock that failed on
 * the way out.
 */
describe('a lock that will not let go', () => {
  it('does not let a failed release hide why the run ended', async () => {
    const stub = stubs({});
    const db = {
      $queryRaw: async (sql: TemplateStringsArray) => {
        if (sql.join('').includes('pg_advisory_unlock')) throw new Error('connection lost');

        return [{ locked: true }];
      },
      campaign: { findUnique: async () => null },
    } as unknown as PrismaClient;

    await expect(run('cmp_missing', stub, {}, db, db)).rejects.toMatchObject({
      reason: 'campaign_not_found',
    });
    expect(stub.logged.join('\n')).toContain('connection lost');
  });
});

/**
 * The two budgets the dispatcher's claim enforces.
 *
 * A contact re-armed past either of them is armed for a call that will never be
 * placed: the claim skips it for ever, nothing settles it, and the campaign
 * cannot finish. The run refuses to arm it and says which budget refused.
 */
describe('a contact the dispatcher would never dial again', () => {
  it('leaves a contact that has spent its follow-ups exactly as it was', async () => {
    const { campaign, links } = await seed(1, {
      campaign: { retryCount: 2, maxGoalFollowUps: 2 },
      contact: { attempts: 5, followUpCount: 2 },
    });

    const report = await run(campaign.id, stubs({}), { apply: true });

    expect(report.rows[0]).toMatchObject({
      newPlan: 'over_budget',
      skipReason: 'follow_up_budget',
      reopenedStop: false,
    });
    expect(report.totals).toMatchObject({ 'over_budget:follow_up_budget': 1 });
    expect(await reload(links[0]!)).toMatchObject({ status: 'COMPLETED', followUpCount: 2 });
    expect(
      (await prisma.callAttempt.findFirstOrThrow({ where: { campaignContactId: links[0]!.id } }))
        .extraction,
    ).toEqual(OLD_STOP);
  });

  /** The run asks the ceiling the way the claim does: a PLACED attempt at or
   *  past `retryCount + maxGoalFollowUps + 1`. Zero of each is a ceiling of
   *  one, which the seeded first dial has already spent. */
  it('leaves a contact at the dial ceiling alone', async () => {
    const { campaign, links } = await seed(1, {
      campaign: { retryCount: 0, maxGoalFollowUps: 0 },
      contact: { followUpCount: 0 },
    });

    const report = await run(campaign.id, stubs({}), { apply: true });

    expect(report.rows[0]).toMatchObject({
      newPlan: 'over_budget',
      skipReason: 'dial_budget',
    });
    expect(await reload(links[0]!)).toMatchObject({ status: 'COMPLETED' });
  });

  /** Reported, but never as a contact that is back: nothing was written for it
   *  and the dispatcher would not dial it if it had been. */
  it('keeps it out of the reopened stops that are dialable again', async () => {
    // The ceiling here is 1 + 2 + 1 = 4, well clear of the seeded first dial,
    // so the refusal below is the FOLLOW-UP budget and not the ceiling — the
    // two clauses are separate and this case is about the first.
    const { campaign } = await seed(1, {
      campaign: { retryCount: 1, maxGoalFollowUps: 2 },
      contact: { attempts: 4, followUpCount: 2 },
    });

    const report = await run(campaign.id, stubs({}), { apply: true });

    expect(report.markdown).toContain('No stop was reopened');
    expect(report.markdown).toContain('over_budget:follow_up_budget');
  });

  /** A promise spends no budget, which is the claim's own exemption. It is NOT
   *  exempt from the dial ceiling, so the budget is left with room. */
  it('still books a promise for a contact that has spent its follow-ups', async () => {
    const { campaign, links } = await seed(1, {
      campaign: { retryCount: 1, maxGoalFollowUps: 2 },
      contact: { attempts: 4, followUpCount: 2 },
    });
    const stub = stubs({
      default: {
        call_outcome_vocobaseplatform: 'incomplete',
        call_outcome_reason_vocobaseplatform: 'asked for Tuesday',
        immediate_callback_needed_vocobaseplatform: 'no',
        immediate_callback_needed_reason_vocobaseplatform: 'call ended normally',
        callback_requested_time_vocobaseplatform: '2026-09-08T10:00+05:30',
      },
    });

    const report = await run(campaign.id, stub, { apply: true });

    expect(report.rows[0]!.newPlan).toBe('callback');
    expect(await reload(links[0]!)).toMatchObject({ status: 'PENDING', armKind: 'CALLBACK' });
  });
});

/**
 * A reopened `stop` that is still on the do-not-call list is not dialable: the
 * re-arm deletes only the row this contact's own verdict created, and the next
 * dispatcher sweep excludes it again on any other. The report has to say which,
 * per contact, or an operator unpauses a campaign believing it is re-armed.
 */
describe('whether a reopened stop is actually dialable', () => {
  it('is dialable once its own row is gone', async () => {
    const { campaign, links, phones } = await seed(1);
    await prisma.doNotCall.create({
      data: {
        campaignId: campaign.id,
        phone: phones[links[0]!.id]!,
        reason: 'G said stop',
        sourceCampaignContactId: links[0]!.id,
      },
    });

    const report = await run(campaign.id, stubs({}), { apply: true });

    expect(report.rows[0]).toMatchObject({ reopenedStop: true, stillListed: false });
    expect(await prisma.doNotCall.count({ where: { campaignId: campaign.id } })).toBe(0);
  });

  /** What the row said before it was deleted, kept in the report: the run has
   *  just thrown away a reason somebody wrote, and putting it back by hand is
   *  otherwise a reason nobody has any more. */
  it('records the do-not-call row it deleted', async () => {
    const { campaign, links, phones } = await seed(1);
    await prisma.doNotCall.create({
      data: {
        campaignId: campaign.id,
        phone: phones[links[0]!.id]!,
        reason: 'G said stop',
        sourceCampaignContactId: links[0]!.id,
      },
    });

    const report = await run(campaign.id, stubs({}), { apply: true });

    expect(report.rows[0]!.deletedDoNotCall).toMatchObject({
      reason: 'G said stop',
      sourceCampaignContactId: links[0]!.id,
    });
    expect(report.markdown).toContain('G said stop');
  });

  it('is still listed when another source wrote the row', async () => {
    const { campaign, links, phones } = await seed(1);
    const phone = phones[links[0]!.id]!;
    await prisma.doNotCall.create({
      data: { campaignId: campaign.id, phone, reason: 'uploaded opt-out list' },
    });

    const report = await run(campaign.id, stubs({}), { apply: true });

    expect(report.rows[0]).toMatchObject({ reopenedStop: true, stillListed: true });
    expect(report.markdown).toContain('Reopened but still listed (1)');
  });

  /** A dry run must reach the same answer without deleting anything, so the
   *  row this contact's own stop wrote is discounted rather than removed. */
  it('answers the same in a dry run, without touching the row', async () => {
    const { campaign, links, phones } = await seed(1);
    const phone = phones[links[0]!.id]!;
    await prisma.doNotCall.create({
      data: {
        campaignId: campaign.id,
        phone,
        reason: 'G said stop',
        sourceCampaignContactId: links[0]!.id,
      },
    });

    const report = await run(campaign.id, stubs({}));

    expect(report.rows[0]).toMatchObject({ stillListed: false });
    expect(await prisma.doNotCall.count({ where: { campaignId: campaign.id } })).toBe(1);
  });
});
