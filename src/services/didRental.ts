import type { PhoneNumber, Prisma, Workspace } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { addOneMonth } from '../lib/billingCycle.js';

/**
 * Renting and releasing DIDs, and the only module in this service that moves
 * credits.
 *
 * Renting is internal. Nothing is bought upstream, no DID is mapped to a
 * client, no routing is created: a rented DID is a row with a `workspaceId` on
 * it and a charge in the ledger. Making it ring is a later slice.
 *
 * Every balance change is a **conditional write** inside a transaction, never
 * a read followed by a write. That distinction is the whole safety argument
 * here: Postgres runs READ COMMITTED, so two transactions can both read
 * "unowned" or both read "can afford it" and both proceed. A conditional write
 * takes a row lock and matches nothing when the precondition has already been
 * consumed, which is what makes a double rental and a negative balance
 * unreachable rather than merely unlikely.
 */

/** The DID was gone by the time the claim ran — already rented, or never there. */
export class PhoneNumberTakenError extends Error {
  constructor() {
    super('That number is no longer available.');
    this.name = 'PhoneNumberTakenError';
  }
}

/** The owner's balance did not cover the price. */
export class InsufficientCreditsError extends Error {
  constructor() {
    super('Not enough credits to rent this number.');
    this.name = 'InsufficientCreditsError';
  }
}

/** The workspace does not hold this DID — another workspace's, or nobody's. */
export class PhoneNumberNotHeldError extends Error {
  constructor() {
    super('This workspace does not hold that number.');
    this.name = 'PhoneNumberNotHeldError';
  }
}

/** The DID is rented by a workspace, and the caller asked for something that
 *  only makes sense on an idle one. */
export class PhoneNumberInUseError extends Error {
  constructor() {
    super('That number is currently rented by a workspace.');
    this.name = 'PhoneNumberInUseError';
  }
}

/**
 * The CATALOG price: what this DID costs to rent from today.
 *
 * `null` means "staff did not price this one", so the configured global
 * default applies. It never means free — an explicit `0n` does, and the
 * nullish coalescing keeps the two distinguishable.
 *
 * This is the price a prospective renter is quoted. It is **not** what an
 * existing rental is charged; see `chargePriceOf`.
 */
export function priceOf(number: Pick<PhoneNumber, 'monthlyPriceCredits'>): bigint {
  return number.monthlyPriceCredits ?? env.didDefaultMonthlyPriceCredits;
}

/**
 * What an existing rental is charged: the price the workspace agreed to when
 * it took the number.
 *
 * Renewals used to read the catalog price, which made a rental's cost a live
 * value — re-pricing a DID, or correcting the global default, silently
 * re-billed every customer already renting one at a number they never agreed
 * to. The snapshot is the fix, and this is the only function renewals may use.
 *
 * The fallback covers rentals taken before the snapshot column existed, whose
 * catalog price is by definition still the one they agreed to.
 */
export function chargePriceOf(
  number: Pick<PhoneNumber, 'rentedPriceCredits' | 'monthlyPriceCredits'>,
): bigint {
  return number.rentedPriceCredits ?? priceOf(number);
}

export interface RentalRequest {
  phoneNumberId: string;
  workspace: Pick<Workspace, 'id' | 'ownerAccountId'>;
}

/**
 * Charges the workspace owner and assigns the DID, atomically.
 *
 * The owner pays, not the caller: an ADMIN who is not the owner may rent, but
 * the credits belong to the account that owns the workspace.
 *
 * Full price at the start of the month, no proration. Renting on the 28th
 * costs what renting on the 1st costs — a proration rule nobody has decided
 * would otherwise be invented here and live in the ledger forever.
 */
export async function rentPhoneNumber({
  phoneNumberId,
  workspace,
}: RentalRequest): Promise<PhoneNumber> {
  return prisma.$transaction(async (tx) => {
    // Read for the price only. Safety comes from the claim below, not from
    // this — anything decided here can be stale by the next statement.
    const candidate = await tx.phoneNumber.findFirst({
      where: { id: phoneNumberId, workspaceId: null },
    });

    if (!candidate) throw new PhoneNumberTakenError();

    const price = priceOf(candidate);
    const now = new Date();

    // Claim: compare-and-set on "still unowned". Of two simultaneous rentals
    // exactly one matches; the other sees zero rows and is told the number is
    // taken. A released-for-non-payment DID is unowned too, and renting it
    // clears the marker.
    const claimed = await tx.phoneNumber.updateMany({
      where: { id: phoneNumberId, workspaceId: null },
      data: {
        workspaceId: workspace.id,
        status: 'ASSIGNED',
        // The price is captured here, with the claim, and every renewal reads
        // it back. What the customer agreed to at this moment is what they
        // keep paying, whatever staff or the configured default do later.
        rentedPriceCredits: price,
        rentedAt: now,
        nextRenewalAt: addOneMonth(now),
        // A number renting out of the released pool starts clean.
        pastDueSince: null,
      },
    });

    if (claimed.count === 0) throw new PhoneNumberTakenError();

    // Debit: compare-and-set on "can still afford it". The `gte` guard is what
    // makes a negative balance unreachable — there is no window between
    // checking the balance and spending it. A miss throws, which rolls the
    // claim above back, so a DID is never held without a charge behind it.
    const debited = await tx.account.updateMany({
      where: { id: workspace.ownerAccountId, credits: { gte: price } },
      data: { credits: { decrement: price } },
    });

    if (debited.count === 0) throw new InsufficientCreditsError();

    await tx.creditTransaction.create({
      data: {
        accountId: workspace.ownerAccountId,
        workspaceId: workspace.id,
        phoneNumberId,
        amount: -price,
        type: 'DID_PURCHASE',
      },
    });

    return tx.phoneNumber.findUniqueOrThrow({ where: { id: phoneNumberId } });
  });
}

/**
 * Returns a DID to the pool.
 *
 * **No refund**, and the absence of any credit statement below is what
 * enforces it: the month was paid in full at its start, and handing the number
 * back partway through does not un-spend it. The UI says so before the click
 * rather than leaving it to be discovered in the ledger.
 */
export async function releasePhoneNumber({
  phoneNumberId,
  workspace,
}: RentalRequest): Promise<PhoneNumber> {
  return prisma.$transaction(async (tx) => {
    // Scoped to the workspace, so releasing another workspace's number finds
    // nothing rather than needing an ownership check somebody can forget.
    const released = await tx.phoneNumber.updateMany({
      where: { id: phoneNumberId, workspaceId: workspace.id },
      data: {
        workspaceId: null,
        status: 'UNASSIGNED',
        rentedPriceCredits: null,
        rentedAt: null,
        nextRenewalAt: null,
        pastDueSince: null,
      },
    });

    if (released.count === 0) throw new PhoneNumberNotHeldError();

    // Zero-amount marker. It carries the workspace it left, so the record
    // survives on that workspace's ledger after the DID is gone from it.
    await tx.creditTransaction.create({
      data: {
        accountId: workspace.ownerAccountId,
        workspaceId: workspace.id,
        phoneNumberId,
        amount: 0n,
        type: 'DID_RELEASE',
      },
    });

    return tx.phoneNumber.findUniqueOrThrow({ where: { id: phoneNumberId } });
  });
}

/**
 * Moves a DID between workspaces, or back to the pool, **without charging**.
 *
 * A staff override — correcting a mistake, seeding a workspace — not a sale.
 * No credits move, so no charge row is written: manufacturing a transaction
 * for a credit movement that did not happen puts fiction in the audit trail.
 *
 * Taking a number **away** from a workspace is a different matter. This used
 * to be an unconditional update: staff could reassign a DID a workspace had
 * paid for and the losing workspace's ledger would show a `DID_PURCHASE` with
 * no counterpart — the history asserting they still held a number that was
 * gone. The renewal path argues its own marker exists because it is "the only
 * durable record that this workspace ever held this number and how it lost
 * it"; the same is owed here. So:
 *
 * - Taking a DID from a workspace requires `force`, because it is not
 *   something to do by pasting the wrong id into a field.
 * - When it happens, the losing workspace gets a zero-amount `DID_RELEASE`
 *   row, so the number's departure is on the ledger that recorded its arrival.
 *
 * Assigning starts a billing cycle: the DID renews normally from here, at the
 * catalog price snapshotted now, and the receiving workspace's owner is
 * charged from the next renewal on. That is why a typo'd `workspaceId` is not
 * a harmless mistake, and why the route resolves the workspace before calling.
 */
export async function assignPhoneNumber(
  phoneNumberId: string,
  workspaceId: string | null,
  { force = false }: { force?: boolean } = {},
): Promise<PhoneNumber> {
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const current = await tx.phoneNumber.findUnique({ where: { id: phoneNumberId } });
    if (!current) throw new PhoneNumberNotHeldError();

    const heldBy = current.workspaceId;
    const takingItAway = heldBy !== null && heldBy !== workspaceId;

    if (takingItAway && !force) throw new PhoneNumberInUseError();

    if (takingItAway) {
      const owner = await tx.workspace.findUnique({
        where: { id: heldBy },
        select: { ownerAccountId: true },
      });

      if (owner) {
        await tx.creditTransaction.create({
          data: {
            accountId: owner.ownerAccountId,
            workspaceId: heldBy,
            phoneNumberId,
            amount: 0n,
            type: 'DID_RELEASE',
          },
        });
      }
    }

    const data: Prisma.PhoneNumberUpdateInput = workspaceId
      ? {
          workspace: { connect: { id: workspaceId } },
          status: 'ASSIGNED',
          rentedPriceCredits: priceOf(current),
          rentedAt: now,
          nextRenewalAt: addOneMonth(now),
          pastDueSince: null,
        }
      : {
          workspace: { disconnect: true },
          status: 'UNASSIGNED',
          rentedPriceCredits: null,
          rentedAt: null,
          nextRenewalAt: null,
          pastDueSince: null,
        };

    return tx.phoneNumber.update({ where: { id: phoneNumberId }, data });
  });
}
