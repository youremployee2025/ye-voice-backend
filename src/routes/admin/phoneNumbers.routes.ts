import { Router } from 'express';
import { z } from 'zod';
import type { PhoneNumber, Prisma, Workspace } from '@prisma/client';
import { requireStaffToken } from '../../middleware/adminToken.js';
import { ApiError, asyncHandler } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { parseBody } from '../../lib/validate.js';
import { toInternalCredits } from '../../lib/credits.js';
import { serializePhoneNumberForStaff } from '../../lib/serialize.js';
import { PhoneNumberInUseError, assignPhoneNumber, priceOf } from '../../services/didRental.js';
import { syncPurchasedDids } from '../../services/didSync.js';

/**
 * Staff view of the DID inventory.
 *
 * Every DID the telephony connection owns lives in one pool; assignment is
 * what makes it a workspace's. These routes and the rental service are the
 * only places assignment changes, which is why the customer routes can treat
 * `workspaceId` as trustworthy.
 */
export const adminPhoneNumberRoutes: Router = Router();

adminPhoneNumberRoutes.use(requireStaffToken);

/** Anything but the listed values is a mistake worth reporting: silently
 *  ignoring it would return the wrong list. */
const listQuerySchema = z.object({
  assigned: z.enum(['true', 'false']).optional(),
  status: z.enum(['UNASSIGNED', 'ASSIGNED', 'PAST_DUE', 'RELEASED_NONPAYMENT']).optional(),
});

/**
 * `null` means "return this number to the pool" and must be stated. Treating a
 * missing field as null would let a malformed request take a number away from
 * a paying customer.
 */
const assignmentSchema = z.object({
  workspaceId: z.string().min(1).nullable(),
  /**
   * Required to take a DID away from the workspace currently renting it.
   *
   * Reassigning is not the same act as assigning an idle number: it ends a
   * rental somebody is paying for, mid-month, with no refund. Without this the
   * two were the same request, and a pasted-in wrong id was indistinguishable
   * from a deliberate repossession.
   */
  force: z.boolean().optional(),
});

/** Likewise: `null` restores the global default, and must be explicit. */
const priceSchema = z.object({
  monthlyPriceCredits: z.string().nullable(),
});

const forStaff = (number: PhoneNumber & { workspace: Workspace | null }) =>
  serializePhoneNumberForStaff(number, priceOf(number));

adminPhoneNumberRoutes.get(
  '/phone-numbers',
  asyncHandler(async (req, res) => {
    const { assigned, status } = parseBody(listQuerySchema, req.query);

    const where: Prisma.PhoneNumberWhereInput = {};
    if (assigned !== undefined) where.workspaceId = assigned === 'true' ? { not: null } : null;
    if (status !== undefined) where.status = status;

    const numbers = await prisma.phoneNumber.findMany({
      where,
      include: { workspace: true },
      orderBy: { did: 'asc' },
    });

    res.json({ success: true, data: numbers.map(forStaff) });
  }),
);

// Registered before `/phone-numbers/:didId/...`, so Express cannot match the
// literal "sync" as a DID id.
adminPhoneNumberRoutes.post(
  '/phone-numbers/sync',
  asyncHandler(async (_req, res) => {
    res.json({ success: true, data: await syncPurchasedDids() });
  }),
);

/**
 * Moves a number between workspaces, or back to the pool, **without charging**.
 *
 * An operational override — correcting a mistake, seeding a workspace — not a
 * sale. See `assignPhoneNumber` for why no ledger row is written.
 */
adminPhoneNumberRoutes.post(
  '/phone-numbers/:didId/assign',
  asyncHandler(async (req, res) => {
    const { workspaceId, force } = parseBody(assignmentSchema, req.body);

    const number = await prisma.phoneNumber.findUnique({ where: { id: req.params.didId } });
    if (!number) {
      throw new ApiError(404, 'NOT_FOUND', 'Phone number not found.');
    }

    // Checked before the write so a typo in the workspace id fails loudly
    // rather than arriving as a foreign-key violation dressed up as a 500.
    if (workspaceId) {
      const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
      if (!workspace) {
        throw new ApiError(404, 'NOT_FOUND', 'Workspace not found.');
      }
    }

    try {
      await assignPhoneNumber(number.id, workspaceId, { force: force ?? false });
    } catch (err) {
      if (err instanceof PhoneNumberInUseError) {
        throw new ApiError(
          409,
          'PHONE_NUMBER_IN_USE',
          'That number is rented by a workspace. Re-send with force: true to take it back — ' +
            'the rental ends immediately and the month already paid is not refunded.',
        );
      }
      throw err;
    }

    const updated = await prisma.phoneNumber.findUniqueOrThrow({
      where: { id: number.id },
      include: { workspace: true },
    });

    res.json({ success: true, data: forStaff(updated) });
  }),
);

/**
 * Sets the **catalog** price: what this DID costs the next workspace to rent it.
 *
 * Deliberately not blocked on an assigned number, and deliberately without a
 * `force` flag. Editing this cannot reach an existing rental — that charge is
 * the snapshot taken when the number was rented — so there is nothing here to
 * protect a paying customer from. The response carries `rented_price_credits`
 * beside the new catalog price so the distinction is visible rather than
 * something staff have to remember: an edit that appears to do nothing to the
 * current renter is doing exactly what it should.
 */
adminPhoneNumberRoutes.patch(
  '/phone-numbers/:didId',
  asyncHandler(async (req, res) => {
    const { monthlyPriceCredits } = parseBody(priceSchema, req.body);

    let price: bigint | null = null;
    if (monthlyPriceCredits !== null) {
      try {
        price = toInternalCredits(monthlyPriceCredits);
      } catch {
        // The parser's own wording names internals; the code is what the
        // caller acts on. Out-of-range lands here too rather than reaching the
        // write as an unhandled Prisma error — a validated money field should
        // not be able to answer 500.
        throw new ApiError(
          400,
          'VALIDATION_ERROR',
          'monthlyPriceCredits must be a non-negative amount with at most 4 decimal places, ' +
            'within the supported range.',
        );
      }
    }

    const number = await prisma.phoneNumber.findUnique({ where: { id: req.params.didId } });
    if (!number) {
      throw new ApiError(404, 'NOT_FOUND', 'Phone number not found.');
    }

    const updated = await prisma.phoneNumber.update({
      where: { id: number.id },
      data: { monthlyPriceCredits: price },
      include: { workspace: true },
    });

    res.json({ success: true, data: forStaff(updated) });
  }),
);
