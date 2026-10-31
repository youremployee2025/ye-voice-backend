# Platform wallet: top up from the staff console

**Date:** 2026-09-07
**Repos:** `ye-voice-backend`, `ye-voice-admin`
**Source contract:** Vocobase V2 Billing, "Payment Links integration guide" (September 2026), backend PR #532

## What this is

YE's calling capacity is paid for out of one Vocobase partner wallet. Today,
adding money to that wallet means leaving the staff console and doing it on
Vocobase. This gives the console a **Platform wallet** page that shows the
wallet balance, warns when it is critically low, mints a Razorpay payment link
for a chosen amount, and watches the link until the money lands.

It is deliberately separate from `/billing`, which is YE's own ledger of what
YE's customers hold. This page is about what YE holds with its supplier. The
two never share a table, a route, or a page.

## What the supplier gives us

Four endpoints on `https://api.vocobase.com/api/v2`, all with the partner key
we already hold. No Razorpay credentials, no webhook, no new environment
variables on the supplier side.

| Call | What |
|------|------|
| `GET /billing/topup/config` | `{ presets, min, max, gst_rate_bps }` — the allowed range and preset amounts |
| `POST /billing/topup/quote` | `{ amount_rupees }` → `{ base, gst, total }`; pure math, 60/hour |
| `POST /billing/topup/links` | `{ amount_rupees }` → `201 { payment_order_id, short_url, expires_at, base, gst, total }`; 10/hour |
| `GET /billing/topup/links/{id}` | `{ status, credited_at, ... }`; another account's id is a 404 |

Plus `GET /billing/balance`, which the backend has never called until now.

Status is one of `CREATED`, `ATTEMPTED`, `FAILED` (not final; the payer can
retry), `CREDITED` (the only status that means money moved), `EXPIRED`,
`MISMATCH`. `CREDITED`, `EXPIRED`, `MISMATCH` are terminal.

Facts that shape the design:

- **There is no callback.** Polling is the contract. Every 30 to 60 seconds,
  stop on a terminal status or once `expires_at` has passed on our own clock.
  The supplier flips to `EXPIRED` on an hourly sweep, so a link can read
  `CREATED` for up to an hour after it expired.
- **A missed supplier webhook is caught hourly.** "Paid but not credited after
  90 minutes" is the thing to escalate; five minutes is not.
- **At most 5 links may be open** (unpaid, unexpired, not yet attempted). The
  sixth is a `409 OPEN_ORDER_LIMIT`. The right response is to show the open
  links, not an error.
- **The link always credits YE's wallet.** It must never be forwarded to an
  YE customer as a way to bill them.
- **Amount is a JSON number**, a whole rupee, inside `min..max`. A string is a
  `400 INVALID_AMOUNT`.

## Backend (`ye-voice-backend`)

### Adapter

Five functions in `src/adapter/vocobase.ts`, in a new "Billing" block:

```ts
getBalance(): Promise<BalanceResponse>            // GET /billing/balance
getTopupConfig(): Promise<TopupConfigResponse>    // GET /billing/topup/config
quoteTopup(amountRupees): Promise<TopupQuote>     // POST /billing/topup/quote
createTopupLink(amountRupees): Promise<TopupLink> // POST /billing/topup/links
getTopupLink(id): Promise<TopupLinkStatus>        // GET /billing/topup/links/:id
```

`unwrap` maps every upstream 409 to `NAME_TAKEN`. That is wrong for
`createTopupLink`, where a 409 is `OPEN_ORDER_LIMIT` and the console must act
on it. The adapter gains one bounded, opt-in option on `RequestOptions`:

```ts
/** Opt-in: an upstream 409 carrying this code passes through under this
 *  code, rather than being read as a name collision. */
conflictCode?: 'OPEN_ORDER_LIMIT';
```

`OPEN_ORDER_LIMIT` is added to `ErrorCode`. Every other status keeps the
existing mapping: 400 passes through as `VALIDATION_ERROR` with the upstream
message (that is how `INVALID_AMOUNT` reaches a caller who bypassed the
console), 404 passes through, 429 is `UPSTREAM_RATE_LIMITED`, the two 502s
(`RAZORPAY_LINK_CREATE_FAILED`, `PAYMENT_ORDER_PATCH_FAILED`) collapse to
`UPSTREAM_ERROR`. Both of those mean "try again", so the console does not need
to tell them apart.

### Schema

```prisma
enum PlatformTopupStatus {
  CREATED
  ATTEMPTED
  FAILED
  CREDITED
  EXPIRED
  MISMATCH
}

/// A payment link minted against the supplier wallet. One row per link;
/// the supplier is the source of truth for status, this is the mirror the
/// console reads so a reload or a second operator does not lose the URL.
model PlatformTopup {
  id             String              @id @default(uuid())
  paymentOrderId String              @unique
  shortUrl       String
  amountRupees   Int                 // base: what lands in the wallet
  gstRupees      Int
  totalRupees    Int                 // what the payer is charged
  status         PlatformTopupStatus @default(CREATED)
  expiresAt      DateTime
  creditedAt     DateTime?
  createdAt      DateTime            @default(now())
  updatedAt      DateTime            @updatedAt

  @@index([status, expiresAt])
}
```

No `createdBy`: staff auth is one shared token and there is no per-person
identity to record. The row exists so the console survives a reload and so two
operators see the same link.

The table joins `TABLES` in `test/setup.ts` so the suite resets it.

### Service: `src/services/platformWallet.ts`

```ts
readWallet(thresholdInr: number): Promise<{ balance_inr: number; low: boolean; threshold_inr: number }>
createTopup(amountRupees: number): Promise<PlatformTopup>
refreshTopup(row: PlatformTopup, now?: Date): Promise<PlatformTopup>
refreshOpenTopups(now?: Date): Promise<{ refreshed: number; credited: number; expired: number; failed: number }>
```

- `createTopup` calls `createTopupLink` and writes the row. A 409 from upstream
  propagates as `OPEN_ORDER_LIMIT`. **It does not range-check the amount**: the
  route's zod schema enforces a positive integer, and the range is upstream's
  to own, because a copy of `min`/`max` here would drift from the config the
  form was built against. An out-of-range amount is upstream's
  `400 INVALID_AMOUNT`, which reaches the caller as `VALIDATION_ERROR` with the
  upstream wording.
- `refreshTopup` returns the row unchanged if terminal. Otherwise it reads the
  live status and writes `status` and `creditedAt`, under a predicate that
  makes the write a no-op if another poller has settled the row in the
  meantime — three things poll the same row and a slow one must not clear a
  `creditedAt` a fast one wrote. A 404 from upstream marks the row `EXPIRED`
  and logs it: the link is gone on their side and there is nothing to poll.
- **A row past `expiresAt` settles on that pass, but is read first.** Stopping
  on our own clock is right, because the platform's `EXPIRED` lags by up to an
  hour. Writing the terminal status *without asking* is not: a payment landing
  in the last poll interval would be recorded permanently as unpaid, and the
  operator, shown "expired, create a new link", pays a second time. So the
  read happens, `CREDITED` and `MISMATCH` survive the expiry, and everything
  else past it — including a read that fails outright — becomes `EXPIRED`.
- `refreshOpenTopups` loads every non-terminal row, refreshes each in turn, and
  returns counts. Note the supplier's ceiling of 5 counts links that are open
  (unpaid, unexpired, **not yet attempted**), which is not the same set as
  "non-terminal": an `ATTEMPTED` or `FAILED` row is still polled and does not
  count against that 5. The real bound is the links minted in the last 24 hours
  that have neither credited nor passed their expiry.
- `readWallet` takes the threshold as an argument rather than reading `env`
  itself — the route injects `env.walletLowBalanceInr` — so the service stays
  testable without env juggling. It calls `getBalance`, reads `credits` (or
  `balance`) as INR, and compares to that threshold. It throws if the balance is not a
  finite number: a wallet that reports "0" when the supplier is misbehaving is
  the one answer this must never give.

### Routes: `src/routes/admin/wallet.routes.ts`

All behind `requireStaffToken`, composed into `adminRoutes` like every other
staff router. Snake_case on the wire, as the rest of the staff surface.

| Route | What |
|-------|------|
| `GET /api/admin/wallet` | `{ balance_inr, low, threshold_inr }`. Upstream failure is a 502; the console tolerates it. |
| `GET /api/admin/wallet/topup-config` | pass-through of the supplier config |
| `POST /api/admin/wallet/topup-quote` | `{ amount_rupees }` → `{ base, gst, total }` |
| `POST /api/admin/wallet/topups` | `{ amount_rupees }` → `201` with the row. 409 `OPEN_ORDER_LIMIT` passes through. |
| `GET /api/admin/wallet/topups` | 20 most recent rows, newest first, each refreshed if non-terminal |
| `GET /api/admin/wallet/topups/:id` | one row, refreshed if non-terminal. `:id` is `payment_order_id`. 404 if unknown. |

Amount validation is a zod schema: `z.number().int()`. A string amount is a
400 `VALIDATION_ERROR` here, before any upstream call, so the console can
never send the shape the guide warns about.

Serialised row:

```json
{
  "payment_order_id": "...", "short_url": "https://rzp.io/i/...",
  "amount_rupees": 5000, "gst_rupees": 900, "total_rupees": 5900,
  "status": "CREATED", "expires_at": "...", "credited_at": null,
  "created_at": "...", "updated_at": "..."
}
```

### Threshold

`WALLET_LOW_BALANCE_INR`, default `25000`, floor `0`, read through the
existing `count()` helper in `src/lib/env.ts` and documented in
`.env.example`. The backend returns `low` and `threshold_inr`; the console
never hardcodes a rupee figure.

### Background poll

A new maintenance job kind `wallet-topup-poll`, repeatable id
`maintenance-wallet-topup-poll`, every `WALLET_TOPUP_POLL_MS` (default
120000, floor 30000). It calls `refreshOpenTopups` and logs a line only when
something changed. Ungated: it places no call and spends no credit, and a
link paid overnight should read `CREDITED` before anyone opens the console.

There is nothing to do on `CREDITED` beyond writing the row. The dial engine
reads the supplier's answer live on every attempt, and a campaign that halted
on `CREDIT_EXHAUSTED` is restarted by its owner through the existing lifecycle,
which re-checks balance at start.

## Console (`ye-voice-admin`)

### `/wallet` — Platform wallet

A new sidebar entry after Concurrency. Server component page, following
`/concurrency`: it reads `GET /api/admin/wallet`, `.../topup-config` and
`.../topups` in parallel, tolerates `RouteNotServedError` on all three with a
`PendingRoute` panel, and lets any other error reach `error.tsx`.

Sections, top to bottom:

1. **Balance.** The wallet balance in rupees. When `low` is true, a danger
   panel above it: **"Wallet balance is critically low"**, the balance and the
   threshold in words, and what stops when it hits zero (every campaign on the
   platform halts on `CREDIT_EXHAUSTED`). If the balance read failed, the tile
   says the supplier did not answer, never `₹0`.
2. **Add money.** A client component `<TopupForm>`:
   - Preset buttons from config, a rupee input, and a live quote line
     *"Payer is charged ₹5,900 (₹5,000 + ₹900 GST). ₹5,000 is added to the
     wallet."* The quote comes from a server action, debounced 300ms, and only
     for a whole number inside the range; out-of-range shows the range instead
     of calling.
   - **Create link** calls the `createTopup` server action. On success the form
     is replaced by the link view. On `OPEN_ORDER_LIMIT` it renders the open
     links from the list with expiry and a **Pay** button each, and a one-line
     explanation that the supplier allows five open links.
3. **Link view** (`<TopupWatch>`): the URL in a copyable field, **Open payment
   page**, the expiry time, a `StatusPill` for the status. A client-side
   interval calls the `pollTopup` server action every 30 seconds while the
   status is non-terminal and `expires_at` is in the future. On `CREDITED`:
   positive pill, *"₹5,000 added to the wallet"*, and `router.refresh()` so
   the balance tile updates. On `EXPIRED` or `MISMATCH`: danger pill, one
   line each, **Create a new link**. `MISMATCH` shows the `payment_order_id`
   and `support@vocobase.com`. A poll error keeps the last known state and
   says the check failed; it does not stop polling.
4. **Recent top-ups.** A `TableFrame` of the 20 most recent rows: created,
   amount, total charged, status, expiry, credited. Empty state says no link
   has been minted yet.

Consequences stated before the click, per the console's rule: the create
button reads **"Create ₹5,900 payment link"**, and the panel above it says
the link credits YE's platform wallet and must not be sent to a customer.

### Low-balance banner, every page

`app/(console)/layout.tsx` reads `GET /api/admin/wallet` and, when `low` is
true, renders a slim danger banner above `{children}` on every console page:
*"Platform wallet is critically low: ₹18,400 of ₹25,000. Add money"*, linking
to `/wallet`. The read is wrapped so any failure (unserved route, supplier
down, 502) renders nothing. A console that cannot reach the supplier must
still let staff do everything else.

### Types and server actions

`lib/types.ts` gains `Wallet`, `TopupConfig`, `TopupQuote`, `TopupStatus`,
`TopupRow`. `app/(console)/wallet/actions.ts` exports `quoteTopup`,
`createTopup`, `pollTopup`, each returning an `ActionResult`-shaped value with
the data or a user message, following `concurrency/actions.ts`. The staff
token never reaches the browser: the client components only ever call server
actions.

## Errors, end to end

| Upstream | Backend | Console |
|----------|---------|---------|
| 400 `INVALID_AMOUNT` | 400 `VALIDATION_ERROR` (message passes through) | Should be unreachable; form validates against config. Shown as the field error if it happens. |
| 409 `OPEN_ORDER_LIMIT` | 409 `OPEN_ORDER_LIMIT` | Open-links list, not an error |
| 502 either code | 502 `UPSTREAM_ERROR` | "The voice platform could not create the link. Try again in a moment." |
| 404 on poll | row marked `EXPIRED`, 200 | Danger pill, "Create a new link" |
| 429 | 429 `UPSTREAM_RATE_LIMITED` | "Too many requests to the voice platform. Wait a minute." |
| balance read fails | 502 | Tile says unavailable; banner renders nothing |

## Testing

**Backend (vitest, supertest, adapter mocked as in `admin-concurrency.test.ts`):**

- `test/admin-wallet.test.ts`: every route rejects without the token; wallet
  returns `low` correctly on each side of the threshold; config and quote pass
  through; create writes a row and returns 201; a string amount is a 400 with
  no upstream call; upstream 409 surfaces as `OPEN_ORDER_LIMIT`; list returns
  newest first and refreshes non-terminal rows only; poll refreshes, writes
  `creditedAt` on `CREDITED`, marks past-expiry `EXPIRED` without an upstream
  call, 404s an unknown id.
- `test/platform-wallet.test.ts`: `refreshTopup` on each status transition,
  upstream 404 → `EXPIRED`, `refreshOpenTopups` counts.
- `test/queue-repeatable.test.ts`: the new scheduler registers once and does
  not double-register.
- `test/vocobase-adapter.test.ts` (or the existing adapter suite): the
  `conflictCode` option passes a 409 through under that code and is inert for
  every other status.

**Console (vitest + testing-library, as `credit-form.test.tsx`):**

- `test/topup-form.test.tsx`: presets fill the input; the quote line renders
  from the mocked action; out-of-range shows the range and calls nothing; a
  successful create swaps to the link view; `OPEN_ORDER_LIMIT` renders the
  open-links list.
- `test/topup-watch.test.tsx`: polls on an interval with fake timers, stops on
  a terminal status and past expiry, renders each terminal state's copy.
- `test/low-balance-banner.test.tsx`: renders when low, renders nothing when
  not low or when the wallet is null.

**Manual, before go-live (real money):**

1. Confirm with the Vocobase team that backend PR #532 is deployed.
2. Create a ₹1,000 link: base 1000, gst 180, total 1180, expiry about 24h out.
3. Pay by UPI. Poll: `CREDITED` within a minute; balance rose by exactly ₹1,000.
4. Second link, fail a card on purpose, then pay: `FAILED` then `CREDITED`, one credit.
5. Five open links, try a sixth: the console shows the list, not an error.
6. Reload `/wallet` mid-payment: the link and status survive.
7. Set `WALLET_LOW_BALANCE_INR` above the balance on a dev backend: the banner appears on every page and the danger panel on `/wallet`.

## Deliberately not here

- **Per-operator attribution.** There is no staff identity to record.
- **A customer-facing top-up.** This credits YE's wallet only. YE's
  customers are billed through `/billing` and the account ledger.
- **Automatic campaign restart on `CREDITED`.** The dial engine already reads
  the supplier live; halted campaigns are restarted by their owners.
- **Cancelling a link.** The supplier offers no call for it; links expire in
  24 hours.
- **A cache of the balance.** The wallet route is read on `/wallet` and once
  per console page render for the banner. That is a handful of reads a minute
  at staff-console traffic, well under the shared rate limit.
