import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import {
  CUSTOM_EXPORT_GROUPS,
  IDENTITY_COLUMNS,
  parseCustomExportFields,
  streamCustomCsv,
} from '../src/services/campaignCustomExport.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';

/**
 * The custom export: one row per `CallAttempt`, columns chosen by group.
 *
 * What is graded is that each group produces exactly its columns and that the
 * identity columns are always present, that the range filters on `startedAt`,
 * and the three cells whose shape is a decision rather than a copy: the
 * transcript flattening, the recording link, and credits in display units.
 */

let seq = 0;

async function seed(campaignFields: Record<string, unknown> = {}) {
  const account = await makeAccount(`custom-export-${(seq += 1)}`);
  const workspace = await makeWorkspace(account, 'Custom');
  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: workspace.id,
      name: 'Autopay Touchbase',
      status: 'RUNNING',
      ...campaignFields,
    } as never,
  });
  const contact = await prisma.contact.create({
    data: { workspaceId: workspace.id, phone: '+918482909288', name: 'Asha', metadata: { city: 'Pune' } },
  });
  const lead = await prisma.campaignContact.create({
    data: { campaignId: campaign.id, contactId: contact.id, status: 'COMPLETED' },
  });

  return { account, workspace, campaign, contact, lead };
}

async function addAttempt(ctx: Awaited<ReturnType<typeof seed>>, fields: Record<string, unknown>) {
  seq += 1;

  return prisma.callAttempt.create({
    data: {
      campaignId: ctx.campaign.id,
      campaignContactId: ctx.lead.id,
      workspaceId: ctx.workspace.id,
      accountId: ctx.account.id,
      upstreamCallId: `c_${seq}`,
      status: 'COMPLETED',
      attemptNo: seq,
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

/** A CSV record splitter that respects quoted newlines, which the transcript cell has. */
function records(csv: string): string[] {
  const out: string[] = [];
  let record = '';
  let quoted = false;

  for (let i = 0; i < csv.length; i += 1) {
    const ch = csv[i]!;
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '\r' && csv[i + 1] === '\n') {
      out.push(record);
      record = '';
      i += 1;
      continue;
    }
    record += ch;
  }
  if (record !== '') out.push(record);

  return out;
}

async function render(
  campaignId: string,
  fields: string[],
  range?: { from: Date; to: Date },
  appUrl?: string,
): Promise<string[][]> {
  let out = '';
  await streamCustomCsv(
    campaignId,
    (chunk) => {
      out += chunk;
      return true;
    },
    { fields: parseCustomExportFields(fields.join(',')), range, appUrl },
  );

  return records(out.replace(/^﻿/, '')).map(cells);
}

beforeEach(async () => {
  await truncateAll();
});

describe('parseCustomExportFields', () => {
  it('accepts every group name, in any order, deduplicated', () => {
    expect(parseCustomExportFields('credits,attempts,credits')).toEqual(['attempts', 'credits']);
    expect(parseCustomExportFields(CUSTOM_EXPORT_GROUPS.map((g) => g.key).join(','))).toEqual(
      CUSTOM_EXPORT_GROUPS.map((g) => g.key),
    );
  });

  it('refuses an unknown group and an empty list', () => {
    expect(() => parseCustomExportFields('attempts,bogus')).toThrow(/bogus/);
    expect(() => parseCustomExportFields('')).toThrow();
    expect(() => parseCustomExportFields(undefined)).toThrow();
  });
});

describe('streamCustomCsv', () => {
  it('always writes the identity columns, then each chosen group in canonical order', async () => {
    const ctx = await seed();
    await addAttempt(ctx, { startedAt: new Date('2026-09-10T10:00:00Z') });

    const [header, row] = await render(ctx.campaign.id, ['credits', 'attempts']);

    expect(header!.slice(0, IDENTITY_COLUMNS.length)).toEqual([...IDENTITY_COLUMNS]);
    const attempts = CUSTOM_EXPORT_GROUPS.find((g) => g.key === 'attempts')!;
    const credits = CUSTOM_EXPORT_GROUPS.find((g) => g.key === 'credits')!;
    expect(header!.slice(IDENTITY_COLUMNS.length)).toEqual([...attempts.columns, ...credits.columns]);
    expect(row!.length).toBe(header!.length);
    expect(row![0]).toBe(ctx.lead.id);
    expect(row![1]).toBe('Asha');
    // Formula-safe, as every sheet writes a leading `+`.
    expect(row![2]).toBe("'+918482909288");
    expect(row![5]).toBe('2026-09-10 10:00:00');
    expect(IDENTITY_COLUMNS[6]).toBe('Direction');
    expect(row![6]).toBe('Outbound');
  });

  it('filters on startedAt when a range is given, and walks every dial otherwise', async () => {
    const ctx = await seed();
    await addAttempt(ctx, { startedAt: new Date('2026-09-01T10:00:00Z') });
    await addAttempt(ctx, { startedAt: new Date('2026-09-10T10:00:00Z') });
    await addAttempt(ctx, { startedAt: new Date('2026-09-20T10:00:00Z') });

    const all = await render(ctx.campaign.id, ['attempts']);
    expect(all.length).toBe(4);

    const some = await render(ctx.campaign.id, ['attempts'], {
      from: new Date('2026-09-05T00:00:00Z'),
      to: new Date('2026-09-15T00:00:00Z'),
    });
    expect(some.length).toBe(2);
    expect(some[1]![5]).toBe('2026-09-10 10:00:00');
  });

  it('writes attempt facts, with reached decided by the shared predicate', async () => {
    const ctx = await seed();
    await addAttempt(ctx, {
      disposition: 'completed',
      answeredAt: new Date('2026-09-10T10:00:05Z'),
      endedAt: new Date('2026-09-10T10:02:05Z'),
      durationSecs: 120,
      hangupSource: 'caller',
      errorCode: 'user_hangup',
    });
    await addAttempt(ctx, { disposition: 'no_answer' });

    const [header, reached, missed] = await render(ctx.campaign.id, ['attempts']);
    const at = (name: string) => header!.indexOf(name);

    expect(reached![at('Disposition')]).toBe('completed');
    expect(reached![at('Reached')]).toBe('Yes');
    expect(reached![at('Duration (Seconds)')]).toBe('120');
    expect(reached![at('Disconnected By')]).toBe('Customer');
    expect(reached![at('End Call Reason')]).toBe('user_hangup');
    expect(missed![at('Reached')]).toBe('No');
    expect(missed![at('Disconnected By')]).toBe('System');
  });

  it('writes credits in display units, never the internal multiplier', async () => {
    const ctx = await seed();
    await addAttempt(ctx, {
      costCredits: 25_000n,
      rateCreditsPerMin: 10_000n,
      billedSecs: 150,
      tierSlug: 'standard',
      chargedAt: new Date('2026-09-10T10:03:00Z'),
    });
    await addAttempt(ctx, {});

    const [header, charged, free] = await render(ctx.campaign.id, ['credits']);
    const at = (name: string) => header!.indexOf(name);

    expect(charged![at('Cost Credits')]).toBe('2.5');
    expect(charged![at('Rate Credits Per Minute')]).toBe('1');
    expect(charged![at('Billed Seconds')]).toBe('150');
    expect(charged![at('Tier')]).toBe('standard');
    expect(charged![at('Charged At')]).toBe('2026-09-10 10:03:00');
    expect(free![at('Cost Credits')]).toBe('');
  });

  it('flattens a transcript to one cell of role-prefixed lines, and leaves a non-array empty', async () => {
    const ctx = await seed();
    await addAttempt(ctx, {
      transcript: [
        { role: 'assistant', content: 'Hello, "Asha"' },
        { role: 'user', content: 'Yes, speaking' },
      ],
    });
    await addAttempt(ctx, { transcript: { error: 'no_answer', provider: 'voicelink' } });

    const [header, spoke, silent] = await render(ctx.campaign.id, ['transcript']);
    const at = header!.indexOf('Transcript');

    expect(spoke![at]).toBe('assistant: Hello, "Asha"\nuser: Yes, speaking');
    expect(silent![at]).toBe('');
  });

  it('links a recording to the call page only when one exists and a base URL is known', async () => {
    const ctx = await seed();
    const has = await addAttempt(ctx, { recordingAvailable: true });
    await addAttempt(ctx, { recordingAvailable: false });
    await addAttempt(ctx, { recordingAvailable: true, upstreamCallId: null });

    const withUrl = await render(ctx.campaign.id, ['recording'], undefined, 'https://app.test');
    const at = withUrl[0]!.indexOf('Recording');
    expect(withUrl[1]![at]).toBe(`https://app.test/calls/${has.upstreamCallId}`);
    expect(withUrl[2]![at]).toBe('');
    expect(withUrl[3]![at]).toBe('');

    const noUrl = await render(ctx.campaign.id, ['recording']);
    expect(noUrl[1]![at]).toBe('');
  });

  it('writes one extraction column per key seen on the campaign, per dial, reserved keys dropped', async () => {
    const ctx = await seed();
    await addAttempt(ctx, {
      disposition: 'completed',
      extraction: { interest: 'high', interest_reason: 'asked for a demo', call_outcome_vocobaseplatform: 'x' },
    });
    await addAttempt(ctx, { disposition: 'no_answer', extraction: { city: 'Pune' } });

    const [header, first, second] = await render(ctx.campaign.id, ['extractions']);
    const extra = header!.slice(IDENTITY_COLUMNS.length);

    expect(extra).toEqual(['Extraction city', 'Extraction interest', 'Extraction interest_reason']);
    expect(first!.slice(IDENTITY_COLUMNS.length)).toEqual(['', 'high', 'asked for a demo']);
    // Per dial, deliberately: this file publishes what each call wrote.
    expect(second!.slice(IDENTITY_COLUMNS.length)).toEqual(['Pune', '', '']);
  });

  it('writes the variables the campaign sends, stored value first, projection as fallback', async () => {
    const ctx = await seed({ variableMap: { city: 'city_name', name: 'customer' } });
    await addAttempt(ctx, { variables: { city_name: 'Mumbai', customer: 'Asha' } });
    await addAttempt(ctx, { variables: null });

    const [header, stored, projected] = await render(ctx.campaign.id, ['variables']);

    expect(header!.slice(IDENTITY_COLUMNS.length)).toEqual(['city_name', 'customer']);
    expect(stored!.slice(IDENTITY_COLUMNS.length)).toEqual(['Mumbai', 'Asha']);
    expect(projected!.slice(IDENTITY_COLUMNS.length)).toEqual(['Pune', 'Asha']);
  });

  it('writes the session metadata verbatim', async () => {
    const ctx = await seed();
    const a = await addAttempt(ctx, {
      upstreamSessionId: 's_1',
      answeredBy: 'human',
      hangupCause: 'NORMAL_CLEARING',
      hangupSource: 'caller',
      upstreamStatus: 'completed',
      kind: 'conversation',
      errorMessage: null,
    });

    const [header, row] = await render(ctx.campaign.id, ['session']);
    const at = (name: string) => header!.indexOf(name);

    expect(row![at('Upstream Call ID')]).toBe(a.upstreamCallId);
    expect(row![at('Upstream Session ID')]).toBe('s_1');
    expect(row![at('Answered By')]).toBe('human');
    expect(row![at('Hangup Cause')]).toBe('NORMAL_CLEARING');
    expect(row![at('Hangup Source')]).toBe('caller');
    expect(row![at('Upstream Status')]).toBe('completed');
    expect(row![at('Call Kind')]).toBe('conversation');
    expect(row![at('Error Message')]).toBe('');
  });

  it('pages by keyset and writes every row once', async () => {
    const ctx = await seed();
    const at = new Date('2026-09-10T10:00:00Z');
    for (let i = 0; i < 5; i += 1) await addAttempt(ctx, { startedAt: at });

    let out = '';
    await streamCustomCsv(ctx.campaign.id, (c) => { out += c; return true; }, {
      fields: ['attempts'],
      pageSize: 2,
    });
    const rows = records(out.replace(/^﻿/, ''));

    expect(rows.length).toBe(6);
    expect(new Set(rows.slice(1).map((r) => cells(r)[3])).size).toBe(5);
  });

  /**
   * Inbound calls live in their own table and carry a subset of the fields.
   * They ride the same file, merged by time, with Direction saying which row
   * is which — a campaign that only ever received calls used to export a
   * header and nothing else.
   */
  describe('inbound calls', () => {
    async function addInbound(ctx: Awaited<ReturnType<typeof seed>>, fields: Record<string, unknown>) {
      seq += 1;
      const did = await prisma.phoneNumber.create({
        data: { did: `+9180${String(seq).padStart(7, '0')}`, workspaceId: ctx.workspace.id, status: 'ASSIGNED' },
      });

      return prisma.campaignInboundCall.create({
        data: {
          campaignId: ctx.campaign.id,
          campaignContactId: ctx.lead.id,
          contactId: ctx.contact.id,
          workspaceId: ctx.workspace.id,
          phoneNumberId: did.id,
          fromNumber: '+918482909288',
          upstreamPhoneCallId: `pc_${seq}`,
          upstreamSessionId: `ps_${seq}`,
          ...fields,
        } as never,
      });
    }

    it('merges inbound calls with dials by time, each row saying its direction', async () => {
      const ctx = await seed();
      await addAttempt(ctx, { startedAt: new Date('2026-09-10T10:00:00Z') });
      await addInbound(ctx, { arrivedAt: new Date('2026-09-10T09:00:00Z') });
      await addInbound(ctx, { arrivedAt: new Date('2026-09-10T11:00:00Z') });

      const [header, ...rows] = await render(ctx.campaign.id, ['attempts']);
      const at = (name: string) => header!.indexOf(name);

      expect(rows.map((r) => r[at('Started At')])).toEqual([
        '2026-09-10 09:00:00',
        '2026-09-10 10:00:00',
        '2026-09-10 11:00:00',
      ]);
      expect(rows.map((r) => r[at('Direction')])).toEqual(['Inbound', 'Outbound', 'Inbound']);
    });

    it('fills what an inbound call records and leaves the rest empty', async () => {
      const ctx = await seed();
      const call = await addInbound(ctx, {
        arrivedAt: new Date('2026-09-10T09:00:00Z'),
        endedAt: new Date('2026-09-10T09:02:00Z'),
        durationSecs: 120,
        disposition: 'completed',
        costCredits: 15_000n,
        extraction: { interest: 'high' },
      });

      const [header, row] = await render(ctx.campaign.id, [
        'attempts', 'credits', 'extractions', 'transcript', 'recording', 'session',
      ], undefined, 'https://app.test');
      const at = (name: string) => header!.indexOf(name);

      expect(row![at('Lead ID')]).toBe(ctx.lead.id);
      expect(row![at('Lead Name')]).toBe('Asha');
      expect(row![at('Phone')]).toBe("'+918482909288");
      expect(row![at('Attempt ID')]).toBe(call.id);
      expect(row![at('Attempt No')]).toBe('');
      expect(row![at('Direction')]).toBe('Inbound');
      expect(row![at('Disposition')]).toBe('completed');
      expect(row![at('Reached')]).toBe('Yes');
      expect(row![at('Ended At')]).toBe('2026-09-10 09:02:00');
      expect(row![at('Duration (Seconds)')]).toBe('120');
      expect(row![at('Cost Credits')]).toBe('1.5');
      expect(row![at('Extraction interest')]).toBe('high');
      // Nothing stored yet for this row: no conversation, no audio claimed.
      expect(row![at('Transcript')]).toBe('');
      expect(row![at('Recording')]).toBe('');
      expect(row![at('Upstream Call ID')]).toBe(call.upstreamPhoneCallId);
      expect(row![at('Upstream Session ID')]).toBe('ps_' + String(seq));
    });

    it('prints an inbound call\'s stored transcript and links its recording by the platform call id', async () => {
      const ctx = await seed();
      const call = await addInbound(ctx, {
        transcript: [{ role: 'user', content: 'Billing question.', timestamp: null }],
        recordingAvailable: true,
      });
      await addInbound(ctx, { transcript: [], recordingAvailable: false });

      const [header, has, hasNot] = await render(ctx.campaign.id, ['transcript', 'recording'], undefined, 'https://app.test');
      const at = (name: string) => header!.indexOf(name);

      expect(has![at('Transcript')]).toBe('user: Billing question.');
      expect(has![at('Recording')]).toBe(`https://app.test/calls/${call.upstreamPhoneCallId}`);
      expect(hasNot![at('Transcript')]).toBe('');
      expect(hasNot![at('Recording')]).toBe('');
    });

    it('bounds inbound calls by the same range, on when they arrived', async () => {
      const ctx = await seed();
      await addInbound(ctx, { arrivedAt: new Date('2026-09-01T09:00:00Z') });
      await addInbound(ctx, { arrivedAt: new Date('2026-09-10T09:00:00Z') });

      const rows = await render(ctx.campaign.id, ['attempts'], {
        from: new Date('2026-09-05T00:00:00Z'),
        to: new Date('2026-09-15T00:00:00Z'),
      });

      expect(rows.length).toBe(2);
    });

    it('adds the extraction keys inbound calls carried to the header', async () => {
      const ctx = await seed();
      await addAttempt(ctx, { extraction: { interest: 'high' } });
      await addInbound(ctx, { extraction: { reason: 'billing' } });

      const [header] = await render(ctx.campaign.id, ['extractions']);

      expect(header!.slice(IDENTITY_COLUMNS.length)).toEqual(['Extraction interest', 'Extraction reason']);
    });

    it('pages both sources and writes every row once', async () => {
      const ctx = await seed();
      for (let i = 0; i < 3; i += 1) await addAttempt(ctx, { startedAt: new Date(`2026-09-10T1${i}:00:00Z`) });
      for (let i = 0; i < 3; i += 1) await addInbound(ctx, { arrivedAt: new Date(`2026-09-10T1${i}:30:00Z`) });

      let out = '';
      await streamCustomCsv(ctx.campaign.id, (c) => { out += c; return true; }, {
        fields: ['attempts'],
        pageSize: 2,
      });
      const rows = records(out.replace(/^\uFEFF/, '')).slice(1).map(cells);

      expect(rows.length).toBe(6);
      expect(new Set(rows.map((r) => r[3])).size).toBe(6);
      expect(rows.map((r) => r[6])).toEqual(['Outbound', 'Inbound', 'Outbound', 'Inbound', 'Outbound', 'Inbound']);
    });
  });

  it('writes nothing for a campaign that does not exist', async () => {
    let out = '';
    await streamCustomCsv('nope', (c) => { out += c; return true; }, { fields: ['attempts'] });
    expect(out).toBe('');
  });
});
