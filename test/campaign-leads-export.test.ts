import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { streamLeadsCsv } from '../src/services/campaignLeadsExport.js';
import { variablesFor } from '../src/lib/callVariables.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';

/**
 * The leads export: one row per campaign contact, at header parity with the
 * export it replaces.
 *
 * What is graded here is the row ASSEMBLY — which extraction speaks for a
 * contact, which keys become columns, what the aggregates count. CSV escaping
 * is not re-graded: this reuses `analyticsExport`'s `toCsvLine`, whose
 * formula-injection guard has its own suite.
 */

let seq = 0;

async function seed(options: { variableMap?: Record<string, string> | null; leadBucketKey?: string } = {}) {
  const account = await makeAccount(`lead-export-${(seq += 1)}`);
  const workspace = await makeWorkspace(account, 'Leads');
  const agent = await prisma.agent.create({
    data: {
      externalId: `ext_leads_${seq}`,
      workspaceId: workspace.id,
      name: 'Touchbase',
      status: 'active',
      variables: ['tb_plan'],
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: workspace.id,
      name: 'Autopay Touchbase September 2026',
      status: 'RUNNING',
      agentId: agent.id,
      variableMap: options.variableMap === undefined ? undefined : options.variableMap ?? undefined,
      leadBucketKey: options.leadBucketKey ?? null,
      startedAt: new Date('2026-09-02T05:30:00.000Z'),
    },
  });

  return { account, workspace, agent, campaign };
}

async function addLead(
  campaign: { id: string; workspaceId: string },
  fields: { phone?: string; name?: string; metadata?: Record<string, unknown> } = {},
) {
  seq += 1;
  const contact = await prisma.contact.create({
    data: {
      workspaceId: campaign.workspaceId,
      phone: fields.phone ?? `+9199000${String(seq).padStart(5, '0')}`,
      name: fields.name ?? null,
      metadata: (fields.metadata ?? {}) as never,
    },
  });

  return prisma.campaignContact.create({
    data: { campaignId: campaign.id, contactId: contact.id, status: 'COMPLETED' },
  });
}

async function addAttempt(
  campaign: { id: string; workspaceId: string },
  account: { id: string },
  lead: { id: string },
  fields: Record<string, unknown>,
) {
  seq += 1;
  return prisma.callAttempt.create({
    data: {
      campaignId: campaign.id,
      campaignContactId: lead.id,
      workspaceId: campaign.workspaceId,
      accountId: account.id,
      attemptNo: (fields.attemptNo as number) ?? seq,
      upstreamCallId: `c_${seq}`,
      status: 'COMPLETED',
      ...fields,
    } as never,
  });
}

/** The whole file, as lines, header included. */
async function render(campaignId: string): Promise<string[]> {
  let out = '';
  await streamLeadsCsv(campaignId, (chunk) => {
    out += chunk;
    return true;
  });

  return out.replace(/^﻿/, '').trimEnd().split('\r\n');
}

/**
 * One CSV line, unquoted.
 *
 * A real parse rather than `split(',')`, because this file is quoted for good
 * reasons and the assertions must see through them: an extraction reason is a
 * sentence a model wrote and routinely holds a comma, and every phone number
 * is formula-guarded — see the deviation case below.
 */
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

beforeEach(async () => {
  await truncateAll();
});

describe('the leads export header', () => {
  it('opens with the identity and interest columns the reference file opens with', async () => {
    const { campaign } = await seed();

    const header = cells((await render(campaign.id))[0]!);

    expect(header.slice(0, 11)).toEqual([
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
    ]);
  });

  /** The tool columns belong to the call-detail sheet and to that sheet only.
   *  Carrying them here would make this file three columns wider than the one
   *  it replaces — the same kind of break as omitting one. */
  it('does not carry the call-detail sheet’s tool columns', async () => {
    const { campaign } = await seed();

    expect(cells((await render(campaign.id))[0]!)).not.toContain('Tool Executions');
  });

  it('names each extracted metric and its reason, and each entity', async () => {
    const { campaign, account } = await seed();
    const lead = await addLead(campaign);
    await addAttempt(campaign, account, lead, {
      disposition: 'completed',
      extraction: { Call_Outcome_tb: 'dropped', Call_Outcome_tb_reason: 'Ended early', Customer_Voice: 'hello' },
    });

    const header = cells((await render(campaign.id))[0]!);

    expect(header).toContain('Lead Metric Call_Outcome_tb');
    expect(header).toContain('Lead Metric Call_Outcome_tb Reason');
    expect(header).toContain('Lead Entity Customer_Voice');
    expect(header).not.toContain('Lead Entity Call_Outcome_tb_reason');
  });

  /**
   * The variable columns are the AGENT VARIABLE names, which is what the
   * reference file's `tb_*` group holds — not the CSV headers they were mapped
   * from. `variableMap` is `{ csvColumn: agentVariable }`, so the header is its
   * values.
   */
  it('names the agent variables a mapped campaign sends, not the csv columns', async () => {
    const { campaign } = await seed({ variableMap: { 'Plan Tenure': 'tb_plan_tenure' } });

    const header = cells((await render(campaign.id))[0]!);

    expect(header).toContain('tb_plan_tenure');
    expect(header).not.toContain('Plan Tenure');
  });

  /**
   * The values come from the dialer's own projection, `variablesFor`, called
   * rather than restated. Two things only that projection gets right: a mapped
   * column named for one of the four the importer lifted out of metadata
   * (`phone`, `name`, `email`, `tags`) resolves to the contact's column, not to
   * an empty metadata key; and when two CSV columns map to one variable, the
   * one exported is whichever the dial sends. That second one is asserted
   * against `variablesFor` itself rather than a literal: jsonb does not keep
   * key order, so which entry "wins" is the projection's business, and the
   * export's only obligation is to agree with it.
   */
  it('exports the value each dial actually sent, through the dialer projection', async () => {
    const { campaign } = await seed({
      variableMap: { name: 'tb_name', 'Old Plan': 'tb_plan', Plan: 'tb_plan' },
    });
    const lead = await addLead(campaign, {
      name: 'Asha',
      metadata: { 'Old Plan': 'basic', Plan: 'gold' },
    });

    const stored = await prisma.campaign.findUniqueOrThrow({
      where: { id: campaign.id },
      include: { agent: { select: { variables: true } } },
    });
    const contact = await prisma.contact.findUniqueOrThrow({ where: { id: lead.contactId } });
    const sent = variablesFor(stored, stored.agent?.variables, contact);

    const rows = await render(campaign.id);
    const header = cells(rows[0]!);
    const row = cells(rows[1]!);

    expect(row[header.indexOf('tb_name')]).toBe('Asha');
    expect(['basic', 'gold']).toContain(sent.tb_plan);
    expect(row[header.indexOf('tb_plan')]).toBe(sent.tb_plan);
  });
});

describe('which extraction speaks for a lead', () => {
  /**
   * The PR #48 regression, and the reason this export cannot invent its own
   * rule. The post-call model fills in every key it is given, so a machine that
   * beeped for thirty seconds is graded as confidently as a real conversation.
   * Read without the reached predicate, a Thursday follow-up into an answering
   * machine overrides Tuesday's actual conversation — 27 contacts of 843 on the
   * two September campaigns.
   */
  it('lets a real conversation stand over a later voicemail that also extracted', async () => {
    const { campaign, account } = await seed({ leadBucketKey: 'interest' });
    const lead = await addLead(campaign);

    await addAttempt(campaign, account, lead, {
      attemptNo: 1,
      disposition: 'completed',
      startedAt: new Date('2026-09-01T10:00:00.000Z'),
      extraction: { interest: 'hot', interest_reason: 'Asked for a demo' },
    });
    await addAttempt(campaign, account, lead, {
      attemptNo: 2,
      disposition: 'voicemail',
      startedAt: new Date('2026-09-03T10:00:00.000Z'),
      extraction: { interest: 'cold', interest_reason: 'No engagement' },
    });

    const rows = await render(campaign.id);
    const header = cells(rows[0]!);
    const row = cells(rows[1]!);

    expect(row[header.indexOf('Lead Interest')]).toBe('hot');
  });

  /** An absent extraction is no answer, not a new one. */
  it('lets an earlier answer stand when a later reached call extracted nothing', async () => {
    const { campaign, account } = await seed({ leadBucketKey: 'interest' });
    const lead = await addLead(campaign);

    await addAttempt(campaign, account, lead, {
      attemptNo: 1,
      disposition: 'completed',
      startedAt: new Date('2026-09-01T10:00:00.000Z'),
      extraction: { interest: 'warm' },
    });
    await addAttempt(campaign, account, lead, {
      attemptNo: 2,
      disposition: 'completed',
      startedAt: new Date('2026-09-03T10:00:00.000Z'),
      extraction: undefined,
    });

    const rows = await render(campaign.id);
    const header = cells(rows[0]!);

    expect(cells(rows[1]!)[header.indexOf('Lead Interest')]).toBe('warm');
  });

  /**
   * "Reached" is `reachedAttemptSql`, the whole predicate, and not the
   * disposition list alone. The platform maps Q.850 cause 16 to `no_answer` on
   * some real conversations, and answer detection saying `human` is what the
   * buckets, the strip and the analytics use to count those as reached. An
   * export that read the disposition alone would show this lead with no
   * answer beside a dashboard chip that buckets it — the one disagreement this
   * file exists to prevent.
   */
  it('reads the extraction of a call the answer detector marked human, even under no_answer', async () => {
    const { campaign, account } = await seed({ leadBucketKey: 'interest' });
    const lead = await addLead(campaign);

    await addAttempt(campaign, account, lead, {
      attemptNo: 1,
      disposition: 'no_answer',
      answeredBy: 'human',
      durationSecs: 42,
      startedAt: new Date('2026-09-01T10:00:00.000Z'),
      extraction: { interest: 'hot', interest_reason: 'Wants the autopay link' },
    });

    const rows = await render(campaign.id);
    const header = cells(rows[0]!);
    const row = cells(rows[1]!);

    expect(row[header.indexOf('Lead Interest')]).toBe('hot');
    expect(row[header.indexOf('AI Connected Calls')]).toBe('1');
    expect(row[header.indexOf('AI Connected Seconds')]).toBe('42.00');
  });
});

describe('the call aggregates', () => {
  it('counts every dial but only the reached ones as connected', async () => {
    const { campaign, account } = await seed();
    const lead = await addLead(campaign);

    await addAttempt(campaign, account, lead, {
      attemptNo: 1,
      disposition: 'no_answer',
      startedAt: new Date('2026-09-01T10:00:00.000Z'),
      durationSecs: 0,
    });
    await addAttempt(campaign, account, lead, {
      attemptNo: 2,
      disposition: 'completed',
      startedAt: new Date('2026-09-02T10:00:00.000Z'),
      durationSecs: 8,
    });

    const rows = await render(campaign.id);
    const header = cells(rows[0]!);
    const row = cells(rows[1]!);

    expect(row[header.indexOf('Total AI Call Attempts')]).toBe('2');
    expect(row[header.indexOf('AI Connected Calls')]).toBe('1');
    expect(row[header.indexOf('AI Connected Seconds')]).toBe('8.00');
  });

  it('reports the last call, not the first, as the last status', async () => {
    const { campaign, account } = await seed();
    const lead = await addLead(campaign);

    await addAttempt(campaign, account, lead, {
      attemptNo: 1,
      disposition: 'completed',
      startedAt: new Date('2026-09-01T10:00:00.000Z'),
      hangupSource: 'callee',
    });
    await addAttempt(campaign, account, lead, {
      attemptNo: 2,
      disposition: 'no_answer',
      startedAt: new Date('2026-09-05T10:00:00.000Z'),
      hangupSource: null,
    });

    const rows = await render(campaign.id);
    const header = cells(rows[0]!);
    const row = cells(rows[1]!);

    expect(row[header.indexOf('Last Call Status')]).toBe('no_answer');
    expect(row[header.indexOf('Last Call Disconnected By')]).toBe('System');
  });

  it('attributes the last call from end_call_reason when there is no source', async () => {
    const { campaign, account } = await seed();
    const lead = await addLead(campaign);

    await addAttempt(campaign, account, lead, {
      attemptNo: 1,
      disposition: 'completed',
      startedAt: new Date('2026-09-01T10:00:00.000Z'),
      hangupSource: null,
      endCallReason: 'CUSTOMER_HUNG_UP',
    });

    const rows = await render(campaign.id);
    const header = cells(rows[0]!);

    expect(cells(rows[1]!)[header.indexOf('Last Call Disconnected By')]).toBe('Customer');
  });

  /** The LAST attempt's reason, from the same row the source and status come from. */
  it('reads the last attempt\'s end_call_reason, not the first', async () => {
    const { campaign, account } = await seed();
    const lead = await addLead(campaign);

    await addAttempt(campaign, account, lead, {
      attemptNo: 1,
      disposition: 'completed',
      startedAt: new Date('2026-09-01T10:00:00.000Z'),
      hangupSource: null,
      endCallReason: 'COMPLETED',
    });
    await addAttempt(campaign, account, lead, {
      attemptNo: 2,
      disposition: 'completed',
      startedAt: new Date('2026-09-05T10:00:00.000Z'),
      hangupSource: null,
      endCallReason: 'CUSTOMER_HUNG_UP',
    });

    const rows = await render(campaign.id);
    const header = cells(rows[0]!);

    expect(cells(rows[1]!)[header.indexOf('Last Call Disconnected By')]).toBe('Customer');
  });

  /** A lead nobody has dialled is still a row: it is on the list, and a file
   *  that silently omitted it would not sum to the campaign. */
  it('emits an undialled lead with empty aggregates', async () => {
    const { campaign } = await seed();
    await addLead(campaign, { phone: '+919900011111' });

    const rows = await render(campaign.id);
    const header = cells(rows[0]!);
    const row = cells(rows[1]!);

    expect(row[header.indexOf('Phone Number')]).toBe("'+919900011111");
    expect(row[header.indexOf('Total AI Call Attempts')]).toBe('0');
    expect(row[header.indexOf('First Call Timestamp')]).toBe('');
  });
});

/**
 * The one place this file deliberately departs from byte-parity with the
 * export it replaces.
 *
 * Every phone number here is E.164, so every one of them begins with `+` — a
 * character a spreadsheet reads as the start of a formula. The reference file
 * writes them bare; this service has neutralised that on every export it has
 * ever shipped, and re-introducing a known injection vector to match a
 * competitor's file byte for byte is not a trade worth making. The apostrophe
 * is invisible in a spreadsheet and the digits are unchanged.
 */
describe('formula injection', () => {
  it('neutralises the leading + on a phone number', async () => {
    const { campaign } = await seed();
    await addLead(campaign, { phone: '+919900022222' });

    const rows = await render(campaign.id);

    expect(rows[1]!).toContain('"\'+919900022222"');
    expect(cells(rows[1]!)[cells(rows[0]!).indexOf('Phone Number')]).toBe("'+919900022222");
  });
});

/**
 * What the variable columns say a call was told.
 *
 * Reconstructing them from `Contact.metadata` through the campaign's CURRENT
 * `variableMap` is right only while that map has not been edited since the
 * calls were placed. Once a dial's own variables are stored, they are the
 * better answer, because they are what the agent was actually told rather than
 * what it would be told if the same lead were dialled today.
 */
describe('the variable columns', () => {
  it('prefers what the dial actually sent over what the map would send now', async () => {
    const { campaign, account } = await seed({ variableMap: { 'Business Name': 'tb_business_name' } });
    const lead = await addLead(campaign, { metadata: { 'Business Name': 'Renamed Since' } });

    await addAttempt(campaign, account, lead, {
      attemptNo: 1,
      disposition: 'completed',
      variables: { tb_business_name: 'Petal Palace' },
    });

    const rows = await render(campaign.id);
    const header = cells(rows[0]!);

    expect(cells(rows[1]!)[header.indexOf('tb_business_name')]).toBe('Petal Palace');
  });

  /** Every attempt settled before the column existed carries null, and until
   *  the backfill reaches them the reconstruction is the only answer there is
   *  — better than a blank column claiming the dial carried nothing. */
  it('falls back to the map for a dial placed before the column existed', async () => {
    const { campaign, account } = await seed({ variableMap: { 'Business Name': 'tb_business_name' } });
    const lead = await addLead(campaign, { metadata: { 'Business Name': 'Petal Palace' } });

    await addAttempt(campaign, account, lead, { attemptNo: 1, disposition: 'completed' });

    const rows = await render(campaign.id);
    const header = cells(rows[0]!);

    expect(cells(rows[1]!)[header.indexOf('tb_business_name')]).toBe('Petal Palace');
  });
});
