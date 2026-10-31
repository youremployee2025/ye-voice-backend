import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { IN_FLIGHT } from '../lib/concurrency.js';

/**
 * Moving one campaign from one workspace to another — a staff action, not a
 * customer one.
 *
 * ## What does not move
 *
 * Call history and ledger rows stay with the source. `CallAttempt.workspaceId`
 * is a dial-time snapshot, exactly as `CreditTransaction` snapshots its
 * workspace, and both comments say why: deriving either later would make a
 * campaign's billing history follow whoever owns the workspace now. Rewriting
 * them is ruled out by the same contract that rules out hard-deleting a
 * workspace.
 *
 * ## What moves for free
 *
 * `CampaignContact`, `DoNotCall`, `CallAttempt` and `CampaignPhoneNumber` are
 * keyed by `campaignId` alone with no workspace column, so they follow the
 * campaign with no write at all. Only `Contact` needs remapping, because it is
 * workspace-scoped and unique on `(workspaceId, phone)`.
 *
 * ## Preview then apply
 *
 * Modelled on `accountTransfer.ts`, and for the same reason: the commit calls
 * `describeCampaignTransfer` **inside its own transaction** and writes from
 * what it returns. Two code paths would let the confirm step promise something
 * the write does not do, and on an operation with no undo the confirm step is
 * the only protection there is.
 */

export class CampaignNotFoundError extends Error {
  constructor() {
    super('That campaign does not exist.');
    this.name = 'CampaignNotFoundError';
  }
}

export class WorkspaceNotFoundError extends Error {
  constructor() {
    super('The target workspace does not exist.');
    this.name = 'WorkspaceNotFoundError';
  }
}

export class SameWorkspaceError extends Error {
  constructor() {
    super('The campaign is already in that workspace.');
    this.name = 'SameWorkspaceError';
  }
}

/** A deleted workspace still holds its rows so the ledger's `Restrict` foreign
 *  keys stay valid — it is not a place anything new may be put. Every scoped
 *  route already refuses it, so a campaign moved into one would be reachable by
 *  nobody and recoverable only by hand. */
export class TargetWorkspaceDeletedError extends Error {
  constructor() {
    super('The target workspace has been deleted. Nothing can be moved into it.');
    this.name = 'TargetWorkspaceDeletedError';
  }
}

/** Live, in either sense: dialing, scheduled, or holding a line. Staff stop the
 *  campaign first; the transfer does not stop it for them, because a campaign
 *  halted by a move is a campaign nobody decided to halt. */
export class CampaignRunningError extends Error {
  constructor(readonly reason: 'status' | 'in-flight') {
    super(
      reason === 'status'
        ? 'This campaign is running or scheduled to start. Stop it before moving it.'
        : 'This campaign still has calls connected. Wait for them to finish.',
    );
    this.name = 'CampaignRunningError';
  }
}

/** The campaign gained or lost contacts between the preview and the confirm.
 *  Refused rather than applied: the plan the operator reviewed must be the plan
 *  that ran, and a move of a different thing is worse than a move refused. */
export class ContactCountChangedError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      `This campaign had ${expected} contacts when the preview was taken and has ${actual} now. Nothing was moved — review it again.`,
    );
    this.name = 'ContactCountChangedError';
  }
}

export interface CampaignTransferPlan {
  campaign: { id: string; name: string; status: string };
  source: { id: string; name: string };
  target: { id: string; name: string };
  counts: {
    contacts: number;
    /** Already present in the target, matched on phone. Their rows are reused
     *  untouched — the target's own record of a person is not the source's to
     *  overwrite, and a silent merge is unreviewable afterward. */
    contactsExisting: number;
    contactsCreated: number;
    doNotCall: number;
    /** Stays with the source. The number the dialog must make unmissable. */
    attemptsStaying: number;
  };
  detaching: {
    agentName: string | null;
    /** The dial roster's DIDs, by number. */
    phoneNumbers: string[];
  };
}

/** The narrowest client this reads through, so the preview and the commit can
 *  share one implementation — the commit passes its own transaction. */
type Reader = Prisma.TransactionClient | typeof prisma;

/** Rows per statement. The schema contemplates 100,000-contact campaigns, and
 *  `campaignTopup.ts:15-18` documents both traps this shares: a parameter list
 *  no driver enjoys, and a lock held longer than the dispatcher can wait.
 *  Exported because the remap must page in the same steps this preview counted
 *  in — two chunk sizes is two different walks over one list. */
export const TRANSFER_CHUNK_SIZE = 1000;

/**
 * Prisma's interactive-transaction default is 5 seconds, and a large remap
 * beats it — which surfaces as a P2028 and a 500 on a request that was doing
 * exactly what it was asked to. Same number `campaignTopup.ts:20-24` settled
 * on, for the same reason.
 */
export const TRANSFER_TRANSACTION_TIMEOUT_MS = 30_000;

/**
 * What a transfer would do.
 *
 * Every refusal below is raised here rather than at the route, so the commit —
 * which calls this inside its own transaction — cannot move a campaign the
 * preview would have refused. A guard only the route holds is a guard the
 * write does not have.
 */
export async function describeCampaignTransfer(
  campaignId: string,
  targetWorkspaceId: string,
  client: Reader = prisma,
): Promise<CampaignTransferPlan> {
  const campaign = await client.campaign.findUnique({
    where: { id: campaignId },
    include: {
      workspace: { select: { id: true, name: true } },
      agent: { select: { name: true } },
      dialNumbers: {
        include: { phoneNumber: { select: { did: true } } },
        orderBy: { position: 'asc' },
      },
    },
  });

  if (!campaign) throw new CampaignNotFoundError();
  if (campaign.workspaceId === targetWorkspaceId) throw new SameWorkspaceError();

  const target = await client.workspace.findUnique({
    where: { id: targetWorkspaceId },
    select: { id: true, name: true, deletedAt: true },
  });

  if (!target) throw new WorkspaceNotFoundError();
  if (target.deletedAt) throw new TargetWorkspaceDeletedError();

  // `scheduledStartAt` is checked beside the two statuses and not folded into
  // them: a campaign waiting on the scanner is DRAFT, so the status alone says
  // nothing is wrong, and the scanner would start it in a workspace nobody
  // scheduled it for.
  if (
    campaign.status === 'RUNNING' ||
    campaign.status === 'SCHEDULED' ||
    campaign.scheduledStartAt !== null
  ) {
    throw new CampaignRunningError('status');
  }

  // `IN_FLIGHT` rather than a status list spelled here. That set is the same
  // one the platform's concurrency endpoint counts, and a second copy of it
  // drifts into meaning something else — here, into moving a campaign whose
  // call is still connected and whose completion webhook is about to land on a
  // campaign that changed workspace underneath it.
  const inFlight = await client.callAttempt.count({
    where: { campaignId: campaign.id, ...IN_FLIGHT },
  });
  if (inFlight) throw new CampaignRunningError('in-flight');

  const [contacts, doNotCall, attemptsStaying] = await Promise.all([
    client.campaignContact.count({ where: { campaignId: campaign.id } }),
    client.doNotCall.count({ where: { campaignId: campaign.id } }),
    client.callAttempt.count({ where: { campaignId: campaign.id } }),
  ]);

  // Derived from the one count, never counted a second way: "how many the
  // target already has" and "how many it will gain" must add up to the number
  // beside them, and two independent reads of a live table do not have to.
  const contactsExisting = await countPhonesAlreadyInTarget(client, campaign.id, target.id);

  return {
    campaign: { id: campaign.id, name: campaign.name, status: campaign.status },
    source: campaign.workspace,
    target: { id: target.id, name: target.name },
    counts: {
      contacts,
      contactsExisting,
      contactsCreated: contacts - contactsExisting,
      doNotCall,
      attemptsStaying,
    },
    detaching: {
      agentName: campaign.agent?.name ?? null,
      phoneNumbers: campaign.dialNumbers.map((row) => row.phoneNumber.did),
    },
  };
}

/**
 * How many of the campaign's phones the target workspace already holds.
 *
 * Paged, not loaded. The obvious version reads every phone into an array and
 * asks `phone: { in: phones }` once, which on the 100,000-contact campaign the
 * schema contemplates is a hundred thousand bind parameters in one statement —
 * the exact shape `campaignTopup.ts` chunks to avoid, arrived at from the read
 * side instead of the write side.
 *
 * Keyed on phone because that is what `Contact`'s unique is keyed on, and the
 * remap has to match rows the way the database will.
 */
async function countPhonesAlreadyInTarget(
  client: Reader,
  campaignId: string,
  targetWorkspaceId: string,
): Promise<number> {
  let existing = 0;
  let cursor: string | undefined;

  for (;;) {
    // Keyset over the campaign's own rows, not `skip`: an offset walk re-sorts
    // the whole list on every page, and the contact list is the one thing here
    // that is allowed to be enormous.
    const page = await client.campaignContact.findMany({
      where: { campaignId },
      select: { id: true, contact: { select: { phone: true } } },
      orderBy: { id: 'asc' },
      take: TRANSFER_CHUNK_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    if (!page.length) break;

    existing += await client.contact.count({
      where: {
        workspaceId: targetWorkspaceId,
        phone: { in: page.map((row) => row.contact.phone) },
      },
    });

    if (page.length < TRANSFER_CHUNK_SIZE) break;
    cursor = page[page.length - 1]!.id;
  }

  return existing;
}

/**
 * Perform the transfer.
 *
 * `expectedContactCount` is the figure the operator confirmed. It is compared
 * against the plan this transaction derives, not against a second count of its
 * own — see `ContactCountChangedError`.
 */
export async function transferCampaign(
  campaignId: string,
  targetWorkspaceId: string,
  expectedContactCount: number,
): Promise<CampaignTransferPlan> {
  return prisma.$transaction(
    async (tx) => {
      // Re-derived inside the transaction rather than trusted from the preview
      // the operator saw: minutes may have passed, and every refusal the
      // preview raises has to hold now rather than then.
      const plan = await describeCampaignTransfer(campaignId, targetWorkspaceId, tx);

      if (plan.counts.contacts !== expectedContactCount) {
        throw new ContactCountChangedError(expectedContactCount, plan.counts.contacts);
      }

      await remapContacts(tx, campaignId, targetWorkspaceId);

      // The rotation is the source's DIDs and goes with them. The inbound
      // claims are deleted defensively — they are taken at start and released
      // at pause, so a moved campaign should hold none, and one that survived
      // would pin one workspace's DID to another workspace's campaign.
      await tx.campaignPhoneNumber.deleteMany({ where: { campaignId } });
      await tx.campaignInboundClaim.deleteMany({ where: { campaignId } });

      await tx.campaign.update({
        where: { id: campaignId },
        data: {
          workspaceId: targetWorkspaceId,
          // The agent and the caller number belong to the source. The campaign
          // lands incomplete and the new owner re-picks both; carrying the DID
          // over instead would change which account is billed for that rental
          // while the ledger goes on saying otherwise.
          agentId: null,
          phoneNumberId: null,
          // Inert on arrival, and saying so. A campaign that resumed dialing
          // the moment it changed hands would place calls nobody in the
          // receiving workspace had decided to place.
          status: 'PAUSED',
          haltReason: `Moved from ${plan.source.name} by YE staff. Set an agent and a phone number before resuming.`,
        },
      });

      return plan;
    },
    { timeout: TRANSFER_TRANSACTION_TIMEOUT_MS },
  );
}

/**
 * Point every one of the campaign's links at a contact in the target workspace.
 *
 * `Contact` is the one row that cannot simply follow the campaign: it is
 * workspace-scoped and unique on `(workspaceId, phone)`. The source rows stay
 * where they are — they may back other campaigns the move does not touch, and
 * a person's record is the workspace's own data rather than something a move
 * of one campaign is entitled to take away.
 *
 * Paged by keyset for the reason `countPhonesAlreadyInTarget` is: the schema
 * contemplates 100,000-contact campaigns, and one `IN` list over all of them is
 * a statement no driver enjoys. Keyed on `CampaignContact.id`, which this loop
 * never writes, so the walk cannot be disturbed by its own updates.
 *
 * ## The assumption the paging makes, and what happens if it is ever false
 *
 * Each page resolves its phones independently, so the loop is only correct
 * while a phone cannot appear on two pages. That holds because `Contact` is
 * unique on `(workspaceId, phone)` and a campaign's contacts all live in one
 * workspace — which nothing in the schema enforces: `CampaignContact.contactId`
 * carries no workspace column, and no query here checks one. It is true today
 * because every write path that creates a link resolves the contact inside the
 * campaign's own workspace.
 *
 * Deliberately not guarded at runtime, because the failure is already safe: a
 * campaign holding two workspaces' contacts for one phone would make a later
 * page try to create a target row an earlier page already created, and the
 * unique index answers `P2002`, which rolls the whole transaction back. A
 * reader who somehow reaches that state sees a refused transfer and an
 * untouched campaign, never a half-moved one — so the cost of the missing
 * guard is a confusing error, not corrupted data.
 */
async function remapContacts(
  tx: Prisma.TransactionClient,
  campaignId: string,
  targetWorkspaceId: string,
): Promise<void> {
  let cursor: string | undefined;

  for (;;) {
    const page = await tx.campaignContact.findMany({
      where: { campaignId },
      select: {
        id: true,
        contact: {
          select: { phone: true, name: true, email: true, tags: true, metadata: true },
        },
      },
      orderBy: { id: 'asc' },
      take: TRANSFER_CHUNK_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    if (!page.length) break;

    // **A phone the target already holds is reused completely untouched.**
    // There is deliberately no `update` on an existing target contact anywhere
    // in this function: the target's own record of a person is not the
    // source's to overwrite, and a silent merge of a name, a tag list or a
    // metadata blob is invisible afterwards — nothing records what it replaced
    // and there is no undo.
    const known = new Map<string, string>();
    const learn = async (phones: string[]) => {
      for (const row of await tx.contact.findMany({
        where: { workspaceId: targetWorkspaceId, phone: { in: phones } },
        select: { id: true, phone: true },
      })) {
        known.set(row.phone, row.id);
      }
    };

    await learn(page.map((link) => link.contact.phone));

    const missing = page.filter((link) => !known.has(link.contact.phone));

    if (missing.length) {
      await tx.contact.createMany({
        data: missing.map((link) => ({
          workspaceId: targetWorkspaceId,
          phone: link.contact.phone,
          name: link.contact.name,
          email: link.contact.email,
          tags: link.contact.tags,
          metadata: link.contact.metadata as Prisma.InputJsonValue,
        })),
      });

      // `createMany` returns a count and no ids, so the rows it just wrote are
      // read back by the key they were written under.
      await learn(missing.map((link) => link.contact.phone));
    }

    const pairs = page.map((link) => {
      const contactId = known.get(link.contact.phone);
      if (!contactId) {
        // Unreachable unless the read-back above disagrees with the write.
        // Loud, and inside the transaction, so the campaign aborts whole
        // rather than quietly leaving one contact pointing at the source.
        throw new Error(`No target contact for ${link.contact.phone} — nothing moved.`);
      }
      return Prisma.sql`(${link.id}::text, ${contactId}::text)`;
    });

    // ONE statement per page, never one per link. A row-at-a-time loop is a
    // round trip per contact inside an interactive transaction, which on the
    // 100,000-contact campaign this pages for is the exact P2028 that
    // `campaignTopup.ts:19-24` warns about — and it would make
    // `TRANSFER_TRANSACTION_TIMEOUT_MS` promise a campaign size this could not
    // actually move.
    //
    // No collision is possible on `@@unique([campaignId, contactId])`: the
    // source's contacts are already distinct by phone within their workspace,
    // so they map to distinct target contacts. That is still the property that
    // makes this safe — a VALUES list naming one target contact twice would
    // violate the unique rather than merge two links.
    //
    // The ids are parameters, never interpolated text. They are cuids this
    // process just read out of the database rather than anything a caller
    // supplied, so nothing here is injectable today; a raw-SQL builder that
    // concatenated would be copied to somewhere it is. `::text` on both
    // columns because a bare VALUES literal is `unknown`, which Postgres will
    // not always plan against a `text` column.
    //
    // `updatedAt` is set explicitly: `@updatedAt` is applied by the Prisma
    // client and a raw statement goes past it, so without this the row would
    // claim it had not changed. Same reason the sweeps in
    // `campaignLifecycle.ts` set it by hand.
    const remapped = await tx.$executeRaw`
      UPDATE "CampaignContact" AS cc
      SET "contactId" = v.contact_id, "updatedAt" = NOW()
      FROM (VALUES ${Prisma.join(pairs)}) AS v(id, contact_id)
      WHERE cc.id = v.id`;

    if (remapped !== page.length) {
      // The `learn` read-back's argument, one layer on: a statement that moved
      // a different number of rows than the page it was built from means the
      // page and the table disagree, and a half-moved campaign is the one
      // outcome with no way back.
      throw new Error(
        `Remapped ${remapped} of ${page.length} contacts — nothing moved.`,
      );
    }

    if (page.length < TRANSFER_CHUNK_SIZE) break;
    cursor = page[page.length - 1]!.id;
  }
}
