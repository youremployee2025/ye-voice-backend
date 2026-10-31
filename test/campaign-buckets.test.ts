import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { as, makeAccount, makeAgent, makeWorkspace } from './helpers.js';
import { MAX_REPORTED_BUCKETS, campaignLeadBuckets } from '../src/lib/campaignBuckets.js';

/**
 * Where a campaign's leads landed, computed at READ time.
 *
 * Nothing is stamped onto a contact when a call resolves. The answer a call
 * extracted is stored verbatim on the attempt, and which of those answers is
 * "the bucket" is decided by the campaign's `leadBucketKey` every time somebody
 * looks. That is what lets an operator pick a key after the campaign has
 * finished — which is when they know which answer mattered — and see the whole
 * history sorted by it.
 *
 * Against real Postgres, because the whole computation is one statement: a
 * DISTINCT ON per contact, a case-folded grouping, and two window aggregates
 * that must not be distorted by the cap on the bucket list.
 */

let seq = 0;

async function seedCampaign(
  settings: { leadBucketKey?: string | null; wonBuckets?: string[] } = {},
) {
  seq += 1;
  const account = await makeAccount(`b${seq}${Math.random().toString(36).slice(2, 6)}`);
  const workspace = await makeWorkspace(account, `Buckets ${seq}`);
  const agent = await makeAgent(workspace, `caller${seq}`);
  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: workspace.id,
      name: `Sort ${seq}`,
      agentId: agent.id,
      leadBucketKey: settings.leadBucketKey ?? null,
      wonBuckets: settings.wonBuckets ?? [],
    },
  });

  return { account, workspace, campaign };
}

/**
 * One dial: what it extracted, and what the carrier said it came to.
 *
 * A bare extraction record is a dial somebody ANSWERED, because that is what
 * every case below is about unless it says otherwise. `voicemail()` is the
 * wrapper for the other kind, and it is deliberately verbose at the call site:
 * a fixture whose disposition is invisible is how the whole suite came to
 * assert bucketing over calls nobody had picked up.
 */
interface Dial {
  extraction: Record<string, unknown> | null;
  /** Null is a real state: the reaper's ABANDONED rows and any attempt settled
   *  before the carrier classified it carry no disposition at all. */
  disposition: string | null;
  /** The platform's answer detection, when the case is about it. */
  answeredBy?: string | null;
}

/** A dial that reached an answering machine. The post-call model still runs and
 *  still fills in every key, so an extraction here is a reading of a call on
 *  which nobody spoke. */
const voicemail = (extraction: Record<string, unknown> | null): Dial => ({
  extraction,
  disposition: 'voicemail',
});

/** A dial the carrier reported but that reached no person and extracted nothing. */
const noAnswer = (): Dial => ({ extraction: null, disposition: 'no_answer' });

const asDial = (dial: Record<string, unknown> | null | Dial): Dial =>
  dial !== null && 'extraction' in dial && 'disposition' in dial
    ? (dial as Dial)
    : { extraction: dial as Record<string, unknown> | null, disposition: 'completed' };

/**
 * One contact and its dials, each dial carrying whatever that call extracted.
 * `null` is a dial whose extraction never arrived, which is most of them.
 */
async function seedContact(
  ctx: Awaited<ReturnType<typeof seedCampaign>>,
  dials: (Record<string, unknown> | null | Dial)[],
) {
  seq += 1;
  const contact = await prisma.contact.create({
    data: { workspaceId: ctx.workspace.id, phone: `+9198765${String(10000 + seq).slice(-5)}` },
  });
  const link = await prisma.campaignContact.create({
    data: { campaignId: ctx.campaign.id, contactId: contact.id },
  });

  for (const [index, entry] of dials.entries()) {
    const { extraction, disposition, answeredBy } = asDial(entry);

    await prisma.callAttempt.create({
      data: {
        campaignId: ctx.campaign.id,
        campaignContactId: link.id,
        workspaceId: ctx.workspace.id,
        accountId: ctx.account.id,
        attemptNo: index + 1,
        status: 'COMPLETED',
        disposition,
        answeredBy: answeredBy ?? null,
        extraction: extraction ?? undefined,
      },
    });
  }

  return link;
}

const of = async (ctx: Awaited<ReturnType<typeof seedCampaign>>) =>
  (await campaignLeadBuckets([ctx.campaign]))[ctx.campaign.id]!;

beforeEach(async () => {
  await truncateAll();
});

describe('campaignLeadBuckets', () => {
  it('counts each answer the campaign’s key came back with', async () => {
    const ctx = await seedCampaign({ leadBucketKey: 'lead_stage' });
    await seedContact(ctx, [{ lead_stage: 'Hot' }]);
    await seedContact(ctx, [{ lead_stage: 'Hot' }]);
    await seedContact(ctx, [{ lead_stage: 'Cold' }]);

    expect(await of(ctx)).toMatchObject({
      key: 'lead_stage',
      buckets: [{ name: 'Hot', count: 2 }, { name: 'Cold', count: 1 }],
      bucketed: 3,
      won: 0,
      truncated: false,
    });
  });

  /** A campaign that does not bucket is not a campaign whose leads are all
   *  unsorted — it is one nobody asked the question of. No query runs. */
  it('reports nothing at all when no key is chosen', async () => {
    const ctx = await seedCampaign();
    await seedContact(ctx, [{ lead_stage: 'Hot' }]);

    expect(await of(ctx)).toEqual({
      key: null,
      buckets: [],
      bucketed: 0,
      won: 0,
      truncated: false,
    });
  });

  /**
   * The LATEST call's answer wins. A lead who was cold in March and hot in
   * August is hot: the campaign kept calling precisely because the earlier
   * answer was not the final one.
   */
  it('takes the answer from the contact’s most recent extracting call', async () => {
    const ctx = await seedCampaign({ leadBucketKey: 'lead_stage' });
    await seedContact(ctx, [{ lead_stage: 'Cold' }, { lead_stage: 'Hot' }]);

    expect((await of(ctx)).buckets).toEqual([{ name: 'Hot', count: 1 }]);
  });

  /** A later dial that extracted nothing does not erase what an earlier one
   *  learned: no extraction is an absent answer, not a new one. */
  it('ignores a later dial that carried no extraction at all', async () => {
    const ctx = await seedCampaign({ leadBucketKey: 'lead_stage' });
    await seedContact(ctx, [{ lead_stage: 'Hot' }, null]);

    expect((await of(ctx)).buckets).toEqual([{ name: 'Hot', count: 1 }]);
  });

  /**
   * An extraction that ran and did not answer THIS key is a real result and it
   * is the latest one. The contact is unbucketed rather than falling back to
   * an older call — the campaign asked again and got no answer.
   */
  it('leaves a contact unbucketed when its latest extraction skipped the key', async () => {
    const ctx = await seedCampaign({ leadBucketKey: 'lead_stage' });
    await seedContact(ctx, [{ lead_stage: 'Hot' }, { other_key: 'x' }]);

    expect(await of(ctx)).toMatchObject({ buckets: [], bucketed: 0 });
  });

  /**
   * The bug this predicate exists for.
   *
   * A voicemail is settled like any other call, so the post-call extraction
   * runs on it and the model fills in every key it was given — including the
   * one the campaign buckets on. It has nothing to judge, so it invents a
   * grade. Read without the disposition filter, a Thursday follow-up into an
   * answering machine overrode Tuesday's four-minute conversation and the chip
   * fell from `Hot` to `Cold`. Measured against production on 2026-09-06: 27 of
   * the 843 contacts on the two September Touchbase campaigns were showing a
   * voicemail's grade.
   */
  it('does not let a voicemail placed after a conversation override its answer', async () => {
    const ctx = await seedCampaign({ leadBucketKey: 'lead_stage' });
    await seedContact(ctx, [{ lead_stage: 'Hot' }, voicemail({ lead_stage: 'Cold' })]);

    expect(await of(ctx)).toMatchObject({
      buckets: [{ name: 'Hot', count: 1 }],
      bucketed: 1,
    });
  });

  /**
   * A contact we have only ever left messages for is unbucketed, which is a
   * visible change to the counts and the correct one: nobody has told us
   * anything about this lead, so the campaign has no grade to show for them.
   * An invented one is worse than an absent one — it is indistinguishable on
   * the chip from a grade somebody actually gave.
   */
  it('leaves a contact unbucketed when every extraction it has is a voicemail', async () => {
    const ctx = await seedCampaign({ leadBucketKey: 'lead_stage', wonBuckets: ['Hot'] });
    await seedContact(ctx, [voicemail({ lead_stage: 'Hot' }), voicemail({ lead_stage: 'Hot' })]);

    expect(await of(ctx)).toMatchObject({ buckets: [], bucketed: 0, won: 0 });
  });

  /** The detector saying `human` beside a voicemail is the detector disagreeing
   *  with itself; the disposition is the later, more specific verdict. Reading
   *  the detector alone here would grade the lead off a call nobody spoke on. */
  it('leaves a voicemail unbucketed even when the detector said human', async () => {
    const ctx = await seedCampaign({ leadBucketKey: 'lead_stage', wonBuckets: ['Hot'] });
    await seedContact(ctx, [{ ...voicemail({ lead_stage: 'Hot' }), answeredBy: 'human' }]);

    expect(await of(ctx)).toMatchObject({ buckets: [], bucketed: 0, won: 0 });
  });

  /** The other non-reached dispositions carry no extraction in practice, but
   *  the predicate is over the disposition and not over the payload, so a
   *  no-answer between two conversations changes nothing either way. */
  it('reads through a no-answer to the last call that reached somebody', async () => {
    const ctx = await seedCampaign({ leadBucketKey: 'lead_stage' });
    await seedContact(ctx, [{ lead_stage: 'Cold' }, { lead_stage: 'Hot' }, noAnswer()]);

    expect((await of(ctx)).buckets).toEqual([{ name: 'Hot', count: 1 }]);
  });

  /** `transferred` is the second half of `REACHED_DISPOSITIONS`: a conversation
   *  that ended somewhere else is still a conversation. */
  it('reads a transferred call, which is a conversation that ended elsewhere', async () => {
    const ctx = await seedCampaign({ leadBucketKey: 'lead_stage' });
    await seedContact(ctx, [
      { lead_stage: 'Cold' },
      { extraction: { lead_stage: 'Hot' }, disposition: 'transferred' },
    ]);

    expect((await of(ctx)).buckets).toEqual([{ name: 'Hot', count: 1 }]);
  });

  /** The platform may label a cause-16 conversation `no_answer`. Its answer
   *  detection heard the person, so the call's extraction is a reading of a
   *  conversation and speaks for the contact. */
  it('reads a call labelled no_answer when a human was on the line', async () => {
    const ctx = await seedCampaign({ leadBucketKey: 'lead_stage' });
    await seedContact(ctx, [
      { lead_stage: 'Cold' },
      { extraction: { lead_stage: 'Hot' }, disposition: 'no_answer', answeredBy: 'human' },
    ]);
    await seedContact(ctx, [
      { extraction: { lead_stage: 'Warm' }, disposition: 'no_answer', answeredBy: 'not_answered' },
    ]);

    expect((await of(ctx)).buckets).toEqual([{ name: 'Hot', count: 1 }]);
  });

  /**
   * An attempt whose disposition never arrived is not a call we know somebody
   * answered. The reaper's `ABANDONED` rows and any attempt settled before the
   * carrier classified it land here, and the rule this module already holds for
   * a missing extraction applies to a missing disposition too: an absence is
   * not an answer.
   */
  it('does not read an attempt whose disposition was never recorded', async () => {
    const ctx = await seedCampaign({ leadBucketKey: 'lead_stage' });
    await seedContact(ctx, [
      { lead_stage: 'Hot' },
      { extraction: { lead_stage: 'Cold' }, disposition: null },
    ]);

    expect((await of(ctx)).buckets).toEqual([{ name: 'Hot', count: 1 }]);
  });

  it('does not bucket a blank or whitespace-only answer', async () => {
    const ctx = await seedCampaign({ leadBucketKey: 'lead_stage' });
    await seedContact(ctx, [{ lead_stage: '' }]);
    await seedContact(ctx, [{ lead_stage: '   ' }]);
    await seedContact(ctx, [{ lead_stage: 'Hot' }]);

    expect(await of(ctx)).toMatchObject({ buckets: [{ name: 'Hot', count: 1 }], bucketed: 1 });
  });

  /**
   * A model writing the same answer twice does not capitalise it the same way
   * twice, so `Hot` and `hot` are one bucket. The name shown is the spelling
   * most of the calls actually used, with ties broken on byte order — which is
   * deterministic whatever the cluster's collation, and puts the capitalised
   * form first at a tie.
   */
  it('collapses answers that differ only in case', async () => {
    const ctx = await seedCampaign({ leadBucketKey: 'lead_stage' });
    await seedContact(ctx, [{ lead_stage: 'Hot' }]);
    await seedContact(ctx, [{ lead_stage: 'hot' }]);

    expect((await of(ctx)).buckets).toEqual([{ name: 'Hot', count: 2 }]);
  });

  it('names a collapsed bucket by the spelling most of its calls used', async () => {
    const ctx = await seedCampaign({ leadBucketKey: 'lead_stage' });
    await seedContact(ctx, [{ lead_stage: 'hot' }]);
    await seedContact(ctx, [{ lead_stage: 'hot' }]);
    await seedContact(ctx, [{ lead_stage: 'Hot' }]);

    expect((await of(ctx)).buckets).toEqual([{ name: 'hot', count: 3 }]);
  });

  /**
   * The bug on the September Touchbase campaigns: `NOT INTERESTED 64` and
   * `not_interested 26` drawn as two chips on one row.
   *
   * Nothing pinned the key's answers, so the buckets are whatever a language
   * model wrote — and across a few thousand calls it wrote the same answer
   * both ways. `LOWER()` alone folded `COLD`/`cold` and left this pair split,
   * which does not merely look untidy: it halves the bucket an operator sorts
   * on, and a `won` list naming one spelling scored only the calls that
   * happened to come back in it.
   *
   * Underscores, hyphens and runs of whitespace all fold to a single space, so
   * the four spellings a model reaches for are one bucket.
   */
  it('collapses answers that differ only in how the words are joined', async () => {
    const ctx = await seedCampaign({ leadBucketKey: 'lead_stage' });
    await seedContact(ctx, [{ lead_stage: 'NOT INTERESTED' }]);
    await seedContact(ctx, [{ lead_stage: 'not_interested' }]);
    await seedContact(ctx, [{ lead_stage: 'not-interested' }]);
    await seedContact(ctx, [{ lead_stage: 'Not  Interested' }]);

    const readout = await of(ctx);

    expect(readout.buckets).toHaveLength(1);
    expect(readout.buckets[0]!.count).toBe(4);
    expect(readout.bucketed).toBe(4);
  });

  /**
   * Two answers that are genuinely different words stay two buckets. The fold
   * is about how a phrase was joined, never about what it says — a rule that
   * quietly merged `no answer` into `no_answer_yet` would be worse than the
   * split it replaced, because nothing on the page would show it had happened.
   */
  it('keeps answers that differ in more than their joining apart', async () => {
    const ctx = await seedCampaign({ leadBucketKey: 'lead_stage' });
    await seedContact(ctx, [{ lead_stage: 'not interested' }]);
    await seedContact(ctx, [{ lead_stage: 'not interested yet' }]);

    expect((await of(ctx)).buckets).toHaveLength(2);
  });

  /** A won bucket names the answer however the operator typed it, and the
   *  count it scores is the whole folded bucket — not the share of it that
   *  came back spelled the same way. */
  it('counts the won buckets across every spelling of the same answer', async () => {
    const ctx = await seedCampaign({
      leadBucketKey: 'lead_stage',
      wonBuckets: ['Not Interested'],
    });
    await seedContact(ctx, [{ lead_stage: 'NOT INTERESTED' }]);
    await seedContact(ctx, [{ lead_stage: 'not_interested' }]);
    await seedContact(ctx, [{ lead_stage: 'Hot' }]);

    expect(await of(ctx)).toMatchObject({ won: 2, bucketed: 3 });
  });

  it('counts the won buckets without regard to case', async () => {
    const ctx = await seedCampaign({ leadBucketKey: 'lead_stage', wonBuckets: ['HOT'] });
    await seedContact(ctx, [{ lead_stage: 'Hot' }]);
    await seedContact(ctx, [{ lead_stage: 'hot' }]);
    await seedContact(ctx, [{ lead_stage: 'Cold' }]);

    expect(await of(ctx)).toMatchObject({ won: 2, bucketed: 3 });
  });

  /** An answer the model did not write as a string still sorts leads. */
  it('buckets a non-string answer by its rendered value', async () => {
    const ctx = await seedCampaign({ leadBucketKey: 'interested', wonBuckets: ['true'] });
    await seedContact(ctx, [{ interested: true }]);
    await seedContact(ctx, [{ interested: false }]);

    expect(await of(ctx)).toMatchObject({
      buckets: [{ name: 'false', count: 1 }, { name: 'true', count: 1 }],
      won: 1,
    });
  });

  /**
   * The cap is on the LIST, never on the totals. A free-text key can produce a
   * distinct answer per contact, and a page that renders ten thousand chips is
   * no more readable than one that renders forty — but a `won` count that only
   * summed the forty shown would be wrong rather than short.
   */
  it('caps the bucket list without letting the cap distort the totals', async () => {
    const ctx = await seedCampaign({ leadBucketKey: 'note', wonBuckets: ['n0'] });

    for (let i = 0; i <= MAX_REPORTED_BUCKETS; i += 1) {
      await seedContact(ctx, [{ note: `n${i}` }]);
    }

    const buckets = await of(ctx);
    expect(buckets.buckets).toHaveLength(MAX_REPORTED_BUCKETS);
    expect(buckets.truncated).toBe(true);
    expect(buckets.bucketed).toBe(MAX_REPORTED_BUCKETS + 1);
    expect(buckets.won).toBe(1);
  });

  it('answers for several campaigns at once, each on its own key', async () => {
    const first = await seedCampaign({ leadBucketKey: 'lead_stage', wonBuckets: ['Hot'] });
    const second = await seedCampaign({ leadBucketKey: 'budget' });
    await seedContact(first, [{ lead_stage: 'Hot', budget: 'high' }]);
    await seedContact(second, [{ lead_stage: 'Hot', budget: 'high' }]);

    const all = await campaignLeadBuckets([first.campaign, second.campaign]);

    expect(all[first.campaign.id]).toMatchObject({ buckets: [{ name: 'Hot', count: 1 }], won: 1 });
    expect(all[second.campaign.id]).toMatchObject({ buckets: [{ name: 'high', count: 1 }], won: 0 });
  });

  /** One campaign's calls never count toward another's, whatever they said. */
  it('never counts an attempt belonging to another campaign', async () => {
    const mine = await seedCampaign({ leadBucketKey: 'lead_stage' });
    const theirs = await seedCampaign({ leadBucketKey: 'lead_stage' });
    await seedContact(theirs, [{ lead_stage: 'Hot' }]);

    expect(await of(mine)).toMatchObject({ buckets: [], bucketed: 0 });
  });

  it('asks nothing of the database when no campaign buckets', async () => {
    const ctx = await seedCampaign();

    expect(await campaignLeadBuckets([ctx.campaign])).toEqual({
      [ctx.campaign.id]: { key: null, buckets: [], bucketed: 0, won: 0, truncated: false },
    });
  });

  it('answers an empty request with an empty result', async () => {
    expect(await campaignLeadBuckets([])).toEqual({});
  });
});

/**
 * Which key names a campaign may pick, over a whole PATCH.
 *
 * The refusal is not a validator detail here: the dashboard sends the entire
 * settings form back on every save, so a name this surface refuses is a
 * campaign that can never be edited again — not merely one that cannot adopt
 * the name today.
 */
describe('the keys a campaign may bucket on', () => {
  const app = createApp();

  async function seedForPatch(leadBucketKey: string | null) {
    seq += 1;
    const account = await makeAccount(`pk${seq}${Math.random().toString(36).slice(2, 6)}`);
    const workspace = await makeWorkspace(account, `Picker ${seq}`);
    const agent = await makeAgent(workspace, `picker${seq}`);

    await prisma.agent.update({
      where: { id: agent.id },
      data: {
        rawConfig: {
          extraction_config: {
            keys: [
              'lead_stage',
              'callback_requested_at',
              'callback_at',
              'call_outcome_vocobaseplatform',
            ].map(
              (name) => ({ name, type: 'string' }),
            ),
          },
        },
      },
    });

    const campaign = await prisma.campaign.create({
      data: {
        workspaceId: workspace.id,
        name: `Sortable ${seq}`,
        agentId: agent.id,
        status: 'RUNNING',
        leadBucketKey,
      },
    });

    return { account, workspace, campaign };
  }

  const patch = (ctx: Awaited<ReturnType<typeof seedForPatch>>, body: unknown) =>
    request(app)
      .patch(`/api/workspaces/${ctx.workspace.id}/campaigns/${ctx.campaign.id}`)
      .set(...as(ctx.account.clerkUserId, ctx.account.email))
      .send(body);

  /**
   * A campaign stored with this key was accepted before goals existed, and the
   * form that re-sends it must keep saving. This is the regression that a
   * reservation built from every reserved name introduced.
   */
  it('still saves a campaign whose stored bucket key is callback_requested_at', async () => {
    const ctx = await seedForPatch('callback_requested_at');

    const res = await patch(ctx, { leadBucketKey: 'callback_requested_at' });

    expect(res.status).toBe(200);
    expect(res.body.data.leadBucketKey).toBe('callback_requested_at');
  });

  /** One of the five call-note keys a goal campaign's agent answers with:
   *  bucketing leads on the machinery's own answer would make the readout a
   *  fact about YE rather than about the person on the phone. */
  it('refuses a key campaign goals manage', async () => {
    const ctx = await seedForPatch(null);

    const res = await patch(ctx, { leadBucketKey: 'call_outcome_vocobaseplatform' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('reserved');
  });
});

describe('campaignLeadBuckets counts inbound calls', () => {
  async function seedInbound(
    ctx: Awaited<ReturnType<typeof seedCampaign>>,
    link: Awaited<ReturnType<typeof seedContact>>,
    extraction: Record<string, unknown>,
    endedAt: Date,
  ) {
    const did = await prisma.phoneNumber.create({
      data: { did: `+9180${Math.floor(Math.random() * 1e7)}`, workspaceId: ctx.workspace.id, status: 'ASSIGNED' },
    });
    await prisma.campaignInboundCall.create({
      data: {
        campaignId: ctx.campaign.id,
        campaignContactId: link.id,
        contactId: link.contactId,
        workspaceId: ctx.workspace.id,
        phoneNumberId: did.id,
        fromNumber: '+919876543210',
        arrivedAt: endedAt,
        endedAt,
        extraction,
      },
    });
  }

  it('buckets a contact whose only extracting call was inbound', async () => {
    const ctx = await seedCampaign({ leadBucketKey: 'lead_stage' });
    const link = await seedContact(ctx, []); // no dials placed
    await seedInbound(ctx, link, { lead_stage: 'Hot' }, new Date());

    expect((await of(ctx)).buckets).toEqual([{ name: 'Hot', count: 1 }]);
  });

  it('takes the answer from the most recent call across both streams', async () => {
    const ctx = await seedCampaign({ leadBucketKey: 'lead_stage' });
    const link = await seedContact(ctx, [{ lead_stage: 'Cold' }]); // older outbound attempt
    // A later inbound call overrides it.
    await seedInbound(ctx, link, { lead_stage: 'Hot' }, new Date(Date.now() + 60_000));

    expect((await of(ctx)).buckets).toEqual([{ name: 'Hot', count: 1 }]);
  });

  it('counts an inbound call toward the won total', async () => {
    const ctx = await seedCampaign({ leadBucketKey: 'lead_stage', wonBuckets: ['hot'] });
    const link = await seedContact(ctx, []);
    await seedInbound(ctx, link, { lead_stage: 'Hot' }, new Date());

    expect((await of(ctx)).won).toBe(1);
  });
});
