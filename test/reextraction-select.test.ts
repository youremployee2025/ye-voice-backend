import { beforeEach, describe, expect, it } from 'vitest';
import type {
  Account,
  Campaign,
  CampaignContact,
  CampaignStatus,
  Workspace,
} from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';
import { selectConversations } from '../src/services/reextraction.service.js';
import { ReextractionRefused } from '../src/lib/reextraction/skip.js';

/**
 * Which call of which contact the re-extraction re-judges.
 *
 * The selection is the run's blast radius: every contact it names has its
 * verdict replaced and its place in the queue rewritten, and every contact it
 * leaves out keeps a verdict the campaign no longer trusts. So the cases here
 * are about the edges — a contact whose last dial was a voicemail after a real
 * conversation, one whose conversation the platform can no longer be asked
 * about, one an operator removed — rather than about the happy path, which is
 * one row.
 */

beforeEach(async () => {
  await truncateAll();
});

async function setup(status: CampaignStatus = 'PAUSED') {
  const owner = await makeAccount('alice');
  const ws = await makeWorkspace(owner, 'A Co');
  const campaign = await prisma.campaign.create({
    data: { workspaceId: ws.id, name: 'Touchbase September', status, goalEnabled: true },
  });

  return { owner, ws, campaign };
}

let seq = 0;

async function addContact(
  ws: Workspace,
  campaign: Campaign,
  fields: Partial<CampaignContact> = {},
) {
  seq += 1;
  const contact = await prisma.contact.create({
    data: { workspaceId: ws.id, phone: `+9198765${String(43000 + seq).padStart(5, '0')}` },
  });

  return prisma.campaignContact.create({
    data: { campaignId: campaign.id, contactId: contact.id, ...fields },
  });
}

let attemptSeq = 0;

async function addAttempt(
  ws: Workspace,
  owner: Account,
  campaign: Campaign,
  link: CampaignContact,
  fields: {
    attemptNo: number;
    disposition: string | null;
    withSession?: boolean;
    extraction?: unknown;
  },
) {
  attemptSeq += 1;

  return prisma.callAttempt.create({
    data: {
      campaignId: campaign.id,
      campaignContactId: link.id,
      workspaceId: ws.id,
      accountId: owner.id,
      attemptNo: fields.attemptNo,
      status: 'COMPLETED',
      resolvedAt: new Date(),
      disposition: fields.disposition,
      ...(fields.withSession === false
        ? {}
        : { upstreamCallId: `call_${attemptSeq}`, upstreamSessionId: `sess_${attemptSeq}` }),
      ...(fields.extraction === undefined
        ? {}
        : { extraction: fields.extraction as object }),
    },
  });
}

describe('choosing the call to re-judge', () => {
  /** One contact, several conversations: the last one is the one whose verdict
   *  armed the contact, so it is the only one worth re-judging. */
  it('takes the latest attempt that reached a person', async () => {
    const { owner, ws, campaign } = await setup();
    const link = await addContact(ws, campaign);
    await addAttempt(ws, owner, campaign, link, { attemptNo: 1, disposition: 'completed' });
    const later = await addAttempt(ws, owner, campaign, link, {
      attemptNo: 2,
      disposition: 'transferred',
    });

    const { conversations, skipped } = await selectConversations(campaign.id);

    expect(skipped).toEqual([]);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      campaignContactId: link.id,
      attemptId: later.id,
      attemptNo: 2,
      upstreamSessionId: later.upstreamSessionId,
    });
  });

  /**
   * The latest **reached** attempt, not the latest attempt. A contact whose
   * conversation was followed by two voicemails still has exactly one call
   * worth re-reading, and reading the voicemail instead would re-judge a call
   * on which nobody said anything.
   */
  it('looks past a later dial that reached nobody', async () => {
    const { owner, ws, campaign } = await setup();
    const link = await addContact(ws, campaign);
    const spoke = await addAttempt(ws, owner, campaign, link, {
      attemptNo: 1,
      disposition: 'completed',
    });
    await addAttempt(ws, owner, campaign, link, { attemptNo: 2, disposition: 'voicemail' });

    const { conversations } = await selectConversations(campaign.id);

    expect(conversations.map((c) => c.attemptId)).toEqual([spoke.id]);
  });

  /** The contact's whole state before the run, so the report can say what
   *  changed and the re-arm can reason about where the contact was. */
  it('carries the contact as it stands before the run', async () => {
    const { owner, ws, campaign } = await setup();
    const link = await addContact(ws, campaign, { status: 'COMPLETED', armKind: 'FOLLOW_UP' });
    const contact = await prisma.contact.findUniqueOrThrow({ where: { id: link.contactId } });
    await addAttempt(ws, owner, campaign, link, {
      attemptNo: 1,
      disposition: 'completed',
      extraction: { call_outcome_vocobaseplatform: 'stop' },
    });

    const { conversations } = await selectConversations(campaign.id);

    expect(conversations[0]).toMatchObject({
      phone: contact.phone,
      oldStatus: 'COMPLETED',
      oldArmKind: 'FOLLOW_UP',
      oldExtraction: { call_outcome_vocobaseplatform: 'stop' },
    });
  });

  /**
   * Ascending by contact id, which is what makes a run resumable: the
   * orchestrator walks the same order every time, so a run stopped after
   * batch three continues at batch four rather than re-judging a shuffle.
   */
  it('returns the conversations in a stable order', async () => {
    const { owner, ws, campaign } = await setup();

    for (const _ of [1, 2, 3, 4]) {
      const link = await addContact(ws, campaign);
      await addAttempt(ws, owner, campaign, link, { attemptNo: 1, disposition: 'completed' });
    }

    const ids = (await selectConversations(campaign.id)).conversations.map(
      (c) => c.campaignContactId,
    );

    expect(ids).toHaveLength(4);
    expect(ids).toEqual([...ids].sort());
  });

  /** Another campaign's contacts are another campaign's business, even in the
   *  same workspace and on the same agent. */
  it('never reaches outside the campaign it was given', async () => {
    const { owner, ws, campaign } = await setup();
    const other = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Other', status: 'PAUSED' },
    });
    const theirs = await addContact(ws, other);
    await addAttempt(ws, owner, other, theirs, { attemptNo: 1, disposition: 'completed' });

    const { conversations, skipped } = await selectConversations(campaign.id);

    expect(conversations).toEqual([]);
    expect(skipped).toEqual([]);
  });
});

/**
 * A contact this run cannot re-judge is reported, never guessed at. Each of
 * these leaves the contact exactly as it is, and the operator reads the reason
 * beside the row rather than wondering why a thousand contacts became nine
 * hundred.
 */
describe('the contacts a run cannot re-judge', () => {
  it('skips a contact nobody ever spoke to', async () => {
    const { owner, ws, campaign } = await setup();
    const voicemail = await addContact(ws, campaign);
    await addAttempt(ws, owner, campaign, voicemail, { attemptNo: 1, disposition: 'voicemail' });
    const undialed = await addContact(ws, campaign);

    const { conversations, skipped } = await selectConversations(campaign.id);

    expect(conversations).toEqual([]);
    expect(skipped).toEqual(
      expect.arrayContaining([
        { campaignContactId: voicemail.id, reason: 'never_reached' },
        { campaignContactId: undialed.id, reason: 'never_reached' },
      ]),
    );
    expect(skipped).toHaveLength(2);
  });

  /** No session id is no transcript: the dump is keyed by it, so there is
   *  nothing to ask the model about. Distinct from `never_reached` because it
   *  is a gap in our own records rather than a call that never happened. */
  it('skips a conversation the platform cannot be asked about', async () => {
    const { owner, ws, campaign } = await setup();
    const link = await addContact(ws, campaign);
    await addAttempt(ws, owner, campaign, link, {
      attemptNo: 1,
      disposition: 'completed',
      withSession: false,
    });

    const { conversations, skipped } = await selectConversations(campaign.id);

    expect(conversations).toEqual([]);
    expect(skipped).toEqual([{ campaignContactId: link.id, reason: 'no_session_id' }]);
  });

  /**
   * An `EXCLUDED` contact is reported rather than re-armed, whichever writer
   * excluded it.
   *
   * Not only an operator's remove: the dispatcher's do-not-call sweep settles
   * every PENDING contact whose phone is on the campaign's list, so a G-era
   * `stop` can have excluded a second contact sharing that phone. Both stay
   * out for the same reason — `EXCLUDED` is the one status `totalContacts` was
   * decremented for, so re-arming one would queue a contact the campaign's own
   * denominator says is not there. The operator puts it back deliberately,
   * with the top-up, once the do-not-call row is gone.
   */
  it('skips a contact that was excluded, by an operator or by the sweep', async () => {
    const { owner, ws, campaign } = await setup();
    const link = await addContact(ws, campaign, { status: 'EXCLUDED' });
    await addAttempt(ws, owner, campaign, link, { attemptNo: 1, disposition: 'completed' });

    const { conversations, skipped } = await selectConversations(campaign.id);

    expect(conversations).toEqual([]);
    expect(skipped).toEqual([{ campaignContactId: link.id, reason: 'excluded' }]);
  });
});

/**
 * The dispatcher and this run must never hold the same campaign at once. The
 * run rewrites `nextEligibleAt` and `armKind` on contacts wholesale; a
 * dispatcher sweeping the same campaign would dial from a queue being rewritten
 * underneath it, and the second half of the run would then be re-judging calls
 * placed by the first half.
 */
describe('the campaigns a run refuses', () => {
  it.each(['RUNNING', 'SCHEDULED', 'DRAFT'] as const)('refuses a %s campaign', async (status) => {
    const { campaign } = await setup(status);

    await expect(selectConversations(campaign.id)).rejects.toBeInstanceOf(ReextractionRefused);
  });

  it.each(['PAUSED', 'COMPLETED', 'STOPPED', 'CREDIT_EXHAUSTED'] as const)(
    'accepts a %s campaign',
    async (status) => {
      const { campaign } = await setup(status);

      await expect(selectConversations(campaign.id)).resolves.toEqual({
        conversations: [],
        skipped: [],
      });
    },
  );

  it('refuses a campaign that is not there', async () => {
    await expect(selectConversations('cmpgn_gone')).rejects.toBeInstanceOf(ReextractionRefused);
  });
});
