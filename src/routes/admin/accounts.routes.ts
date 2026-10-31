import { Router } from 'express';
import { z } from 'zod';
import { CreditTransactionType, Prisma } from '@prisma/client';
import { requireStaffToken } from '../../middleware/adminToken.js';
import { ApiError, asyncHandler } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { parseBody } from '../../lib/validate.js';
import { paginated, parsePagination } from '../../lib/pagination.js';
import { parseSignedCredits, toDisplayCredits } from '../../lib/credits.js';
import {
  serializeAccountForStaff,
  serializeLedgerRow,
  LEDGER_CALL,
  serializeMembershipForStaff,
  serializeWorkspaceForStaff,
} from '../../lib/serialize.js';

/**
 * Staff view of accounts and the credit ledger.
 *
 * An account is the billing principal, so this is where a balance is read and
 * — through the one write here — corrected. Everything else about an account
 * is read-only in this slice: there is no suspension, no deletion, no editing.
 */
export const adminAccountRoutes: Router = Router();

adminAccountRoutes.use(requireStaffToken);

/** How many of an account's ledger rows the detail view carries. The full
 *  history is a page of `/credit-transactions?accountId=`, not this. */
const RECENT_TRANSACTIONS = 20;

/**
 * How many workspaces and memberships the detail view carries.
 *
 * Same reasoning as the ledger cap above: `workspace_count` and
 * `membership_count` come from `_count` and are the true totals, so a capped
 * list is legible as one rather than passing for the whole.
 */
const DETAIL_ROWS = 100;

const searchSchema = z.object({ search: z.string().trim().min(1).optional() });

/**
 * A correction, and the sentence explaining it.
 *
 * `note` is required here though the column is nullable: a staff adjustment
 * that nobody can account for later is the failure this ledger exists to
 * prevent, while a machine-written charge has its own type to explain it.
 */
const adjustmentSchema = z.object({
  amount: z.string(),
  note: z.string().trim().min(1, 'a note is required'),
  reference: z.string().trim().min(1).optional(),
});

const ledgerFilterSchema = z.object({
  accountId: z.string().min(1).optional(),
  // An unrecognised type is rejected rather than ignored: a filter that
  // silently matched everything would read as "no rows of this kind".
  type: z.enum(CreditTransactionType).optional(),
});

adminAccountRoutes.get(
  '/accounts',
  asyncHandler(async (req, res) => {
    const pagination = parsePagination(req.query as Record<string, unknown>);
    const { search } = parseBody(searchSchema, { search: req.query.search });

    // `contains`, not `startsWith`: staff paste a fragment of an address at
    // least as often as its beginning.
    const where: Prisma.AccountWhereInput = search
      ? {
          OR: [
            { email: { contains: search, mode: 'insensitive' } },
            { name: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {};

    const [accounts, total] = await prisma.$transaction([
      prisma.account.findMany({
        where,
        include: { _count: { select: { ownedWorkspaces: true, memberships: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      prisma.account.count({ where }),
    ]);

    res.json({
      success: true,
      data: paginated(accounts.map(serializeAccountForStaff), total, pagination),
    });
  }),
);

adminAccountRoutes.get(
  '/accounts/:accountId',
  asyncHandler(async (req, res) => {
    const account = await prisma.account.findUnique({
      where: { id: req.params.accountId },
      include: {
        _count: { select: { ownedWorkspaces: true, memberships: true } },
        ownedWorkspaces: {
          include: { _count: { select: { members: true, agents: true, campaigns: true } } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: DETAIL_ROWS,
        },
        memberships: {
          include: { workspace: true },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: DETAIL_ROWS,
        },
        creditTransactions: {
          // The call behind a usage row, so the ledger can show what was
          // billed against what the call actually ran to.
          include: { callAttempt: LEDGER_CALL },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: RECENT_TRANSACTIONS,
        },
      },
    });

    if (!account) {
      throw new ApiError(404, 'NOT_FOUND', 'Account not found.');
    }

    res.json({
      success: true,
      data: {
        ...serializeAccountForStaff(account),
        super_admin_granted_at: await superAdminGrantedAt(prisma, account),
        // Owned and joined are listed apart because they answer different
        // questions: what this account is responsible for, and what it can
        // reach. The owner is also a member of their own workspace, so the
        // two lists overlap by design.
        owned_workspaces: account.ownedWorkspaces.map((workspace) =>
          serializeWorkspaceForStaff({ ...workspace, owner: account }),
        ),
        memberships: account.memberships.map(serializeMembershipForStaff),
        recent_transactions: account.creditTransactions.map((row) => serializeLedgerRow(row)),
      },
    });
  }),
);

/**
 * The one write in this slice.
 *
 * The balance change and the ledger row are a single transaction, and there is
 * no path that writes one without the other — a balance nobody can account for
 * is the failure mode this endpoint exists to avoid.
 *
 * The balance is moved by a *conditional atomic update*, never by reading it
 * and writing back a number computed in Node. Read-modify-write loses under
 * concurrency in both directions: two grants each read the old balance and the
 * second overwrites the first, so a credit vanishes; two deductions each find
 * the balance sufficient and the account overdraws. Neither is caught by any
 * amount of checking before the write, because the value checked is already
 * stale by the time it is used. `increment` composes, and the sufficiency test
 * lives in the WHERE clause of the statement that applies the change — in READ
 * COMMITTED, a blocked UPDATE re-evaluates that clause against the row as the
 * other transaction left it, so it cannot pass against a balance that is gone.
 */
adminAccountRoutes.post(
  '/accounts/:accountId/credits',
  asyncHandler(async (req, res) => {
    const { amount, note, reference } = parseBody(adjustmentSchema, req.body);

    let delta: bigint;
    try {
      delta = parseSignedCredits(amount);
    } catch {
      // The parser's wording names internals; the caller acts on the code.
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        'amount must be a non-zero signed amount with at most 4 decimal places, e.g. "25" or "-0.5".',
      );
    }

    const accountId = req.params.accountId;

    const result = await prisma.$transaction(async (tx) => {
      const applied = await tx.account.updateMany({
        where: {
          id: accountId,
          // A grant needs no floor; a deduction may only apply to a balance
          // that still covers it. Expressed here rather than in a prior read
          // so the test and the write are one statement.
          ...(delta < 0n ? { credits: { gte: -delta } } : {}),
        },
        data: { credits: { increment: delta } },
      });

      if (applied.count === 0) {
        // Two ways to match nothing, and they are different answers. The read
        // is only reached on the refusal path, where its being a second
        // statement costs nothing.
        const account = await tx.account.findUnique({ where: { id: accountId } });

        if (!account) {
          throw new ApiError(404, 'NOT_FOUND', 'Account not found.');
        }

        throw new ApiError(
          422,
          'INSUFFICIENT_CREDITS',
          `That deduction is larger than the balance of ${toDisplayCredits(account.credits)}.`,
        );
      }

      // Inside the transaction, so this reads the row this transaction just
      // wrote and still holds the lock on.
      const updated = await tx.account.findUniqueOrThrow({ where: { id: accountId } });

      let transaction;
      try {
        transaction = await tx.creditTransaction.create({
          data: {
            accountId,
            amount: delta,
            type: 'ADJUSTMENT',
            note,
            reference: reference ?? null,
          },
        });
      } catch (err) {
        // The unique index on (accountId, reference) is what makes a resubmitted
        // form a duplicate rather than a second correction. Throwing here rolls
        // the balance change back with it — the alternative, a balance that
        // moved with no ledger row to explain it, is the one outcome this
        // endpoint exists to prevent.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          throw new ApiError(
            409,
            'DUPLICATE_REFERENCE',
            `An adjustment for this account already cites ${JSON.stringify(reference)}. Vary the reference if this is genuinely a second correction.`,
          );
        }

        throw err;
      }


      return { updated, transaction };
    });

    res.json({
      success: true,
      data: {
        account: {
          id: result.updated.id,
          email: result.updated.email,
          credits: toDisplayCredits(result.updated.credits),
        },
        transaction: serializeLedgerRow(result.transaction),
      },
    });
  }),
);

const superAdminSchema = z.object({ enabled: z.boolean() });

/**
 * When the flag the account carries now was granted: the newest GRANT row,
 * and null while the flag is off even if a GRANT once happened. The console
 * renders "Granted <date>" from this, and a date next to a flag that has since
 * been revoked would read as the opposite of what it is.
 */
async function superAdminGrantedAt(
  db: Prisma.TransactionClient,
  account: { id: string; isSuperAdmin: boolean },
): Promise<Date | null> {
  if (!account.isSuperAdmin) return null;
  const grant = await db.superAdminAction.findFirst({
    // `subjectAccountId`, not `accountId`: this asks when the flag was given
    // to them, not what they did with it. Scoped to `workspaceId: null` as
    // well, so only a console grant can ever answer — a request row cannot
    // carry the method anyway, but the constraint is free and says so.
    where: { subjectAccountId: account.id, method: 'GRANT', workspaceId: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { createdAt: true },
  });
  return grant?.createdAt ?? null;
}

/**
 * The one way the flag is set. Never reachable through a Clerk session: a
 * customer who could grant this to themselves would own every workspace on
 * the platform. Idempotent, and each real change is an audit row of its own.
 */
adminAccountRoutes.patch(
  '/accounts/:accountId/super-admin',
  asyncHandler(async (req, res) => {
    const { enabled } = parseBody(superAdminSchema, req.body);
    const accountId = req.params.accountId;

    const { account, grantedAt } = await prisma.$transaction(async (tx) => {
      // One conditional statement rather than read-then-write: two staff
      // clicking at once would otherwise both read "off", both write "on" and
      // both record a GRANT for one change. The WHERE makes the second a no-op.
      const changed = await tx.account.updateMany({
        where: { id: accountId, isSuperAdmin: !enabled },
        data: { isSuperAdmin: enabled },
      });

      if (changed.count === 1) {
        await tx.superAdminAction.create({
          data: {
            // No actor: the staff console authenticates with one shared
            // token, so the request genuinely does not say who clicked.
            // `subjectAccountId` is the account this was done TO — putting it
            // in `accountId` made the trail report a grant as something its
            // recipient had done.
            accountId: null,
            subjectAccountId: accountId,
            workspaceId: null,
            method: enabled ? 'GRANT' : 'REVOKE',
            path: `/api/admin/accounts/${accountId}/super-admin`,
            // Fixed rather than read off the response, unlike the bypass
            // path's 499 handling: the transaction has committed by the time
            // this row exists, so the change really did happen whatever the
            // client goes on to hear about it.
            status: 200,
          },
        });
      }

      // A zero count is either "already so" or "no such account", and only
      // the refusal path pays for telling them apart. The read is inside the
      // transaction so the row just written is the one answered with.
      const account = await tx.account.findUnique({
        where: { id: accountId },
        include: { _count: { select: { ownedWorkspaces: true, memberships: true } } },
      });
      if (!account) throw new ApiError(404, 'NOT_FOUND', 'Account not found.');

      return { account, grantedAt: await superAdminGrantedAt(tx, account) };
    });

    res.json({
      success: true,
      data: { ...serializeAccountForStaff(account), super_admin_granted_at: grantedAt },
    });
  }),
);

adminAccountRoutes.get(
  '/credit-transactions',
  asyncHandler(async (req, res) => {
    const pagination = parsePagination(req.query as Record<string, unknown>);
    const { accountId, type } = parseBody(ledgerFilterSchema, {
      accountId: req.query.accountId,
      type: req.query.type,
    });

    const where: Prisma.CreditTransactionWhereInput = {
      ...(accountId ? { accountId } : {}),
      ...(type ? { type } : {}),
    };

    const [rows, total] = await prisma.$transaction([
      prisma.creditTransaction.findMany({
        where,
        include: { account: true, callAttempt: LEDGER_CALL },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      prisma.creditTransaction.count({ where }),
    ]);

    res.json({ success: true, data: paginated(rows.map(serializeLedgerRow), total, pagination) });
  }),
);
