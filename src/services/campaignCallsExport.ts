import { prisma } from '../lib/prisma.js';
import { disconnectColumns } from '../lib/campaignExportColumns.js';
import { toCsvLine, type ExportSink } from './analyticsExport.js';

/**
 * A campaign's calls as CSV, streamed — one row per `CallAttempt`.
 *
 * The companion to the leads export and the finer-grained of the two: where
 * that one answers "where does each person stand", this answers "what happened
 * on each dial", which is what a reader reconciling against the carrier
 * call-for-call needs. Same header-parity rule, same streaming, same sink
 * contract.
 *
 * It has no extraction columns at all, deliberately. An extraction is a verdict
 * about a CONVERSATION and the leads file already carries the one that speaks
 * for each lead, under the rule that decides which conversation that is;
 * repeating a per-dial copy here would publish the voicemail-written answers
 * that rule exists to suppress.
 */

/** Dials read per page. */
export const CALLS_PAGE_SIZE = 500;

/**
 * The header, and the order every row follows — the reference file's columns,
 * in its order.
 *
 * `DND Identifier` and the three tool columns are carried and never filled,
 * for the reason the leads file carries them: no tool-execution field exists
 * anywhere in this service, they are blank in every row of the reference file
 * too, and a file that is structurally different breaks anything reading by
 * position.
 *
 * `Telephony Disposition` is also always empty, and that one is a real gap
 * rather than an absent concept. See `disconnectColumns`: the reference file's
 * single `user` reason key splits across two of its values, so the column is a
 * function of the hangup CAUSE as well as the source, and no production
 * distribution has been measured against it yet.
 */
export const CALLS_EXPORT_COLUMNS = [
  'To Phone Num',
  'Call Attempt ID',
  'Call Direction',
  'From Phone Num',
  'Campaign Name',
  'Campaign ID',
  'Campaign Created Date',
  'External ID',
  'Lead ID',
  'Lead Name',
  'Lead Link',
  'Lead Creation Timestamp',
  'Call Status',
  'Telephony Disposition',
  'Call Timestamp',
  'Call Answered Timestamp',
  'Call End Timestamp',
  'Call Duration (Seconds)',
  'Call Pulse Unit',
  'Call Pulse Count',
  'Attempt Number',
  'Disconnect Reason Key',
  'Call Disconnected By',
  'DND Identifier',
  'Tool Executions',
  'Tool Execution Success',
  'Tool Execution Failures',
] as const;

/** `YYYY-MM-DD HH:MM:SS`. Empty for an absent instant — never an epoch, which
 *  would put a 1970 timestamp on every call still in flight. */
function stamp(at: Date | null | undefined): string {
  if (!at) return '';

  return at.toISOString().slice(0, 19).replace('T', ' ');
}

export interface CallsExportOptions {
  pageSize?: number;
  appUrl?: string | null;
}

interface ExportAttempt {
  id: string;
  attemptNo: number;
  fromNumber: string | null;
  status: string;
  disposition: string | null;
  hangupSource: string | null;
  endCallReason: string | null;
  launchError: string | null;
  startedAt: Date;
  answeredAt: Date | null;
  endedAt: Date | null;
  durationSecs: number | null;
  billedSecs: number | null;
  billingIncrementSecs: number | null;
  campaignContact: {
    id: string;
    createdAt: Date;
    contact: { phone: string; name: string | null; metadata: unknown };
  } | null;
}

/**
 * Writes the whole call-detail export, header first.
 *
 * Ordered `(startedAt, id)` ASCENDING — a dial log reads forwards, unlike the
 * analytics export's newest-first listing. The tiebreaker on `id` is not
 * optional: a batch claimed in one pass shares a `startedAt` to the
 * millisecond, and an unstable sort under keyset paging shows one row on two
 * pages while omitting another.
 */
export async function streamCallsCsv(
  campaignId: string,
  sink: ExportSink | ((chunk: string) => boolean | void),
  options: CallsExportOptions = {},
): Promise<void> {
  const { write, drain, aborted } =
    typeof sink === 'function' ? { write: sink, drain: undefined, aborted: undefined } : sink;

  const pageSize = Math.max(1, options.pageSize ?? CALLS_PAGE_SIZE);

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, name: true, createdAt: true },
  });

  if (!campaign) return;

  write('﻿');
  write(`${toCsvLine([...CALLS_EXPORT_COLUMNS])}\r\n`);

  const campaignCreated = stamp(campaign.createdAt);

  let cursor: { startedAt: Date; id: string } | null = null;

  for (;;) {
    // Whether any write on THIS page filled the consumer's buffer. `'drain'`
    // is only ever emitted after a write has returned `false`, so awaiting it
    // after a page of small writes waits for an event that never comes. Reset
    // per page, since a page that filled the buffer says nothing about the next.
    let full = false;

    // Keyset by hand, never Prisma's `cursor`: that resolves through an
    // unfiltered subquery, so an id the caller cannot see still steers the
    // query, and its unconditional `skip: 1` drops a row the caller never saw.
    const attempts: ExportAttempt[] = await prisma.callAttempt.findMany({
      where: {
        campaignId,
        ...(cursor
          ? {
              OR: [
                { startedAt: { gt: cursor.startedAt } },
                { startedAt: cursor.startedAt, id: { gt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      take: pageSize,
      select: {
        id: true,
        attemptNo: true,
        fromNumber: true,
        status: true,
        disposition: true,
        hangupSource: true,
        endCallReason: true,
        launchError: true,
        startedAt: true,
        answeredAt: true,
        endedAt: true,
        durationSecs: true,
        billedSecs: true,
        billingIncrementSecs: true,
        campaignContact: {
          select: {
            id: true,
            createdAt: true,
            contact: { select: { phone: true, name: true, metadata: true } },
          },
        },
      },
    });

    if (attempts.length === 0) return;

    // The opt-out list, one query for the page rather than a lookup per row.
    const phones = attempts
      .map((attempt) => attempt.campaignContact?.contact.phone)
      .filter((phone): phone is string => typeof phone === 'string');

    const listed = new Set(
      (
        await prisma.doNotCall.findMany({
          where: { campaignId, phone: { in: phones } },
          select: { phone: true },
        })
      ).map((row) => row.phone),
    );

    for (const attempt of attempts) {
      const lead = attempt.campaignContact;
      const metadata =
        lead?.contact.metadata !== null &&
        typeof lead?.contact.metadata === 'object' &&
        !Array.isArray(lead?.contact.metadata)
          ? (lead.contact.metadata as Record<string, unknown>)
          : {};

      const disconnect = disconnectColumns({
        endCallReason: attempt.endCallReason,
        hangupSource: attempt.hangupSource,
        disposition: attempt.disposition,
        launchError: attempt.launchError,
      });

      const wrote = write(
        `${toCsvLine([
          lead?.contact.phone ?? '',
          attempt.id,
          // Every campaign call this service places is outbound. An inbound
          // call has no attempt row and never reaches this file.
          'Outbound',
          attempt.fromNumber ?? '',
          campaign.name,
          campaign.id,
          campaignCreated,
          String(metadata.external_id ?? metadata.externalId ?? metadata['External ID'] ?? ''),
          lead?.id ?? '',
          lead?.contact.name ?? '',
          options.appUrl && lead ? `${options.appUrl}/campaigns/${campaign.id}?contact=${lead.id}` : '',
          stamp(lead?.createdAt),
          // The carrier's own word where it gave one, and our enum only where
          // it did not — the disposition is the later and better-informed
          // verdict, which is why every classifier here reads it first.
          attempt.disposition ?? attempt.status.toLowerCase(),
          // Deliberately empty. See CALLS_EXPORT_COLUMNS.
          '',
          stamp(attempt.startedAt),
          stamp(attempt.answeredAt),
          stamp(attempt.endedAt),
          attempt.durationSecs ?? '',
          // Null and zero are different facts here. Every attempt settled
          // before pulse billing existed carries null, and rendering it as
          // zero — or as the duration, which happens to be right for those
          // rows — teaches a reader to trust a figure nobody recorded.
          attempt.billingIncrementSecs === null ? '' : `${attempt.billingIncrementSecs}s`,
          attempt.billedSecs ?? '',
          attempt.attemptNo,
          disconnect.reasonKey,
          disconnect.disconnectedBy,
          lead && listed.has(lead.contact.phone) ? 'Yes' : '',
          '',
          '',
          '',
        ])}\r\n`,
      );
      if (wrote === false) full = true;
    }

    const last = attempts[attempts.length - 1]!;
    cursor = { startedAt: last.startedAt, id: last.id };

    if (aborted?.()) return;
    if (full && drain) await drain();
    if (aborted?.()) return;

    if (attempts.length < pageSize) return;
  }
}
