# Onboard Customer and Transfer Account — design

Two staff operations that today take a person half an hour of careful clicking
across five pages, and that nobody can perform without knowing which order the
writes go in.

- **Onboard** turns an email address into a customer who can dial: an account,
  a workspace they own, the agents and numbers they were sold, a balance, and
  a tier.
- **Transfer** moves an entire book of business from one account to another —
  when a customer changes the address they sign in with, or one entity buys
  another.

Both are single API calls that either happen entirely or not at all. That is
the point of building them: assembled by hand out of the existing endpoints,
each is six writes with no transaction around them, and the half-finished
states are all silent. A workspace whose owner has no membership row cannot be
opened by its owner. An agent assigned to a workspace whose account was never
credited cannot place a call. Nothing in the console says either is wrong.

## Feature 1 — Onboard

`POST /api/admin/customers/onboard`

```
email, workspaceName, agentIds[], phoneNumberIds[], credits, tierId?
```

### The Clerk step happens before the transaction

`Account.clerkUserId` is `@unique` and not nullable, so an Account cannot exist
before a Clerk identity does. Onboarding therefore resolves Clerk first:
look the address up with `getUserList`, create the user if it is not there,
and take the id.

That call is deliberately **outside** `$transaction`. A Clerk round trip is
tens to hundreds of milliseconds and can time out; run inside the transaction
it would hold row locks on `Account` for its whole duration, and every
concurrent call charge against that account would queue behind an HTTP request
to a third party. The account resolution is idempotent, so doing it first and
failing later costs nothing worse than a Clerk user with no workspace — which
the next attempt with the same address adopts rather than duplicating.

An address that already has an Account skips Clerk entirely. That is the common
case: adding a second workspace to a customer who already exists.

### Everything else is one transaction

In order, and each of them a conditional write rather than a check followed by
a write:

1. **Workspace.** `uniqueSlug` runs against the transaction's client, not the
   global one — read on one connection and written on another, two concurrent
   onboards of "Moomba Foods" both see `moomba-foods` free and the second gets
   a foreign-key-shaped 500 instead of a sentence. `P2002` on the slug is
   translated to a 409 that says to retry.

2. **Membership.** The owner is also an `ADMIN` member, because every
   permission check downstream is a plain membership lookup. This is the row
   whose absence is invisible: the workspace exists, the account owns it, and
   the customer's dashboard shows them nothing.

3. **Agents.** `updateMany({ where: { id: { in: ids }, workspaceId: null } })`
   and then an assertion on `count`. Reading the agents first and checking they
   are unassigned tests a value that is already stale by the time it is used —
   the same reasoning `accounts.routes.ts` sets out for balances. The `WHERE`
   clause is the test, and a count below the requested length means somebody
   else took one, which fails the whole request.

4. **Phone numbers.** The same conditional write per number, writing the field
   set `assignPhoneNumber` writes — including `rentedPriceCredits: priceOf(row)`
   and `nextRenewalAt`. Skipping those would hand the customer a number the
   renewal sweep never charges for and never renews. Onboarding assigns only
   numbers in the pool, so there is no rental to end and no `DID_RELEASE` row
   to write; the staff assign route keeps that job.

   **No charge is raised for the DIDs.** Staff assignment has never charged —
   it is an operational act, not a sale — and the first renewal a month from
   now is where the customer starts paying. The onboarding credit is what
   covers it.

5. **Credits.** An atomic `increment` plus an `ONBOARDING_TOPUP` ledger row in
   the same transaction, so there is no path that moves a balance without
   recording why.

6. **Tier.** An `AccountTier` upsert, refused if the tier is not `ACTIVE` — a
   retired tier cannot be assigned to anybody, which is the rule the tiers route
   already enforces.

## Feature 2 — Transfer

```
GET  /api/admin/account-transfers/preview?sourceAccountId=&destinationAccountId=
POST /api/admin/account-transfers
```

Preview and commit call the same `describeTransfer()`. Two code paths would let
the confirm step promise something the write does not do, and the confirm step
is the only protection this endpoint has.

### What moves

`Workspace.ownerAccountId` is the hinge. Campaigns, contacts, agents, DIDs,
call attempts and everything else workspace-scoped move because they were never
attached to the account in the first place — they hang off the workspace, and
the workspace changed hands. Only four things need writing:

- **Workspaces** — `ownerAccountId` updated for every one the source owns.
- **Membership** — the source's rows on those workspaces are deleted and the
  destination gets `ADMIN` on each. `upsert`, not `create`: the destination may
  already be a `MEMBER` of a workspace it is about to own, and `create` would
  fail on the composite unique. The upsert promotes.
- **Credits** — the whole balance, by compare-and-set:
  `where: { id, credits: exactBalanceRead }`. A `count` of 0 means the balance
  moved between the read and the write — a call settled, a top-up landed — and
  that is a 409, not a transfer of the wrong number. Two ledger rows,
  `ACCOUNT_TRANSFER_OUT` and `ACCOUNT_TRANSFER_IN`, each naming the other
  account. A zero balance writes no rows: a ledger of zero-amount markers for
  nothing is noise in the one place noise is expensive.
- **Tiers** — `AccountTier` rows move by `accountId`, except where the
  destination already holds that tier. Those stay on the source untouched.

### What does not move, and why it is stated rather than assumed

- **The ledger.** `CreditTransaction.account` is `onDelete: Restrict` precisely
  so an account's financial history survives everything; rewriting history so a
  charge appears to have been incurred by an account that did not incur it is
  the opposite of what an append-only ledger is for. The two transfer rows are
  what connect the halves, which is why they carry the other party's address in
  the note.
- **`Account.concurrencyLimit`.** It is this account's slice of the platform's
  call pool — a commercial arrangement with the account, not a property of the
  workspaces. The destination keeps its own. The preview says so, because
  transferring a busy book of business onto an account allotted three lines is
  a real way to make a working customer stop working, and the operator should
  learn it here rather than from the dialer.
- **The source account itself.** It stays, with no workspaces and no balance.
  It still exists in Clerk and the person can still sign in; they simply have
  nothing. That is the intended end state, not a leak.

### What the operator is told before agreeing

The preview names both addresses and counts workspaces, agents, phone numbers,
campaigns and contacts, states the credit amount in display units, and lists
the tiers that will stay behind. Then a checkbox, then a confirm dialog with a
typed confirmation — the transfer cannot be undone by clicking the same control
again, which is exactly the case `ConfirmDialog`'s `confirmWord` exists for.

## Ledger types

Three values are added to `CreditTransactionType`:

| Type | Sign | Written by |
|---|---|---|
| `ONBOARDING_TOPUP` | positive | the onboard endpoint |
| `ACCOUNT_TRANSFER_OUT` | negative | the transfer endpoint, on the source |
| `ACCOUNT_TRANSFER_IN` | positive | the transfer endpoint, on the destination |

`ADJUSTMENT` was the alternative for all three, and it is wrong for the same
reason `CALL_USAGE_SHORTFALL` is not a zero-amount `CALL_USAGE`: "staff
corrected this balance" and "this balance moved to another account" are
different facts, and a billing page that cannot filter one from the other
cannot answer where a customer's credits went. The enum's own comment
anticipates this — the full set is declared up front so later slices add rows
rather than rename values in place.

`ALTER TYPE ... ADD VALUE` is additive and takes no table lock; the existing
rows are untouched.

## Console

Two pages under Accounts, both server components with server actions, so the
staff token stays in its httpOnly cookie and no API response reaches the browser
that the reader was not sent.

| Route | Reads | Writes |
|---|---|---|
| `/accounts/onboard` | `agents?assigned=false`, `phone-numbers?assigned=false`, `tiers` | `POST /customers/onboard` |
| `/accounts/transfer` | `accounts` (both pickers) | preview, then `POST /account-transfers` |

Both pickers say how many of how many they are showing, because the accounts
listing is capped at a page and an account missing from a picker reads as an
account that does not exist.

`billing/filters.tsx` gains the three new types. Its comment claims to list
every type the ledger can hold and it has been wrong since call billing landed
— `CALL_USAGE`, `CALL_USAGE_SHORTFALL`, `TEST_SESSION_USAGE` and
`TEST_SESSION_SHORTFALL` are all missing, so a staff member filtering for call
charges is told there are none. Fixed here rather than left further behind.
