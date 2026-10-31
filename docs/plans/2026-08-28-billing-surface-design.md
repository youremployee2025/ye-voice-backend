# Customer billing surface — Design

Date: 2026-08-28. Scope: the customer-facing billing page across
`ye-voice-backend` and `ye-voice-dashboard`.

## What this slice is

The phone-numbers slice already put money in the system: `Account.credits`,
the `CreditTransaction` ledger, `src/services/didRental.ts` as the only module
that moves credits, and `GET /api/workspaces/:id/billing`, which today answers
a balance and a cursor page of this workspace's DID rows. It exists to feed one
line of a confirmation dialog.

This slice turns that into a page a customer can actually read: what the
balance is, what has been charged, what is about to be charged, and whether the
balance will cover it. It extends the phone-numbers model; it does not redefine
any part of it.

**There is no payment gateway in this wave.** Credits enter the system only
through a super-admin grant — a staff endpoint the admin-console slice owns.
The customer page therefore has no checkout, no card form, and no buy button,
not even a disabled one. It has a balance, a history, and a way to ask for more.
A greyed-out "Buy credits" would promise a capability that is not coming this
wave, which is the same rule the agents surface set for editing controls.

## What the balance is, and who may see it

The balance shown is the **workspace owner's account balance**, exactly as
`/billing` already reports it. Credits belong to an Account; a Workspace has
none of its own. An ADMIN who is not the owner is shown the owner's number,
labelled as the owner's — the phone-numbers dialog already does this, and for
the same reason: an ADMIN reading their own credits beside charges that will
never touch them is the more expensive confusion.

Visibility follows the permission matrix without inventing a new rule:

| | Owner / ADMIN | MEMBER |
|---|:---:|:---:|
| Balance | ✅ | ❌ |
| Ledger | ✅ | ❌ |
| Billing nav entry | shown | hidden |

The nav entry is hidden rather than disabled. This is a **deliberate departure
from the phone-numbers precedent**, where the link is shown to everyone because
the page beneath it is readable and only its actions are ADMIN. Here the entire
page is ADMIN — a MEMBER following the link would get a 403 and nothing else, so
a visible link would lead only to a dead end. The backend is still the
enforcement point: `requireMembership('ADMIN')` on every route, and the page
renders a refusal rather than a spinner if a MEMBER reaches it by typing the URL.

## The ledger this workspace should see

Today the ledger filter is exactly `CreditTransaction.workspaceId = :id`. That
is right for DID rows and captures nothing else, because the only writer so far
is `didRental.ts`, which always sets the column.

Grants are different. A staff adjustment credits an **Account**; it is not made
on behalf of any one workspace, and the admin endpoint writes no `workspaceId`.
Under the current filter a customer sees every charge and never the top-up that
paid for them — a history whose lines cannot add up to the balance printed above
it. So the filter widens to a disjunction:

```
WHERE  workspaceId = :workspaceId                          -- this workspace's DID rows
   OR (accountId  = :ownerAccountId AND type = 'ADJUSTMENT')   -- grants funding it
```

Three things about that second arm are deliberate and are worth being explicit
about, because each is a small disclosure:

- **It is scoped to the owner's account, not the caller's.** The caller may be
  an ADMIN with credits of their own; those are not this page's subject.
- **An ADMIN of one workspace sees grants that funded another.** An owner with
  three workspaces has one balance, and each workspace's ADMIN already sees that
  balance. Showing the grants that produced it discloses nothing the balance did
  not, and hiding them would leave the same unaccountable history the second arm
  exists to fix. What an ADMIN still cannot see is another workspace's *spending*
  — DID rows stay filtered to their own workspace.
- **`type = 'ADJUSTMENT'` is a whitelist, not a convenience.** A future writer
  that records something else against an Account with no workspace does not
  silently become customer-visible; whoever adds it decides.

The consequence has to be stated on the page rather than left for the reader to
discover: **this list does not reconcile to the balance.** It shows one
workspace's charges against an account-wide balance, so an owner with two
workspaces sees a balance that moves for reasons this page does not list. The
page says so in one line under the table. The alternative — showing every
workspace's charges — would leak one customer team's spending to another's
admin, which is worse than an explained gap.

### `balance_after` is omitted, honestly

The requirement asks for a running balance per row *if cheaply derivable*. It is
not, and the reason is structural rather than a matter of query cost.

`CreditTransaction` stores no balance snapshot, so a running balance can only be
reconstructed by summing. Summing works only over a **complete, contiguous**
series — and this ledger is deliberately neither. It is filtered (one
workspace's DID rows out of an account's), and it is further filterable by type
and date range by the reader. A number computed from a subset would be arithmetic
that does not describe any moment the account was ever in, printed in the column
where a customer is most entitled to take a number literally.

So no `balance_after` field is emitted. Not null, not zero — absent, with the
reason recorded here and a note on the page. A later slice that wants it should
add a `balanceAfter` column written inside the same transaction as the balance
change, which is the only place it can be captured truthfully.

## `note` and `reference`

The requirement asks each row to carry a note/reference. Nothing on `main`
stores one: a grant row today is an amount, a type and a timestamp, so a customer
reading `+500 · ADJUSTMENT` learns the number and nothing about why it arrived.

Two nullable text columns are added — the only schema change in this slice, and
additive:

```sql
ALTER TABLE "CreditTransaction" ADD COLUMN IF NOT EXISTS "note" TEXT;
ALTER TABLE "CreditTransaction" ADD COLUMN IF NOT EXISTS "reference" TEXT;
```

**This slice reads them and never writes them.** The writer is the staff grant
endpoint, which the admin-console slice owns. That split is the point: the
surface that displays a value does not get to invent it, so a row with no note
renders as having no note rather than as a sentence this repo made up.

`IF NOT EXISTS` is not idiomatic Prisma output and is there for one concrete
reason: the admin-console slice is in flight and adds the same two columns for
its own writer. Whichever migration lands second would otherwise fail on a
duplicate column, on the deploy, which is the worst place to find out. Two
migrations that each ensure the same additive shape are safe to apply in either
order. The columns are nullable with no default and no backfill, so applying
this to a populated database rewrites no rows and takes no long lock.

**DID rows get no synthesised note.** A charge for a rental already carries
`phoneNumberId`, and the payload already embeds `{ id, did }` — the dashboard
renders the number itself, which is both more precise and more useful than a
sentence assembled around it. `note` stays null for those rows because nobody
wrote one.

## Route shape: one route becomes two

`GET /api/workspaces/:id/billing` stays, and its response **grows a field
rather than changing one**. The phone-numbers page calls it with `?limit=1`
purely to read `balance`, and that call must keep working unchanged.

The ledger moves to a sibling:

| Route | Role | Answers |
|---|:---:|---|
| `GET /api/workspaces/:id/billing` | ADMIN | balance, owner label, and the 30-day renewal projection |
| `GET /api/workspaces/:id/billing/transactions` | ADMIN | the filtered, paginated ledger |

They are split because they change at different rates and for different reasons.
The balance card is read once per page load; the table re-reads on every filter
click and page step. Serving both from one route would re-query the owner's
account and recompute the projection on every keystroke of a date filter, and —
more to the point — would make a ledger failure take the balance card down with
it, which is the exact failure the phone-numbers page already had to unpick when
billing shared a `Promise.all` with the number lists.

`/billing` keeps its existing `ledger` and `nextCursor` fields, unchanged, so no
consumer breaks. They are marked deprecated in the payload's own documentation
and are the thing a follow-up removes once nothing reads them.

### Pagination: offset, not cursor

The existing ledger is cursor-paginated. The new one is offset-paginated
(`?page=`, `?limit=`), through a shared `src/lib/pagination.ts`.

Cursor pagination is the better tool for an append-only feed being walked
forwards. This is a filterable table with a page control: a reader changes the
type filter and expects to land on page 1 of the new result set, and may want to
jump. A cursor is meaningless across a filter change — it names a row that may
not be in the new set at all — so a cursor API forces the client to reset to the
start on every filter change anyway, while still paying the cursor's cost of not
knowing how many pages there are.

Offset pagination's real weakness is drift under concurrent inserts. Here the
inserts are a customer's own rentals and an hourly sweep, so a page boundary
moving is a row appearing twice across a page step in the rarest case, on a
history that is read and not acted upon.

`total` is returned, so the page can say "Showing 1–25 of 63" rather than
leaving the reader to click until it stops.

`src/lib/pagination.ts` is written to a contract the in-flight admin-console
slice also needs, `{ page, limit, skip, take }` plus a `paginated()` envelope.
If that slice lands first the merge keeps one copy and this route is unaffected,
which is the whole reason for matching its shape rather than inventing a second
pagination vocabulary for the same codebase.

### Filters

- `type` — one `CreditTransactionType`, validated against the enum. An unknown
  value is a 400, not an empty page: a filter that silently matches nothing is
  indistinguishable from a workspace with no history.
- `from` / `to` — ISO dates on `createdAt`, each optional. `to` is inclusive of
  the whole day named: a customer filtering "to 31 March" means through the end
  of 31 March, and a naive `lte` on midnight silently drops that day's rows.
  Interpreted in UTC, the same as every other date in this system.
- `from` after `to` is a 400. It is always a mistake, and an empty table would
  read as "you have no history in this period", which is a different claim.

## Upcoming charges and the shortfall warning

The page shows the DIDs this workspace holds with their next renewal date and
the price each will actually be charged — the snapshot price, `chargePriceOf`,
never today's catalog price. That data comes from
`GET /api/workspaces/:id/phone-numbers`, which the dashboard already consumes
and which already carries `next_renewal_at` and the agreed
`monthly_price_credits`. No new endpoint, no second source of truth for what a
number costs.

The **shortfall warning** — "the balance will not cover the next 30 days of
renewals" — is computed on the backend, in `/billing`, and not in the browser.
Three reasons, in order of weight:

1. It is a money claim. Saying "you are short" to a customer who is not, or
   staying quiet for one who is, are both damaging, and the assertion should be
   tested in the repo that owns the arithmetic and has a database to test against.
2. It is the same sum the renewal sweep will actually perform, so it belongs
   beside that logic rather than in a second implementation that can drift from
   it.
3. Doing it client-side means summing credit strings in JavaScript, and this
   codebase is emphatic that credit values are never parsed into numbers.

So `/billing` gains:

```json
"upcoming": {
  "window_days": 30,
  "renewal_count": 3,
  "total_credits": "1500",
  "covers": false,
  "shortfall_credits": "200"
}
```

Computed in internal BigInt units and emitted as decimal strings, through
`toDisplayCredits`, like every other credit value that crosses the API.

What it counts, precisely, and why each choice:

- Every DID with `workspaceId = :id`, `status IN (ASSIGNED, PAST_DUE)` and
  `nextRenewalAt` within the window, at `chargePriceOf` each. The `status`
  filter mirrors the sweep's exactly; filtering on the workspace alone selects
  the same rows today, but only because every release path nulls `workspaceId`
  in the same statement that sets a terminal status, and no column enforces
  that.
- **Each number counts once, and that is an approximation in two directions.**
  It was originally justified as "a number renewing twice in 30 days is
  impossible on a monthly cycle", which is false for a backlog: the sweep
  advances `nextRenewalAt` from `dueAt` rather than from `now` and charges one
  month per pass on an hourly timer, so a DID three months overdue is charged
  three times within three hours and this counts it once. In the other
  direction, a `PAST_DUE` number past the end of its grace window is *released*
  rather than charged, and this bills it. Both errors are bounded by one
  month of one number's price, and in both cases the headline the projection
  gives — the balance is short — is the correct one.
- **`PAST_DUE` numbers are included.** Their `nextRenewalAt` is unmoved by a
  declined charge — that is what makes the sweep retry the same month — so they
  are already in the window by date. They are also the strongest evidence that
  the balance is short, and excluding them would quietly drop the one case the
  warning exists for.
- A DID with a null `nextRenewalAt` is excluded and **counted separately** as
  `unscheduled_count`. That state means staff assigned a number without starting
  a cycle, or a row predates the column; either way this slice does not know when
  it will next be billed, and folding an unknown into a total presents a guess as
  a sum.
- `covers` is decided in BigInt against **`account_total_credits`**, not against
  this workspace's `total_credits`. One account funds every workspace it owns
  from one balance, so a per-workspace comparison answers a question nobody
  asked: with 1000 credits and two workspaces each renewing 800 next week, both
  pages report `covers: true` while the account is 600 short and the sweep is
  about to decline one of them. `shortfall_credits` is present only when
  `covers` is false, and is `account_total - balance`.
- `total_credits` stays scoped to this workspace, because it is the figure the
  dashboard's table of rows has to sum to. `account_total_credits` is the same
  window across every workspace the owner account owns, and equals
  `total_credits` whenever the owner has one workspace — which is the common
  case, so a surface can show the second figure only when the two differ.

30 days is a fixed window in this slice and is stated in the payload rather than
assumed by the reader, so a later slice can widen it without the dashboard
silently mislabelling the number.

It is worth being explicit that 30 days is **not** the billing period. Renewal
dates come from `addOneMonth`, which is calendar-aware, so a number rented
during a 31-day month renews one day past this horizon and is outside the
window from the moment it is rented. The window is a conservative "what is
definitely coming" rather than a billing cycle, and the consequence is that the
total can under-report by up to one month of one number. Any surface listing
the underlying rows must filter them to this same horizon, or its rows will not
sum to the total it prints beneath them.

## What the dashboard renders

A new `/settings/billing`, ADMIN-only, in the settings group of the sidebar.

- **Balance card** — the owner's balance in display credits, labelled as the
  owner's. Beside it, "contact us to top up": a `mailto:` to a configured
  support address. Text and a link, not a button styled like a purchase.
- **Upcoming charges** — the DIDs renewing in the next 30 days with their dates
  and prices, and the total. When `covers` is false, a warning naming the
  shortfall sits above it, not below: a customer who scrolls past the table has
  missed the one thing on the page that needs an action.
- **Transactions** — a table with type badges, the signed amount, the date, the
  note or the DID as the reference, and the type / date-range filters over
  server-side pages.

Three renderings that are never conflated, following the rule the phone-numbers
page set: a failed request offers a retry and never reads as "you have no
history"; an empty ledger says so plainly; a loading state is neither. The
balance card, the upcoming table and the transactions table each own their
loading and error state, so one failure does not blank the page.

Signed amounts are rendered from the string the backend sent, never parsed. A
negative amount is shown with its sign **and** a word — colour never carries the
meaning alone, which is the same rule `status-pill.tsx` follows.

## Not in this slice

- Any payment gateway, checkout, invoice or receipt.
- A `balanceAfter` column, and therefore a running balance.
- Writing `note` or `reference` — the admin-console slice owns the writer.
- Exporting the ledger to CSV.
- Any Vocobase call. This surface makes none; every number on it comes from
  local tables.
