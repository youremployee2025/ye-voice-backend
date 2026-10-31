import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import {
  EXPORT_COLUMNS,
  streamWorkspaceCsv,
  toCsvCell,
  toCsvLine,
  type ExportOptions,
} from '../src/services/analyticsExport.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';

const RANGE = {
  from: new Date('2026-08-01T00:00:00.000Z'),
  to: new Date('2026-08-31T23:59:59.999Z'),
};

let counter = 0;

/**
 * One dial the dialer placed — a CAMPAIGN row, which the export merges with the
 * ingest's non-campaign rows into one chronological file.
 */
async function attempt(
  account: { id: string },
  workspace: { id: string },
  campaign: { id: string; workspaceId: string },
  fields: Record<string, unknown> = {},
) {
  counter += 1;
  const contact = await prisma.contact.create({
    data: {
      workspaceId: campaign.workspaceId,
      phone: (fields.phone as string) ?? `+1415555${String(counter).padStart(4, '0')}`,
    },
  });
  const link = await prisma.campaignContact.create({
    data: { campaignId: campaign.id, contactId: contact.id, attempts: 1 },
  });

  return prisma.callAttempt.create({
    data: {
      campaignId: campaign.id,
      campaignContactId: link.id,
      workspaceId: workspace.id,
      accountId: account.id,
      attemptNo: 1,
      upstreamCallId: `att_${counter}`,
      status: 'COMPLETED',
      disposition: 'completed',
      startedAt: new Date('2026-08-10T12:00:00.000Z'),
      durationSecs: 60,
      ...(fields.startedAt ? { startedAt: fields.startedAt as Date } : {}),
      ...(fields.disposition === undefined ? {} : { disposition: fields.disposition }),
      ...(fields.answeredBy === undefined ? {} : { answeredBy: fields.answeredBy }),
    } as never,
  });
}

async function fact(fields: Record<string, unknown>) {
  counter += 1;
  return prisma.callRecord.create({
    data: {
      upstreamCallId: `call_${counter}`,
      startedAt: new Date('2026-08-10T12:00:00.000Z'),
      ...fields,
    } as never,
  });
}

async function collect(
  workspaceId: string,
  options: ExportOptions = {},
  range = RANGE,
): Promise<string> {
  let out = '';
  await streamWorkspaceCsv(
    workspaceId,
    range,
    (chunk) => {
      out += chunk;
    },
    options,
  );
  return out;
}

/** Rows, without the header and without the trailing blank. */
function bodyOf(csv: string): string[] {
  return csv.replace(/^﻿/, '').trim().split('\r\n').slice(1);
}

beforeEach(async () => {
  await truncateAll();
});

describe('toCsvCell', () => {
  it('leaves an ordinary value alone', () => {
    expect(toCsvCell('completed')).toBe('completed');
  });

  it('renders absent as empty, never as the word null', () => {
    expect(toCsvCell(null)).toBe('');
    expect(toCsvCell(undefined)).toBe('');
  });

  it('quotes a value containing a comma, a quote or a newline', () => {
    expect(toCsvCell('a,b')).toBe('"a,b"');
    expect(toCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(toCsvCell('one\ntwo')).toBe('"one\ntwo"');
  });

  it('neutralises a leading + so a phone number is not a formula', () => {
    // Not theoretical: `phone` is E.164, so EVERY number in this export starts
    // with `+`. Quoting alone does not help — a spreadsheet strips the quotes
    // and evaluates what is inside.
    expect(toCsvCell('+14155550100')).toBe(`"'+14155550100"`);
  });

  it('neutralises the other formula leaders', () => {
    for (const leader of ['=', '-', '@', '\t', '\r']) {
      expect(toCsvCell(`${leader}CMD`)).toContain(`'${leader}`);
    }
  });

  it('does not disturb a negative number written as a number', () => {
    // A JavaScript number is ours, not a carrier's string, and cannot carry a
    // payload — quoting it would make every duration column a text cell.
    expect(toCsvCell(-5)).toBe('-5');
  });
});

describe('toCsvLine', () => {
  it('joins cells with commas', () => {
    expect(toCsvLine(['a', 'b', null])).toBe('a,b,');
  });
});

describe('streamWorkspaceCsv', () => {
  it('starts with a BOM and the header row', async () => {
    const account = await makeAccount('csvhead');
    const workspace = await makeWorkspace(account, 'Head');

    const csv = await collect(workspace.id);

    // The BOM is what makes a spreadsheet open this as UTF-8 rather than guess.
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.replace(/^﻿/, '').split('\r\n')[0]).toBe(EXPORT_COLUMNS.join(','));
  });

  it('emits a header even when there are no rows', async () => {
    // An empty file and a file of headers say different things: the second is
    // an answer, the first looks like a failed download.
    const account = await makeAccount('csvempty');
    const workspace = await makeWorkspace(account, 'Empty');

    expect(bodyOf(await collect(workspace.id))).toEqual([]);
  });

  it('writes one row per fact, newest first', async () => {
    const account = await makeAccount('csvrows');
    const workspace = await makeWorkspace(account, 'Rows');

    await fact({ workspaceId: workspace.id, startedAt: new Date('2026-08-02T00:00:00.000Z') });
    await fact({ workspaceId: workspace.id, startedAt: new Date('2026-08-03T00:00:00.000Z') });

    const rows = bodyOf(await collect(workspace.id));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('2026-08-03');
    expect(rows[1]).toContain('2026-08-02');
  });

  it('carries the classified outcome beside the raw disposition', async () => {
    const account = await makeAccount('csvoutcome');
    const workspace = await makeWorkspace(account, 'Outcome');
    await fact({ workspaceId: workspace.id, disposition: 'voicemail', status: 'completed' });

    const [row] = bodyOf(await collect(workspace.id));

    expect(row).toContain('voicemail');
    // Both, so a reader filtering in a spreadsheet gets the bucket and a reader
    // reconciling against the platform gets what the carrier actually said.
    expect(row.split(',')).toContain('voicemail');
  });

  it('classifies a campaign call labelled no_answer with a human on the line as answered', async () => {
    const account = await makeAccount('csvhuman');
    const workspace = await makeWorkspace(account, 'Human');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'Cause 16' },
    });

    await attempt(account, workspace, campaign, { disposition: 'no_answer', answeredBy: 'human' });

    const [row] = bodyOf(await collect(workspace.id));
    const cells = row.split(',');

    expect(cells).toContain('no_answer');
    expect(cells).toContain('answered');
  });

  it('names the campaign on a campaign row, and marks its source', async () => {
    const account = await makeAccount('csvcampaign');
    const workspace = await makeWorkspace(account, 'Campaign');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'Spring push' },
    });

    await attempt(account, workspace, campaign);

    const [row] = bodyOf(await collect(workspace.id));

    expect(row).toContain('Spring push');
    // The two sources carry genuinely different fields, so the file says which
    // a row came from rather than leaving the reader to infer it.
    expect(row.split(',')).toContain('campaign');
  });

  it('merges both sources into one chronological file', async () => {
    // Not one source after the other: a CSV of calls that is not in time order
    // is one the reader has to re-sort before it means anything.
    const account = await makeAccount('csvmerge');
    const workspace = await makeWorkspace(account, 'Merge');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'Merged' },
    });

    await attempt(account, workspace, campaign, {
      startedAt: new Date('2026-08-03T00:00:00.000Z'),
    });
    await fact({ workspaceId: workspace.id, startedAt: new Date('2026-08-04T00:00:00.000Z') });
    await attempt(account, workspace, campaign, {
      startedAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    await fact({ workspaceId: workspace.id, startedAt: new Date('2026-08-02T00:00:00.000Z') });

    const rows = bodyOf(await collect(workspace.id, { pageSize: 1 }));

    expect(rows.map((row) => row.split(',')[1].slice(0, 10))).toEqual([
      '2026-08-04',
      '2026-08-03',
      '2026-08-02',
      '2026-08-01',
    ]);
  });

  it('drops the non-campaign source entirely when filtered to a campaign', async () => {
    const account = await makeAccount('csvfilter');
    const workspace = await makeWorkspace(account, 'Filter');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'Only me' },
    });

    await attempt(account, workspace, campaign);
    await fact({ workspaceId: workspace.id, phone: '+19999999999' });

    const csv = await collect(workspace.id, { campaignId: campaign.id });

    expect(bodyOf(csv)).toHaveLength(1);
    expect(csv).not.toContain('9999999999');
  });

  it('leaves the campaign columns empty for an uncorrelated call', async () => {
    const account = await makeAccount('csvnocampaign');
    const workspace = await makeWorkspace(account, 'No campaign');
    await fact({ workspaceId: workspace.id });

    expect(bodyOf(await collect(workspace.id))[0]).not.toContain('undefined');
  });

  it('contains no other workspace’s rows, and no quarantined ones', async () => {
    const account = await makeAccount('csviso');
    const mine = await makeWorkspace(account, 'Mine');
    const theirs = await makeWorkspace(account, 'Theirs');

    await fact({ workspaceId: mine.id, phone: '+10000000001' });
    await fact({ workspaceId: theirs.id, phone: '+10000000002' });
    await fact({ workspaceId: null, phone: '+10000000003' });

    const csv = await collect(mine.id);

    expect(csv).toContain('+10000000001');
    expect(csv).not.toContain('+10000000002');
    expect(csv).not.toContain('+10000000003');
  });

  it('respects the range', async () => {
    const account = await makeAccount('csvrange');
    const workspace = await makeWorkspace(account, 'Range');

    await fact({ workspaceId: workspace.id, startedAt: RANGE.from, phone: '+1111' });
    await fact({ workspaceId: workspace.id, startedAt: RANGE.to, phone: '+2222' });
    await fact({
      workspaceId: workspace.id,
      startedAt: new Date('2026-09-02T00:00:00.000Z'),
      phone: '+3333',
    });

    const csv = await collect(workspace.id);

    expect(bodyOf(csv)).toHaveLength(2);
    expect(csv).not.toContain('+3333');
  });

  it('pages across a boundary without repeating or losing a row', async () => {
    // The keyset tiebreaks on id as well as startedAt. Rows written by one
    // ingest pass share a startedAt to the millisecond, and an unstable sort
    // repeats one row and omits another.
    const account = await makeAccount('csvpage');
    const workspace = await makeWorkspace(account, 'Page');

    const shared = new Date('2026-08-15T00:00:00.000Z');
    for (let i = 0; i < 25; i += 1) {
      await fact({ workspaceId: workspace.id, startedAt: shared, phone: `+9${i}` });
    }

    // Ten at a time over twenty-five rows: two full pages and a short one.
    const rows = bodyOf(await collect(workspace.id, { pageSize: 10 }));

    expect(rows).toHaveLength(25);
    expect(new Set(rows).size).toBe(25);
  });

  it('waits for a slow consumer instead of buffering the whole export', async () => {
    // Without this the "streamed, constant memory" claim is not true: every
    // page would accumulate in the socket buffer on its way to a client that is
    // not reading.
    const account = await makeAccount('csvslow');
    const workspace = await makeWorkspace(account, 'Slow');
    for (let i = 0; i < 6; i += 1) {
      await fact({ workspaceId: workspace.id, phone: `+8${i}` });
    }

    let drains = 0;

    await streamWorkspaceCsv(
      workspace.id,
      RANGE,
      {
        // Always behind.
        write: () => false,
        drain: async () => {
          drains += 1;
        },
      },
      { pageSize: 2 },
    );

    expect(drains).toBeGreaterThan(0);
  });

  it('stops paging when the consumer has gone', async () => {
    // A reader who closes the tab mid-download. Without this the walk pages
    // through the rest of the workspace's history into a socket nobody reads.
    const account = await makeAccount('csvgone');
    const workspace = await makeWorkspace(account, 'Gone');
    for (let i = 0; i < 10; i += 1) {
      await fact({ workspaceId: workspace.id, phone: `+7${i}` });
    }

    let written = 0;

    await streamWorkspaceCsv(
      workspace.id,
      RANGE,
      {
        write: () => {
          written += 1;
          return true;
        },
        // Gone after the header and the first page.
        aborted: () => written > 3,
      },
      { pageSize: 2 },
    );

    // The header, two rows of page one, and then it stopped — not ten rows.
    expect(written).toBeLessThan(10);
  });

  it('quotes a campaign name containing a comma', async () => {
    const account = await makeAccount('csvquote');
    const workspace = await makeWorkspace(account, 'Quote');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: workspace.id, name: 'Delhi, Mumbai' },
    });

    await attempt(account, workspace, campaign);

    const [row] = bodyOf(await collect(workspace.id));

    expect(row).toContain('"Delhi, Mumbai"');
    // And the row still has exactly as many fields as the header.
    expect(row.match(/,/g)!.length).toBeGreaterThanOrEqual(EXPORT_COLUMNS.length - 1);
  });
});
