import type { Workspace } from '@prisma/client';
import { createPartnerCustomer } from '../adapter/vocobase.js';
import { prisma } from './prisma.js';
import { ApiError } from './errors.js';

/**
 * The workspace's customer on the voice platform, created the first time it is
 * needed.
 *
 * Upstream, OAuth connections belong to a **partner customer**, and the
 * partner account is YE as a whole — so without a customer per workspace
 * every Google token in the pool would belong to YE, and which workspace
 * consented to which mailbox would be a mapping row and nothing more. With
 * one, `GET /customers/:id/connections` is an authoritative answer to "is this
 * connection theirs", which is what the connect return leg checks before it
 * maps anything (design §2).
 *
 * Created lazily rather than at workspace creation: the overwhelming majority
 * of workspaces never connect anything, and a customer per workspace minted up
 * front is a row upstream, a failure mode during signup, and a migration for
 * every workspace that already exists.
 */

/** Upstream's cap on `name`; past it the create is a 400. */
const MAX_NAME = 200;

/**
 * One create per workspace in flight at a time.
 *
 * Two admins clicking *Connect* at the same moment — or one admin
 * double-clicking — otherwise both find `partnerCustomerId` null and both post
 * a create. Upstream de-duplicates on `external_id`, so the outcome is already
 * correct; this makes it *quiet*, which matters because the alternative is a
 * second write to the partner account for every impatient click.
 *
 * Per process, not a lock: two dynos racing still produce two creates and the
 * same right answer. This is a courtesy, and the compare-and-set below is what
 * makes the result correct.
 */
const inFlight = new Map<string, Promise<string>>();

export async function ensurePartnerCustomer(workspace: Workspace): Promise<string> {
  if (workspace.partnerCustomerId) return workspace.partnerCustomerId;

  // The row on `req` was loaded at the top of the request, so its null may be
  // minutes old and somebody else may have connected in between. Cheaper to
  // re-read than to mint a customer nobody needed.
  const fresh = await prisma.workspace.findUnique({
    where: { id: workspace.id },
    select: { partnerCustomerId: true, name: true },
  });

  if (fresh?.partnerCustomerId) return fresh.partnerCustomerId;

  const existing = inFlight.get(workspace.id);
  if (existing) return existing;

  const pending = create(workspace.id, fresh?.name ?? workspace.name).finally(() => {
    // Cleared whether it resolved or threw. A cached rejection would make one
    // lost response permanent for the life of the process.
    inFlight.delete(workspace.id);
  });

  inFlight.set(workspace.id, pending);

  return pending;
}

async function create(workspaceId: string, name: string): Promise<string> {
  const customer = await createPartnerCustomer({
    external_id: workspaceId,
    name: name.slice(0, MAX_NAME),
  });

  const customerId = typeof customer.id === 'string' ? customer.id.trim() : '';
  if (!customerId) {
    throw new ApiError(
      502,
      'UPSTREAM_ERROR',
      'The voice platform did not return a customer for this workspace.',
    );
  }

  /**
   * Compare-and-set, not a plain update.
   *
   * The write must not clobber an id somebody else stored while this create
   * was in flight: two processes racing both hold a valid id — the same one,
   * since upstream is idempotent on `external_id` — but only one of them may
   * be the value of record, and the loser has to go and read it rather than
   * assume its own copy won.
   */
  const claimed = await prisma.workspace
    .updateMany({
      where: { id: workspaceId, partnerCustomerId: null },
      data: { partnerCustomerId: customerId },
    })
    .catch((err: unknown) => {
      // P2002: this id is already stored — against some workspace. Whose is
      // settled below by reading, because the two cases have opposite answers.
      if (isUniqueViolation(err)) return { count: 0 };
      throw err;
    });

  if (claimed.count > 0) return customerId;

  const stored = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { partnerCustomerId: true },
  });

  if (stored?.partnerCustomerId) return stored.partnerCustomerId;

  /**
   * Nothing was written and this workspace still has no customer, so the id
   * upstream just returned is stored against a *different* workspace.
   *
   * Nothing legitimate produces that: the create is keyed by workspace id, so
   * two workspaces cannot share a customer unless the platform handed back
   * somebody else's — or a database was restored across a platform account.
   * Refusing is the only safe answer. Writing it anyway would take the other
   * workspace's connections away from it, and with the mapping rows still in
   * place nothing downstream would notice.
   */
  console.error(
    `Voice platform returned customer ${customerId} for workspace ${workspaceId}, ` +
      'but it is already held by another workspace. Refusing to claim it.',
  );

  throw new ApiError(
    502,
    'UPSTREAM_ERROR',
    'This workspace could not be linked to the voice platform. Contact support rather than trying again.',
  );
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
