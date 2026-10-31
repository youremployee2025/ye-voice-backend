import { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { reachedAttemptSql } from './campaignOutcomes.js';

/**
 * Where a campaign's leads landed, computed at READ time.
 *
 * ## Why nothing is stamped at resolution
 *
 * A call's answers are stored verbatim on its attempt. Which of those answers
 * is "the bucket" is the campaign's `leadBucketKey`, and it is applied every
 * time somebody looks rather than when the call resolved. That is the whole
 * feature: an operator does not know which extracted answer matters until they
 * have a few hundred of them, so the key is usually chosen *after* the calls —
 * and a stamped bucket would only ever describe calls placed after the choice.
 *
 * ## The one statement
 *
 * `DISTINCT ON` per contact for the latest reached, extracting call, a case-folded
 * grouping, and window aggregates for the totals. It is one round trip for a
 * whole page of campaigns, because the list renders a chip per row and a query
 * per row would be fifty round trips on a page that exists to load quickly —
 * the same reasoning `campaignOutcomes` gives for its three.
 */

/**
 * How many buckets a readout names. The cap is on the LIST and never on the
 * totals: a free-text key can produce a distinct answer per contact, and a
 * page of ten thousand chips is no more readable than one of forty — but a
 * `won` count that only summed the forty shown would be wrong rather than
 * short.
 *
 * Forty is the ceiling the agent editor puts on a key's pinned answers, so a
 * key whose vocabulary was actually pinned can never be truncated here.
 */
export const MAX_REPORTED_BUCKETS = 40;

/**
 * One bucket name, reduced to what makes two of them the same bucket.
 *
 * Case, and how the words were joined — nothing else. The grouping in the
 * statement below applies this same rule in SQL (it has to: the fold decides
 * the GROUP BY), and this is the copy the won-bucket matching uses, so a
 * campaign's setting and the counts beside it cannot disagree about which chip
 * it names.
 */
export function foldBucketName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
}

export interface CampaignLeadBuckets {
  /** Echoed so a reader holding only this object knows what it sorted by. */
  key: string | null;
  /** Descending by count, then by name. At most `MAX_REPORTED_BUCKETS`. */
  buckets: { name: string; count: number }[];
  /** Whether `buckets` was capped. The totals below are complete either way. */
  truncated: boolean;
  /** Contacts whose latest reached, extracting call answered the key. */
  bucketed: number;
  /** Of those, the ones whose answer is one the campaign counts as won.
   *  Summed over EVERY bucket, so the cap cannot distort it. */
  won: number;
}

interface BucketRow {
  campaign_id: string;
  name: string;
  count: number;
  distinct_buckets: number;
  bucketed: number;
  won: number;
}

export interface BucketedCampaign {
  id: string;
  leadBucketKey: string | null;
  wonBuckets: string[];
}

const nothing = (key: string | null): CampaignLeadBuckets => ({
  key,
  buckets: [],
  truncated: false,
  bucketed: 0,
  won: 0,
});

/**
 * Narrow the pick to conversations inside a window, or to all of them.
 *
 * **Optional, and omitted means lifetime** — which is what every caller
 * before the lead-analytics page wanted and still gets, byte for byte. The
 * campaign list, the detail and `/stats` all describe a campaign to date.
 *
 * A window changes what "the latest call" means: the latest conversation
 * INSIDE the window rather than the latest overall. That is the right
 * reading for a page whose other figures are window-scoped, and the wrong
 * one for a chip that answers "where does this lead stand" — so it is the
 * caller's choice rather than a default.
 */
function windowSql(range?: { from: Date; to: Date }): Prisma.Sql {
  return range
    ? Prisma.sql`AND a."startedAt" >= ${range.from} AND a."startedAt" <= ${range.to}`
    : Prisma.empty;
}

/**
 * What this readout may count, beyond the campaign and the window.
 *
 * Optional and empty by default, so every caller that predates it is
 * unchanged. The lead-analytics page passes one because its three rings are
 * drawn over a single population under a single printed denominator, and a
 * ring that ignored the lead-state filter would sit beside one half its size
 * with nothing on the card saying they disagree.
 *
 * An EXISTS rather than a join: the pick is `DISTINCT ON` over an index-
 * ordered scan, and a join here would put a second table inside the ordering
 * that index supplies.
 */
export interface BucketContactFilter {
  statuses?: readonly string[];
  createdFrom?: Date;
  createdUntil?: Date;
}

function contactSql(filter?: BucketContactFilter): Prisma.Sql {
  if (!filter) return Prisma.empty;

  const clauses: Prisma.Sql[] = [];

  if (filter.statuses?.length) {
    clauses.push(
      Prisma.sql`cc."status"::text IN (${Prisma.join([...filter.statuses])})`,
    );
  }
  if (filter.createdFrom) clauses.push(Prisma.sql`cc."createdAt" >= ${filter.createdFrom}`);
  if (filter.createdUntil) clauses.push(Prisma.sql`cc."createdAt" <= ${filter.createdUntil}`);

  if (clauses.length === 0) return Prisma.empty;

  return Prisma.sql`AND EXISTS (
    SELECT 1 FROM "CampaignContact" cc
    WHERE cc."id" = a."campaignContactId"
      AND ${Prisma.join(clauses, ' AND ')}
  )`;
}

export async function campaignLeadBuckets(
  campaigns: readonly BucketedCampaign[],
  range?: { from: Date; to: Date },
  contacts?: BucketContactFilter,
): Promise<Record<string, CampaignLeadBuckets>> {
  const answer: Record<string, CampaignLeadBuckets> = Object.fromEntries(
    campaigns.map((c) => [c.id, nothing(c.leadBucketKey)]),
  );

  // A campaign that does not bucket is not one whose leads are all unsorted —
  // it is one nobody asked the question of, and there is nothing to ask the
  // database. A page where no campaign buckets costs no query at all.
  const sorting = campaigns.filter((c) => c.leadBucketKey !== null);

  if (sorting.length === 0) return answer;

  /**
   * The per-campaign parameters, as rows rather than as a loop.
   *
   * Each campaign sorts on its OWN key and counts its OWN buckets as won, so
   * the key cannot be a single bound parameter — it varies per row of the
   * join. Folded here with `foldBucketName`, the same rule the grouping below
   * applies in SQL, so the matching works in both directions: `Hot`, `hot`,
   * `NOT INTERESTED` and `not_interested` name what they look like they name.
   */
  const wanted = Prisma.join(
    sorting.map(
      (c) => Prisma.sql`(
        ${c.id}::text,
        ${c.leadBucketKey!}::text,
        ${c.wonBuckets.map(foldBucketName)}::text[]
      )`,
    ),
  );

  const rows = await prisma.$queryRaw<BucketRow[]>`
    WITH wanted (campaign_id, bucket_key, won) AS (VALUES ${wanted}),
    /**
     * The latest call per contact that both reached a person and carried
     * extraction.
     *
     * A later dial that extracted nothing does not erase what an earlier one
     * learned — an absent extraction is no answer, not a new one — so rows
     * with a NULL column are excluded before the pick rather than after.
     *
     * A voicemail's extraction is not an answer either, and for the same
     * reason: nobody spoke on that call. The post-call model runs on every
     * settled attempt and fills in every key it was given, so a machine that
     * beeped for thirty seconds comes back graded as confidently as a
     * four-minute conversation — it has nothing to judge, so it invents. Read
     * without this predicate, a Thursday follow-up into an answering machine
     * overrode Tuesday's real conversation and the chip fell from hot to cold.
     * On the two September Touchbase campaigns that was 27 contacts of the 843
     * with a conversation, and all 82 extractions on non-reached calls there
     * were voicemails carrying an interest_level.
     *
     * A further 10 contacts (of 853 bucketed before this change) go UNBUCKETED,
     * because every extraction they have came off a voicemail. That is the
     * intended result and not a loss: nobody has ever spoken to them, so the
     * campaign has nothing to report about them, and a chip reading a grade a
     * model invented for an answering machine is indistinguishable from one a
     * person actually gave. The denominators do not move with it — the contact
     * is still on the campaign and still counted as dialled, so the panel's bar
     * comes up short by exactly the claim we withdrew.
     *
     * reachedAttemptSql rather than two literals: it is the same predicate
     * reachedContactsFilter counts a campaign's conversations over, and the
     * same one reextraction.service.ts picks a call to re-judge by — the
     * disposition list plus the platform's own answer detection, so a
     * conversation the platform labelled no_answer still speaks for its lead. That last
     * one matters — the re-extraction tool already refuses to re-grade a
     * voicemail, so before this predicate the two paths disagreed about which
     * call speaks for a contact. (No backticks in here: this comment lives
     * inside a tagged template literal, and one would end the SQL.)
     */
    latest_attempt AS (
      SELECT DISTINCT ON (a."campaignId", a."campaignContactId")
        a."campaignId"        AS campaign_id,
        a."campaignContactId" AS campaign_contact_id,
        a."extraction"        AS extraction,
        COALESCE(a."resolvedAt", a."endedAt", a."startedAt") AS ts
      FROM "CallAttempt" a
      JOIN wanted w ON w.campaign_id = a."campaignId"
      WHERE a."campaignContactId" IS NOT NULL
        AND a."extraction" IS NOT NULL
        AND ${reachedAttemptSql('a')}
        ${windowSql(range)}
        ${contactSql(contacts)}
      /*
       * Led by "campaignId" so the ORDER BY matches the partial index
       * call_attempts_campaign_extraction_idx exactly and the index supplies
       * it. (No backticks in here: this comment lives inside a tagged template
       * literal, and one would end the SQL.)
       *
       * Distinct on the pair rather than on the contact alone is the SAME
       * result — a contact belongs to exactly one campaign — but distinct on
       * the contact alone demands a global ordering the per-campaign index
       * cannot give, so the list endpoint sorted every bucketing campaign's
       * attempt history, JSONB payload and all, on each load.
       *
       * The disposition predicate above rides on top of that index rather than
       * displacing it: disposition is not a column of it, so it is applied
       * from the heap the same page the JSONB is read from, and the ordering
       * still comes from the index. Measured before and after with EXPLAIN
       * (ANALYZE, BUFFERS) on a million-attempt table (one campaign, 623 MB
       * table): the same Bitmap Index Scan on
       * call_attempts_campaign_extraction_idx either way, 3.6 ms to 2.1 ms,
       * because the predicate takes rows OUT of the sort that feeds the
       * DISTINCT ON. Extending the index with the predicate was tried and is
       * deliberately not here — it is picked when it exists but saves nothing
       * measurable, and a second index on the table the dialer writes to on
       * every attempt is a cost paid on every call to buy nothing.
       */
      ORDER BY a."campaignId", a."campaignContactId", a."attemptNo" DESC
    ),
    /*
     * The same pick over the calls the contact MADE: an inbound call is never
     * a CallAttempt, so without this stream inbound calls extract correctly
     * and count toward nothing (design section 11). Its own CTE rather than a
     * UNION under the attempt pick, so the attempt half keeps the index-aligned
     * ordering above — a union would have forced a COALESCE-timestamp sort over
     * every extracting attempt on every load, the exact cost the index exists
     * to avoid. The inbound table is small; no predicate on disposition, since
     * a call the contact placed and the agent answered is a conversation by
     * construction. (No backticks in here: a tagged template literal.)
     */
    latest_inbound AS (
      SELECT DISTINCT ON (i."campaignId", i."campaignContactId")
        i."campaignId"        AS campaign_id,
        i."campaignContactId" AS campaign_contact_id,
        i."extraction"        AS extraction,
        COALESCE(i."endedAt", i."arrivedAt") AS ts
      FROM "CampaignInboundCall" i
      JOIN wanted w ON w.campaign_id = i."campaignId"
      WHERE i."campaignContactId" IS NOT NULL
        AND i."extraction" IS NOT NULL
      ORDER BY i."campaignId", i."campaignContactId", COALESCE(i."endedAt", i."arrivedAt") DESC
    ),
    /*
     * One winner per contact across both streams, by instant. The union here
     * is over rows already reduced to one per contact per stream, so this sort
     * is over at most two rows per contact. An attempt wins an exact tie.
     */
    latest AS (
      SELECT DISTINCT ON (src.campaign_id, src.campaign_contact_id)
        src.campaign_id AS campaign_id,
        src.extraction  AS extraction
      FROM (
        SELECT campaign_id, campaign_contact_id, extraction, ts, 1 AS ord FROM latest_attempt
        UNION ALL
        SELECT campaign_id, campaign_contact_id, extraction, ts, 0 AS ord FROM latest_inbound
      ) src
      ORDER BY src.campaign_id, src.campaign_contact_id, src.ts DESC, src.ord DESC
    ),
    /**
     * That call's answer to this campaign's key. NULL when the extraction ran
     * and skipped the key, which leaves the contact unbucketed: the campaign
     * asked again and got no answer, and falling back to an older call would
     * report a lead as something the most recent conversation contradicted.
     * Blank and whitespace-only are the same absence.
     */
    answered AS (
      SELECT w.campaign_id,
             NULLIF(BTRIM(l.extraction ->> w.bucket_key), '') AS bucket
      FROM latest l
      JOIN wanted w ON w.campaign_id = l.campaign_id
    ),
    grouped AS (
      /*
       * The fold: case, and how the words were joined.
       *
       * Nothing pins a free-text key's answers, so the buckets are whatever a
       * language model wrote — and over a few thousand calls it writes the same
       * answer more than one way. LOWER() alone folded COLD and cold and left
       * NOT INTERESTED and not_interested as two chips on the same row, which
       * is not merely untidy: it halves the bucket an operator sorts on, and a
       * won list naming one spelling scored only the share that came back in
       * it.
       *
       * Underscores, hyphens and runs of whitespace all become a single space.
       * Deliberately nothing more — no stemming, no synonyms, no edit distance:
       * a rule that merged two answers a model meant differently would be worse
       * than the split, because nothing on the page would show it had happened.
       *
       * Restated character for character as foldBucketName above, which the won
       * matching uses, and a third time in the dashboard's
       * lib/campaigns/lead-buckets.ts, which decides which chip reads as won.
       * All three are pinned against the same spellings in their own tests.
       * (No backticks in here: this comment lives inside a tagged template
       * literal, and one would end the SQL.)
       */
      SELECT campaign_id,
             BTRIM(REGEXP_REPLACE(LOWER(bucket), '[\\s_-]+', ' ', 'g')) AS folded,
             -- The spelling most of these calls actually used, which is the
             -- one an operator recognises. Ties break on byte order rather
             -- than the database's linguistic collation, so the answer does
             -- not depend on the cluster's locale — and byte order puts the
             -- capitalised form first, which is the one to prefer at a tie.
             MODE() WITHIN GROUP (ORDER BY bucket COLLATE "C") AS name,
             COUNT(*)::int   AS count
      FROM answered
      WHERE bucket IS NOT NULL
      -- The same expression the projection folds on, restated because a GROUP
      -- BY cannot name a select alias. The two drifting apart is not a
      -- rendering fault: the projection would report one bucket's spelling
      -- over a group the database split, so the chips stay split while the won
      -- total below is summed over the folded key.
      GROUP BY campaign_id, BTRIM(REGEXP_REPLACE(LOWER(bucket), '[\\s_-]+', ' ', 'g'))
    ),
    ranked AS (
      SELECT g.campaign_id,
             g.name,
             g.count,
             ROW_NUMBER() OVER (
               PARTITION BY g.campaign_id ORDER BY g.count DESC, g.name ASC
             )::int AS rank,
             -- The totals, over EVERY bucket. Windowed rather than a second
             -- pass so the cap below cannot reach them.
             COUNT(*)     OVER (PARTITION BY g.campaign_id)::int AS distinct_buckets,
             SUM(g.count) OVER (PARTITION BY g.campaign_id)::int AS bucketed,
             SUM(CASE WHEN g.folded = ANY(w.won) THEN g.count ELSE 0 END)
               OVER (PARTITION BY g.campaign_id)::int AS won
      FROM grouped g
      JOIN wanted w ON w.campaign_id = g.campaign_id
    )
    SELECT campaign_id, name, count, distinct_buckets, bucketed, won
    FROM ranked
    WHERE rank <= ${MAX_REPORTED_BUCKETS}
    ORDER BY campaign_id, rank
  `;

  for (const row of rows) {
    const entry = answer[row.campaign_id];

    // A campaign that vanished between the two reads. Not an error: the row is
    // simply not on the page being drawn.
    if (!entry) continue;

    entry.buckets.push({ name: row.name, count: row.count });
    entry.bucketed = row.bucketed;
    entry.won = row.won;
    entry.truncated = row.distinct_buckets > MAX_REPORTED_BUCKETS;
  }

  return answer;
}
