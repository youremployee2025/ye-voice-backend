/**
 * The document an operator decides on.
 *
 * A run of this tool rewrites the queue of a whole campaign, and the only part
 * of it a person ever sees is this. So the rendering is a module with tests
 * rather than template literals inside the orchestrator: what the report
 * groups by, and above all what it separates, is the difference between an
 * operator unpausing a campaign that is genuinely re-armed and one whose next
 * dispatcher sweep will settle half of it straight back out.
 *
 * Pure. It takes rows and renders markdown; it reads no database and knows no
 * Prisma. Every case in its tests is a few lines of data.
 */
import type { RearmPlan } from './plan.js';

/** One conversation, as the run left it. */
export interface RunRow {
  campaignContactId: string;
  /** Last four digits. The report is pasted into chats and issue threads, and
   *  a full number in it is a lead's telephone number in somebody's clipboard. */
  phoneTail: string;
  attemptNo: number;
  oldOutcome: string | null;
  oldCallbackType: string | null;
  newOutcome: string | null;
  newCallbackType: string | null;
  oldStatus: string;
  /** The plan the new note earned, or `skipped` for a conversation that was
   *  never judged — and for one judged in a batch that was then abandoned. */
  newPlan: RearmPlan['kind'] | 'skipped';
  /** Why it was skipped: a `ReextractionSkip.reason`, a `ParsedReply` refusal,
   *  or `already_reextracted` / `batch_abandoned`. Never a single word for all
   *  of them — a model that quietly started answering in prose must not read
   *  like a contract whose keys were renamed. */
  skipReason?: string;
  /** The message of an error on this one row. Message only: an exception from
   *  the model client can carry a URL, and a report is a document that gets
   *  pasted into chats. */
  error?: string;
  reopenedStop: boolean;
  /**
   * Whether a do-not-call row for this campaign and number survives the
   * re-arm — one written by an uploaded opt-out list, or by another contact on
   * the same number. Such a contact is armed but not dialable: the next
   * dispatcher sweep excludes it again.
   */
  stillListed: boolean;
  /** The attempt's stored extraction before the run, for the before-and-after
   *  on a reopened stop. Rendered with this tool's markers stripped. */
  oldExtraction?: unknown;
  /**
   * The do-not-call row this re-arm deleted, as it read before it went.
   *
   * Kept because the run has just thrown away a sentence somebody wrote about a
   * person who asked not to be called, and if the operator decides the new
   * verdict was wrong, this report is the only place that sentence still
   * exists.
   */
  deletedDoNotCall?: { reason: string | null; sourceCampaignContactId: string | null };
}

/** A contact the selection never handed over, structurally rather than by
 *  import: this module stays free of the service that calls it. */
export interface NotSelected {
  campaignContactId: string;
  reason: string;
}

/**
 * How the run ended, which is the report's last line and the whole of what a
 * caller needs to choose an exit code.
 *
 * The reason is part of it rather than left to be inferred from the rows: an
 * operator answering `no` and a model outage both end a run as `stopped`, and
 * they are opposite pieces of news — one is a run that did what it was told,
 * the other is a run that stopped because nothing was working.
 */
export type RunOutcome =
  | { kind: 'completed' }
  | {
      kind: 'stopped';
      /** The batch it stopped at: the last one confirmed, or the one abandoned. */
      batchNo: number;
      /** `operator` declined the next batch; `batch_abandoned` is a model that
       *  was down; `confirm_failed` is a prompt that could not be asked at all. */
      reason: 'operator' | 'batch_abandoned' | 'confirm_failed';
    }
  | {
      kind: 'stopped';
      /** The batch that would have passed the ceiling, and was not applied. */
      batchNo: number;
      reason: 'reopened_cap';
      /** What the run would have reopened had this batch been applied, and the
       *  ceiling it was given — both, because "4 against a ceiling of 2" is a
       *  different decision from "3 against 2" and the closing line is where
       *  that decision gets made. */
      reopened: number;
      ceiling: number;
    }
  /** A refusal — a campaign that went live mid-run — ended it. */
  | { kind: 'aborted'; batchNo: number; reason: string };

export interface ReportInput {
  campaign: { id: string; name: string };
  runId: string;
  apply: boolean;
  batchSize: number;
  concurrency: number;
  startedAt: Date;
  /** The zone every relative time in every transcript was resolved against. */
  timezone: string;
  /** Whether that zone is the campaign's or this tool's fallback. */
  timezoneDefaulted: boolean;
  rows: RunRow[];
  notSelected: NotSelected[];
  outcome: RunOutcome;
}

/**
 * An extraction with this tool's own bookkeeping removed.
 *
 * `_reextractedBy` and `_reextractedAt` are how a re-run knows which
 * conversations it has already judged. They are invisible to every reader of a
 * call note by design, and they must be invisible here too: printed beside the
 * new verdict of a re-run they are two lines of noise in every row, and they
 * are not anything the model ever said. Stripped from what is RENDERED only —
 * never from what is stored, which is the whole point of them.
 */
export function stripMarkers(extraction: unknown): unknown {
  if (typeof extraction !== 'object' || extraction === null || Array.isArray(extraction)) {
    return extraction;
  }

  return Object.fromEntries(
    Object.entries(extraction as Record<string, unknown>).filter(([key]) => !key.startsWith('_')),
  );
}

const NONE = 'none';

/**
 * The counts, keyed by prefix so the groups can be rendered apart without a
 * second structure to keep in step with this one.
 *
 * A skipped row is counted under its reason and NEVER as a transition: it
 * carries whatever outcome it always had, and counting that as `stop→stop`
 * would report a run as having confirmed a verdict it never asked about.
 */
export function tally(rows: RunRow[], notSelected: NotSelected[]): Record<string, number> {
  const totals: Record<string, number> = {};
  const add = (key: string): void => {
    totals[key] = (totals[key] ?? 0) + 1;
  };

  /**
   * A reply that named no outcome is NOT a contact that moved to having no arm,
   * and an arm the dispatcher would never take is not a transition either.
   * Counted as `stop→none` they read, forty rows deep, as forty contacts this
   * run disarmed — when it wrote nothing at all for them, and each still holds
   * the verdict it always had. A hundred `over_budget:follow_up_budget` rows
   * is a different piece of news again: it is a campaign whose
   * `maxGoalFollowUps` is what is actually stopping it.
   */
  for (const row of rows) {
    // The error first where a row carries both — a row whose write failed after
    // it was judged has a skip reason too, and the failure is the news.
    if (row.error !== undefined) add('error');
    // The two plans that write nothing are counted as themselves before the
    // skip reasons, because the reason they carry IS the plan: an
    // `over_budget` row's `follow_up_budget` is not one more way a
    // conversation could not be judged, it is the judgement.
    else if (row.newPlan === 'over_budget') add(`over_budget:${row.skipReason ?? 'unknown'}`);
    else if (row.newPlan === 'no_verdict') add(`no_verdict:${row.oldOutcome ?? NONE}`);
    else if (row.skipReason !== undefined) add(`skip:${row.skipReason}`);
    else add(`transition:${row.oldOutcome ?? NONE}→${row.newOutcome ?? NONE}`);
  }

  for (const skip of notSelected) add(`not_selected:${skip.reason}`);

  return totals;
}

/** `incomplete/requested`, or just the outcome when there is no callback type. */
function verdict(outcome: string | null, callbackType: string | null): string {
  if (outcome === null && callbackType === null) return NONE;

  return callbackType === null ? (outcome ?? NONE) : `${outcome ?? NONE}/${callbackType}`;
}

/** The right-hand column: why a row did not land where it looks like it should
 *  have. Both an error and a skip reason can be present — a row abandoned with
 *  a batch, say — and both are printed. */
function note(row: RunRow): string {
  const parts: string[] = [];

  if (row.skipReason !== undefined) parts.push(row.skipReason);
  if (row.error !== undefined) parts.push(row.error);
  if (row.reopenedStop) parts.push(row.stillListed ? 'reopened, still listed' : 'reopened');

  return parts.join('; ');
}

const ROW_HEADER = [
  '| contact | phone | # | old | new | old status | plan | note |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
];

function rowLine(row: RunRow): string {
  return [
    '',
    `\`${row.campaignContactId}\``,
    `…${row.phoneTail}`,
    String(row.attemptNo),
    verdict(row.oldOutcome, row.oldCallbackType),
    verdict(row.newOutcome, row.newCallbackType),
    row.oldStatus,
    row.newPlan,
    note(row),
    '',
  ].join(' | ').trim();
}

function table(rows: RunRow[]): string[] {
  return rows.length === 0
    ? ['_No conversation was judged._']
    : [...ROW_HEADER, ...rows.map(rowLine)];
}

function totalsTable(totals: Record<string, number>): string[] {
  const keys = Object.keys(totals).sort();

  if (keys.length === 0) return ['_Nothing to count._'];

  return [
    '| group | count |',
    '| --- | --- |',
    ...keys.map((key) => `| ${key} | ${totals[key]} |`),
  ];
}

/** One reopened stop, with the note the campaign is withdrawing beside it and
 *  the do-not-call row the re-arm removed. */
function reopenedLine(row: RunRow): string {
  const before =
    row.oldExtraction === undefined ? '' : ` · was: ${JSON.stringify(stripMarkers(row.oldExtraction))}`;
  const cleared =
    row.deletedDoNotCall === undefined
      ? ''
      : ` · cleared do-not-call: ${JSON.stringify(row.deletedDoNotCall.reason)}`;

  return `- \`${row.campaignContactId}\` (…${row.phoneTail}) → ${row.newPlan}${before}${cleared}`;
}

/**
 * The section the review turns on.
 *
 * `applyRearm` deletes only the do-not-call row this contact's own withdrawn
 * `stop` created; a row an uploaded opt-out list or another contact on the same
 * number put there survives, and the dispatcher's own do-not-call sweep will
 * settle this contact `EXCLUDED` again. Listing the two halves together would
 * tell an operator that every reopened contact is back when some of them need a
 * row cleared by hand first.
 */
function reopened(rows: RunRow[]): string[] {
  const all = rows.filter((row) => row.reopenedStop);

  if (all.length === 0) return ['_No stop was reopened._'];

  const free = all.filter((row) => !row.stillListed);
  const listed = all.filter((row) => row.stillListed);

  return [
    'A contact here is dialable only if BOTH hold: no do-not-call row still covers',
    'its number, and it is inside the campaign\'s retry and dial budgets. Rows the',
    'second refused are not in this list at all — they are counted under',
    '`over_budget:` and nothing was written for them.',
    '',
    `### Dialable again (${free.length})`,
    '',
    ...(free.length === 0 ? ['_None._'] : free.map(reopenedLine)),
    '',
    `### Reopened but still listed (${listed.length})`,
    '',
    'A do-not-call row written by another source still covers these numbers, so the',
    'next dispatcher sweep will exclude them again. Clear the row before unpausing.',
    '',
    ...(listed.length === 0 ? ['_None._'] : listed.map(reopenedLine)),
  ];
}

/**
 * The last line, and the first one an operator reads when a run was long: the
 * difference between "this is the whole campaign" and "this is the first forty
 * contacts of it".
 */
function closing(outcome: RunOutcome, judged: number, apply: boolean): string {
  const seen = `${judged} conversation${judged === 1 ? '' : 's'} judged.`;

  switch (outcome.kind) {
    case 'completed':
      return `**Run completed.** ${seen}`;
    case 'stopped':
      switch (outcome.reason) {
        case 'operator':
          return `**Stopped after batch ${outcome.batchNo}** at the operator's request. ${seen}`;
        case 'confirm_failed':
          // Not a `no`: nobody was asked. The run ends there rather than
          // pressing on unattended, and this report is the record of what it
          // had already done.
          return (
            `**Stopped after batch ${outcome.batchNo}**: whether to continue could not be asked. ` +
            seen
          );
        case 'reopened_cap':
          // A ceiling the operator set, reached. The batches before it stand.
          return (
            `**Stopped before batch ${outcome.batchNo}**: applying it would have left ` +
            `${outcome.reopened} reopened stops against a ceiling of ${outcome.ceiling}. ${seen}`
          );
        case 'batch_abandoned':
          return (
            `**Stopped at batch ${outcome.batchNo}**: most of that batch failed to extract, ` +
            `so the whole batch was left unapplied. ${seen}`
          );
      }
    case 'aborted':
      // Partly, because the refusal comes from a write: everything before it in
      // that batch stands, and an operator resuming needs to know which batch to
      // look at rather than to assume it is untouched.
      return (
        `**Aborted during batch ${outcome.batchNo}**: ${outcome.reason}. ` +
        (apply ? 'Rows earlier in that batch may already be applied. ' : '') +
        seen
      );
  }
}

/**
 * The header, on its own, because it is written twice.
 *
 * Once at the top of the finished report, and once ahead of the first batch a
 * run appends as it goes — a run that is killed never writes a finished report,
 * and a file of batch tables with no idea which campaign or which mode they
 * belong to is not a record of anything.
 */
export function renderReportHeader(input: Omit<ReportInput, 'rows' | 'notSelected' | 'outcome'>): string {
  const mode = input.apply ? 'APPLY (rows were written)' : 'DRY RUN (nothing was written)';

  return [
    `# Re-extraction — ${input.campaign.name} (\`${input.campaign.id}\`)`,
    '',
    `- Mode: **${mode}**`,
    `- Run: \`${input.runId}\``,
    `- Started: ${input.startedAt.toISOString()}`,
    `- Batching: batch size ${input.batchSize}, concurrency ${input.concurrency}`,
    // Stated on every report, because it is the clock every callback this run
    // booked was resolved against and it is written down nowhere else. A
    // campaign with no zone of its own says so: it is five and a half hours of
    // difference to every time in the run, silently applied.
    `- Times anchored in: ${input.timezone}${
      input.timezoneDefaulted ? ' (the campaign names no timezone; this is the default)' : ''
    }`,
    '',
  ].join('\n');
}

export function renderReport(input: ReportInput): string {
  const totals = tally(input.rows, input.notSelected);

  return [
    renderReportHeader(input),
    '## Conversations',
    '',
    ...table(input.rows),
    '',
    '## Totals',
    '',
    ...totalsTable(totals),
    '',
    '## Reopened stops',
    '',
    ...reopened(input.rows),
    '',
    closing(input.outcome, input.rows.length, input.apply),
    '',
  ].join('\n');
}

/**
 * What is printed after each batch, before the operator is asked whether to go
 * on. The same table as the report's, plus the totals so far — a decision about
 * batch nine is made on the nine batches, not on the ninth.
 */
export function renderBatch(input: {
  batchNo: number;
  rows: RunRow[];
  totals: Record<string, number>;
}): string {
  return [
    `### Batch ${input.batchNo}`,
    '',
    ...table(input.rows),
    '',
    '**Totals so far**',
    '',
    ...totalsTable(input.totals),
    '',
  ].join('\n');
}
