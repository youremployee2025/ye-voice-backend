import { Router } from 'express';
import { z } from 'zod';
import type { PlatformTopup } from '@prisma/client';
import { requireStaffToken } from '../../middleware/adminToken.js';
import { asyncHandler, ApiError } from '../../lib/errors.js';
import { parseBody } from '../../lib/validate.js';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../lib/env.js';
import { getTopupConfig, quoteTopup } from '../../adapter/vocobase.js';
import {
  createTopup,
  deleteTopup,
  readWallet,
  refreshTopup,
  TERMINAL_TOPUP_STATUSES,
} from '../../services/platformWallet.js';

/**
 * The supplier wallet, from the staff console.
 *
 * Staff-only for the reason the DID inventory and the webhook config are:
 * there is one partner account behind every YE customer, and a payment link
 * minted here credits *that* wallet. It is never a way to bill a customer —
 * their money would land in YE's balance and a chargeback on their card
 * would be charged back to YE. Nothing under `/api/workspaces` reaches any
 * of this.
 *
 * Deliberately separate from `/api/admin/accounts/:id/credits`, which moves
 * YE's own ledger. That is what YE's customers hold; this is what YE holds.
 */

export const adminWalletRoutes: Router = Router();

adminWalletRoutes.use(requireStaffToken);

/**
 * A whole number of rupees, as a JSON number. The supplier answers a string
 * amount with a 400 of its own; refusing it here means the console can never
 * send that shape, and the range check comes from upstream's config rather
 * than a copy that would drift.
 */
const amountSchema = z.object({
  amount_rupees: z.number().int().positive(),
});

const RECENT_TOPUPS = 20;

function serializeTopup(row: PlatformTopup) {
  return {
    payment_order_id: row.paymentOrderId,
    short_url: row.shortUrl,
    amount_rupees: row.amountRupees,
    gst_rupees: row.gstRupees,
    total_rupees: row.totalRupees,
    status: row.status,
    expires_at: row.expiresAt.toISOString(),
    credited_at: row.creditedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

adminWalletRoutes.get(
  '/wallet',
  asyncHandler(async (_req, res) => {
    res.json({ success: true, data: await readWallet(env.walletLowBalanceInr) });
  }),
);

adminWalletRoutes.get(
  '/wallet/topup-config',
  asyncHandler(async (_req, res) => {
    res.json({ success: true, data: await getTopupConfig() });
  }),
);

adminWalletRoutes.post(
  '/wallet/topup-quote',
  asyncHandler(async (req, res) => {
    const { amount_rupees } = parseBody(amountSchema, req.body);
    res.json({ success: true, data: await quoteTopup(amount_rupees) });
  }),
);

adminWalletRoutes.post(
  '/wallet/topups',
  asyncHandler(async (req, res) => {
    const { amount_rupees } = parseBody(amountSchema, req.body);
    // A 409 OPEN_ORDER_LIMIT from the adapter propagates as itself: the
    // console shows the open links rather than an error.
    const row = await createTopup(amount_rupees);
    res.status(201).json({ success: true, data: serializeTopup(row) });
  }),
);

/**
 * The recent links, each open one brought up to date.
 *
 * A refresh that fails leaves that row at its last known status and the
 * listing still renders: the page must not go blank because the supplier is
 * slow, and the last known status is a fact, not a guess.
 */
adminWalletRoutes.get(
  '/wallet/topups',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.platformTopup.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: RECENT_TOPUPS,
    });

    const fresh = await Promise.all(
      rows.map(async (row) => {
        if (TERMINAL_TOPUP_STATUSES.has(row.status)) return row;
        try {
          return await refreshTopup(row);
        } catch (err) {
          console.error(`[wallet] could not refresh top-up ${row.paymentOrderId}:`, err);
          return row;
        }
      }),
    );

    res.json({ success: true, data: fresh.map(serializeTopup) });
  }),
);

/**
 * One link, refreshed. This is what the console polls, so a failed refresh
 * is a failure here rather than a stale 200: the poller keeps its last known
 * state on its own and says the check failed.
 */
adminWalletRoutes.get(
  '/wallet/topups/:id',
  asyncHandler(async (req, res) => {
    const row = await prisma.platformTopup.findUnique({
      where: { paymentOrderId: String(req.params.id) },
    });
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'No such top-up.');

    res.json({ success: true, data: serializeTopup(await refreshTopup(row)) });
  }),
);

/**
 * Removes one link from the listing.
 *
 * A housekeeping action, not a cancellation: the supplier exposes no way to
 * void a link it has minted, so the link stays live and payable on their side
 * until its own expiry, and — the part that surprises people — it keeps
 * counting against the five-open-link ceiling that answers
 * `OPEN_ORDER_LIMIT`. Deleting a row here is therefore never the way out of
 * that 409, and the console says so above the button rather than leaving it to
 * be discovered by a second refusal.
 *
 * The refusal to delete a paid row, and the confirming read that decides it,
 * live in `deleteTopup` — see the note there on why the stored status is not
 * good enough to delete on.
 */
adminWalletRoutes.delete(
  '/wallet/topups/:id',
  asyncHandler(async (req, res) => {
    const removed = await deleteTopup(String(req.params.id));
    res.json({ success: true, data: serializeTopup(removed) });
  }),
);
