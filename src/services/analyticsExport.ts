import { Prisma } from '@prisma/client';
import type { AnalyticsRange } from '../lib/analyticsQuery.js';
import { classifyAttempt, classifyOutcome } from '../lib/callOutcome.js';
import { toDisplayCredits } from '../lib/credits.js';
import { prisma } from '../lib/prisma.js';

/**
 * A workspace's calls as CSV, streamed.
 *
 * Streamed rather than assembled, because the alternative is holding a
 * workspace's whole history in this process's heap on the way to a response
 * that is written out a chunk at a time anyway.
 *
 * **Two sources, one file.** Campaign calls are `CallAttempt` rows the dialer
 * wrote; everything else is `CallRecord` rows the analytics ingest wrote. Each
 * is walked by its own keyset and the two are **merged** newest-first, so the
 * file is in one chronological order rather than one source after the other. A
 * `source` column says which row came from where, because the two carry
 * genuinely different fields and a reader reconciling against the platform
 * needs to know which they are looking at.
 */

/**
 * Rows read per query, per source.
 *
 * Large enough that a year of calls is a handful of round trips, small enough
 * that no single result set is a memory problem. Two sources are in flight at
 * once, so the real ceiling is twice this.
 */
export const EXPORT_PAGE_SIZE = 500;

/**
 * The header, and the order every row follows.
 *
 * `disposition` and `outcome` are both here on purpose: the first is what the
 * carrier said, which is what a reader reconciling against the platform needs,
 * and the second is the bucket this service put it in, which is what a reader
 * filtering in a spreadsheet needs. Emitting only the bucket would hide a value
 * the classifier did not recognise; emitting only the raw value would make
 * every reader re-derive the classification, differently.
 *
 * `cost_credits` and `charged` are two columns rather than one because a call
 * can complete against a balance too small to cover it: the cost is real, the
 * charge never happened, and one column would have to pick which of those to
 * tell. `charged=false` beside a cost is exactly that state.
 */
export const EXPORT_COLUMNS = [
  'call_id',
  'started_at',
  'source',
  'direction',
  'phone',
  'status',
  'disposition',
  'outcome',
  'duration_seconds',
  'campaign_id',
  'campaign_name',
  'attempt_no',
  'cost_credits',
  'charged',
] as const;

export type CsvValue = string | number | boolean | null | undefined;

/**
 * Characters a spreadsheet reads as the start of a formula.
 *
 * `+` is the one that matters here and it is not hypothetical: `phone` is
 * E.164, so **every** phone number in this export begins with one. An unguarded
 * export of this table is a spreadsheet full of formulas, some of which the
 * application will offer to execute.
 *
 * Tab and carriage return are included because a leading one is stripped by
 * some spreadsheets before the first visible character is examined, which puts
 * whatever follows back at the front.
 */
const FORMULA_LEADERS = ['=', '+', '-', '@', '\t', '\r'];

/** Characters that force the cell to be quoted under RFC 4180. */
const NEEDS_QUOTING = /["\r\n,]/;

/**
 * One cell, escaped and neutralised.
 *
 * A leading formula character is prefixed with an apostrophe — the convention
 * every major spreadsheet reads as "this is text" — and the cell is then quoted
 * so the apostrophe itself survives. Quoting *alone* does not help: a
 * spreadsheet strips the quotes and evaluates what was inside them.
 *
 * Numbers and booleans pass through unguarded. They are this service's own
 * values rather than a carrier's strings, they cannot carry a payload, and
 * quoting them would turn every duration into a text cell that will not sum.
 *
 * Absent renders empty, never the word `null` — a cell reading "null" is a
 * value somebody will filter on.
 */
export function toCsvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';

  const guarded = FORMULA_LEADERS.some((leader) => value.startsWith(leader)) ? `'${value}` : value;

  if (!NEEDS_QUOTING.test(guarded) && guarded === value) return guarded;

  return `"${guarded.replace(/"/g, '""')}"`;
}

export function toCsvLine(values: CsvValue[]): string {
  return values.map(toCsvCell).join(',');
}

export interface ExportSink {
  /**
   * Writes one chunk. Returns `false` when the consumer's buffer is full —
   * `res.write`'s own contract.
   */
  write: (chunk: string) => boolean | void;
  /**
   * Resolves when the consumer has drained.
   *
   * Without this the "streamed" claim is not true: a slow client that never
   * drains would have every page of the export accumulate in this process's
   * socket buffer, and an unbounded export would be an unbounded allocation.
   *
   * It must also settle when the consumer goes away, not only when it catches
   * up — a reader who closes the tab mid-download never drains, and a `drain`
   * that only awaited drain would leave this walk suspended for the life of the
   * process.
   */
  drain?: () => Promise<void>;
  /**
   * Whether the consumer has gone.
   *
   * Checked between pages so a closed connection ends the walk instead of
   * paging through the rest of a workspace's history into a socket nobody is
   * reading.
   */
  aborted?: () => boolean;
}

export interface ExportOptions {
  /**
   * Rows read per query, per source.
   *
   * A seam, in the same spirit as the ingest's `pageSize`: the keyset's
   * behaviour at a page boundary, and the merge's behaviour when one source
   * runs out, are what these pages exist to get right, and exercising either
   * otherwise costs a five-hundred-row fixture. Nothing in production passes
   * it.
   */
  pageSize?: number;
}

export interface ExportFilters {
  /**
   * Narrow to one campaign.
   *
   * Resolved by the ROUTE against the workspace before it reaches here — the
   * same `findFirst({ where: { id, workspaceId } })` every campaign surface
   * runs — so an id that arrives here has already been proved to belong. The
   * queries still filter on `workspaceId` as well, which is redundant on
   * purpose: two independent filters mean a later refactor of that lookup
   * cannot silently widen this one.
   *
   * A campaign filter drops the `CallRecord` source entirely rather than
   * filtering it, because no row there is a campaign call.
   */
  campaignId?: string | null;
}

/** One row of the file, from either source. */
interface ExportRow {
  startedAt: Date;
  /** Tiebreaker within an instant. Unique per source, which is all the sort needs. */
  id: string;
  cells: CsvValue[];
}

/**
 * The campaign half: one row per dial the dialer placed.
 *
 * **Never Prisma's `cursor`.** It resolves through an unfiltered subquery — no
 * workspace, no range — so an id the caller cannot see still steers the query,
 * which is an existence-and-position oracle across the tenant boundary; and its
 * unconditional `skip: 1` then drops a row the caller never saw. The anchor
 * here is folded into the same `where` as the scope, so there is nothing for it
 * to escape.
 *
 * The tiebreaker on `id` is not optional. Rows written in one pass share a
 * `startedAt` to the millisecond, and an unstable sort under paging repeats one
 * row and omits another — in a file somebody is about to treat as a record.
 */
async function* walkAttempts(
  workspaceId: string,
  range: AnalyticsRange,
  campaignId: string | null,
  pageSize: number,
): AsyncGenerator<ExportRow> {
  let anchor: { startedAt: Date; id: string } | null = null;

  for (;;) {
    const where: Prisma.CallAttemptWhereInput = {
      workspaceId,
      startedAt: { gte: range.from, lte: range.to },
      ...(campaignId ? { campaignId } : {}),
    };

    if (anchor) {
      where.OR = [
        { startedAt: { lt: anchor.startedAt } },
        { startedAt: anchor.startedAt, id: { lt: anchor.id } },
      ];
    }

    const rows = await prisma.callAttempt.findMany({
      where,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: pageSize,
      select: {
        id: true,
        upstreamCallId: true,
        startedAt: true,
        status: true,
        upstreamStatus: true,
        disposition: true,
        answeredBy: true,
        durationSecs: true,
        attemptNo: true,
        costCredits: true,
        chargedAt: true,
        shortfall: true,
        campaign: { select: { id: true, name: true } },
        campaignContact: { select: { contact: { select: { phone: true } } } },
      },
    });

    if (rows.length === 0) return;

    for (const row of rows) {
      yield {
        startedAt: row.startedAt,
        id: row.id,
        cells: [
          row.upstreamCallId,
          row.startedAt.toISOString(),
          'campaign',
          // A campaign call is always outbound. Stated rather than left empty,
          // which would read as "unknown" rather than as "by construction".
          'outbound',
          // Null when the campaign was deleted: the attempt is kept as billing
          // history, but its campaign and assignment pointers are gone.
          row.campaignContact?.contact.phone ?? null,
          row.upstreamStatus ?? row.status,
          row.disposition,
          classifyAttempt(row.disposition, row.upstreamStatus, row.status, row.answeredBy),
          row.durationSecs,
          row.campaign?.id ?? null,
          row.campaign?.name ?? null,
          row.attemptNo,
          row.costCredits === null ? null : toDisplayCredits(row.costCredits),
          // A cost beside `charged=false` is a shortfall: the call completed,
          // the cost is real, and nothing was debited.
          row.chargedAt !== null && !row.shortfall,
        ],
      };
    }

    if (rows.length < pageSize) return;

    const last = rows[rows.length - 1];
    anchor = { startedAt: last.startedAt, id: last.id };
  }
}

/** The other half: everything on the shared account that is not a campaign call. */
async function* walkRecords(
  workspaceId: string,
  range: AnalyticsRange,
  pageSize: number,
): AsyncGenerator<ExportRow> {
  let anchor: { startedAt: Date; id: string } | null = null;

  for (;;) {
    const where: Prisma.CallRecordWhereInput = {
      workspaceId,
      startedAt: { gte: range.from, lte: range.to },
    };

    if (anchor) {
      where.OR = [
        { startedAt: { lt: anchor.startedAt } },
        { startedAt: anchor.startedAt, id: { lt: anchor.id } },
      ];
    }

    const rows = await prisma.callRecord.findMany({
      where,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: pageSize,
      select: {
        id: true,
        upstreamCallId: true,
        startedAt: true,
        direction: true,
        phone: true,
        status: true,
        disposition: true,
        durationSecs: true,
      },
    });

    if (rows.length === 0) return;

    for (const row of rows) {
      // The range filter excludes undated rows, so this cannot fire. Guarded
      // rather than asserted: a null anchor would silently restart the walk
      // from the top and repeat the whole file.
      const startedAt = row.startedAt;
      if (!startedAt) continue;

      yield {
        startedAt,
        id: row.id,
        cells: [
          row.upstreamCallId,
          startedAt.toISOString(),
          'other',
          row.direction,
          row.phone,
          row.status,
          row.disposition,
          classifyOutcome(row.disposition, row.status),
          row.durationSecs,
          // No campaign, by construction — the ingest never stores one.
          null,
          null,
          null,
          // Not billed: metering charges a campaign attempt and this is not
          // one. Empty rather than `0`, which would claim the call was free.
          null,
          null,
        ],
      };
    }

    if (rows.length < pageSize) return;

    const last = rows[rows.length - 1];
    // Cannot be null — the range filter excludes undated rows — but an anchor
    // that was would silently restart the walk from the top.
    if (!last.startedAt) return;

    anchor = { startedAt: last.startedAt, id: last.id };
  }
}

/**
 * Merges two newest-first streams into one.
 *
 * A two-way merge rather than collecting and sorting: each source is already
 * ordered, so taking the newer of the two heads is enough, and it keeps memory
 * bounded by one row per source rather than by the size of the export.
 *
 * The tiebreaker on `id` matters here too — without it two rows sharing an
 * instant would order arbitrarily between passes, and the same export run twice
 * would produce two different files.
 */
async function* merge(
  a: AsyncGenerator<ExportRow>,
  b: AsyncGenerator<ExportRow>,
): AsyncGenerator<ExportRow> {
  let left = await a.next();
  let right = await b.next();

  for (;;) {
    if (left.done && right.done) return;

    if (left.done) {
      yield right.value as ExportRow;
      right = await b.next();
      continue;
    }

    if (right.done) {
      yield left.value as ExportRow;
      left = await a.next();
      continue;
    }

    const l = left.value as ExportRow;
    const r = right.value as ExportRow;
    const takeLeft =
      l.startedAt.getTime() !== r.startedAt.getTime()
        ? l.startedAt.getTime() > r.startedAt.getTime()
        : l.id > r.id;

    if (takeLeft) {
      yield l;
      left = await a.next();
    } else {
      yield r;
      right = await b.next();
    }
  }
}

/** A source that yields nothing, for a filter that excludes one entirely. */
async function* nothing(): AsyncGenerator<ExportRow> {
  // Intentionally empty.
}

/**
 * Writes the whole export, header first.
 *
 * The caller supplies the sink and owns the response, so this service owns rows
 * and nothing else — which is what lets it be tested without an HTTP server.
 *
 * **No row cap.** A cap means one of two things, and both are worse: a
 * truncated file that reads as complete — the one outcome forbidden on every
 * listing in this service — or a truncation marker inside the CSV, where it
 * becomes a data row in somebody's spreadsheet. Both sources are indexed on the
 * workspace and paged, and backpressure is honoured, so a large export is slow
 * rather than unbounded.
 */
export async function streamWorkspaceCsv(
  workspaceId: string,
  range: AnalyticsRange,
  sink: ExportSink | ((chunk: string) => boolean | void),
  options: ExportOptions & ExportFilters = {},
): Promise<void> {
  const { write, drain, aborted } =
    typeof sink === 'function' ? { write: sink, drain: undefined, aborted: undefined } : sink;

  const pageSize = Math.max(1, options.pageSize ?? EXPORT_PAGE_SIZE);
  const campaignId = options.campaignId ?? null;

  // The BOM is what makes a spreadsheet open this as UTF-8 rather than guess at
  // it, which is how a name in Devanagari or an accented one arrives mangled.
  write('﻿');
  // Header first and unconditionally: an empty file and a file of headers say
  // different things, and only the second reads as an answer rather than as a
  // download that failed.
  write(`${toCsvLine([...EXPORT_COLUMNS])}\r\n`);

  const attempts = walkAttempts(workspaceId, range, campaignId, pageSize);
  // A campaign filter drops this source rather than filtering it: no row here
  // is a campaign call, so a filtered walk would read the whole table to return
  // nothing.
  const records = campaignId ? nothing() : walkRecords(workspaceId, range, pageSize);

  let full = false;
  let since = 0;

  for await (const row of merge(attempts, records)) {
    full = write(`${toCsvLine(row.cells)}\r\n`) === false;
    since += 1;

    // Checked on a page's worth of rows rather than on every row: awaiting per
    // row would turn one export into a round trip per line, and a page is a
    // bounded amount to have in flight.
    if (since >= pageSize) {
      since = 0;
      if (aborted?.()) return;
      if (full && drain) {
        await drain();
        if (aborted?.()) return;
      }
    }
  }
}
