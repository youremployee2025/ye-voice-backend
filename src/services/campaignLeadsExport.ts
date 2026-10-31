import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { reachedAttemptSql } from '../lib/campaignOutcomes.js';
import { variablesFor } from '../lib/callVariables.js';
import { disconnectColumns, splitExtractionKeys, type ExtractionColumns } from '../lib/campaignExportColumns.js';
import { toCsvLine, type ExportSink } from './analyticsExport.js';

/**
 * A campaign's leads as CSV, streamed — one row per `CampaignContact`.
 *
 * At **byte-identical header parity** with the export this replaces, so the
 * file is a drop-in for anything already reading that one. That parity is why
 * several columns are constants: this platform has no visitor id and no
 * per-lead ownership, so `Visitor ID` is always empty and `Lead Ownership` is
 * always `ai`. An empty column where this service has no concept is honest;
 * omitting it would make the file structurally different from the one it
 * replaces and break anything reading by position.
 *
 * The three tool-execution columns are deliberately NOT here. They exist on
 * the call-detail sheet and on that sheet only — carrying them here would make
 * this file three columns wider than the one it replaces, which is the same
 * kind of break as omitting one.
 *
 * Streamed rather than assembled, following `analyticsExport`: this file is
 * wider than that one — every mapped variable and every extracted key is a
 * column — so holding a campaign's leads in heap on the way to a chunked
 * response is the one thing that would make a large campaign unexportable.
 */

/** Leads read per page. The row is wide, so this is smaller than the analytics
 *  export's: the ceiling that matters here is cells in flight, not rows. */
export const LEADS_PAGE_SIZE = 200;

/** Columns before the extraction, the variables and the entities. */
const HEAD_COLUMNS = [
  'Lead Link',
  'Lead ID',
  'Visitor ID',
  'External ID',
  'Lead Created Date',
  'Lead Name',
  'Lead State',
  'Lead Ownership',
  'Phone Number',
  'Lead Interest',
  'Lead Interest Reason',
  'Campaign ID',
  'Campaign Name',
  'Campaign Status',
  'Campaign Start Date',
  'Total AI Call Attempts',
  'AI Connected Calls',
  'AI Connected Seconds',
  'First Call Timestamp',
  'Last Call Timestamp',
  'Last Call Status',
  'Last Call Disconnected By',
  'Caller ID Used',
  'DND Identifier (Yes/No)',
] as const;

/**
 * One lead as the page reads it.
 *
 * Written out rather than inferred: the keyset cursor is derived from this
 * result and fed back into the query that produces it, which TypeScript reads
 * as a circular initializer and widens to `any`.
 */
interface ExportLead {
  id: string;
  status: string;
  createdAt: Date;
  contact: {
    phone: string;
    name: string | null;
    email: string | null;
    tags: string[];
    metadata: Prisma.JsonValue;
  };
}

/** The campaign, and everything about it the header depends on. */
export interface ExportCampaign {
  id: string;
  name: string;
  status: string;
  startedAt: Date | null;
  leadBucketKey: string | null;
  variableMap: Prisma.JsonValue | null;
  agent: { variables: Prisma.JsonValue } | null;
}

/**
 * The variable columns: the AGENT VARIABLE names a dial actually sends.
 *
 * `Campaign.variableMap` is `{ csvColumn: agentVariable }`, so the header is
 * its **values** — the names the prompt interpolates — and not the spreadsheet
 * headers they were mapped from. Getting this backwards would label every
 * column with the customer's own CSV heading while the reference file labels
 * them with the variable names, and the two are routinely different words.
 *
 * With no map saved, the campaign is on the declared projection and the
 * agent's own `variables` are the allow-list — the same fallback `variablesFor`
 * makes in the dialer, so the header names what the dial sends in both modes.
 *
 * Derived from campaign configuration rather than from the rows, so the header
 * is stable across two exports of one campaign and costs no scan.
 */
export function variableColumns(campaign: ExportCampaign): string[] {
  const map = campaign.variableMap;

  if (map !== null && typeof map === 'object' && !Array.isArray(map)) {
    const names = Object.values(map as Record<string, unknown>).filter(
      (value): value is string => typeof value === 'string' && value !== '',
    );

    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
  }

  const declared = campaign.agent?.variables;
  const names = Array.isArray(declared)
    ? declared.filter((value): value is string => typeof value === 'string' && value !== '')
    : [];

  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/**
 * Every extraction key this campaign's calls actually carried.
 *
 * Read from the data rather than from the agent's declared config, which is a
 * display cache this service explicitly does not treat as a source of truth —
 * a stale snapshot would produce a header that does not describe the file
 * beneath it. Rides `call_attempts_campaign_extraction_idx`, the partial index
 * the lead buckets already read through.
 */
export async function extractionKeys(campaignId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ key: string }[]>`
    SELECT DISTINCT jsonb_object_keys(a."extraction") AS key
    FROM "CallAttempt" a
    WHERE a."campaignId" = ${campaignId}
      AND a."extraction" IS NOT NULL
  `;

  return rows.map((row) => row.key);
}

/** One lead's aggregates over its own dials, and the extraction that speaks
 *  for it. */
interface LeadFacts {
  attempts: number;
  connected: number;
  connectedSecs: number;
  firstCallAt: Date | null;
  lastCallAt: Date | null;
  lastDisposition: string | null;
  lastHangupSource: string | null;
  lastEndCallReason: string | null;
  lastLaunchError: string | null;
  fromNumber: string | null;
  extraction: Record<string, unknown> | null;
  /**
   * The variables the LAST dial actually went out with, when that dial
   * recorded them.
   *
   * The last rather than the extracting one, deliberately: these are lead
   * attributes and the question they answer is what the agent was most
   * recently told about this person. Null on every attempt settled before the
   * column existed, and on one the backfill has not reached.
   */
  sentVariables: Record<string, unknown> | null;
}

const EMPTY_FACTS: LeadFacts = {
  attempts: 0,
  connected: 0,
  connectedSecs: 0,
  firstCallAt: null,
  lastCallAt: null,
  lastDisposition: null,
  lastHangupSource: null,
  lastEndCallReason: null,
  lastLaunchError: null,
  fromNumber: null,
  extraction: null,
  sentVariables: null,
};

/**
 * The per-lead facts, for one page of leads, in one statement.
 *
 * Three things are computed here and each is a different question, which is
 * why they are three subqueries rather than one aggregate:
 *
 * - **The totals**, over every attempt. `connected` counts the REACHED ones
 *   through `reachedAttemptSql`, the one predicate the strip, the analytics
 *   and the buckets all read, so this file agrees with the reached count on
 *   the campaign's own strip rather than measuring the same word a second way.
 *   It is the whole predicate, not the disposition list alone: the platform
 *   maps Q.850 cause 16 to `no_answer` on some real conversations, and the
 *   answer-detection half is what keeps those counted.
 * - **The last dial**, by `attemptNo` and never by `startedAt`: the ordinal is
 *   unique per contact and the timestamps are not, so ordering on the clock
 *   leaves the "last" row arbitrary between two dials that started in the same
 *   millisecond.
 * - **The extraction that speaks for the lead**, which is deliberately NOT the
 *   last dial's. It is the latest attempt that carried an extraction AND
 *   reached a person — the predicate `campaignBuckets.ts` already uses, reused
 *   here verbatim rather than restated. Both halves are load-bearing and both
 *   were production bugs: a later dial that extracted nothing must not erase
 *   what an earlier one learned, and a voicemail's extraction is not an answer
 *   because the post-call model fills in every key it is given whether or not
 *   anybody spoke. Departing from it would make a lead's export row contradict
 *   the bucket chip the dashboard shows for that same lead.
 */
async function leadFacts(campaignId: string, leadIds: string[]): Promise<Map<string, LeadFacts>> {
  if (leadIds.length === 0) return new Map();

  const rows = await prisma.$queryRaw<
    {
      lead_id: string;
      attempts: bigint;
      connected: bigint;
      connected_secs: bigint;
      first_call_at: Date | null;
      last_call_at: Date | null;
      last_disposition: string | null;
      last_hangup_source: string | null;
      last_end_call_reason: string | null;
      last_launch_error: string | null;
      from_number: string | null;
      sent_variables: Prisma.JsonValue | null;
      extraction: Prisma.JsonValue | null;
    }[]
  >`
    WITH totals AS (
      SELECT
        a."campaignContactId" AS lead_id,
        COUNT(*)                                        AS attempts,
        COUNT(*) FILTER (WHERE ${reachedAttemptSql('a')}) AS connected,
        COALESCE(SUM(a."durationSecs") FILTER (WHERE ${reachedAttemptSql('a')}), 0) AS connected_secs,
        MIN(a."startedAt")                              AS first_call_at,
        MAX(a."startedAt")                              AS last_call_at
      FROM "CallAttempt" a
      WHERE a."campaignId" = ${campaignId}
        AND a."campaignContactId" IN (${Prisma.join(leadIds)})
      GROUP BY a."campaignContactId"
    ),
    /* The last dial, by ORDINAL. attemptNo is unique per contact; two dials
       can share a millisecond, so ordering on the clock leaves "last"
       arbitrary between them. (No backticks in here: this comment lives inside
       a tagged template literal, and one would end the SQL.) */
    last_call AS (
      SELECT DISTINCT ON (a."campaignContactId")
        a."campaignContactId" AS lead_id,
        a."disposition"       AS last_disposition,
        a."hangupSource"      AS last_hangup_source,
        a."endCallReason"     AS last_end_call_reason,
        a."launchError"       AS last_launch_error,
        a."fromNumber"        AS from_number,
        a."variables"         AS sent_variables
      FROM "CallAttempt" a
      WHERE a."campaignId" = ${campaignId}
        AND a."campaignContactId" IN (${Prisma.join(leadIds)})
      ORDER BY a."campaignContactId", a."attemptNo" DESC
    ),
    /* The extraction that speaks for the lead. NOT the last dial's: the same
       two-part predicate the lead buckets use, so this file and the chip on
       the dashboard cannot disagree about one lead. */
    spoken AS (
      SELECT DISTINCT ON (a."campaignId", a."campaignContactId")
        a."campaignContactId" AS lead_id,
        a."extraction"        AS extraction
      FROM "CallAttempt" a
      WHERE a."campaignId" = ${campaignId}
        AND a."campaignContactId" IN (${Prisma.join(leadIds)})
        AND a."extraction" IS NOT NULL
        AND ${reachedAttemptSql('a')}
      ORDER BY a."campaignId", a."campaignContactId", a."attemptNo" DESC
    )
    SELECT
      t.lead_id, t.attempts, t.connected, t.connected_secs,
      t.first_call_at, t.last_call_at,
      l.last_disposition, l.last_hangup_source, l.last_end_call_reason, l.last_launch_error, l.from_number,
      l.sent_variables,
      s.extraction
    FROM totals t
    LEFT JOIN last_call l ON l.lead_id = t.lead_id
    LEFT JOIN spoken    s ON s.lead_id = t.lead_id
  `;

  return new Map(
    rows.map((row) => [
      row.lead_id,
      {
        attempts: Number(row.attempts),
        connected: Number(row.connected),
        connectedSecs: Number(row.connected_secs),
        firstCallAt: row.first_call_at,
        lastCallAt: row.last_call_at,
        lastDisposition: row.last_disposition,
        lastHangupSource: row.last_hangup_source,
        lastEndCallReason: row.last_end_call_reason,
        lastLaunchError: row.last_launch_error,
        fromNumber: row.from_number,
        sentVariables:
          row.sent_variables !== null &&
          typeof row.sent_variables === 'object' &&
          !Array.isArray(row.sent_variables)
            ? (row.sent_variables as Record<string, unknown>)
            : null,
        extraction:
          row.extraction !== null && typeof row.extraction === 'object' && !Array.isArray(row.extraction)
            ? (row.extraction as Record<string, unknown>)
            : null,
      },
    ]),
  );
}

/** `YYYY-MM-DD HH:MM:SS`, the shape the reference file writes. Empty for an
 *  absent instant, never an epoch and never "now": both are claims. */
function stamp(at: Date | null | undefined): string {
  if (!at) return '';

  return at.toISOString().slice(0, 19).replace('T', ' ');
}

/** An extracted answer as a cell. A structured value is JSON rather than
 *  `[object Object]`, which is what `String()` would put in the column. */
function answer(extraction: Record<string, unknown> | null, key: string): string {
  const value = extraction?.[key];

  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  return JSON.stringify(value);
}

export interface LeadsExportOptions {
  /** Leads per page. A seam for exercising the keyset at a page boundary;
   *  nothing in production passes it. */
  pageSize?: number;
  /** Base URL for `Lead Link`. Absent emits the column empty rather than a
   *  relative path, which is not a link. */
  appUrl?: string | null;
}

/**
 * Writes the whole leads export, header first.
 *
 * The caller supplies the sink and owns the response, exactly as
 * `streamWorkspaceCsv` does, so this service owns rows and nothing else and
 * can be graded without an HTTP server.
 */
export async function streamLeadsCsv(
  campaignId: string,
  sink: ExportSink | ((chunk: string) => boolean | void),
  options: LeadsExportOptions = {},
): Promise<void> {
  const { write, drain, aborted } =
    typeof sink === 'function' ? { write: sink, drain: undefined, aborted: undefined } : sink;

  const pageSize = Math.max(1, options.pageSize ?? LEADS_PAGE_SIZE);

  const campaign = (await prisma.campaign.findUnique({
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

  if (!campaign) return;

  const columns: ExtractionColumns = splitExtractionKeys(await extractionKeys(campaignId));
  const variables = variableColumns(campaign);

  // Header order follows the reference file exactly: identity and aggregates,
  // then every metric with its reason beside it, then the variables, then the
  // entities.
  const header = [
    ...HEAD_COLUMNS,
    ...columns.metrics.flatMap((metric) => [`Lead Metric ${metric.key}`, `Lead Metric ${metric.key} Reason`]),
    ...variables,
    ...columns.entities.map((key) => `Lead Entity ${key}`),
  ];

  // The BOM, so a spreadsheet opens this as UTF-8 rather than guessing — which
  // is how a name in Devanagari arrives mangled.
  write('﻿');
  write(`${toCsvLine(header)}\r\n`);

  const campaignStart = stamp(campaign.startedAt);

  let cursor: { createdAt: Date; id: string } | null = null;

  for (;;) {
    // Whether any write on THIS page filled the consumer's buffer. `'drain'`
    // is only ever emitted after a write has returned `false`, so awaiting it
    // after a page of small writes waits for an event that never comes — the
    // response streams every row and then never ends. Reset per page for the
    // same reason: a page that filled the buffer says nothing about the next.
    let full = false;

    // Keyset by hand on `(createdAt, id)`, never Prisma's `cursor`: that
    // resolves through an unfiltered subquery, so an id the caller cannot see
    // still steers the query, and its unconditional `skip: 1` then drops a row
    // the caller never saw. The tiebreaker is not optional — a bulk import
    // stamps one `createdAt` across every row it writes.
    const leads: ExportLead[] = await prisma.campaignContact.findMany({
      where: {
        campaignId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { gt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { gt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: pageSize,
      select: {
        id: true,
        status: true,
        createdAt: true,
        contact: { select: { phone: true, name: true, email: true, tags: true, metadata: true } },
      },
    });

    if (leads.length === 0) return;

    const facts = await leadFacts(
      campaignId,
      leads.map((lead) => lead.id),
    );

    // The opt-out list is per campaign and keyed by phone, so one query answers
    // the whole page rather than one lookup per lead.
    const listed = new Set(
      (
        await prisma.doNotCall.findMany({
          where: { campaignId, phone: { in: leads.map((lead) => lead.contact.phone) } },
          select: { phone: true },
        })
      ).map((row) => row.phone),
    );

    for (const lead of leads) {
      const fact = facts.get(lead.id) ?? EMPTY_FACTS;
      const disconnect = disconnectColumns({
        endCallReason: fact.lastEndCallReason,
        hangupSource: fact.lastHangupSource,
        disposition: fact.lastDisposition,
        launchError: fact.lastLaunchError,
      });

      // The lead's own metadata, read for `External ID` below. The variable
      // columns do not read it here: they come from `variablesFor`, the
      // dialer's own projection.
      const metadata =
        lead.contact.metadata !== null && typeof lead.contact.metadata === 'object' && !Array.isArray(lead.contact.metadata)
          ? (lead.contact.metadata as Record<string, unknown>)
          : {};

      const bucketKey = campaign.leadBucketKey;
      const sent = variablesFor(campaign, campaign.agent?.variables, lead.contact);

      const row: (string | number | null)[] = [
        options.appUrl ? `${options.appUrl}/campaigns/${campaign.id}?contact=${lead.id}` : '',
        lead.id,
        // No visitor concept on this platform. Empty, never invented.
        '',
        // The customer's own identifier for this lead, when their upload
        // carried one. Their column name, so it is looked for under the
        // spellings a spreadsheet actually uses.
        String(metadata.external_id ?? metadata.externalId ?? metadata['External ID'] ?? ''),
        stamp(lead.createdAt),
        lead.contact.name ?? '',
        lead.status.toLowerCase(),
        // Every call on this platform is placed by an agent.
        'ai',
        lead.contact.phone,
        bucketKey ? answer(fact.extraction, bucketKey) : '',
        bucketKey ? answer(fact.extraction, `${bucketKey}_reason`) : '',
        campaign.id,
        campaign.name,
        campaign.status.toLowerCase(),
        campaignStart,
        fact.attempts,
        fact.connected,
        // Two decimals, as the reference file writes them.
        fact.connectedSecs.toFixed(2),
        stamp(fact.firstCallAt),
        stamp(fact.lastCallAt),
        fact.lastDisposition ?? '',
        disconnect.disconnectedBy,
        fact.fromNumber ?? '',
        listed.has(lead.contact.phone) ? 'Yes' : '',
        ...columns.metrics.flatMap((metric) => [
          answer(fact.extraction, metric.key),
          answer(fact.extraction, metric.reasonKey),
        ]),
        /**
         * What the dial ACTUALLY sent, falling back to what it WOULD send.
         *
         * The stored value is preferred because it is the only one of the two
         * that describes a call that already happened. `variablesFor` resolves
         * the campaign's CURRENT `variableMap` against the contact as it
         * stands now, so a map edited — or a contact re-imported — since the
         * calls were placed makes it quietly wrong about what the agent was
         * told, with nothing in the file saying so.
         *
         * The fallback is the dialer's own projection, called rather than
         * restated, so a column shows exactly what a dial sends — including
         * which of two CSV columns mapped to one variable wins. It covers
         * every attempt settled before the column existed and every one the
         * backfill has not reached; a blank column would claim the dial
         * carried nothing, which is a stronger and worse claim.
         */
        ...variables.map((name) => {
          const stored = fact.sentVariables?.[name];

          if (stored !== undefined && stored !== null) {
            return typeof stored === 'string' ? stored : String(stored);
          }

          return sent[name] ?? '';
        }),
        ...columns.entities.map((key) => answer(fact.extraction, key)),
      ];

      if (write(`${toCsvLine(row)}\r\n`) === false) full = true;
    }

    const last = leads[leads.length - 1]!;
    cursor = { createdAt: last.createdAt, id: last.id };

    if (aborted?.()) return;
    if (full && drain) await drain();
    if (aborted?.()) return;

    if (leads.length < pageSize) return;
  }
}
