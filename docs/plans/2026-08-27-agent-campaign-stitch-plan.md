# Agent ↔ Campaign Stitch (Backend) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn `Campaign.agentId` from an unconstrained string into a real, workspace-validated relation to the local `Agent` mirror, as described in `2026-08-27-agent-campaign-stitch-design.md`.

**Architecture:** One additive migration adding a foreign key (preceded by a deterministic `UPDATE` that clears every id which does not resolve to an agent in the same workspace), one new resolver in `src/lib/campaign.ts` that both write paths share, and a widened `serializeCampaign` that embeds a three-field agent summary loaded through a relation `include` — so no route issues a per-row agent query.

**Tech Stack:** Express 4, TypeScript, Prisma 6, Zod 4. Vitest + Supertest.

**Test safety (read first):** Tests run only against `TEST_DATABASE_URL`, which `test/setup.ts` asserts is set and is not a Neon host. That guard stays exactly as it is — if it trips, fix the environment, never the guard. Migrations reach the test DB through `npm run test:prepare` (`prisma migrate deploy`), never through `prisma migrate reset`.

**Rules that apply to every task:**

1. No query looks an agent up by id alone. Always `where: { id, workspaceId }`.
2. A workspace must never learn that another workspace's agent id is real. One status code, one message, for every way a lookup can fail.
3. `Agent.workspaceId` is set by staff with an `UPDATE`, so the foreign key holding does **not** mean the agent still belongs to the campaign's workspace. Re-resolve; never infer ownership from `agentId != null`.

---

### Task 1: The relation and its migration

**Files:**
- Modify: `prisma/schema.prisma` (the `Campaign` and `Agent` models)
- Create: `prisma/migrations/<timestamp>_campaign_agent_fk/migration.sql`

**Step 1: Declare the relation**

In `model Campaign`, replace the "Deliberately not a relation" comment block on `agentId` with:

```prisma
  /// The agent this campaign dials with. Nullable, and null is a real state:
  /// a draft campaign has not chosen one yet, and `ON DELETE SET NULL` returns
  /// a campaign to that state when its agent row is deleted.
  ///
  /// A set value does NOT prove the agent is still this workspace's. Staff
  /// unassign by setting `Agent.workspaceId = null`, an UPDATE the constraint
  /// cannot see, so every read that matters re-resolves against the workspace.
  agentId     String?
```

and add to the relation block at the bottom of the model:

```prisma
  agent     Agent?            @relation(fields: [agentId], references: [id], onDelete: SetNull)
```

In `model Agent`, add the back-relation (Prisma requires both sides; it emits no SQL):

```prisma
  campaigns Campaign[]
```

Leave `@@index([agentId])` exactly as it is — it is what lets the constraint be added without a table rewrite.

**Step 2: Generate the migration without applying it**

Run: `npx prisma migrate dev --name campaign_agent_fk --create-only`

Expected: a new `prisma/migrations/<timestamp>_campaign_agent_fk/migration.sql` containing an `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY`. Nothing is applied yet.

**Step 3: Prepend the cleanup UPDATE**

Prisma generates only the constraint. Postgres will refuse it on any database holding a dangling id, so edit the file to put this **above** the generated `ALTER TABLE`:

```sql
-- `agentId` has been an unconstrained string since the campaigns slice, filled
-- from a free-text field. Anything could be in it: a typo, an id whose agent
-- has since been removed, or another workspace's agent id.
--
-- Postgres refuses to add a foreign key while any row violates it, so the
-- column is cleaned first, in this migration, rather than failing the deploy.
--
-- This clears MORE than the constraint requires, deliberately. A foreign key
-- only asks whether the referenced row exists; it has no opinion on whose it
-- is. Matching on workspace as well also clears a pointer to an agent that
-- exists but belongs to another workspace or to none -- exactly the rows the
-- new PATCH rule refuses to create. Leaving them would grandfather in the
-- cross-workspace references this constraint exists to end.
--
-- Set-based and ordering-independent: re-running it changes nothing.
UPDATE "Campaign" c SET "agentId" = NULL
WHERE c."agentId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Agent" a
    WHERE a."id" = c."agentId"
      AND a."workspaceId" = c."workspaceId"
  );
```

**Step 4: Apply locally and to the test database**

Run: `npx prisma migrate dev` then `npm run test:prepare`
Expected: both report the migration applied. `DATABASE_URL` is the local dev Postgres; production is never a target of either command.

**Step 5: Verify the constraint is real**

Run:
```bash
psql "$DATABASE_URL" -c '\d "Campaign"' | grep -i 'foreign key'
```
Expected: `"Campaign_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"(id) ON DELETE SET NULL`

**Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: relate a campaign to the agent it dials with"
```

---

### Task 2: Resolving an agent inside a workspace

**Files:**
- Modify: `src/lib/campaign.ts`
- Modify: `src/lib/errors.ts`
- Test: `test/campaign-agent.test.ts` (create)

**Step 1: Write the failing test**

Create `test/campaign-agent.test.ts`. It needs an agent factory the suite does not have yet — add it to `test/helpers.ts` first:

```ts
export async function makeAgent(
  workspace: Workspace | null,
  name: string,
  status = 'active',
): Promise<Agent> {
  return prisma.agent.create({
    data: {
      externalId: `ext_${name}_${Math.random().toString(36).slice(2, 8)}`,
      workspaceId: workspace?.id ?? null,
      name,
      status,
    },
  });
}
```

Then the first cases:

```ts
describe('assigning an agent to a campaign', () => {
  it('accepts an agent in the same workspace', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Sales');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3' },
    });

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ agentId: agent.id });

    expect(res.status).toBe(200);
    expect(res.body.data.agentId).toBe(agent.id);
    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.agentId).toBe(agent.id);
  });

  it('422s an agent from another workspace, a nonexistent id, and an unassigned agent identically', async () => {
    const alice = await makeAccount('alice');
    const mine = await makeWorkspace(alice, 'A Co');
    const theirs = await makeWorkspace(alice, 'B Co');
    const foreign = await makeAgent(theirs, 'Theirs');
    const unassigned = await makeAgent(null, 'Pool');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: mine.id, name: 'Q3' },
    });
    const auth = as('user_alice', 'alice@ezo.test');

    const patch = (agentId: string) =>
      request(app)
        .patch(`/api/workspaces/${mine.id}/campaigns/${campaign.id}`)
        .set(...auth)
        .send({ agentId });

    const results = await Promise.all([
      patch(foreign.id),
      patch(unassigned.id),
      patch('agent_does_not_exist'),
    ]);

    for (const res of results) {
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('CAMPAIGN_AGENT_NOT_FOUND');
    }

    // Byte-identical: a caller must not be able to sort ids into real and
    // unreal by comparing responses.
    expect(new Set(results.map((r) => JSON.stringify(r.body))).size).toBe(1);

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.agentId).toBeNull();
  });

  it('clears the agent when sent null', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Sales');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', agentId: agent.id },
    });

    const res = await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ agentId: null });

    expect(res.status).toBe(200);
    expect(res.body.data.agentId).toBeNull();
  });

  it('leaves an existing agent alone when the field is absent', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Sales');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', agentId: agent.id },
    });

    await request(app)
      .patch(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...as('user_alice', 'alice@ezo.test'))
      .send({ name: 'Q4' });

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.agentId).toBe(agent.id);
  });
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run test/campaign-agent.test.ts`
Expected: FAIL. The 422 cases return 500 — Prisma rejects the foreign key — rather than the envelope.

**Step 3: Add the error code**

In `src/lib/errors.ts`, add `'CAMPAIGN_AGENT_NOT_FOUND'` to the `ErrorCode` union, next to the other `CAMPAIGN_*` codes.

**Step 4: Write the resolver**

In `src/lib/campaign.ts`:

```ts
/**
 * Resolves an agent inside one workspace, or throws.
 *
 * The workspace is part of the lookup rather than a check after it, so no
 * caller can hold an agent it was not entitled to.
 *
 * Four causes, one answer: the id names nothing, names an unassigned agent,
 * names another workspace's agent, or is malformed. Distinguishing them would
 * let a caller sort ids into real and unreal by watching the status code, one
 * request at a time. 422 rather than 400: the body is well-formed and the
 * field is the right shape -- it is the referent that is wrong.
 */
export async function agentForCampaign(workspaceId: string, agentId: string): Promise<Agent> {
  const agent = await prisma.agent.findFirst({ where: { id: agentId, workspaceId } });

  if (!agent) {
    throw new ApiError(
      422,
      'CAMPAIGN_AGENT_NOT_FOUND',
      'That agent is not available in this workspace.',
    );
  }

  return agent;
}
```

**Step 5: Call it from PATCH**

In `src/routes/campaigns.routes.ts`, between `parseBody` and `prisma.campaign.update`:

```ts
    // Only when the field is present AND non-null. An absent field changes
    // nothing, and clearing the agent is not a reference to validate.
    if (data.agentId) {
      await agentForCampaign(campaign.workspaceId, data.agentId);
    }
```

**Step 6: Run the tests**

Run: `npx vitest run test/campaign-agent.test.ts`
Expected: PASS, all four.

**Step 7: Commit**

```bash
git add src/lib/campaign.ts src/lib/errors.ts src/routes/campaigns.routes.ts test/campaign-agent.test.ts test/helpers.ts
git commit -m "feat: refuse a campaign agent that is not the workspace's"
```

---

### Task 3: start and resume re-resolve the agent

**Files:**
- Modify: `src/routes/campaigns.routes.ts:411-417`
- Test: `test/campaign-agent.test.ts`

**Step 1: Write the failing test**

```ts
describe('starting a campaign whose agent left the workspace', () => {
  it('refuses start and resume with CAMPAIGN_AGENT_REQUIRED', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Sales');
    const contact = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+919876543210' },
    });
    const auth = as('user_alice', 'alice@ezo.test');

    for (const [status, action] of [['DRAFT', 'start'], ['PAUSED', 'resume']] as const) {
      const campaign = await prisma.campaign.create({
        data: { workspaceId: ws.id, name: `${action} me`, agentId: agent.id, status },
      });
      await prisma.campaignContact.create({
        data: { campaignId: campaign.id, contactId: contact.id },
      });

      // Staff unassign with an UPDATE. The row survives, the foreign key still
      // holds, and a null check on agentId would wave this through.
      await prisma.agent.update({ where: { id: agent.id }, data: { workspaceId: null } });

      const res = await request(app)
        .post(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/${action}`)
        .set(...auth);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CAMPAIGN_AGENT_REQUIRED');

      await prisma.agent.update({ where: { id: agent.id }, data: { workspaceId: ws.id } });
    }
  });

  it('starts when the agent is the workspace's', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Sales');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', agentId: agent.id },
    });
    const contact = await prisma.contact.create({
      data: { workspaceId: ws.id, phone: '+919876543210' },
    });
    await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });

    const res = await request(app)
      .post(`/api/workspaces/${ws.id}/campaigns/${campaign.id}/start`)
      .set(...as('user_alice', 'alice@ezo.test'));

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('RUNNING');
  });
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run test/campaign-agent.test.ts -t 'left the workspace'`
Expected: FAIL — 200 RUNNING. The null check passed a campaign whose agent is gone.

**Step 3: Replace the null check with a resolution**

In the transition handler, replace:

```ts
      if (transition.requiresAgent && !campaign.agentId) {
```

with:

```ts
      // Not a null check. `agentId` being set proves only that an Agent row
      // exists -- staff unassign with an UPDATE the foreign key cannot see, so
      // a campaign can hold a valid id for an agent this workspace no longer
      // has. The lookup is skipped when there is nothing to look up, so the
      // common failure costs no query.
      if (
        transition.requiresAgent &&
        !(campaign.agentId &&
          (await prisma.agent.findFirst({
            where: { id: campaign.agentId, workspaceId: campaign.workspaceId },
            select: { id: true },
          })))
      ) {
        throw new ApiError(
          409,
          'CAMPAIGN_AGENT_REQUIRED',
          'Assign an agent before starting this campaign.',
        );
      }
```

Same code, same status, same message as before: an operator whose agent was unassigned and one who never chose an agent have the identical remedy, and a second error code would ask them to tell apart two situations with one fix.

**Step 4: Run the tests**

Run: `npx vitest run test/campaign-agent.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/routes/campaigns.routes.ts test/campaign-agent.test.ts
git commit -m "fix: refuse to start a campaign whose agent left the workspace"
```

---

### Task 4: Embed the agent summary

**Files:**
- Modify: `src/lib/campaign.ts`
- Modify: `src/routes/campaigns.routes.ts` (every campaign read)
- Test: `test/campaign-agent.test.ts`

**Step 1: Write the failing test**

```ts
describe('campaign agent summary', () => {
  it('embeds id, name and status, and nothing else', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Sales', 'active');
    await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', agentId: agent.id },
    });

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns`)
      .set(...as('user_alice', 'alice@ezo.test'));

    const [row] = res.body.data.campaigns;
    expect(row.agent).toEqual({ id: agent.id, name: 'Sales', status: 'active' });
    // workspaceId is selected to decide visibility and must never be emitted.
    expect(JSON.stringify(res.body)).not.toContain('workspaceId');
  });

  it('reports an unassigned agent as null while keeping agentId', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Sales');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', agentId: agent.id },
    });
    await prisma.agent.update({ where: { id: agent.id }, data: { workspaceId: null } });

    const res = await request(app)
      .get(`/api/workspaces/${ws.id}/campaigns/${campaign.id}`)
      .set(...as('user_alice', 'alice@ezo.test'));

    // Not set and unavailable are different states with different remedies.
    expect(res.body.data.agent).toBeNull();
    expect(res.body.data.agentId).toBe(agent.id);
    expect(JSON.stringify(res.body)).not.toContain('Sales');
  });

  it('nulls the campaign agent when the agent row is deleted', async () => {
    const alice = await makeAccount('alice');
    const ws = await makeWorkspace(alice, 'A Co');
    const agent = await makeAgent(ws, 'Sales');
    const campaign = await prisma.campaign.create({
      data: { workspaceId: ws.id, name: 'Q3', agentId: agent.id },
    });

    await prisma.agent.delete({ where: { id: agent.id } });

    const still = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(still.agentId).toBeNull();
  });
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run test/campaign-agent.test.ts -t 'summary'`
Expected: FAIL — `row.agent` is `undefined`.

**Step 3: Widen the serializer**

In `src/lib/campaign.ts`:

```ts
/** The agent fields a campaign row needs, and no more. */
const AGENT_SUMMARY_SELECT = {
  id: true,
  name: true,
  status: true,
  // Read to decide whether the agent is still this workspace's. Never emitted.
  workspaceId: true,
} as const;

export const CAMPAIGN_INCLUDE = { agent: { select: AGENT_SUMMARY_SELECT } } as const;

type CampaignWithAgent = Campaign & {
  agent?: { id: string; name: string; status: string | null; workspaceId: string | null } | null;
};
```

and inside `serializeCampaign`, replacing the body:

```ts
export function serializeCampaign(campaign: CampaignWithAgent, contactCount?: number) {
  // Prisma cannot put a `where` on a to-one include, so the join returns the
  // agent whatever workspace it now sits in. Emitting it unfiltered would
  // print another workspace's agent name in this workspace's campaign list.
  const agent =
    campaign.agent && campaign.agent.workspaceId === campaign.workspaceId
      ? { id: campaign.agent.id, name: campaign.agent.name, status: campaign.agent.status }
      : null;

  return {
    id: campaign.id,
    name: campaign.name,
    // Emitted even when `agent` is null. Nulling it too would make
    // "unavailable" indistinguishable from "not set" on the wire.
    agentId: campaign.agentId,
    agent,
    status: campaign.status,
    …unchanged fields…
  };
}
```

**Step 4: Load the relation on every campaign read**

- `campaignInWorkspace()` — add `include: CAMPAIGN_INCLUDE` and widen its return type to `CampaignWithAgent`.
- The list route — merge `...CAMPAIGN_INCLUDE` into its existing `include` alongside `_count`. One round trip, no per-row query.
- The transition handlers — `prisma.campaign.update` returns no relation, so pass `include: CAMPAIGN_INCLUDE` there too.
- The PATCH handler — same, on its `update`.

**Step 5: Run the whole suite**

Run: `npx vitest run`
Expected: PASS. Every existing campaign test still passes; the payload only gained a field.

**Step 6: Commit**

```bash
git add src/lib/campaign.ts src/routes/campaigns.routes.ts test/campaign-agent.test.ts
git commit -m "feat: embed the assigned agent in the campaign payload"
```

---

### Task 5: Gates and docs

**Files:**
- Modify: `CLAUDE.md` (the Campaigns section)

**Step 1: Update the repo's own documentation**

Replace the "**Open stitch point:**" paragraph with what the relation now is: the foreign key, `ON DELETE SET NULL`, the 422 on PATCH, and the fact that unassignment is an UPDATE the constraint cannot see. Add `agentId?` → `agent` to the schema sketch and `CAMPAIGN_AGENT_NOT_FOUND` where the error codes are listed.

**Step 2: Run both gates**

Run: `npx tsc --noEmit`
Expected: no output.

Run: `npx vitest run`
Expected: all files pass.

**Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record the campaign-agent relation"
```
