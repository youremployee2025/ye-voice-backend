# Agent ↔ Campaign stitch — Design

Date: 2026-08-27. Scope: relate campaigns to the local agent mirror across
`ye-voice-backend` and `ye-voice-dashboard`.

## What this slice is

Agents and campaigns both shipped, deliberately unconnected: `Campaign.agentId`
is a plain indexed `String?` with no foreign key, and the campaign form asks an
operator to type an agent id into a text box. This slice closes that gap and
nothing else. No dispatcher, no scheduling, no new agent capability.

Four changes, in dependency order:

1. `Campaign.agentId` becomes a real nullable foreign key to `Agent`.
2. `PATCH` refuses an agent that is not this workspace's.
3. `start` / `resume` refuse a campaign whose agent has left the workspace.
4. The campaign payload carries a small agent summary, and the dashboard
   replaces the text box with a picker.

## Why the column could not be a foreign key on day one

Campaigns and the agent mirror were built on parallel branches. A foreign key
declared then would have named a model the other branch owned. The column was
therefore left plain and indexed — indexed precisely so the constraint could be
added later without rewriting the table.

That decision has a cost this slice pays off: for as long as the column was
unconstrained, the text box accepted anything. A typo, an id belonging to an
agent that has since been removed, and an id belonging to **another
workspace's** agent were all storable, and nothing rejected any of them.

## Migration

Additive only. No column is dropped, renamed, or retyped; `agentId` keeps its
type, its nullability and its index. The migration adds one constraint and
runs one `UPDATE` before it.

```sql
UPDATE "Campaign" c SET "agentId" = NULL
WHERE c."agentId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Agent" a WHERE a."id" = c."agentId"
  );

SET lock_timeout = '3s';

ALTER TABLE "Campaign"
  ADD CONSTRAINT "Campaign_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id")
  ON DELETE SET NULL ON UPDATE CASCADE
  NOT VALID;

-- next migration, so: separate transaction
ALTER TABLE "Campaign" VALIDATE CONSTRAINT "Campaign_agentId_fkey";
```

**The `UPDATE` is not optional.** Postgres refuses to add a foreign key while
any row violates it, so a migration without it fails on the first database that
holds a dangling id — and fails at deploy time, on production, which is the
worst place to discover it.

**It clears exactly what the constraint requires, and nothing more.** An earlier
draft added `AND a."workspaceId" = c."workspaceId"`, to also clear pointers to an
agent in another workspace or in none. That was wrong on two counts.

It destroys data irreversibly for no durable gain. Unassignment is a routine,
reversible staff UPDATE, so a campaign whose agent happens to be in the pool at
deploy time has made a valid choice that staff will likely undo within the hour
— and nothing would record what it was. It also collapses "unavailable" into
"not set", which is the one distinction the serializer deliberately keeps on the
wire.

And it cannot hold. The running system re-creates cross-workspace and unassigned
pointers continuously through staff reassignment; that is fine, because every
reader re-resolves rather than trusting the column. A one-time sweep cannot
maintain a property the system does not maintain — it can only lose data.
Correctness here comes from `agentIsUsable` at read time, not from the shape of
the table.

**`NOT VALID`, validated separately.** A plain `ADD CONSTRAINT` validates on
creation, holding ACCESS EXCLUSIVE on `Campaign` — every read and write blocked
— for a full scan probing `Agent`'s primary key, with the `UPDATE` above added
to that hold, since Prisma wraps one migration file in one transaction.
`NOT VALID` takes the lock only long enough to record the constraint and
enforces on every insert and update immediately; `VALIDATE CONSTRAINT` in the
following migration scans under SHARE UPDATE EXCLUSIVE, which does not block
writes.

That split also closes a race the one-step version has. In READ COMMITTED the
validating scan takes a fresh snapshot, so a row written by still-running old
code between the `UPDATE` and the `ALTER` is visible to it, violates the
constraint, and aborts the whole deploy. With `NOT VALID` there is no window to
write into.

It is deterministic: set-based, ordering-independent, and dependent only on the
data already in the two tables. Re-running it changes nothing.

`ON DELETE SET NULL`, not `Restrict`. An agent is the platform's record and a
campaign is the customer's; a campaign should not be able to pin an agent row
in place, and staff removing an agent should not have to hunt down every
campaign referencing it. The campaign survives with no agent and refuses to
start, which is the accurate state.

## Unassignment is not deletion

The subtle case, and the reason rule 3 exists at all.

Staff unassign an agent by setting `Agent.workspaceId = null` — an `UPDATE`.
Agents are never deleted: sync marks the ones the voice platform stops listing
`status = "removed"` and leaves the row standing. So `ON DELETE SET NULL`
essentially never fires. A campaign keeps a perfectly valid `agentId` pointing
at an agent its workspace can no longer see.

A foreign key cannot express this. It guarantees the row exists; it cannot
guarantee the row is still *ours*. Two facts follow:

- Ownership must be re-checked at every point it matters, not assumed from the
  constraint holding.
- `campaign.agentId != null` is no longer sufficient evidence that a campaign
  can run.

There are **two** such UPDATEs, not one. Staff unassign by clearing
`Agent.workspaceId`; sync retires by setting `Agent.status = 'removed'` and
leaves `workspaceId` intact. The second is easy to miss precisely because the
agent still resolves in its workspace — ownership alone waves it straight
through, and a retired agent then looks fully assigned right up until the dial.

Four states, then, where the schema distinguishes two:

| State | `agentId` | In workspace | Not retired |
|---|---|---|---|
| Not set | `null` | — | — |
| Assigned | set | yes | yes |
| Unavailable — reassigned | set | no | — |
| Unavailable — retired | set | yes | no |

Every layer below carries all four, and reads the two unavailable states as one:
same refusal, same `agent: null`, same remedy. The split matters only to the
code deciding usability, which is why that decision lives in exactly one place
(`agentIsUsable` / `NOT_REMOVED`, `src/lib/agentVisibility.ts`) rather than
being spelled out once per surface.

## Validation on PATCH

`agentId` on `PATCH .../campaigns/:campaignId` is resolved before it is
written:

```ts
prisma.agent.findFirst({ where: { id: agentId, workspaceId: campaign.workspaceId } })
```

Ownership is part of the lookup rather than a check after it — the same shape
`campaignInWorkspace()` and `agentInWorkspace()` already use, so there is no
path where a handler writes an agent it was not entitled to.

Nothing found is `422 CAMPAIGN_AGENT_NOT_FOUND`, "That agent is not available in
this workspace."

**One response for four distinct causes**: the id names no agent at all, names
an unassigned agent, names another workspace's agent, or is simply malformed.
They are indistinguishable from outside, which is the point. A `404` for "no
such agent" and a `403` for "someone else's agent" would let a caller sort ids
into real and unreal by watching the status code — id enumeration, one request
at a time. This matches how the agent surface already behaves: an agent in
another workspace, an unassigned agent, and a nonexistent id all return the
same answer there too.

`422` rather than the repo's usual `400 VALIDATION_ERROR` because the body is
well-formed. The field is a syntactically valid string of the right shape; it
is the *referent* that is wrong, which is a semantic failure, and a caller
distinguishing "you sent nonsense" from "that agent isn't yours" gets a better
error message for it. Setting `agentId: null` is always allowed and skips the
lookup entirely — unassigning is not a reference.

## Validation on start / resume

The existing guard is `if (transition.requiresAgent && !campaign.agentId)`. A
null check alone now passes a campaign whose agent was unassigned, so it
becomes a resolution:

```ts
const agent = campaign.agentId
  ? await prisma.agent.findFirst({
      where: { id: campaign.agentId, workspaceId: campaign.workspaceId },
    })
  : null;

if (!agent) throw new ApiError(409, 'CAMPAIGN_AGENT_REQUIRED', …);
```

Same code, same status, same message as before — the existing
`CAMPAIGN_AGENT_REQUIRED`. Both causes converge deliberately: an operator whose
agent was unassigned and an operator who never chose one face the identical
remedy, which is to pick an agent, and a second error code would only ask them
to tell apart two situations with one fix. The message, "Assign an agent before
starting this campaign", is already true of both.

The query is skipped entirely when `agentId` is null, so the common failure
costs nothing extra, and it runs before the pending-contacts count so the
cheaper check fails first.

## Serialization

`serializeCampaign` gains an `agent` field: `{ id, name, status } | null`.

Three fields, chosen for what the dashboard renders and nothing more: the name
to display, the id to link to `/agents/:id` and to preselect in the picker, and
the status for the pill. Not `serializeAgentSummary` — that projects eight
fields including voice, language and document count, none of which a campaign
row shows, and a summary that grows because the agent surface needed a field
would quietly widen this payload too.

Loaded with `include: { agent: { select: { id, name, status, workspaceId } } }`
in the same query as the campaign, so the list is one round trip regardless of
how many campaigns it returns. `workspaceId` is selected but **never emitted**:
it is read to decide whether the agent still belongs to this workspace, and
dropped from the response.

That check is what keeps the third state honest, and it has to happen in the
serializer. Prisma cannot put a `where` on a to-one `include`, so the join
returns the agent whatever workspace it now sits in. Emitting it unfiltered
would print another workspace's agent name in this workspace's campaign list —
a leak the rest of the codebase spends real effort preventing, arriving through
a relation nobody thought to scope.

So:

| `agentId` | Agent row | Its workspace | `agentId` out | `agent` out |
|---|---|---|---|---|
| `null` | — | — | `null` | `null` |
| set | exists | this one | the id | `{ id, name, status }` |
| set | exists | another, or none | the id | `null` |

`agentId` is emitted verbatim in every case, including the last. Nulling it in
the response would make "unavailable" indistinguishable from "not set" on the
wire and leave the dashboard unable to tell the reader why Start is refused.
The name is withheld; the fact that a pointer exists is not — that fact is this
workspace's own campaign data, and hiding it would be the same mistake as
rendering a missing value as blank.

## Dashboard

**The picker.** A searchable dropdown over `GET /api/workspaces/:id/agents`,
the endpoint the agents list already uses. Each option shows the agent name and
a status pill; a "No agent" option clears the field. ADMIN-only and disabled
under exactly the same rule as every other field on the form — one `canEdit`
prop, not a second gate that can drift from the first.

Native `<select>` cannot hold a status pill in an option or filter as you type,
so this is a listbox: a text input that filters, a keyboard-navigable list
(`↑` `↓` `Enter` `Escape`), and `role="combobox"` with `aria-activedescendant`
so the choice is announced rather than merely rendered.

The list loads once when the tab opens. Failure is not silent and not fatal:
the field falls back to reporting that agents could not be loaded and offers a
retry, and the rest of the form stays usable — a campaign's retry settings
should not become uneditable because one request failed.

When the campaign holds an agent that is not in the list — the unavailable
state — the picker says so in place of a name, with the raw id beneath it, so
the operator can see what it points at and choose a replacement.

**List and detail.** The Agent column renders the agent's name as a link to
`/agents/:id`, `Not set` when `agentId` is null, and `Unavailable` when it is
set but did not resolve. Never blank: a blank cell reads as a rendering bug, and
these three states have three different remedies.

**Start.** The button is disabled when the campaign has no usable agent, with
the reason stated next to it rather than in a tooltip — a disabled control whose
explanation requires hovering is a puzzle on a touchscreen. If the API refuses
anyway, its message is shown as-is; `CAMPAIGN_AGENT_REQUIRED` is already
actionable as written and rewording it here would let the two drift.

## Testing

Backend, Vitest + Supertest against `TEST_DATABASE_URL`, written before the
code:

- **PATCH** accepts an agent in the workspace and persists it; `422
  CAMPAIGN_AGENT_NOT_FOUND` for a nonexistent id, an unassigned agent, and
  another workspace's agent — the same code and message for all three, asserted
  as identical so a future change cannot make them distinguishable; `null`
  clears the field; an unrelated field patches without disturbing `agentId`.
- **Non-enumeration**, explicitly: the response for another workspace's real
  agent is byte-identical to the response for an id that names nothing.
- **start / resume** succeed with a workspace agent; both fail
  `409 CAMPAIGN_AGENT_REQUIRED` when the agent has been unassigned, and when
  `agentId` is null.
- **Foreign key** — deleting an agent nulls the referencing campaign's
  `agentId` and leaves the campaign standing.
- **Serialization** — the summary is present and carries exactly three fields;
  it is `null` for an unassigned agent while `agentId` remains set; no
  `workspaceId` appears anywhere in the payload; the list issues no per-row
  query.

Dashboard, Vitest + Testing Library: the picker filters, clears, and reports a
load failure without disabling the rest of the form; the Agent cell renders all
three states.
