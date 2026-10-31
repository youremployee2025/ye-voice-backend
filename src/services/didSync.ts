import { Prisma } from '@prisma/client';
import { listPurchasedDids, voicelinkCallReady, type UpstreamRecord } from '../adapter/vocobase.js';
import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';
import { canonicalizeE164 } from '../lib/phone.js';
import { readDigits, readIdentifier, readPhoneValue, readString } from '../lib/upstream.js';

/**
 * Pulls the DIDs the platform's telephony connection has purchased into the
 * local inventory.
 *
 * The invariant that matters, and the mirror of the one the agent sync holds:
 * **sync owns provider facts, renting and staff own tenancy and billing.** The
 * upsert below must never write `workspaceId`, `status`, `monthlyPriceCredits`,
 * `rentedPriceCredits`, `rentedAt`, `nextRenewalAt` or `pastDueSince`. A
 * routine refresh that touched them would un-rent numbers customers are paying
 * for and leave the ledger recording charges for nothing.
 *
 * Staff-triggered only. Nothing here purchases, maps or releases a DID
 * upstream, and nothing here spends money.
 *
 * **One exception, and it is deliberate:** a DID this sweep *imports* is then
 * made call-ready, which creates the bot and outbound routing upstream that
 * turn a number in the inventory into a number that can dial. Only on import,
 * never on refresh, and never for a row that was already here — see
 * `provisionImported` at the foot of this file. `VOICELINK_AUTO_CALL_READY`
 * turns it off and restores the read-only sweep.
 */

/** Upstream accepts up to 1000; 200 keeps a page comfortably small. */
const PER_PAGE = 200;

/** Backstop against a listing that never ends. */
const MAX_PAGES = 50;

export interface DidSyncOptions {
  /** Page-walk backstop. Overridable so the truncation path is testable
   *  without forcing fifty real pages through the mirror. */
  maxPages?: number;
}

export interface DidSyncResult {
  /** Rows created. */
  imported: number;
  /** Existing rows whose provider facts were refreshed. */
  updated: number;
  /** Rows skipped: no provider id, or a number that would not canonicalize. */
  skipped: number;
  /** Rows whose number is already held in the inventory under another id. */
  conflicts: number;
  /** Rows that errored for some other reason. Non-zero means a partial run. */
  failed: number;
  /**
   * True when the page walk stopped at the backstop rather than at the end of
   * the listing, so the mirror is knowingly partial. Reported because a
   * truncated walk otherwise looks exactly like a complete one.
   */
  truncated: boolean;
  /** Newly imported DIDs upstream reports as ready to place a call. */
  provisioned: number;
  /**
   * Newly imported DIDs upstream accepted but does not consider ready — one
   * still needing a client mapping, say.
   *
   * Counted apart from a failure because it is not one: the call succeeded and
   * upstream answered honestly. Counted apart from a success because the
   * number still cannot dial, and a run reporting it as provisioned would be
   * saying the opposite of what it was told.
   */
  provisionUnready: number;
  /** Newly imported DIDs whose provisioning call errored. The row is kept. */
  provisionFailed: number;
  /**
   * DIDs a workspace is renting that upstream no longer lists.
   *
   * Reconciling them needs a policy nobody has written — deleting or
   * un-renting on one bad sync would be worse than leaving them. But the
   * charging half of this shipped without the divergence half, which means a
   * customer can be billed every month for a number that no longer exists and
   * nothing anywhere says so. Naming them is the least this can do.
   */
  unseenAssigned: string[];
}

/** The provider sends a bare date ("2026-08-31"). An unparseable one is
 *  absent rather than an Invalid Date, which Prisma would reject at write. */
function readDate(value: string | null): Date | null {
  if (!value) return null;

  const at = new Date(value);
  return Number.isFinite(at.getTime()) ? at : null;
}

/** Prisma's unique-constraint violation, and which column it was on. */
function uniqueViolationTarget(err: unknown): string[] | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return null;

  const target = err.meta?.target;
  if (Array.isArray(target)) return target.filter((f): f is string => typeof f === 'string');
  if (typeof target === 'string') return [target];

  // Unknown, not "definitely externalId". An empty array is truthy, so
  // returning one sent a collision whose column Prisma did not name into the
  // concurrent-create branch below — where the blind update re-threw P2002
  // uncaught and took the whole run with it, discarding the counters for every
  // row already written.
  return null;
}

/** The columns sync owns. Tenancy and billing are deliberately not among them. */
function providerFields(row: UpstreamRecord, did: string) {
  return {
    did,
    provider: 'voicelink',
    countryCode: readDigits(row, ['country_code', 'countryCode']),
    numberType: readString(row, ['type_label', 'typeLabel', 'did_type_label']),
    providerStatus: readString(row, ['status_label', 'statusLabel', 'status']),
    providerExpiresAt: readDate(readString(row, ['expiry_date', 'expiryDate', 'user_expiry_date'])),
    rawProvider: row as Prisma.InputJsonValue,
    lastSyncedAt: new Date(),
  };
}

/**
 * The same facts, minus the ones this payload did not carry.
 *
 * `providerFields` always returns every key, with `null` where a reader found
 * nothing — correct on create, wrong on update. A refresh where upstream
 * omitted `expiry_date`, or sent `status` as a number so `readString` declined
 * it, cleared a known-good value and left the staff console unable to tell
 * "the provider says no expiry" from "that page of the response was thin".
 *
 * `did` and `lastSyncedAt` are never dropped: one is the row's identity and
 * the other is the whole point of the write.
 */
function refreshableFields(fields: ReturnType<typeof providerFields>) {
  const { did, provider, rawProvider, lastSyncedAt, ...optional } = fields;

  return {
    did,
    provider,
    rawProvider,
    lastSyncedAt,
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== null)),
  };
}

/**
 * Walks the purchased listing.
 *
 * Ends on the reported last page, or — only when upstream reports none — on a
 * short page, or at the backstop.
 *
 * The order matters. Checking the short page first meant the heuristic
 * overruled the fact: upstream capping `per_page` at 100 while this asked for
 * 200 ended the walk on page 1 with `last_page: 5`, mirroring a fifth of the
 * estate and reporting a clean run. The comment above `PER_PAGE` guesses at a
 * limit for a listing whose shape has already moved once, which is exactly the
 * kind of guess that should not get to decide when to stop.
 */
async function fetchPurchased(
  maxPages: number,
): Promise<{ rows: UpstreamRecord[]; truncated: boolean }> {
  const collected: UpstreamRecord[] = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const { rows, lastPage } = await listPurchasedDids({ page, perPage: PER_PAGE });
    collected.push(...rows);

    if (lastPage !== null) {
      if (page >= lastPage) return { rows: collected, truncated: false };
    } else if (rows.length < PER_PAGE) {
      return { rows: collected, truncated: false };
    }
  }

  return { rows: collected, truncated: true };
}

export async function syncPurchasedDids({
  maxPages = MAX_PAGES,
}: DidSyncOptions = {}): Promise<DidSyncResult> {
  const result: DidSyncResult = {
    imported: 0,
    updated: 0,
    skipped: 0,
    conflicts: 0,
    failed: 0,
    truncated: false,
    provisioned: 0,
    provisionUnready: 0,
    provisionFailed: 0,
    unseenAssigned: [],
  };

  // Collected during the walk and provisioned after it. Doing it inline would
  // put a live telephony write between two rows of a mirror refresh, so one
  // slow or hanging call would stall every row behind it.
  const imported: string[] = [];

  // The fetch completes before a single row is written, so a page-3-of-5
  // failure leaves the mirror exactly as it was rather than half-refreshed.
  const { rows: upstreamRows, truncated } = await fetchPurchased(maxPages);
  result.truncated = truncated;

  if (truncated) {
    console.error(
      `DID sync stopped at the ${maxPages}-page backstop; the mirror is partial.`,
    );
  }

  const seenExternalIds = new Set<string>();

  for (const row of upstreamRows) {
    // Without a provider id there is nothing stable to match on across runs,
    // so the row would be re-created on every sync.
    const externalId = readIdentifier(row, ['id', 'did_id', 'didId']);

    // The same canonicalizer contact uploads use, gated on validity. A number
    // that will not parse is skipped and counted, never stored: prepending a
    // bare '+' to whatever arrived mints a plausible-looking fake that fails
    // at dial time, far from the sync that invented it.
    const raw = readPhoneValue(row, ['did_number', 'didNumber', 'phone_number', 'number', 'did']);
    const did = raw ? canonicalizeE164(raw) : null;

    if (!externalId || !did) {
      // Logged, not merely counted. Every silent-skip path used to be visible
      // only as a number in a 200 response, so a listing that changed shape
      // and skipped all of it was indistinguishable from a healthy no-op.
      console.error(
        `Skipping a purchased DID: ${externalId ? `id ${externalId}` : 'no provider id'}, ` +
          `number ${JSON.stringify(raw)}`,
      );
      result.skipped += 1;
      continue;
    }

    seenExternalIds.add(externalId);

    const fields = providerFields(row, did);

    try {
      const existing = await prisma.phoneNumber.findUnique({
        where: { externalId },
        select: { id: true, did: true, workspaceId: true },
      });

      // A DID re-issued under the same provider id: same row, different
      // number. `did` is a provider fact, but it is the one a customer is
      // billed against — the ledger renders `phoneNumber.did`, so rewriting it
      // under a live rental retroactively changes which number every past
      // charge appears to have been for. The reverse case (same number, new
      // provider id) is already treated as a question for a person; this is
      // the same question from the other side.
      if (existing && existing.workspaceId && existing.did !== did) {
        console.error(
          `DID ${existing.did} (provider id ${externalId}) now lists as ${did} while rented; skipping.`,
        );
        result.conflicts += 1;
        continue;
      }

      await prisma.phoneNumber.upsert({
        where: { externalId },
        // Tenancy and billing columns are omitted, not set. See the header.
        update: refreshableFields(fields),
        create: { externalId, ...fields },
      });

      if (existing) {
        result.updated += 1;
      } else {
        result.imported += 1;
        imported.push(did);
      }
    } catch (err) {
      const target = uniqueViolationTarget(err);

      if (!target) {
        // Not a unique violation, or one whose column Prisma did not name.
        // Counted and carried on: every row already written stays written, and
        // re-throwing here discarded the whole result for one bad row.
        console.error(`Could not mirror DID ${did}:`, err);
        result.failed += 1;
        continue;
      }

      // The number is already in the inventory under a different provider id —
      // a DID re-issued upstream. Counted and reported rather than thrown, so
      // one odd number cannot fail the whole run, and never silently rewritten:
      // which row is the real one is a question for a person.
      if (target.includes('did')) {
        console.error(`DID ${did} is already held under another provider id; skipping.`);
        result.conflicts += 1;
        continue;
      }

      // `upsert` is find-then-write, not atomic: two concurrent syncs can both
      // miss the row and both take the create branch. The row the loser
      // collided with is the one it wanted.
      try {
        await prisma.phoneNumber.update({
          where: { externalId },
          data: refreshableFields(fields),
        });
        result.updated += 1;
      } catch (retryErr) {
        console.error(`Could not mirror DID ${did} after a unique violation:`, retryErr);
        result.failed += 1;
      }
      continue;
    }
  }

  // Rows upstream no longer lists are still left alone: deciding what happens
  // to a DID that vanished while a workspace is paying for it is a policy
  // nobody has written, and un-renting or deleting on the strength of one sync
  // would be a worse answer than none.
  //
  // But the charging half of this shipped without the divergence half. The
  // renewal sweep filters on `status` and `nextRenewalAt` and consults no
  // provider fact at all, so a number that lapsed upstream keeps billing its
  // renter every month, forever, and the only trace is a `lastSyncedAt` going
  // stale where nobody is looking. Naming them is the least this can do, and
  // it is what a policy would be written against.
  //
  // Skipped when the walk was truncated: a partial listing makes every
  // unvisited row look vanished, which would turn a backstop into a false
  // alarm about paid-for numbers.
  if (!truncated) {
    const assigned = await prisma.phoneNumber.findMany({
      where: { workspaceId: { not: null } },
      select: { did: true, externalId: true },
    });

    result.unseenAssigned = assigned
      .filter(({ externalId }) => externalId === null || !seenExternalIds.has(externalId))
      .map(({ did }) => did);

    if (result.unseenAssigned.length > 0) {
      console.error(
        `Upstream no longer lists ${result.unseenAssigned.length} rented DID(s), still being ` +
          `billed monthly: ${result.unseenAssigned.join(', ')}`,
      );
    }
  }

  await provisionImported(imported, result);

  return result;
}

/**
 * Makes each newly imported DID able to place a call.
 *
 * Upstream's `call-ready` resolves the DID, imports it, ensures the client's
 * WebSocket bot exists and points at the platform, and ensures outbound
 * routing points at that bot. Without it a number is in the inventory and in
 * the caller-id picker while every campaign using it is refused at start, with
 * an error about VoiceLink rather than about the number.
 *
 * **Only the rows this pass created.** Re-running it over the whole inventory
 * every hour would turn a mirror refresh into a steady stream of writes
 * against a live telephony account, on numbers that were already ready.
 *
 * **`client_id` is never sent**, which is why an unmapped DID comes back
 * `ready: false` rather than being mapped here. Mapping is the one step of
 * this workflow that is not idempotent in a recoverable direction, and this
 * service shares a partner account; the connection id the adapter pins is a
 * deployment fact, a client id would be a guess about somebody's tenancy.
 *
 * Sequential rather than concurrent: each call provisions a bot and routing
 * upstream, and a burst of those against a shared account is how a first sync
 * of a large inventory becomes somebody else's incident.
 *
 * Failures are counted, never thrown. The mirror is the product of this sweep
 * and it is already written; losing it because one number could not be
 * provisioned would be the wrong trade.
 */
async function provisionImported(dids: string[], result: DidSyncResult): Promise<void> {
  if (!env.voicelinkAutoCallReady || dids.length === 0) return;

  for (const did of dids) {
    try {
      const verdict = await voicelinkCallReady(did);

      if (verdict.ready) {
        result.provisioned += 1;
        continue;
      }

      // Accepted and honestly not ready. Named rather than counted as a
      // failure, because the thing to do about it is look at the number.
      result.provisionUnready += 1;
      const issues = verdict.readiness?.issues ?? [];
      console.warn(
        `[dids] imported ${did} is not call-ready` +
          (verdict.readiness?.state ? ` (${verdict.readiness.state})` : '') +
          (issues.length > 0 ? `: ${issues.join(', ')}` : ''),
      );
    } catch (err) {
      result.provisionFailed += 1;
      console.error(`[dids] could not make imported ${did} call-ready:`, err);
    }
  }
}
