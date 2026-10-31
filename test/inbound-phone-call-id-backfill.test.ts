import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Moving an imported inbound call's platform id into the column that is read.
 *
 * The whole risk of this backfill is one decision, made per row: an id that
 * `GET /calls/:id` resolves is a `PhoneCall.id` and may be copied; an id it
 * does not is the carrier's `provider_call_id` from a routing-policy row, and
 * copying that would put a non-resolving id into the column the settle dedupe
 * keys on — a worse bug than the missing link it would fix. The two kinds of
 * row are indistinguishable in the data, so the test is the pair of them side
 * by side.
 *
 * The adapter is mocked, as everywhere in this suite: the partner account is
 * production and no test here may make a real network call.
 */
const { getCallMock } = vi.hoisted(() => ({ getCallMock: vi.fn() }));

vi.mock('../src/adapter/vocobase.js', () => ({ getCall: getCallMock }));

import { prisma } from '../src/lib/prisma.js';
import { backfillInboundPhoneCallId } from '../src/services/inboundPhoneCallIdBackfill.js';
import { truncateAll } from './setup.js';
import { makeAccount, makePhoneNumber, makeWorkspace } from './helpers.js';

async function scenario() {
  const account = await makeAccount('backfill');
  const ws = await makeWorkspace(account, 'Backfill Co');
  const did = await makePhoneNumber(ws, '+919000000090', 'ASSIGNED');
  const campaign = await prisma.campaign.create({
    data: { workspaceId: ws.id, name: 'Support', type: 'INBOUND', status: 'RUNNING' },
  });

  return { ws, did, campaign };
}

let seq = 0;

/** One received call, as either the import or the routing policy leaves it. */
async function inboundCall(
  s: Awaited<ReturnType<typeof scenario>>,
  fields: { upstreamCallId: string | null; upstreamPhoneCallId?: string | null; campaignId?: string },
) {
  seq += 1;

  return prisma.campaignInboundCall.create({
    data: {
      campaignId: fields.campaignId ?? s.campaign.id,
      workspaceId: s.ws.id,
      phoneNumberId: s.did.id,
      fromNumber: `+9190000001${String(seq).padStart(2, '0')}`,
      upstreamCallId: fields.upstreamCallId,
      upstreamPhoneCallId: fields.upstreamPhoneCallId ?? null,
      arrivedAt: new Date(Date.UTC(2026, 8, 10, 0, seq)),
    },
  });
}

/** The platform's answer: a record for an id it knows, null for a 404. */
function resolving(...known: string[]) {
  getCallMock.mockImplementation(async (id: string) =>
    known.includes(id) ? { call_id: id } : null,
  );
}

beforeEach(async () => {
  await truncateAll();
  getCallMock.mockReset();
});

describe('backfillInboundPhoneCallId', () => {
  /**
   * The task in one test. An imported row holds a `PhoneCall.id` in the
   * carrier column and must be linked; a policy-created row holds a carrier id
   * there and must be left alone, because the platform id it never learned
   * cannot be invented by copying.
   */
  it('copies the id that resolves and leaves the one that does not', async () => {
    const s = await scenario();
    const imported = await inboundCall(s, { upstreamCallId: 'pc-resolves' });
    const policy = await inboundCall(s, { upstreamCallId: 'CA-carrier' });
    resolving('pc-resolves');

    const result = await backfillInboundPhoneCallId();

    expect(result).toEqual({ candidates: 2, filled: 1, unresolved: 1, conflicted: 0 });
    expect(
      (await prisma.campaignInboundCall.findUniqueOrThrow({ where: { id: imported.id } }))
        .upstreamPhoneCallId,
    ).toBe('pc-resolves');
    expect(
      (await prisma.campaignInboundCall.findUniqueOrThrow({ where: { id: policy.id } }))
        .upstreamPhoneCallId,
    ).toBeNull();
  });

  it('asks the platform rather than guessing from the row', async () => {
    const s = await scenario();
    await inboundCall(s, { upstreamCallId: 'pc-1' });
    resolving('pc-1');

    await backfillInboundPhoneCallId();

    expect(getCallMock).toHaveBeenCalledWith('pc-1');
  });

  it('counts what it would do on a dry run and writes nothing', async () => {
    const s = await scenario();
    const row = await inboundCall(s, { upstreamCallId: 'pc-1' });
    resolving('pc-1');

    const result = await backfillInboundPhoneCallId({ dryRun: true });

    expect(result).toMatchObject({ candidates: 1, filled: 1, unresolved: 0 });
    expect(
      (await prisma.campaignInboundCall.findUniqueOrThrow({ where: { id: row.id } }))
        .upstreamPhoneCallId,
    ).toBeNull();
  });

  /** Fills absences only, which is what makes a second run free rather than a
   *  second write over a column the settle owns. */
  it('never touches a row that already carries a platform id', async () => {
    const s = await scenario();
    await inboundCall(s, { upstreamCallId: 'CA-1', upstreamPhoneCallId: 'pc-already' });

    const result = await backfillInboundPhoneCallId();

    expect(result.candidates).toBe(0);
    expect(getCallMock).not.toHaveBeenCalled();
  });

  it('has nothing to test on a row that carries neither id', async () => {
    const s = await scenario();
    await inboundCall(s, { upstreamCallId: null });

    expect(await backfillInboundPhoneCallId()).toMatchObject({ candidates: 0, filled: 0 });
  });

  /**
   * Both columns are `@unique`. A resolving id that another row already claims
   * is refused and counted, not forced: two rows claiming one platform call is
   * exactly the state the settle dedupe exists to prevent, and a crashed run
   * would leave the rows behind it unwalked.
   */
  it('refuses an id another row has already claimed, and keeps going', async () => {
    const s = await scenario();
    await inboundCall(s, { upstreamCallId: 'CA-other', upstreamPhoneCallId: 'pc-taken' });
    const clash = await inboundCall(s, { upstreamCallId: 'pc-taken' });
    const after = await inboundCall(s, { upstreamCallId: 'pc-fine' });
    resolving('pc-taken', 'pc-fine');

    const result = await backfillInboundPhoneCallId();

    expect(result).toEqual({ candidates: 2, filled: 1, unresolved: 0, conflicted: 1 });
    expect(
      (await prisma.campaignInboundCall.findUniqueOrThrow({ where: { id: clash.id } }))
        .upstreamPhoneCallId,
    ).toBeNull();
    expect(
      (await prisma.campaignInboundCall.findUniqueOrThrow({ where: { id: after.id } }))
        .upstreamPhoneCallId,
    ).toBe('pc-fine');
  });

  it('scopes to one campaign when asked', async () => {
    const s = await scenario();
    const other = await prisma.campaign.create({
      data: { workspaceId: s.ws.id, name: 'Other', type: 'INBOUND', status: 'RUNNING' },
    });
    await inboundCall(s, { upstreamCallId: 'pc-mine' });
    const elsewhere = await inboundCall(s, { upstreamCallId: 'pc-theirs', campaignId: other.id });
    resolving('pc-mine', 'pc-theirs');

    const result = await backfillInboundPhoneCallId({ campaignId: s.campaign.id });

    expect(result).toMatchObject({ candidates: 1, filled: 1 });
    expect(
      (await prisma.campaignInboundCall.findUniqueOrThrow({ where: { id: elsewhere.id } }))
        .upstreamPhoneCallId,
    ).toBeNull();
  });
});
