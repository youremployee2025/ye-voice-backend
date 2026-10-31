import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

/**
 * `GET /api/workspaces/:id/campaigns/:id/analytics/buckets`.
 *
 * The endpoint the lead-buckets panel reads. Its job is to be the *complete*
 * statement a stacked bar needs: not only where the leads landed, but what the
 * rest of the track is — which contacts nobody has dialled, and the remainder
 * that were dialled and never answered the key.
 *
 * Against real Postgres. The distribution itself is one raw statement over
 * `CallAttempt.extraction`, and the two things most worth pinning here are
 * arithmetic that a mock would happily get wrong: that `won` is summed over
 * every bucket rather than the ones on screen, and that the three groups do not
 * silently overlap.
 */
vi.mock('../src/adapter/vocobase.js', () => ({
  listCalls: vi.fn(async () => ({ calls: [] })),
  getCall: vi.fn(),
  getCallRecordingUrl: vi.fn(),
  fetchRecording: vi.fn(),
  listAgents: vi.fn(),
  listVoices: vi.fn(),
  getAgent: vi.fn(),
  getAgentDocuments: vi.fn(),
  getAgentFunctions: vi.fn(),
  getAgentTools: vi.fn(),
  listPurchasedDids: vi.fn(),
}));

const { prisma } = await import('../src/lib/prisma.js');
const { createApp } = await import('../src/app.js');
const { truncateAll } = await import('./setup.js');
const { addMember, as, makeAccount, makeAgent, makeWorkspace } = await import('./helpers.js');
const { MAX_REPORTED_BUCKETS } = await import('../src/lib/campaignBuckets.js');
const { campaignAnalytics } = await import('../src/services/analytics.js');

const app = createApp();

let seq = 0;

async function seedCampaign(
  settings: { leadBucketKey?: string | null; wonBuckets?: string[] } = {},
) {
  seq += 1;
  const handle = `bkt${seq}${Math.random().toString(36).slice(2, 6)}`;
  const account = await makeAccount(handle);
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

  return { account, workspace, campaign, handle };
}

/**
 * One contact and its dials.
 *
 * The contact-level columns are set the way the **dialer** would leave them,
 * which is not the way a count of dials would:
 *
 * - `lastAttemptAt` is stamped once anything was dialled at all. The claim
 *   writes it in the same `UPDATE` as `status = 'QUEUED'`, in every lane, and
 *   nothing clears it — so it is the column that answers "has this contact been
 *   dialled", and it is what `unreached` and the funnel's `attempted` both read.
 * - `attempts` is **retries consumed**, so it is one *less* than the number of
 *   dials: the first dial spends none of it. A fixture setting it to the dial
 *   count describes a contact that was called one more time than its rows say,
 *   and — worse for what this file pins — gives a first-dial answer a counter
 *   the dialer would have left at zero, hiding the whole population these two
 *   panels used to disagree about.
 */
/**
 * One dial: what it extracted, and what the carrier said it came to.
 *
 * A bare extraction record is a dial somebody ANSWERED. Only those can carry a
 * bucket — a voicemail's extraction is the post-call model grading a call on
 * which nobody spoke — so a fixture that wants the other kind says so with
 * `voicemail()`.
 */
interface Dial {
  extraction: Record<string, unknown> | null;
  disposition: string | null;
}

const voicemail = (extraction: Record<string, unknown> | null): Dial => ({
  extraction,
  disposition: 'voicemail',
});

const asDial = (dial: Record<string, unknown> | null | Dial): Dial =>
  dial !== null && 'extraction' in dial && 'disposition' in dial
    ? (dial as Dial)
    : { extraction: dial as Record<string, unknown> | null, disposition: 'completed' };

async function seedContact(
  ctx: Awaited<ReturnType<typeof seedCampaign>>,
  dials: (Record<string, unknown> | null | Dial)[],
) {
  seq += 1;
  const contact = await prisma.contact.create({
    data: { workspaceId: ctx.workspace.id, phone: `+9198765${String(10000 + seq).slice(-5)}` },
  });
  const link = await prisma.campaignContact.create({
    data: {
      campaignId: ctx.campaign.id,
      contactId: contact.id,
      attempts: Math.max(0, dials.length - 1),
      lastAttemptAt: dials.length > 0 ? new Date('2026-08-10T11:59:00.000Z') : null,
    },
  });

  for (const [index, entry] of dials.entries()) {
    const { extraction, disposition } = asDial(entry);

    await prisma.callAttempt.create({
      data: {
        campaignId: ctx.campaign.id,
        campaignContactId: link.id,
        workspaceId: ctx.workspace.id,
        accountId: ctx.account.id,
        attemptNo: index + 1,
        status: 'COMPLETED',
        disposition,
        extraction: extraction ?? undefined,
      },
    });
  }

  return link;
}

/** A contact on the campaign that has never been dialled. */
async function seedUndialed(ctx: Awaited<ReturnType<typeof seedCampaign>>) {
  return seedContact(ctx, []);
}

const read = (ctx: Awaited<ReturnType<typeof seedCampaign>>, campaignId?: string) =>
  request(app)
    .get(`/api/workspaces/${ctx.workspace.id}/campaigns/${campaignId ?? ctx.campaign.id}/analytics/buckets`)
    .set(...as(`user_${ctx.handle}`, `${ctx.handle}@ezo.test`));

beforeEach(async () => {
  await truncateAll();
});

describe('campaign lead buckets endpoint', () => {
  describe('the distribution', () => {
    it('counts one contact per bucket, ranked by size', async () => {
      const ctx = await seedCampaign({ leadBucketKey: 'stage' });

      await seedContact(ctx, [{ stage: 'Hot' }]);
      await seedContact(ctx, [{ stage: 'Hot' }]);
      await seedContact(ctx, [{ stage: 'Hot' }]);
      await seedContact(ctx, [{ stage: 'Cold' }]);

      const res = await read(ctx).expect(200);

      expect(res.body.data.configured).toBe(true);
      expect(res.body.data.key).toBe('stage');
      expect(res.body.data.buckets).toEqual([
        { name: 'Hot', count: 3, won: false },
        { name: 'Cold', count: 1, won: false },
      ]);
      expect(res.body.data.bucketed).toBe(4);
    });

    it('reads the latest extracting call, not the latest call', async () => {
      const ctx = await seedCampaign({ leadBucketKey: 'stage' });

      // A later dial that extracted nothing is no answer, not a new one — it
      // must not erase what the second call learned.
      await seedContact(ctx, [{ stage: 'Cold' }, { stage: 'Hot' }, null]);

      const res = await read(ctx).expect(200);

      expect(res.body.data.buckets).toEqual([{ name: 'Hot', count: 1, won: false }]);
    });

    /**
     * The chart's own reading of the voicemail rule, and the reason it is worth
     * a second test rather than left to `campaignBuckets`: this panel draws
     * `bucketed` against `contacts` and `unreached`, so it is the surface where
     * losing a bucket is visible as a stacked bar coming up short. It should.
     * The contact is still on the campaign and was still dialled — what has
     * gone is the claim that we know anything about them, which we never did.
     */
    it('drops a voicemail-only contact from the buckets without moving the denominators', async () => {
      const ctx = await seedCampaign({ leadBucketKey: 'stage' });

      await seedContact(ctx, [{ stage: 'Hot' }]);
      await seedContact(ctx, [voicemail({ stage: 'Cold' })]);
      await seedContact(ctx, [{ stage: 'Hot' }, voicemail({ stage: 'Cold' })]);

      const res = await read(ctx).expect(200);

      expect(res.body.data.buckets).toEqual([{ name: 'Hot', count: 2, won: false }]);
      expect(res.body.data.bucketed).toBe(2);
      expect(res.body.data.contacts).toBe(3);
      expect(res.body.data.unreached).toBe(0);
    });

    it('folds one bucket case-insensitively', async () => {
      const ctx = await seedCampaign({ leadBucketKey: 'stage' });

      await seedContact(ctx, [{ stage: 'Hot' }]);
      await seedContact(ctx, [{ stage: 'hot' }]);

      const res = await read(ctx).expect(200);

      expect(res.body.data.buckets).toHaveLength(1);
      expect(res.body.data.buckets[0].count).toBe(2);
      expect(res.body.data.bucketed).toBe(2);
    });

    it('leaves a contact unbucketed when the extraction skipped the key', async () => {
      const ctx = await seedCampaign({ leadBucketKey: 'stage' });

      await seedContact(ctx, [{ stage: 'Hot' }]);
      // Extraction ran and matched none of its keys. A real thing the call did,
      // and not a bucket.
      await seedContact(ctx, [{ budget: 'high' }]);
      // Answered the key with whitespace, which is the same absence.
      await seedContact(ctx, [{ stage: '   ' }]);

      const res = await read(ctx).expect(200);

      expect(res.body.data.bucketed).toBe(1);
      expect(res.body.data.contacts).toBe(3);
    });
  });

  describe('won marking', () => {
    it('marks the won buckets and totals them', async () => {
      const ctx = await seedCampaign({ leadBucketKey: 'stage', wonBuckets: ['Hot', 'Warm'] });

      await seedContact(ctx, [{ stage: 'Hot' }]);
      await seedContact(ctx, [{ stage: 'Hot' }]);
      await seedContact(ctx, [{ stage: 'Warm' }]);
      await seedContact(ctx, [{ stage: 'Cold' }]);

      const res = await read(ctx).expect(200);

      const won = Object.fromEntries(
        res.body.data.buckets.map((b: { name: string; won: boolean }) => [b.name, b.won]),
      );
      expect(won).toEqual({ Hot: true, Warm: true, Cold: false });
      expect(res.body.data.won).toBe(3);
      expect(res.body.data.wonBuckets).toEqual(['Hot', 'Warm']);
    });

    it('matches a won bucket without regard to case, in both directions', async () => {
      const ctx = await seedCampaign({ leadBucketKey: 'stage', wonBuckets: ['HOT'] });

      await seedContact(ctx, [{ stage: 'hot' }]);

      const res = await read(ctx).expect(200);

      expect(res.body.data.buckets[0].won).toBe(true);
      expect(res.body.data.won).toBe(1);
    });

    it('counts nothing as won when the campaign names no won bucket', async () => {
      const ctx = await seedCampaign({ leadBucketKey: 'stage' });

      await seedContact(ctx, [{ stage: 'Hot' }]);

      const res = await read(ctx).expect(200);

      // Zero, not null: the campaign was asked and answered "none of them".
      expect(res.body.data.won).toBe(0);
      expect(res.body.data.buckets[0].won).toBe(false);
    });

    it('totals won over every bucket, including ones the list was capped before', async () => {
      const ctx = await seedCampaign({ leadBucketKey: 'stage', wonBuckets: ['rare'] });

      // Enough distinct buckets to overflow the cap, each with two contacts, so
      // the single-contact "rare" bucket ranks last and falls off the list.
      for (let i = 0; i < MAX_REPORTED_BUCKETS; i += 1) {
        await seedContact(ctx, [{ stage: `bucket-${i}` }]);
        await seedContact(ctx, [{ stage: `bucket-${i}` }]);
      }
      await seedContact(ctx, [{ stage: 'rare' }]);

      const res = await read(ctx).expect(200);

      expect(res.body.data.buckets).toHaveLength(MAX_REPORTED_BUCKETS);
      expect(res.body.data.truncated).toBe(true);
      expect(res.body.data.buckets.some((b: { name: string }) => b.name === 'rare')).toBe(false);
      // The point of the case: a won total that only summed the forty shown
      // would be wrong rather than short.
      expect(res.body.data.won).toBe(1);
      expect(res.body.data.bucketed).toBe(MAX_REPORTED_BUCKETS * 2 + 1);
    });
  });

  describe('unreached', () => {
    it('counts contacts the campaign has never dialled', async () => {
      const ctx = await seedCampaign({ leadBucketKey: 'stage' });

      await seedContact(ctx, [{ stage: 'Hot' }]);
      await seedUndialed(ctx);
      await seedUndialed(ctx);

      const res = await read(ctx).expect(200);

      expect(res.body.data.unreached).toBe(2);
      expect(res.body.data.contacts).toBe(3);
      expect(res.body.data.bucketed).toBe(1);
    });

    it('does not count a dialled contact that never answered the key', async () => {
      const ctx = await seedCampaign({ leadBucketKey: 'stage' });

      // Dialled twice, learned nothing. Reached, unbucketed, and NOT unreached
      // — it is the remainder the panel names rather than a segment.
      await seedContact(ctx, [null, null]);

      const res = await read(ctx).expect(200);

      expect(res.body.data.unreached).toBe(0);
      expect(res.body.data.bucketed).toBe(0);
      expect(res.body.data.contacts).toBe(1);
    });

    it('never lets the three groups exceed the contact count', async () => {
      const ctx = await seedCampaign({ leadBucketKey: 'stage' });

      await seedContact(ctx, [{ stage: 'Hot' }]);
      await seedContact(ctx, [null]);
      await seedUndialed(ctx);

      const { bucketed, unreached, contacts } = (await read(ctx).expect(200)).body.data;

      expect(bucketed + unreached).toBeLessThanOrEqual(contacts);
      expect(contacts - bucketed - unreached).toBe(1);
    });

    /**
     * The two panels are rendered on one screen, so they answer to each other:
     * **`unreached` is the complement of the funnel's `attempted` stage.**
     *
     * The population that breaks it is the one a campaign is trying to produce
     * — somebody who picked up the first time. No dial counter moves on that
     * contact: `attempts` is retries consumed and the settle path spends none,
     * `callbackCount` needs a booking and `followUpCount` a goal re-arm. So a
     * count of `attempts = 0` reads it as never dialled, and the analytics tab
     * says "Attempted 3" directly above "3 not yet dialled" about the same
     * three people.
     *
     * Asserted as the complement rather than as a number, because that is the
     * claim: one predicate, counted both ways.
     */
    it('agrees with the funnel about who has been dialled', async () => {
      const ctx = await seedCampaign({ leadBucketKey: 'stage' });

      // Three that answered on the first ring — one dial each, no retry spent.
      await seedContact(ctx, [{ stage: 'Hot' }]);
      await seedContact(ctx, [{ stage: 'Cold' }]);
      await seedContact(ctx, [null]);
      // Two nobody has called.
      await seedUndialed(ctx);
      await seedUndialed(ctx);

      const { unreached, contacts } = (await read(ctx).expect(200)).body.data;
      const { funnel } = (await campaignAnalytics(ctx.workspace.id, ctx.campaign.id, {
        from: new Date('2026-08-01T00:00:00.000Z'),
        to: new Date('2026-08-31T23:59:59.999Z'),
      }))!;

      expect(contacts).toBe(funnel.contacts);
      expect(unreached).toBe(funnel.contacts - funnel.attempted);
      expect(unreached).toBe(2);
    });

    it('reports unreached even when the campaign does not bucket', async () => {
      const ctx = await seedCampaign();

      await seedUndialed(ctx);
      await seedContact(ctx, [null]);

      const res = await read(ctx).expect(200);

      // The panel renders a "not configured" state, but the counts behind it are
      // still true and are what the copy quotes.
      expect(res.body.data.configured).toBe(false);
      expect(res.body.data.unreached).toBe(1);
      expect(res.body.data.contacts).toBe(2);
    });
  });

  describe('absent and mixed configuration', () => {
    it('reports a campaign that does not bucket as unconfigured, with no buckets', async () => {
      const ctx = await seedCampaign();

      await seedContact(ctx, [{ stage: 'Hot' }]);

      const res = await read(ctx).expect(200);

      expect(res.body.data).toMatchObject({
        configured: false,
        key: null,
        wonBuckets: [],
        buckets: [],
        bucketed: 0,
        won: 0,
        truncated: false,
      });
    });

    it('reports a configured campaign with no answers as configured and empty', async () => {
      const ctx = await seedCampaign({ leadBucketKey: 'stage', wonBuckets: ['Hot'] });

      await seedUndialed(ctx);

      const res = await read(ctx).expect(200);

      // The two states the panel must tell apart: this one names the key, so an
      // operator who chose the wrong one can see that they did.
      expect(res.body.data.configured).toBe(true);
      expect(res.body.data.key).toBe('stage');
      expect(res.body.data.buckets).toEqual([]);
      expect(res.body.data.contacts).toBe(1);
    });

    it('sorts on the key the campaign names, not on another key in the same extraction', async () => {
      const ctx = await seedCampaign({ leadBucketKey: 'stage' });

      await seedContact(ctx, [{ stage: 'Hot', budget: 'low' }]);
      await seedContact(ctx, [{ stage: 'Hot', budget: 'high' }]);

      const res = await read(ctx).expect(200);

      expect(res.body.data.buckets).toEqual([{ name: 'Hot', count: 2, won: false }]);
    });

    it('re-reads history when the key changes', async () => {
      const ctx = await seedCampaign({ leadBucketKey: 'stage' });

      await seedContact(ctx, [{ stage: 'Hot', budget: 'low' }]);

      await prisma.campaign.update({
        where: { id: ctx.campaign.id },
        data: { leadBucketKey: 'budget' },
      });

      const res = await read(ctx).expect(200);

      // The whole point of computing at read time: a key chosen after the calls
      // sorts the calls that already happened.
      expect(res.body.data.key).toBe('budget');
      expect(res.body.data.buckets).toEqual([{ name: 'low', count: 1, won: false }]);
    });
  });

  describe('workspace isolation', () => {
    it('404s a campaign in another workspace', async () => {
      const mine = await seedCampaign({ leadBucketKey: 'stage' });
      const theirs = await seedCampaign({ leadBucketKey: 'stage' });

      await seedContact(theirs, [{ stage: 'Hot' }]);

      const res = await read(mine, theirs.campaign.id).expect(404);

      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('404s an id that names nothing, with the same body', async () => {
      const ctx = await seedCampaign({ leadBucketKey: 'stage' });

      const foreign = await seedCampaign();
      const missing = await read(ctx, '00000000-0000-4000-8000-000000000000').expect(404);
      const other = await read(ctx, foreign.campaign.id).expect(404);

      // Indistinguishable on purpose: telling them apart would let a caller sort
      // ids into real and unreal by watching the response.
      expect(missing.body).toEqual(other.body);
    });

    it('never counts another workspace’s contacts into the totals', async () => {
      const mine = await seedCampaign({ leadBucketKey: 'stage' });
      const theirs = await seedCampaign({ leadBucketKey: 'stage' });

      await seedContact(mine, [{ stage: 'Hot' }]);
      await seedContact(theirs, [{ stage: 'Hot' }]);
      await seedContact(theirs, [{ stage: 'Hot' }]);
      await seedUndialed(theirs);

      const res = await read(mine).expect(200);

      expect(res.body.data.buckets).toEqual([{ name: 'Hot', count: 1, won: false }]);
      expect(res.body.data.contacts).toBe(1);
      expect(res.body.data.unreached).toBe(0);
    });

    it('refuses a caller who is not a member', async () => {
      const ctx = await seedCampaign({ leadBucketKey: 'stage' });
      const stranger = await makeAccount(`out${seq}${Math.random().toString(36).slice(2, 6)}`);

      // 403 rather than 404, which is the workspace guard's own choice and the
      // opposite of this route's: the workspace id came from the caller's URL
      // and a 404 there would say which workspace ids exist. The campaign id is
      // the one being probed, and that is what the 404 above protects.
      await request(app)
        .get(`/api/workspaces/${ctx.workspace.id}/campaigns/${ctx.campaign.id}/analytics/buckets`)
        .set(...as(stranger.clerkUserId, stranger.email))
        .expect(403);
    });

    it('lets a MEMBER read it, like every other analytics read', async () => {
      const ctx = await seedCampaign({ leadBucketKey: 'stage' });
      const handle = `mem${seq}${Math.random().toString(36).slice(2, 6)}`;
      const member = await makeAccount(handle);
      await addMember(ctx.workspace, member, 'MEMBER');

      await seedContact(ctx, [{ stage: 'Hot' }]);

      const res = await request(app)
        .get(`/api/workspaces/${ctx.workspace.id}/campaigns/${ctx.campaign.id}/analytics/buckets`)
        .set(...as(member.clerkUserId, member.email))
        .expect(200);

      expect(res.body.data.bucketed).toBe(1);
    });
  });
});

/**
 * The overview's campaign filter.
 *
 * Lives here rather than in `analytics-routes.test.ts` because it arrived with
 * this wave, and because its interesting cases are the two that look like
 * details and are not: an empty filter selects nothing rather than everything,
 * and a filtered page drops the non-campaign half instead of leaving it in.
 */
describe('the overview campaign filter', () => {
  const RANGE = 'from=2026-08-01&to=2026-08-31';

  const overview = (ctx: Awaited<ReturnType<typeof seedCampaign>>, query = '') =>
    request(app)
      .get(`/api/workspaces/${ctx.workspace.id}/analytics/overview?${RANGE}${query}`)
      .set(...as(`user_${ctx.handle}`, `${ctx.handle}@ezo.test`));

  /** One dial in the range, on the given campaign. */
  async function dial(ctx: Awaited<ReturnType<typeof seedCampaign>>, campaignId: string) {
    seq += 1;
    const contact = await prisma.contact.create({
      data: { workspaceId: ctx.workspace.id, phone: `+9198760${String(10000 + seq).slice(-5)}` },
    });
    const link = await prisma.campaignContact.create({
      data: { campaignId, contactId: contact.id, attempts: 1 },
    });

    await prisma.callAttempt.create({
      data: {
        campaignId,
        campaignContactId: link.id,
        workspaceId: ctx.workspace.id,
        accountId: ctx.account.id,
        attemptNo: 1,
        upstreamCallId: `flt_${seq}`,
        status: 'COMPLETED',
        disposition: 'completed',
        startedAt: new Date('2026-08-10T12:00:00.000Z'),
        durationSecs: 60,
      },
    });
  }

  /** A call this workspace placed outside any campaign. */
  async function loose(ctx: Awaited<ReturnType<typeof seedCampaign>>) {
    seq += 1;
    await prisma.callRecord.create({
      data: {
        workspaceId: ctx.workspace.id,
        upstreamCallId: `rec_${seq}`,
        startedAt: new Date('2026-08-10T12:00:00.000Z'),
        status: 'completed',
        disposition: 'completed',
        durationSecs: 60,
      } as never,
    });
  }

  it('counts every call when no filter is named', async () => {
    const ctx = await seedCampaign();
    await dial(ctx, ctx.campaign.id);
    await loose(ctx);

    const res = await overview(ctx).expect(200);

    expect(res.body.data.scope).toBe('workspace');
    expect(res.body.data.totals.calls).toBe(2);
  });

  it('narrows to the campaigns named, and drops the non-campaign half', async () => {
    const ctx = await seedCampaign();
    const other = await prisma.campaign.create({
      data: { workspaceId: ctx.workspace.id, name: 'Other', agentId: null },
    });

    await dial(ctx, ctx.campaign.id);
    await dial(ctx, other.id);
    await loose(ctx);

    const res = await overview(ctx, `&campaignId=${ctx.campaign.id}`).expect(200);

    expect(res.body.data.scope).toBe('campaigns');
    // One dial. Not two — the loose call belongs to no campaign and so can
    // never be one the filter selected.
    expect(res.body.data.totals.calls).toBe(1);
    expect(res.body.data.campaigns).toHaveLength(1);
    expect(res.body.data.series.reduce((n: number, p: { calls: number }) => n + p.calls, 0)).toBe(1);
  });

  it('accepts several campaigns at once', async () => {
    const ctx = await seedCampaign();
    const other = await prisma.campaign.create({
      data: { workspaceId: ctx.workspace.id, name: 'Other', agentId: null },
    });

    await dial(ctx, ctx.campaign.id);
    await dial(ctx, other.id);
    await loose(ctx);

    const res = await overview(
      ctx,
      `&campaignId=${ctx.campaign.id}&campaignId=${other.id}`,
    ).expect(200);

    expect(res.body.data.totals.calls).toBe(2);
    expect(res.body.data.campaigns).toHaveLength(2);
  });

  it('selects nothing for an empty filter, never everything', async () => {
    const ctx = await seedCampaign();
    await dial(ctx, ctx.campaign.id);
    await loose(ctx);

    const res = await overview(ctx, '&campaignId=').expect(200);

    // The case worth pinning: an empty list is a filter that selects nothing,
    // and reading it as "no filter" would answer a reader who narrowed to zero
    // campaigns with every call the workspace has.
    expect(res.body.data.scope).toBe('campaigns');
    expect(res.body.data.totals.calls).toBe(0);
  });

  it('404s a filter naming another workspace’s campaign', async () => {
    const mine = await seedCampaign();
    const theirs = await seedCampaign();

    await dial(mine, mine.campaign.id);

    const res = await overview(mine, `&campaignId=${theirs.campaign.id}`).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('404s rather than silently dropping one unresolvable id of several', async () => {
    const ctx = await seedCampaign();
    await dial(ctx, ctx.campaign.id);

    // Answering with two campaigns under a chip row showing three is the
    // failure: the page would be narrower than it says and nothing would tell
    // the reader.
    await overview(
      ctx,
      `&campaignId=${ctx.campaign.id}&campaignId=00000000-0000-4000-8000-000000000000`,
    ).expect(404);
  });
});
