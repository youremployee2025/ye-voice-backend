# End Call Reason Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Read the platform's new `end_call_reason` on every path a call's ending reaches this service, store it on the attempt, and move every reader that today keys on the deprecated `hangup_cause` / `hangup_source` onto it before the platform removes those two fields next release.

**Architecture:** One new nullable free-text column on `CallAttempt` (`endCallReason`), written by the completion webhook, the terminal status webhook and the reaper's reconcile, and backfilled for history off the listing. One new lib module owns the vocabulary and the customer-facing wording. Existing rules (`classifyOutcome`, `attemptReason`, `disconnectColumns`, the timeline, the two exports, the call-detail screen) gain the new field as their FIRST input and keep the cause/source paths as a fallback for rows settled before the column existed. Nothing that decides a retry changes its answer on a payload that carries no `end_call_reason`.

**Tech Stack:** Express + Prisma + Postgres (backend), Vitest against a real test DB, Next.js + Vitest/RTL (dashboard), the `vocobase-mock` simulator.

---

## What was verified before this plan was written (2026-09-15)

Read from the platform repo at `origin/main` (`d420537`, PR #577) rather than from the announcement:

| Surface | Where the field sits | Mode |
|---|---|---|
| `session.completed` | `data.call.end_call_reason` | authoritative: an answered call with no bot report is `UNKNOWN` |
| `call.status.updated` | `data.end_call_reason`, `null` while `terminal: false` | carrier snapshot: an answered call reads `COMPLETED` here and, say, `CUSTOMER_HUNG_UP` on the completion |
| `GET /api/v2/calls`, `GET /api/v2/calls/{id}` | `data.end_call_reason` (listing rows likewise) | authoritative; **derived on read**, so history is populated with no platform backfill |

Vocabulary (`src/lib/end-call-reason.ts` upstream): `COMPLETED CUSTOMER_HUNG_UP TRANSFERRED VOICEMAIL SCREENER SYSTEM_ERROR BUSY NO_ANSWER REJECTED BLOCKED INVALID_NUMBER NETWORK_ERROR CANCELED NOT_CONNECTED UNKNOWN`. The platform's own comment says the enum may grow, so the column is free text like every other field copied from upstream.

Facts that shape the decisions below:

- `COMPLETED` means the **bot** pushed EndFrame (`pipeline_finished`, or the `watchdog` slow-teardown): the assistant ended the call. `CUSTOMER_HUNG_UP` is `client_disconnected`. This is the attribution `hangup_source` gave on ~24% of voicelink calls, now on every answered call.
- `INVALID_NUMBER` is only Q.850 **1** on voicelink (plus two Plivo strings). Our `UNREACHABLE_HANGUP_CAUSES` also names 3, 22, 28. The Q.850 fallback must stay while the cause still ships.
- `SYSTEM_ERROR` covers: server restart, "insufficient wallet balance" (the 402 we regex-match today), `signal:*` mid-call, and a connected-but-`FAILED` call with no bot report.
- `NOT_CONNECTED` is the MCube/Exotel honest answer. We dial voicelink only, so it should be rare, and it is a silence like `no_answer`.
- `hangup_cause` and `hangup_source` are still emitted this release and removed next release. `CallAttempt.hangupCause` / `hangupSource` stay as columns; every reader of them becomes a fallback.
- **`error_code` is not emitted on any partner call surface on the platform's `origin/main`** (only on messaging events). The `PENDING_TIMEOUT` / `DIAL_TRANSPORT_FAILURE` / `ADMIN_DISMISSED` / `TELEPHONY_CREDIT_EXHAUSTED` branch in `classifyOutcome` and `attemptReason` has, on that evidence, never fired. It stays untouched here (harmless, and the contract may still land), but `SYSTEM_ERROR` is the signal that actually arrives for "the platform, not the number".

## Decisions

- **D1. Store it, free text.** `CallAttempt.endCallReason String?`. Not a Prisma enum, for the reason every upstream-copied column gives: an unlisted value must not fail an ingest.
- **D2. Retry classification: additive only.** `classifyOutcome` keeps its status/disposition/answered_by rule as the primary (the platform's own design keeps `disposition` as the retry driver). `end_call_reason` adds two things: `INVALID_NUMBER` or `BLOCKED` on a silence → `permanent`; `SYSTEM_ERROR` with nobody heard → `platformFault` (handed back at no cost, like an `error_code`). `answered_by: human` still outranks everything, as today.
- **D3. Wallet pause stays on the message regex.** `exhaustsPlatformCredit` is unchanged: `SYSTEM_ERROR` alone cannot tell "wallet dry" from "server restart", and only the former should pause a campaign.
- **D4. Export attribution reads `endCallReason` first, `hangupSource` second.** The bot witnessed the ending; per-leg signalling inferred it. Rows with neither keep today's disposition rule. Mapping is in Task 8.
- **D5. Completion overwrites the snapshot.** The terminal `call.status.updated` writes the carrier snapshot only onto an open attempt; `session.completed` writes unconditionally, so `COMPLETED` (carrier view) becomes `CUSTOMER_HUNG_UP` (bot view) when the completion lands. The reaper's reconcile writes whatever the detail carries: the detail is authoritative and derived on read, so the only thing it can overwrite on a still-open attempt is a status-event carrier snapshot. No writer ever writes null over a value.
- **D6. The dashboard prints words, never the token.** A label map lives in the backend and travels as `end_reason` (attempt feed) / `endReason` (call detail) beside the raw value, the same rule `failure_reason` follows.
- **D7. Backfill reuses the listing walk.** The `hangupSourceBackfill` walk is generalised to any `(upstream key → column)` pair rather than copied. History is filled because the platform derives the value on read.

## Order of work and deploy

1. Backend Tasks 1–11 → PR → merge = Render prod deploy (see memory: merge is a deploy).
2. Run the backfill against prod (Task 12) once the backend is live. It is idempotent and fills nulls only.
3. Dashboard Task 13 → PR → merge. The dashboard renders `endReason` as optional, so it is safe in either order, but the field only appears once the backend is live.
4. Mock Task 14 is independent; land it first if convenient so backend tests can use the emitted field, but the backend tests here do not depend on it.

Worktrees (top-level layout, per the root `CLAUDE.md`):

```bash
cd /Users/sajaldewangan/Desktop/revenue-generator
git -C ezo/ye-voice-agent/ye-voice-backend fetch -q origin
git -C ezo/ye-voice-agent/ye-voice-backend worktree add ../../../.worktrees/end-call-reason/ye-voice-backend -b feat/end-call-reason origin/main
git -C ezo/ye-voice-agent/ye-voice-dashboard worktree add ../../../.worktrees/end-call-reason/ye-voice-dashboard -b feat/end-call-reason origin/main
git -C ezo/ye-voice-agent/vocobase-mock worktree add ../../../.worktrees/end-call-reason/vocobase-mock -b feat/end-call-reason main
```

Each backend worktree needs its own `node_modules` (`npm ci`, never a symlink) and its own dev + test Postgres in `.env` / `.env.test` (see memories `ezo-per-worktree-databases`, `ezo-worktrees-need-own-node-modules`). Copy this plan into the backend worktree's `docs/plans/` and commit it as the first commit.

All backend paths below are relative to `.worktrees/end-call-reason/ye-voice-backend`.

---

### Task 1: The column

**Files:**
- Modify: `prisma/schema.prisma` (the `CallAttempt` model, directly after `hangupSource String?` at ~line 1296)
- Create: `prisma/migrations/20260915120000_call_attempt_end_call_reason/migration.sql`

**Step 1: Add the field**

```prisma
  /// The platform's one-vocabulary answer to how the call ended, replacing
  /// `hangupCause` + `hangupSource` above (both deprecated upstream, removed
  /// next release). Written by the completion, the terminal status event and
  /// the reaper's reconcile; backfilled off the listing for older rows. Free
  /// text for the reason every column above it is: the platform says the set
  /// may grow, and an unlisted value must not fail an ingest. `UNKNOWN` and
  /// `NOT_CONNECTED` are values; null means "no delivery carried it".
  endCallReason  String?
```

**Step 2: Create the migration**

Run: `npx prisma migrate dev --name call_attempt_end_call_reason`
Expected: one new folder under `prisma/migrations/` containing exactly:

```sql
ALTER TABLE "CallAttempt" ADD COLUMN "endCallReason" TEXT;
```

If `migrate dev` asks to reset, the worktree is pointed at a shared DB. Stop and fix `.env` first.

**Step 3: Confirm the client regenerated**

Run: `npx tsc --noEmit`
Expected: clean.

**Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "Store the platform's end_call_reason on each call attempt"
```

---

### Task 2: The vocabulary module

**Files:**
- Create: `src/lib/endCallReason.ts`
- Test: `test/end-call-reason.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  endReasonLabel,
  isNumberVerdict,
  isPlatformFault,
  normaliseEndCallReason,
} from '../src/lib/endCallReason.js';

describe('normaliseEndCallReason', () => {
  it.each([
    ['customer_hung_up', 'CUSTOMER_HUNG_UP'],
    ['  Completed ', 'COMPLETED'],
    ['SOMETHING_NEW', 'SOMETHING_NEW'],
  ])('upper-cases and trims %s', (raw, expected) => {
    expect(normaliseEndCallReason(raw)).toBe(expected);
  });

  it.each([null, undefined, '', '   '])('reads %s as not reported', (raw) => {
    expect(normaliseEndCallReason(raw)).toBeNull();
  });
});

describe('isNumberVerdict', () => {
  it.each(['INVALID_NUMBER', 'BLOCKED'])('%s says the number itself is bad', (r) => {
    expect(isNumberVerdict(r)).toBe(true);
  });
  it.each(['NO_ANSWER', 'BUSY', 'REJECTED', 'NETWORK_ERROR', 'NOT_CONNECTED', null])(
    '%s is about this call, not the number',
    (r) => expect(isNumberVerdict(r)).toBe(false),
  );
});

describe('isPlatformFault', () => {
  it('is SYSTEM_ERROR and nothing else', () => {
    expect(isPlatformFault('SYSTEM_ERROR')).toBe(true);
    expect(isPlatformFault('UNKNOWN')).toBe(false);
    expect(isPlatformFault(null)).toBe(false);
  });
});

describe('endReasonLabel', () => {
  it('names every documented value in customer words with no token in it', () => {
    for (const v of [
      'COMPLETED', 'CUSTOMER_HUNG_UP', 'TRANSFERRED', 'VOICEMAIL', 'SCREENER', 'SYSTEM_ERROR',
      'BUSY', 'NO_ANSWER', 'REJECTED', 'BLOCKED', 'INVALID_NUMBER', 'NETWORK_ERROR',
      'CANCELED', 'NOT_CONNECTED', 'UNKNOWN',
    ]) {
      const label = endReasonLabel(v);
      expect(label).not.toBeNull();
      expect(label).not.toMatch(/[A-Z]{3,}_/);
    }
  });

  it('returns null for a value it has no words for, and for absence', () => {
    expect(endReasonLabel('SOMETHING_NEW')).toBeNull();
    expect(endReasonLabel(null)).toBeNull();
  });

  it('attributes COMPLETED to the assistant, not to success', () => {
    expect(endReasonLabel('COMPLETED')).toBe('The assistant ended the call');
  });
});
```

**Step 2: Run to verify it fails**

Run: `npx vitest run test/end-call-reason.test.ts`
Expected: FAIL, module not found.

**Step 3: Implement**

```ts
/**
 * The platform's `end_call_reason`: one vocabulary for how a call ended, the
 * same on every carrier. Replaces `hangup_cause` (raw carrier text) and
 * `hangup_source` (per-leg attribution), both deprecated upstream.
 *
 * The values split in two. Unanswered calls resolve from the carrier
 * (BUSY … NOT_CONNECTED); answered calls resolve from the platform's own bot
 * (COMPLETED … SCREENER). SYSTEM_ERROR can come from either half. Verified
 * against the platform's `lib/end-call-reason.ts` on 2026-09-15.
 *
 * Read as free text everywhere, and every set below is an allow-list: the
 * platform says new values may be added, and an unlisted one must fall
 * through as "not one of these", never as an error.
 */

/** Upper-cased and trimmed, or null: a blank reason is no reason. */
export function normaliseEndCallReason(raw: string | null | undefined): string | null {
  const v = raw?.trim().toUpperCase();
  return v ? v : null;
}

/**
 * The carrier said the NUMBER is bad, not the moment. `INVALID_NUMBER` is
 * Q.850 1 / "unallocated" / "invalid destination"; `BLOCKED` is a carrier
 * "forbidden". Neither will complete on a later attempt either. Deliberately
 * not REJECTED (the callee declined once) or NETWORK_ERROR (the moment).
 */
const NUMBER_VERDICTS: ReadonlySet<string> = new Set(['INVALID_NUMBER', 'BLOCKED']);

export function isNumberVerdict(reason: string | null | undefined): boolean {
  const r = normaliseEndCallReason(reason);
  return r !== null && NUMBER_VERDICTS.has(r);
}

/**
 * The platform, not the carrier, ended it: a server restart, its telephony
 * wallet dry, the bot process torn down, or a connected call that failed
 * with no bot report. Beside nobody heard, the number was never tested.
 */
export function isPlatformFault(reason: string | null | undefined): boolean {
  return normaliseEndCallReason(reason) === 'SYSTEM_ERROR';
}

/**
 * Customer-facing words. The dashboard prints these and never the token —
 * the same rule `attemptReason` holds for failure sentences. COMPLETED is
 * "the assistant ended the call", which is what the platform's bot means by
 * it (`pipeline_finished`), and NOT "the call succeeded".
 */
const LABELS: Readonly<Record<string, string>> = {
  COMPLETED: 'The assistant ended the call',
  CUSTOMER_HUNG_UP: 'The customer hung up',
  TRANSFERRED: 'Transferred to a person',
  VOICEMAIL: 'Reached voicemail',
  SCREENER: 'A call screener answered',
  SYSTEM_ERROR: 'The voice platform ended the call',
  BUSY: 'The line was busy',
  NO_ANSWER: 'No answer',
  REJECTED: 'The call was declined',
  BLOCKED: 'The number is blocked',
  INVALID_NUMBER: 'Not a valid phone number',
  NETWORK_ERROR: 'The carrier could not connect the call',
  CANCELED: 'Canceled before it connected',
  NOT_CONNECTED: 'Did not connect',
  UNKNOWN: 'Not reported',
};

export function endReasonLabel(reason: string | null | undefined): string | null {
  const r = normaliseEndCallReason(reason);
  return r === null ? null : (LABELS[r] ?? null);
}
```

**Step 4: Run to verify it passes**

Run: `npx vitest run test/end-call-reason.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/endCallReason.ts test/end-call-reason.test.ts
git commit -m "Add the end_call_reason vocabulary and its customer-facing labels"
```

---

### Task 3: `classifyOutcome` reads the reason (D2)

**Files:**
- Modify: `src/lib/dialOutcome.ts` (the `classifyOutcome` signature ~line 230 and body)
- Test: `test/dial-outcome.test.ts`

**Step 1: Write the failing tests** (append to the existing file, reusing its `failedCall` helper style)

```ts
describe('end_call_reason', () => {
  const silence = (endCallReason: string | null) => ({
    status: 'no_answer',
    disposition: 'no_answer',
    answeredBy: null,
    hangupCause: '16 - Normal Clearing',
    endCallReason,
  });

  it.each(['INVALID_NUMBER', 'BLOCKED', 'invalid_number'])(
    'settles a silence the platform blames on the number (%s) permanently',
    (r) => expect(classifyOutcome(silence(r)).permanent).toBe(true),
  );

  it.each(['NO_ANSWER', 'BUSY', 'REJECTED', 'NETWORK_ERROR', 'NOT_CONNECTED', 'CANCELED', 'UNKNOWN', null])(
    'keeps a %s silence on the ladder',
    (r) => {
      const c = classifyOutcome(silence(r));
      expect(c.retryable).toBe(true);
      expect(c.permanent).toBe(false);
      expect(c.platformFault).toBe(false);
    },
  );

  it('hands back a SYSTEM_ERROR nobody was heard on at no cost', () => {
    expect(classifyOutcome(silence('SYSTEM_ERROR'))).toEqual({
      retryable: true,
      permanent: false,
      platformFault: true,
    });
  });

  it('a person heard beats SYSTEM_ERROR and INVALID_NUMBER alike', () => {
    for (const r of ['SYSTEM_ERROR', 'INVALID_NUMBER']) {
      const c = classifyOutcome({ ...silence(r), status: 'completed', disposition: 'completed', answeredBy: 'human' });
      expect(c).toEqual({ retryable: false, permanent: false, platformFault: false });
    }
  });

  it('never makes a conversation permanent off a stray reason', () => {
    const c = classifyOutcome({ status: 'completed', disposition: 'completed', answeredBy: null, endCallReason: 'BLOCKED' });
    expect(c.permanent).toBe(false);
  });
});
```

The last test is deliberate: like the Q.850 rule, the number verdict is gated on `retryable` (nobody spoken to), so a mis-emitted reason on a `completed` call cannot retire a lead.

**Step 2: Run to verify it fails**

Run: `npx vitest run test/dial-outcome.test.ts`
Expected: the new block fails (`permanent` false, `platformFault` false).

**Step 3: Implement**

In `src/lib/dialOutcome.ts`, import at the top:

```ts
import { isNumberVerdict, isPlatformFault } from './endCallReason.js';
```

Add to the `classifyOutcome` parameter type, after `errorMessage`:

```ts
  /**
   * The platform's `end_call_reason`. Two readings only, both additive:
   * `INVALID_NUMBER` / `BLOCKED` on a silence is permanent, the same verdict
   * the Q.850 rule below draws from the raw cause (which the platform stops
   * sending next release); `SYSTEM_ERROR` with nobody heard is a platform
   * fault, the same handling as an `error_code`. Everything else in the
   * vocabulary restates the disposition, which stays the retry driver.
   */
  endCallReason?: string | null;
```

Change the `decidedByPlatform` expression to:

```ts
  const decidedByPlatform =
    normaliseErrorCode(outcome.errorCode) !== null ||
    exhaustsPlatformCredit(null, outcome.errorMessage) ||
    isPlatformFault(outcome.endCallReason);
```

Change the `permanent` expression's last disjunct to:

```ts
      (retryable &&
        (namesAnUnreachableNumber(outcome.hangupCause) || isNumberVerdict(outcome.endCallReason))),
```

**Step 4: Run to verify it passes**

Run: `npx vitest run test/dial-outcome.test.ts test/dialer-outcome.test.ts test/goal-record.test.ts`
Expected: PASS, including every pre-existing case (nothing changes when `endCallReason` is absent).

**Step 5: Commit**

```bash
git add src/lib/dialOutcome.ts test/dial-outcome.test.ts
git commit -m "Let end_call_reason retire a bad number and hand back a platform fault"
```

---

### Task 4: Ingest on both webhooks

**Files:**
- Modify: `src/services/dialerOutcome.ts` (`TerminalOutcome` ~line 76–98; the `classifyOutcome` call ~line 871; the attempt `update` data ~line 979)
- Modify: `src/services/webhookOutcome.ts` (`handleSessionCompleted` ~line 202–218; `handleStatusUpdated` ~line 446–521)
- Test: `test/webhooks.test.ts`

**Step 1: Write the failing tests** (append; use the file's `completion(...)` and the existing status-updated helpers, and its attempt-lookup helper)

```ts
describe('end_call_reason', () => {
  it('stores the completion\'s reason on the attempt', async () => {
    const { attemptId } = await seedOpenAttempt();
    await deliver(completion({}, { end_call_reason: 'CUSTOMER_HUNG_UP', hangup_cause: '16', hangup_source: 'caller' }));

    const row = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(row.endCallReason).toBe('CUSTOMER_HUNG_UP');
    // Still recorded while the platform sends them.
    expect(row.hangupCause).toBe('16');
    expect(row.hangupSource).toBe('caller');
  });

  it('settles a next-release payload that carries no hangup_cause or hangup_source', async () => {
    const { attemptId } = await seedOpenAttempt();
    const body = completion({}, { end_call_reason: 'COMPLETED', disposition: 'completed', answered_by: 'human' });
    delete (body.data.call as Record<string, unknown>).hangup_cause;
    delete (body.data.call as Record<string, unknown>).hangup_source;
    await deliver(body);

    const row = await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(row.status).toBe('COMPLETED');
    expect(row.endCallReason).toBe('COMPLETED');
    expect(row.hangupCause).toBeNull();
  });

  it('the terminal status event writes the carrier snapshot; the completion overwrites it', async () => {
    const { attemptId } = await seedOpenAttempt();
    await deliver(statusUpdated({ status: 'completed', terminal: true, end_call_reason: 'COMPLETED', disposition: 'completed', answered_by: 'human' }));
    expect((await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } })).endCallReason).toBe('COMPLETED');

    await deliver(completion({}, { end_call_reason: 'CUSTOMER_HUNG_UP' }));
    expect((await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } })).endCallReason).toBe('CUSTOMER_HUNG_UP');
  });

  it('a live status event carries null and writes nothing', async () => {
    const { attemptId } = await seedOpenAttempt();
    await deliver(statusUpdated({ status: 'ringing', terminal: false, end_call_reason: null }));
    expect((await prisma.callAttempt.findUniqueOrThrow({ where: { id: attemptId } })).endCallReason).toBeNull();
  });

  it('a SYSTEM_ERROR silence hands the contact back at no cost to its ladder', async () => {
    const { attemptId, contactId } = await seedOpenCampaignAttempt();
    await deliver(completion({}, { end_call_reason: 'SYSTEM_ERROR', status: 'failed', disposition: 'failed' }));

    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: contactId } });
    // Same assertions the existing "an outcome the platform decided (error_code)"
    // block makes: attempts untouched, back on the queue. Copy them verbatim.
  });
});
```

Adapt `seedOpenAttempt` / `seedOpenCampaignAttempt` / `statusUpdated` to whatever the file already names those helpers (see the `describe('call.status.updated'` block at ~line 848 and the `error_code` block at ~line 995 for the give-back assertions).

**Step 2: Run to verify it fails**

Run: `npx vitest run test/webhooks.test.ts -t end_call_reason`
Expected: FAIL (`endCallReason` is null / not a column on the outcome).

**Step 3: Implement**

`src/services/dialerOutcome.ts`, in `TerminalOutcome` after `hangupSource`:

```ts
  /** The platform's `end_call_reason`, verbatim. Optional for the same reason
   *  `hangupSource` is: the reaper reads a detail payload that may predate it. */
  endCallReason?: string | null;
```

In `applyTerminalOutcome`, pass it to `classifyOutcome` beside `hangupCause`:

```ts
    endCallReason: outcome.endCallReason ?? null,
```

and in the attempt update data beside `hangupSource: outcome.hangupSource ?? null,` write it **only when carried** (so a reconcile over an older detail cannot blank what a webhook wrote):

```ts
          ...(outcome.endCallReason == null ? {} : { endCallReason: normaliseEndCallReason(outcome.endCallReason) }),
```

(import `normaliseEndCallReason` from `../lib/endCallReason.js`.)

`src/services/webhookOutcome.ts`, `handleSessionCompleted`, in the `applyTerminalOutcome` call after `hangupSource`:

```ts
    // The platform's one-vocabulary ending. Lives on `data.call`; the envelope
    // is read second for the same reason `hangup_source` is.
    endCallReason:
      readString(call, ['end_call_reason', 'endCallReason']) ?? readString(data, ['end_call_reason', 'endCallReason']),
```

`handleStatusUpdated`: read it once beside `errorCode`:

```ts
  // Null while the call is live; on the terminal event it is the CARRIER's
  // view only (the bot has not reported yet), so a connected call reads
  // COMPLETED here and its real ending arrives on session.completed.
  const endCallReason = normaliseEndCallReason(readString(data, ['end_call_reason', 'endCallReason']));
```

add `endCallReason` to the `normalised` object passed to `classifyOutcome`, and in the `updateMany` data beside the `hangupSource` spread:

```ts
        // Only when carried, like the source: this `updateMany` matches open
        // attempts alone, so it never blanks a settled value, and the completion
        // that follows overwrites this carrier snapshot with the bot's answer.
        ...(endCallReason === null ? {} : { endCallReason }),
```

**Step 4: Run to verify it passes**

Run: `npx vitest run test/webhooks.test.ts test/dialer-outcome.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/services/dialerOutcome.ts src/services/webhookOutcome.ts test/webhooks.test.ts
git commit -m "Record end_call_reason off both webhooks and classify on it"
```

---

### Task 5: The reaper's reconcile reads it off the call detail

**Files:**
- Modify: `src/services/dialerReaper.ts:127-151`
- Test: the existing reaper reconcile test file (find it: `grep -l "hangupSource" test/*reaper*`), one new case

**Step 1: Failing test.** Mock `getCall` to return `{ ..., end_call_reason: 'NO_ANSWER' }` for an open attempt past the reap deadline; assert the reconciled row has `endCallReason: 'NO_ANSWER'`. Follow the file's existing `hangupSource` reconcile case.

**Step 2: Run, expect FAIL.**

**Step 3: Implement.** Beside `hangupSource: readString(call, ['hangup_source', 'hangupSource']),`:

```ts
          // The one-vocabulary ending. `GET /calls/:id` derives it on read, so
          // a reconciliation records the same answer the lost webhook would
          // have. Absent on a detail that predates it: the settle then writes
          // nothing and the backfill fills it later.
          endCallReason: readString(call, ['end_call_reason', 'endCallReason']),
```

**Step 4: Run, expect PASS.**

**Step 5: Commit** — `git commit -m "Reconcile end_call_reason off the call detail"`

---

### Task 6: `attemptReason` speaks from the reason

**Files:**
- Modify: `src/lib/attemptReason.ts` (`AttemptReasonInput`, and the body after the `blocked` branch)
- Modify: every caller that builds an `AttemptReasonInput` from an attempt row: `src/lib/serialize.ts` (~line 1323, `attemptReason(attempt)`), `src/services/callHistory.ts:377` select, and any `select` that feeds it (grep `attemptReason(`). Add `endCallReason: true` to those selects.
- Test: `test/attempt-reason.test.ts`

**Step 1: Failing tests** (extend the `row` helper with `endCallReason: null`)

```ts
describe('end_call_reason', () => {
  it.each([
    ['INVALID_NUMBER', 'not a valid phone number'],
    ['BLOCKED', 'blocked'],
  ])('%s: the number will not be called again', (r, phrase) => {
    const s = attemptReason(row({ endCallReason: r, disposition: 'no_answer' }));
    expect(s?.toLowerCase()).toContain(phrase);
    expect(s).toContain('will not be called again');
  });

  it.each(['NETWORK_ERROR', 'REJECTED', 'CANCELED', 'NOT_CONNECTED'])('%s: one sentence, no token', (r) => {
    const s = attemptReason(row({ endCallReason: r, disposition: 'failed' }));
    expect(s).not.toBeNull();
    expect(s).not.toContain(r);
  });

  it('SYSTEM_ERROR nobody was heard on reads as a platform fault not counted against the contact', () => {
    expect(attemptReason(row({ endCallReason: 'SYSTEM_ERROR' }))).toContain('not counted');
  });

  it('SYSTEM_ERROR beside a person heard is a conversation and says nothing', () => {
    expect(attemptReason(row({ endCallReason: 'SYSTEM_ERROR', answeredBy: 'human', status: 'COMPLETED', disposition: 'completed' }))).toBeNull();
  });

  it.each(['NO_ANSWER', 'BUSY', 'VOICEMAIL', 'COMPLETED', 'CUSTOMER_HUNG_UP', 'UNKNOWN'])(
    '%s: the disposition already says it',
    (r) => expect(attemptReason(row({ endCallReason: r, disposition: 'no_answer' }))).toBeNull(),
  );

  it('the reaper\'s verdict still outranks a reason', () => {
    expect(attemptReason(row({ status: 'ABANDONED', endCallReason: 'INVALID_NUMBER' }))).toContain('outcome is unknown');
  });
});
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement.** Add `endCallReason: string | null;` to `AttemptReasonInput`. Add a table:

```ts
/** Sentences keyed on the platform's `end_call_reason`. Only the values that
 *  add something the disposition does not say; the rest return null. */
const END_REASON_SENTENCE: Record<string, string> = {
  INVALID_NUMBER: 'This is not a valid phone number. It will not be called again.',
  BLOCKED: 'This number is blocked. It will not be called again.',
  NETWORK_ERROR: 'The carrier could not connect this call.',
  REJECTED: 'The call was declined before it connected.',
  CANCELED: 'The call was canceled before it connected.',
  NOT_CONNECTED: 'The call did not connect.',
};
```

In `attemptReason`, after the `error_code` branch and before the launch-error branch, add the platform-fault reading (it must sit with the other "not counted" branch, because that is what the settle did with it):

```ts
  if (isPlatformFault(attempt.endCallReason) && !heardAPerson(attempt.answeredBy)) {
    return 'The voice platform ended this call before the number was tested.' + NOT_COUNTED;
  }
```

After the `blocked` disposition branch and before the Q.850 branch:

```ts
  const reason = normaliseEndCallReason(attempt.endCallReason);
  if (reason !== null && !heardAPerson(attempt.answeredBy)) {
    const sentence = END_REASON_SENTENCE[reason];
    if (sentence) return sentence;
  }
```

Keep the Q.850 branch beneath it as the fallback for rows with no reason.

**Step 4: Run** `npx vitest run test/attempt-reason.test.ts test/call-serialize.test.ts test/call-history-service.test.ts` — PASS. Run `npx tsc --noEmit` to find every `AttemptReasonInput` builder that now lacks the field, and add `endCallReason: true` to each select.

**Step 5: Commit** — `git commit -m "Explain a dial's ending from end_call_reason before the raw cause"`

---

### Task 7: Serialize it to the dashboard

**Files:**
- Modify: `src/lib/serialize.ts` (call detail ~line 1233; attempt row ~line 1291)
- Modify: `src/lib/callTimeline.ts:31,84`
- Test: `test/call-serialize.test.ts`, `test/call-timeline.test.ts`

**Step 1: Failing tests.**
- Call detail: a platform call payload with `end_call_reason: 'CUSTOMER_HUNG_UP'` serializes `endCallReason: 'CUSTOMER_HUNG_UP'` and `endReason: 'The customer hung up'`; with the field absent both are null.
- Attempt row: `end_call_reason` and `end_reason` beside `hangup_cause`.
- Timeline: `ended` event `detail` is the end reason when the attempt has one, else the hangup cause (existing tests keep passing).

**Step 2: Run, expect FAIL.**

**Step 3: Implement.**

Call detail (beside `hangupSource:`):

```ts
    // The platform's one-vocabulary ending, live off the detail like the two
    // deprecated fields above it, plus the words the screen prints.
    endCallReason: normaliseEndCallReason(readString(call, ['end_call_reason', 'endCallReason'])),
    endReason: endReasonLabel(readString(call, ['end_call_reason', 'endCallReason'])),
```

Attempt row (beside `hangup_cause:`):

```ts
    end_call_reason: attempt.endCallReason,
    end_reason: endReasonLabel(attempt.endCallReason),
```

Timeline: add `endCallReason: string | null` to `TimelineAttempt`; `['ended', attempt.endedAt, attempt.endCallReason ?? attempt.hangupCause]`. Add `endCallReason: true` to the selects that feed `buildTimeline` (tsc will list them).

**Step 4: Run** the two test files and `npx tsc --noEmit` — PASS / clean.

**Step 5: Commit** — `git commit -m "Serialize end_call_reason and its label on call detail, attempts and the timeline"`

---

### Task 8: Export attribution reads the reason first (D4)

**Files:**
- Modify: `src/lib/campaignExportColumns.ts` (`DisconnectSource`, `disconnectColumns`)
- Modify: `src/services/campaignCallsExport.ts:89,167,211` and `src/services/campaignLeadsExport.ts:226,254,280,298,455`
- Test: `test/campaign-export-disconnect.test.ts`, `test/campaign-calls-export.test.ts`, `test/campaign-leads-export.test.ts`

Mapping (the reference export's four combinations, nothing new invented):

| `end_call_reason` | reasonKey | disconnectedBy | why |
|---|---|---|---|
| CUSTOMER_HUNG_UP | `user` | Customer | the bot saw the client disconnect |
| COMPLETED, TRANSFERRED | `voicebot_hangup` | AI Assistant | the bot ended its leg |
| VOICEMAIL, SCREENER, BUSY, NO_ANSWER | `` | System | nobody on the line; the platform or carrier released it (same bucket the unsourced `no_answer`/`busy` rule already credits) |
| REJECTED, CANCELED, NETWORK_ERROR, INVALID_NUMBER, BLOCKED, NOT_CONNECTED, SYSTEM_ERROR, UNKNOWN, anything else | `` | `` | the reference file leaves an outright failure unattributed; a blank is recoverable, a wrong name is not |

**Step 1: Failing tests** (append to `campaign-export-disconnect.test.ts`)

```ts
describe('end_call_reason', () => {
  it.each([
    ['CUSTOMER_HUNG_UP', { reasonKey: 'user', disconnectedBy: 'Customer' }],
    ['COMPLETED', { reasonKey: 'voicebot_hangup', disconnectedBy: 'AI Assistant' }],
    ['TRANSFERRED', { reasonKey: 'voicebot_hangup', disconnectedBy: 'AI Assistant' }],
    ['VOICEMAIL', { reasonKey: '', disconnectedBy: 'System' }],
    ['NO_ANSWER', { reasonKey: '', disconnectedBy: 'System' }],
    ['NETWORK_ERROR', { reasonKey: '', disconnectedBy: '' }],
    ['SOMETHING_NEW', { reasonKey: '', disconnectedBy: '' }],
  ])('%s', (endCallReason, expected) => {
    expect(disconnectColumns({ endCallReason, hangupSource: null, disposition: 'completed' })).toEqual(expected);
  });

  it('outranks a hangup_source that disagrees', () => {
    expect(disconnectColumns({ endCallReason: 'CUSTOMER_HUNG_UP', hangupSource: 'system', disposition: 'completed' }))
      .toEqual({ reasonKey: 'user', disconnectedBy: 'Customer' });
  });

  it('falls back to hangup_source on a row settled before the column existed', () => {
    expect(disconnectColumns({ endCallReason: null, hangupSource: 'system', disposition: 'completed' }))
      .toEqual({ reasonKey: 'voicebot_hangup', disconnectedBy: 'AI Assistant' });
  });

  it('a launch that never left still disconnected nothing', () => {
    expect(disconnectColumns({ endCallReason: 'COMPLETED', hangupSource: null, disposition: null, launchError: 'x' }))
      .toEqual({ reasonKey: '', disconnectedBy: '' });
  });
});
```

**Step 2: Run, expect FAIL** (type error: unknown property).

**Step 3: Implement.** Add `endCallReason?: string | null;` to `DisconnectSource` with a doc comment ("the bot's account of the ending; read before the inferred per-leg source"). Add:

```ts
const END_REASONS: Readonly<Record<string, DisconnectColumns>> = {
  CUSTOMER_HUNG_UP: { reasonKey: 'user', disconnectedBy: 'Customer' },
  COMPLETED: { reasonKey: 'voicebot_hangup', disconnectedBy: 'AI Assistant' },
  TRANSFERRED: { reasonKey: 'voicebot_hangup', disconnectedBy: 'AI Assistant' },
  VOICEMAIL: { reasonKey: '', disconnectedBy: 'System' },
  SCREENER: { reasonKey: '', disconnectedBy: 'System' },
  BUSY: { reasonKey: '', disconnectedBy: 'System' },
  NO_ANSWER: { reasonKey: '', disconnectedBy: 'System' },
};
```

In `disconnectColumns`, after the `launchError` guard and before the `named` source read:

```ts
  const reason = normaliseEndCallReason(source.endCallReason);
  if (reason !== null) return END_REASONS[reason] ?? UNATTRIBUTED;
```

Then thread the column: calls export `select` + row shape + `disconnectColumns({ endCallReason: attempt.endCallReason, ... })`; leads export raw SQL adds `a."endCallReason" AS last_end_call_reason`, the row type, the GROUP BY/select list at ~280, the fact mapping at ~298, and the `disconnectColumns` call at ~455. Extend the two export tests with one row each carrying `endCallReason: 'CUSTOMER_HUNG_UP'` and `hangupSource: null` and assert `Call Disconnected By` = `Customer`.

**Step 4: Run** `npx vitest run test/campaign-export-disconnect.test.ts test/campaign-calls-export.test.ts test/campaign-leads-export.test.ts` — PASS.

**Step 5: Commit** — `git commit -m "Attribute export disconnects from end_call_reason before the inferred source"`

---

### Task 9: Backfill history off the listing (D7)

**Files:**
- Modify: `src/services/hangupSourceBackfill.ts` → generalise; keep `backfillHangupSource` as a wrapper
- Create: `src/services/endCallReasonBackfill.ts` (thin), `scripts/backfill-end-call-reason.ts` (copy `scripts/backfill-hangup-source.ts`, swap the service)
- Modify: `package.json` scripts: `"backfill:end-call-reason": "tsx scripts/backfill-end-call-reason.ts"`
- Test: `test/end-call-reason-backfill.test.ts` (copy the shape of `test/hangup-source-backfill.test.ts`)

**Step 1: Failing test.** Three cases, mirroring the source backfill's: fills a null `endCallReason` from a listing row's `end_call_reason`; leaves a row that already has one alone (the webhook is fresher); a listing row without the field writes nothing.

**Step 2: Run, expect FAIL.**

**Step 3: Implement.** Extract the loop body of `backfillHangupSource` into

```ts
export interface ListingColumn {
  upstreamKeys: string[];        // e.g. ['end_call_reason', 'endCallReason']
  column: 'hangupSource' | 'endCallReason';
  normalise?: (raw: string) => string | null;
}
export async function backfillFromListing(col: ListingColumn, options: BackfillOptions = {}): Promise<BackfillResult>
```

with `where: { upstreamCallId: callId, [col.column]: null }` and `data: { [col.column]: value }`, and the default `outstanding` count keyed on `col.column`. `backfillHangupSource = (o) => backfillFromListing({ upstreamKeys: ['hangup_source','hangupSource'], column: 'hangupSource' }, o)`. `backfillEndCallReason` uses `normaliseEndCallReason`. The existing `hangup-source-backfill.test.ts` is the refactor's safety net.

**Step 4: Run** `npx vitest run test/hangup-source-backfill.test.ts test/end-call-reason-backfill.test.ts` — PASS.

**Step 5: Commit** — `git commit -m "Backfill end_call_reason for settled attempts off the listing"`

---

### Task 10: Docs

**Files:**
- Modify: `CLAUDE.md` — the `CallAttempt` field table (~line 2444), the "hangup_source" section (~line 2090–2155), the outcome ladder table (~line 3080–3095), the scripts table (~line 1981)

Add: the field, where it comes from on each of the three surfaces, the D2 additions to the ladder table (two new rows: `INVALID_NUMBER`/`BLOCKED` → permanent; `SYSTEM_ERROR` nobody heard → platform fault), the export mapping table from Task 8, the `backfill:end-call-reason` script, and one paragraph stating that `hangup_cause`/`hangup_source` are deprecated upstream (removed next release), that their columns and readers stay as fallbacks for older rows, and that the finding about `error_code` never being emitted on call surfaces (2026-09-15, platform `origin/main`) is why `SYSTEM_ERROR` is read as the platform-fault signal.

**Commit** — `git commit -m "Document end_call_reason and the deprecation of the raw hangup fields"`

---

### Task 11: Full backend verification

Run, in the worktree:

```bash
npx tsc --noEmit
npx vitest run
```

Expected: clean, all green. Per memory the full suite is ~10% flaky from cross-file bleed; re-run a failing file alone before concluding anything. Then push the branch and open the PR (`gh pr create --repo Arvind9599/ye-voice-backend`). Merging is a prod deploy; hand the merge to the operator.

---

### Task 12: Backfill production (operator)

After the backend is live on Render, the operator runs from the main backend checkout on `main`:

```
! cd /Users/sajaldewangan/Desktop/revenue-generator/ezo/ye-voice-agent/ye-voice-backend && npm run backfill:end-call-reason
```

Verify (read-only, prod DB):

```sql
SELECT "endCallReason", COUNT(*) FROM "CallAttempt"
WHERE "upstreamCallId" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC;
```

Expected: nulls only on attempts that never got an upstream call id. Then check one fresh completion carried the field end to end:

```sql
SELECT id, "endCallReason", "hangupCause", "hangupSource", "resolvedAt"
FROM "CallAttempt" WHERE "resolvedAt" > now() - interval '1 hour' ORDER BY "resolvedAt" DESC LIMIT 20;
```

---

### Task 13: Dashboard

Paths relative to `.worktrees/end-call-reason/ye-voice-dashboard`.

**Files:**
- Modify: `lib/types.ts` (~line 1136 attempt row: add `end_call_reason?: string | null; end_reason?: string | null;`; ~line 1859 `CallDetail`: add `endCallReason?: string | null; endReason?: string | null;`)
- Modify: `components/calls/call-detail.tsx:~366-377` and `app/(dash)/calls/[id]/page.tsx:~392-397`
- Test: `test/call-detail-page.test.tsx`

**Step 1: Failing test.** The fixture at line ~58 gains `endCallReason: 'CUSTOMER_HUNG_UP', endReason: 'The customer hung up'`; assert the page renders "How it ended" with "The customer hung up" and that the raw token `CUSTOMER_HUNG_UP` does not appear. Second case: fixture without the two fields (older backend) renders the existing cause/source rows and no "How it ended" row.

**Step 2: Run** `npx vitest run test/call-detail-page.test.tsx` — FAIL.

**Step 3: Implement.** In both carrier-detail blocks, add as the FIRST row, rendered only when `call.endReason` is a string:

```tsx
{call.endReason ? (
  <Row label="How it ended">
    <Value>{call.endReason}</Value>
  </Row>
) : null}
```

(`Field`/`id="field-end-reason"` in the app-route page.) Keep the "Hangup cause" / "Hangup source" rows: they render "—" once the platform stops sending them, and the fallback rows still have them. Update the section comment: the end reason is the everyday line; cause and source are the deprecated raw pair.

**Step 4: Run** `npx vitest run test/call-detail-page.test.tsx test/calls-page.test.tsx test/campaign-attempts-feed.test.tsx` — PASS. `npx tsc --noEmit` clean.

**Step 5: Commit** — `git commit -m "Show how a call ended from the platform's end_call_reason"` — then PR. Merge after the backend is live.

---

### Task 14: Mock emits it

Paths relative to `.worktrees/end-call-reason/vocobase-mock`.

**Files:**
- Modify: `src/store.ts` (`ScriptRule`: `end_call_reason?: string | null;`; `SimCall`: `endCallReason: string | null;`)
- Modify: `src/routes/calls.ts:~152` (seed from the rule) and `~249` (terminal GET block)
- Modify: `src/webhooks.ts:~86` (completion `call` block) and the status event block (add `end_call_reason: terminal ? reason : null`)
- Test: `test/webhooks.test.ts`, `test/lifecycle.test.ts`

**Step 1: Failing tests.** A scripted `end_call_reason: 'CUSTOMER_HUNG_UP'` appears on the completion's `data.call`, on the terminal status event's `data`, and on `GET /calls/:id`; a live status event carries `end_call_reason: null`; an unscripted call derives a default.

**Step 2: Run, expect FAIL.**

**Step 3: Implement.** Default derivation when the rule sets none, mirroring the platform's fallbacks for a voicelink-shaped call:

```ts
export function defaultEndCallReason(c: Pick<SimCall, 'status' | 'disposition' | 'answeredBy'>): string {
  if (c.disposition === 'voicemail' || c.answeredBy === 'machine') return 'VOICEMAIL';
  switch (c.status) {
    case 'completed': return 'COMPLETED';
    case 'no_answer': return 'NO_ANSWER';
    case 'busy': return 'BUSY';
    case 'canceled': return 'CANCELED';
    case 'failed': return 'NOT_CONNECTED';
    default: return 'UNKNOWN';
  }
}
```

Resolve `endCallReason = rule?.end_call_reason ?? defaultEndCallReason(call)` at the point the call goes terminal, and emit it on the three surfaces as the platform does (`data.call.end_call_reason` on completion; `data.end_call_reason` on status, null unless terminal; `data.end_call_reason` on the GET).

**Step 4: Run** `npx vitest run` — PASS.

**Step 5: Commit** — `git commit -m "Emit end_call_reason on every surface the platform does"`. The mock has no remote (memory); the commit on `main` is the delivery. Remove its worktree afterwards.

---

## Out of scope (deliberately)

- Dropping `hangupCause` / `hangupSource` columns or their readers. They are fallbacks for rows settled before 2026-09-15 and the platform still sends them this release. Revisit when the platform's next release removes the fields: at that point only the fallbacks remain and nothing breaks.
- Re-deriving `disposition` or the analytics buckets from `end_call_reason`. The platform's own design keeps `disposition` as the retry/report driver, and this service's `callOutcome.ts` classifier stays on it.
- Inbound campaign settles (`campaignInbound.ts`) do not read hangup fields today and gain nothing here.
- Treating `SYSTEM_ERROR` as "wallet dry" (D3).

## Follow-up to raise with the platform

`error_code` on `session.completed` / `call.status.updated` / `GET /calls/:id` is documented in this service's `CLAUDE.md` as the platform-fault contract, but the platform's `origin/main` emits it on messaging events only. Ask whether that contract still lands; until it does, `SYSTEM_ERROR` (Task 3) is the fault signal, and it cannot distinguish the wallet case from a restart.
