import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { CALLS_EXPORT_COLUMNS, streamCallsCsv } from '../src/services/campaignCallsExport.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';

/** The call-detail export: one row per `CallAttempt`, newest dial last. */

let seq = 0;

async function seed() {
  const account = await makeAccount(`calls-export-${(seq += 1)}`);
  const workspace = await makeWorkspace(account, 'Calls');
  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: workspace.id,
      name: 'Autopay Touchbase September 2026',
      status: 'RUNNING',
      createdAt: new Date('2026-09-02T17:29:57.000Z'),
    },
  });
  const contact = await prisma.contact.create({
    data: { workspaceId: workspace.id, phone: '+918482909288', name: 'Asha' },
  });
  const lead = await prisma.campaignContact.create({
    data: { campaignId: campaign.id, contactId: contact.id, status: 'COMPLETED' },
  });

  return { account, workspace, campaign, contact, lead };
}

async function addAttempt(
  ctx: Awaited<ReturnType<typeof seed>>,
  fields: Record<string, unknown>,
) {
  seq += 1;

  return prisma.callAttempt.create({
    data: {
      campaignId: ctx.campaign.id,
      campaignContactId: ctx.lead.id,
      workspaceId: ctx.workspace.id,
      accountId: ctx.account.id,
      upstreamCallId: `c_${seq}`,
      status: 'COMPLETED',
      ...fields,
    } as never,
  });
}

function cells(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cell); cell = ''; }
    else cell += ch;
  }
  out.push(cell);

  return out;
}

async function render(campaignId: string): Promise<string[]> {
  let out = '';
  await streamCallsCsv(campaignId, (chunk) => {
    out += chunk;
    return true;
  });

  return out.replace(/^﻿/, '').trimEnd().split('\r\n');
}

beforeEach(async () => {
  await truncateAll();
});

describe('the call-detail export', () => {
  it('emits the reference file’s columns, in its order', async () => {
    const ctx = await seed();

    expect(cells((await render(ctx.campaign.id))[0]!)).toEqual([...CALLS_EXPORT_COLUMNS]);
  });

  it('writes one row per dial, oldest first', async () => {
    const ctx = await seed();
    await addAttempt(ctx, { attemptNo: 2, startedAt: new Date('2026-09-03T19:16:11.000Z') });
    await addAttempt(ctx, { attemptNo: 1, startedAt: new Date('2026-09-01T09:12:00.000Z') });

    const rows = await render(ctx.campaign.id);
    const header = cells(rows[0]!);
    const no = header.indexOf('Attempt Number');

    expect(rows).toHaveLength(3);
    expect([cells(rows[1]!)[no], cells(rows[2]!)[no]]).toEqual(['1', '2']);
  });

  /**
   * Pulse billing maps straight across: the reference file's `1s` unit with a
   * count equal to the duration is per-second billing, which is exactly what
   * `billingIncrementSecs = 1` and `billedSecs` record.
   */
  it('reports the billing increment as the pulse unit and the billed seconds as the count', async () => {
    const ctx = await seed();
    await addAttempt(ctx, {
      attemptNo: 1,
      durationSecs: 314,
      billedSecs: 314,
      billingIncrementSecs: 1,
    });

    const rows = await render(ctx.campaign.id);
    const header = cells(rows[0]!);
    const row = cells(rows[1]!);

    expect(row[header.indexOf('Call Pulse Unit')]).toBe('1s');
    expect(row[header.indexOf('Call Pulse Count')]).toBe('314');
    expect(row[header.indexOf('Call Duration (Seconds)')]).toBe('314');
  });

  /**
   * Null is not zero and not "the same as the duration". Every attempt settled
   * before pulse billing existed carries null, and the schema is explicit that
   * rendering it as either teaches a reader to trust a figure that was never
   * recorded.
   */
  it('leaves the pulse columns empty on an attempt settled before pulse billing', async () => {
    const ctx = await seed();
    await addAttempt(ctx, { attemptNo: 1, durationSecs: 47, billedSecs: null, billingIncrementSecs: null });

    const rows = await render(ctx.campaign.id);
    const header = cells(rows[0]!);
    const row = cells(rows[1]!);

    expect(row[header.indexOf('Call Pulse Unit')]).toBe('');
    expect(row[header.indexOf('Call Pulse Count')]).toBe('');
    expect(row[header.indexOf('Call Duration (Seconds)')]).toBe('47');
  });

  it('derives both disconnect columns from the hangup source', async () => {
    const ctx = await seed();
    await addAttempt(ctx, { attemptNo: 1, disposition: 'completed', hangupSource: 'callee' });

    const rows = await render(ctx.campaign.id);
    const header = cells(rows[0]!);
    const row = cells(rows[1]!);

    expect(row[header.indexOf('Disconnect Reason Key')]).toBe('user');
    expect(row[header.indexOf('Call Disconnected By')]).toBe('Customer');
  });

  /** The bot's own account of the ending is read before the inferred per-leg
   *  source, which voicelink rarely carries. */
  it('derives both disconnect columns from end_call_reason when there is no source', async () => {
    const ctx = await seed();
    await addAttempt(ctx, { attemptNo: 1, disposition: 'completed', hangupSource: null, endCallReason: 'CUSTOMER_HUNG_UP' });

    const rows = await render(ctx.campaign.id);
    const header = cells(rows[0]!);
    const row = cells(rows[1]!);

    expect(row[header.indexOf('Disconnect Reason Key')]).toBe('user');
    expect(row[header.indexOf('Call Disconnected By')]).toBe('Customer');
  });

  /**
   * The one column shipped deliberately empty. In the reference file the single
   * `user` reason key splits across two of its values, so it is a function of
   * the hangup CAUSE as well as the source — a mapping no production
   * distribution has been measured against yet. A guess in a column an
   * operator reconciles against the carrier is worse than a blank.
   */
  it('ships the telephony disposition empty rather than guessing at it', async () => {
    const ctx = await seed();
    await addAttempt(ctx, { attemptNo: 1, disposition: 'completed', hangupSource: 'callee', hangupCause: 'NORMAL_CLEARING' });

    const rows = await render(ctx.campaign.id);
    const header = cells(rows[0]!);

    expect(cells(rows[1]!)[header.indexOf('Telephony Disposition')]).toBe('');
  });

  /** Every campaign call this service places is outbound; an inbound call has
   *  no attempt row and never reaches this file. */
  it('reports every row as outbound', async () => {
    const ctx = await seed();
    await addAttempt(ctx, { attemptNo: 1 });

    const rows = await render(ctx.campaign.id);
    const header = cells(rows[0]!);

    expect(cells(rows[1]!)[header.indexOf('Call Direction')]).toBe('Outbound');
  });
});
