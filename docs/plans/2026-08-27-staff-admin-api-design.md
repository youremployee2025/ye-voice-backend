# Staff Admin API — Design

The console YE's own operators use needs a read model of the whole platform
and exactly one write: a credit correction. This slice adds both to the
existing `/api/admin/*` surface.

## Scope

| Route | What |
|-------|------|
| `GET /api/admin/overview` | platform counts for the console home |
| `GET /api/admin/accounts` | paginated account list, `?search=` by email/name |
| `GET /api/admin/accounts/:id` | one account: owned workspaces, memberships, balance, recent ledger |
| `POST /api/admin/accounts/:id/credits` | signed credit correction |
| `GET /api/admin/workspaces` | paginated workspace list with counts |
| `GET /api/admin/workspaces/:id` | one workspace: members, agents, campaigns, DIDs |
| `GET /api/admin/credit-transactions` | global ledger, `?accountId=`, `?type=` |

Out of scope: suspension, deletion, editing an account or workspace, anything
that calls the voice platform. This slice never makes an upstream request.

## Prefix, not a new one

The staff surface is `/api/admin/*` and stays there. It already carries the
`X-Admin-Token` guard (`src/middleware/adminToken.ts`) and the rate limiter
mounted ahead of it in `src/app.ts`, and a second prefix would inherit
neither — a limiter that caps token guessing on half the endpoints caps
nothing. New routers mount under the same `app.use('/api/admin', …)` chain, so
a route added later cannot forget the guard by forgetting the prefix.

## Pagination

`?page=` (1-based) and `?limit=` (default 25, max 100), answered as
`{ items, page, limit, total }`. Offset paging, not a cursor: these lists are
staff-facing, sorted by `createdAt desc`, and small enough that the cost of a
`COUNT(*)` is worth being able to show "1,284 accounts". An out-of-range page
is an empty `items`, not a 404 — page 9 of a list that just shrank to 3 pages
is a stale link, not a mistake worth an error.

`?search=` on accounts matches email or name, case-insensitively, as a
substring. It is `contains`, not a prefix match: staff paste a fragment of an
address as often as its start.

## Credits

`CreditTransaction` arrives with this slice because the console cannot show a
balance it has no way to explain. It is deliberately the same shape the
phone-numbers slice defines, so the two can merge rather than compete:

```
CreditTransaction  id, accountId, amount BigInt (signed), type, reference?,
                   note?, createdAt
```

- **Signed amount, internal units.** Negative is a deduction. Credits are
  BigInt with the 10000x multiplier (`src/lib/credits.ts`), so the wire format
  is a decimal string in both directions — a float loses the hundredths on the
  one value where that is a billing dispute.
- **Append-only.** No update or delete route exists, and `onDelete: Restrict`
  on the account relation means deleting an Account cannot silently erase its
  financial history.
- `type` is `CreditTransactionType`; this slice writes only `ADJUSTMENT`.
- `note` is required by the *route*, not the column: every staff correction
  must say why, but the column stays nullable so machine-written rows (a DID
  charge, a call) need not invent one.
- `reference` is a free identifier for whatever occasioned the row — an
  invoice number, a ticket. Nullable and unconstrained on purpose.

**The write.** `POST /api/admin/accounts/:id/credits` takes
`{ amount, note, reference? }` where `amount` is a signed decimal string. The
balance change and the ledger row happen in one `prisma.$transaction`; there is
no path that writes one without the other. A deduction larger than the balance
is a **422 `INSUFFICIENT_CREDITS`** — the balance is never driven negative, and
the check happens inside the transaction against the row it is about to update,
so two concurrent deductions cannot both pass it.

**Merge note.** The phone-numbers branch (`feat/phone-numbers`) introduces this
same model, its own `CreditTransactionType` values, and `src/lib/credits.ts`.
Whichever lands second must reconcile: keep the union of the enum values, keep
both sets of columns (`workspaceId`/`phoneNumberId` from that branch,
`reference`/`note` from this one), and collapse the two `credit_transactions`
migrations into one — running both would fail on `CREATE TABLE`.

## Counts, cheaply

The overview and the two list endpoints need counts, not rows. They use
`groupBy`/`count` rather than loading and measuring in JS: a workspace list
that loaded every agent to call `.length` on it grows with the platform and
not with the page. `_count` on a relation gives the per-row counts in the same
query as the page.

Credits outstanding is `aggregate({ _sum: { credits } })` over accounts, sent
as a display string like every other credit value.

## What staff may see

Everything. These routes serve operators of the platform, so the projections
are wide where the customer ones are narrow — an account's Clerk user id and
an agent's upstream id are exactly what staff need to match a row here against
a row in another console. That is why they sit behind their own guard, and why
none of these serializers may be reused by a workspace route.
