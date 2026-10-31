import { Router, type Request } from 'express';
import { z } from 'zod';
import type { PhoneNumber } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js';
import { requireMembership, workspaceOf } from '../middleware/workspace.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { parseBody } from '../lib/validate.js';
import { paginated, parsePagination } from '../lib/pagination.js';
import { toDisplayCredits } from '../lib/credits.js';
import {
  assignedTiers,
  BILLING_INCREMENT_MIN,
} from '../lib/tierPricing.js';
import {
  serializeAvailablePhoneNumber,
  serializeLedgerRow,
  LEDGER_CALL,
  serializePhoneNumber,
} from '../lib/serialize.js';
import {
  projectUpcomingRenewals,
  type UpcomingRenewals,
} from '../services/billingProjection.js';
import {
  InsufficientCreditsError,
  PhoneNumberNotHeldError,
  PhoneNumberTakenError,
  chargePriceOf,
  priceOf,
  releasePhoneNumber,
  rentPhoneNumber,
} from '../services/didRental.js';

/**
 * Phone numbers and billing for one workspace.
 *
 * Any member may read the workspace's numbers, the shared pool, and nothing
 * else. Renting, releasing and reading the ledger are ADMIN — they move money
 * or reveal what has been spent.
 */
export const phoneNumberRoutes: Router = Router();

/**
 * Resolves the DID named in the route, scoped to the caller's workspace.
 *
 * Ownership is part of the lookup rather than a check after it, so there is no
 * path where a handler holds a number it was not entitled to. A number in
 * another workspace is reported exactly as one that does not exist: a 403
 * would confirm the id is real.
 */
async function phoneNumberInWorkspace(req: Request): Promise<PhoneNumber> {
  const didId = req.params.didId;

  // Prisma DROPS an `undefined` filter rather than matching nothing, so an
  // absent id here would return an arbitrary number from the workspace instead
  // of 404ing. Express cannot currently route to these handlers without the
  // parameter, which is exactly why the failure would be silent if it ever
  // could.
  if (!didId) {
    throw new ApiError(404, 'NOT_FOUND', 'Phone number not found.');
  }

  const number = await prisma.phoneNumber.findFirst({
    where: { id: didId, workspaceId: workspaceOf(req).id },
  });

  if (!number) {
    throw new ApiError(404, 'NOT_FOUND', 'Phone number not found.');
  }

  return number;
}

phoneNumberRoutes.get(
  '/:workspaceId/phone-numbers',
  requireAuth,
  requireMembership(),
  asyncHandler(async (req, res) => {
    const numbers = await prisma.phoneNumber.findMany({
      where: { workspaceId: workspaceOf(req).id },
      orderBy: { did: 'asc' },
    });

    res.json({
      success: true,
      // `chargePriceOf`, not `priceOf`: this workspace is billed the price it
      // agreed to when it rented, and showing today's catalog price would
      // quote them a number their next renewal will not match.
      data: numbers.map((number) => serializePhoneNumber(number, chargePriceOf(number))),
    });
  }),
);

/**
 * The shared pool.
 *
 * `workspaceId: null` is the whole condition: a number released for
 * non-payment is unowned too, and differs from an untouched one only in
 * carrying the reason it became free. Renting either clears the marker.
 *
 * Registered before `/:didId`, or Express matches "available" as a DID id.
 */
phoneNumberRoutes.get(
  '/:workspaceId/phone-numbers/available',
  requireAuth,
  requireMembership(),
  asyncHandler(async (_req, res) => {
    const numbers = await prisma.phoneNumber.findMany({
      where: { workspaceId: null },
      orderBy: { did: 'asc' },
    });

    res.json({
      success: true,
      data: numbers.map((number) => serializeAvailablePhoneNumber(number, priceOf(number))),
    });
  }),
);

phoneNumberRoutes.post(
  '/:workspaceId/phone-numbers/:didId/rent',
  requireAuth,
  requireMembership('ADMIN'),
  asyncHandler(async (req, res) => {
    // Deliberately not scoped through `phoneNumberInWorkspace`: renting acts
    // on the pool, and the service's conditional claim is what settles
    // ownership. A pre-check here would be a read the claim then has to
    // re-establish anyway.
    try {
      const rented = await rentPhoneNumber({
        phoneNumberId: req.params.didId!,
        workspace: workspaceOf(req),
      });

      res.json({ success: true, data: serializePhoneNumber(rented, priceOf(rented)) });
    } catch (err) {
      // A DID that never existed and one somebody else just took are reported
      // the same way, on purpose: both mean "not yours to rent", and telling
      // them apart would let a caller enumerate ids.
      if (err instanceof PhoneNumberTakenError) {
        throw new ApiError(409, 'PHONE_NUMBER_TAKEN', 'That number is no longer available.');
      }

      if (err instanceof InsufficientCreditsError) {
        throw new ApiError(
          402,
          'INSUFFICIENT_CREDITS',
          'This workspace does not have enough credits to rent that number.',
        );
      }

      throw err;
    }
  }),
);

phoneNumberRoutes.post(
  '/:workspaceId/phone-numbers/:didId/release',
  requireAuth,
  requireMembership('ADMIN'),
  asyncHandler(async (req, res) => {
    // Confirms the number is this workspace's before the release, so a foreign
    // id 404s the same way every other scoped lookup does.
    await phoneNumberInWorkspace(req);

    try {
      const released = await releasePhoneNumber({
        phoneNumberId: req.params.didId!,
        workspace: workspaceOf(req),
      });

      res.json({ success: true, data: serializePhoneNumber(released, priceOf(released)) });
    } catch (err) {
      // Lost a race with the renewal sweep or a second click.
      if (err instanceof PhoneNumberNotHeldError) {
        throw new ApiError(404, 'NOT_FOUND', 'Phone number not found.');
      }

      throw err;
    }
  }),
);

const ledgerQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * The workspace's billing: the owner's balance and this workspace's ledger.
 *
 * The balance is the **owner's**, not the caller's — an ADMIN who is not the
 * owner would otherwise be shown their own credits beside charges that will
 * never touch them.
 *
 * The ledger is filtered on `CreditTransaction.workspaceId`, the snapshot
 * taken when the row was written, not on the DID's current workspace. That is
 * what keeps a released number's history on the workspace that paid for it.
 */
phoneNumberRoutes.get(
  '/:workspaceId/billing',
  requireAuth,
  requireMembership('ADMIN'),
  asyncHandler(async (req, res) => {
    const workspace = workspaceOf(req);
    const { cursor, limit } = parseBody(ledgerQuerySchema, req.query);

    // A cursor naming a row this workspace cannot see — stale, mistyped, or
    // another workspace's — used to come back as a normal empty page, which
    // reads as "no more history" rather than "that link is no longer valid".
    // Scoped to the workspace, so it cannot double as an existence oracle for
    // somebody else's transaction ids.
    if (cursor) {
      const anchor = await prisma.creditTransaction.findFirst({
        where: { id: cursor, workspaceId: workspace.id },
        select: { id: true },
      });

      if (!anchor) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'That page cursor is no longer valid.');
      }
    }

    const [owner, rows] = await Promise.all([
      prisma.account.findUniqueOrThrow({
        where: { id: workspace.ownerAccountId },
        select: { credits: true },
      }),
      prisma.creditTransaction.findMany({
        where: { workspaceId: workspace.id },
        include: { phoneNumber: true, callAttempt: LEDGER_CALL },
        orderBy: { createdAt: 'desc' },
        take: limit + 1, // the extra row tells us whether another page exists
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    ]);

    const page = rows.slice(0, limit);

    // Sequenced after the balance rather than beside it: the projection is
    // measured against that exact number, and two reads taken at different
    // instants could report a shortfall against a balance the payload does
    // not show.
    //
    // Caught rather than propagated. This route is the balance, and the phone
    // numbers rent dialog reads it with `?limit=1` for that one field; letting
    // a projection failure 500 the whole payload would take the balance card
    // and the rent dialog down with it — the same coupling that splitting the
    // ledger onto its own route exists to avoid. `upcoming: null` is a panel
    // that could not be computed, which is what happened, and is a state every
    // consumer of this field already has to render while the request is in
    // flight.
    let upcoming: UpcomingRenewals | null = null;

    try {
      upcoming = await projectUpcomingRenewals(
        workspace.id,
        workspace.ownerAccountId,
        owner.credits,
      );
    } catch (err) {
      console.error(
        `Renewal projection failed for workspace ${workspace.id}; ` +
          `balance answered without it.`,
        err,
      );
    }

    res.json({
      success: true,
      data: {
        balance: toDisplayCredits(owner.credits),
        /**
         * Whose balance that is. An ADMIN who is not the owner is being shown
         * somebody else's number, and the payload says so rather than leaving
         * the dashboard to infer it from a workspace lookup it would have to
         * make separately.
         */
        owner_account_id: workspace.ownerAccountId,
        /**
         * What the coming window costs, and whether the balance stretches to
         * it. Decided in BigInt by `billingProjection.ts` and emitted as
         * decimal strings, like every other credit value that crosses this
         * API — the comparison must not happen in a browser.
         */
        upcoming: upcoming && {
          window_days: upcoming.windowDays,
          renewal_count: upcoming.renewalCount,
          unscheduled_count: upcoming.unscheduledCount,
          total_credits: toDisplayCredits(upcoming.totalCredits),
          /**
           * The same window across every workspace the owner account owns.
           * `covers` is judged against this, not against `total_credits`: one
           * balance funds all of an owner's workspaces, so a per-workspace
           * comparison would report `covers: true` on two pages at once while
           * the account is short enough to lose a number on both.
           *
           * Equal to `total_credits` whenever the account owns one workspace,
           * which is the common case — a surface can show the second figure
           * only when the two differ.
           */
          account_total_credits: toDisplayCredits(upcoming.accountTotalCredits),
          covers: upcoming.covers,
          shortfall_credits:
            upcoming.shortfallCredits === null
              ? null
              : toDisplayCredits(upcoming.shortfallCredits),
        },
        // Superseded by `/billing/transactions`, which paginates by offset and
        // filters. Kept verbatim, cursor and all, because the phone-numbers
        // page reads `balance` off this route with `?limit=1` and a payload
        // that dropped fields would break a surface this slice does not touch.
        // Remove them in the change that removes the last reader.
        ledger: page.map(serializeLedgerRow),
        nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
      },
    });
  }),
);


/**
 * A calendar day, as `YYYY-MM-DD`.
 *
 * Narrow on purpose. `z.coerce.date()` alone accepts anything `new Date()`
 * accepts, which includes locale-dependent spellings and full timestamps with
 * an offset — so the same filter would select different rows depending on who
 * typed it. A day is what this control offers, and UTC is how every other date
 * in this system is read.
 */
const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date as YYYY-MM-DD')
  .transform((day) => ({ day, date: new Date(`${day}T00:00:00.000Z`) }))
  /**
   * Round-trip, not `Number.isFinite`.
   *
   * V8 rejects a month past 12 and a day past 31, so a finiteness check catches
   * `2026-13-01` and `2026-01-32`. It does not catch a day that is impossible
   * only for its month: `2026-02-31` parses, and parses to **3 March**. A
   * finiteness check therefore let `?to=2026-02-31` return March rows under a
   * February heading, and let `?from=2026-04-31&to=2026-04-31` mean 1 May — a
   * typo answered with a different month's ledger, silently. It also defeated
   * the `from > to` guard below, which compares dates that have already
   * rolled.
   *
   * Formatting the parsed date back out and requiring it to equal what was
   * typed is the only check that rejects a rolled date, because rolling is
   * precisely what changes it.
   */
  .refine(({ day, date }) => date.toISOString().slice(0, 10) === day, 'must be a real date')
  .transform(({ date }) => date);

const transactionFilterSchema = z.object({
  type: z
    .enum(['DID_PURCHASE', 'DID_RENEWAL', 'DID_RELEASE', 'DID_RELEASE_NONPAYMENT', 'ADJUSTMENT'])
    .optional(),
  from: isoDay.optional(),
  to: isoDay.optional(),
});

/**
 * The workspace's transaction history: filtered, and paginated by offset.
 *
 * A sibling of `/billing` rather than part of it, because the two change at
 * different rates and for different reasons. The balance card is read once per
 * page load; this table re-reads on every filter click and page step. Served
 * from one route, a ledger failure would take the balance card down with it —
 * which is exactly the failure the phone-numbers page had to unpick when
 * billing shared a `Promise.all` with the number lists.
 */
phoneNumberRoutes.get(
  '/:workspaceId/billing/transactions',
  requireAuth,
  requireMembership('ADMIN'),
  asyncHandler(async (req, res) => {
    const workspace = workspaceOf(req);
    const pagination = parsePagination(req.query as Record<string, unknown>);
    const { type, from, to } = parseBody(transactionFilterSchema, {
      type: req.query.type,
      from: req.query.from,
      to: req.query.to,
    });

    // Always a mistake, and an empty table would read as "no history in this
    // period" — a different claim from "that range is backwards".
    if (from && to && from > to) {
      throw new ApiError(400, 'VALIDATION_ERROR', '`from` must not be after `to`.');
    }

    // `to` names a whole day. A bare `lte` on its midnight silently drops
    // every row from the day the reader actually asked for.
    const until = to ? new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1) : undefined;

    const where = {
      /**
       * This workspace's own movements, plus the grants that funded them.
       *
       * A staff grant credits an **Account** and carries no workspaceId, so
       * the first arm alone shows a customer every charge and never the top-up
       * that paid for it — a history whose lines cannot add up to the balance
       * printed above it.
       *
       * The account is the **owner's**, not the caller's: an ADMIN's own
       * credits are not this page's subject. And `type: 'ADJUSTMENT'` is a
       * whitelist rather than a shorthand — a future writer that records
       * something else against an Account with no workspace does not become
       * customer-visible by default.
       */
      OR: [
        { workspaceId: workspace.id },
        {
          accountId: workspace.ownerAccountId,
          type: 'ADJUSTMENT' as const,
          // The two clauses that make the paragraph above enforceable rather
          // than merely intended. "A staff adjustment credits an Account and
          // carries no workspaceId" is this arm's whole premise, so it is
          // asserted here instead of assumed of every future writer: without
          // them, an adjustment attributed to a *sibling* workspace — same
          // owner, different team — is returned to this one, carrying that
          // workspace's DID, note and invoice reference through
          // `serializeLedgerRow`. That is the one disclosure the design rules
          // out ("DID rows stay filtered to their own workspace"), and nothing
          // but these two lines was stopping it.
          workspaceId: null,
          phoneNumberId: null,
        },
      ],
      ...(type ? { type } : {}),
      ...(from || until
        ? { createdAt: { ...(from ? { gte: from } : {}), ...(until ? { lte: until } : {}) } }
        : {}),
    };

    // The page and the count it is a page of, in parallel — the count is what
    // lets the table say "1–25 of 63" instead of asking the reader to click
    // until it stops.
    const [rows, total] = await Promise.all([
      prisma.creditTransaction.findMany({
        where,
        include: { phoneNumber: true, callAttempt: LEDGER_CALL },
        // The tiebreaker is not decoration. Rows written inside one
        // transaction share a `createdAt` to the millisecond, and an unstable
        // sort under offset pagination shows the same row on two pages while
        // hiding another entirely.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: pagination.skip,
        take: pagination.take,
      }),
      prisma.creditTransaction.count({ where }),
    ]);

    res.json({
      success: true,
      data: paginated(rows.map(serializeLedgerRow), total, pagination),
    });
  }),
);

/**
 * What this workspace is charged per minute of calling.
 *
 * A sibling of `/billing` for the same reason `/billing/transactions` is: the
 * two answer different questions, fail independently, and a plan lookup that
 * cannot be served must not take the balance card down with it.
 *
 * **Minutes are billed**, and `metered: true` says so. The flag read `false`
 * while a rate card was all this surface had; leaving it would print "calling
 * is not billed yet" above a history that lists the charges. The flag rather
 * than a sentence, still: the wording is the dashboard's, the fact is this
 * service's.
 *
 * Each tier carries the **increment its calls are billed in**, because a rate
 * per minute without one does not describe the bill: at a 60-second increment
 * a 47-second call costs a full minute, and a customer who can see only the
 * rate cannot reconcile that against their own history. It is never null —
 * per-second billing is the increment of one, not the absence of one — so the
 * dashboard has one sentence to write rather than a sentence and a gap.
 *
 * The plan is the **owner account's**, like the balance above it. An ADMIN who
 * is not the owner is reading somebody else's rate, which is the same thing
 * they are already doing with the balance and the renewal projection.
 *
 * Three things this payload deliberately does not carry:
 *
 * - **Any mark distinguishing a per-account price from the list price.** It is
 *   the customer's rate. A "custom" or "discounted" badge invites the question
 *   of what everyone else pays, which is not theirs to learn here.
 * - **Any mark saying a tier is the platform default.** An account with no
 *   assignment of its own is on the default; that is a fact about how this
 *   system is arranged, not about their plan.
 * - **A rate for a tier nobody has priced.** `null`, never `"0"` — zero is a
 *   price somebody set, and telling a customer their calls are free is the one
 *   wrong answer with a bill attached.
 * - **Any mark saying an increment came from an override.** Same rule as the
 *   rate: it is how their calls are billed, and what everybody else is billed
 *   in is not theirs to learn here.
 */
phoneNumberRoutes.get(
  '/:workspaceId/billing/plan',
  requireAuth,
  requireMembership('ADMIN'),
  asyncHandler(async (req, res) => {
    const workspace = workspaceOf(req);

    const held = await assignedTiers(workspace.ownerAccountId);

    // An account with no assignment of its own is on the platform default —
    // resolved here rather than by the reader, so the card has one shape.
    const rows = held.length
      ? held
      : await prisma.tier
          .findFirst({ where: { isDefault: true, status: 'ACTIVE' } })
          .then((tier) =>
            tier ? [{ tier, priceCreditsPerMin: null, billingIncrementSecs: null }] : [],
          );

    res.json({
      success: true,
      data: {
        tiers: rows.map(({ tier, priceCreditsPerMin, billingIncrementSecs }) => {
          const rate = priceCreditsPerMin ?? tier.defaultPriceCreditsPerMin;

          return {
            slug: tier.slug,
            name: tier.name,
            // Lowercased to match every other status this API emits to a
            // customer. A tier the platform no longer offers is listed rather
            // than dropped: a plan card that quietly loses a line is how
            // somebody discovers a change by not noticing it.
            status: tier.status.toLowerCase(),
            rate_credits_per_min: rate === null ? null : toDisplayCredits(rate),
            /**
             * The same walk `resolveTierPricing` makes — account override,
             * then the tier's own, then one second. Resolved here rather than
             * by the reader so the card has one shape and no consumer has to
             * reproduce a precedence chain that lives in the backend.
             */
            billing_increment_secs:
              billingIncrementSecs ??
              tier.billingIncrementSecs ??
              BILLING_INCREMENT_MIN,
          };
        }),
        /** True: the dialer prices and charges every call it places. */
        metered: true,
      },
    });
  }),
);
