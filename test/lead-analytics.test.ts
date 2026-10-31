import { beforeEach, describe, expect, it } from 'vitest';
import type { Account, Campaign, Workspace } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { leadOutcome } from '../src/services/leadAnalytics.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';

/**
 * The lead-level aggregates.
 *
 * The distinction this whole service exists for: `CallAttempt` is one row per
 * **dial**, `CampaignContact` is one row per **lead**. A lead rung four times
 * is four attempts and one lead, and every number here counts the second
 * thing. Reading the first and calling it leads is the bug this file is
 * written to catch.
 *
 * Everything runs in SQL. Nothing loads a workspace's contacts into Node.
 */

const RANGE = {
  from: new Date('2026-08-01T00:00:00.000Z'),
  to: new Date('2026-08-31T23:59:59.999Z'),
};

let counter = 0;

interface Ctx {
  account: Account;
  workspace: Workspace;
}

async function seedWorkspace(handle: string): Promise<Ctx> {
  const account = await makeAccount(handle);
  return { account, workspace: await makeWorkspace(account, handle) };
}

async function seedCampaign(ctx: Ctx, name: string): Promise<Campaign> {
  return prisma.campaign.create({ data: { workspaceId: ctx.workspace.id, name } });
}

/**
 * One lead on a campaign.
 *
 * `lastAttemptAt` is derived from the dial counters rather than passed, for
 * the reason the overview's fixtures give: the claim stamps it in the same
 * `UPDATE` that flips a contact `PENDING -> QUEUED`, and nothing clears it. A
 * fixture with a spent counter and a null `lastAttemptAt` is a row no dial
 * could have produced, and a suite built on impossible rows proves nothing.
 */
async function seedLead(
  campaign: Campaign,
  opts: {
    attempts?: number;
    status?: string;
    goalAchieved?: boolean | null;
  } = {},
) {
  counter += 1;
  const attempts = opts.attempts ?? 0;
  const status = opts.status ?? 'PENDING';

  const contact = await prisma.contact.create({
    data: {
      workspaceId: campaign.workspaceId,
      phone: `+1415555${String(counter).padStart(4, '0')}`,
    },
  });

  const dialed = attempts > 0 || status === 'COMPLETED' || status === 'FAILED';

  return prisma.campaignContact.create({
    data: {
      campaignId: campaign.id,
      contactId: contact.id,
      attempts,
      status: status as never,
      goalAchieved: opts.goalAchieved ?? null,
      lastAttemptAt: dialed ? new Date('2026-08-10T11:59:00.000Z') : null,
    },
  });
}

/** One dial against an existing lead. */
async function dial(
  ctx: Ctx,
  campaign: Campaign,
  campaignContactId: string,
  fields: {
    attemptNo?: number;
    disposition?: string | null;
    answeredBy?: string | null;
    durationSecs?: number | null;
    startedAt?: string;
    extraction?: Record<string, unknown> | null;
  } = {},
) {
  counter += 1;

  return prisma.callAttempt.create({
    data: {
      campaignId: campaign.id,
      campaignContactId,
      workspaceId: ctx.workspace.id,
      accountId: ctx.account.id,
      attemptNo: fields.attemptNo ?? 1,
      upstreamCallId: `lead_att_${counter}`,
      status: 'COMPLETED',
      disposition: fields.disposition === undefined ? 'completed' : fields.disposition,
      answeredBy: fields.answeredBy ?? null,
      durationSecs: fields.durationSecs === undefined ? 60 : fields.durationSecs,
      startedAt: new Date(fields.startedAt ?? '2026-08-10T12:00:00.000Z'),
      extraction: (fields.extraction ?? undefined) as never,
    },
  });
}

/** A lead that was reached once, carrying one extracted answer. */
async function seedBucketedLead(
  ctx: Ctx,
  campaign: Campaign,
  extraction: Record<string, unknown>,
  startedAt?: string,
) {
  const lead = await seedLead(campaign, { attempts: 1, status: 'COMPLETED' });
  await dial(ctx, campaign, lead.id, { disposition: 'completed', extraction, startedAt });

  return lead;
}

beforeEach(async () => {
  await truncateAll();
});

describe('lead totals', () => {
  it('counts leads, not dials', async () => {
    const ctx = await seedWorkspace('leadtotals');
    const campaign = await seedCampaign(ctx, 'One');

    // One lead, rung three times, reached on the third. This is the fixture
    // that separates the two denominators: a call-level count says 3, a
    // lead-level count says 1.
    const rung = await seedLead(campaign, { attempts: 3, status: 'COMPLETED' });
    await dial(ctx, campaign, rung.id, { attemptNo: 1, disposition: 'no_answer' });
    await dial(ctx, campaign, rung.id, { attemptNo: 2, disposition: 'no_answer' });
    await dial(ctx, campaign, rung.id, { attemptNo: 3, disposition: 'completed' });

    // A lead dialled once and never reached.
    const missed = await seedLead(campaign, { attempts: 1, status: 'COMPLETED' });
    await dial(ctx, campaign, missed.id, { disposition: 'no_answer' });

    // A lead never dialled at all — in the workspace, outside `attempted`.
    await seedLead(campaign);

    const result = await leadOutcome(ctx.workspace.id, { range: RANGE });

    expect(result.totals.attemptedLeads).toBe(2);
    expect(result.totals.connectedLeads).toBe(1);
    expect(result.totals.connectivity).toBeCloseTo(0.5);
  });

  it('reports connectivity as null, never zero, with nothing dialled', async () => {
    const ctx = await seedWorkspace('leadempty');
    const campaign = await seedCampaign(ctx, 'Quiet');
    await seedLead(campaign);

    const result = await leadOutcome(ctx.workspace.id, { range: RANGE });

    expect(result.totals.attemptedLeads).toBe(0);
    // The rule the whole page rests on. `0` here asserts that leads were
    // dialled and none connected, which is a different and false claim.
    expect(result.totals.connectivity).toBeNull();
  });

  it('counts a lead reached by a human answer with no disposition', async () => {
    const ctx = await seedWorkspace('leadhuman');
    const campaign = await seedCampaign(ctx, 'Human');

    const lead = await seedLead(campaign, { attempts: 1, status: 'COMPLETED' });
    // `reached` is not only a disposition allow-list: a human who answered
    // with no disposition written is reached too. Reusing REACHED_ATTEMPT
    // rather than re-deriving it is what keeps this true here.
    await dial(ctx, campaign, lead.id, { disposition: null, answeredBy: 'human' });

    const result = await leadOutcome(ctx.workspace.id, { range: RANGE });

    expect(result.totals.connectedLeads).toBe(1);
  });

  it('does not read a lead as connected on an attempt outside the window', async () => {
    const ctx = await seedWorkspace('leadwindow');
    const campaign = await seedCampaign(ctx, 'Window');

    // One lead, reached LAST month and dialled unsuccessfully THIS one. Both
    // predicates hold over the lead's attempts taken as a set, so a query
    // that puts the window and the reached test in two separate `some`
    // clauses calls this lead connected in August. It was not.
    const lead = await seedLead(campaign, { attempts: 2, status: 'COMPLETED' });
    await dial(ctx, campaign, lead.id, {
      attemptNo: 1,
      disposition: 'completed',
      startedAt: '2026-07-14T12:00:00.000Z',
    });
    await dial(ctx, campaign, lead.id, { attemptNo: 2, disposition: 'no_answer' });

    const result = await leadOutcome(ctx.workspace.id, { range: RANGE });

    expect(result.totals.attemptedLeads).toBe(1);
    expect(result.totals.connectedLeads).toBe(0);
    expect(result.totals.connectivity).toBe(0);
  });

  it('does not count another workspace’s leads', async () => {
    const mine = await seedWorkspace('leadmine');
    const theirs = await seedWorkspace('leadtheirs');
    const ours = await seedCampaign(mine, 'Ours');
    const yours = await seedCampaign(theirs, 'Yours');

    const a = await seedLead(ours, { attempts: 1, status: 'COMPLETED' });
    await dial(mine, ours, a.id, { disposition: 'completed' });

    const b = await seedLead(yours, { attempts: 1, status: 'COMPLETED' });
    await dial(theirs, yours, b.id, { disposition: 'completed' });

    const result = await leadOutcome(mine.workspace.id, { range: RANGE });

    expect(result.totals.attemptedLeads).toBe(1);
    expect(result.totals.connectedLeads).toBe(1);
  });
});

/**
 * The distributions, and the population they are drawn over.
 *
 * **Every distribution is over the CONNECTED leads**, not the attempted ones,
 * and the payload says so rather than leaving the reader to divide and find
 * out. A lead nobody reached has no interest level, no qualification and no
 * goal verdict — it has an absence of all three — so putting it in a ring
 * would draw "we never spoke to them" as a slice of how the conversations
 * went. The reference product draws the same denominator.
 */
describe('lead distributions', () => {
  it('splits lead state into settled and active over the connected leads', async () => {
    const ctx = await seedWorkspace('leadstate');
    const campaign = await seedCampaign(ctx, 'State');

    const done = await seedLead(campaign, { attempts: 1, status: 'COMPLETED' });
    await dial(ctx, campaign, done.id, { disposition: 'completed' });

    const failed = await seedLead(campaign, { attempts: 1, status: 'FAILED' });
    await dial(ctx, campaign, failed.id, { disposition: 'completed' });

    // Reached, and back on the queue for a follow-up: still active.
    const live = await seedLead(campaign, { attempts: 1, status: 'PENDING' });
    await dial(ctx, campaign, live.id, { disposition: 'completed' });

    // Reached and then removed by an operator. EXCLUDED is not settled —
    // `totalContacts` was decremented for it, so counting it as completed
    // puts this arithmetic one ahead of the campaign it describes.
    const removed = await seedLead(campaign, { attempts: 1, status: 'EXCLUDED' });
    await dial(ctx, campaign, removed.id, { disposition: 'completed' });

    // Never reached: outside every distribution on this page.
    const missed = await seedLead(campaign, { attempts: 1, status: 'COMPLETED' });
    await dial(ctx, campaign, missed.id, { disposition: 'no_answer' });

    const result = await leadOutcome(ctx.workspace.id, { range: RANGE });

    expect(result.population).toBe(4);
    expect(result.leadState).toEqual({ completed: 2, active: 2 });
  });

  it('reads a null goal as not evaluated, never as missed', async () => {
    const ctx = await seedWorkspace('leadgoal');
    const campaign = await seedCampaign(ctx, 'Goal');

    for (const goalAchieved of [true, true, false, null]) {
      const lead = await seedLead(campaign, {
        attempts: 1,
        status: 'COMPLETED',
        goalAchieved,
      });
      await dial(ctx, campaign, lead.id, { disposition: 'completed' });
    }

    const result = await leadOutcome(ctx.workspace.id, { range: RANGE });

    // Null is two real states — the campaign has no goal, or the contact has
    // not settled — and neither of them is "missed". Folding null into `no`
    // reports a campaign with no goal as having failed every lead.
    expect(result.goal).toEqual({ yes: 2, no: 1, notEvaluated: 1 });
    expect(result.totals.goalAchievedRate).toBeCloseTo(0.5);
  });

  it('reports the goal rate as null when no lead was reached', async () => {
    const ctx = await seedWorkspace('leadgoalempty');
    const campaign = await seedCampaign(ctx, 'Empty');
    const missed = await seedLead(campaign, { attempts: 1, status: 'COMPLETED' });
    await dial(ctx, campaign, missed.id, { disposition: 'no_answer' });

    const result = await leadOutcome(ctx.workspace.id, { range: RANGE });

    expect(result.population).toBe(0);
    expect(result.totals.goalAchievedRate).toBeNull();
  });

  it('partitions the qualification donut so nothing falls through', async () => {
    const ctx = await seedWorkspace('leadqual');
    const campaign = await seedCampaign(ctx, 'Qual');

    const cases: Array<{ status: string; goalAchieved: boolean | null }> = [
      { status: 'COMPLETED', goalAchieved: true },
      { status: 'COMPLETED', goalAchieved: false },
      { status: 'FAILED', goalAchieved: false },
      { status: 'COMPLETED', goalAchieved: null },
      { status: 'PENDING', goalAchieved: null },
      { status: 'PENDING', goalAchieved: true },
    ];

    for (const c of cases) {
      const lead = await seedLead(campaign, { attempts: 1, ...c });
      await dial(ctx, campaign, lead.id, { disposition: 'completed' });
    }

    const result = await leadOutcome(ctx.workspace.id, { range: RANGE });
    const q = result.qualification;

    expect(q).toEqual({ qualified: 1, notQualified: 2, inProgress: 2, notEvaluated: 1 });
    /*
      Summed against the SEEDED count, not against `result.population`.

      Both are filled from one loop over one grouped read, so comparing them
      is an identity the implementation cannot violate — the assertion would
      pass over any partition, including one that dropped a whole arm. Six is
      the number of reached leads this test created, arrived at independently
      of anything the service did with them.
    */
    expect(q.qualified + q.notQualified + q.inProgress + q.notEvaluated).toBe(cases.length);
  });
});

/**
 * The pooled interest ring.
 *
 * **This pools bucket values across campaigns keyed on DIFFERENT extraction
 * keys, which is a deliberate product decision and not an accident.** One
 * campaign's `interest_level` and another's `gbp_work_status` are questions
 * with different vocabularies, and adding their answers adds unlike things.
 * The reference product does it, the operator asked for it, and what keeps it
 * legible is that the payload names how many keys fed the ring so the card
 * can say so.
 */
describe('pooled lead interest', () => {
  async function bucketing(ctx: Ctx, name: string, key: string) {
    return prisma.campaign.create({
      data: { workspaceId: ctx.workspace.id, name, leadBucketKey: key },
    });
  }

  it('sums bucket values across campaigns with different keys', async () => {
    const ctx = await seedWorkspace('leadinterest');
    const a = await bucketing(ctx, 'A', 'interest_level');
    const b = await bucketing(ctx, 'B', 'gbp_work_status');

    await seedBucketedLead(ctx, a, { interest_level: 'hot' });
    await seedBucketedLead(ctx, a, { interest_level: 'hot' });
    await seedBucketedLead(ctx, a, { interest_level: 'cold' });
    await seedBucketedLead(ctx, b, { gbp_work_status: 'hot' });
    await seedBucketedLead(ctx, b, { gbp_work_status: 'not interested' });

    const result = await leadOutcome(ctx.workspace.id, { range: RANGE });

    expect(result.interest.distinctKeys).toBe(2);
    expect(result.interest.keys).toEqual(['gbp_work_status', 'interest_level']);
    expect(result.interest.bucketed).toBe(5);
    expect(result.interest.buckets).toEqual([
      { name: 'hot', count: 3 },
      { name: 'cold', count: 1 },
      { name: 'not interested', count: 1 },
    ]);
  });

  it('folds case and word joiners into one bucket', async () => {
    const ctx = await seedWorkspace('leadfold');
    const a = await bucketing(ctx, 'A', 'interest_level');

    // The exact split that was found in production: one answer, three
    // spellings, three chips, and a won list naming only one of them.
    await seedBucketedLead(ctx, a, { interest_level: 'NOT INTERESTED' });
    await seedBucketedLead(ctx, a, { interest_level: 'not_interested' });
    await seedBucketedLead(ctx, a, { interest_level: 'Not-Interested' });

    const result = await leadOutcome(ctx.workspace.id, { range: RANGE });

    expect(result.interest.buckets).toHaveLength(1);
    expect(result.interest.buckets[0]!.count).toBe(3);
  });

  it('ignores conversations outside the window', async () => {
    const ctx = await seedWorkspace('leadinterestwindow');
    const a = await bucketing(ctx, 'A', 'interest_level');

    await seedBucketedLead(ctx, a, { interest_level: 'hot' });
    await seedBucketedLead(ctx, a, { interest_level: 'cold' }, '2026-07-02T12:00:00.000Z');

    const result = await leadOutcome(ctx.workspace.id, { range: RANGE });

    // The tiles and the other two rings are window-scoped. A lifetime ring
    // beside them is three true numbers arranged into a false sentence.
    expect(result.interest.bucketed).toBe(1);
    expect(result.interest.buckets).toEqual([{ name: 'hot', count: 1 }]);
  });

  it('reports nothing pooled when no campaign buckets', async () => {
    const ctx = await seedWorkspace('leadnobucket');
    const plain = await seedCampaign(ctx, 'Plain');
    await seedBucketedLead(ctx, plain, { interest_level: 'hot' });

    const result = await leadOutcome(ctx.workspace.id, { range: RANGE });

    // A campaign that does not bucket is not one whose leads are all
    // unsorted — it is one nobody asked the question of.
    expect(result.interest.distinctKeys).toBe(0);
    expect(result.interest.bucketed).toBe(0);
    expect(result.interest.buckets).toEqual([]);
  });
});

describe('campaign filter', () => {
  it('narrows the distributions too, not only the totals', async () => {
    const ctx = await seedWorkspace('leadfilter');
    const kept = await seedCampaign(ctx, 'Kept');
    const dropped = await seedCampaign(ctx, 'Dropped');

    const a = await seedLead(kept, { attempts: 1, status: 'COMPLETED', goalAchieved: true });
    await dial(ctx, kept, a.id, { disposition: 'completed' });

    const b = await seedLead(dropped, { attempts: 1, status: 'COMPLETED', goalAchieved: false });
    await dial(ctx, dropped, b.id, { disposition: 'completed' });

    const result = await leadOutcome(ctx.workspace.id, {
      range: RANGE,
      campaigns: [kept.id],
    });

    expect(result.totals.attemptedLeads).toBe(1);
    expect(result.totals.connectedLeads).toBe(1);
    // The filter has to reach the rings as well as the tiles. A page whose
    // headline narrows and whose charts do not is worse than one narrowing
    // neither — the two disagree on screen with nothing saying why.
    expect(result.population).toBe(1);
    expect(result.goal).toEqual({ yes: 1, no: 0, notEvaluated: 0 });
    expect(result.leadState).toEqual({ completed: 1, active: 0 });
  });

  it('tells an absent filter apart from one that selects nothing', async () => {
    const ctx = await seedWorkspace('leademptyfilter');
    const campaign = await seedCampaign(ctx, 'One');
    const lead = await seedLead(campaign, { attempts: 1, status: 'COMPLETED' });
    await dial(ctx, campaign, lead.id, { disposition: 'completed' });

    const unfiltered = await leadOutcome(ctx.workspace.id, { range: RANGE });
    const narrowedToNothing = await leadOutcome(ctx.workspace.id, {
      range: RANGE,
      campaigns: [],
    });

    // `undefined` is "no filter named"; `[]` is "a filter that selects
    // nothing". Collapsing the second into the first hands a reader who
    // narrowed to zero campaigns every lead in the workspace.
    expect(unfiltered.totals.attemptedLeads).toBe(1);
    expect(narrowedToNothing.totals.attemptedLeads).toBe(0);
    expect(narrowedToNothing.population).toBe(0);
  });

  it('ignores a campaign id belonging to another workspace', async () => {
    const mine = await seedWorkspace('leadscopemine');
    const theirs = await seedWorkspace('leadscopetheirs');
    const ours = await seedCampaign(mine, 'Ours');
    const foreign = await seedCampaign(theirs, 'Theirs');

    const a = await seedLead(ours, { attempts: 1, status: 'COMPLETED' });
    await dial(mine, ours, a.id, { disposition: 'completed' });

    const b = await seedLead(foreign, { attempts: 1, status: 'COMPLETED' });
    await dial(theirs, foreign, b.id, { disposition: 'completed' });

    // Naming a foreign campaign narrows to nothing rather than widening the
    // read. The scope goes through the campaign's own workspaceId, so an id
    // from another tenant selects no rows however it was obtained.
    const result = await leadOutcome(mine.workspace.id, {
      range: RANGE,
      campaigns: [foreign.id],
    });

    expect(result.totals.attemptedLeads).toBe(0);
    expect(result.population).toBe(0);
  });
});
