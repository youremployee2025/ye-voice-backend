import type {
  CampaignContactStatus,
  ContactArmKind,
  Prisma,
} from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { REACHED_ATTEMPT } from '../lib/campaignOutcomes.js';
import { NEVER_PLACED } from '../lib/dialBudget.js';
import { ReextractionRefused, ReextractionSkip } from '../lib/reextraction/skip.js';
import { planRearm } from '../lib/reextraction/plan.js';
import type { RearmPlan } from '../lib/reextraction/plan.js';
import { buildMessages } from '../lib/reextraction/messages.js';
import type { ChatMessage } from '../lib/reextraction/messages.js';
import type { DumpResult } from '../lib/reextraction/dump.js';
import { parseCallNoteReply } from '../lib/reextraction/parse.js';
import { renderBatch, renderReport, renderReportHeader, tally } from '../lib/reextraction/report.js';
import type { RunOutcome, RunRow } from '../lib/reextraction/report.js';
import type { DialingWindow } from '../lib/dialingWindow.js';
import { readCallNote } from '../lib/goalRecord.js';
import { totalDialsFor } from '../lib/dialBudget.js';
import { callbackRawFrom, deriveKind } from '../lib/attemptKind.js';
import { boundExtractionValues } from '../lib/extractionCapture.js';
import { recordAttempt } from './goalContext.js';

/**
 * Re-judging a paused campaign's finished conversations, against the database.
 *
 * The pure halves of the run live under `lib/reextraction` — the messages the
 * model is shown, the reading of its reply, the plan a note earns. This module
 * is the half that touches rows: which conversations a run is allowed to
 * re-judge, and what a plan does to the contact it belongs to.
 *
 * It is a service rather than a script because both halves of that are
 * decisions with consequences an operator cannot see at the time — a contact
 * left out keeps a verdict the campaign no longer trusts, a contact re-armed
 * wrongly gets a telephone call — and a decision like that belongs where it
 * can be enumerated in a test.
 *
 * One thing a re-judged call deliberately does NOT move: `lastCallNote`, when a
 * voicemail followed the conversation being re-judged. `recordAttempt` moves it
 * only for the latest attempt by ordinal (`noteMoves`), and that is right here
 * too — the dashboard's "last call" is the last call, and a re-judgement of
 * attempt two must not relabel a contact whose attempt three rang out. The
 * memory the next dial reads does move, because it follows the last attempt
 * that actually said something.
 */

type Db = PrismaClient;

/** One finished conversation, and the contact it belongs to as it stands
 *  before the run touches anything. */
export interface Conversation {
  campaignContactId: string;
  attemptId: string;
  attemptNo: number;
  upstreamSessionId: string;
  phone: string;
  oldStatus: CampaignContactStatus;
  oldArmKind: ContactArmKind;
  /** The attempt's stored extraction, for the report's before-and-after. */
  oldExtraction: unknown;
  /** `CampaignContact.attempts`: the retry counter. Carried for the report;
   *  the claim exempts a reached contact's FOLLOW_UP row from it. */
  attempts: number;
  /** `CampaignContact.followUpCount` AS IT STANDS, before the apply resets it
   *  to zero. That reset is the agreed rule for what a re-judged contact
   *  starts from, and the budget check has to run against the value the claim
   *  would compare RIGHT NOW — reading the post-reset zero would arm every
   *  contact, however many follow-ups it has already taken. */
  followUpCount: number;
  /** The highest attempt number this contact has that actually reached the
   *  platform, which is the claim's own reading of the dial ceiling. Null for a
   *  contact whose only attempts were launch failures. */
  latestPlacedAttemptNo: number | null;
}

export interface SelectionSkip {
  campaignContactId: string;
  reason: 'never_reached' | 'no_session_id' | 'excluded';
}

/**
 * The campaign states in which a re-extraction is safe to run.
 *
 * Stated as the refusal rather than the permission — `RUNNING`, and the two
 * pre-flight states a start can move out of without anybody watching — because
 * the hazard is a dispatcher and this run holding the same campaign at once.
 * The run rewrites `armKind` and `nextEligibleAt` across a whole campaign; a
 * sweep reading that queue as it is rewritten would dial from half of it, and
 * the second half of the run would then be re-judging calls the first half
 * caused.
 *
 * `CREDIT_EXHAUSTED` is allowed: the dialing stopped, which is the only
 * property this list is about, and an operator topping the balance up
 * afterwards is a separate deliberate act.
 */
const REFUSED_STATUSES = new Set<CampaignContactStatus | string>([
  'RUNNING',
  'SCHEDULED',
  'DRAFT',
]);

/**
 * The conversations of a campaign worth re-judging, and the contacts that have
 * none.
 *
 * One call per contact, and it is the **latest one that reached a person**:
 * that is the call whose verdict armed the contact, so it is the only one the
 * re-arm can act on. The latest attempt outright would be the wrong call for
 * every contact whose conversation was followed by a voicemail — a reading of
 * a call on which nobody said anything.
 *
 * Ordered by contact id ascending, which is what makes a run resumable: the
 * orchestrator walks this list in batches and a stopped run continues where it
 * left off rather than re-judging a shuffle.
 */
export async function selectConversations(
  campaignId: string,
  db: Db = prisma,
): Promise<{ conversations: Conversation[]; skipped: SelectionSkip[] }> {
  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, status: true },
  });

  if (campaign === null) throw new ReextractionRefused('campaign_not_found', campaignId);

  if (REFUSED_STATUSES.has(campaign.status)) {
    throw new ReextractionRefused('campaign_is_live', campaign.status);
  }

  const contacts = await db.campaignContact.findMany({
    where: { campaignId },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      status: true,
      armKind: true,
      attempts: true,
      followUpCount: true,
      contact: { select: { phone: true } },
      callAttempts: {
        where: REACHED_ATTEMPT,
        orderBy: { attemptNo: 'desc' },
        take: 1,
        select: { id: true, attemptNo: true, upstreamSessionId: true, extraction: true },
      },
    },
  });

  /**
   * The highest PLACED attempt number per contact, in one grouped query rather
   * than one per contact.
   *
   * `NOT NEVER_PLACED` is `dialBudget.ts`'s own definition of a dial: a launch
   * failure that never reached the platform holds an ordinal but rang no
   * telephone, and counting it would refuse to re-arm a contact over a call
   * nobody made. The claim asks this as `NOT EXISTS (attemptNo >= cap AND NOT
   * never-placed)`, which is the same question as "is the highest placed
   * ordinal at or past the cap".
   */
  const placed = await db.callAttempt.groupBy({
    by: ['campaignContactId'],
    where: { campaignId, NOT: NEVER_PLACED },
    _max: { attemptNo: true },
  });

  const latestPlaced = new Map(
    placed.map((row) => [row.campaignContactId, row._max.attemptNo] as const),
  );

  const conversations: Conversation[] = [];
  const skipped: SelectionSkip[] = [];

  for (const contact of contacts) {
    /**
     * An `EXCLUDED` contact is reported, never re-armed.
     *
     * Two writers reach that status and only one of them is a person: an
     * operator's remove, and the dispatcher's own do-not-call sweep
     * (`excludeDoNotCallContacts` in `dialerClaim.ts`), which settles every
     * PENDING contact whose phone is on the campaign's list. So a G-era `stop`
     * on one contact can have EXCLUDED a SECOND contact sharing that phone —
     * exactly a contact this run would otherwise have every reason to bring
     * back.
     *
     * It is still not brought back here, and the argument is the same for both
     * writers: `EXCLUDED` is the one status `totalContacts` was decremented
     * for. Re-arming it would put a contact on the queue while the campaign's
     * own denominator says it is not there, and every page that draws the
     * campaign would be a contact short of the queue it describes.
     *
     * So the row is reported with its reason and an operator puts it back
     * deliberately — `PENDING` plus a `totalContacts` top-up — once the
     * do-not-call row that swept it is gone. `SKIPPED` is deliberately not
     * here: that is the campaign sweeping its own queue on a stop, which is
     * exactly the state this run exists to revisit.
     */
    if (contact.status === 'EXCLUDED') {
      skipped.push({ campaignContactId: contact.id, reason: 'excluded' });
      continue;
    }

    const attempt = contact.callAttempts[0];

    if (attempt === undefined) {
      skipped.push({ campaignContactId: contact.id, reason: 'never_reached' });
      continue;
    }

    // No session id is no transcript: the dump is keyed by it, so there is
    // nothing to ask the model about. Its own reason, because it is a gap in
    // our records rather than a call that never happened, and an operator
    // reading the report should be able to tell those apart.
    if (attempt.upstreamSessionId === null) {
      skipped.push({ campaignContactId: contact.id, reason: 'no_session_id' });
      continue;
    }

    conversations.push({
      campaignContactId: contact.id,
      attemptId: attempt.id,
      attemptNo: attempt.attemptNo,
      upstreamSessionId: attempt.upstreamSessionId,
      phone: contact.contact.phone,
      oldStatus: contact.status,
      oldArmKind: contact.armKind,
      oldExtraction: attempt.extraction,
      attempts: contact.attempts,
      followUpCount: contact.followUpCount,
      latestPlacedAttemptNo: latestPlaced.get(contact.id) ?? null,
    });
  }

  return { conversations, skipped };
}

/**
 * The counter a campaign keeps for each settled status, or null for a status
 * that is not settled.
 *
 * Three, not the plan's two. A campaign that was stopped swept its own queue
 * to `SKIPPED` with `skippedCount`, and those contacts are exactly the ones a
 * re-arm brings back — giving back only `completedCount` and `failedCount`
 * would leave the list page reporting contacts as swept out that are queued
 * again.
 */
type SettledCounter = 'completedCount' | 'failedCount' | 'skippedCount';

function counterOf(status: CampaignContactStatus): SettledCounter | null {
  switch (status) {
    case 'COMPLETED':
      return 'completedCount';
    case 'FAILED':
      return 'failedCount';
    case 'SKIPPED':
      return 'skippedCount';
    default:
      return null;
  }
}

/**
 * Written out per counter rather than built from a computed key, because a
 * computed key over a union widens to an index signature and Prisma's input
 * types — deliberately — have none.
 */
const POSITIVE: Record<SettledCounter, Prisma.CampaignWhereInput> = {
  completedCount: { completedCount: { gt: 0 } },
  failedCount: { failedCount: { gt: 0 } },
  skippedCount: { skippedCount: { gt: 0 } },
};

const DECREMENT: Record<SettledCounter, Prisma.CampaignUpdateInput> = {
  completedCount: { completedCount: { decrement: 1 } },
  failedCount: { failedCount: { decrement: 1 } },
  skippedCount: { skippedCount: { decrement: 1 } },
};

const INCREMENT: Record<SettledCounter, Prisma.CampaignUpdateInput> = {
  completedCount: { completedCount: { increment: 1 } },
  failedCount: { failedCount: { increment: 1 } },
  skippedCount: { skippedCount: { increment: 1 } },
};

/** The columns a plan sets on the contact. Every plan writes all six, so a
 *  contact cannot be left carrying half of an arm it no longer has. */
interface ContactWrite {
  status: CampaignContactStatus;
  goalAchieved: boolean | null;
  nextEligibleAt: Date | null;
  callbackAt: Date | null;
  armKind: ContactArmKind;
  followUpCount: number;
}

/**
 * The row a plan makes of the contact.
 *
 * Two things here are not what the live resolution writes, and both follow
 * from this being a re-judgement rather than a resolution.
 *
 * `followUpCount` is reset to zero on every plan — the agreed decision. The
 * counter records how many follow-ups the OLD verdicts spent, and those calls
 * were placed on a reading of the conversation the campaign has withdrawn; a
 * counter is history on the row and nothing bounds itself against it, but a
 * contact carrying two of them would still read as having spent follow-ups on
 * dials that this run says should never have happened.
 *
 * `armKind` is written on the settling plans too, where the live settle
 * deliberately leaves it alone as history. History is exactly what it stops
 * being here: the arm on the row is the one the withdrawn verdict chose, and
 * leaving it would have a settled contact still naming a lane it was put in by
 * a decision this run has just reversed. `FRESH` is the neutral value, and
 * every reader pairs the column with `status = 'PENDING'` anyway.
 */
/**
 * The two plans that write nothing at all: a reply that named no outcome, and
 * an arm the dispatcher would never take. Named once so the write, the report
 * and the batch bookkeeping cannot come to disagree about which they are.
 */
export function writesNothing(plan: RearmPlan): boolean {
  return plan.kind === 'no_verdict' || plan.kind === 'over_budget';
}

function contactWrite(
  plan: Exclude<RearmPlan, { kind: 'no_verdict' } | { kind: 'over_budget' }>,
): ContactWrite {
  const settled = { nextEligibleAt: null, callbackAt: null, armKind: 'FRESH' } as const;

  switch (plan.kind) {
    case 'stop':
      return { status: 'COMPLETED', goalAchieved: false, ...settled, followUpCount: 0 };
    case 'completed':
      return { status: 'COMPLETED', goalAchieved: true, ...settled, followUpCount: 0 };
    case 'callback':
      // The one arm that writes `callbackAt`, because it is the one arm a
      // person on the phone asked for.
      return {
        status: 'PENDING',
        goalAchieved: null,
        nextEligibleAt: plan.at,
        callbackAt: plan.at,
        armKind: 'CALLBACK',
        followUpCount: 0,
      };
    case 'resume':
    case 'follow_up':
      return {
        status: 'PENDING',
        goalAchieved: null,
        nextEligibleAt: plan.at,
        // Cleared rather than left behind: this contact waits on an arm the
        // engine chose, and a `callbackAt` from a withdrawn promise would draw
        // it everywhere as one a person asked for.
        callbackAt: null,
        armKind: plan.kind === 'resume' ? 'RESUME' : 'FOLLOW_UP',
        followUpCount: 0,
      };
  }
}

/** The do-not-call row a re-arm removed, as it read before it went. */
export interface DeletedDoNotCall {
  /** Nullable, as the column is: a row can have been written without one. */
  reason: string | null;
  sourceCampaignContactId: string | null;
}

/** What a write did that the report cannot see afterwards. */
export interface RearmEffect {
  deletedDoNotCall: DeletedDoNotCall | null;
}

export interface RearmInput {
  conversation: Conversation;
  /** The parsed reply, exactly as it will be stored. */
  values: Record<string, unknown>;
  plan: RearmPlan;
  /** Stamped onto the attempt, and what makes a re-run resumable. */
  runId: string;
  now: Date;
}

/**
 * Writes one re-judged conversation: the new verdict onto its attempt, the new
 * arm onto its contact, the campaign's counters, and the goal record the next
 * dial will read.
 *
 * All of it in one transaction, under the campaign row lock every other writer
 * in this tree takes first. The lock is not about the dispatcher — this run
 * refuses a live campaign — but about the lock ORDER: a campaign held while a
 * contact is waited for is the deadlock this whole tree avoids by always
 * taking the campaign first, and a writer that holds only on some paths is not
 * a lock order.
 *
 * ## Why nothing at all is written for `no_verdict` or `over_budget`
 *
 * An `over_budget` plan is the other one: the note wants another call and the
 * dispatcher's claim would never place it, so arming the contact would swap a
 * settled row for a PENDING one that nothing dials and nothing settles — and
 * `completeIfDone` could then never finish the campaign. The old verdict at
 * least ends somewhere.
 *
 * A reply that does not name an outcome has not answered the question the
 * re-extraction was run to ask. Storing its values anyway would replace the
 * attempt's whole `extraction` column — the write is a replace, as the live
 * path's is — so a one-key reply would blank the other five values the attempt
 * has held since the call. The contact keeps its arm, the attempt keeps its
 * answers, and the report carries the row as skipped.
 *
 * ## Why it is safe to run twice
 *
 * An operator whose run died halfway re-runs it, and every row already applied
 * is applied again. The attempt write and the contact write are replacements,
 * so they are naturally idempotent; the goal record is keyed by attempt number
 * and replaces its own entry. The counters are the one place increments could
 * drift, and they are decided against the contact's status **as read inside
 * this transaction** rather than against the `oldStatus` captured at selection
 * time — on a second pass the two statuses agree and no counter moves. That is
 * also the only reading that is correct at all if anything touched the row
 * between the selection and here.
 */
export async function applyRearm(input: RearmInput, db: Db = prisma): Promise<RearmEffect> {
  if (writesNothing(input.plan)) return { deletedDoNotCall: null };

  const plan = input.plan as Exclude<RearmPlan, { kind: 'no_verdict' } | { kind: 'over_budget' }>;
  const { conversation } = input;

  return db.$transaction(async (tx): Promise<RearmEffect> => {
    // Which campaign this contact belongs to, read before the lock because it
    // is the one thing on the row that cannot change under it: a contact never
    // moves campaign. Everything a write below keys off is read afterwards.
    const link = await tx.campaignContact.findUnique({
      where: { id: conversation.campaignContactId },
      select: { campaignId: true },
    });

    // Deleted between the selection and here. There is nothing to re-arm, and
    // the attempt's verdict is of no use to anybody without it.
    if (link === null) return { deletedDoNotCall: null };

    const campaignId = link.campaignId;

    await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${campaignId} FOR UPDATE`;

    const campaign = await tx.campaign.findUnique({
      where: { id: campaignId },
      select: { status: true },
    });

    // Cascade-deleted with its contacts while this ran.
    if (campaign === null) return { deletedDoNotCall: null };

    /**
     * The refusal `selectConversations` already made, made again here and
     * under the lock.
     *
     * Selection happens once; this runs a thousand times after it, and a run
     * that pauses between batches for an operator to read a table spans as
     * long as somebody's lunch. An operator who unpauses the campaign in the
     * middle of that must not have the remaining contacts rewritten underneath
     * a dispatcher that is dialing from them — the check is worth nothing at
     * the top of a run if it is not also true at the instant of each write.
     */
    if (REFUSED_STATUSES.has(campaign.status)) {
      throw new ReextractionRefused('campaign_is_live', campaign.status);
    }

    // The status the counters key off, read under the lock rather than beside
    // the campaign id above: it is the field another writer could still be
    // moving, and it is the field the arithmetic below is decided on.
    const contact = await tx.campaignContact.findUnique({
      where: { id: conversation.campaignContactId },
      select: { status: true },
    });

    if (contact === null) return { deletedDoNotCall: null };

    /**
     * The verdict, replacing the column outright the way the live path writes
     * it, plus two marker keys.
     *
     * Prefixed with `_` and invisible to everything that reads a note:
     * `readCallNote` reads the six managed keys by name and ignores the rest,
     * so the marker cannot change how a single reader in the system judges
     * this call. It exists for this tool alone — a re-run skips a conversation
     * already stamped with a run id, which is what lets an operator restart a
     * run that died at contact six hundred.
     */
    const attempt = await tx.callAttempt.update({
      where: { id: conversation.attemptId },
      data: {
        extraction: {
          // Bounded exactly as every other writer of this column bounds it, so
          // a model that answered a call note with a page of prose cannot put
          // the size of this database in its own hands. The markers are added
          // afterwards: they are ours, they are two short strings, and they
          // must not be what a wide reply displaces.
          ...(boundExtractionValues(input.values) ?? {}),
          _reextractedBy: input.runId,
          _reextractedAt: input.now.toISOString(),
        } as Prisma.InputJsonObject,
      },
      select: {
        attemptNo: true,
        kind: true,
        upstreamStatus: true,
        disposition: true,
        answeredBy: true,
        durationSecs: true,
      },
    });

    const write = contactWrite(plan);

    await tx.campaignContact.update({
      where: { id: conversation.campaignContactId },
      data: write,
    });

    let deletedDoNotCall: DeletedDoNotCall | null = null;

    if (plan.kind === 'stop') {
      // Exactly as `resolveContact` writes it, down to the sentence: first
      // writer wins, so a number already listed keeps the reason and the
      // source that first put it there.
      await tx.doNotCall.upsert({
        where: {
          campaignId_phone: { campaignId: campaignId, phone: conversation.phone },
        },
        create: {
          campaignId: campaignId,
          phone: conversation.phone,
          reason: plan.reason ?? 'Asked not to be called again during a campaign call.',
          sourceCampaignContactId: conversation.campaignContactId,
        },
        update: {},
      });
    } else {
      /**
       * A reopened `stop` takes its own do-not-call row with it, or the
       * contact is armed for a dial the claim will refuse — armed forever,
       * because nothing else would ever clear the row.
       *
       * Matched on the source as well as the number, so this deletes only what
       * THIS contact's own withdrawn verdict created. An uploaded opt-out
       * list, or another contact on the same number, is not this run's to
       * overrule: all it knows is that its own reading of its own call was
       * wrong.
       */
      const where = {
        campaignId: campaignId,
        phone: conversation.phone,
        sourceCampaignContactId: conversation.campaignContactId,
      };

      // Read before it is deleted, and returned to the report. The run is
      // throwing away a sentence somebody wrote about a person who asked not to
      // be called; if the operator decides the new verdict was wrong, the
      // report is the only place that sentence still exists.
      deletedDoNotCall = await tx.doNotCall.findFirst({
        where,
        select: { reason: true, sourceCampaignContactId: true },
      });

      await tx.doNotCall.deleteMany({ where });
    }

    const before = counterOf(contact.status);
    const after = counterOf(write.status);

    if (before !== after) {
      if (before !== null) {
        // Guarded at zero. A counter that is already wrong — a campaign whose
        // history predates a fix, a row moved by hand — must not be driven
        // negative by a correction; a count below zero is a number no page can
        // draw.
        await tx.campaign.updateMany({
          where: { id: campaignId, ...POSITIVE[before] },
          data: DECREMENT[before],
        });
      }

      if (after !== null) {
        await tx.campaign.update({
          where: { id: campaignId },
          data: INCREMENT[after],
        });
      }
    }

    /**
     * The goal record, so the journey and the next dial's memory read H's note
     * rather than the verdict the campaign has withdrawn.
     *
     * `recordAttempt` keys its log by attempt number and REPLACES the entry
     * for one it already holds, which is what makes it the right call here:
     * this is the same attempt, re-judged, not a new one. The platform-side
     * facts come off the attempt row — its status, disposition, `answeredBy`
     * and duration are what actually happened on the call and did not change
     * — while everything the note decides is derived from the new values.
     */
    await recordAttempt(
      {
        campaignContactId: conversation.campaignContactId,
        attemptNo: attempt.attemptNo,
        kind: deriveKind(attempt),
        status: attempt.upstreamStatus,
        disposition: attempt.disposition,
        answeredBy: attempt.answeredBy,
        extraction: input.values,
        // Read by the same rule the live path reads it by: every campaign
        // carries the call-note set now, so the promised time is the note's.
        callbackNote: ((raw) => (typeof raw === 'string' ? raw : null))(
          callbackRawFrom(input.values),
        ),
        durationSecs: attempt.durationSecs,
      },
      tx,
    );

    return { deletedDoNotCall };
  });
}

/**
 * The run itself: selection, then batches of judged conversations, then the
 * report an operator decides on.
 *
 * Two properties are worth more than everything else in here, and every choice
 * below serves one of them.
 *
 * **A batch commits as a batch.** Every conversation in it is fetched and
 * judged first; only then does anything get written. A model that dies halfway
 * through leaves a batch that was judged whole or not at all, rather than a
 * campaign whose first forty contacts were re-armed under H and whose next
 * forty still hold G's verdict — a state nothing downstream could tell apart
 * from a campaign that was always like that.
 *
 * **A failure has a blast radius that matches it.** A dump the platform no
 * longer has is one row's news; a reply in prose is one row's news; a socket
 * that hung up is one row's news. More than half a batch failing is not a
 * collection of odd conversations, it is the model being down, and the run
 * stops rather than spending an hour recording the same failure a thousand
 * times. A campaign that goes live under the run is the one failure that ends
 * it outright, because from that instant a dispatcher is dialing from the queue
 * this run rewrites.
 */

/** Batches of twenty and four at a time: small enough that an operator can read
 *  a batch table, large enough that a thousand contacts is not an evening. */
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_CONCURRENCY = 4;

/** Below this, a batch's failures are conversations rather than evidence about
 *  the model, and the majority rule does not apply. */
const MIN_ABANDONABLE_BATCH = 4;

/**
 * The zone a call is anchored in when its campaign names none.
 *
 * Not UTC. Every campaign this tool was built for dials India, and a
 * transcript's "ten in the morning" resolved against UTC books a callback five
 * and a half hours from the hour a person was told.
 */
const FALLBACK_TIMYENE = 'Asia/Kolkata';

export interface RunOptions {
  campaignId: string;
  /** False writes nothing at all: the same judgements, the same report. */
  apply: boolean;
  /** Judge conversations an earlier run already stamped. */
  force: boolean;
  concurrency?: number;
  batchSize?: number;
  now?: Date;
  runId?: string;
  fetchDump: (sessionId: string) => Promise<DumpResult>;
  complete: (messages: ChatMessage[]) => Promise<string>;
  /** Called once per batch with that batch's table and the running totals. */
  log?: (line: string) => void;
  /**
   * Called once per batch with markdown to APPEND to a growing report — the
   * header ahead of the first batch, then each batch's table.
   *
   * Separate from `log`, which is for a terminal: a run that is killed never
   * writes a finished report, and what it leaves behind is a database with
   * hundreds of contacts re-armed and do-not-call rows deleted. This is the
   * record of which.
   */
  onBatch?: (markdown: string) => void | Promise<void>;
  /**
   * Stop before applying a batch that would take the run's reopened-`stop`
   * count past this. A run that reopens six hundred stops is either a contract
   * that was badly wrong before or a prompt that is badly wrong now, and the
   * difference is not visible from inside the run.
   */
  maxReopenedStops?: number;
  /** Asked after each batch. `false` stops the run cleanly, with the report. */
  confirmBatch?: (summary: {
    batchNo: number;
    rows: RunRow[];
    totalsSoFar: Record<string, number>;
  }) => Promise<boolean>;
}

export interface RunReport {
  runId: string;
  campaignId: string;
  apply: boolean;
  rows: RunRow[];
  /** Contacts the selection never handed over. Reported rather than dropped:
   *  an `excluded` one is manual work the run cannot do for the operator. */
  notSelected: SelectionSkip[];
  totals: Record<string, number>;
  status: RunOutcome['kind'];
  /**
   * How it ended, with the reason. `status` collapses an operator's `no` and a
   * model outage into one word; this keeps them apart, which is what a caller
   * choosing an exit code needs and what the closing line is rendered from.
   */
  outcome: RunOutcome;
  /** The last batch that completed, when the run did not. */
  stoppedAfterBatch: number | null;
  markdown: string;
}

export type { RunOutcome, RunRow } from '../lib/reextraction/report.js';

/** The message of something thrown, and never its stack: a report and a run log
 *  are documents that get pasted into chats. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Short, and random rather than sequential: it is a marker on a row, not an
 * ordering, and two operators running at once must not collide.
 *
 * Exported because a caller that wants to append the report as it is produced
 * has to know the file's name before the first batch lands, and the file is
 * named after the run.
 */
export function newRunId(): string {
  return `rx_${randomBytes(4).toString('hex')}`;
}

/**
 * The campaign's zone, checked once before a single conversation is fetched.
 *
 * A zone `Intl` cannot read makes the date-time line — the whole difference
 * between re-extracting a call and extracting it live — resolve every relative
 * time against nothing. Checked here rather than per row because the answer is
 * the same a thousand times, and because a run that discovers it on row one is
 * a run that has already paid for a thousand model calls.
 */
function assertZone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
  } catch {
    throw new ReextractionRefused('bad_timezone', timezone);
  }
}

/**
 * The selection's order, asserted rather than imposed.
 *
 * Ascending by contact id is what makes a stopped run resumable: the operator
 * restarts it and the marker skips exactly the prefix that was done. A silent
 * re-sort here would paper over a selection that had stopped promising that,
 * and the resumed run would start somewhere else.
 */
function assertAscending(conversations: Conversation[]): void {
  for (let index = 1; index < conversations.length; index += 1) {
    if (conversations[index - 1]!.campaignContactId >= conversations[index]!.campaignContactId) {
      throw new ReextractionRefused('unordered_selection', conversations[index]!.campaignContactId);
    }
  }
}

/** Whether an earlier run already judged this conversation. */
function isReextracted(extraction: unknown): boolean {
  return (
    typeof extraction === 'object' &&
    extraction !== null &&
    !Array.isArray(extraction) &&
    '_reextractedBy' in extraction
  );
}

/**
 * `limit` workers over one queue, in start order.
 *
 * The worker never rejects — `judge` turns every failure into a row — so one
 * conversation cannot take a batch's other nineteen down with it.
 */
async function pool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = next;
        next += 1;

        if (index >= items.length) return;

        results[index] = await worker(items[index]!);
      }
    }),
  );

  return results;
}

/**
 * Every row that was judged and then not written, said so on the row.
 *
 * Left carrying their plans they would sit in the report under "Dialable
 * again" — telling an operator a contact is back in the queue when its status
 * was never touched. A plan that writes nothing is skipped: it had nothing
 * taken from it.
 */
function markUnwritten(judged: Judged[]): void {
  for (const entry of judged) {
    if (entry.plan === undefined || entry.applied === true) continue;
    if (writesNothing(entry.plan)) continue;

    entry.row.newPlan = 'skipped';
    entry.row.skipReason = 'not_applied';
    entry.row.reopenedStop = false;
  }
}

/** One judged conversation: the row it will be reported as, and — when it was
 *  actually judged — what applying it would write. */
interface Judged {
  conversation: Conversation;
  row: RunRow;
  plan?: RearmPlan;
  values?: Record<string, unknown>;
  /** A refusal raised while judging — a credential the platform would not
   *  accept. It is true of every conversation, so it ends the run. */
  refused?: ReextractionRefused;
  /** Whether the write actually happened — false in a dry run, and false for
   *  everything after the refusal that aborted a batch. */
  applied?: boolean;
}

/**
 * One run of a campaign at a time.
 *
 * Two runs of the same campaign would interleave on the same thousand rows: the
 * second's selection reads contacts the first has already re-armed, judges them
 * again against a fresh model call, and both spend the campaign's counters. The
 * campaign lock each write takes does not prevent that — it serialises the
 * writes, which is not the same as refusing the second run.
 *
 * A session-level advisory lock, keyed by the campaign id, held for the life of
 * the run. The lock belongs to the CONNECTION that took it, and Prisma hands
 * each query to whichever pooled connection is free — so taken and released
 * through the shared pool, the release landed on a connection that never held
 * the lock more often than not once the run had spread its queries across the
 * pool. Postgres answers such a release with false, the lock stays with the
 * process until it exits, and every later run of that campaign is refused.
 *
 * So the lock gets a client of its own, pinned to a single connection for the
 * life of the run, and the release goes back through the same one. A second run
 * in the same process opens its own session too, which is what makes the guard
 * hold between two runs in one process and not only between two operators.
 */
function openLockSession(): Db {
  return new PrismaClient({ datasourceUrl: singleConnection(process.env.DATABASE_URL) });
}

function singleConnection(url: string | undefined): string | undefined {
  if (!url) return undefined;

  const parsed = new URL(url);
  parsed.searchParams.set('connection_limit', '1');

  return parsed.toString();
}

async function takeCampaignLock(session: Db, campaignId: string): Promise<boolean> {
  const [row] = await session.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_lock(hashtext(${campaignId})) AS locked`;

  return row?.locked === true;
}

async function releaseCampaignLock(session: Db, campaignId: string): Promise<void> {
  await session.$queryRaw`SELECT pg_advisory_unlock(hashtext(${campaignId}))`;
}

/**
 * `lockSession` is the connection the campaign lock lives on. Left out, the run
 * opens one of its own and closes it on the way out; a caller that hands one in
 * keeps it.
 */
export async function runReextraction(
  opts: RunOptions,
  db: Db = prisma,
  lockSession?: Db,
): Promise<RunReport> {
  const session = lockSession ?? openLockSession();

  try {
    if (!(await takeCampaignLock(session, opts.campaignId))) {
      throw new ReextractionRefused('run_in_progress', opts.campaignId);
    }

    try {
      return await runLocked(opts, db);
    } finally {
      /**
       * Quiet in the one way that matters: a release that throws must not
       * replace the error the run was already failing with — a refused campaign
       * reported as a lost connection sends an operator to the wrong problem
       * entirely. Closing the session below lets go of the lock either way.
       */
      try {
        await releaseCampaignLock(session, opts.campaignId);
      } catch (error) {
        opts.log?.(`reextraction: could not release the campaign lock: ${messageOf(error)}`);
      }
    }
  } finally {
    if (!lockSession) await session.$disconnect().catch(() => undefined);
  }
}

async function runLocked(opts: RunOptions, db: Db): Promise<RunReport> {
  const now = opts.now ?? new Date();
  const runId = opts.runId ?? newRunId();
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const log = opts.log ?? ((): void => {});

  const campaign = await db.campaign.findUnique({
    where: { id: opts.campaignId },
    select: {
      id: true,
      name: true,
      fromTime: true,
      toTime: true,
      timezone: true,
      dialDays: true,
      retryCount: true,
      maxGoalFollowUps: true,
    },
  });

  if (campaign === null) throw new ReextractionRefused('campaign_not_found', opts.campaignId);

  // The dispatcher's own window, read off the same four columns its gate reads.
  // Its zone is the campaign's as stored — a campaign with none has no window
  // to roll into, which is not the same thing as one anchored in India.
  const window: DialingWindow = {
    fromTime: campaign.fromTime,
    toTime: campaign.toTime,
    timezone: campaign.timezone,
    dialDays: campaign.dialDays,
  };

  /**
   * The dial ceiling as the dialer hands it to the claim:
   * `retryCount + maxGoalFollowUps + 1`, derived by the one function that owns
   * the rule. Read once — it is the campaign's — while the contact's half of
   * the budget comes off each conversation.
   */
  const maxTotalDials = totalDialsFor(campaign);
  const { retryCount, maxGoalFollowUps } = campaign;

  const { conversations, skipped } = await selectConversations(opts.campaignId, db);

  assertAscending(conversations);

  /**
   * The zone, checked after the selection and before the first fetch.
   *
   * After, because `selectConversations` is what refuses a campaign a
   * dispatcher may still be dialing, and that is the more urgent thing to tell
   * an operator: a live campaign with an odd zone reported as `bad_timezone`
   * sends them to fix the zone and run it again against the same live campaign.
   * Before the first fetch, because the answer is the same a thousand times and
   * a run that discovers it on row one has already paid for a thousand model
   * calls.
   */
  const timezone = campaign.timezone ?? FALLBACK_TIMYENE;

  assertZone(timezone);

  const rows: RunRow[] = [];
  const pending: Conversation[] = [];

  for (const conversation of conversations) {
    if (!opts.force && isReextracted(conversation.oldExtraction)) {
      const row = blankRow(conversation);

      row.skipReason = 'already_reextracted';
      rows.push(row);
      continue;
    }

    pending.push(conversation);
  }

  /** One conversation, from its dump to the plan its new note earns. Never
   *  throws: every failure is a field on the row it belongs to. */
  async function judge(conversation: Conversation): Promise<Judged> {
    const row = blankRow(conversation);

    try {
      const dump = await opts.fetchDump(conversation.upstreamSessionId);
      const messages = buildMessages({
        systemPrompt: dump.systemPrompt,
        transcript: dump.transcript,
        endedAt: dump.endedAt,
        timezone,
      });
      const parsed = parseCallNoteReply(await opts.complete(messages));

      if (!parsed.ok) {
        // The refusal's own reason, never a single `unparseable`: a model
        // answering in prose is worth a retry and a reply of the wrong shape
        // never will be.
        row.skipReason = parsed.reason;

        return { conversation, row };
      }

      const note = readCallNote(parsed.values);
      const plan = planRearm(note, {
        now,
        window,
        timezone,
        budget: {
          retryCount,
          maxGoalFollowUps,
          maxTotalDials,
          attempts: conversation.attempts,
          followUpCount: conversation.followUpCount,
          latestPlacedAttemptNo: conversation.latestPlacedAttemptNo,
        },
      });

      row.newOutcome = note.outcome;
      row.newCallbackType = note.callbackType;
      row.newPlan = plan.kind;
      // The budget that refused it, in the same field every other "nothing was
      // written, and here is why" reason travels in.
      if (plan.kind === 'over_budget') row.skipReason = plan.reason;
      /**
       * A `stop` the new note does not repeat.
       *
       * `no_verdict` is excluded because it is not a new verdict at all: the
       * re-arm writes nothing for one, so a `stop` under it is still a stop, and
       * calling that reopened would tell an operator a contact is back when its
       * row was never touched. In `apply` mode a row that was judged and then
       * not written — a refusal, a failed write — has this cleared for the same
       * reason, once the batch knows which of its rows landed.
       */
      row.reopenedStop =
        row.oldOutcome === 'stop' && plan.kind !== 'stop' && !writesNothing(plan);

      return { conversation, row, plan, values: parsed.values };
    } catch (error) {
      if (error instanceof ReextractionSkip) {
        row.skipReason = error.reason;

        return { conversation, row };
      }

      /**
       * Not this conversation's news. A token the platform will not accept
       * answers every session the same way, so recording it per row would walk
       * a thousand contacts, report a thousand failures and exit clean — and
       * under a small `--batch` the majority rule that abandons a batch never
       * fires, because a batch of two is too small to read anything into.
       */
      if (error instanceof ReextractionRefused) {
        row.error = error.message;

        return { conversation, row, refused: error };
      }

      // The message and not the stack. The message can carry the endpoint's URL
      // and the first two hundred characters of its body — the model client
      // builds it that way, and its own tests pin the key and the debug token
      // absent from it — but a stack in a document that gets pasted into chats
      // is pages of this repository's paths for no reader's benefit.
      row.error = messageOf(error);

      return { conversation, row };
    }
  }

  /**
   * Whether a do-not-call row for this number survives the re-arm.
   *
   * Asked of the rows rather than of `deleteMany`'s count, because the question
   * is about numbers rather than about this contact: a row an uploaded opt-out
   * list wrote — `sourceCampaignContactId` null — is exactly the case that
   * matters, and it is the one a `not:` filter would silently drop.
   */
  async function stillListed(conversation: Conversation, applied: boolean): Promise<boolean> {
    const listed = await db.doNotCall.findMany({
      where: { campaignId: opts.campaignId, phone: conversation.phone },
      select: { sourceCampaignContactId: true },
    });

    return applied
      ? listed.length > 0
      : listed.some((row) => row.sourceCampaignContactId !== conversation.campaignContactId);
  }

  const reportHeader = {
    campaign: { id: campaign.id, name: campaign.name },
    runId,
    apply: opts.apply,
    batchSize,
    concurrency,
    startedAt: now,
    timezone,
    timezoneDefaulted: campaign.timezone === null,
  };

  let outcome: RunOutcome = { kind: 'completed' };
  let stoppedAfterBatch: number | null = null;
  let batchNo = 0;

  /**
   * One batch, said twice: to the terminal, and to whatever is keeping the
   * growing file. The header goes ahead of the first batch only, so a run that
   * is killed leaves a file that still says which campaign and which mode its
   * tables belong to.
   */
  async function report(no: number, batchRows: RunRow[]): Promise<void> {
    const fragment = renderBatch({ batchNo: no, rows: batchRows, totals: tally(rows, skipped) });

    log(fragment);

    if (opts.onBatch === undefined) return;

    /**
     * The append is a favour to a run that might be killed, not a condition of
     * it. A full disk or a read-only path must not take the finished report —
     * and the record of every row already written — down with it, so the
     * failure is said out loud and the run goes on.
     */
    try {
      await opts.onBatch(no === 1 ? `${renderReportHeader(reportHeader)}\n${fragment}` : fragment);
    } catch (error) {
      log(`reextraction: could not append batch ${no}: ${messageOf(error)}`);
    }
  }

  for (let start = 0; start < pending.length; start += batchSize) {
    batchNo += 1;

    const batch = pending.slice(start, start + batchSize);
    const judged = await pool(batch, concurrency, judge);

    /**
     * A refusal raised while judging ends the run here, before the batch is
     * weighed and before a row of it is written: it is a fact about the run
     * rather than about any conversation in it, and the batch's own rows are
     * left saying they were not applied.
     */
    const refusal = judged.find((entry) => entry.refused !== undefined)?.refused;

    if (refusal !== undefined) {
      markUnwritten(judged);
      rows.push(...judged.map((entry) => entry.row));
      await report(batchNo, judged.map((entry) => entry.row));
      outcome = { kind: 'aborted', batchNo, reason: refusal.message };
      stoppedAfterBatch = batchNo - 1;
      break;
    }

    const failed = judged.filter((entry) => entry.row.error !== undefined).length;

    /**
     * More than half of a batch failing is a model that is down, and the plan
     * is explicit that an outage mid-batch leaves the batch untouched. So
     * nothing here is applied — not even the conversations that were judged
     * fine — and the run stops. Their rows say `batch_abandoned` rather than
     * carrying a plan nothing acted on.
     *
     * Under four conversations there is no majority worth reading. A batch of
     * one is every batch of a `--batch 1` run and a batch of two is what a
     * campaign of forty-one ends on, and in both a single dump the platform no
     * longer has would stop the whole run.
     */
    if (batch.length >= MIN_ABANDONABLE_BATCH && failed * 2 > batch.length) {
      for (const entry of judged) {
        // A plan that would have written nothing had nothing taken from it.
        if (entry.plan === undefined || writesNothing(entry.plan)) continue;

        entry.row.newPlan = 'skipped';
        entry.row.skipReason = 'batch_abandoned';
        entry.row.reopenedStop = false;
      }

      rows.push(...judged.map((entry) => entry.row));
      await report(batchNo, judged.map((entry) => entry.row));
      outcome = { kind: 'stopped', batchNo, reason: 'batch_abandoned' };
      stoppedAfterBatch = batchNo - 1;
      break;
    }

    /**
     * The ceiling, weighed before a row of this batch is written.
     *
     * Counted over the run rather than the batch — it is a statement about how
     * much of a campaign's history the operator is willing to have reversed in
     * one go — and checked before the writes so the batch that would pass it is
     * the batch that is left untouched. Everything before it stands.
     */
    if (opts.maxReopenedStops !== undefined) {
      const soFar = rows.filter((row) => row.reopenedStop).length;
      const inBatch = judged.filter((entry) => entry.row.reopenedStop).length;

      if (soFar + inBatch > opts.maxReopenedStops) {
        // Only in `apply`: a dry run was never going to write these rows, and
        // the whole point of tripping the ceiling on one is to SEE which
        // contacts tripped it before deciding whether to apply.
        if (opts.apply) markUnwritten(judged);

        rows.push(...judged.map((entry) => entry.row));
        await report(batchNo, judged.map((entry) => entry.row));
        outcome = {
          kind: 'stopped',
          batchNo,
          reason: 'reopened_cap',
          reopened: soFar + inBatch,
          ceiling: opts.maxReopenedStops,
        };
        stoppedAfterBatch = batchNo - 1;
        break;
      }
    }

    let aborted: ReextractionRefused | null = null;

    if (opts.apply) {
      for (const entry of judged) {
        if (entry.plan === undefined || entry.values === undefined) continue;

        try {
          const effect = await applyRearm(
            { conversation: entry.conversation, values: entry.values, plan: entry.plan, runId, now },
            db,
          );

          entry.applied = true;

          if (effect.deletedDoNotCall !== null) {
            entry.row.deletedDoNotCall = effect.deletedDoNotCall;
          }
        } catch (error) {
          // The campaign went live under the run. Every remaining write would
          // be racing a dispatcher dialing from the same queue, so the run ends
          // here with the report it has.
          if (error instanceof ReextractionRefused) {
            aborted = error;
            break;
          }

          entry.row.error = messageOf(error);
        }
      }
    }

    // Everything the abort left behind, and any row whose own write failed.
    if (opts.apply) markUnwritten(judged);

    for (const entry of judged) {
      if (entry.plan === undefined || writesNothing(entry.plan)) continue;
      // A row nothing was written for has no "after" to ask about.
      if (opts.apply && entry.applied !== true) continue;

      entry.row.stillListed = await stillListed(entry.conversation, entry.applied === true);
    }

    rows.push(...judged.map((entry) => entry.row));

    const batchRows = judged.map((entry) => entry.row);

    await report(batchNo, batchRows);

    const totals = tally(rows, skipped);

    if (aborted !== null) {
      outcome = { kind: 'aborted', batchNo, reason: aborted.message };
      stoppedAfterBatch = batchNo - 1;
      break;
    }

    if (opts.confirmBatch) {
      /**
       * The one call in this loop the run does not own.
       *
       * A prompt on a closed stdin, or one interrupted, throws rather than
       * answering — and an exception escaping here would take the whole report
       * with it, including the record of every row already applied, which is
       * the one document that says which ones they were. So it ends the run the
       * way a `no` does, under its own reason: nobody said no, nobody was
       * asked.
       */
      let carryOn: boolean;
      let reason: 'operator' | 'confirm_failed' = 'operator';

      try {
        carryOn = await opts.confirmBatch({ batchNo, rows: batchRows, totalsSoFar: totals });
      } catch {
        carryOn = false;
        reason = 'confirm_failed';
      }

      if (!carryOn) {
        outcome = { kind: 'stopped', batchNo, reason };
        stoppedAfterBatch = batchNo;
        break;
      }
    }
  }

  return {
    runId,
    campaignId: opts.campaignId,
    apply: opts.apply,
    rows,
    notSelected: skipped,
    totals: tally(rows, skipped),
    status: outcome.kind,
    outcome,
    stoppedAfterBatch,
    markdown: renderReport({ ...reportHeader, rows, notSelected: skipped, outcome }),
  };
}

/**
 * A row carrying only what is true before the model is asked anything: which
 * conversation it is, and what the campaign currently believes about it.
 *
 * The old verdict is read through `readCallNote`, which sees the six managed
 * keys and nothing else — so a conversation an earlier run judged reports its
 * outcome rather than that run's bookkeeping.
 */
function blankRow(conversation: Conversation): RunRow {
  const old = readCallNote(conversation.oldExtraction);

  return {
    campaignContactId: conversation.campaignContactId,
    // Last four digits: the report is pasted into chats and issue threads.
    phoneTail: conversation.phone.slice(-4),
    attemptNo: conversation.attemptNo,
    oldOutcome: old.outcome,
    oldCallbackType: old.callbackType,
    newOutcome: null,
    newCallbackType: null,
    oldStatus: conversation.oldStatus,
    newPlan: 'skipped',
    reopenedStop: false,
    stillListed: false,
    oldExtraction: conversation.oldExtraction,
  };
}
