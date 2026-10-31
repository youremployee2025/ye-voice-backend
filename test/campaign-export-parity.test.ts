import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { prisma } from '../src/lib/prisma.js';
import { CALLS_EXPORT_COLUMNS, streamCallsCsv } from '../src/services/campaignCallsExport.js';
import { streamLeadsCsv } from '../src/services/campaignLeadsExport.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';

/**
 * Header parity with the export this replaces, asserted against that export's
 * own column names.
 *
 * The fixture holds column NAMES only — no rows, no phone numbers, no business
 * names. What is checked is the campaign-INDEPENDENT part: the leads file's
 * fixed head, and the whole of the call-detail header. The `Lead Metric`,
 * variable and `Lead Entity` columns are derived per campaign and belong to one
 * customer's configuration, so they are graded by the derivation tests instead.
 *
 * This is the contract. Anything reading those files by position keeps working
 * only while this passes, which is why the names live in a fixture rather than
 * being retyped into an assertion where a drift would be invisible.
 */
const REFERENCE = JSON.parse(
  readFileSync(new URL('./fixtures/convin-export-headers.json', import.meta.url), 'utf8'),
) as { leadsHead: string[]; calls: string[] };

let seq = 0;

async function emptyCampaign() {
  const account = await makeAccount(`parity-${(seq += 1)}`);
  const workspace = await makeWorkspace(account, 'Parity');

  return prisma.campaign.create({
    data: { workspaceId: workspace.id, name: 'Parity', status: 'RUNNING' },
  });
}

async function header(stream: (id: string, sink: (chunk: string) => boolean) => Promise<void>, id: string) {
  let out = '';
  await stream(id, (chunk) => {
    out += chunk;

    return true;
  });

  return out.replace(/^﻿/, '').split('\r\n')[0]!.split(',').map((cell) => cell.replace(/^"|"$/g, ''));
}

beforeEach(async () => {
  await truncateAll();
});

describe('header parity with the export being replaced', () => {
  it('opens the leads file with that file’s own fixed columns, in its order', async () => {
    const campaign = await emptyCampaign();

    const columns = await header((id, sink) => streamLeadsCsv(id, sink), campaign.id);

    expect(columns.slice(0, REFERENCE.leadsHead.length)).toEqual(REFERENCE.leadsHead);
  });

  /**
   * A campaign with no calls and no variables derives no further columns, so
   * the fixed head is the whole header. This is what pins the ABSENCE of the
   * tool columns on this file: they exist on the call detail and not here, and
   * adding them would make a file one column wider than the one it replaces.
   */
  it('adds nothing of its own to the leads header', async () => {
    const campaign = await emptyCampaign();

    expect(await header((id, sink) => streamLeadsCsv(id, sink), campaign.id)).toEqual(
      REFERENCE.leadsHead,
    );
  });

  it('matches the call-detail header exactly', async () => {
    const campaign = await emptyCampaign();

    expect(await header((id, sink) => streamCallsCsv(id, sink), campaign.id)).toEqual(REFERENCE.calls);
  });

  /** The constant this service exports and the reference file must not drift
   *  apart silently — the columns are read by position downstream. */
  it('keeps the calls column constant equal to the reference', () => {
    expect([...CALLS_EXPORT_COLUMNS]).toEqual(REFERENCE.calls);
  });
});
