import { campaignLeadBuckets } from '../lib/campaignBuckets.js';
import { prisma } from '../lib/prisma.js';

/**
 * Where one campaign's leads landed, as the analytics surface reads it.
 *
 * A thin composition rather than a new computation: `campaignLeadBuckets`
 * already derives membership at read time out of `CallAttempt.extraction`, and
 * this adds the two denominators a *chart* needs and a chip does not — how many
 * contacts the campaign holds, and how many of them it has never dialled.
 *
 * **Why those two and not more.** A stacked bar has to reach the end of its
 * track or it is lying about its own scale, so the reader has to be told what
 * the rest of it is. Three groups make up a campaign's contacts:
 *
 * 1. contacts whose latest reached, extracting call answered the bucket key —
 *    the buckets themselves;
 * 2. contacts nobody has dialled yet — `unreached`, which is an absence and is
 *    drawn as one rather than as another bucket;
 * 3. the remainder: dialled, but no answer to the key. A person who did not
 *    pick up, a conversation that never reached the question, an extraction
 *    that ran and skipped it.
 *
 * The third is not returned as a field because it is not a fact of its own —
 * it is `contacts - bucketed - unreached`, and returning it as well would give
 * a caller two numbers that can disagree after a concurrent dial.
 *
 * **`unreached` is "never dialled", not "never connected".** It counts contacts
 * with **no `lastAttemptAt`**, which is exactly the complement of the funnel's
 * `attempted` stage on the same campaign's analytics tab — the two panels
 * render together, so one predicate is counted both ways rather than two
 * predicates being kept in step by hand. It is the same column
 * `HAS_BEEN_DIALED_SQL` (`campaignQueue.ts`) reads for `/stats`' `waiting`
 * split and the campaign list's `outcomes` bar, so all four agree by
 * construction. A contact dialled five times that
 * never picked up is *reached* by this definition and falls in the remainder
 * above; calling it unreached would need the connectedness rule, which is a JS
 * classification over free carrier text, restated in SQL as a third copy.
 *
 * **Not `attempts = 0`, which this used to count and which cannot answer the
 * question.** `attempts` is retries CONSUMED: the settle path never increments
 * it, so a contact that answers its first dial and finishes carries zero — as
 * does one that booked a callback (`callbackCount`) or was re-armed by a goal
 * (`followUpCount`). Read that way, the panel called a campaign's *successes*
 * people nobody had rung, and printed "N not yet dialled" beside a funnel
 * saying it had attempted them. `lastAttemptAt` is stamped by the claim in the
 * same `UPDATE` as `status = 'QUEUED'`, in every lane, and never cleared, so it
 * is the one column present on every contact any dial touched.
 */
export interface CampaignBucketReport {
  campaign: { id: string; name: string };
  /** Whether this campaign sorts its leads at all. */
  configured: boolean;
  /** The extraction key it sorts by; null when it does not sort. */
  key: string | null;
  /** As stored, so the panel can mark a bucket won without re-deriving it. */
  wonBuckets: string[];
  /** Descending by count, then by name. Capped; the totals below are not. */
  buckets: { name: string; count: number; won: boolean }[];
  /** Whether `buckets` was capped. */
  truncated: boolean;
  /** Contacts whose latest reached, extracting call answered `key`. */
  bucketed: number;
  /** Of those, the ones in a bucket this campaign counts as won. */
  won: number;
  /** Contacts the campaign has never dialled. */
  unreached: number;
  /** Every contact on the campaign. The denominator for all of the above. */
  contacts: number;
}

/**
 * The report, or `null` when the campaign is not this workspace's.
 *
 * Null rather than a thrown 404, following `campaignAnalytics`: the route owns
 * the wording, and a foreign campaign, an unmapped id and pure nonsense all
 * arrive here as the same answer — which is what stops the endpoint being used
 * to sort ids into real and unreal.
 *
 * No range parameter. Which bucket a lead is in is a fact about the campaign's
 * whole history, and a range-scoped bucket chart would answer "how did the
 * leads we happened to call this month divide", which is a different and much
 * less useful question than the one the panel asks.
 */
export async function campaignBucketReport(
  workspaceId: string,
  campaignId: string,
): Promise<CampaignBucketReport | null> {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, workspaceId },
    select: { id: true, name: true, leadBucketKey: true, wonBuckets: true },
  });

  if (!campaign) return null;

  const [distribution, contacts, unreached] = await Promise.all([
    campaignLeadBuckets([campaign]),
    prisma.campaignContact.count({ where: { campaignId: campaign.id } }),
    // The complement of the funnel's `attempted`, counted off the same column
    // so the two panels on one screen cannot say different things about the
    // same people. `lastAttemptAt` and not the attempt rows: a dial the
    // platform refused is stamped here and may leave no usable row behind it,
    // and a contact that was tried and refused has not been left alone.
    prisma.campaignContact.count({ where: { campaignId: campaign.id, lastAttemptAt: null } }),
  ]);

  const leads = distribution[campaign.id]!;

  /**
   * Matched case-insensitively, in both directions.
   *
   * The stored list is free text and so is the answer a language model wrote,
   * so `Hot` and `hot` are one bucket — the same rule the SQL folds on, kept
   * identical here because the two disagreeing would mark a bucket won in the
   * total and not in the legend row beside it.
   */
  const won = new Set(campaign.wonBuckets.map((name) => name.trim().toLowerCase()));

  return {
    campaign: { id: campaign.id, name: campaign.name },
    configured: campaign.leadBucketKey !== null,
    key: campaign.leadBucketKey,
    wonBuckets: campaign.wonBuckets,
    buckets: leads.buckets.map((bucket) => ({
      ...bucket,
      won: won.has(bucket.name.trim().toLowerCase()),
    })),
    truncated: leads.truncated,
    bucketed: leads.bucketed,
    won: leads.won,
    unreached,
    contacts,
  };
}
