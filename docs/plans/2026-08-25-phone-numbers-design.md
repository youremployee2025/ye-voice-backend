# Phone numbers — Design

Date: 2026-08-25. Scope: a phone-number (DID) inventory, workspace rental, and the credit ledger that pays for it, across `ye-voice-backend` and `ye-voice-dashboard`.

## What this slice is

YE holds one telephony connection with the voice platform. DIDs are imported or purchased **there**, by an YE super-admin, against that one connection. This slice gives those DIDs a life inside this platform: a local inventory mirroring what the connection owns, a way for a workspace to take one for its own, a monthly price, and a ledger recording every credit that moved.

Four things happen here and nothing else:

1. **Sync.** Staff pull the connection's purchased DIDs into a local `PhoneNumber` table.
2. **Rent.** A workspace ADMIN takes an unowned DID for their workspace. The workspace owner's account is charged the monthly price, immediately and in full.
3. **Renew.** An hourly sweep charges each rented DID again when its renewal date arrives. A balance too short to cover it releases the DID.
4. **Release.** A workspace ADMIN gives a DID back. No refund.

**Renting is internal.** Nothing is bought upstream. `POST /voicelink/dids/map` is never called, no routing is created, no bot is provisioned. A rented DID is a row in our table with a `workspaceId` on it and a charge in the ledger — it is not yet a number that rings. Attaching a DID to an agent or a campaign, so that calls actually arrive on it, is a later slice.

Explicitly out of scope, and deliberately absent from the schema: purchasing or releasing a DID upstream, call routing, inbound webhooks, agent/campaign attachment, proration, refunds, invoices, payment collection, credit top-up, tax, and per-minute call billing. The only credit movement this slice can cause is a DID rental charge.

### Which upstream calls this slice may make

One, and it is a read:

| Call | Used for |
|---|---|
| `GET /voicelink/dids/purchased` | The staff sync. Paged, read-only. |

Everything else on that namespace is off-limits from this code. `POST /dids/map`, `/call-ready`, `/inbound-ready`, `/call-routing`, `/bots`, `/clients` and anything under `/calls` mutate a live telephony account that serves real customers, and none of them is needed to record who owns a number here.

`POST /voicelink/sync` is permitted but not used: it exists to reconcile *upstream's* view of routing and readiness, which this slice has no opinion about. Reading the purchased list is the whole of what the mirror needs, and a read cannot damage the connection.

## Data model

```prisma
enum PhoneNumberStatus     { UNASSIGNED ASSIGNED RELEASED_NONPAYMENT }
enum CreditTransactionType { DID_PURCHASE DID_RENEWAL DID_RELEASE DID_RELEASE_NONPAYMENT ADJUSTMENT }

PhoneNumber        id, did @unique, externalId? @unique, provider?, countryCode?,
                   numberType?, providerStatus?, providerExpiresAt?, rawProvider Json?,
                   status @default(UNASSIGNED), workspaceId?,
                   monthlyPriceCredits BigInt?, rentedAt?, nextRenewalAt?,
                   lastSyncedAt?, createdAt, updatedAt
                   @@index([workspaceId]) @@index([status])
                   @@index([status, nextRenewalAt])

CreditTransaction  id, accountId, workspaceId?, phoneNumberId?,
                   amount BigInt, type, createdAt
                   @@index([accountId, createdAt]) @@index([workspaceId, createdAt])
                   @@index([phoneNumberId])
```

Decisions worth stating:

- **`did` is E.164 and globally unique.** A DID is a real-world telephone number; two rows for the same number is not a tenancy nuance, it is a double-rental waiting to happen. `externalId` — the platform's own DID id, stored as text — is separately unique and is what sync matches on.

- **Sync owns provider facts; renting owns tenancy and billing.** The sync upsert writes `did`, `externalId`, `provider`, `countryCode`, `numberType`, `providerStatus`, `providerExpiresAt`, `rawProvider`, `lastSyncedAt` — and **never** `workspaceId`, `status`, `monthlyPriceCredits`, `rentedAt`, or `nextRenewalAt`. This is the same invariant the agent mirror holds, for the same reason: a refresh that touched assignment would silently un-rent every number a customer is paying for. Here it would also make the ledger a record of charges for nothing.

- **`monthlyPriceCredits` is nullable and means "use the global default".** The purchased-DID payload carries no price at all — the upstream connection knows what YE paid, not what YE charges. Price is therefore ours, set per DID by staff, falling back to `DID_DEFAULT_MONTHLY_PRICE_CREDITS` (default 500 display credits). Null is "not overridden", not "free".

- **`CreditTransaction.workspaceId` is a snapshot, not a join.** The workspace ledger has to stay readable after a DID goes back to the pool, and at that moment `PhoneNumber.workspaceId` is null. Deriving the workspace from the DID would make a workspace's billing history evaporate the day it releases a number — the one moment somebody most wants to read it. So the workspace a charge was made on behalf of is written onto the row.

- **`PhoneNumber.workspaceId` uses `onDelete: Restrict`.** The `Agent` mirror uses `SetNull` because an unassigned agent is a coherent thing. Here `SetNull` would produce a row that is `ASSIGNED` with no workspace — two fields that must agree, silently disagreeing, on the record that says who is paying. There is no workspace-delete route today; `Restrict` means the slice that adds one has to confront the rented numbers explicitly rather than orphan them. A loud failure in a route that does not exist yet beats a quiet inconsistency in the billing table.

- **Five ledger types, not three.** `DID_PURCHASE`, `DID_RENEWAL` and `ADJUSTMENT` carry money. `DID_RELEASE` and `DID_RELEASE_NONPAYMENT` are zero-amount markers recording that a DID left a workspace, and why. They are separate types rather than a zero-amount `ADJUSTMENT` because "the customer gave the number back" and "we took the number away because they could not pay" are different facts, and an audit that cannot tell them apart is not an audit. `ADJUSTMENT` stays reserved for staff credit corrections.

### Credits

Credits are `BigInt` on `Account.credits` with a **10000× internal multiplier**, so 1 display credit is `10000n` and 0.01 display credits is `100n`. `src/lib/credits.ts` owns the conversion in both directions and is the only place the multiplier appears. Every credit value crossing the API is a **decimal string** — `BigInt` is not JSON-serializable, and a float would lose the precision the multiplier exists to protect.

## Renting

`POST /api/workspaces/:workspaceId/phone-numbers/:didId/rent`, ADMIN only.

The whole operation is one `prisma.$transaction`, and every step inside it is a **conditional write** rather than a read followed by a write. That is what makes it safe under concurrency, not the transaction alone — READ COMMITTED lets two transactions both read "unowned" and both proceed.

```
1. read the DID (for its price)                → 404 if it is not in the pool
2. claim it:  updateMany where { id, workspaceId: null }
                     data  { workspaceId, status: ASSIGNED, rentedAt: now,
                             nextRenewalAt: addOneMonth(now) }
              count === 0                       → 409 PHONE_NUMBER_TAKEN
3. debit the owner:
              updateMany where { id: ownerAccountId, credits: { gte: price } }
                     data  { credits: { decrement: price } }
              count === 0                       → 402 INSUFFICIENT_CREDITS  (rolls back step 2)
4. ledger: { accountId: owner, workspaceId, phoneNumberId, amount: -price,
             type: DID_PURCHASE }
```

Step 2's `updateMany` takes a row lock, so of two simultaneous rents exactly one matches and the other sees `count === 0` and gets its 409. Step 3's `gte` guard is what makes a negative balance unreachable: there is no window between checking the balance and spending it.

**The owner pays, not the renter.** An ADMIN who is not the owner can rent; the charge lands on `workspace.ownerAccountId`, because that is the account that holds the workspace's credits. The confirm dialog says whose balance it is.

**Full price at purchase, no proration.** Renting on the 28th costs the same as renting on the 1st. Proration is a pricing decision nobody has made, and inventing one would put an arbitrary rule in the ledger forever.

**`nextRenewalAt` is one calendar month out, day-clamped.** `addOneMonth` clamps to the last day of the target month, so 31 January renews on 28 February (29th in a leap year) rather than overflowing into March, which is what `Date.setMonth` does. A rental that silently skips a month is a month of free service.

## Renewing

`src/services/didRenewal.ts` runs a sweep every hour (`DID_RENEWAL_SWEEP_MS`, default 3600000), started from `src/server.ts` and not from `createApp()` — a test that builds the app must never start a timer that bills people. The interval is `unref`'d so it cannot hold the process open, and one sweep runs at boot so a restart does not cost an hour.

It selects `status = ASSIGNED AND nextRenewalAt <= now` and, per DID, runs the same conditional-write shape:

```
tx:
  claim:  updateMany where { id, status: ASSIGNED, nextRenewalAt: dueAt }
                 data  { nextRenewalAt: addOneMonth(dueAt) }
          count === 0                       → another runner took it; skip silently
  debit:  updateMany where { id: owner, credits: { gte: price } }
          count === 0                       → throw; the transaction rolls back
                                              and the DID is released (below)
  ledger: { amount: -price, type: DID_RENEWAL }
```

The claim compares-and-sets on `nextRenewalAt`, which is what makes the sweep **idempotent**: running it twice, or on two processes, charges once. The spec only requires it to be safe on one process; being safe on N costs one `where` clause and removes a whole class of future incident.

**The next date advances from `dueAt`, not from `now`.** A sweep that was down for three months finds a DID three months overdue, charges one month, and sets the date one month past the old one — so the DID is still due and the next sweep charges the next month. Three months of downtime bills three months, one per hour, in order. Advancing from `now` would silently forgive the gap; charging the whole backlog in one pass would empty an account without warning. One charge per DID per sweep is the bounded, self-healing middle.

### Insufficient balance releases the DID

When the debit finds too few credits the transaction rolls back — nothing charged, `nextRenewalAt` unmoved — and a second transaction releases the number:

```
PhoneNumber: workspaceId → null, status → RELEASED_NONPAYMENT,
             rentedAt → null, nextRenewalAt → null
ledger:      { accountId: owner, workspaceId: <the workspace it left>,
               phoneNumberId, amount: 0, type: DID_RELEASE_NONPAYMENT }
```

The zero-amount row is the point: it is the only durable record that the workspace ever had this number and how it lost it, and it survives on the workspace's ledger because `workspaceId` was captured onto the row.

**A released DID is immediately rentable again.** The available pool is every DID with `workspaceId IS NULL` — `RELEASED_NONPAYMENT` differs from `UNASSIGNED` only in carrying the reason it became free, and renting either one sets `status = ASSIGNED`, clearing the marker. The dashboard badges the reason so a returning renter is not surprised by a number that was pulled from someone last week.

## Releasing

`POST /api/workspaces/:workspaceId/phone-numbers/:didId/release`, ADMIN only. Returns the DID to the pool as `UNASSIGNED` and writes a zero-amount `DID_RELEASE` marker.

**No refund, and the UI says so before the click.** The rental is a month, paid in full at its start; giving the number back partway through does not un-spend it. This is stated in the confirm dialog rather than discovered in the ledger.

## Permissions and isolation

| Action | Owner/ADMIN | MEMBER | Staff |
|---|:---:|:---:|:---:|
| List the workspace's numbers | ✅ | ✅ | ✅ |
| List the available pool | ✅ | ✅ | ✅ |
| Rent / release | ✅ | ❌ | — |
| Read the workspace's billing | ✅ | ❌ | — |
| Sync, assign without charge, set price, list everything | — | — | ✅ |

Workspace routes sit behind `requireMembership()` / `requireMembership('ADMIN')`, which already answers a non-member with 403 — a 404 there would let an outsider probe which workspace ids exist. Staff routes sit behind `requireStaffToken` and the existing `/api/admin` rate limiter.

Inside a workspace, **no query looks a DID up by id alone**. An owned DID is found by `findFirst({ where: { id, workspaceId } })`, so a number belonging to another workspace returns 404 — indistinguishable from one that never existed, which is the fact isolation exists to withhold. The available pool is the one deliberate exception: it is a shared pool, every member of every workspace is entitled to see what is rentable, and it exposes only the number, its price, and why it is free.

**Staff assignment is free.** `POST /api/admin/phone-numbers/:didId/assign` moves a DID to a workspace or back to the pool with **no ledger row and no charge**. It is an operational override — correcting a mistake, seeding a workspace — not a sale, and manufacturing a transaction for it would put fiction in the ledger. Reassigning sets `nextRenewalAt` one month out so the DID re-enters the billing cycle; unassigning clears it. Like the agent pool, unassigning requires an explicit `{ "workspaceId": null }`, so a malformed body cannot silently take a number away from a customer.

## Routes

| Route | Who | Notes |
|---|:---:|---|
| `GET /api/workspaces/:id/phone-numbers` | member | The workspace's own DIDs, with price and next renewal. |
| `GET /api/workspaces/:id/phone-numbers/available` | member | The unowned pool, with price and release reason. |
| `POST /api/workspaces/:id/phone-numbers/:didId/rent` | ADMIN | 409 `PHONE_NUMBER_TAKEN`, 402 `INSUFFICIENT_CREDITS`. |
| `POST /api/workspaces/:id/phone-numbers/:didId/release` | ADMIN | No refund. |
| `GET /api/workspaces/:id/billing` | ADMIN | Owner balance + cursor-paginated ledger for this workspace. |
| `GET /api/admin/phone-numbers` | staff | Everything, with each DID's workspace and renewal state. `?status=` , `?assigned=`. |
| `POST /api/admin/phone-numbers/sync` | staff | Pulls the purchased list. |
| `POST /api/admin/phone-numbers/:didId/assign` | staff | `{ workspaceId }` or `{ workspaceId: null }`. No charge. |
| `PATCH /api/admin/phone-numbers/:didId` | staff | `{ monthlyPriceCredits }`; `null` restores the global default. |

All use the standard envelope. `/phone-numbers/sync` and `/phone-numbers/available` are registered before their `:didId` siblings so Express cannot match the literal word as an id.

New error codes: `INSUFFICIENT_CREDITS` (402) and `PHONE_NUMBER_TAKEN` (409).

## Sync

`GET /voicelink/dids/purchased` returns a doubly-nested envelope — the partner API's `{ success, data }` wrapping the provider's `{ status, message, data: { data: [...], current_page, per_page, last_page, total } }`. The adapter unwraps the outer layer already; `readDidRows` peels the inner one, tolerating the provider's habit of moving the array between `data`, `data.data` and `items`.

Two shape hazards in the payload, both worth naming:

- **`did_number` arrives as a JSON number**, not a string: `919429390403`. Every existing upstream reader takes strings, so a `readDigits` helper accepts either and rejects anything that is not a whole number. The value is then canonicalized by the existing `canonicalizeE164` — the same parser the campaign uploads use, gated on validity. **A row that will not canonicalize is skipped and counted, never stored.** Prepending a bare `+` to whatever arrived would mint a plausible-looking number that fails much later, at dial time, far from the sync that invented it.
- **`expiry_date` is a bare date** (`"2026-08-31"`) and describes the *provider's* rental of the DID to YE. It is recorded as `providerExpiresAt` for staff to read and has nothing to do with `nextRenewalAt`, which is YE's rental to a workspace. Conflating the two would bill customers on the provider's calendar.

The sync upserts on `externalId`. A number re-issued under a new provider id collides with the unique index on `did`; that row is counted as a conflict and reported, not thrown, so one odd number cannot fail the whole run. Rows the provider stops listing are **left alone** — reconciling a DID that vanished upstream while a workspace is paying for it needs a policy nobody has written, and deleting or unassigning it on a guess is the worst available answer. See "Stitch points".

## Dashboard

A **Phone numbers** page under workspace settings, beside Members, with two views on `?tab=`:

- **Your numbers** — a table of the workspace's DIDs: number, price per month, next renewal, and (ADMIN) a Release action behind a confirm dialog that states plainly that there is no refund.
- **Get a number** — the available pool. Each row shows the monthly price; one released for non-payment is badged as such. The Rent action opens a confirm dialog showing **the monthly price and the workspace owner's current balance** side by side, so the decision is made with both numbers visible rather than after the fact.

MEMBERs see both lists read-only, with no Rent or Release control at all — not a disabled one, following the rule the agents surface set: a greyed-out button promises a capability that is coming.

`INSUFFICIENT_CREDITS` and `PHONE_NUMBER_TAKEN` render as curated copy naming what to do — top up, or pick another number. Neither is ever a silent failure or a generic "that did not work". Absent fields render `Not set`; an error state renders the error rather than an empty table, so "no numbers" and "could not load numbers" are never the same picture.

The owner's balance comes from `GET /api/workspaces/:id/billing`, not from the signed-in account's own credits — an ADMIN who is not the owner would otherwise be shown their own balance beside a charge that will not touch it.

## Safety

- **The partner key in `.env` is live.** This slice issues exactly one upstream call, a paged GET. Nothing here writes to the telephony connection.
- **`DATABASE_URL` is local Postgres; production Neon is `PROD_DATABASE_URL` and stays inactive.** The migration is purely additive — three new enums, two new tables, two new relation fields — and adds no column to an existing table. Tests reach only `TEST_DATABASE_URL`, and both `test/setup.ts` and `scripts/test-prepare.mjs` refuse a `neon.tech` host.
- `test/setup.ts`'s truncation list gains `CreditTransaction` and `PhoneNumber`, child-first, or every case after the first sees the previous one's rows.

## Stitch points

Deliberate follow-ups, each small because the schema already anticipates it:

- **Attaching a DID to an agent or campaign.** A rented number does not ring yet. That slice adds the relation and the upstream calls this one refuses to make.
- **Reconciling a DID the provider stopped listing.** Needs a policy for a number a workspace is paying for that no longer exists upstream. `providerStatus` and `lastSyncedAt` are already recorded so the detection is a query, not a re-sync.
- **Deleting a workspace.** `Restrict` will block it while numbers are rented; that slice decides whether deletion releases them or refuses.
- **Credit top-up.** Nothing here adds credits. `ADJUSTMENT` and the staff surface are the seam.
