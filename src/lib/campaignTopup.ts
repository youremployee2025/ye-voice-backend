import { prisma } from './prisma.js';
import type { ErrorCode } from './errors.js';

/**
 * Adding to a campaign that already exists — contacts, and mapping entries.
 *
 * Both are the same shape of problem: a change to a campaign somebody may
 * already be dialing, which must not silently rewrite what an earlier call was
 * placed against.
 */

/** Most contacts one request may add. A list larger than this is a file. */
export const MAX_CONTACTS_PER_REQUEST = 10_000;

/** Rows per `createMany`. Ten thousand in one statement is a parameter list no
 *  driver enjoys and a lock held for longer than the dispatcher can wait. */
const INSERT_CHUNK_SIZE = 1000;

/**
 * Prisma's interactive-transaction default is 5 seconds, and a ten-thousand-row
 * top-up beats it — which surfaces as a P2028 and a 500 on a request that was
 * doing exactly what it was asked to.
 */
const TOPUP_TRANSACTION_TIMEOUT_MS = 30_000;

/**
 * Why a stopped campaign takes no more contacts.
 *
 * Deliberately does not end with "mark it complete, or create a new campaign":
 * the first half of that coached the operator straight through the refusal.
 */
export const STOPPED_CAMPAIGN_TOPUP_ERROR =
  'This campaign was stopped, so the rest of its queue was skipped on purpose. ' +
  'Contacts cannot be added to it — create a new campaign for further calls.';

export interface TopupResult {
  added: number;
  duplicates: number;
  reopened: boolean;
}

export type TopupOutcome =
  | { ok: true; result: TopupResult }
  | { ok: false; status: number; code: ErrorCode; message: string };

/**
 * Puts contacts onto a campaign's queue.
 *
 * **Ownership is the caller's job.** This function never sees a workspace, so
 * it cannot check one; every caller resolves the campaign and the contacts
 * inside a workspace before reaching here.
 *
 * ## The lock, first
 *
 * The campaign row is locked `FOR UPDATE` before anything is read or written —
 * the same order `stop`, the retry sweep, the callback re-arm and the
 * dispatcher's completion pass take. Without it, read-committed lets the
 * dispatcher count zero contacts remaining, this transaction insert fresh rows
 * while the campaign still reads RUNNING, and the dispatcher then commit
 * COMPLETED on top of them: leads added by hand and never dialed, with nothing
 * anywhere saying so.
 *
 * ## Refused on the column, not the status
 *
 * `complete` relabels a stopped campaign, so a rule written on
 * `status === 'STOPPED'` would be a two-click bypass of itself. `stoppedAt` is
 * written once and never cleared, which is why it is the thing this reads.
 *
 * ## Re-opened to PAUSED, never RUNNING
 *
 * A finished campaign that gains contacts becomes PAUSED. Start and resume are
 * the only doors into RUNNING, and both re-validate the agent, the numbers and
 * the balance; a top-up that flipped a campaign straight back to dialing would
 * be a third door with none of those checks on it. Adding contacts never starts
 * dialing.
 *
 * No credit check, deliberately: a top-up prices nothing. Resume checks the
 * balance and the dispatcher re-checks it every pass.
 */
export async function addContactsToCampaign({
  campaignId,
  contactIds,
}: {
  campaignId: string;
  contactIds: readonly string[];
}): Promise<TopupOutcome> {
  // Nothing to add, nothing to lock. An empty list is a legitimate outcome of
  // "select all" on a campaign that already holds everything.
  if (contactIds.length === 0) {
    return { ok: true, result: { added: 0, duplicates: 0, reopened: false } };
  }

  return prisma.$transaction(
    async (tx): Promise<TopupOutcome> => {
      const locked = await tx.$queryRaw<{ status: string; stoppedAt: Date | null }[]>`
        SELECT status::text, "stoppedAt" FROM "Campaign" WHERE id = ${campaignId} FOR UPDATE`;

      const campaign = locked[0];

      if (!campaign) {
        return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Campaign not found.' };
      }

      if (campaign.stoppedAt !== null) {
        return {
          ok: false,
          status: 400,
          code: 'CAMPAIGN_CONTACTS_LOCKED',
          message: STOPPED_CAMPAIGN_TOPUP_ERROR,
        };
      }

      // Deduplicated before the insert as well as by the unique index: a
      // request naming the same contact twice must not depend on
      // `skipDuplicates` inside one statement to behave.
      const wanted = [...new Set(contactIds)];

      const already = new Set(
        (
          await tx.campaignContact.findMany({
            where: { campaignId, contactId: { in: wanted } },
            select: { contactId: true },
          })
        ).map((row) => row.contactId),
      );

      const fresh = wanted.filter((contactId) => !already.has(contactId));

      let added = 0;

      for (let start = 0; start < fresh.length; start += INSERT_CHUNK_SIZE) {
        const inserted = await tx.campaignContact.createMany({
          data: fresh
            .slice(start, start + INSERT_CHUNK_SIZE)
            .map((contactId) => ({ campaignId, contactId })),
          skipDuplicates: true,
        });

        // The returned count, never the chunk length. `skipDuplicates` means
        // the two can differ, and a counter incremented by the wrong one is
        // wrong permanently.
        added += inserted.count;
      }

      // Everything that was asked for and not added was already on the list.
      // Derived rather than counted separately so the two always sum to what
      // the caller sent.
      const duplicates = contactIds.length - added;
      const reopened = campaign.status === 'COMPLETED' && added > 0;

      if (added > 0) {
        await tx.campaign.update({
          where: { id: campaignId },
          data: {
            totalContacts: { increment: added },
            ...(reopened
              ? {
                  status: 'PAUSED',
                  completedAt: null,
                  pausedAt: new Date(),
                  // The page's answer to "why paused": somebody added work
                  // to a finished campaign, and it waits for a person to
                  // resume it. Written outright rather than left as whatever
                  // the campaign last carried.
                  haltReason: 'New contacts were added after this campaign finished. Resume it to call them.',
                }
              : {}),
          },
        });
      }

      return { ok: true, result: { added, duplicates, reopened } };
    },
    { timeout: TOPUP_TRANSACTION_TIMEOUT_MS },
  );
}

/** A flat object, which is the only shape a variable map is allowed to be. */
function isFlatRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether `next` only *adds* to `existing`.
 *
 * Every key already there must survive with an identical value; new keys are
 * free; removing a key or re-pointing it at a different variable is not
 * additive.
 *
 * This is what lets a mapping be edited on a campaign that is no longer a
 * draft. The rule protects the calls already placed: a lead imported under
 * `{"Phone": "mobile_number"}` and dialed an hour later under
 * `{"Phone": "callee_name"}` would be greeted with variables its own CSV row
 * never meant, and nothing in the call record would say why.
 *
 * `null` is a clear rather than an add, so it is refused here — a clear
 * contradicts every existing key at once. An existing map that is null or
 * absent can contradict nothing, so anything flat is additive over it.
 */
export function isAdditiveVariableMapUpdate(existing: unknown, next: unknown): boolean {
  if (!isFlatRecord(next)) return false;
  if (existing === null || existing === undefined) return true;
  if (!isFlatRecord(existing)) return false;

  return Object.entries(existing).every(([key, value]) => next[key] === value);
}
