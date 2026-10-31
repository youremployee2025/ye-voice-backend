import { Prisma, type CampaignContactStatus } from '@prisma/client';
import { prisma } from './prisma.js';
import type { CampaignInboundOutcomes } from './campaignInboundStats.js';
import { HAS_BEEN_DIALED_SQL } from './campaignQueue.js';

/**
 * What a campaign's contacts came to.
 *
 * ## Why the dispositions are zero-filled, and why unknown ones are still
 * counted
 *
 * The platform reports a disposition as free text and the published set grows
 * without this service deploying. Two rules follow from that, and they pull in
 * opposite directions: the stats page needs a **fixed** set of rows or it
 * reflows every time a carrier is added, and no contact may be dropped merely
 * because its outcome postdates this deployment. So the canonical nine are
 * seeded at zero and anything else is counted under `settledUnknown` — visible,
 * labelled, and never silently missing from the total.
 */

/**
 * The nine outcomes the platform documents.
 *
 * Not an enum in the database, deliberately: the column holds whatever the
 * carrier said. This list is a display contract, not a constraint.
 */
export const CANONICAL_DISPOSITIONS = [
  'completed',
  'transferred',
  'voicemail',
  'user_hangup_no_speech',
  'no_answer',
  'busy',
  'canceled',
  'blocked',
  'failed',
] as const;

/**
 * The two dispositions that mean a person was on the line.
 *
 * A tier over the list above rather than a second list of its own:
 * `transferred` is a conversation that ended somewhere else and `completed` is
 * one that ended with us, while every other canonical value is a phone that
 * rang out, a machine, or a wall. It lives here, beside the vocabulary it
 * selects from, so a caller asking "did this dial reach anybody" reads the
 * same two literals the display contract does rather than writing them out
 * again somewhere the next carrier value will not reach.
 *
 * Deliberately NOT `dialOutcome`'s `reachedAPerson`. That one classifies a
 * live outcome from three fields at resolution time in order to decide whether
 * a phone rings again; this is a filter over the disposition column as it was
 * stored, which is the only fact a later reader of a settled attempt has.
 *
 * **Restated on the dashboard as `DISPOSITION_TIERS.reached`.** One is a Prisma
 * `where` and the other groups a payload already sent, so there is no module
 * both can import; each side pins this list BY NAME in its own test
 * (`analytics-service.test.ts` here, `campaign-presentation.test.ts` there), so
 * a tier edited on one side fails that side's suite instead of silently drawing
 * a percentage that disagrees with the bar beside it.
 *
 * **On `CampaignContact.disposition` this list answers a narrower question
 * than it looks like it does**, and the difference has bitten twice. That
 * column is the LAST dial's outcome, rewritten by every resolution — so a lead
 * that had a real conversation and was later followed up into a voicemail
 * stops carrying `completed` altogether, and the re-arm paths copy the
 * disposition onto rows still mid-journey, which puts an unqualified count
 * ahead of the outcome bar. Pair it with `SETTLED_STATUSES` and the first
 * problem gets worse rather than better: the gate drops every contact the goal
 * follow-up re-armed, which on a running campaign is most of the ones it has
 * spoken to.
 *
 * So a readout of **how many leads this campaign has talked to** does not come
 * from that column at all. It comes from `reachedContactsFilter`, below, over
 * the attempts themselves. This list still filters the column where the
 * question really is "what did this contact's last dial come to" — the outcome
 * bar and the `/stats` disposition groups, which partition contacts by current
 * state on purpose.
 */
export const REACHED_DISPOSITIONS = ['completed', 'transferred'] as const;

/**
 * The platform's answer-detection verdict that a person was on the line.
 *
 * Read beside the disposition on every attempt-level "did this call reach
 * somebody" question, because the platform has said Q.850 cause 16 — normal
 * clearing, how a real conversation usually ends — will map to `no_answer`.
 * If that mapping is not gated on the call having connected, thousands of
 * ninety-second human calls a week arrive labelled as silences, and a
 * `reached` count read off the label alone would drop every one of them while
 * the dialer (which reads the same evidence in `dialOutcome.ts`) keeps them.
 * A label describes the ending; the detector heard the connection.
 *
 * Case-insensitive on both halves: the attempt row stores the platform's text
 * verbatim, and `Human` must not be a second, invisible value.
 */
export const REACHED_ANSWERED_BY = 'human';

/**
 * The labels the detector overrules: the ones that assert the call never
 * landed, and a missing one (a cause-16 payload may carry `status: no_answer`
 * and no disposition at all). **Not** `voicemail` or `user_hangup_no_speech`
 * — a voicemail beside `human` is the detector disagreeing with itself and
 * the disposition is the later, more specific verdict; a pick-up nobody spoke
 * on is not a conversation — and not `blocked`, a verdict on the number. The
 * same set `classifyAttempt` overrides on and `settledDisposition` writes
 * from, so the reached count, the analytics bucket, the lead buckets and the
 * contact's own disposition cannot come to disagree. Reading the detector
 * alone here would put a voicemail's invented extraction back into the lead
 * buckets, which is exactly what PR #48 took out.
 */
export const NEVER_CONNECTED_LABELS = ['no_answer', 'busy', 'failed'] as const;

/**
 * One attempt that reached a person, as a `CallAttempt` where-filter: the
 * carrier's own conversation dispositions, OR the detector hearing a human
 * whatever the label says. The SQL twin is `reachedAttemptSql`; both are
 * generated here so the stats count, the analytics report, the bucket panel
 * and the re-extraction picker cannot come to disagree about which calls were
 * conversations.
 */
export const REACHED_ATTEMPT: Prisma.CallAttemptWhereInput = {
  OR: [
    { disposition: { in: [...REACHED_DISPOSITIONS] } },
    {
      answeredBy: { equals: REACHED_ANSWERED_BY, mode: 'insensitive' },
      OR: [{ disposition: null }, { disposition: { in: [...NEVER_CONNECTED_LABELS] } }],
    },
  ],
};

/** The SQL half of `REACHED_ATTEMPT`, against a `CallAttempt` alias the caller names. */
export function reachedAttemptSql(alias: string): Prisma.Sql {
  const a = Prisma.raw(`"${alias}"`);

  return Prisma.sql`(${a}."disposition" IN (${Prisma.join([...REACHED_DISPOSITIONS])}) OR (LOWER(${a}."answeredBy") = ${REACHED_ANSWERED_BY} AND (${a}."disposition" IS NULL OR ${a}."disposition" IN (${Prisma.join([...NEVER_CONNECTED_LABELS])}))))`;
}

/**
 * The leads a campaign has actually had a conversation with.
 *
 * A `CampaignContact` filter, matching a contact that has **at least one**
 * attempt whose own disposition is in `REACHED_DISPOSITIONS`. Three properties
 * follow, and each is a bug that reached production without it:
 *
 * - **It counts contacts, not calls.** A lead rung four times and reached
 *   three of them is one lead. The funnel's `connected` stage is the other
 *   reading and is labelled as calls for exactly this reason.
 * - **It is monotonic.** Nothing a later dial does can un-hold a conversation
 *   that happened, where the count off `CampaignContact.disposition` went DOWN
 *   when a follow-up landed in voicemail. A campaign report whose headline
 *   figure falls while the campaign works is a report nobody can act on.
 * - **It is evidenced rather than asserted.** The claim is carried by an
 *   attempt row the dialer wrote, not by a column a backfill could set.
 *
 * Expressed as a relation `some` rather than a `COUNT(DISTINCT ...)`: Prisma
 * compiles it to an `EXISTS` against `@@index([campaignContactId])`, so it
 * stays one statement and needs no raw SQL to keep the disposition list in one
 * place.
 *
 * **`EXCLUDED` contacts are counted, deliberately.** An operator removing
 * somebody does not un-say what was said to them, and every denominator this
 * figure is drawn over — the analytics funnel's `contacts`, `/stats`' `total`
 * — counts `CampaignContact` rows for the campaign with no status gate of its
 * own. It is `Campaign.totalContacts` that a removal decrements, and nothing
 * divides by that.
 */
export function reachedContactsFilter(campaignId: string): Prisma.CampaignContactWhereInput {
  return {
    campaignId,
    callAttempts: { some: REACHED_ATTEMPT },
  };
}

/**
 * The statuses that mean this contact's journey is over.
 *
 * `EXCLUDED` is deliberately absent: an operator removing somebody decrements
 * `totalContacts`, so counting them in a bucket would put the arithmetic one
 * ahead of the campaign it describes.
 */
export const SETTLED_STATUSES: readonly CampaignContactStatus[] = [
  'COMPLETED',
  'FAILED',
  'SKIPPED',
];

/** The statuses that mean a telephone is off the hook right now. */
const LIVE_STATUSES: readonly CampaignContactStatus[] = ['QUEUED', 'CALLING'];

export function zeroFilledDispositions(): Record<string, number> {
  return Object.fromEntries(CANONICAL_DISPOSITIONS.map((name) => [name, 0]));
}

/**
 * Whether a campaign has spoken to each of its leads — a **second** partition
 * of the same roster, answering the question the row is actually scanned for.
 *
 * The four numbers above partition by *where a contact is now*, which is what
 * makes them a progress bar. That is a different question from *have we ever
 * got hold of this person*, and reading one as the other is the bug this
 * exists to end: a lead that had a real conversation on Tuesday and was
 * re-armed for a Thursday follow-up is `inFlight` — correctly — and its
 * conversation was nowhere on the row. Beside a Leads column counting every
 * contact an extraction had ever graded, that put "450 reached a person" next
 * to chips summing to 1114 on the same line.
 *
 * **Evidenced by the attempts, never by `CampaignContact.disposition`.** That
 * column is the LAST dial's outcome and every resolution rewrites it, so it
 * loses a conversation to a later voicemail and gains one from a re-arm that
 * copied it forward. Same rule, and the same two literals, as
 * `reachedContactsFilter` — so the strip, the funnel and this now agree by
 * construction rather than by two lists staying in step.
 *
 * **Three buckets, not two.** `notConnected` has to mean *we rang and nobody
 * picked up*. Folding a contact nobody has dialled into it would report a
 * campaign on its first morning as one a thousand people had refused, which is
 * the single most misreadable thing a list of campaigns could say.
 */
export interface CampaignConnect {
  /** At least one attempt whose own disposition was a conversation. */
  connected: number;
  /** Rung at least once — a claim that reached the platform — and never
   *  reached. */
  notConnected: number;
  /**
   * No dial has ever gone out for this contact.
   *
   * Deliberately **not** `undialed` above, and the difference is real in both
   * directions. `undialed` is scoped to PENDING, so a contact the dispatcher
   * has claimed but not yet dialled lands in `inFlight` — right for a progress
   * bar, wrong here, where a telephone about to ring has not rung. And it
   * splits on `lastAttemptAt`, which a claim stamps whether or not the call was
   * ever placed, so a launch the platform refused reads as a dial nobody
   * answered. This one splits on an attempt row carrying no `launchError`,
   * which is the only evidence that a telephone actually rang.
   */
  notDialed: number;
}

export interface CampaignOutcomes {
  /** Raw counts, keyed by whatever the platform said. Collapsing these into
   *  display tiers is the dashboard's job; doing it here too would give two
   *  copies to drift. */
  dispositions: Record<string, number>;
  /** On the phone, or mid-journey between dials. */
  inFlight: number;
  /** Never dialled at all — no claim ever stamped `lastAttemptAt`. */
  undialed: number;
  /** Settled, with nothing recorded about how. */
  settledUnknown: number;
  /** The same roster, partitioned by conversation rather than by progress. */
  connect: CampaignConnect;
  /**
   * What an inbound-facing campaign has RECEIVED. Present only on INBOUND and
   * BOTH campaigns, computed by `inboundOutcomes` beside this block, never
   * inside it: the four numbers above partition the contact list, and calls
   * are not contacts.
   */
  inbound?: CampaignInboundOutcomes;
}

/**
 * The outcome mix for a whole page of campaigns, in **one** statement.
 *
 * Never one `/stats` call per row: a page of fifty campaigns would be fifty
 * round trips of five aggregates each, on a list that exists to load quickly.
 * Still batched across every campaign id on the page, which is why this is one
 * `GROUP BY` over `(campaignId, status, disposition)` rather than one statement
 * per campaign — the extra dimension yields the combinations that exist and
 * nothing else, so the row count follows the data rather than the product of
 * the vocabularies.
 *
 * The four numbers **partition** each campaign's `totalContacts`, which is what
 * makes them drawable as one bar. `settledUnknown` exists precisely to keep
 * that true — those rows matched no bucket before, and the bar silently came up
 * short.
 *
 * ## Why one statement and not three
 *
 * It was three — statuses, PENDING-with-work, and settled-by-disposition — in
 * one `Promise.all`, which is three connections and three READ COMMITTED
 * snapshots. A partition read across snapshots is not a partition: the goal
 * re-arm moves a contact `CALLING → PENDING` continuously, and one landing
 * between the first two reads is counted twice — as a live call in the first,
 * as PENDING-with-work in the second — while `Math.max(0, pending - worked)`
 * floored the subtraction that would have taken it back out. The four numbers
 * then overflowed the campaign they describe and the bar was drawn longer than
 * the list beneath it. The settled read carried the same hazard one bucket
 * over, so folding two of the three would have left the claim untrue.
 *
 * One snapshot makes it exact by construction, and the floor is gone with the
 * race that needed it: `total - worked` over one group cannot go negative.
 * `/stats` was folded for the same reason and says so in the same words.
 *
 * `Campaign.completedCount` deliberately cannot feed this. It counts contacts
 * that **settled**, so a voicemail lands in it, and rendering that as "reached
 * a person" would score a campaign that spoke to nobody as the healthiest row
 * on the page.
 */
export async function campaignOutcomes(
  campaignIds: readonly string[],
): Promise<Record<string, CampaignOutcomes>> {
  const empty: Record<string, CampaignOutcomes> = Object.fromEntries(
    campaignIds.map((id) => [
      id,
      {
        dispositions: {},
        inFlight: 0,
        undialed: 0,
        settledUnknown: 0,
        connect: { connected: 0, notConnected: 0, notDialed: 0 },
      },
    ]),
  );

  if (campaignIds.length === 0) return empty;

  /**
   * `worked` is `HAS_BEEN_DIALED_SQL` — `lastAttemptAt IS NOT NULL`, the one
   * predicate `/stats`' `waiting` split, the analytics funnel and the bucket
   * report also read. That constant carries the argument for why it is that
   * column and not the dial counters, and why the near-identical lane
   * predicate in `concurrency.ts` is not this one. Read off the counters, a
   * contact the dialer claimed and handed back landed in `undialed` and was
   * drawn on the bar as somebody nobody had ever rung, while the funnel beside
   * it counted the same contact as attempted. It is counted on every group and
   * read only off the PENDING ones, because that is the group whose remainder
   * is a sentence worth drawing.
   *
   * `disposition` is grouped **without** filtering nulls. The null group is the
   * point: those are the rows nothing recorded an outcome for, and they have to
   * be counted somewhere or the partition breaks.
   */
  const rows = await prisma.$queryRaw<
    Array<{
      campaignId: string;
      status: CampaignContactStatus;
      disposition: string | null;
      total: bigint;
      worked: bigint;
      connected: bigint;
      not_connected: bigint;
      not_dialed: bigint;
    }>
  >`
    /**
     * What the attempts say about each contact, folded to one row per contact
     * before anything is counted.
     *
     * One pass over the campaign's attempts with two boolean aggregates, not
     * two CTEs and not an EXISTS per contact row: a workspace list draws every
     * campaign it has, and a correlated subquery would be one index probe per
     * contact per campaign on a page whose whole job is to load quickly. It
     * rides the partial index call_attempts_campaign_reached_idx, which carries
     * exactly the two columns this reads and holds only the attempts that
     * reached somebody. (No backticks in here: this comment lives inside a
     * tagged template literal, and one would end the SQL.)
     *
     * "reached" is reachedAttemptSql — the carrier's conversation dispositions
     * OR the detector hearing a human whatever the label says — read off the
     * attempt itself, which is the only fact about a finished call that a later
     * resolution cannot rewrite. The shared predicate rather than the two
     * literals, so this cannot come to disagree with the strip's reached count,
     * the analytics bucket or the lead buckets about which calls were
     * conversations: a cause-16 payload arriving as no_answer beside
     * answered_by human is a conversation on all four or on none.
     *
     * "rang" excludes an attempt carrying a launchError: that is a claim the
     * platform refused, so no telephone rang and reporting it as a dial nobody
     * answered would file our own outage under the lead refusing.
     */
    WITH attempted AS (
      SELECT a."campaignContactId" AS contact_id,
             bool_or(${reachedAttemptSql('a')}) AS reached,
             bool_or(a."launchError" IS NULL) AS rang
      FROM "CallAttempt" a
      WHERE a."campaignId" IN (${Prisma.join([...campaignIds])})
        AND a."campaignContactId" IS NOT NULL
      GROUP BY a."campaignContactId"
    )
    SELECT cc."campaignId", cc.status, cc.disposition,
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE ${HAS_BEEN_DIALED_SQL}) AS worked,
           /*
            * Three FILTERs over one LEFT JOIN, written so that every contact
            * satisfies exactly one of them whatever the join found: connected
            * wins outright, then a contact that rang, then everything else.
            * A contact with no attempt row at all falls through both NULL
            * checks into not_dialed rather than into none of the three, which
            * is what keeps the sum equal to the roster.
            */
           COUNT(*) FILTER (WHERE at.reached) AS connected,
           COUNT(*) FILTER (WHERE COALESCE(at.reached, false) = false AND at.rang) AS not_connected,
           COUNT(*) FILTER (
             WHERE COALESCE(at.reached, false) = false AND COALESCE(at.rang, false) = false
           ) AS not_dialed
    FROM "CampaignContact" cc
    LEFT JOIN attempted at ON at.contact_id = cc.id
    WHERE cc."campaignId" IN (${Prisma.join([...campaignIds])})
    GROUP BY cc."campaignId", cc.status, cc.disposition`;

  for (const group of rows) {
    const row = empty[group.campaignId]!;
    const count = Number(group.total);

    if (group.status === 'PENDING') {
      const worked = Number(group.worked);

      // Mid-journey is in flight: somebody is being worked, even between dials.
      row.inFlight += worked;
      // Exact, not floored. Both figures are counted over the same rows in the
      // same statement, so the remainder cannot be negative and no contact can
      // be counted here and in flight at once.
      row.undialed += count - worked;
    } else if (LIVE_STATUSES.includes(group.status)) {
      row.inFlight += count;
    } else if (SETTLED_STATUSES.includes(group.status)) {
      if (group.disposition === null) row.settledUnknown += count;
      else row.dispositions[group.disposition] = (row.dispositions[group.disposition] ?? 0) + count;
    } else {
      // `EXCLUDED`, counted by nothing above and by nothing below: an operator
      // removing somebody decrements `totalContacts`, so a bucket for them
      // would put either partition one ahead of the campaign it describes.
      continue;
    }

    // Accumulated over every group that was NOT excluded above — including the
    // settled ones, which is the whole point: a conversation is a fact about
    // the calls a contact took, not about the status it is sitting in now.
    row.connect.connected += Number(group.connected);
    row.connect.notConnected += Number(group.not_connected);
    row.connect.notDialed += Number(group.not_dialed);
  }

  return empty;
}

/**
 * `REACHED_ATTEMPT` for a row already in hand.
 *
 * The same three clauses as the Prisma filter and the SQL fragment above, so
 * an export that has the attempt's columns does not re-query to learn what it
 * can compute — and cannot disagree with the count on the strip about it.
 */
export function isReachedAttempt(attempt: {
  disposition: string | null;
  answeredBy: string | null;
}): boolean {
  if (attempt.disposition !== null && (REACHED_DISPOSITIONS as readonly string[]).includes(attempt.disposition)) {
    return true;
  }

  return (
    attempt.answeredBy?.toLowerCase() === REACHED_ANSWERED_BY &&
    (attempt.disposition === null || (NEVER_CONNECTED_LABELS as readonly string[]).includes(attempt.disposition))
  );
}
