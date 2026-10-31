import { getCall } from '../adapter/vocobase.js';
import { prisma } from '../lib/prisma.js';

/**
 * Moving an imported inbound call's platform id into the column that is read.
 *
 * `CampaignInboundCall` carries two ids from two namespaces, and the schema
 * says which is which: `upstreamCallId` is the carrier's `provider_call_id`,
 * the only id the routing policy carries; `upstreamPhoneCallId` is Vocobase's
 * own `call.call_id`, learned at completion, and the only one
 * `GET /api/v2/calls/:id` resolves.
 *
 * `onboard-inbound-campaign.ts` predates that split. It reads `call_id` off the
 * platform listing — a `PhoneCall.id`, the resolving kind — proves it resolves
 * by fetching each call's extraction with it, and then stores it in
 * `upstreamCallId`. So on the campaign this was written for, 136 of 137 rows
 * hold a perfectly good platform id in the column nothing reads any more, and
 * the Calls tab offers "Open call" on one row.
 *
 * ## Why this is not a one-line UPDATE
 *
 * A row created by the ROUTING POLICY also has `upstreamCallId` set, and there
 * it is the carrier's id. Copying that into `upstreamPhoneCallId` would write a
 * non-resolving id into the column the settle dedupe keys on — a worse bug than
 * the one being fixed, and invisible until a redelivered completion fabricated
 * a second row for a call already settled.
 *
 * The two kinds of row are indistinguishable in the data. `arrivedAt` against
 * the campaign's `createdAt` looks like a discriminator and is not one: it is
 * inferred rather than checked, and it breaks for any campaign whose import
 * window overlaps its own run — which is exactly the shape of the campaign this
 * exists for.
 *
 * **So each id is asked.** One `GET /calls/:id` per candidate row, and the copy
 * happens only for an id the platform resolves. At 137 rows that is 137
 * requests, which is cheap; at a hundred times that it would still be the only
 * honest answer, because no rule invents an id that was never learned.
 *
 * Safe to re-run: it fills absences only, so a second pass sees no candidates
 * for the rows the first one filled.
 */

export interface InboundPhoneCallIdBackfillOptions {
  /** Scope to one campaign. Absent walks every campaign, which is the right
   *  default for a column that is missing everywhere it was imported. */
  campaignId?: string;
  /** Read and ask upstream, write nothing. */
  dryRun?: boolean;
  /**
   * Whether an id is one the calls surface can resolve. Defaults to a real
   * `GET /calls/:id`, which answers `null` on a 404 — the answer that means
   * "the platform never knew this id", which is what a carrier id looks like
   * from here.
   */
  resolves?: (upstreamCallId: string) => Promise<boolean>;
  /** Called per row, so a walk of some hundreds says something while it runs. */
  onRow?: (row: { id: string; upstreamCallId: string; resolved: boolean }) => void;
}

export interface InboundPhoneCallIdBackfillResult {
  /** Rows with no `upstreamPhoneCallId` and an `upstreamCallId` to test. */
  candidates: number;
  /** Rows whose id resolved and was copied. On a dry run, would have been. */
  filled: number;
  /**
   * Rows whose id the platform does not know — the policy-created ones, whose
   * platform id genuinely was never learned. Left exactly as they are: no
   * amount of copying invents one.
   */
  unresolved: number;
  /**
   * Rows whose id resolved but is already another row's `upstreamPhoneCallId`.
   * Both columns are `@unique`, so this is refused rather than forced: two rows
   * claiming one platform call is the state the dedupe exists to prevent.
   */
  conflicted: number;
}

/** Prisma's unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

export async function backfillInboundPhoneCallId(
  options: InboundPhoneCallIdBackfillOptions = {},
): Promise<InboundPhoneCallIdBackfillResult> {
  const resolves = options.resolves ?? (async (id: string) => (await getCall(id)) !== null);

  const candidates = await prisma.campaignInboundCall.findMany({
    where: {
      upstreamPhoneCallId: null,
      upstreamCallId: { not: null },
      ...(options.campaignId ? { campaignId: options.campaignId } : {}),
    },
    select: { id: true, upstreamCallId: true },
    orderBy: { arrivedAt: 'asc' },
  });

  const result: InboundPhoneCallIdBackfillResult = {
    candidates: candidates.length,
    filled: 0,
    unresolved: 0,
    conflicted: 0,
  };

  for (const row of candidates) {
    // Narrowed by the `not: null` above; Prisma's type does not carry that.
    const upstreamCallId = row.upstreamCallId!;
    const resolved = await resolves(upstreamCallId);
    options.onRow?.({ id: row.id, upstreamCallId, resolved });

    if (!resolved) {
      result.unresolved += 1;
      continue;
    }

    if (options.dryRun) {
      result.filled += 1;
      continue;
    }

    try {
      await prisma.campaignInboundCall.update({
        where: { id: row.id },
        data: { upstreamPhoneCallId: upstreamCallId },
      });
      result.filled += 1;
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        result.conflicted += 1;
        continue;
      }
      throw err;
    }
  }

  return result;
}
