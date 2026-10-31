import type { PlatformTopup, PlatformTopupStatus } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { ApiError } from '../lib/errors.js';
import {
  createTopupLink,
  getBalance,
  getTopupLink,
  type TopupLinkStatus,
} from '../adapter/vocobase.js';

/**
 * The supplier wallet: what YE holds with the voice platform, and the payment
 * links minted against it.
 *
 * One property shapes everything here: **there is no callback.** A paid link
 * becomes CREDITED only because somebody re-read it — the console's own
 * 30-second poll while a page is open, or the maintenance job every couple of
 * minutes when nobody is looking. Both come through `refreshTopup`.
 */

export const TERMINAL_TOPUP_STATUSES: ReadonlySet<PlatformTopupStatus> = new Set([
  'CREDITED',
  'EXPIRED',
  'MISMATCH',
]);

export interface Wallet {
  balance_inr: number;
  low: boolean;
  threshold_inr: number;
}

function readBalanceInr(value: unknown): number {
  // `Number('')` and `Number('  ')` are both 0, so a blank decimal upstream
  // would arrive here as a balance of zero. Blank is unreadable, not empty.
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  if (!Number.isFinite(parsed)) {
    // A wallet that reads ₹0 when the supplier answered nonsense is the one
    // answer this must never give: it is indistinguishable from empty.
    throw new ApiError(
      502,
      'UPSTREAM_ERROR',
      'The voice platform returned an unreadable balance.',
    );
  }
  return parsed;
}

export async function readWallet(thresholdInr: number): Promise<Wallet> {
  const upstream = await getBalance();
  const balance = readBalanceInr(upstream.credits ?? upstream.balance);
  return { balance_inr: balance, low: balance < thresholdInr, threshold_inr: thresholdInr };
}

export async function createTopup(amountRupees: number): Promise<PlatformTopup> {
  const link = await createTopupLink(amountRupees);

  return prisma.platformTopup.create({
    data: {
      paymentOrderId: link.payment_order_id,
      shortUrl: link.short_url,
      amountRupees: link.base,
      gstRupees: link.gst,
      totalRupees: link.total,
      expiresAt: new Date(link.expires_at),
    },
  });
}

function isTerminal(status: PlatformTopupStatus): boolean {
  return TERMINAL_TOPUP_STATUSES.has(status);
}

/**
 * Brings one row up to date.
 *
 * Terminal rows are returned as they are. Everything else is read live.
 *
 * A row past its own `expiresAt` always settles on this pass rather than
 * waiting for the platform's hourly sweep, which can leave a dead link
 * reading CREATED for an hour. But it settles *after* one confirming read,
 * not instead of one: EXPIRED is terminal and is never revisited, so writing
 * it blind would record a payment made in the last poll interval as a link
 * nobody paid — and the operator, told to create a new link, pays twice. Our
 * clock decides when to stop; it does not get to overrule a settled money
 * fact. CREDITED and MISMATCH therefore survive the expiry; everything else
 * past it becomes EXPIRED.
 *
 * An upstream 404 means the link is gone on their side and there is nothing
 * left to poll, so it is recorded as EXPIRED. Any other failure propagates
 * and the row is left untouched — "we could not check" must not be written
 * down as a status — except on a row already past expiry, which settles
 * EXPIRED anyway rather than being polled forever against a platform that
 * cannot answer.
 */
export async function refreshTopup(row: PlatformTopup, now = new Date()): Promise<PlatformTopup> {
  if (isTerminal(row.status)) return row;

  const past = row.expiresAt.getTime() <= now.getTime();

  let status: TopupLinkStatus;
  let creditedAt: Date | null;
  try {
    const live = await getTopupLink(row.paymentOrderId);
    status = live.status;
    creditedAt = live.credited_at ? new Date(live.credited_at) : null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      console.error(`[wallet] top-up ${row.paymentOrderId} is unknown upstream; marking expired.`);
      status = 'EXPIRED';
      creditedAt = null;
    } else if (past) {
      console.error(
        `[wallet] could not confirm expired top-up ${row.paymentOrderId}; marking expired:`,
        err,
      );
      status = 'EXPIRED';
      creditedAt = null;
    } else {
      throw err;
    }
  }

  // The clock stops the polling; it does not overrule what the money did.
  if (past && status !== 'CREDITED' && status !== 'MISMATCH') {
    status = 'EXPIRED';
    creditedAt = null;
  }

  // Skip the write when nothing moved, so `updatedAt` is not bumped every two
  // minutes and the poll job's "log only when something changed" holds. The
  // row is still re-read below rather than returned from the snapshot: this
  // caller learning nothing new does not mean nothing happened.
  const unchanged =
    status === row.status &&
    (creditedAt?.getTime() ?? null) === (row.creditedAt?.getTime() ?? null);

  // Guarded, not a blind write. `row` was read before the upstream call, so
  // between then and now another poller — the maintenance job, the list
  // route's fan-out, another console tab — may already have settled it. The
  // predicate makes this a no-op against a row that has since gone terminal,
  // so a slow reader can never clear a `creditedAt` a faster one wrote.
  if (!unchanged) {
    await prisma.platformTopup.updateMany({
      where: { id: row.id, status: { notIn: [...TERMINAL_TOPUP_STATUSES] } },
      data: { status, creditedAt },
    });
  }

  return prisma.platformTopup.findUniqueOrThrow({ where: { id: row.id } });
}

export interface RefreshSummary {
  /**
   * Rows walked, not rows successfully read: `failed` is a subset of this, so
   * a pass that could reach nothing still reports what it tried. The one
   * question a poll's log line has to answer is whether it looked, and a
   * count that excluded the failures would read as "there was nothing open"
   * on exactly the pass where the supplier was down.
   */
  refreshed: number;
  credited: number;
  expired: number;
  failed: number;
}

/**
 * Every non-terminal row, refreshed in turn.
 *
 * Not bounded by the supplier's five: that ceiling counts links which are
 * open (unpaid, unexpired, not yet attempted), and an ATTEMPTED or FAILED
 * row is neither open by that definition nor terminal by ours, so it is
 * still polled. The real bound is what was minted in the last 24 hours and
 * has neither credited nor passed its expiry.
 */
export async function refreshOpenTopups(now = new Date()): Promise<RefreshSummary> {
  const open = await prisma.platformTopup.findMany({
    where: { status: { notIn: [...TERMINAL_TOPUP_STATUSES] } },
    orderBy: { createdAt: 'asc' },
  });

  const summary: RefreshSummary = { refreshed: 0, credited: 0, expired: 0, failed: 0 };

  for (const row of open) {
    summary.refreshed += 1;
    try {
      const next = await refreshTopup(row, now);
      if (next.status === 'CREDITED') summary.credited += 1;
      if (next.status === 'EXPIRED') summary.expired += 1;
    } catch (err) {
      summary.failed += 1;
      console.error(`[wallet] could not refresh top-up ${row.paymentOrderId}:`, err);
    }
  }

  return summary;
}

/**
 * The statuses that record money having moved, and so can never be removed.
 *
 * CREDITED is obvious. MISMATCH is the one worth stating: it means a payment
 * landed for an amount that did not match the link, which is precisely the row
 * somebody has to reconcile against the supplier's statement. It is "not yet
 * credited" by the letter of the column and is emphatically not a link nobody
 * paid, so it is refused alongside CREDITED rather than swept up with the dead
 * links.
 */
export const PAID_TOPUP_STATUSES: ReadonlySet<PlatformTopupStatus> = new Set([
  'CREDITED',
  'MISMATCH',
]);

/**
 * Removes one top-up row, refusing anything that records a payment.
 *
 * **The confirming read is the whole of this function.** There is no callback
 * from the supplier — a paid link becomes CREDITED only because somebody
 * re-read it — so the local status is only ever as fresh as the last poll, and
 * the console's poll runs every 30 seconds while a page is open and every
 * couple of minutes when nobody is looking. Deleting on the stored status
 * would therefore delete a link paid within that window while it still read
 * CREATED, and the operator would be told the link never happened. That is the
 * same failure `refreshTopup` refuses to commit when it declines to write
 * EXPIRED blind, and for the same reason: our clock does not get to overrule a
 * settled money fact.
 *
 * So a non-terminal row is read live first and the refusal is decided on what
 * came back. A refresh that throws propagates and nothing is deleted — "we
 * could not check" must not become a delete, which is the one direction with
 * no undo.
 *
 * The row is the mirror, not the money: the wallet balance is read live from
 * the supplier, so removing a row never changes what YE holds. What it does
 * lose is the record of the link, which is why the paid statuses are refused
 * and why the console says what a delete does not do — see the note there
 * about the supplier's open-link limit.
 */
export async function deleteTopup(paymentOrderId: string): Promise<PlatformTopup> {
  const row = await prisma.platformTopup.findUnique({ where: { paymentOrderId } });
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'No such top-up.');

  // Terminal rows are already settled and `refreshTopup` returns them
  // untouched, so this costs an upstream call only where one can still change
  // the answer.
  const current = isTerminal(row.status) ? row : await refreshTopup(row);

  if (PAID_TOPUP_STATUSES.has(current.status)) {
    throw new ApiError(
      409,
      'TOPUP_PAID',
      current.status === 'CREDITED'
        ? 'That link has been paid and credited to the wallet. A paid top-up stays as the record of it.'
        : 'That link was paid for an amount that does not match it. It stays until the difference is reconciled with the platform.',
    );
  }

  // Guarded on the status that was just confirmed rather than deleting by id
  // alone. Between the read above and this write another poller — the
  // maintenance job, the list route's fan-out, a second console tab — may have
  // settled the row, and a delete by id would take the CREDITED row it became.
  const removed = await prisma.platformTopup.deleteMany({
    where: { id: row.id, status: current.status },
  });

  if (removed.count === 0) {
    throw new ApiError(
      409,
      'TOPUP_PAID',
      'That link changed while it was being removed. Reload the page and check its status.',
    );
  }

  return current;
}
