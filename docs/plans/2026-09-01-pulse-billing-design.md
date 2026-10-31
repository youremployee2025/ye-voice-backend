# Pulse Billing — Design

Date: 2026-09-01. Scope: billing increments across `ye-voice-backend`, the staff console, and the customer dashboard.

Today a call is billed pro-rata to the second: a 47-second call at 10 credits per minute costs 7.8333 credits. **Pulse billing** rounds a call's duration up to the next multiple of a configurable increment before pricing it. At a 60-second increment that same call bills a full minute; at a 1-second increment nothing changes.

This is a pricing lever, not a pricing change. Every tier ships with the increment unset, which resolves to per-second — **byte-for-byte today's arithmetic** — until staff deliberately set one.

## Decisions

- **One increment, not two.** A single `billingIncrementSecs` rounds the whole call up. No first-pulse / subsequent-pulse split, no minimum-duration column that is really a first pulse in disguise. Two numbers would need a third to say how they compose, and the composition is the part customers dispute.
- **Per-second is `1`, and `1` is the floor.** There is no "off". A call is always billed in increments; per-second billing is the increment of one. That keeps a single formula on the charge path instead of a formula and a branch that must agree.
- **Null means per-second, at both levels.** `AccountTier.billingIncrementSecs` → `Tier.billingIncrementSecs` → `1`. Exactly the shape of the rate chain beside it, and the same `??` rather than `||` — see § The `??` rule below.
- **Rate and increment resolve together, once.** `resolveTierRate` becomes `resolveTierPricing`, returning both from one query and one precedence walk. A call must never be priced at the account's rate and the tier's increment: those are two different plans, and the customer agreed to neither.
- **Both numbers are stored on every charge.** The actual `durationSecs` and the `billedSecs` that was charged, plus the `billingIncrementSecs` that produced it. A charge that records only the billed figure cannot answer "why is this 60 seconds when the call was 47", which is the first question pulse billing generates.
- **Rounding up is the whole point, and truncation still applies after it.** `billedSecs` rounds **up** to the increment; the credit division then truncates, as it already does. Two roundings in opposite directions, both stated, because the difference is a billing dispute nobody can settle by reading the code.
- **Reject, never clamp.** An increment outside 1–600 is a 400 at every write path, and a `CHECK` constraint behind them. Clamping 3600 to 600 charges a customer at an increment nobody chose.
- **Null history reads as unrecorded.** Every charge written before this change has `billedSecs = null`. No reader may render that as `0`, and none may render it as "equal to the duration" — the second is a guess that happens to be right and teaches the reader to trust it when it is not.

## The `??` rule

The rate chain carries this comment, and it is the reason to extend that function rather than write a second one:

> `?? tier.default…` rather than `||`: a deliberate 0n is falsy, and `||` would step over a free tier straight onto the list price.

The increment has the same trap one step over. An account deliberately put on **per-second billing** — `billingIncrementSecs = 1` — while its tier defaults to 60 is a real and commercially meaningful override: it is the concession you give the customer who noticed. `1` is truthy, so `||` survives *that* case; what `||` does not survive is the shape being copied without thought into the resolver's own defaulting (`incrementSecs || 1`), where a stored `0` would silently become per-second instead of being refused. Both are guarded: `??` at every link, bounds at every write, and a `CHECK` in the database.

## The formula

```
billedSecs = ceil(durationSecs / incrementSecs) * incrementSecs
cost       = rateCreditsPerMin * BigInt(billedSecs) / 60n     // BigInt: truncates
```

Worked, at 10000 internal units (1.0000 display credits) per minute:

| duration | increment | billedSecs | cost (internal) |
|---|---|---|---|
| 61 s | 60 | 120 | 20000 |
| 61 s | 1 | 61 | 10166 |
| 5 s | 30 | 30 | 5000 |
| 60 s | 60 | 60 | 10000 |
| 0 s | anything | 0 | 0 — and no ledger row |

**A zero-duration call stays free.** It is arithmetic, not a special case: `ceil(0/n)*n` is 0 for every n. The existing rule that no ledger row is written for a zero-credit call is unchanged, and `chargedAt` is still stamped so a late delivery cannot charge it afterwards.

Two invariants every charge row satisfies, and the tests assert them directly:

- `billedSecs >= durationSecs`
- `billedSecs % billingIncrementSecs == 0`

## Schema

Four nullable columns. No table is created, no column is dropped, no existing column changes type — the migration is additive and every existing row keeps reading exactly as it does today.

```prisma
model Tier {
  /// The tier's default billing increment, in seconds. A call's duration is
  /// rounded UP to the next multiple of this before it is priced. Null means
  /// per-second billing, which is the increment of one — there is no "off".
  ///
  /// Range 1–600 is enforced by a CHECK CONSTRAINT in the migration, which
  /// Prisma's schema language cannot express; this comment is where you learn
  /// it exists. Clamping an out-of-range value would charge a customer at an
  /// increment nobody chose, so every write path refuses instead.
  billingIncrementSecs Int?
}

model AccountTier {
  /// This account's own increment for this tier. Null means the tier's default
  /// applies. A deliberate 1 here is per-second billing on a tier that pulses,
  /// which is a real concession and must survive the fallback — hence `??`.
  billingIncrementSecs Int?
}

model CallAttempt {
  /// The seconds actually charged for: `durationSecs` rounded up to
  /// `billingIncrementSecs`. Null on every attempt settled before pulse
  /// billing existed. Null is NOT zero and NOT "same as the duration" —
  /// readers say the figure was not recorded.
  billedSecs           Int?
  /// SNAPSHOT of the increment this call was launched under, captured beside
  /// `rateCreditsPerMin` and for the same reason: a call launched under one
  /// plan must be billed on that plan even if staff re-pulse the tier while
  /// the phone is still ringing.
  billingIncrementSecs Int?
}
```

### Why `CreditTransaction` gains no column

Every `CALL_USAGE` and `CALL_USAGE_SHORTFALL` row already carries `callAttemptId`, and that relation is `onDelete: Restrict` — the ledger's rule that a charge can never lose its referent. So the duration, the billed seconds and the increment are reachable from any ledger row by an include the reader already pays for on the phone-number join.

Copying all three onto the ledger row would create a second place the same three facts are written, with no constraint keeping the copies equal. The ledger is append-only precisely so that it can be audited, and an audit trail with two disagreeing accounts of one call is worse than one. **The join is the record; the read routes include it.**

## Resolution

`src/lib/tierPricing.ts` stays the only place the precedence chain exists — its own comment makes that a rule, and this slice honours it by widening the existing function rather than adding a neighbour:

```ts
export interface TierPricing {
  rateCreditsPerMin: bigint;
  /** Always resolved. 1 is per-second; never null past this boundary. */
  incrementSecs: number;
}

export async function resolveTierPricing(accountId, tierId): Promise<TierPricing>
```

One query, one walk, both values. `TierRateUnavailableError` is unchanged and still thrown for an unpriced tier: an unresolvable **rate** is still a refusal, while an unresolvable **increment** does not exist — the chain bottoms out at 1.

`resolveCallRate` in `dialerPricing.ts` gains `incrementSecs` on `PricedCall` by passing the resolution through. It continues to answer only *which tier*, and reimplements no link of the chain.

`chargeFor` returns both figures so the caller can persist what it charged:

```ts
export function chargeFor(rateCreditsPerMin, durationSecs, incrementSecs): {
  billedSecs: number;
  cost: bigint;
}
```

## The charge path

`dialer.ts` snapshots `billingIncrementSecs` onto the `CallAttempt` at insert, in the same object literal as `rateCreditsPerMin`, from the same `PricedCall`.

`dialerOutcome.ts` reads the snapshot back:

```ts
const increment = attempt.billingIncrementSecs ?? 1;
const { billedSecs, cost } = chargeFor(rate, outcome.durationSecs, increment);
```

`?? 1` here is not a default anybody chose — it is the honest reading of an attempt row launched **before this column existed**, which was billed per-second. Those rows are in flight for minutes, not days, so the window is small; getting it wrong in the other direction would charge a customer a pulse they were never on.

`billedSecs` is written in the same `updateMany` as `costCredits`, inside the same transaction, under the same `chargedAt: null` guard. The exactly-once machinery is untouched: no new marker, no new lock, no new failure mode.

## Surfaces

### Editing a tier: two fields, two writes

`PATCH /api/admin/tiers/:tierId` takes the price, the increment, or both. **An omitted key leaves that column alone; an empty body is refused.**

The rule the route already held — *"`null` must be stated rather than implied by omission"* — exists because a half-written client sending `{}` would unprice a tier and take it out of every voice picker. Making omission mean *leave alone* keeps that guarantee and strengthens it: no omission can now turn anything off, and `{}` is a 400 rather than a no-op somebody meant as an edit.

It is also what lets the price cell and the increment cell stay two independent one-field editors on one table row. A price edit forced to resubmit the increment would overwrite whatever another operator set between the two page loads, and the increment edit would do the same back.

The account-tier `PUT` is unchanged in shape: whole-set replace, and on each row an absent or null `billingIncrementSecs` means the tier's default — the identical convention the rate override already uses.

**Staff — `/tiers`.** The increment sits beside the list price, inline-edited, with the same warning the price edit already carries: editing a tier's default moves every account on it that has no override, and the count is named **before** the click, not discovered after it. Null renders as *per second* — never blank, because a blank cell in a money column reads as a rendering fault.

**Staff — account page.** An increment override column beside the rate override, with the same empty-means-default convention: the placeholder names the tier's own default (`Tier default: 30s`), so a blank box is documented on every row rather than in a paragraph above them.

**Staff — billing ledger.** A charge row shows actual against billed when they differ: `0:47 billed as 1:00`. When they are equal it shows one figure — a row that says "1:00 billed as 1:00" is noise that trains the reader to skip the column. A row with no recorded figures says so.

**Customer — settings/billing.** The same actual-vs-billed on the transaction row, and one plain sentence in the plan area: *"Calls are billed in 30-second steps."* / *"Calls are billed per second."* No table, no formula, no worked example — the customer needs to know the rule applies, and the row shows them it applied.

### One honesty fix that comes with this

`GET /:workspaceId/billing/plan` still answers `metered: false`, and both the plan card and the staff tier page still say *"nothing is charged per minute yet"*. That was true when the tier catalogue landed and stopped being true when the dialer did. Printing *"Calls are billed in 30-second steps"* directly beneath *"calling is not billed yet"* is a contradiction on one card, so this slice corrects the flag and the two sentences alongside the increment copy. It is the smallest change that lets the new sentence be true.

## What this slice does not do

- **No retroactive fill.** No migration computes `billedSecs` for settled attempts. The increment those calls were billed under was 1, so a fill would be *correct* — and it would also erase the distinction between "recorded" and "reconstructed", which is the distinction an audit needs.
- **No per-campaign or per-agent increment.** The scope is tier default plus account override, mirroring the rate. A third level would need a fourth to say which wins.
- **No change to the estimate.** `campaignStart` checks that a rate is *resolvable*; it does not price the campaign. Rounding does not change whether a rate exists.
