import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeAgent, makePhoneNumber, makeWorkspace } from './helpers.js';
import {
  CampaignNotFoundError,
  CampaignRunningError,
  ContactCountChangedError,
  SameWorkspaceError,
  TargetWorkspaceDeletedError,
  WorkspaceNotFoundError,
  describeCampaignTransfer,
  transferCampaign,
} from '../src/services/campaignTransfer.js';

beforeEach(async () => {
  await truncateAll();
});

async function scene() {
  const account = await makeAccount('owner');
  const source = await makeWorkspace(account, 'Source');
  const target = await makeWorkspace(account, 'Target');
  const agent = await makeAgent(source, 'closer');
  const did = await makePhoneNumber(source, '+918000', 'ASSIGNED');
  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: source.id,
      name: 'Q3 outreach',
      status: 'PAUSED',
      agentId: agent.id,
      phoneNumberId: did.id,
    },
  });
  await prisma.campaignPhoneNumber.create({
    data: { campaignId: campaign.id, phoneNumberId: did.id, position: 0 },
  });
  return { account, source, target, agent, did, campaign };
}

async function addContact(
  workspaceId: string,
  campaignId: string | null,
  phone: string,
  fields: { name?: string; email?: string; tags?: string[]; metadata?: Prisma.InputJsonValue } = {},
) {
  const contact = await prisma.contact.create({
    data: { workspaceId, phone, ...fields },
  });
  if (campaignId) {
    await prisma.campaignContact.create({ data: { campaignId, contactId: contact.id } });
  }
  return contact;
}

/** A terminal attempt, so it counts as history rather than as a call in flight.
 *  `accountId` and `attemptNo` have no defaults — an attempt row is a billing
 *  record and the dial mutual-exclusion token, and neither can be guessed. */
async function addAttempt(
  campaignId: string,
  campaignContactId: string,
  workspaceId: string,
  accountId: string,
  attemptNo: number,
  status: 'COMPLETED' | 'RINGING' | 'QUEUED' | 'IN_PROGRESS' | 'FAILED' | 'ABANDONED',
) {
  return prisma.callAttempt.create({
    data: { campaignId, campaignContactId, workspaceId, accountId, attemptNo, status },
  });
}

/**
 * Counts the statements a transfer issues through its own transaction client.
 *
 * The seam is `prisma.$transaction`: the service builds its `tx` there, so
 * wrapping the client handed to the callback observes every statement the
 * remap makes without the service knowing it is watched. Prisma 6 removed
 * `$use`, and a client extension returns a NEW client the service would not be
 * holding, so this is the one seam left that sees inside the transaction.
 *
 * It counts the two shapes the remap could take: one raw statement per page,
 * and one `campaignContact.update` per contact.
 */
async function countingTransfer(
  campaignId: string,
  targetWorkspaceId: string,
  expectedContactCount: number,
): Promise<{ rawStatements: number; perRowUpdates: number }> {
  const counts = { rawStatements: 0, perRowUpdates: 0 };
  const real = prisma.$transaction.bind(prisma);

  const watch = (tx: unknown) =>
    new Proxy(tx as object, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;

        if (prop === '$executeRaw' || prop === '$executeRawUnsafe') {
          return (...args: unknown[]) => {
            counts.rawStatements += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }

        if (prop === 'campaignContact') {
          return new Proxy(value as object, {
            get(delegate, method) {
              const fn = Reflect.get(delegate, method) as unknown;
              if (method === 'update' || method === 'updateMany') {
                return (...args: unknown[]) => {
                  counts.perRowUpdates += 1;
                  return (fn as (...a: unknown[]) => unknown).apply(delegate, args);
                };
              }
              return typeof fn === 'function' ? fn.bind(delegate) : fn;
            },
          });
        }

        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });

  const spy = vi
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .spyOn(prisma, '$transaction' as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .mockImplementation((...args: any[]) => {
      const [fn, options] = args;
      if (typeof fn !== 'function') return (real as (...a: unknown[]) => unknown)(...args);
      return (real as (...a: unknown[]) => unknown)(
        (tx: unknown) => fn(watch(tx)),
        options,
      );
    });

  try {
    await transferCampaign(campaignId, targetWorkspaceId, expectedContactCount);
  } finally {
    spy.mockRestore();
  }

  return counts;
}

describe('describeCampaignTransfer', () => {
  it('splits the contacts into ones the target already holds and ones it does not', async () => {
    const { source, target, campaign, agent, did } = await scene();
    await addContact(source.id, campaign.id, '+919000000001');
    await addContact(source.id, campaign.id, '+919000000002');
    // The target already knows this person.
    await addContact(target.id, null, '+919000000002', { name: 'Known' });
    await prisma.doNotCall.create({
      data: { campaignId: campaign.id, phone: '+919000000003', reason: 'asked' },
    });

    const plan = await describeCampaignTransfer(campaign.id, target.id);

    expect(plan.campaign).toMatchObject({ id: campaign.id, name: 'Q3 outreach', status: 'PAUSED' });
    expect(plan.source).toMatchObject({ id: source.id, name: 'Source' });
    expect(plan.target).toMatchObject({ id: target.id, name: 'Target' });
    expect(plan.counts).toMatchObject({
      contacts: 2,
      contactsExisting: 1,
      contactsCreated: 1,
      doNotCall: 1,
    });
    expect(plan.detaching).toMatchObject({ agentName: agent.name, phoneNumbers: [did.did] });
  });

  it('pages the contact read rather than building one IN list of every phone', async () => {
    const { source, target, campaign } = await scene();

    // Deliberately over the 1,000-row chunk, with matches on both sides of the
    // boundary and one on the last page. An off-by-one in the paging loop —
    // a cursor that re-reads its own row, or a loop that stops a page early —
    // is invisible on a campaign that fits in a single chunk.
    const phones = Array.from(
      { length: 1005 },
      (_, index) => `+9190001${index.toString().padStart(5, '0')}`,
    );
    await prisma.contact.createMany({
      data: phones.map((phone) => ({ workspaceId: source.id, phone })),
    });
    const created = await prisma.contact.findMany({
      where: { workspaceId: source.id },
      select: { id: true },
    });
    await prisma.campaignContact.createMany({
      data: created.map((contact) => ({ campaignId: campaign.id, contactId: contact.id })),
    });
    for (const index of [0, 999, 1004]) {
      await addContact(target.id, null, phones[index]);
    }

    const plan = await describeCampaignTransfer(campaign.id, target.id);

    expect(plan.counts).toMatchObject({
      contacts: 1005,
      contactsExisting: 3,
      contactsCreated: 1002,
    });
  });

  it('counts the attempts staying behind', async () => {
    const { account, source, campaign, target } = await scene();
    const contact = await addContact(source.id, campaign.id, '+919000000001');
    const cc = await prisma.campaignContact.findFirstOrThrow({ where: { contactId: contact.id } });
    await addAttempt(campaign.id, cc.id, source.id, account.id, 1, 'COMPLETED');
    await addAttempt(campaign.id, cc.id, source.id, account.id, 2, 'FAILED');

    const plan = await describeCampaignTransfer(campaign.id, target.id);

    expect(plan.counts.attemptsStaying).toBe(2);
  });

  it('reports no agent when the campaign has none', async () => {
    const { campaign, target } = await scene();
    await prisma.campaign.update({ where: { id: campaign.id }, data: { agentId: null } });

    const plan = await describeCampaignTransfer(campaign.id, target.id);

    expect(plan.detaching.agentName).toBeNull();
  });

  it('refuses a campaign that does not exist', async () => {
    const { target } = await scene();
    await expect(describeCampaignTransfer('nope', target.id)).rejects.toThrow(
      CampaignNotFoundError,
    );
  });

  it('refuses a target that does not exist', async () => {
    const { campaign } = await scene();
    await expect(describeCampaignTransfer(campaign.id, 'nope')).rejects.toThrow(
      WorkspaceNotFoundError,
    );
  });

  it('refuses a target that is the source', async () => {
    const { campaign, source } = await scene();
    await expect(describeCampaignTransfer(campaign.id, source.id)).rejects.toThrow(
      SameWorkspaceError,
    );
  });

  it('refuses a deleted target', async () => {
    const { campaign, target } = await scene();
    await prisma.workspace.update({ where: { id: target.id }, data: { deletedAt: new Date() } });
    await expect(describeCampaignTransfer(campaign.id, target.id)).rejects.toThrow(
      TargetWorkspaceDeletedError,
    );
  });

  it('refuses a RUNNING campaign', async () => {
    const { campaign, target } = await scene();
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'RUNNING' } });
    await expect(describeCampaignTransfer(campaign.id, target.id)).rejects.toThrow(
      CampaignRunningError,
    );
  });

  it('refuses a SCHEDULED campaign', async () => {
    const { campaign, target } = await scene();
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'SCHEDULED' } });
    await expect(describeCampaignTransfer(campaign.id, target.id)).rejects.toThrow(
      CampaignRunningError,
    );
  });

  it('refuses a campaign waiting on a scheduled start', async () => {
    const { campaign, target } = await scene();
    // DRAFT, not RUNNING, and the status alone says nothing is wrong — the
    // scanner is going to start this campaign on its own, and a move in the
    // meantime hands the dial to a workspace nobody scheduled it for.
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: 'DRAFT', scheduledStartAt: new Date(Date.now() + 3_600_000) },
    });
    await expect(describeCampaignTransfer(campaign.id, target.id)).rejects.toThrow(
      CampaignRunningError,
    );
  });

  it('refuses while a call is in flight', async () => {
    const { account, source, campaign, target } = await scene();
    const contact = await addContact(source.id, campaign.id, '+919000000001');
    const cc = await prisma.campaignContact.findFirstOrThrow({ where: { contactId: contact.id } });
    await addAttempt(campaign.id, cc.id, source.id, account.id, 1, 'RINGING');

    await expect(describeCampaignTransfer(campaign.id, target.id)).rejects.toThrow(
      CampaignRunningError,
    );
  });

  it('does not mistake a settled attempt for one in flight', async () => {
    const { account, source, campaign, target } = await scene();
    const contact = await addContact(source.id, campaign.id, '+919000000001');
    const cc = await prisma.campaignContact.findFirstOrThrow({ where: { contactId: contact.id } });
    await addAttempt(campaign.id, cc.id, source.id, account.id, 1, 'ABANDONED');

    await expect(describeCampaignTransfer(campaign.id, target.id)).resolves.toMatchObject({
      counts: { attemptsStaying: 1 },
    });
  });

  it('ignores another campaign’s in-flight call', async () => {
    const { account, source, campaign, target } = await scene();
    const other = await prisma.campaign.create({
      data: { workspaceId: source.id, name: 'Other', status: 'RUNNING' },
    });
    const contact = await addContact(source.id, other.id, '+919000000009');
    const cc = await prisma.campaignContact.findFirstOrThrow({ where: { contactId: contact.id } });
    await addAttempt(other.id, cc.id, source.id, account.id, 1, 'IN_PROGRESS');

    await expect(describeCampaignTransfer(campaign.id, target.id)).resolves.toMatchObject({
      counts: { contacts: 0, attemptsStaying: 0 },
    });
  });
});

describe('transferCampaign', () => {
  it('moves the campaign and lands it inert', async () => {
    const { source, target, campaign, agent, did } = await scene();
    // DRAFT going in, so landing PAUSED is something this write did rather
    // than the state the fixture happened to start in.
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'DRAFT' } });
    await addContact(source.id, campaign.id, '+919000000001');
    // An inbound claim is created explicitly rather than assumed absent: a
    // surviving claim would pin one workspace's DID to another's campaign, and
    // an assertion over a table nothing wrote proves nothing about the delete.
    await prisma.campaignInboundClaim.create({
      data: { phoneNumberId: did.id, campaignId: campaign.id, agentId: agent.externalId },
    });

    await transferCampaign(campaign.id, target.id, 1);

    const after = await prisma.campaign.findUniqueOrThrow({
      where: { id: campaign.id },
      include: { dialNumbers: true, inboundClaims: true },
    });

    expect(after.workspaceId).toBe(target.id);
    expect(after.agentId).toBeNull();
    expect(after.phoneNumberId).toBeNull();
    expect(after.dialNumbers).toEqual([]);
    expect(after.inboundClaims).toEqual([]);
    expect(after.status).toBe('PAUSED');
    expect(after.haltReason).toBe(
      'Moved from Source by YE staff. Set an agent and a phone number before resuming.',
    );

    // The DID itself is untouched — it is the source's rental, and moving it
    // would change which account is billed while the ledger says otherwise.
    expect(await prisma.phoneNumber.findUniqueOrThrow({ where: { id: did.id } })).toMatchObject({
      workspaceId: source.id,
      status: 'ASSIGNED',
    });
  });

  it('creates a contact in the target when it holds no matching phone', async () => {
    const { source, target, campaign } = await scene();
    await addContact(source.id, campaign.id, '+919000000001', {
      name: 'Asha',
      email: 'asha@example.test',
      tags: ['warm'],
      metadata: { city: 'Pune' },
    });

    await transferCampaign(campaign.id, target.id, 1);

    const moved = await prisma.contact.findUniqueOrThrow({
      where: { workspaceId_phone: { workspaceId: target.id, phone: '+919000000001' } },
    });
    expect(moved).toMatchObject({
      name: 'Asha',
      email: 'asha@example.test',
      tags: ['warm'],
      metadata: { city: 'Pune' },
    });

    const cc = await prisma.campaignContact.findFirstOrThrow({ where: { campaignId: campaign.id } });
    expect(cc.contactId).toBe(moved.id);
  });

  it('reuses the target contact UNCHANGED when it already holds the phone', async () => {
    const { source, target, campaign } = await scene();
    await addContact(source.id, campaign.id, '+919000000001', {
      name: 'Source name',
      tags: ['source-tag'],
      metadata: { from: 'source' },
    });
    const theirs = await addContact(target.id, null, '+919000000001', {
      name: 'Their name',
      tags: ['their-tag'],
      metadata: { from: 'target' },
    });

    await transferCampaign(campaign.id, target.id, 1);

    // The target's own record of a person is not the source's to overwrite,
    // and a silent merge is the failure nobody notices afterward.
    expect(await prisma.contact.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({
      name: 'Their name',
      tags: ['their-tag'],
      metadata: { from: 'target' },
    });
    // Reused, not duplicated: the unique on (workspaceId, phone) makes a second
    // row impossible, so a create would have thrown rather than merged.
    expect(await prisma.contact.count({ where: { workspaceId: target.id } })).toBe(1);

    const cc = await prisma.campaignContact.findFirstOrThrow({ where: { campaignId: campaign.id } });
    expect(cc.contactId).toBe(theirs.id);
  });

  it('leaves the source contacts in place', async () => {
    const { source, target, campaign } = await scene();
    const mine = await addContact(source.id, campaign.id, '+919000000001');

    await transferCampaign(campaign.id, target.id, 1);

    // They may back other campaigns the move does not touch, and a person's
    // record is the source workspace's own data either way.
    expect(await prisma.contact.findUnique({ where: { id: mine.id } })).toMatchObject({
      workspaceId: source.id,
      phone: '+919000000001',
    });
  });

  it('carries every contact journey field across unchanged', async () => {
    const { source, target, campaign } = await scene();
    const contact = await addContact(source.id, campaign.id, '+919000000001');
    // A real pairing: an armed CALLBACK is the one arm that carries a
    // `callbackAt`, and `nextEligibleAt` moves with it.
    const callbackAt = new Date('2026-10-01T09:30:00.000Z');
    await prisma.campaignContact.updateMany({
      where: { campaignId: campaign.id, contactId: contact.id },
      data: {
        attempts: 2,
        callbackCount: 1,
        followUpCount: 1,
        armKind: 'CALLBACK',
        callbackAt,
        nextEligibleAt: callbackAt,
        status: 'PENDING',
        disposition: 'no_answer',
      },
    });

    await transferCampaign(campaign.id, target.id, 1);

    expect(
      await prisma.campaignContact.findFirstOrThrow({ where: { campaignId: campaign.id } }),
    ).toMatchObject({
      attempts: 2,
      callbackCount: 1,
      followUpCount: 1,
      armKind: 'CALLBACK',
      callbackAt,
      nextEligibleAt: callbackAt,
      status: 'PENDING',
      disposition: 'no_answer',
    });
  });

  it('carries the DNC list across', async () => {
    const { source, target, campaign } = await scene();
    await addContact(source.id, campaign.id, '+919000000001');
    await prisma.doNotCall.create({
      data: { campaignId: campaign.id, phone: '+919000000009', reason: 'asked not to be called' },
    });

    await transferCampaign(campaign.id, target.id, 1);

    // Keyed by campaignId alone, so it follows for free — asserted because
    // "for free" is exactly the kind of claim that stops being true.
    expect(await prisma.doNotCall.count({ where: { campaignId: campaign.id } })).toBe(1);
  });

  it('leaves the call history and the ledger reading source', async () => {
    const { account, source, target, campaign } = await scene();
    const contact = await addContact(source.id, campaign.id, '+919000000001');
    const cc = await prisma.campaignContact.findFirstOrThrow({ where: { contactId: contact.id } });
    const attempt = await addAttempt(campaign.id, cc.id, source.id, account.id, 1, 'COMPLETED');
    const ledger = await prisma.creditTransaction.create({
      data: {
        accountId: account.id,
        workspaceId: source.id,
        amount: -100n,
        type: 'CALL_USAGE',
        callAttemptId: attempt.id,
      },
    });

    await transferCampaign(campaign.id, target.id, 1);

    expect(await prisma.callAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({
      workspaceId: source.id,
    });
    expect(
      await prisma.creditTransaction.findUniqueOrThrow({ where: { id: ledger.id } }),
    ).toMatchObject({ workspaceId: source.id });
  });

  it('refuses on contact-count drift and writes nothing', async () => {
    const { source, target, campaign } = await scene();
    await addContact(source.id, campaign.id, '+919000000001');
    await addContact(source.id, campaign.id, '+919000000002');

    await expect(transferCampaign(campaign.id, target.id, 1)).rejects.toThrow(
      ContactCountChangedError,
    );

    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({
      workspaceId: source.id,
      status: 'PAUSED',
      // Null, not merely unchanged: the halt sentence is the one field on the
      // campaign row a refused transfer could still have left behind.
      haltReason: null,
    });
    expect(await prisma.contact.count({ where: { workspaceId: target.id } })).toBe(0);
    expect(await prisma.campaignPhoneNumber.count({ where: { campaignId: campaign.id } })).toBe(1);
  });

  it('remaps across the chunk boundary', async () => {
    const { source, target, campaign } = await scene();
    const COUNT = 1050;

    await prisma.contact.createMany({
      data: Array.from({ length: COUNT }, (_, index) => ({
        workspaceId: source.id,
        phone: `+9190000${String(index).padStart(5, '0')}`,
      })),
    });
    const contacts = await prisma.contact.findMany({ where: { workspaceId: source.id } });
    await prisma.campaignContact.createMany({
      data: contacts.map((contact) => ({ campaignId: campaign.id, contactId: contact.id })),
    });

    const statements = await countingTransfer(campaign.id, target.id, COUNT);

    // Exercised rather than assumed: at 1,000 rows per statement this is two
    // chunks, and an off-by-one in the batching loses the tail silently.
    expect(await prisma.contact.count({ where: { workspaceId: target.id } })).toBe(COUNT);

    // Bounded by PAGES, not by contacts. 1,050 contacts is two pages, so a
    // remap that touched one row per statement would read 1,050 here — which
    // is what `TRANSFER_TRANSACTION_TIMEOUT_MS` cannot survive at the campaign
    // sizes this pages for. Both counters are live: a per-link
    // `campaignContact.update` loop scores 0 raw and 1,050 row updates, and a
    // per-link raw statement scores 1,050 raw.
    expect(statements.perRowUpdates).toBe(0);
    expect(statements.rawStatements).toBeLessThanOrEqual(4);

    const remapped = await prisma.campaignContact.findMany({
      where: { campaignId: campaign.id },
      select: { contact: { select: { workspaceId: true } } },
    });
    expect(remapped).toHaveLength(COUNT);
    expect(remapped.every((row) => row.contact.workspaceId === target.id)).toBe(true);
  }, 60_000);
});
