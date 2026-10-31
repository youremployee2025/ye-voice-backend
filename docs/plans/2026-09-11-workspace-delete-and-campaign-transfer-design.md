# Workspace delete and cross-workspace campaign transfer

Date: 2026-09-11
Status: built — 2026-09-11, across all three repos.

Two features that meet at one point: staff transfer is how a customer's campaigns
are rescued out of a workspace *before* its owner deletes it.

| Feature | Surface | Who |
|---|---|---|
| Delete a workspace | customer dashboard, Settings → General | the workspace owner only |
| Move a campaign to another workspace | `ye-voice-admin` console | YE staff only |

## Why a soft delete, and not a real one

The schema already anticipated this slice, twice, and both comments rule out a
row-level `DELETE`:

- `PhoneNumber.workspace` is `onDelete: Restrict` — *"There is no
  workspace-delete route yet; this makes the slice that adds one confront rented
  numbers explicitly."* (`prisma/schema.prisma:1009-1013`)
- `CreditTransaction.workspace` is `Restrict` for the same reason: the column is
  a deliberate snapshot so that *"a workspace's billing history"* does not
  *"evaporate exactly when somebody wants to read it"*
  (`prisma/schema.prisma:1030-1071`).

Any workspace that has ever placed a call or rented a DID holds ledger rows, so
the `Restrict` FK blocks its deletion. Clearing that means either deleting the
ledger rows or nulling their snapshot — the two things those comments exist to
forbid. A hard delete would also orphan `Call`, `Session`, `TestSession` and
`CallAttempt`, which carry `workspaceId` as a plain column with no foreign key.

So the `Workspace` row survives and is marked deleted. Keeping the row is exactly
what keeps those `Restrict` FKs valid.

---

# Part 1 — Workspace delete

## Schema

One column:

```prisma
model Workspace {
  deletedAt DateTime?
  @@index([deletedAt])
}
```

No cascade changes, no ledger changes.

## Route

`DELETE /api/workspaces/:workspaceId`

Gated by `requireMembership('ADMIN')` followed by a new `requireOwner`
middleware asserting `workspace.ownerAccountId === account.id`. A separate
middleware rather than a parameter on the existing one: "is an admin" and "is
the owner" are different questions, and `requireMembership` only answers the
first.

Owner-only is deliberately stricter than the rename route beside it. An invited
admin must not be able to erase the workspace out from under the person whose
account is billed for its DIDs and its calls.

### Blockers — 409, nothing is auto-released or auto-stopped

| Blocker | Check | Response |
|---|---|---|
| Rented DIDs | `PhoneNumber` where `workspaceId = :id` | names the numbers; link to Settings → Phone numbers |
| Live campaigns | `status IN (RUNNING, SCHEDULED)` or `scheduledStartAt IS NOT NULL` | names them; link per campaign |
| Calls in flight | non-terminal `CallAttempt` for the workspace | "wait for N calls to finish" |
| Active test session | `TestSession` where `status = 'ACTIVE'` | same |

Releasing a DID is irreversible — it returns to the shared pool and anyone may
rent it — so that choice stays a separate, deliberate act rather than a side
effect of a differently-named button. The response body carries a machine code
and the offending list so the dashboard can render a specific instruction rather
than a flat error string.

## Enforcement: where `deletedAt` is honored

**1. `requireMembership` — `src/middleware/workspace.ts:23`.** The membership row
survives the soft delete, so without this every scoped route keeps answering
normally. After the `!member` check:

```ts
if (member.workspace.deletedAt) {
  throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this workspace.');
}
```

Same status and same sentence as a non-member. That function's own comment says
a 404 would leak which workspace ids exist; a distinct "this was deleted" leaks
the same thing one step later. Written as one branch with the `!member` test
rather than beside it: the two sentences being byte-identical is the security
property, and two adjacent copies of a literal are what an unrelated reword
pulls apart.

This covers every `/api/workspaces/:workspaceId/*` route **except one**.
`GET .../calls/:callId/recording` is reachable with a `?token=` and no session,
because an `<audio>` element cannot send a header, and
`requireMembershipOrRecordingToken` (`src/routes/calls.routes.ts`) short-circuits
the membership middleware on that branch. The handler's own visibility check is
no substitute: `resolveScope` reads the workspace's agents and campaigns and
never reads `Workspace` at all. A token minted seconds before the delete would
otherwise keep streaming audio for the rest of its two-minute TTL. So that branch
reads `deletedAt` itself and refuses with the **401 an expired link already
gets** — a link for a deleted workspace must not be distinguishable from a stale
one, which is the indistinguishability that branch's claims check already keeps.

**2. `/api/me` — `src/routes/me.routes.ts:17-24`.** Add
`workspace: { deletedAt: null }` to the memberships query and the invites query.
This is what removes it from the switcher, and what makes the delete-your-last-
workspace case fall into the existing `/onboarding` redirect at
`components/workspace-provider.tsx:88` with no new code.

**3. `loadActionableInvite` — `src/routes/invites.routes.ts:38`.** A PENDING
invite outlives the delete; accepting one would mint a membership in a deleted
workspace. Treat it as not found.

**4. Background jobs need no change** — a consequence of the blockers, not luck.
The dispatcher reads only `RUNNING` campaigns, `didRenewal` only rented DIDs,
the schedule scanner only `scheduledStartAt`, and inbound only fires on a
claimed DID. Every one is a precondition the delete refuses on, so a deleted
workspace is invisible to all of them by construction.

**The audit behind that claim.** Every `prisma.workspace` read in `src/` and
`scripts/` was walked, and each falls into one of four buckets:

| Read | Filters? | Why |
|---|---|---|
| `requireMembership`, `/api/me`, `loadActionableInvite` | yes | the customer-facing surface |
| `calls.routes.ts` recording `?token=` branch | yes | the one route that bypasses the middleware |
| `campaignStart.ts`, `campaigns.routes.ts`, `didRental.ts` | no, and need not | all behind `requireMembership` |
| `didRenewal.ts`, `scheduleScanner.ts`, inbound arrival | no, and need not | each keyed on a precondition the delete refuses on |
| `admin/*`, `accountTransfer.ts` | no, deliberately | staff must see a deleted workspace — it is the recovery path |
| `uniqueSlug` | no, deliberately | see below |

One read is deliberately unfiltered and would look like an oversight:
`chargeInboundCall` (`src/services/campaignInbound.ts`) settles a call that
already happened. A workspace deleted between the hangup and the settlement must
still bill for it — dropping the charge there is the billing history evaporating
on delete, which is the thing the `Restrict` FKs exist to prevent. It carries a
comment saying so.

`uniqueSlug` keeps counting deleted slugs as taken. The row still holds the
unique index, and re-issuing a dead workspace's slug would make old links
resolve to a stranger's workspace.

## Recovery

Presented to the customer as permanent. No trash UI, no restore endpoint, no
purge job. Recovery exists only as a staff action against the database — an
escape hatch for support, not a promised feature.

## Dashboard

There is no Settings → General page today, and `PATCH /api/workspaces/:id`
(rename) has **no caller in the dashboard at all**. This slice adds
`app/(dash)/settings/general/page.tsx` and gives both actions a home: rename at
the top, danger zone below.

- `components/shell/sidebar.tsx:44` gains
  `{ href: '/settings/general', label: 'General', icon: Settings }` as the first
  `SETTINGS_NAV` entry. No `adminOnly` flag — a MEMBER can read the workspace
  name, so unlike Billing the page has a readable half.
- The delete button gates on `activeWorkspace.isOwner`, which
  `serializeMembership` (`src/lib/serialize.ts:49`) already returns — no API
  change. A non-owner sees it disabled with a line naming the owner, rather than
  hidden; hiding it leaves an admin hunting for an option that exists.
- Promote `app/(dash)/settings/phone-numbers/confirm-dialog.tsx` to
  `components/ui/confirm-dialog.tsx` and reuse it. It already has the `danger`
  tone and `busy` / `error` / `disabled` wired the way this needs.
- The dialog carries: the workspace name typed to confirm (feeding the existing
  `disabled` prop), a plain count of what becomes unreachable (N campaigns, N
  contacts, N calls), and "This is permanent" with nothing softer.
- On success, call the provider's `refresh()` and let its existing logic pick
  the next workspace or bounce to `/onboarding`.

---

# Part 2 — Cross-workspace campaign transfer

Staff-only, from the admin console. Not exposed to customers.

## What moves and what stays

Call history and ledger rows **stay with the source workspace**.
`CallAttempt.workspaceId` is documented as a dial-time snapshot, *"exactly as
`CreditTransaction` snapshots its workspace. Deriving either later would make a
campaign's billing history follow whoever owns the workspace now"*
(`prisma/schema.prisma:1234-1237`). Rewriting it is ruled out by the same
contract that ruled out the hard delete.

Everything else moves: settings, contacts, DNC list, and every contact's journey
state — attempts used, callbacks booked, settled or pending.

Most of it needs no write at all. `CampaignContact`, `DoNotCall`, `CallAttempt`
and `CampaignPhoneNumber` are keyed by `campaignId` alone, with no workspace
column, so they follow the campaign for free.

### The full write set

| Write | Why |
|---|---|
| `Campaign.workspaceId = target` | the move |
| `Campaign.agentId = null`, `phoneNumberId = null` | they are the source's |
| delete `CampaignPhoneNumber` rows | the dial roster is source DIDs |
| delete `CampaignInboundClaim` rows | defensive; only exist while RUNNING |
| `status = 'PAUSED'` + `haltReason` | lands inert and explains itself |
| `CampaignContact.contactId` remapped | see below |

`haltReason`: *"Moved from &lt;source&gt; by YE staff. Set an agent and a phone
number before resuming."*

### Agent and DIDs always detach

The campaign lands incomplete and the customer re-picks both. Staff do not remap
them at transfer time. Moving the DIDs instead would silently change which
account is billed for those rentals while the ledger says otherwise.

### The contact remap

`Contact` is workspace-scoped and unique on `(workspaceId, phone)`, so every
contact needs a counterpart in the target. For each source contact: find-or-create
by `(targetWorkspaceId, phone)`, then repoint the `CampaignContact`.

**When the target already holds that phone, reuse its row untouched** — no
merging of name, tags or metadata. The target's own record of a person is not
the source's to overwrite, and a silent merge is unreviewable afterward.

Source `Contact` rows stay. They may back other campaigns that are not moving,
and source `CallAttempt` history references them.

No collision is possible on `@@unique([campaignId, contactId])`: source contacts
are already distinct by phone, so they map to distinct target contacts.

### Scale

The schema contemplates 100,000-contact campaigns. `src/lib/campaignTopup.ts:15-24`
documents both traps: chunk at 1,000 rows per statement, and raise Prisma's
5-second interactive-transaction default or a large remap surfaces as a P2028
and a 500 on a request that was doing exactly what it was asked to.

## Service

`src/services/campaignTransfer.ts`, modeled on `src/services/accountTransfer.ts`
— preview then apply, typed errors, and a `ConcurrentModificationError` when the
plan the operator confirmed is not the plan that would run.

## Routes

New `src/routes/admin/campaigns.routes.ts`, mounted in `admin/index.ts` beside
its siblings and carrying its own `requireStaffToken` (that file's comment at
line 25 makes the redundancy the house rule).

- `GET /api/admin/campaigns/:campaignId/transfer-preview?target=<workspaceId>`
  — source and target names, contact count, how many already exist in the target
  vs. will be created, attempts staying behind, the agent and DIDs being
  detached, and any blockers.
- `POST /api/admin/campaigns/:campaignId/transfer` — body
  `{ targetWorkspaceId, expectedContactCount }`. The expected count is the drift
  check: if the campaign gained contacts between preview and confirm, refuse
  rather than move a different thing than was reviewed.

### Blockers — 409

Campaign is `RUNNING` or `SCHEDULED`; any non-terminal `CallAttempt`; target is
deleted, or is the source. Staff stop the campaign first; the transfer does not
stop it for them.

## Admin UI

The workspace detail page already renders a campaigns table
(`app/(console)/workspaces/[id]/page.tsx:185-212`). Each row gains a **Move**
action — staff arrive there already looking at the workspace they want to move
something out of.

The dialog: a searchable target-workspace picker, the preview as plain
sentences, then confirm. Two facts must be unmissable, because they are what
surprises people afterward:

- *"N calls and their billing history stay with &lt;source&gt;."*
- *"The agent and N phone numbers are removed. Someone in &lt;target&gt; must set
  an agent and a number before this campaign can run."*

One stale line to fix while there: the table's empty state reads *"Campaigns are
created by the workspace's own members, not from here"*, which stops being true
once staff can move one in.

---

# Testing

`test/account-transfer.test.ts` is the precedent for the transfer half;
`test/analytics-isolation.test.ts` for the delete half.

## `test/workspace-delete.test.ts`

- Each blocker refuses with its own code and names what is in the way: rented
  DID, RUNNING campaign, `scheduledStartAt` set, non-terminal `CallAttempt`,
  ACTIVE `TestSession`.
- An ADMIN who is not the owner gets 403; the owner succeeds.
- **Isolation sweep** — after a delete, walk *every* `/api/workspaces/:id/*`
  route and assert 403, rather than spot-checking three. A route added later
  that forgets the rule should fail here, not in production.
- `/api/me` omits it; a PENDING invite to it cannot be accepted; its slug stays
  taken.
- The ledger survives: `CreditTransaction` and `PhoneNumber` rows still resolve
  their workspace relation. This is the assertion proving the `Restrict` FKs
  were respected rather than worked around.

## `test/campaign-transfer.test.ts`

- Contact remap: a target with no matching phone creates one; a target that
  already holds the phone reuses it **unchanged** — assert name, tags and
  metadata are untouched, since a silent merge is the failure nobody notices.
- Journey state survives: `attempts`, `nextEligibleAt`, `armKind`, `callbackAt`
  identical across the move.
- History stays: `CallAttempt.workspaceId` and `CreditTransaction.workspaceId`
  still read source afterward.
- Agent, `phoneNumberId`, `CampaignPhoneNumber` and `CampaignInboundClaim` all
  cleared; status `PAUSED` with a `haltReason`.
- Drift: an `expectedContactCount` mismatch refuses and writes nothing.
- A chunk-boundary case (>1,000 contacts) so the batching is exercised rather
  than assumed.

## Notes for whoever runs this

- The backend suite is flaky at roughly 10% of full runs from cross-file bleed.
  Re-run a failure several times before treating it as real.
- The straggler grep for new `deletedAt` filters must cover `scripts/` as well
  as `src/`.
- Each backend worktree needs its own dev and test Postgres.
