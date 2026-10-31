import type { Backend } from './boot.js';
import type { MockState } from './lib.js';

/**
 * The trace: an ordered record of everything observable a run produced.
 * Assertions read this, and a failing scenario prints it — the repro is the
 * trace, not a log grep.
 */
export type TraceEvent =
  | {
      kind: 'dial';
      atMs: number;
      phone: string;
      fromNumber: string;
      campaignContactId: string | null;
      attemptId: string | null;
      attemptNo: number | null;
      callId: string;
    }
  | {
      kind: 'contact';
      atMs: number;
      id: string;
      phone: string;
      from: string;
      to: string;
      nextEligibleAt: Date | null;
    }
  | { kind: 'campaign'; atMs: number; id: string; field: string; from: string; to: string }
  | { kind: 'attempt'; atMs: number; id: string; attemptNo: number; from: string; to: string }
  | { kind: 'ledger'; atMs: number; id: string; type: string; amount: bigint; reference: string | null };

export interface ContactRow {
  id: string;
  phone: string;
  status: string;
  attempts: number;
  callbackCount: number;
  nextEligibleAt: Date | null;
  callbackAt: Date | null;
}

export interface CampaignRow {
  id: string;
  status: string;
  totalContacts: number;
  completedCount: number;
  failedCount: number;
  skippedCount: number;
  rrCursor: number;
  stoppedAt: Date | null;
}

export interface AttemptRow {
  id: string;
  campaignId: string | null;
  campaignContactId: string | null;
  attemptNo: number;
  status: string;
  fromNumber: string | null;
  chargedAt: Date | null;
  resolvedAt: Date | null;
  shortfall: boolean;
  costCredits: bigint | null;
  durationSecs: number | null;
}

export interface LedgerRow {
  id: string;
  accountId: string;
  type: string;
  amount: bigint;
  reference: string | null;
}

export interface Snapshot {
  contacts: Map<string, ContactRow>;
  campaigns: Map<string, CampaignRow>;
  attempts: Map<string, AttemptRow>;
  ledger: Map<string, LedgerRow>;
  dialLogLength: number;
}

export async function takeSnapshot(backend: Backend, mockState: MockState): Promise<Snapshot> {
  const { prisma } = backend;
  const [contacts, campaigns, attempts, ledger] = await Promise.all([
    prisma.campaignContact.findMany({
      select: {
        id: true,
        status: true,
        attempts: true,
        callbackCount: true,
        nextEligibleAt: true,
        callbackAt: true,
        contact: { select: { phone: true } },
      },
    }),
    prisma.campaign.findMany({
      select: {
        id: true,
        status: true,
        totalContacts: true,
        completedCount: true,
        failedCount: true,
        skippedCount: true,
        rrCursor: true,
        stoppedAt: true,
      },
    }),
    prisma.callAttempt.findMany({
      select: {
        id: true,
        campaignId: true,
        campaignContactId: true,
        attemptNo: true,
        status: true,
        fromNumber: true,
        chargedAt: true,
        resolvedAt: true,
        shortfall: true,
        costCredits: true,
        durationSecs: true,
      },
    }),
    prisma.creditTransaction.findMany({
      select: { id: true, accountId: true, type: true, amount: true, reference: true },
    }),
  ]);
  return {
    contacts: new Map(
      contacts.map((c) => [
        c.id,
        {
          id: c.id,
          phone: c.contact.phone,
          status: c.status,
          attempts: c.attempts,
          callbackCount: c.callbackCount,
          nextEligibleAt: c.nextEligibleAt,
          callbackAt: c.callbackAt,
        },
      ]),
    ),
    campaigns: new Map(campaigns.map((c) => [c.id, c])),
    attempts: new Map(attempts.map((a) => [a.id, a])),
    ledger: new Map(ledger.map((l) => [l.id, l])),
    dialLogLength: mockState.dialLog.length,
  };
}

/** Appends the delta between two snapshots (plus new dials) to the trace. */
export function diffIntoTrace(
  trace: TraceEvent[],
  atMs: number,
  prev: Snapshot | null,
  next: Snapshot,
  mockState: MockState,
  backend: Backend,
): void {
  for (const entry of mockState.dialLog.slice(prev?.dialLogLength ?? 0)) {
    let campaignContactId: string | null = null;
    let attemptId: string | null = null;
    let attemptNo: number | null = null;
    if (entry.ref) {
      const parsed = backend.parseCorrelationId(entry.ref);
      if (parsed) {
        campaignContactId = parsed.campaignContactId ?? null;
        attemptId = parsed.attemptId ?? null;
        if (attemptId) attemptNo = next.attempts.get(attemptId)?.attemptNo ?? null;
      }
    }
    trace.push({
      kind: 'dial',
      atMs,
      phone: entry.toNumber,
      fromNumber: entry.fromNumber,
      campaignContactId,
      attemptId,
      attemptNo,
      callId: entry.callId,
    });
  }

  for (const [id, row] of next.contacts) {
    const before = prev?.contacts.get(id);
    if (!before) continue; // creation is seeding, not engine behavior
    if (before.status !== row.status) {
      trace.push({
        kind: 'contact',
        atMs,
        id,
        phone: row.phone,
        from: before.status,
        to: row.status,
        nextEligibleAt: row.nextEligibleAt,
      });
    }
  }
  for (const [id, row] of next.campaigns) {
    const before = prev?.campaigns.get(id);
    if (!before) continue;
    for (const field of ['status', 'completedCount', 'failedCount', 'skippedCount', 'totalContacts'] as const) {
      if (String(before[field]) !== String(row[field])) {
        trace.push({ kind: 'campaign', atMs, id, field, from: String(before[field]), to: String(row[field]) });
      }
    }
  }
  for (const [id, row] of next.attempts) {
    const before = prev?.attempts.get(id);
    if (before && before.status === row.status) continue;
    trace.push({
      kind: 'attempt',
      atMs,
      id,
      attemptNo: row.attemptNo,
      from: before?.status ?? '(new)',
      to: row.status,
    });
  }
  for (const [id, row] of next.ledger) {
    if (prev?.ledger.has(id)) continue;
    trace.push({ kind: 'ledger', atMs, id, type: row.type, amount: row.amount, reference: row.reference });
  }
}

export function renderTrace(trace: TraceEvent[], t0Ms: number): string {
  const lines = trace.map((e) => {
    const t = `t+${((e.atMs - t0Ms) / 1000).toFixed(0)}s`;
    switch (e.kind) {
      case 'dial':
        return `${t} DIAL ${e.phone} attempt#${e.attemptNo ?? '?'} from=${e.fromNumber} call=${e.callId}`;
      case 'contact':
        return `${t} CONTACT ${e.phone} ${e.from} -> ${e.to}`;
      case 'campaign':
        return `${t} CAMPAIGN ${e.id.slice(-6)} ${e.field}: ${e.from} -> ${e.to}`;
      case 'attempt':
        return `${t} ATTEMPT #${e.attemptNo} ${e.from} -> ${e.to}`;
      case 'ledger':
        return `${t} LEDGER ${e.type} amount=${e.amount} ref=${e.reference ?? '-'}`;
    }
  });
  return lines.join('\n');
}
