import type { PhoneNumberStatus, Prisma, PrismaClient } from '@prisma/client';
import { phoneNumberIsUsable } from '../lib/phoneNumberVisibility.js';

/**
 * Which number a campaign dials from, on each call.
 *
 * A campaign may attach up to twenty DIDs, and the order they were attached in
 * *is* the rotation order. Rotating matters for two reasons the customer feels:
 * a single number placing hundreds of calls an hour gets flagged by carriers,
 * and a callee who has already declined one number answers another.
 *
 * The number is resolved **before** the claim, not after it. A campaign whose
 * numbers have all been released must hold its queue where it is rather than
 * claim contacts it cannot dial and fail every one of them — a failed launch is
 * an attempt row, a log line and, on some branches, a consumed retry.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** One usable caller id, as the launcher needs it. */
export interface DialNumber {
  id: string;
  did: string;
}

/**
 * What a campaign has to dial from this pass.
 *
 * Four states, not two, because "nothing to dial from" has two causes with
 * opposite remedies: a campaign that never had a number is misconfigured and
 * its operator must be told, while a campaign whose attached numbers were all
 * just released is a supplier-side fact that may well be fixed by the time the
 * next pass runs.
 */
export type DialRotation =
  /** Attached numbers, at least one usable. The cursor advances over these. */
  | { state: 'rotating'; numbers: DialNumber[] }
  /** No attachments; the legacy pointer still names a usable number. */
  | { state: 'legacy'; numbers: DialNumber[] }
  /** Attachments exist and none is usable. Hold this pass; pause nothing. */
  | { state: 'held'; attached: number }
  /** Nothing configured, or the legacy pointer names a number that is gone. */
  | { state: 'none' };

interface RotationSource {
  workspaceId: string;
  phoneNumber: { id: string; did: string; status: PhoneNumberStatus; workspaceId: string | null } | null;
  dialNumbers: readonly {
    phoneNumber: { id: string; did: string; status: PhoneNumberStatus; workspaceId: string | null };
  }[];
}

/**
 * Resolves the rotation from a campaign row the sweep has already joined.
 *
 * Pure, and reading the same `phoneNumberIsUsable` rule the assignment check
 * and the serializer read — so what a campaign's page prints as its caller ids
 * is exactly the set the dispatcher will dial from.
 *
 * **When attachments exist but none is usable the campaign holds**, and
 * deliberately does not fall back to the legacy pointer. That pointer is kept
 * in sync with the first attached number and is loaded with no status filter of
 * its own: falling back to it would very often mean dialing from the very
 * number that was just deactivated.
 */
export function resolveDialRotation(campaign: RotationSource): DialRotation {
  if (campaign.dialNumbers.length > 0) {
    // A deactivated number falls out of the rotation rather than failing every
    // Nth call.
    const numbers = campaign.dialNumbers
      .filter((row) => phoneNumberIsUsable(row.phoneNumber, campaign.workspaceId))
      .map((row) => ({ id: row.phoneNumber.id, did: row.phoneNumber.did }));

    if (numbers.length === 0) return { state: 'held', attached: campaign.dialNumbers.length };

    return { state: 'rotating', numbers };
  }

  const legacy = campaign.phoneNumber;

  if (!legacy || !phoneNumberIsUsable(legacy, campaign.workspaceId)) return { state: 'none' };

  return { state: 'legacy', numbers: [{ id: legacy.id, did: legacy.did }] };
}

/**
 * Moves the round-robin cursor on by a whole batch and returns where the batch
 * starts.
 *
 * One statement, so two dispatchers each get a disjoint window of the cursor
 * rather than both reading the same value and dialing the same number. Only the
 * modulo is ever used, so the column is never reset and drift is harmless.
 *
 * Called **once per claimed batch** and only when there is a rotation to move
 * over: the single legacy number has nothing to rotate, and advancing a cursor
 * for it would make the column's value a record of nothing.
 */
export async function advanceRoundRobinCursor(
  db: Db,
  campaignId: string,
  count: number,
): Promise<number> {
  const [row] = await db.$queryRaw<{ rrCursor: number }[]>`
    UPDATE "Campaign" SET "rrCursor" = "rrCursor" + ${count}
    WHERE id = ${campaignId}
    RETURNING "rrCursor"`;

  // The value *before* the advance: the batch's first dial uses it, and the
  // i-th uses base + i. A campaign that vanished mid-pass returns nothing, and
  // starting from zero is as good as any other answer for a rotation nobody
  // will read.
  return (row?.rrCursor ?? count) - count;
}
