# Voice tiers and per-minute rates — Design

Date: 2026-08-29. Scope: the tier catalog, its pricing, its assignment to
accounts, and the entitlement it grants — across `ye-voice-backend`,
`ye-voice-dashboard` and `ye-voice-admin`.

## What this slice is

The wallet already exists. `Account.credits`, the append-only
`CreditTransaction` ledger, the customer billing page and the staff credit
adjustment all shipped in earlier slices, and `src/services/didRental.ts` is
still the only module that moves a balance.

This slice puts a **price list** beside that wallet. The voice platform sells
its voices in **tiers**; a tier is a named quality band with a per-minute rate.
YE resells those tiers to its accounts, at prices YE sets, and the tier an
account holds is also what decides **which voices its agents may use**.

Two things this slice deliberately does **not** do:

- **Nothing is charged per minute.** The dialer that would consume minutes is a
  later slice. This slice makes a rate **resolvable** (one function, one place)
  and **visible** (a staff table and a customer card). `resolveTierRate` is
  what the dialer will call; it is written now, tested now, and called by no
  billing path, because there is no billing path.
- **No tier is created here.** The catalog is upstream's. This repo mirrors it
  and prices it; it never invents a tier, renames one, or deletes one.

## The upstream contract, and exactly how much of it we may touch

Two read endpoints on the V2 partner API, and no others:

```
GET /agent/voice-tiers  → { tiers: [ { tier: "va-1", label: "VA 1" }, … ] }
GET /agent/voices       → { voices: [ { id, display_name, …, tier: "va-1" }, … ] }
```

`GET /agent/voice-tiers` returns the tiers **YE is entitled to** — the public
bands plus any exclusive tier the platform has granted the YE partner account.
That is the whole catalog as far as this product is concerned: a tier not in
that list is a tier YE cannot sell.

The payload carries a **slug and a label and nothing else**. No id, no status,
no price — pricing is YE's, and so is retirement. That shapes the mirror
below: upstream owns two columns, YE owns the rest.

**No write reaches upstream in this slice.** Not one. If a task appears to need
`POST`, `PATCH`, `PUT` or `DELETE` against the platform, the task is wrong.

## The mirror

Same pattern as the agent and DID mirrors, and for the same reason: **sync owns
catalog facts, staff own pricing and assignment.**

```
Tier         id, slug (unique), name, status (ACTIVE|REMOVED),
             defaultPriceCreditsPerMin BigInt?, isDefault Boolean,
             lastSyncedAt?, createdAt, updatedAt

AccountTier  id, accountId, tierId, priceCreditsPerMin BigInt?, createdAt
             unique(accountId, tierId)
```

- The sync upsert writes **`slug`, `name`, `status` and `lastSyncedAt` only**.
  It must never touch `defaultPriceCreditsPerMin` or `isDefault`. A refresh
  that reset a price would re-rate every account holding that tier, silently,
  from a button whose label says "Sync".
- A tier upstream stops listing is marked `status = REMOVED`, **never deleted**
  — exactly as a retired agent is. Deleting it would take its price and every
  account's override with it, and the ledger rows a later slice writes against
  it would point at nothing. A `REMOVED` tier keeps its assignments and keeps
  showing them; what it loses is the ability to be assigned to anybody new, and
  its voices stop being offered.
- `slug` is the join key, because it is the only stable identifier upstream
  gives us — it is what `voices[].tier` carries and what `?tier=` accepts.

### Exactly one default tier, enforced by the database

`Tier.isDefault` marks the tier an account with **no assignment at all** is
treated as holding. "Exactly one" is not a rule handlers remember; it is a
**partial unique index** written by hand in the migration:

```sql
CREATE UNIQUE INDEX "Tier_isDefault_key" ON "Tier" ("isDefault") WHERE "isDefault";
```

Prisma's schema language cannot express a partial index, so the schema carries
the column and the migration carries the constraint, with a comment saying so.
Moving the default is one transaction: clear the current, set the new. Two
concurrent moves cannot both land.

**Zero defaults is a legal state** — it is the state a fresh install is in,
before staff have priced anything. It is not papered over: an account with no
assignment then holds **no tier**, is offered **no tiered voice**, and the
staff console says in words that no default tier is set. Failing closed here is
right. The alternative — picking "the first tier" when none is marked — prices
somebody's calls off an arbitrary row.

## Pricing resolution: one function, one place

```
resolveTierRate(accountId, tierId)
  → the account's AccountTier.priceCreditsPerMin for that tier   (a custom price)
  → else Tier.defaultPriceCreditsPerMin                          (the list price)
  → else refuse
```

`src/lib/tierPricing.ts` owns it and nothing else may reimplement the fallback.
Three copies of a precedence rule eventually disagree, and here the
disagreement is a customer charged a price they never agreed to.

**Refusing is a real outcome, not a defensive branch.** A tier freshly synced
has `defaultPriceCreditsPerMin = null` — upstream sends no price and none can
be invented. A tier with no default price and no override for this account
**cannot be used**: it is not offered in the voice picker, and the dialer that
arrives later will refuse rather than bill zero. Zero is a price; unknown is
not, and defaulting one to the other rents calls out for free.

So the write side validates:

- `PATCH /api/admin/tiers/:id` parses `defaultPriceCreditsPerMin` through
  `toInternalCredits`, the same parser every other money field on this API
  uses. A malformed or out-of-range value is a **400**, never a 500 from Prisma
  and never a silent zero.
- `null` is accepted and means "unpriced" — the way a tier arrives from sync.
  It is not a way to say free.
- A tier with no default price **cannot be made the default tier** (409). The
  default tier is the one that prices everybody who was never explicitly
  priced; leaving that unpriced would make the fallback path unreachable for
  the exact population it exists for.

Rates are **display-credit decimal strings on the wire and BigInt in the
database**, through `src/lib/credits.ts` and its 10000× multiplier, like every
other credit value in this system. A per-minute rate is the value most likely
to be a small fraction, which is precisely why it never becomes a float.

## Assignment

An account may hold **many** tiers. Each assignment optionally carries
`priceCreditsPerMin`, which overrides the tier's default **for that account
only**.

`PUT /api/admin/accounts/:id/tiers` is a **full replace**, not a patch. The
body is the complete intended set:

```json
{ "tiers": [ { "tierId": "…", "priceCreditsPerMin": "0.75" }, { "tierId": "…" } ] }
```

Replace rather than add/remove because the staff surface is a form with a Save
button, and add/remove endpoints turn one intention into three requests that
can half-land. The whole set is written in one transaction: delete what is not
in the body, upsert what is. Every `tierId` is validated to exist **and be
ACTIVE** before anything is written — assigning a retired tier would create an
entitlement no voice can satisfy.

An empty array is legal and means "this account holds nothing explicitly", which
returns it to the default tier. That is a real intention and is not confused
with an omitted field: `tiers` is required.

## Entitlement flows to the product

The voice picker in the customer dashboard is the surface where a tier stops
being a price and becomes a capability.

`GET /api/workspaces/:id/voices` today proxies the upstream catalog whole. It
now filters:

1. Resolve the **workspace owner's** account — not the caller's. Credits belong
   to the Account and so does entitlement; an ADMIN who is not the owner would
   otherwise be offered voices out of their own plan and pick one the workspace
   cannot afford. This is the same rule the billing card and the rent dialog
   already follow.
2. `tiersForAccount(ownerAccountId)` → the account's **ACTIVE** assigned tiers,
   or — when it has **no** assignments at all — the default tier.
3. Keep a voice when its `tier` slug is in that set, **or when it carries no
   readable tier at all**. An untiered voice is offered to everybody: it is
   outside the tier system, and hiding it would remove voices from a product
   that has been offering them.

**One upstream call, filtered locally — not one call per held tier.** `?tier=`
exists upstream and would work, but an account holding three tiers would spend
three requests against a partner rate limit every YE customer shares, to
assemble a list one request already contains. The rate-limit argument is the
same one the workspace agent sync already makes.

Each voice row gains `tier` (the slug) and `tier_name` (the mirror's label,
`null` when the slug is not in the mirror), so the picker can group by band
without a second request. `serializeVoices` is where that happens; the voice
payload gains two fields and loses none.

**A tier the mirror does not know is not entitlement.** The filter tests the
slug against the account's assigned slugs, which come from the mirror. A voice
whose tier has never been synced fails that test and is withheld — the same
fail-closed direction every other visibility rule here takes.

## What the customer is told

The billing page gains a read-only **Your plan** card, served by a sibling
route rather than folded into `/billing`:

```
GET /api/workspaces/:id/billing/plan      (ADMIN)
→ { tiers: [ { slug, name, status, rate_credits_per_min } ], … }
```

A sibling for the reason the transactions route is one: the balance card and
the plan card fail independently, and a plan lookup that 500s must not take the
balance down with it.

Three rules for the copy on that card:

- **A custom price is never labelled as one.** It is the customer's rate. Not
  "discounted", not "custom", not shown beside a list price they are not
  paying. What another customer pays is not on this page, and a badge saying
  "special rate" invites the question of what the normal one is.
- **The card says minutes are not billed yet**, because they are not. A rate
  printed with no qualifier on a page headed "Billing" reads as a charge
  already being made, and the reader goes looking for it in a history that will
  never show it.
- **A tier that is no longer offered says so.** A `REMOVED` tier the account
  still holds is listed with that status rather than dropped — a plan card that
  quietly loses a line is how a customer discovers a change by not noticing it.

An account with no assignments sees the default tier, presented exactly as any
other rate. It is their rate; the mechanism behind it is not their business.
An account whose tiers are all unpriced sees a card that says the rate is not
set yet and to contact YE — never a zero.

## The staff console

**`/tiers`** — the catalog: name, slug, status, default price (inline
editable), and how many accounts hold each. Plus the default-tier selector and
a **Sync** button. The accounts count is a `_count`, never a loaded relation.

**`/accounts/[id]`** gains a **Tiers** section: the account's assignments with
a per-account price field on each, add and remove, one Save. It reads
`GET /api/admin/accounts/:id/tiers` and writes the whole set back through the
`PUT`, matching the replace semantics above — a form whose Save means "this is
the set" cannot half-apply.

**`/resources`** — unrelated debt, paid here because it is small and it is
currently costing customers a working feature. The staff resource-mapping
endpoints (`GET /api/admin/resources`, `POST
/api/admin/resources/:kind/:externalId/assignment`) have had no UI, and
`CONNECTION` is the one resource kind a workspace **cannot** map for itself —
connecting an integration is an OAuth flow outside this platform. With no
staff UI, no connection has ever been mapped, which is why every customer's
integrations tab says "No integrations available yet". The page lists the
mappings and offers a form that maps a kind + external id to a workspace, which
is exactly what the existing `assignment` endpoint does (it upserts, so an
unmapped id is mappable). No new backend route.

## Migrations

**Additive only.** One migration: two new tables, one partial unique index. No
column is dropped, no type changed, no row rewritten, nothing backfilled — so
it takes no long lock and is safe to apply while the service is running.

It is **written and reviewed here and not applied to production**. Production
gets one `prisma migrate deploy` from `main` later. No existing migration file
is edited and no timestamp is reordered.

## Testing

Same rules as every slice here. Tests run against `TEST_DATABASE_URL` only —
`test/setup.ts` refuses a hosted host, and that guard is not to be touched. The
Vocobase adapter is **always** mocked with `vi.mock`; no test makes a network
call, so the suite cannot reach the live partner account.

The cases that matter most are the ones where being wrong costs money or
access:

- Sync never overwrites a price or the default flag.
- A tier upstream stops listing is marked REMOVED and keeps its assignments.
- Resolution order: override, then default, then refusal.
- An unpriced tier cannot become the default.
- Replace is atomic and validates every tier before writing any.
- The voice filter reads the **owner's** tiers, keeps untiered voices, and
  withholds a voice whose tier the account does not hold.
