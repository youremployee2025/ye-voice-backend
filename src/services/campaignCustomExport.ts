import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { isReachedAttempt, REACHED_DISPOSITIONS } from '../lib/campaignOutcomes.js';
import { toDisplayCredits } from '../lib/credits.js';
import { variablesFor } from '../lib/callVariables.js';
import { RESERVED_EXTRACTION_KEYS } from '../lib/extractionConfig.js';
import { disconnectColumns } from '../lib/campaignExportColumns.js';
import { variableColumns, type ExportCampaign } from './campaignLeadsExport.js';
import { toCsvLine, type CsvValue, type ExportSink } from './analyticsExport.js';

/**
 * A campaign's dials as CSV with the columns the reader chose — one row per
 * `CallAttempt`, and one column group per box ticked in the dialog.
 *
 * The third export beside the leads and call-detail sheets, and the one with
 * no parity contract: those two reproduce a reference file column for column,
 * which is why neither can carry a transcript or a recording. This one exists
 * precisely to carry the per-call facts that file never had — transcript,
 * recording, credits, the platform's own identifiers — and it is per DIAL
 * because every one of those is a fact about a call rather than a person.
 *
 * **The extraction group is per dial, deliberately.** The leads sheet prints
 * the one extraction that "speaks for" a lead, suppressing what a voicemail
 * wrote; this file prints what each call wrote, because a reader who asked for
 * per-dial rows is reconciling calls, and the dialog says so beside the box.
 *
 * **Inbound calls ride the same file.** They live in `CampaignInboundCall`,
 * a narrower row — no transcript, no variables, no answer detection — and a
 * campaign that only ever received calls exported a header and nothing else
 * while this walked `CallAttempt` alone. The two sources are walked by their
 * own keysets and merged by time, and `Direction` says which each row is; an
 * inbound row fills what it recorded and leaves the rest empty rather than
 * inventing it.
 *
 * Same streaming, same sink contract, same keyset as the calls sheet.
 */

export const CUSTOM_PAGE_SIZE = 200;

/** Group keys, as the query string spells them. */
export type CustomExportGroup =
  | 'attempts'
  | 'credits'
  | 'variables'
  | 'extractions'
  | 'transcript'
  | 'recording'
  | 'session';

export interface GroupSpec {
  key: CustomExportGroup;
  /** Fixed columns. Empty for the two groups whose header is read from the data. */
  columns: readonly string[];
}

/**
 * Every group, in the order the file lays them out. The order is fixed here
 * rather than following the query string, so two exports with the same boxes
 * ticked in a different order are the same file.
 */
export const CUSTOM_EXPORT_GROUPS: readonly GroupSpec[] = [
  {
    key: 'attempts',
    columns: [
      'Status',
      'Disposition',
      'Reached',
      'Answered At',
      'Ended At',
      'Duration (Seconds)',
      'Disconnected By',
      'End Call Reason',
    ],
  },
  {
    key: 'credits',
    columns: ['Cost Credits', 'Billed Seconds', 'Rate Credits Per Minute', 'Tier', 'Charged At'],
  },
  { key: 'variables', columns: [] },
  { key: 'extractions', columns: [] },
  { key: 'transcript', columns: ['Transcript'] },
  { key: 'recording', columns: ['Recording'] },
  {
    key: 'session',
    columns: [
      'Upstream Call ID',
      'Upstream Session ID',
      'Answered By',
      'Hangup Cause',
      'Hangup Source',
      'Upstream Status',
      'Call Kind',
      'Error Message',
    ],
  },
];

const GROUP_KEYS = new Set<string>(CUSTOM_EXPORT_GROUPS.map((group) => group.key));

/** Always first, whatever was chosen: a row nobody can attribute is noise. */
export const IDENTITY_COLUMNS = [
  'Lead ID',
  'Lead Name',
  'Phone',
  'Attempt ID',
  'Attempt No',
  'Started At',
  'Direction',
] as const;

export class CustomExportFieldsError extends Error {}

/**
 * `?fields=` to the groups it names, in canonical order.
 *
 * Refuses rather than ignores: an unknown name is a typo or a stale client,
 * and a file silently missing the group it asked for is the outcome a reader
 * discovers last. An empty list is refused for the same reason — identity
 * columns alone are not an export anybody asked for.
 */
export function parseCustomExportFields(raw: unknown): CustomExportGroup[] {
  if (typeof raw !== 'string') throw new CustomExportFieldsError('fields is required.');

  const wanted = new Set(
    raw
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== ''),
  );

  if (wanted.size === 0) throw new CustomExportFieldsError('fields must name at least one group.');

  for (const name of wanted) {
    if (!GROUP_KEYS.has(name)) {
      throw new CustomExportFieldsError(`Unknown export field group: ${name}.`);
    }
  }

  return CUSTOM_EXPORT_GROUPS.map((group) => group.key).filter((key) => wanted.has(key));
}

export interface CustomExportOptions {
  fields: CustomExportGroup[];
  /** Bounds on `startedAt`, both inclusive. Absent walks the whole campaign. */
  range?: { from: Date; to: Date };
  pageSize?: number;
  /** Base URL for the recording link. Absent leaves the column empty. */
  appUrl?: string | null;
}

interface ExportAttempt {
  id: string;
  attemptNo: number;
  status: string;
  disposition: string | null;
  answeredBy: string | null;
  hangupCause: string | null;
  hangupSource: string | null;
  upstreamStatus: string | null;
  upstreamCallId: string | null;
  upstreamSessionId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  kind: string | null;
  launchError: string | null;
  startedAt: Date;
  answeredAt: Date | null;
  endedAt: Date | null;
  durationSecs: number | null;
  billedSecs: number | null;
  rateCreditsPerMin: bigint | null;
  costCredits: bigint | null;
  tierSlug: string | null;
  chargedAt: Date | null;
  recordingAvailable: boolean | null;
  transcript: Prisma.JsonValue | null;
  variables: Prisma.JsonValue | null;
  extraction: Prisma.JsonValue | null;
  campaignContact: {
    id: string;
    contact: { phone: string; name: string | null; email: string | null; tags: string[]; metadata: Prisma.JsonValue };
  } | null;
}

/** One inbound call as the page reads it. */
interface ExportInbound {
  id: string;
  arrivedAt: Date;
  endedAt: Date | null;
  durationSecs: number | null;
  disposition: string | null;
  fromNumber: string;
  campaignContactId: string | null;
  contactId: string | null;
  upstreamPhoneCallId: string | null;
  upstreamSessionId: string | null;
  costCredits: bigint | null;
  extraction: Prisma.JsonValue | null;
  transcript: Prisma.JsonValue | null;
  recordingAvailable: boolean | null;
}

/** A row of either source, with the instant the merge orders on. */
type Row =
  | { kind: 'outbound'; at: Date; id: string; attempt: ExportAttempt }
  | { kind: 'inbound'; at: Date; id: string; call: ExportInbound; contact: { name: string | null } | null };

function stamp(at: Date | null | undefined): string {
  if (!at) return '';

  return at.toISOString().slice(0, 19).replace('T', ' ');
}

function record(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cell(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  return JSON.stringify(value);
}

/**
 * The conversation as one cell: `role: content`, one turn per line.
 *
 * A stored transcript is an array of turns (`sessionCapture`); anything else
 * in the column is a diagnostic about a call that never connected, and it is
 * left empty rather than printed as something somebody said.
 */
function transcriptCell(value: Prisma.JsonValue | null): string {
  if (!Array.isArray(value)) return '';

  return value
    .map((turn) => {
      const t = record(turn as Prisma.JsonValue);
      if (!t) return null;
      const content = typeof t.content === 'string' ? t.content : null;
      if (content === null) return null;
      const role = typeof t.role === 'string' ? t.role : 'unknown';

      return `${role}: ${content}`;
    })
    .filter((line): line is string => line !== null)
    .join('\n');
}

/**
 * Every extraction key this campaign's calls carried, dials and inbound alike.
 *
 * Its own query rather than the leads sheet's, which reads `CallAttempt`
 * only — a key an inbound call answered would otherwise have no column.
 */
async function allExtractionKeys(campaignId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ key: string }[]>`
    SELECT DISTINCT key FROM (
      SELECT jsonb_object_keys(a."extraction") AS key
      FROM "CallAttempt" a
      WHERE a."campaignId" = ${campaignId} AND a."extraction" IS NOT NULL
      UNION ALL
      SELECT jsonb_object_keys(i."extraction") AS key
      FROM "CampaignInboundCall" i
      WHERE i."campaignId" = ${campaignId} AND i."extraction" IS NOT NULL
    ) keys
  `;

  return rows.map((row) => row.key);
}

/** Extraction keys as columns: sorted, reserved machinery dropped. */
function extractionColumns(keys: readonly string[]): string[] {
  return [...new Set(keys.filter((key) => !RESERVED_EXTRACTION_KEYS.has(key)))].sort((a, b) =>
    a.localeCompare(b),
  );
}

export async function streamCustomCsv(
  campaignId: string,
  sink: ExportSink | ((chunk: string) => boolean | void),
  options: CustomExportOptions,
): Promise<void> {
  const { write, drain, aborted } =
    typeof sink === 'function' ? { write: sink, drain: undefined, aborted: undefined } : sink;

  const pageSize = Math.max(1, options.pageSize ?? CUSTOM_PAGE_SIZE);
  const chosen = new Set(options.fields);

  const loaded = (await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      name: true,
      status: true,
      startedAt: true,
      leadBucketKey: true,
      variableMap: true,
      agent: { select: { variables: true } },
    },
  })) as ExportCampaign | null;

  if (!loaded) return;
  // A non-null binding: the row builders below are closures, and TypeScript
  // does not carry the early return's narrowing into them.
  const campaign: ExportCampaign = loaded;

  // The two data-derived headers, read only when asked for: the extraction
  // scan walks every attempt's JSONB and is not free on a large campaign.
  const variables = chosen.has('variables') ? variableColumns(campaign) : [];
  const extractions = chosen.has('extractions') ? extractionColumns(await allExtractionKeys(campaignId)) : [];

  const header: string[] = [...IDENTITY_COLUMNS];
  for (const group of CUSTOM_EXPORT_GROUPS) {
    if (!chosen.has(group.key)) continue;
    if (group.key === 'variables') header.push(...variables);
    else if (group.key === 'extractions') header.push(...extractions.map((key) => `Extraction ${key}`));
    else header.push(...group.columns);
  }

  write('﻿');
  write(`${toCsvLine(header)}\r\n`);

  /**
   * Each source paged by its own keyset, never Prisma's `cursor` — see the
   * calls sheet for why. The range is ANDed with the keyset rather than folded
   * into it, so the first page and every later one filter alike.
   */
  async function* outbound(): AsyncGenerator<Row> {
    let cursor: { startedAt: Date; id: string } | null = null;

    for (;;) {
      const attempts: ExportAttempt[] = await prisma.callAttempt.findMany({
        where: {
          campaignId,
          ...(options.range ? { startedAt: { gte: options.range.from, lte: options.range.to } } : {}),
          ...(cursor
            ? {
                AND: [
                  {
                    OR: [
                      { startedAt: { gt: cursor.startedAt } },
                      { startedAt: cursor.startedAt, id: { gt: cursor.id } },
                    ],
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
        take: pageSize,
        select: {
          id: true,
          attemptNo: true,
          status: true,
          disposition: true,
          answeredBy: true,
          hangupCause: true,
          hangupSource: true,
          upstreamStatus: true,
          upstreamCallId: true,
          upstreamSessionId: true,
          errorCode: true,
          errorMessage: true,
          kind: true,
          launchError: true,
          startedAt: true,
          answeredAt: true,
          endedAt: true,
          durationSecs: true,
          billedSecs: true,
          rateCreditsPerMin: true,
          costCredits: true,
          tierSlug: true,
          chargedAt: true,
          recordingAvailable: true,
          transcript: true,
          variables: true,
          extraction: true,
          campaignContact: {
            select: {
              id: true,
              contact: { select: { phone: true, name: true, email: true, tags: true, metadata: true } },
            },
          },
        },
      });

      for (const attempt of attempts) yield { kind: 'outbound', at: attempt.startedAt, id: attempt.id, attempt };

      if (attempts.length < pageSize) return;
      const last = attempts[attempts.length - 1]!;
      cursor = { startedAt: last.startedAt, id: last.id };
    }
  }

  async function* inbound(): AsyncGenerator<Row> {
    let cursor: { arrivedAt: Date; id: string } | null = null;

    for (;;) {
      const calls: ExportInbound[] = await prisma.campaignInboundCall.findMany({
        where: {
          campaignId,
          ...(options.range ? { arrivedAt: { gte: options.range.from, lte: options.range.to } } : {}),
          ...(cursor
            ? {
                AND: [
                  {
                    OR: [
                      { arrivedAt: { gt: cursor.arrivedAt } },
                      { arrivedAt: cursor.arrivedAt, id: { gt: cursor.id } },
                    ],
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ arrivedAt: 'asc' }, { id: 'asc' }],
        take: pageSize,
        select: {
          id: true,
          arrivedAt: true,
          endedAt: true,
          durationSecs: true,
          disposition: true,
          fromNumber: true,
          campaignContactId: true,
          contactId: true,
          upstreamPhoneCallId: true,
          upstreamSessionId: true,
          costCredits: true,
          extraction: true,
          transcript: true,
          recordingAvailable: true,
        },
      });

      // The caller, resolved once per page: the inbound row carries no
      // relation to the contact, only its id.
      const contactIds = [...new Set(calls.map((c) => c.contactId).filter((id): id is string => id !== null))];
      const contacts = new Map(
        (contactIds.length
          ? await prisma.contact.findMany({ where: { id: { in: contactIds } }, select: { id: true, name: true } })
          : []
        ).map((c) => [c.id, { name: c.name }]),
      );

      for (const call of calls) {
        yield {
          kind: 'inbound',
          at: call.arrivedAt,
          id: call.id,
          call,
          contact: call.contactId ? (contacts.get(call.contactId) ?? null) : null,
        };
      }

      if (calls.length < pageSize) return;
      const last = calls[calls.length - 1]!;
      cursor = { arrivedAt: last.arrivedAt, id: last.id };
    }
  }

  /** Both sources, oldest first — a two-way merge on the head of each. */
  async function* merged(): AsyncGenerator<Row> {
    const a = outbound();
    const b = inbound();
    let ra = await a.next();
    let rb = await b.next();

    while (!ra.done || !rb.done) {
      const takeA =
        rb.done ||
        (!ra.done && (ra.value.at < rb.value.at || (ra.value.at.getTime() === rb.value.at.getTime() && ra.value.kind === 'outbound')));

      if (takeA) {
        yield ra.value as Row;
        ra = await a.next();
      } else {
        yield rb.value as Row;
        rb = await b.next();
      }
    }
  }

  let written = 0;
  let full = false;

  for await (const row of merged()) {
    if (write(`${toCsvLine(rowCells(row))}\r\n`) === false) full = true;
    written += 1;

    // The drain is honoured per page rather than per row, as the calls sheet
    // does: `'drain'` fires only after a write returned `false`, and awaiting
    // it after a run of small writes waits for an event that never comes.
    if (written % pageSize === 0) {
      if (aborted?.()) return;
      if (full && drain) await drain();
      full = false;
      if (aborted?.()) return;
    }
  }

  function rowCells(row: Row): CsvValue[] {
    if (row.kind === 'outbound') return outboundCells(row.attempt);
    return inboundCells(row.call, row.contact);
  }

  function outboundCells(attempt: ExportAttempt): CsvValue[] {
    const lead = attempt.campaignContact;
    const cells: CsvValue[] = [
      lead?.id ?? '',
      lead?.contact.name ?? '',
      lead?.contact.phone ?? '',
      attempt.id,
      attempt.attemptNo,
      stamp(attempt.startedAt),
      'Outbound',
    ];

    for (const group of CUSTOM_EXPORT_GROUPS) {
      if (!chosen.has(group.key)) continue;

      switch (group.key) {
        case 'attempts': {
          const disconnect = disconnectColumns({
            hangupSource: attempt.hangupSource,
            disposition: attempt.disposition,
            launchError: attempt.launchError,
          });
          cells.push(
            attempt.status.toLowerCase(),
            attempt.disposition ?? '',
            isReachedAttempt(attempt) ? 'Yes' : 'No',
            stamp(attempt.answeredAt),
            stamp(attempt.endedAt),
            attempt.durationSecs ?? '',
            disconnect.disconnectedBy,
            attempt.errorCode ?? '',
          );
          break;
        }
        case 'credits':
          cells.push(
            attempt.costCredits === null ? '' : toDisplayCredits(attempt.costCredits),
            attempt.billedSecs ?? '',
            attempt.rateCreditsPerMin === null ? '' : toDisplayCredits(attempt.rateCreditsPerMin),
            attempt.tierSlug ?? '',
            stamp(attempt.chargedAt),
          );
          break;
        case 'variables': {
          // Stored first, projection as the fallback — the leads sheet's
          // rule, for the same reason: only the stored value describes a
          // call that already happened.
          const stored = record(attempt.variables);
          const projected =
            lead && stored === null ? variablesFor(campaign, campaign.agent?.variables, lead.contact) : null;
          for (const name of variables) {
            const value = stored?.[name];
            cells.push(value !== undefined && value !== null ? cell(value) : (projected?.[name] ?? ''));
          }
          break;
        }
        case 'extractions': {
          const extraction = record(attempt.extraction);
          for (const key of extractions) cells.push(cell(extraction?.[key]));
          break;
        }
        case 'transcript':
          cells.push(transcriptCell(attempt.transcript));
          break;
        case 'recording':
          // The audio sits behind a two-minute token, so the only URL that
          // stays valid in a spreadsheet is the page that mints one.
          cells.push(
            options.appUrl && attempt.recordingAvailable && attempt.upstreamCallId
              ? `${options.appUrl}/calls/${attempt.upstreamCallId}`
              : '',
          );
          break;
        case 'session':
          cells.push(
            attempt.upstreamCallId ?? '',
            attempt.upstreamSessionId ?? '',
            attempt.answeredBy ?? '',
            attempt.hangupCause ?? '',
            attempt.hangupSource ?? '',
            attempt.upstreamStatus ?? '',
            attempt.kind ?? '',
            attempt.errorMessage ?? '',
          );
          break;
      }
    }

    return cells;
  }

  /**
   * An inbound row: what it recorded, and blanks for what it never had.
   *
   * No status, no answer detection, no hangup source, no transcript, no
   * variables — none of those exist on the inbound table, and a blank is the
   * honest cell. Reached is the disposition alone, which is the whole of
   * `REACHED_ATTEMPT` that an inbound row can answer. The transcript and the
   * recording flag are the two session facts the row does hold, written by
   * the completion webhook and the inbound backfill; the recording link goes
   * by the platform call id, which is what the call page resolves.
   */
  function inboundCells(call: ExportInbound, contact: { name: string | null } | null): CsvValue[] {
    const cells: CsvValue[] = [
      call.campaignContactId ?? '',
      contact?.name ?? '',
      call.fromNumber,
      call.id,
      '',
      stamp(call.arrivedAt),
      'Inbound',
    ];
    const reached =
      call.disposition !== null && (REACHED_DISPOSITIONS as readonly string[]).includes(call.disposition);

    for (const group of CUSTOM_EXPORT_GROUPS) {
      if (!chosen.has(group.key)) continue;

      switch (group.key) {
        case 'attempts':
          cells.push('', call.disposition ?? '', reached ? 'Yes' : 'No', '', stamp(call.endedAt), call.durationSecs ?? '', '', '');
          break;
        case 'credits':
          cells.push(call.costCredits === null ? '' : toDisplayCredits(call.costCredits), '', '', '', '');
          break;
        case 'variables':
          for (let i = 0; i < variables.length; i += 1) cells.push('');
          break;
        case 'extractions': {
          const extraction = record(call.extraction);
          for (const key of extractions) cells.push(cell(extraction?.[key]));
          break;
        }
        case 'transcript':
          cells.push(transcriptCell(call.transcript));
          break;
        case 'recording':
          cells.push(
            options.appUrl && call.recordingAvailable && call.upstreamPhoneCallId
              ? `${options.appUrl}/calls/${call.upstreamPhoneCallId}`
              : '',
          );
          break;
        case 'session':
          cells.push(call.upstreamPhoneCallId ?? '', call.upstreamSessionId ?? '', '', '', '', '', '', '');
          break;
      }
    }

    return cells;
  }
}
