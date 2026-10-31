# Platform Wallet Top-Up Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let YE staff see the supplier (Vocobase) wallet balance in the staff console, get a "critically low" alert under ₹25,000, and mint and watch a Razorpay payment link without leaving the console.

**Architecture:** `ye-voice-backend` gains five adapter calls, a `PlatformTopup` table, a `platformWallet` service, six staff routes under `/api/admin/wallet`, and a 2-minute maintenance job that refreshes open links. `ye-voice-admin` gains a `/wallet` page (balance, low alert, Add money form, link watcher, recent top-ups) and a low-balance banner in the console layout. Design: `docs/plans/2026-09-07-platform-wallet-topup-design.md`.

**Tech Stack:** Express 5 + Prisma + zod + BullMQ (backend, ESM with `.js` import suffixes, vitest + supertest). Next 15 App Router with server components and server actions (console, vitest + testing-library + jsdom).

---

## Before starting

**Worktrees** (top-level `.worktrees/`, grouped by feature):

```bash
cd /Users/sajaldewangan/Desktop/revenue-generator
git -C ezo/ye-voice-agent/ye-voice-backend fetch origin
git -C ezo/ye-voice-agent/ye-voice-backend worktree add ../../../.worktrees/platform-wallet/ye-voice-backend -b feat/platform-wallet origin/main
git -C ezo/ye-voice-agent/ye-voice-admin fetch origin
git -C ezo/ye-voice-agent/ye-voice-admin worktree add ../../../.worktrees/platform-wallet/ye-voice-admin -b feat/platform-wallet origin/main
cd .worktrees/platform-wallet/ye-voice-backend && npm ci
cd ../ye-voice-admin && npm ci
```

**Backend test database** (per-worktree, so a parallel suite does not bleed):

```bash
# docker containers ye-test-pg (5435) and ye-dev-redis (6382) must be running
psql postgresql://postgres:test@localhost:5435/postgres -c 'CREATE DATABASE ye_test_wallet'
export TEST_DATABASE_URL=postgresql://postgres:test@localhost:5435/ye_test_wallet
export TEST_REDIS_URL=redis://localhost:6382/13
npm run test:prepare
```

16 tests always fail without local secrets (`env.test.ts` ×4, `upstream-dialer.test.ts` ×9, `calls.test.ts` ×3). That is not a regression.

**Rules from the repo's `CLAUDE.md`:** never `migrate reset`; `.env` points at production. Small commits, imperative mood. Customer-facing strings say "the voice platform"; staff console and code may say Vocobase.

---

## Part A: ye-voice-backend

### Task 1: Adapter — balance and top-up calls, with a bounded 409 pass-through

**Files:**
- Modify: `src/lib/errors.ts` (the `ErrorCode` union)
- Modify: `src/adapter/vocobase.ts` (`RequestOptions`, `unwrap`, `request`, new block at the end)
- Test: `test/vocobase-wallet-adapter.test.ts`

**Step 1: Write the failing test**

```ts
// test/vocobase-wallet-adapter.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/errors.js';
import {
  createTopupLink,
  getBalance,
  getTopupConfig,
  getTopupLink,
  quoteTopup,
} from '../src/adapter/vocobase.js';

/**
 * The wallet surface of the adapter. `fetch` is stubbed rather than the module
 * mocked, because what is under test is how an upstream status is mapped.
 */

function respond(status: number, payload: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  process.env.VOCOBASE_API_KEY = 'rg_live_testkey';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getBalance', () => {
  it('unwraps the envelope', async () => {
    respond(200, { success: true, data: { credits: '12500.5', currency: 'INR' } });
    await expect(getBalance()).resolves.toEqual({ credits: '12500.5', currency: 'INR' });
  });
});

describe('getTopupConfig / quoteTopup', () => {
  it('reads the config document', async () => {
    respond(200, { success: true, data: { presets: [1000], min: 1000, max: 400000, gst_rate_bps: 1800 } });
    await expect(getTopupConfig()).resolves.toMatchObject({ min: 1000, max: 400000 });
  });

  it('posts the amount as a JSON number', async () => {
    const fetchMock = respond(200, { success: true, data: { base: 5000, gst: 900, total: 5900 } });
    await expect(quoteTopup(5000)).resolves.toEqual({ base: 5000, gst: 900, total: 5900 });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ amount_rupees: 5000 });
  });
});

describe('createTopupLink', () => {
  it('returns the link on 201', async () => {
    respond(201, {
      success: true,
      data: { payment_order_id: 'po_1', short_url: 'https://rzp.io/i/abc', expires_at: '2026-09-08T10:00:00.000Z', base: 5000, gst: 900, total: 5900 },
    });
    await expect(createTopupLink(5000)).resolves.toMatchObject({ payment_order_id: 'po_1' });
  });

  it('passes a 409 through as OPEN_ORDER_LIMIT rather than NAME_TAKEN', async () => {
    respond(409, { success: false, error: { code: 'OPEN_ORDER_LIMIT', message: '5 links are already open.' } });
    const err = await createTopupLink(5000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe('OPEN_ORDER_LIMIT');
  });

  it('still reports a 400 as VALIDATION_ERROR with the upstream wording', async () => {
    respond(400, { success: false, error: { code: 'INVALID_AMOUNT', message: 'amount_rupees must be a whole number.' } });
    const err = await createTopupLink(5000).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('VALIDATION_ERROR');
    expect((err as ApiError).message).toContain('whole number');
  });
});

describe('getTopupLink', () => {
  it('reads the status document', async () => {
    respond(200, { success: true, data: { payment_order_id: 'po_1', status: 'CREDITED', base: 5000, gst: 900, total: 5900, credited_at: '2026-09-07T10:04:12.000Z', created_at: '2026-09-07T10:00:00.000Z' } });
    await expect(getTopupLink('po_1')).resolves.toMatchObject({ status: 'CREDITED' });
  });

  it('reports a 404 as RESOURCE_NOT_FOUND, not as an outage', async () => {
    respond(404, { success: false, error: { code: 'NOT_FOUND', message: 'nope' } });
    const err = await getTopupLink('po_x').catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('RESOURCE_NOT_FOUND');
  });

  it('a 409 on any other call is still NAME_TAKEN', async () => {
    respond(409, { success: false, error: { code: 'OPEN_ORDER_LIMIT', message: 'x' } });
    const err = await getTopupLink('po_1').catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('NAME_TAKEN');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/vocobase-wallet-adapter.test.ts`
Expected: FAIL — `getBalance` (etc.) is not exported.

**Step 3: Implement**

In `src/lib/errors.ts`, add to `ErrorCode` next to `'NAME_TAKEN'`:

```ts
  | 'NAME_TAKEN'
  // The supplier wallet already has the maximum number of unpaid payment
  // links open. Distinguished from NAME_TAKEN, which is what every other
  // upstream 409 means, because the console must show the open links.
  | 'OPEN_ORDER_LIMIT'
```

In `src/adapter/vocobase.ts`, add to `RequestOptions` (after `bareBody`):

```ts
  /**
   * Opt-in: an upstream 409 on this call means this, not a name collision.
   *
   * `unwrap` reads every 409 as `NAME_TAKEN` because, until the wallet, every
   * write that could conflict was a create-by-name. A payment link conflicts
   * on a count of open links instead, and the console has to act on that
   * differently — so the one call that can hit it says so here.
   */
  conflictCode?: 'OPEN_ORDER_LIMIT';
```

Change `unwrap`'s signature and 409 branch:

```ts
function unwrap<T>(body: unknown, status: number, conflictCode?: RequestOptions['conflictCode']): T {
  ...
  if (status === 409) {
    if (conflictCode) {
      throw new ApiError(
        409,
        conflictCode,
        detail ? scrubIdentifiers(detail) : 'The voice platform refused that request as a conflict.',
      );
    }
    throw new ApiError(409, 'NAME_TAKEN', 'That name is already in use. Choose another.');
  }
```

In `request`, destructure `conflictCode` and pass it: `return unwrap<T>(body_, response.status, conflictCode);`.

Append a new block at the end of the file:

```ts
/*
 * The supplier wallet.
 *
 * Every YE customer's calls are paid for out of one partner balance. These
 * are the reads and the one write behind the staff console's Platform wallet
 * page — see `routes/admin/wallet`. Nothing here is reachable from a customer
 * route, and nothing here must ever be: the link credits YE's wallet.
 */

export interface BalanceResponse {
  /** Decimal string or number, in display credits (₹). Read through `readBalanceInr`. */
  credits?: string | number;
  balance?: string | number;
  currency?: string;
}

export interface TopupConfigResponse {
  presets: number[];
  min: number;
  max: number;
  gst_rate_bps: number;
}

export interface TopupQuote {
  base: number;
  gst: number;
  total: number;
}

export interface TopupLink extends TopupQuote {
  payment_order_id: string;
  short_url: string;
  expires_at: string;
}

export type TopupLinkStatus = 'CREATED' | 'ATTEMPTED' | 'FAILED' | 'CREDITED' | 'EXPIRED' | 'MISMATCH';

export interface TopupLinkStatusResponse extends TopupQuote {
  payment_order_id: string;
  status: TopupLinkStatus;
  credited_at: string | null;
  created_at: string;
}

export function getBalance(): Promise<BalanceResponse> {
  return request<BalanceResponse>('/billing/balance');
}

export function getTopupConfig(): Promise<TopupConfigResponse> {
  return request<TopupConfigResponse>('/billing/topup/config');
}

/** Pure arithmetic upstream; 60 per hour. */
export function quoteTopup(amountRupees: number): Promise<TopupQuote> {
  return request<TopupQuote>('/billing/topup/quote', {
    method: 'POST',
    body: { amount_rupees: amountRupees },
  });
}

/** Mints a payment link; 10 per hour, at most 5 open. The amount must be a
 *  JSON number — a string is an upstream 400. */
export function createTopupLink(amountRupees: number): Promise<TopupLink> {
  return request<TopupLink>('/billing/topup/links', {
    method: 'POST',
    body: { amount_rupees: amountRupees },
    conflictCode: 'OPEN_ORDER_LIMIT',
  });
}

export function getTopupLink(paymentOrderId: string): Promise<TopupLinkStatusResponse> {
  return request<TopupLinkStatusResponse>(
    `/billing/topup/links/${encodeURIComponent(paymentOrderId)}`,
  );
}
```

**Step 4: Run tests**

Run: `npx vitest run test/vocobase-wallet-adapter.test.ts test/vocobase-adapter.test.ts`
Expected: PASS (the existing adapter suite proves the 409 default is untouched).

**Step 5: Commit**

```bash
git add src/lib/errors.ts src/adapter/vocobase.ts test/vocobase-wallet-adapter.test.ts
git commit -m "Read the supplier wallet and mint top-up links through the adapter"
```

---

### Task 2: Schema — `PlatformTopup`

**Files:**
- Modify: `prisma/schema.prisma` (append after `AnalyticsCursor`)
- Create: `prisma/migrations/20260907120000_platform_topups/migration.sql` (generated)
- Modify: `test/setup.ts` (`TABLES`)

**Step 1: Add the model**

```prisma
// ---------- the supplier wallet ----------

enum PlatformTopupStatus {
  CREATED
  ATTEMPTED
  FAILED
  CREDITED
  EXPIRED
  MISMATCH
}

/// A payment link minted against the supplier wallet, one row per link.
///
/// The supplier is the source of truth for status; this is the mirror the
/// staff console reads, so a reload or a second operator does not lose the
/// URL. No `createdBy`: staff auth is one shared token, and there is no
/// per-person identity to record.
model PlatformTopup {
  id             String              @id @default(uuid())
  /// The supplier's `payment_order_id`. What the console polls by.
  paymentOrderId String              @unique
  shortUrl       String
  /// Base: what lands in the wallet.
  amountRupees   Int
  gstRupees      Int
  /// What the payer is charged.
  totalRupees    Int
  status         PlatformTopupStatus @default(CREATED)
  expiresAt      DateTime
  creditedAt     DateTime?
  createdAt      DateTime            @default(now())
  updatedAt      DateTime            @updatedAt

  @@index([status, expiresAt])
}
```

**Step 2: Generate the migration against the local dev DB**

`DATABASE_URL` in `.env` is production. Point `migrate dev` at the test DB explicitly:

```bash
DATABASE_URL=$TEST_DATABASE_URL npx prisma migrate dev --name platform_topups
```

Expected: a new folder under `prisma/migrations/` with `CREATE TYPE "PlatformTopupStatus"` and `CREATE TABLE "PlatformTopup"`. Open it and confirm nothing else changed.

**Step 3: Add the table to the test reset**

In `test/setup.ts`, `TABLES`, add at the top with the other childless rows:

```ts
  'CallRecord',
  'AnalyticsCursor',
  // Nothing points at a top-up and it points at nothing; position is free.
  'PlatformTopup',
```

**Step 4: Verify**

Run: `npx prisma generate && npm run test:prepare && npx vitest run test/admin-overview.test.ts`
Expected: PASS (proves the reset still runs with the new table).

**Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations test/setup.ts
git commit -m "Mirror supplier top-up links in a PlatformTopup table"
```

---

### Task 3: Env — the low-balance threshold and poll period

**Files:**
- Modify: `src/lib/env.ts` (next to `agentSyncIntervalMs`)
- Modify: `.env.example` (after `AGENT_SYNC_INTERVAL_MS`)

**Step 1: Add to `env`**

```ts
  /**
   * The supplier wallet balance, in rupees, under which the staff console
   * says "critically low" on every page. Every campaign on the platform halts
   * on CREDIT_EXHAUSTED when it reaches zero, so the number is chosen to leave
   * time to top up, not to be exact.
   */
  walletLowBalanceInr: count('WALLET_LOW_BALANCE_INR', 25_000),
  /**
   * How often open payment links are re-read from the supplier. There is no
   * callback for a paid link; this and the console's own 30-second poll are
   * the only ways a payment becomes visible. Floored at thirty seconds.
   */
  walletTopupPollMs: count('WALLET_TOPUP_POLL_MS', 120_000, 30_000),
```

**Step 2: Document in `.env.example`**

```
# Supplier wallet balance (rupees) under which the staff console shows the
# "critically low" alert on every page. Whole number; 0 disables it.
WALLET_LOW_BALANCE_INR=25000

# How often open supplier payment links are re-read. A paid link only becomes
# CREDITED by polling; there is no callback. Floored at 30000.
WALLET_TOPUP_POLL_MS=120000
```

**Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: no errors.

**Step 4: Commit**

```bash
git add src/lib/env.ts .env.example
git commit -m "Add the wallet low-balance threshold and top-up poll period"
```

---

### Task 4: Service — `platformWallet`

**Files:**
- Create: `src/services/platformWallet.ts`
- Test: `test/platform-wallet.test.ts`

**Step 1: Write the failing test**

```ts
// test/platform-wallet.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/adapter/vocobase.js', () => ({
  getBalance: vi.fn(),
  getTopupConfig: vi.fn(),
  quoteTopup: vi.fn(),
  createTopupLink: vi.fn(),
  getTopupLink: vi.fn(),
}));

const { getBalance, getTopupLink, createTopupLink } = await import('../src/adapter/vocobase.js');
const { ApiError } = await import('../src/lib/errors.js');
const { prisma } = await import('../src/lib/prisma.js');
const { truncateAll } = await import('./setup.js');
const { createTopup, readWallet, refreshOpenTopups, refreshTopup } = await import(
  '../src/services/platformWallet.js'
);

const mockedBalance = vi.mocked(getBalance);
const mockedLink = vi.mocked(getTopupLink);
const mockedCreate = vi.mocked(createTopupLink);

const NOW = new Date('2026-09-07T10:00:00.000Z');
const LATER = new Date('2026-09-08T10:00:00.000Z');

async function row(overrides: Partial<Parameters<typeof prisma.platformTopup.create>[0]['data']> = {}) {
  return prisma.platformTopup.create({
    data: {
      paymentOrderId: `po_${Math.random().toString(36).slice(2)}`,
      shortUrl: 'https://rzp.io/i/abc',
      amountRupees: 5000,
      gstRupees: 900,
      totalRupees: 5900,
      expiresAt: LATER,
      ...overrides,
    },
  });
}

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('readWallet', () => {
  it('reads credits as rupees and flags low against the threshold', async () => {
    mockedBalance.mockResolvedValue({ credits: '18400.25' });
    await expect(readWallet(25_000)).resolves.toEqual({ balance_inr: 18400.25, low: true, threshold_inr: 25_000 });
  });

  it('is not low at exactly the threshold', async () => {
    mockedBalance.mockResolvedValue({ credits: 25_000 });
    await expect(readWallet(25_000)).resolves.toMatchObject({ low: false });
  });

  it('refuses a balance that is not a number rather than reporting zero', async () => {
    mockedBalance.mockResolvedValue({ credits: 'lots' });
    await expect(readWallet(25_000)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('createTopup', () => {
  it('writes the row from the link', async () => {
    mockedCreate.mockResolvedValue({
      payment_order_id: 'po_1', short_url: 'https://rzp.io/i/x', expires_at: LATER.toISOString(), base: 5000, gst: 900, total: 5900,
    });
    const created = await createTopup(5000);
    expect(created).toMatchObject({ paymentOrderId: 'po_1', amountRupees: 5000, gstRupees: 900, totalRupees: 5900, status: 'CREATED' });
    expect(mockedCreate).toHaveBeenCalledWith(5000);
  });
});

describe('refreshTopup', () => {
  it('leaves a terminal row alone without calling upstream', async () => {
    const r = await row({ status: 'CREDITED', creditedAt: NOW });
    await expect(refreshTopup(r, NOW)).resolves.toMatchObject({ status: 'CREDITED' });
    expect(mockedLink).not.toHaveBeenCalled();
  });

  it('marks a row past its expiry EXPIRED on our clock, without calling upstream', async () => {
    const r = await row({ expiresAt: new Date('2026-09-07T09:00:00.000Z') });
    await expect(refreshTopup(r, NOW)).resolves.toMatchObject({ status: 'EXPIRED' });
    expect(mockedLink).not.toHaveBeenCalled();
  });

  it('writes the live status and credited_at', async () => {
    const r = await row();
    mockedLink.mockResolvedValue({ payment_order_id: r.paymentOrderId, status: 'CREDITED', base: 5000, gst: 900, total: 5900, credited_at: '2026-09-07T09:59:00.000Z', created_at: '2026-09-07T09:00:00.000Z' });
    const out = await refreshTopup(r, NOW);
    expect(out.status).toBe('CREDITED');
    expect(out.creditedAt?.toISOString()).toBe('2026-09-07T09:59:00.000Z');
  });

  it('treats an upstream 404 as the link being gone', async () => {
    const r = await row();
    mockedLink.mockRejectedValue(new ApiError(404, 'RESOURCE_NOT_FOUND', 'Not found.'));
    await expect(refreshTopup(r, NOW)).resolves.toMatchObject({ status: 'EXPIRED' });
  });

  it('lets any other upstream failure propagate, leaving the row as it was', async () => {
    const r = await row();
    mockedLink.mockRejectedValue(new ApiError(502, 'UPSTREAM_ERROR', 'down'));
    await expect(refreshTopup(r, NOW)).rejects.toBeInstanceOf(ApiError);
    expect((await prisma.platformTopup.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('CREATED');
  });
});

describe('refreshOpenTopups', () => {
  it('refreshes only non-terminal rows and counts what changed', async () => {
    const open = await row();
    await row({ status: 'CREDITED', creditedAt: NOW });
    const stale = await row({ expiresAt: new Date('2026-09-07T09:00:00.000Z') });
    const broken = await row();
    mockedLink.mockImplementation(async (id) => {
      if (id === broken.paymentOrderId) throw new ApiError(502, 'UPSTREAM_ERROR', 'down');
      return { payment_order_id: id, status: 'CREDITED', base: 5000, gst: 900, total: 5900, credited_at: NOW.toISOString(), created_at: NOW.toISOString() };
    });

    await expect(refreshOpenTopups(NOW)).resolves.toEqual({ refreshed: 3, credited: 1, expired: 1, failed: 1 });
    expect(mockedLink).toHaveBeenCalledTimes(2);
    expect((await prisma.platformTopup.findUniqueOrThrow({ where: { id: open.id } })).status).toBe('CREDITED');
    expect((await prisma.platformTopup.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('EXPIRED');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/platform-wallet.test.ts`
Expected: FAIL — cannot find module `../src/services/platformWallet.js`.

**Step 3: Implement**

```ts
// src/services/platformWallet.ts
import type { PlatformTopup, PlatformTopupStatus } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { ApiError } from '../lib/errors.js';
import {
  createTopupLink,
  getBalance,
  getTopupLink,
  type TopupLinkStatus,
} from '../adapter/vocobase.js';

/**
 * The supplier wallet: what YE holds with the voice platform, and the payment
 * links minted against it.
 *
 * One property shapes everything here: **there is no callback.** A paid link
 * becomes CREDITED only because somebody re-read it — the console's own
 * 30-second poll while a page is open, or the maintenance job every couple of
 * minutes when nobody is looking. Both come through `refreshTopup`.
 */

export const TERMINAL_TOPUP_STATUSES: ReadonlySet<PlatformTopupStatus> = new Set([
  'CREDITED',
  'EXPIRED',
  'MISMATCH',
]);

export interface Wallet {
  balance_inr: number;
  low: boolean;
  threshold_inr: number;
}

function readBalanceInr(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) {
    // A wallet that reads ₹0 when the supplier answered nonsense is the one
    // answer this must never give: it is indistinguishable from empty.
    throw new ApiError(502, 'UPSTREAM_ERROR', 'The voice platform returned an unreadable balance.');
  }
  return parsed;
}

export async function readWallet(thresholdInr: number): Promise<Wallet> {
  const upstream = await getBalance();
  const balance = readBalanceInr(upstream.credits ?? upstream.balance);
  return { balance_inr: balance, low: balance < thresholdInr, threshold_inr: thresholdInr };
}

export async function createTopup(amountRupees: number): Promise<PlatformTopup> {
  const link = await createTopupLink(amountRupees);

  return prisma.platformTopup.create({
    data: {
      paymentOrderId: link.payment_order_id,
      shortUrl: link.short_url,
      amountRupees: link.base,
      gstRupees: link.gst,
      totalRupees: link.total,
      expiresAt: new Date(link.expires_at),
    },
  });
}

function isTerminal(status: PlatformTopupStatus): boolean {
  return TERMINAL_TOPUP_STATUSES.has(status);
}

/**
 * Brings one row up to date.
 *
 * Terminal rows are returned as they are. A row past its own `expiresAt` is
 * marked EXPIRED without asking upstream — the supplier flips that status on
 * an hourly sweep, so it can read CREATED for an hour after the link died,
 * and the guide says to stop on our clock. Everything else is read live.
 *
 * An upstream 404 means the link is gone on their side and there is nothing
 * left to poll, so it is recorded as EXPIRED. Any other failure propagates
 * and the row is left untouched: "we could not check" must not be written
 * down as a status.
 */
export async function refreshTopup(row: PlatformTopup, now = new Date()): Promise<PlatformTopup> {
  if (isTerminal(row.status)) return row;

  if (row.expiresAt.getTime() <= now.getTime()) {
    return prisma.platformTopup.update({ where: { id: row.id }, data: { status: 'EXPIRED' } });
  }

  let status: TopupLinkStatus;
  let creditedAt: Date | null;
  try {
    const live = await getTopupLink(row.paymentOrderId);
    status = live.status;
    creditedAt = live.credited_at ? new Date(live.credited_at) : null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      console.error(`[wallet] top-up ${row.paymentOrderId} is unknown upstream; marking expired.`);
      status = 'EXPIRED';
      creditedAt = null;
    } else {
      throw err;
    }
  }

  if (status === row.status && (creditedAt?.getTime() ?? null) === (row.creditedAt?.getTime() ?? null)) {
    return row;
  }

  return prisma.platformTopup.update({
    where: { id: row.id },
    data: { status, creditedAt },
  });
}

export interface RefreshSummary {
  refreshed: number;
  credited: number;
  expired: number;
  failed: number;
}

/** Every non-terminal row, refreshed in turn. At most five can be open. */
export async function refreshOpenTopups(now = new Date()): Promise<RefreshSummary> {
  const open = await prisma.platformTopup.findMany({
    where: { status: { notIn: [...TERMINAL_TOPUP_STATUSES] } },
    orderBy: { createdAt: 'asc' },
  });

  const summary: RefreshSummary = { refreshed: 0, credited: 0, expired: 0, failed: 0 };

  for (const row of open) {
    try {
      const next = await refreshTopup(row, now);
      summary.refreshed += 1;
      if (next.status === 'CREDITED') summary.credited += 1;
      if (next.status === 'EXPIRED') summary.expired += 1;
    } catch (err) {
      summary.failed += 1;
      console.error(`[wallet] could not refresh top-up ${row.paymentOrderId}:`, err);
    }
  }

  return summary;
}
```

**Step 4: Run tests**

Run: `npx vitest run test/platform-wallet.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/services/platformWallet.ts test/platform-wallet.test.ts
git commit -m "Add the platform wallet service: balance, link creation, and refresh"
```

---

### Task 5: Routes — `/api/admin/wallet`

**Files:**
- Create: `src/routes/admin/wallet.routes.ts`
- Modify: `src/routes/admin/index.ts` (import + `adminRoutes.use(adminWalletRoutes)`)
- Test: `test/admin-wallet.test.ts`

**Step 1: Write the failing test**

```ts
// test/admin-wallet.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../src/adapter/vocobase.js', () => ({
  getBalance: vi.fn(),
  getTopupConfig: vi.fn(),
  quoteTopup: vi.fn(),
  createTopupLink: vi.fn(),
  getTopupLink: vi.fn(),
}));

process.env.ADMIN_STAFF_TOKEN = 'staff-token-for-wallet-tests';
process.env.WALLET_LOW_BALANCE_INR = '25000';

const { getBalance, getTopupConfig, quoteTopup, createTopupLink, getTopupLink } = await import('../src/adapter/vocobase.js');
const { ApiError } = await import('../src/lib/errors.js');
const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { truncateAll } = await import('./setup.js');

const app = createApp();
const STAFF = ['X-Admin-Token', process.env.ADMIN_STAFF_TOKEN!] as const;
const LATER = '2026-12-31T10:00:00.000Z';

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('staff guard', () => {
  it.each([
    ['get', '/api/admin/wallet'],
    ['get', '/api/admin/wallet/topup-config'],
    ['post', '/api/admin/wallet/topup-quote'],
    ['post', '/api/admin/wallet/topups'],
    ['get', '/api/admin/wallet/topups'],
    ['get', '/api/admin/wallet/topups/po_1'],
  ] as const)('%s %s rejects a request without a token', async (method, path) => {
    const res = await request(app)[method](path);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/admin/wallet', () => {
  it('reports the balance, the threshold, and whether it is low', async () => {
    vi.mocked(getBalance).mockResolvedValue({ credits: '18400' });
    const res = await request(app).get('/api/admin/wallet').set(...STAFF);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ balance_inr: 18400, low: true, threshold_inr: 25000 });
  });

  it('is a 502 when the supplier does not answer, never a zero', async () => {
    vi.mocked(getBalance).mockRejectedValue(new ApiError(502, 'UPSTREAM_ERROR', 'down'));
    const res = await request(app).get('/api/admin/wallet').set(...STAFF);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_ERROR');
  });
});

describe('config and quote', () => {
  it('passes the config through', async () => {
    vi.mocked(getTopupConfig).mockResolvedValue({ presets: [1000, 5000], min: 1000, max: 400000, gst_rate_bps: 1800 });
    const res = await request(app).get('/api/admin/wallet/topup-config').set(...STAFF);
    expect(res.body.data).toEqual({ presets: [1000, 5000], min: 1000, max: 400000, gst_rate_bps: 1800 });
  });

  it('quotes a whole-rupee amount', async () => {
    vi.mocked(quoteTopup).mockResolvedValue({ base: 5000, gst: 900, total: 5900 });
    const res = await request(app).post('/api/admin/wallet/topup-quote').set(...STAFF).send({ amount_rupees: 5000 });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ base: 5000, gst: 900, total: 5900 });
    expect(quoteTopup).toHaveBeenCalledWith(5000);
  });

  it.each([['5000'], [5000.5], [-1], [null], [undefined]])(
    'refuses %j before any upstream call',
    async (amount) => {
      const res = await request(app).post('/api/admin/wallet/topup-quote').set(...STAFF).send({ amount_rupees: amount });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(quoteTopup).not.toHaveBeenCalled();
    },
  );
});

describe('POST /api/admin/wallet/topups', () => {
  it('mints a link, stores it, and answers 201 with the row', async () => {
    vi.mocked(createTopupLink).mockResolvedValue({ payment_order_id: 'po_1', short_url: 'https://rzp.io/i/x', expires_at: LATER, base: 5000, gst: 900, total: 5900 });
    const res = await request(app).post('/api/admin/wallet/topups').set(...STAFF).send({ amount_rupees: 5000 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      payment_order_id: 'po_1', short_url: 'https://rzp.io/i/x', amount_rupees: 5000, gst_rupees: 900, total_rupees: 5900,
      status: 'CREATED', expires_at: LATER, credited_at: null,
    });
    expect(await prisma.platformTopup.count()).toBe(1);
  });

  it('passes the open-link limit through as a 409 the console can act on', async () => {
    vi.mocked(createTopupLink).mockRejectedValue(new ApiError(409, 'OPEN_ORDER_LIMIT', '5 links are already open.'));
    const res = await request(app).post('/api/admin/wallet/topups').set(...STAFF).send({ amount_rupees: 5000 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OPEN_ORDER_LIMIT');
    expect(await prisma.platformTopup.count()).toBe(0);
  });

  it('refuses a string amount without calling upstream', async () => {
    const res = await request(app).post('/api/admin/wallet/topups').set(...STAFF).send({ amount_rupees: '5000' });
    expect(res.status).toBe(400);
    expect(createTopupLink).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/wallet/topups', () => {
  it('lists newest first and refreshes only the open rows', async () => {
    await prisma.platformTopup.create({ data: { paymentOrderId: 'po_old', shortUrl: 'u', amountRupees: 1000, gstRupees: 180, totalRupees: 1180, expiresAt: new Date(LATER), status: 'CREDITED', creditedAt: new Date(), createdAt: new Date('2026-09-01T00:00:00Z') } });
    await prisma.platformTopup.create({ data: { paymentOrderId: 'po_new', shortUrl: 'u', amountRupees: 5000, gstRupees: 900, totalRupees: 5900, expiresAt: new Date(LATER) } });
    vi.mocked(getTopupLink).mockResolvedValue({ payment_order_id: 'po_new', status: 'ATTEMPTED', base: 5000, gst: 900, total: 5900, credited_at: null, created_at: LATER });

    const res = await request(app).get('/api/admin/wallet/topups').set(...STAFF);
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { payment_order_id: string }) => r.payment_order_id)).toEqual(['po_new', 'po_old']);
    expect(res.body.data[0].status).toBe('ATTEMPTED');
    expect(getTopupLink).toHaveBeenCalledTimes(1);
  });

  it('still lists when the supplier is unreachable, with the last known status', async () => {
    await prisma.platformTopup.create({ data: { paymentOrderId: 'po_new', shortUrl: 'u', amountRupees: 5000, gstRupees: 900, totalRupees: 5900, expiresAt: new Date(LATER) } });
    vi.mocked(getTopupLink).mockRejectedValue(new ApiError(502, 'UPSTREAM_ERROR', 'down'));
    const res = await request(app).get('/api/admin/wallet/topups').set(...STAFF);
    expect(res.status).toBe(200);
    expect(res.body.data[0].status).toBe('CREATED');
  });
});

describe('GET /api/admin/wallet/topups/:id', () => {
  it('refreshes and returns one row', async () => {
    await prisma.platformTopup.create({ data: { paymentOrderId: 'po_1', shortUrl: 'u', amountRupees: 5000, gstRupees: 900, totalRupees: 5900, expiresAt: new Date(LATER) } });
    vi.mocked(getTopupLink).mockResolvedValue({ payment_order_id: 'po_1', status: 'CREDITED', base: 5000, gst: 900, total: 5900, credited_at: '2026-09-07T10:04:12.000Z', created_at: LATER });
    const res = await request(app).get('/api/admin/wallet/topups/po_1').set(...STAFF);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'CREDITED', credited_at: '2026-09-07T10:04:12.000Z' });
  });

  it('404s an id it has no row for', async () => {
    const res = await request(app).get('/api/admin/wallet/topups/po_none').set(...STAFF);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(getTopupLink).not.toHaveBeenCalled();
  });

  it('is a 502 when the refresh fails, not a stale 200', async () => {
    await prisma.platformTopup.create({ data: { paymentOrderId: 'po_1', shortUrl: 'u', amountRupees: 5000, gstRupees: 900, totalRupees: 5900, expiresAt: new Date(LATER) } });
    vi.mocked(getTopupLink).mockRejectedValue(new ApiError(502, 'UPSTREAM_ERROR', 'down'));
    const res = await request(app).get('/api/admin/wallet/topups/po_1').set(...STAFF);
    expect(res.status).toBe(502);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/admin-wallet.test.ts`
Expected: FAIL — the guard tests pass (404 ≠ 401, they actually fail too), everything else 404.

**Step 3: Implement**

```ts
// src/routes/admin/wallet.routes.ts
import { Router } from 'express';
import { z } from 'zod';
import type { PlatformTopup } from '@prisma/client';
import { requireStaffToken } from '../../middleware/adminToken.js';
import { asyncHandler, ApiError } from '../../lib/errors.js';
import { parseBody } from '../../lib/validate.js';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../lib/env.js';
import { getTopupConfig, quoteTopup } from '../../adapter/vocobase.js';
import {
  createTopup,
  readWallet,
  refreshTopup,
  TERMINAL_TOPUP_STATUSES,
} from '../../services/platformWallet.js';

/**
 * The supplier wallet, from the staff console.
 *
 * Staff-only for the reason the DID inventory and the webhook config are:
 * there is one partner account behind every YE customer, and a payment link
 * minted here credits *that* wallet. It is never a way to bill a customer —
 * their money would land in YE's balance and a chargeback on their card
 * would be charged back to YE. Nothing under `/api/workspaces` reaches any
 * of this.
 *
 * Deliberately separate from `/api/admin/accounts/:id/credits`, which moves
 * YE's own ledger. That is what YE's customers hold; this is what YE holds.
 */

export const adminWalletRoutes: Router = Router();

adminWalletRoutes.use(requireStaffToken);

/**
 * A whole number of rupees, as a JSON number. The supplier answers a string
 * amount with a 400 of its own; refusing it here means the console can never
 * send that shape, and the range check comes from upstream's config rather
 * than a copy that would drift.
 */
const amountSchema = z.object({
  amount_rupees: z.number().int().positive(),
});

const RECENT_TOPUPS = 20;

function serializeTopup(row: PlatformTopup) {
  return {
    payment_order_id: row.paymentOrderId,
    short_url: row.shortUrl,
    amount_rupees: row.amountRupees,
    gst_rupees: row.gstRupees,
    total_rupees: row.totalRupees,
    status: row.status,
    expires_at: row.expiresAt.toISOString(),
    credited_at: row.creditedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

adminWalletRoutes.get(
  '/wallet',
  asyncHandler(async (_req, res) => {
    res.json({ success: true, data: await readWallet(env.walletLowBalanceInr) });
  }),
);

adminWalletRoutes.get(
  '/wallet/topup-config',
  asyncHandler(async (_req, res) => {
    res.json({ success: true, data: await getTopupConfig() });
  }),
);

adminWalletRoutes.post(
  '/wallet/topup-quote',
  asyncHandler(async (req, res) => {
    const { amount_rupees } = parseBody(amountSchema, req.body);
    res.json({ success: true, data: await quoteTopup(amount_rupees) });
  }),
);

adminWalletRoutes.post(
  '/wallet/topups',
  asyncHandler(async (req, res) => {
    const { amount_rupees } = parseBody(amountSchema, req.body);
    // A 409 OPEN_ORDER_LIMIT from the adapter propagates as itself: the
    // console shows the open links rather than an error.
    const row = await createTopup(amount_rupees);
    res.status(201).json({ success: true, data: serializeTopup(row) });
  }),
);

/**
 * The recent links, each open one brought up to date.
 *
 * A refresh that fails leaves that row at its last known status and the
 * listing still renders: the page must not go blank because the supplier is
 * slow, and the last known status is a fact, not a guess.
 */
adminWalletRoutes.get(
  '/wallet/topups',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.platformTopup.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: RECENT_TOPUPS,
    });

    const fresh = await Promise.all(
      rows.map(async (row) => {
        if (TERMINAL_TOPUP_STATUSES.has(row.status)) return row;
        try {
          return await refreshTopup(row);
        } catch (err) {
          console.error(`[wallet] could not refresh top-up ${row.paymentOrderId}:`, err);
          return row;
        }
      }),
    );

    res.json({ success: true, data: fresh.map(serializeTopup) });
  }),
);

/**
 * One link, refreshed. This is what the console polls, so a failed refresh
 * is a failure here rather than a stale 200: the poller keeps its last known
 * state on its own and says the check failed.
 */
adminWalletRoutes.get(
  '/wallet/topups/:id',
  asyncHandler(async (req, res) => {
    const row = await prisma.platformTopup.findUnique({
      where: { paymentOrderId: String(req.params.id) },
    });
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'No such top-up.');

    res.json({ success: true, data: serializeTopup(await refreshTopup(row)) });
  }),
);
```

In `src/routes/admin/index.ts`: add `import { adminWalletRoutes } from './wallet.routes.js';` and `adminRoutes.use(adminWalletRoutes);` after the queue routes.

Check how `parseBody` reports a zod failure (`src/lib/validate.ts`): it must produce a 400 `VALIDATION_ERROR`. If it does, nothing else is needed.

**Step 4: Run tests**

Run: `npx vitest run test/admin-wallet.test.ts test/admin-auth.test.ts test/admin-rate-limit.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/routes/admin/wallet.routes.ts src/routes/admin/index.ts test/admin-wallet.test.ts
git commit -m "Serve the supplier wallet and top-up links to the staff console"
```

---

### Task 6: Maintenance job — poll open links every two minutes

**Files:**
- Modify: `src/lib/queue/types.ts` (`REPEATABLE_JOB_IDS`, `MaintenanceJobKind`)
- Modify: `src/lib/queue/repeatable.ts` (register the scheduler)
- Modify: `src/lib/queue/workers/maintenance.worker.ts` (`dispatch` case)
- Test: `test/queue-repeatable.test.ts` (extend), `test/maintenance-wallet-poll.test.ts`

**Step 1: Write the failing tests**

Add to `test/queue-repeatable.test.ts`, inside `describe('repeatable job registration')`:

```ts
  it('registers the wallet top-up poll on the maintenance queue', async () => {
    await registerRepeatableJobs();

    const keys = (await maintenanceQueue.getJobSchedulers()).map((s) => s.key);
    expect(keys).toContain('maintenance-wallet-topup-poll');
  });
```

New file:

```ts
// test/maintenance-wallet-poll.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/platformWallet.js', () => ({
  refreshOpenTopups: vi.fn(),
}));

const { refreshOpenTopups } = await import('../src/services/platformWallet.js');
const { dispatch } = await import('../src/lib/queue/workers/maintenance.worker.js');

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('the wallet top-up poll', () => {
  it('refreshes the open links', async () => {
    vi.mocked(refreshOpenTopups).mockResolvedValue({ refreshed: 0, credited: 0, expired: 0, failed: 0 });
    await dispatch('wallet-topup-poll');
    expect(refreshOpenTopups).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalled();
  });

  it('logs a line only when something changed', async () => {
    vi.mocked(refreshOpenTopups).mockResolvedValue({ refreshed: 2, credited: 1, expired: 0, failed: 1 });
    await dispatch('wallet-topup-poll');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('credited=1'));
  });
});
```

**Step 2: Run to verify they fail**

Run: `npx vitest run test/queue-repeatable.test.ts test/maintenance-wallet-poll.test.ts`
Expected: FAIL — no scheduler with that key; `dispatch` has no such case (TypeScript error or no call).

**Step 3: Implement**

`src/lib/queue/types.ts`:

```ts
export const REPEATABLE_JOB_IDS = {
  ...
  AGENT_SYNC: 'maintenance-agent-sync',
  WALLET_TOPUP_POLL: 'maintenance-wallet-topup-poll',
} as const;

export type MaintenanceJobKind =
  | 'schedule-scan'
  | 'did-renewal'
  | 'analytics-sync'
  | 'agent-sync'
  | 'wallet-topup-poll';
```

`src/lib/queue/repeatable.ts`, after the agent-sync registration:

```ts
  /**
   * Open supplier payment links, ungated.
   *
   * There is no callback for a paid link: it becomes CREDITED only because
   * something re-read it. This is what makes a link paid overnight show up
   * before anyone opens the console. It places no call and spends no credit,
   * and at most five links can be open, so a pass is at most five reads.
   */
  await maintenanceQueue.upsertJobScheduler(
    REPEATABLE_JOB_IDS.WALLET_TOPUP_POLL,
    { every: env.walletTopupPollMs },
    { data: { kind: 'wallet-topup-poll' } },
  );
```

`src/lib/queue/workers/maintenance.worker.ts`: import `refreshOpenTopups` from `'../../../services/platformWallet.js'` and add a case before the closing of `dispatch`:

```ts
    case 'wallet-topup-poll': {
      const { refreshed, credited, expired, failed } = await refreshOpenTopups();

      // Quiet unless something moved: a pass that finds nothing open is the
      // usual case and would bury the one line that says money landed.
      if (credited || expired || failed) {
        console.log(
          `[wallet] top-up poll: refreshed=${refreshed} credited=${credited} expired=${expired} failed=${failed}`,
        );
      }

      return;
    }
```

**Step 4: Run tests**

Run: `npx vitest run test/queue-repeatable.test.ts test/maintenance-wallet-poll.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

**Step 5: Commit**

```bash
git add src/lib/queue/types.ts src/lib/queue/repeatable.ts src/lib/queue/workers/maintenance.worker.ts test/queue-repeatable.test.ts test/maintenance-wallet-poll.test.ts
git commit -m "Poll open supplier payment links from the maintenance queue"
```

---

### Task 7: Backend docs

**Files:**
- Modify: `CLAUDE.md` — add a `### The supplier wallet` subsection under `## Credits & billing`, before `### Staff routes`; add the six routes to the staff routes table; add `maintenance` queue row note ("4 repeatables") in the queues table.

**Step 1: Write the section**

```markdown
### The supplier wallet

Everything above is YE's own ledger: what YE's customers hold. The
supplier wallet is what YE holds with the voice platform, and it is one
balance behind every customer. `src/services/platformWallet.ts` reads it and
mints Razorpay payment links against it through the platform's
`/billing/topup/*` endpoints; `src/routes/admin/wallet.routes.ts` serves that
to the staff console's Platform wallet page.

- **A link credits YE's wallet, only.** It is never a way to bill a customer.
  Nothing under `/api/workspaces` reaches any of this.
- **There is no callback.** A paid link becomes `CREDITED` because something
  re-read it: the console's own 30-second poll while the page is open, and
  the `wallet-topup-poll` maintenance job every `WALLET_TOPUP_POLL_MS`
  (default 2 minutes). `PlatformTopup` mirrors each link so a reload or a
  second operator does not lose the URL; the platform stays the source of
  truth for status.
- **Expiry is on our clock.** The platform flips `EXPIRED` on an hourly sweep,
  so a link can read `CREATED` for an hour after it died; `refreshTopup`
  marks a row past its own `expiresAt` without asking.
- **At most 5 links open.** The sixth is a `409 OPEN_ORDER_LIMIT`, passed
  through by name — the one upstream 409 that is not `NAME_TAKEN` — so the
  console shows the open links instead of an error.
- **`WALLET_LOW_BALANCE_INR`** (default 25000) is the balance under which
  `GET /api/admin/wallet` says `low: true`, and the console shows "critically
  low" on every page. Every campaign halts on `CREDIT_EXHAUSTED` at zero.
- A balance the platform reports as anything but a finite number is a 502,
  never `₹0`: empty and unreadable must not look alike.
```

Routes table rows:

```markdown
| `GET /api/admin/wallet` | supplier balance in ₹, the low threshold, and `low` |
| `GET /api/admin/wallet/topup-config` | presets, min, max, GST rate, from the platform |
| `POST /api/admin/wallet/topup-quote` | `{ amount_rupees }` → `{ base, gst, total }` |
| `POST /api/admin/wallet/topups` | mints a payment link; `201` with the row; `409 OPEN_ORDER_LIMIT` when five are open |
| `GET /api/admin/wallet/topups` | 20 most recent links, open ones refreshed |
| `GET /api/admin/wallet/topups/:id` | one link by `payment_order_id`, refreshed; what the console polls |
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "Document the supplier wallet and its staff routes"
```

---

### Task 8: Backend full suite and push

**Step 1: Run the whole suite**

Run: `npm run test:ci`
Expected: only the 16 known env-only failures. Anything else is yours to fix.

**Step 2: Push and open the PR**

```bash
git push -u origin feat/platform-wallet
gh pr create --title "Platform wallet: balance, low-balance flag, and top-up links for the staff console" --body "$(cat <<'EOF'
Staff-only surface for the supplier wallet: balance with a low-balance flag (WALLET_LOW_BALANCE_INR, default 25000), Razorpay payment links minted through the platform's /billing/topup endpoints, a PlatformTopup mirror, and a 2-minute maintenance poll so a paid link becomes CREDITED without anyone watching.

Design: docs/plans/2026-09-07-platform-wallet-topup-design.md

New env: WALLET_LOW_BALANCE_INR, WALLET_TOPUP_POLL_MS (both defaulted). Migration: platform_topups (one new table, no existing table touched).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Part B: ye-voice-admin

Work in `.worktrees/platform-wallet/ye-voice-admin`. Run `npm test` and `npm run lint` after each task; `npx tsc --noEmit` before the last commit.

### Task 9: Types and server actions

**Files:**
- Modify: `lib/types.ts` (append)
- Modify: `lib/api.ts` (`ApiErrorCode` gains `'OPEN_ORDER_LIMIT'`)
- Create: `app/(console)/wallet/actions.ts`
- Test: `test/wallet-actions.test.ts`

**Step 1: Write the failing test**

```ts
// test/wallet-actions.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { ApiError } = await import('@/lib/api');
const { createTopup, pollTopup, quoteTopup } = await import('@/app/(console)/wallet/actions');

beforeEach(() => apiFetch.mockReset());

describe('quoteTopup', () => {
  it('returns the quote', async () => {
    apiFetch.mockResolvedValue({ base: 5000, gst: 900, total: 5900 });
    await expect(quoteTopup(5000)).resolves.toEqual({ ok: true, quote: { base: 5000, gst: 900, total: 5900 } });
    expect(apiFetch).toHaveBeenCalledWith('/api/admin/wallet/topup-quote', { method: 'POST', body: { amount_rupees: 5000 } });
  });
});

describe('createTopup', () => {
  it('names the open-link limit rather than reporting a generic failure', async () => {
    apiFetch.mockRejectedValue(new ApiError('OPEN_ORDER_LIMIT', '5 links are already open.', 409));
    await expect(createTopup(5000)).resolves.toEqual({ ok: false, code: 'OPEN_ORDER_LIMIT', message: '5 links are already open.' });
  });

  it('returns the row on success', async () => {
    apiFetch.mockResolvedValue({ payment_order_id: 'po_1', status: 'CREATED' });
    await expect(createTopup(5000)).resolves.toMatchObject({ ok: true, topup: { payment_order_id: 'po_1' } });
  });
});

describe('pollTopup', () => {
  it('reports a failed check as a failure with a message, not a throw', async () => {
    apiFetch.mockRejectedValue(new ApiError('UPSTREAM_ERROR', 'down', 502));
    await expect(pollTopup('po_1')).resolves.toMatchObject({ ok: false, code: 'UPSTREAM_ERROR' });
  });
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run test/wallet-actions.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement**

`lib/api.ts`: add `| 'OPEN_ORDER_LIMIT'` to `ApiErrorCode`.

`lib/types.ts`, append:

```ts
/** The supplier wallet — what YE holds with the voice platform. Rupees as
 *  numbers here: the platform reports whole rupees and there is no ledger
 *  arithmetic on this console for it. */
export interface Wallet {
  balance_inr: number;
  low: boolean;
  threshold_inr: number;
}

export interface TopupConfig {
  presets: number[];
  min: number;
  max: number;
  gst_rate_bps: number;
}

export interface TopupQuote {
  base: number;
  gst: number;
  total: number;
}

export type TopupStatus = 'CREATED' | 'ATTEMPTED' | 'FAILED' | 'CREDITED' | 'EXPIRED' | 'MISMATCH';

export const TERMINAL_TOPUP_STATUSES: ReadonlyArray<TopupStatus> = ['CREDITED', 'EXPIRED', 'MISMATCH'];

export interface TopupRow {
  payment_order_id: string;
  short_url: string;
  amount_rupees: number;
  gst_rupees: number;
  total_rupees: number;
  status: TopupStatus;
  expires_at: string;
  credited_at: string | null;
  created_at: string;
  updated_at: string;
}
```

`app/(console)/wallet/actions.ts`:

```ts
'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError, segment, UnauthorizedError } from '@/lib/api';
import { userMessage } from '@/lib/errors';
import type { TopupQuote, TopupRow } from '@/lib/types';

/**
 * The three calls the wallet page's client components make.
 *
 * Server actions rather than route handlers so the staff token stays in the
 * cookie and on the server: the browser sees a quote, a link, and a status,
 * and never the credential that fetched them.
 */

export type Failure = { ok: false; code: string; message: string };

function failure(err: unknown, fallback: string): Failure {
  if (err instanceof UnauthorizedError) {
    return { ok: false, code: 'UNAUTHORIZED', message: 'Your session has expired. Sign in again.' };
  }
  if (err instanceof ApiError) {
    return { ok: false, code: err.code, message: userMessage(err, fallback) };
  }
  throw err;
}

export async function quoteTopup(amountRupees: number): Promise<{ ok: true; quote: TopupQuote } | Failure> {
  try {
    const quote = await apiFetch<TopupQuote>('/api/admin/wallet/topup-quote', {
      method: 'POST',
      body: { amount_rupees: amountRupees },
    });
    return { ok: true, quote };
  } catch (err) {
    return failure(err, 'The amount could not be quoted.');
  }
}

export async function createTopup(amountRupees: number): Promise<{ ok: true; topup: TopupRow } | Failure> {
  try {
    const topup = await apiFetch<TopupRow>('/api/admin/wallet/topups', {
      method: 'POST',
      body: { amount_rupees: amountRupees },
    });
    revalidatePath('/wallet');
    return { ok: true, topup };
  } catch (err) {
    return failure(err, 'The voice platform could not create the link. Try again in a moment.');
  }
}

export async function pollTopup(paymentOrderId: string): Promise<{ ok: true; topup: TopupRow } | Failure> {
  try {
    const topup = await apiFetch<TopupRow>(`/api/admin/wallet/topups/${segment(paymentOrderId)}`);
    if (topup.status === 'CREDITED') {
      // The balance tile and the banner read the wallet on render.
      revalidatePath('/wallet');
      revalidatePath('/', 'layout');
    }
    return { ok: true, topup };
  } catch (err) {
    return failure(err, 'The status check failed. The last known status is shown.');
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run test/wallet-actions.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add lib/types.ts lib/api.ts "app/(console)/wallet/actions.ts" test/wallet-actions.test.ts
git commit -m "Add the wallet types and the quote, create, and poll actions"
```

---

### Task 10: Rupee formatting

**Files:**
- Modify: `lib/format.ts` (append)
- Modify: `test/format.test.ts` (append)

**Step 1: Test**

```ts
describe('rupees', () => {
  it('formats whole rupees with Indian grouping and the symbol', () => {
    expect(rupees(400000)).toBe('₹4,00,000');
    expect(rupees(5900)).toBe('₹5,900');
    expect(rupees(0)).toBe('₹0');
  });

  it('keeps paise only when present', () => {
    expect(rupees(18400.25)).toBe('₹18,400.25');
  });
});
```

Import `rupees` at the top of the test file.

**Step 2: Run** — Expected: FAIL, `rupees` is not exported.

**Step 3: Implement**

```ts
/**
 * A rupee amount for the wallet page. Indian grouping (₹4,00,000), paise
 * only when the value has them. Numbers here come from the platform as whole
 * rupees or a balance with paise; there is no ledger arithmetic on them.
 */
export function rupees(value: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
}
```

**Step 4: Run** — `npx vitest run test/format.test.ts` — PASS.

**Step 5: Commit**

```bash
git add lib/format.ts test/format.test.ts
git commit -m "Format rupee amounts with Indian grouping"
```

---

### Task 11: `<LowBalanceBanner>` on every console page

**Files:**
- Create: `components/shell/low-balance-banner.tsx`
- Create: `lib/wallet.ts` (server-only tolerant read)
- Modify: `app/(console)/layout.tsx`
- Test: `test/low-balance-banner.test.tsx`

**Step 1: Test**

```tsx
// test/low-balance-banner.test.tsx
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LowBalanceBanner } from '@/components/shell/low-balance-banner';

afterEach(cleanup);

describe('the low-balance banner', () => {
  it('says the balance and the threshold in words, and links to the wallet', () => {
    render(<LowBalanceBanner wallet={{ balance_inr: 18400, low: true, threshold_inr: 25000 }} />);
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('Platform wallet is critically low');
    expect(banner).toHaveTextContent('₹18,400');
    expect(banner).toHaveTextContent('₹25,000');
    expect(screen.getByRole('link', { name: /add money/i })).toHaveAttribute('href', '/wallet');
  });

  it('renders nothing when the wallet is not low', () => {
    const { container } = render(<LowBalanceBanner wallet={{ balance_inr: 90000, low: false, threshold_inr: 25000 }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the wallet could not be read', () => {
    const { container } = render(<LowBalanceBanner wallet={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

**Step 2: Run** — FAIL, module not found.

**Step 3: Implement**

```tsx
// components/shell/low-balance-banner.tsx
import Link from 'next/link';
import { rupees } from '@/lib/format';
import type { Wallet } from '@/lib/types';

/**
 * The one thing the console says on every page.
 *
 * Every campaign on the platform halts on CREDIT_EXHAUSTED when the supplier
 * wallet reaches zero, and nothing on any other page hints that it is
 * approaching. Rendered only when the API says `low`; a wallet that could not
 * be read renders nothing, because a banner about a balance we do not know is
 * a guess, and the page beneath it still has to work.
 */
export function LowBalanceBanner({ wallet }: { wallet: Wallet | null }) {
  if (!wallet?.low) return null;

  return (
    <div
      role="alert"
      className="mb-5 flex flex-wrap items-center justify-between gap-3 border border-[var(--danger)]/40 bg-[var(--surface)] px-4 py-2.5 text-[13px]"
    >
      <p>
        <span className="font-semibold text-[var(--danger)]">Platform wallet is critically low.</span>{' '}
        {rupees(wallet.balance_inr)} remains, under the {rupees(wallet.threshold_inr)} floor. Every
        campaign halts when it reaches zero.
      </p>
      <Link href="/wallet" className="font-medium text-[var(--accent)] underline-offset-2 hover:underline">
        Add money
      </Link>
    </div>
  );
}
```

```ts
// lib/wallet.ts
import 'server-only';

import { staffFetch } from '@/lib/staff';
import { UnauthorizedError } from '@/lib/api';
import type { Wallet } from '@/lib/types';

/**
 * The wallet, tolerated as unreadable.
 *
 * For the banner and the balance tile only. A supplier that does not answer,
 * or an API that does not serve the route yet, is `null` here — the page
 * beneath still renders. A rejected token is the one failure that is not
 * tolerated, because `staffFetch` turns it into the login screen.
 */
export async function readWalletOrNull(): Promise<Wallet | null> {
  try {
    return await staffFetch<Wallet>('/api/admin/wallet');
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    console.error('[wallet] could not read the supplier balance:', err);
    return null;
  }
}
```

`app/(console)/layout.tsx`:

```tsx
import { EnvironmentBadge } from '@/components/shell/environment-badge';
import { LowBalanceBanner } from '@/components/shell/low-balance-banner';
import { Sidebar } from '@/components/shell/sidebar';
import { readWalletOrNull } from '@/lib/wallet';

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const wallet = await readWalletOrNull();

  return (
    <div className="flex min-h-screen">
      <Sidebar badge={<EnvironmentBadge />} />
      <main className="min-w-0 flex-1 px-7 py-6">
        <LowBalanceBanner wallet={wallet} />
        {children}
      </main>
    </div>
  );
}
```

Note: `staffFetch` calls `redirect()` on a 401, which throws a Next redirect error. That must propagate; `readWalletOrNull` catches only non-Unauthorized errors, but `redirect` throws *inside* `staffFetch` before it returns. Check that `redirect`'s thrown error is not swallowed: re-throw anything whose `digest` starts with `NEXT_REDIRECT`:

```ts
    if (err instanceof UnauthorizedError) throw err;
    if (typeof (err as { digest?: string }).digest === 'string' && (err as { digest: string }).digest.startsWith('NEXT_REDIRECT')) throw err;
```

**Step 4: Run** — `npx vitest run test/low-balance-banner.test.tsx && npm run lint` — PASS.

**Step 5: Commit**

```bash
git add components/shell/low-balance-banner.tsx lib/wallet.ts "app/(console)/layout.tsx" test/low-balance-banner.test.tsx
git commit -m "Warn on every console page when the supplier wallet is critically low"
```

---

### Task 12: `<TopupForm>` — presets, quote line, create, open-link list

**Files:**
- Create: `app/(console)/wallet/topup-form.tsx`
- Test: `test/topup-form.test.tsx`

**Step 1: Test**

```tsx
// test/topup-form.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const quoteTopup = vi.fn();
const createTopup = vi.fn();
vi.mock('@/app/(console)/wallet/actions', () => ({
  quoteTopup: (...a: unknown[]) => quoteTopup(...a),
  createTopup: (...a: unknown[]) => createTopup(...a),
}));

const { TopupForm } = await import('@/app/(console)/wallet/topup-form');

const config = { presets: [1000, 5000], min: 1000, max: 400000, gst_rate_bps: 1800 };
const openLink = {
  payment_order_id: 'po_open', short_url: 'https://rzp.io/i/open', amount_rupees: 1000, gst_rupees: 180, total_rupees: 1180,
  status: 'CREATED' as const, expires_at: '2026-12-31T10:00:00.000Z', credited_at: null, created_at: '2026-09-07T10:00:00.000Z', updated_at: '2026-09-07T10:00:00.000Z',
};

beforeEach(() => {
  vi.useFakeTimers();
  quoteTopup.mockResolvedValue({ ok: true, quote: { base: 5000, gst: 900, total: 5900 } });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  quoteTopup.mockReset();
  createTopup.mockReset();
});

const amount = () => screen.getByLabelText(/amount/i);

describe('the top-up form', () => {
  it('fills the amount from a preset and quotes it after a pause', async () => {
    const onCreated = vi.fn();
    render(<TopupForm config={config} openLinks={[]} onCreated={onCreated} />);

    fireEvent.click(screen.getByRole('button', { name: '₹5,000' }));
    expect(amount()).toHaveValue(5000);
    expect(quoteTopup).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(300); });
    await waitFor(() => expect(quoteTopup).toHaveBeenCalledWith(5000));
    expect(screen.getByText(/payer is charged ₹5,900/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create ₹5,900 payment link/i })).toBeEnabled();
  });

  it('states the range instead of quoting an amount outside it', async () => {
    render(<TopupForm config={config} openLinks={[]} onCreated={vi.fn()} />);
    fireEvent.change(amount(), { target: { value: '500' } });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(quoteTopup).not.toHaveBeenCalled();
    expect(screen.getByText(/between ₹1,000 and ₹4,00,000/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create/i })).toBeDisabled();
  });

  it('hands the created link up', async () => {
    const onCreated = vi.fn();
    createTopup.mockResolvedValue({ ok: true, topup: { ...openLink, payment_order_id: 'po_new', amount_rupees: 5000 } });
    render(<TopupForm config={config} openLinks={[]} onCreated={onCreated} />);
    fireEvent.click(screen.getByRole('button', { name: '₹5,000' }));
    await act(async () => { vi.advanceTimersByTime(300); });
    await waitFor(() => screen.getByRole('button', { name: /create ₹5,900 payment link/i }));
    fireEvent.click(screen.getByRole('button', { name: /create ₹5,900 payment link/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ payment_order_id: 'po_new' })));
  });

  it('shows the open links on OPEN_ORDER_LIMIT rather than an error', async () => {
    createTopup.mockResolvedValue({ ok: false, code: 'OPEN_ORDER_LIMIT', message: '5 links are already open.' });
    render(<TopupForm config={config} openLinks={[openLink]} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '₹5,000' }));
    await act(async () => { vi.advanceTimersByTime(300); });
    await waitFor(() => screen.getByRole('button', { name: /create ₹5,900 payment link/i }));
    fireEvent.click(screen.getByRole('button', { name: /create ₹5,900 payment link/i }));
    await waitFor(() => screen.getByText(/five payment links open/i));
    expect(screen.getByRole('link', { name: /pay ₹1,180/i })).toHaveAttribute('href', 'https://rzp.io/i/open');
  });
});
```

**Step 2: Run** — FAIL, module not found.

**Step 3: Implement**

```tsx
// app/(console)/wallet/topup-form.tsx
'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button, FieldError, Input, Label } from '@/components/ui/primitives';
import { date, rupees } from '@/lib/format';
import type { TopupConfig, TopupQuote, TopupRow } from '@/lib/types';
import { createTopup, quoteTopup } from './actions';

const QUOTE_DEBOUNCE_MS = 300;

/**
 * Add money to the supplier wallet.
 *
 * The consequence is stated before the click, as everywhere on this console:
 * the button names the amount the payer will be charged, and the line above
 * it says what lands in the wallet. Those are different numbers — GST is
 * charged on top and not credited — and a form that showed only one of them
 * would have somebody paying ₹5,900 to see ₹5,000 arrive and calling it a bug.
 *
 * The quote is upstream's arithmetic, debounced: the platform allows sixty
 * an hour, and a quote per keystroke would spend that on one amount.
 */
export function TopupForm({
  config,
  openLinks,
  onCreated,
}: {
  config: TopupConfig;
  /** Links already open, for the moment the platform refuses a sixth. */
  openLinks: TopupRow[];
  onCreated: (topup: TopupRow) => void;
}) {
  const [amount, setAmount] = useState<number | ''>('');
  const [quote, setQuote] = useState<TopupQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const inRange = typeof amount === 'number' && Number.isInteger(amount) && amount >= config.min && amount <= config.max;
  const rangeLine = `Enter a whole amount between ${rupees(config.min)} and ${rupees(config.max)}.`;

  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
    if (!inRange) return;

    const handle = setTimeout(async () => {
      const result = await quoteTopup(amount as number);
      if (result.ok) setQuote(result.quote);
      else setQuoteError(result.message);
    }, QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [amount, inRange]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!inRange || !quote || submitting) return;
    setSubmitting(true);
    setError(null);
    setLimitHit(false);

    const result = await createTopup(amount as number);
    setSubmitting(false);

    if (result.ok) {
      onCreated(result.topup);
      return;
    }
    if (result.code === 'OPEN_ORDER_LIMIT') {
      setLimitHit(true);
      return;
    }
    setError(result.message);
  }

  return (
    <form onSubmit={submit} className="space-y-4" aria-label="Add money">
      <p className="text-[13px] text-[var(--text-muted)]">
        The link credits YE&apos;s platform wallet. Do not send it to a customer — their
        payment would land here, and a chargeback on their card is charged back to YE.
      </p>

      <div className="flex flex-wrap gap-2">
        {config.presets.map((preset) => (
          <Button key={preset} type="button" variant={amount === preset ? 'primary' : 'secondary'} size="sm" onClick={() => setAmount(preset)}>
            {rupees(preset)}
          </Button>
        ))}
      </div>

      <div className="max-w-xs">
        <Label htmlFor="topup-amount">Amount (₹)</Label>
        <Input
          id="topup-amount"
          type="number"
          inputMode="numeric"
          min={config.min}
          max={config.max}
          step={1}
          value={amount}
          onChange={(event) => setAmount(event.target.value === '' ? '' : Number(event.target.value))}
        />
        {amount !== '' && !inRange ? <FieldError>{rangeLine}</FieldError> : null}
        {quoteError ? <FieldError>{quoteError}</FieldError> : null}
      </div>

      {quote ? (
        <p className="text-[13px]">
          Payer is charged <strong>{rupees(quote.total)}</strong> ({rupees(quote.base)} + {rupees(quote.gst)} GST).{' '}
          <strong>{rupees(quote.base)}</strong> is added to the wallet.
        </p>
      ) : null}

      {limitHit ? (
        <div role="status" className="space-y-2 border border-[var(--warning)]/40 bg-[var(--warning-soft)] p-3 text-[13px]">
          <p>
            The platform already has five payment links open, which is its limit. Pay one of
            them, or wait for one to expire.
          </p>
          <ul className="space-y-1">
            {openLinks.map((link) => (
              <li key={link.payment_order_id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {rupees(link.amount_rupees)} to the wallet · expires {date(link.expires_at)}
                </span>
                <a href={link.short_url} target="_blank" rel="noreferrer" className="font-medium text-[var(--accent)] hover:underline">
                  Pay {rupees(link.total_rupees)}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? <FieldError>{error}</FieldError> : null}

      <Button type="submit" variant="primary" disabled={!inRange || !quote || submitting} loading={submitting}>
        {quote ? `Create ${rupees(quote.total)} payment link` : 'Create payment link'}
      </Button>
    </form>
  );
}
```

Check `Button`'s `size` prop values in `components/ui/primitives.tsx` (`SIZES`) and use an existing one; check `date()` returns a string for an ISO input.

**Step 4: Run** — `npx vitest run test/topup-form.test.tsx && npm run lint` — PASS.

**Step 5: Commit**

```bash
git add "app/(console)/wallet/topup-form.tsx" test/topup-form.test.tsx
git commit -m "Add the top-up form: presets, a live quote, and the open-link list"
```

---

### Task 13: `<TopupWatch>` — the link view that polls

**Files:**
- Create: `app/(console)/wallet/topup-watch.tsx`
- Test: `test/topup-watch.test.tsx`

**Step 1: Test**

```tsx
// test/topup-watch.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const pollTopup = vi.fn();
vi.mock('@/app/(console)/wallet/actions', () => ({ pollTopup: (...a: unknown[]) => pollTopup(...a) }));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const { TopupWatch } = await import('@/app/(console)/wallet/topup-watch');

const base = {
  payment_order_id: 'po_1', short_url: 'https://rzp.io/i/x', amount_rupees: 5000, gst_rupees: 900, total_rupees: 5900,
  status: 'CREATED' as const, expires_at: '2099-01-01T00:00:00.000Z', credited_at: null, created_at: '2026-09-07T10:00:00.000Z', updated_at: '2026-09-07T10:00:00.000Z',
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); pollTopup.mockReset(); refresh.mockReset(); });

describe('watching a payment link', () => {
  it('shows the link and polls every 30 seconds while open', async () => {
    pollTopup.mockResolvedValue({ ok: true, topup: { ...base, status: 'ATTEMPTED' } });
    render(<TopupWatch initial={base} onReset={vi.fn()} />);
    expect(screen.getByRole('link', { name: /open payment page/i })).toHaveAttribute('href', base.short_url);
    expect(screen.getByText('Created')).toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(30_000); });
    await waitFor(() => expect(pollTopup).toHaveBeenCalledWith('po_1'));
    expect(screen.getByText('Attempted')).toBeInTheDocument();
  });

  it('says the money landed on CREDITED and refreshes the page', async () => {
    pollTopup.mockResolvedValue({ ok: true, topup: { ...base, status: 'CREDITED', credited_at: '2026-09-07T10:04:12.000Z' } });
    render(<TopupWatch initial={base} onReset={vi.fn()} />);
    await act(async () => { vi.advanceTimersByTime(30_000); });
    await waitFor(() => screen.getByText(/₹5,000 added to the wallet/i));
    expect(refresh).toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(pollTopup).toHaveBeenCalledTimes(1);
  });

  it('stops on its own clock once the link has expired', async () => {
    render(<TopupWatch initial={{ ...base, expires_at: '2000-01-01T00:00:00.000Z' }} onReset={vi.fn()} />);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(pollTopup).not.toHaveBeenCalled();
    expect(screen.getByText(/expired/i)).toBeInTheDocument();
  });

  it('names the support address and the id on MISMATCH', () => {
    render(<TopupWatch initial={{ ...base, status: 'MISMATCH' }} onReset={vi.fn()} />);
    expect(screen.getByText(/support@vocobase.com/)).toBeInTheDocument();
    expect(screen.getByText(/po_1/)).toBeInTheDocument();
  });

  it('keeps the last known state and says the check failed', async () => {
    pollTopup.mockResolvedValue({ ok: false, code: 'UPSTREAM_ERROR', message: 'The status check failed.' });
    render(<TopupWatch initial={base} onReset={vi.fn()} />);
    await act(async () => { vi.advanceTimersByTime(30_000); });
    await waitFor(() => screen.getByText(/status check failed/i));
    expect(screen.getByText('Created')).toBeInTheDocument();
  });

  it('offers a new link from a terminal state', () => {
    const onReset = vi.fn();
    render(<TopupWatch initial={{ ...base, status: 'EXPIRED' }} onReset={onReset} />);
    fireEvent.click(screen.getByRole('button', { name: /create a new link/i }));
    expect(onReset).toHaveBeenCalled();
  });
});
```

**Step 2: Run** — FAIL, module not found.

**Step 3: Implement**

```tsx
// app/(console)/wallet/topup-watch.tsx
'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button, Input } from '@/components/ui/primitives';
import { StatusPill, type Tone } from '@/components/ui/status-pill';
import { date, rupees } from '@/lib/format';
import { TERMINAL_TOPUP_STATUSES, type TopupRow, type TopupStatus } from '@/lib/types';
import { pollTopup } from './actions';

const POLL_MS = 30_000;

const STATUS: Record<TopupStatus, { label: string; tone: Tone }> = {
  CREATED: { label: 'Created', tone: 'neutral' },
  ATTEMPTED: { label: 'Attempted', tone: 'accent' },
  FAILED: { label: 'Payment failed — can retry', tone: 'warning' },
  CREDITED: { label: 'Credited', tone: 'positive' },
  EXPIRED: { label: 'Expired', tone: 'danger' },
  MISMATCH: { label: 'Amount mismatch', tone: 'danger' },
};

/**
 * One payment link, watched until it settles.
 *
 * There is no callback from the platform, so this polls — every thirty
 * seconds, and only while the link is open and unexpired *on our clock*. The
 * platform marks expiry on an hourly sweep, so a link can read CREATED for an
 * hour after it died; the guide says to stop on `expires_at`, and this does.
 *
 * A failed check keeps the last known state and says so. It does not stop:
 * the next tick may succeed, and a page that gave up would need reloading to
 * find out the money had landed.
 */
export function TopupWatch({ initial, onReset }: { initial: TopupRow; onReset: () => void }) {
  const router = useRouter();
  const [topup, setTopup] = useState(initial);
  const [checkFailed, setCheckFailed] = useState<string | null>(null);

  const expired = new Date(topup.expires_at).getTime() <= Date.now();
  const terminal = TERMINAL_TOPUP_STATUSES.includes(topup.status);
  const shown: TopupStatus = !terminal && expired ? 'EXPIRED' : topup.status;

  useEffect(() => {
    if (terminal || expired) return;

    const handle = setInterval(async () => {
      const result = await pollTopup(topup.payment_order_id);
      if (!result.ok) {
        setCheckFailed(result.message);
        return;
      }
      setCheckFailed(null);
      setTopup(result.topup);
      if (result.topup.status === 'CREDITED') router.refresh();
    }, POLL_MS);

    return () => clearInterval(handle);
  }, [topup.payment_order_id, topup.status, topup.expires_at, terminal, expired, router]);

  return (
    <div className="space-y-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-3">
        <StatusPill tone={STATUS[shown].tone}>{STATUS[shown].label}</StatusPill>
        <span className="text-[var(--text-muted)]">
          {rupees(topup.amount_rupees)} to the wallet · payer is charged {rupees(topup.total_rupees)} · expires {date(topup.expires_at)}
        </span>
      </div>

      {shown === 'CREDITED' ? (
        <p role="status" className="font-medium text-[var(--success)]">
          {rupees(topup.amount_rupees)} added to the wallet
          {topup.credited_at ? ` on ${date(topup.credited_at)}` : ''}.
        </p>
      ) : null}
      {shown === 'EXPIRED' ? (
        <p>This link has expired or was cancelled. Nothing was charged. Create a new one.</p>
      ) : null}
      {shown === 'MISMATCH' ? (
        <p>
          The platform received an amount that does not match this link. Nothing was credited.
          Contact support@vocobase.com and quote <code>{topup.payment_order_id}</code>.
        </p>
      ) : null}
      {shown === 'FAILED' ? (
        <p>A payment attempt failed. The same link can be paid again.</p>
      ) : null}

      {!terminal && !expired ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input readOnly value={topup.short_url} aria-label="Payment link" className="max-w-sm" onFocus={(e) => e.currentTarget.select()} />
          <Button type="button" size="sm" onClick={() => navigator.clipboard?.writeText(topup.short_url)}>
            Copy
          </Button>
          <a href={topup.short_url} target="_blank" rel="noreferrer" className="font-medium text-[var(--accent)] hover:underline">
            Open payment page
          </a>
          <span className="text-[var(--text-faint)]">Checked every 30 seconds.</span>
        </div>
      ) : null}

      {checkFailed ? <p className="text-[var(--warning)]">{checkFailed}</p> : null}

      {terminal || expired ? (
        <Button type="button" variant="secondary" onClick={onReset}>
          Create a new link
        </Button>
      ) : null}
    </div>
  );
}
```

**Step 4: Run** — `npx vitest run test/topup-watch.test.tsx && npm run lint` — PASS.

**Step 5: Commit**

```bash
git add "app/(console)/wallet/topup-watch.tsx" test/topup-watch.test.tsx
git commit -m "Watch a payment link until it is credited, expired, or mismatched"
```

---

### Task 14: The `/wallet` page, sidebar entry, loading state

**Files:**
- Create: `app/(console)/wallet/page.tsx`
- Create: `app/(console)/wallet/add-money.tsx` (client: switches form ↔ watch)
- Create: `app/(console)/wallet/loading.tsx`
- Modify: `components/shell/sidebar.tsx` (`LINKS`)

**Step 1: `add-money.tsx`**

```tsx
'use client';

import { useState } from 'react';
import type { TopupConfig, TopupRow } from '@/lib/types';
import { TopupForm } from './topup-form';
import { TopupWatch } from './topup-watch';

/** The form until a link exists, then the link until it settles. Starts on
 *  the newest open link so a reload mid-payment lands back on it. */
export function AddMoney({ config, openLinks }: { config: TopupConfig; openLinks: TopupRow[] }) {
  const [current, setCurrent] = useState<TopupRow | null>(openLinks[0] ?? null);

  if (current) {
    return <TopupWatch key={current.payment_order_id} initial={current} onReset={() => setCurrent(null)} />;
  }
  return <TopupForm config={config} openLinks={openLinks} onCreated={setCurrent} />;
}
```

**Step 2: `page.tsx`**

```tsx
import { PageHeader } from '@/components/shell/page-header';
import { EmptyTableRow } from '@/components/ui/empty-state';
import { PendingRoute } from '@/components/ui/pending-route';
import { Section, SectionStack } from '@/components/ui/section';
import { StatusPill } from '@/components/ui/status-pill';
import { TableFrame, Td, Th, Tr } from '@/components/ui/table';
import { RouteNotServedError } from '@/lib/api';
import { date, rupees } from '@/lib/format';
import { staffFetch } from '@/lib/staff';
import { TERMINAL_TOPUP_STATUSES, type TopupConfig, type TopupRow, type Wallet } from '@/lib/types';
import { readWalletOrNull } from '@/lib/wallet';
import { AddMoney } from './add-money';

export const metadata = { title: 'Platform wallet — YE staff console' };

/**
 * What YE holds with the voice platform, and how to add to it.
 *
 * Not `/billing`: that is YE's ledger of what its customers hold. This is
 * one balance behind every one of them, and the thing that halts every
 * campaign at once when it reaches zero. The alert above the balance and the
 * banner on every other page both come from the same `low` flag the API
 * computes against `WALLET_LOW_BALANCE_INR`.
 *
 * The balance is read live and may be unavailable; that renders as
 * unavailable, never as ₹0.
 */
export default async function WalletPage() {
  const [wallet, config, topups] = await Promise.all([
    readWalletOrNull(),
    tolerate(staffFetch<TopupConfig>('/api/admin/wallet/topup-config')),
    tolerate(staffFetch<TopupRow[]>('/api/admin/wallet/topups')),
  ]);

  if (config.data === null || topups.data === null) {
    return (
      <>
        <PageHeader title="Platform wallet" subtitle="YE's balance with the voice platform, and the payment links minted against it." />
        <PendingRoute
          endpoint="GET /api/admin/wallet/topup-config"
          wouldShow="A form here that could not create a link would read as the platform refusing money."
          reason={config.reason ?? topups.reason}
        />
      </>
    );
  }

  const open = topups.data.filter((row) => !TERMINAL_TOPUP_STATUSES.includes(row.status) && new Date(row.expires_at).getTime() > Date.now());

  return (
    <>
      <PageHeader title="Platform wallet" subtitle="YE's balance with the voice platform, and the payment links minted against it. This is not a customer's ledger." />

      <SectionStack>
        <Section title="Balance">
          {wallet?.low ? <LowBalancePanel wallet={wallet} /> : null}
          <p className="text-[22px] font-semibold tabular-nums">
            {wallet ? rupees(wallet.balance_inr) : <span className="text-[var(--text-muted)]">Unavailable</span>}
          </p>
          <p className="text-[12.5px] text-[var(--text-faint)]">
            {wallet ? `Alert floor ${rupees(wallet.threshold_inr)}. Read live from the platform.` : 'The platform did not answer. The number is not zero; it is unknown.'}
          </p>
        </Section>

        <Section title="Add money" description="Mint a payment link and pay it by UPI, card, or netbanking. GST is charged on top and is not credited.">
          <AddMoney config={config.data} openLinks={open} />
        </Section>

        <Section title="Recent top-ups" shown={topups.data.length}>
          <TableFrame>
            <thead>
              <tr>
                <Th>Created</Th>
                <Th>To wallet</Th>
                <Th>Charged</Th>
                <Th>Status</Th>
                <Th>Expires</Th>
                <Th>Credited</Th>
              </tr>
            </thead>
            <tbody>
              {topups.data.length === 0 ? (
                <EmptyTableRow colSpan={6} title="No payment links yet" hint="A link appears here the moment it is created, and stays as the record of what was paid." />
              ) : (
                topups.data.map((row) => (
                  <Tr key={row.payment_order_id}>
                    <Td>{date(row.created_at)}</Td>
                    <Td>{rupees(row.amount_rupees)}</Td>
                    <Td>{rupees(row.total_rupees)}</Td>
                    <Td><StatusPill tone={toneFor(row.status)}>{row.status}</StatusPill></Td>
                    <Td>{date(row.expires_at)}</Td>
                    <Td>{row.credited_at ? date(row.credited_at) : 'Not yet'}</Td>
                  </Tr>
                ))
              )}
            </tbody>
          </TableFrame>
        </Section>
      </SectionStack>
    </>
  );
}

function LowBalancePanel({ wallet }: { wallet: Wallet }) {
  return (
    <div role="alert" className="mb-3 border border-[var(--danger)]/40 p-3 text-[13px]">
      <p className="font-semibold text-[var(--danger)]">Wallet balance is critically low.</p>
      <p>
        {rupees(wallet.balance_inr)} remains, under the {rupees(wallet.threshold_inr)} floor. When it
        reaches zero every campaign on the platform halts on CREDIT_EXHAUSTED and no call is
        placed until money is added.
      </p>
    </div>
  );
}

function toneFor(status: TopupRow['status']) {
  switch (status) {
    case 'CREDITED': return 'positive' as const;
    case 'EXPIRED':
    case 'MISMATCH': return 'danger' as const;
    case 'FAILED': return 'warning' as const;
    case 'ATTEMPTED': return 'accent' as const;
    default: return 'neutral' as const;
  }
}

async function tolerate<T>(read: Promise<T>): Promise<{ data: T | null; reason: string | null }> {
  try {
    return { data: await read, reason: null };
  } catch (err) {
    if (err instanceof RouteNotServedError) return { data: null, reason: err.message };
    throw err;
  }
}
```

Check `Section`'s `shown` prop semantics against `components/ui/section.tsx` before using it; drop it if it requires `total`.

**Step 3: `loading.tsx`** — copy `app/(console)/concurrency/loading.tsx` and adjust the skeleton to a header, one short section, and a 6-column table via `TableSkeleton`.

**Step 4: Sidebar** — in `components/shell/sidebar.tsx` `LINKS`, add `{ href: '/wallet', label: 'Platform wallet' },` after Concurrency.

**Step 5: Verify**

Run: `npm run lint && npx tsc --noEmit && npm test`
Expected: clean, all green.

Then run it against a local backend (the backend worktree on `npm run dev` with `ADMIN_STAFF_TOKEN` set and a Vocobase key; or with the adapter pointed at a mock): `npm run dev`, sign in at `http://localhost:3020/login`, open `/wallet`. Set `WALLET_LOW_BALANCE_INR=99999999` on the backend and confirm the banner on `/accounts` and the panel on `/wallet`.

**Step 6: Commit**

```bash
git add "app/(console)/wallet" components/shell/sidebar.tsx
git commit -m "Add the Platform wallet page: balance, low alert, add money, recent links"
```

---

### Task 15: Console docs, PR

**Files:**
- Modify: `CLAUDE.md` — add `/wallet` to the Pages table; a paragraph under it; add `low-balance-banner` to Shared components; add to "Consequences, stated before the click".

Pages row:

```markdown
| `/wallet` | YE's balance with the voice platform, the critically-low alert, Add money (a payment link minted upstream and watched until it is credited), and the recent links |
```

Paragraph:

```markdown
**`/wallet` is not `/billing`.** `/billing` is what YE's customers hold;
`/wallet` is what YE holds with its supplier, one balance behind all of them.
A payment link minted there credits YE's wallet only and must never be sent to
a customer. There is no callback for a paid link, so the page polls the API
every thirty seconds while a link is open, and stops on `expires_at` by its own
clock. When the API says the wallet is `low` (under `WALLET_LOW_BALANCE_INR`
on the backend, default ₹25,000), every console page carries a banner saying
so; the balance tile never renders ₹0 for a supplier that did not answer.
```

Consequences bullet:

```markdown
- **Creating a payment link** names the amount the payer is charged, which is
  more than what lands in the wallet: GST is on top and is not credited.
```

**Commit and push:**

```bash
git add CLAUDE.md
git commit -m "Document the Platform wallet page"
git push -u origin feat/platform-wallet
gh pr create --title "Platform wallet: balance, critically-low alert, and top-up links" --body "$(cat <<'EOF'
A /wallet page for YE's balance with the voice platform: the balance, a "critically low" alert under the backend's WALLET_LOW_BALANCE_INR (default ₹25,000) on this page and as a banner on every page, an Add money form that mints a payment link through the platform and watches it until credited, and the recent links.

Depends on ye-voice-backend#<backend PR number> (the /api/admin/wallet routes). Pages tolerate the routes being unserved.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Part C: Go-live

Real money. Do this once both PRs are merged and deployed, and after the Vocobase team confirms their backend PR #532 is deployed (the endpoints return 404 until then).

1. On production, set `WALLET_LOW_BALANCE_INR` if a value other than 25000 is wanted. Redeploy the backend so the maintenance scheduler registers.
2. `/wallet`: balance shows a rupee figure, not "Unavailable".
3. Create a ₹1,000 link. Confirm the quote says ₹1,000 + ₹180 = ₹1,180 and expiry is about 24h out.
4. Pay by UPI. Within a minute the pill reads Credited and the balance tile rises by exactly ₹1,000.
5. Create a second link, fail a card on purpose, then pay: Payment failed, then Credited. One credit, not two.
6. Create five links without paying; try a sixth: the open-link list appears, not an error. Let them expire.
7. Reload `/wallet` mid-payment: the link and its status survive.
8. If the balance is under the floor, the banner is on every page. If it is not, temporarily raise the floor on a staging backend to see it.

## Memory note for later sessions

After the PRs merge, record in the project memory: the worktree paths, the per-worktree test DB name (`ye_test_wallet`), and that the wallet endpoints are only live once Vocobase deploys PR #532.
