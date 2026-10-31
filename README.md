# ye-voice-backend

API backend for the YE Voice AI platform. Express + TypeScript + Prisma (Postgres) + Clerk.

## Setup

```bash
npm install
cp .env.example .env      # then fill in the values below
npx prisma generate
npm run dev               # http://localhost:3001
```

## Environment

| Variable | Required | Purpose |
|----------|:--------:|---------|
| `DATABASE_URL` | ✅ | Postgres connection string |
| `CLERK_SECRET_KEY` | ✅ | Clerk backend key — verifies caller JWTs |
| `CLERK_PUBLISHABLE_KEY` | | Clerk frontend key |
| `REDIS_URL` | ✅ | Redis connection string — the queues run on it |
| `PORT` | | API port, defaults to `3001` |
| `CORS_ORIGIN` | | Allowed browser origin, defaults to `http://localhost:3000` |
| `TEST_DATABASE_URL` | for tests | Local Postgres used by the test suite |
| `TEST_REDIS_URL` | for tests | A dedicated **database index** on the local Redis, e.g. `redis://localhost:6382/10` — never the dev index, or the suite publishes onto the dev server's queues |

`.env` is gitignored and must never be committed.

## Local services

Postgres and Redis run in Docker on non-default ports so they do not clash with
anything else on the machine:

```bash
docker run -d --name ye-dev-pg    -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=ye_voice -p 5436:5432 postgres:16
docker run -d --name ye-dev-redis -p 6382:6379 redis:7
```

```
DATABASE_URL=postgresql://postgres:devpass@localhost:5436/ye_voice
REDIS_URL=redis://localhost:6382
```

## Database

```bash
npx prisma migrate dev --name <name>   # create a migration (local only)
npx prisma migrate deploy              # apply pending migrations
npx prisma studio
```

`prisma migrate reset` is destructive and must never be run against a shared or
deployed database.

Applying migrations to a deployed database is always an explicit, opt-in command —
pass the URL inline so it can never be picked up by accident:

```bash
DATABASE_URL="<deployed-url>" npx prisma migrate status   # read-only check first
DATABASE_URL="<deployed-url>" npx prisma migrate deploy
```

Use `migrate deploy`, never `migrate dev`: `deploy` only applies pending
migrations forward and has no reset path, whereas `migrate dev` may offer to
reset a database whose history it does not recognise.

## Tests

Tests run against `TEST_DATABASE_URL` and never against `DATABASE_URL`. The
harness refuses to start if `TEST_DATABASE_URL` is unset or points at a hosted
Neon database.

The suite also refuses to start without `TEST_REDIS_URL` — a database index of
its own on the local Redis (the local convention pins dev on `/9`, tests on
`/10`; the battle and conformance harnesses take `/11`–`/13`). Queues are keyed
by name and not by database, so a suite pointed at the dev index would share
`campaign-dispatch` with a running dev server.

```bash
docker run -d --name ye-test-pg -e POSTGRES_PASSWORD=test -p 5435:5432 postgres:16
export TEST_DATABASE_URL=postgresql://postgres:test@localhost:5435/postgres
export TEST_REDIS_URL=redis://localhost:6382/10

npm run test:prepare   # apply migrations to the test database
npm test
```

Tests authenticate by sending `X-Test-Clerk-User: <clerkUserId>|<email>` instead
of a Clerk JWT. That branch is only reachable when `NODE_ENV=test`, and
`createApp()` refuses to boot if it is ever enabled in production.

The Vocobase client is mocked with `vi.mock` in every test that touches it. No
test makes a real network call, so the suite is deterministic, runs offline,
and cannot reach the live partner account.

## API

All responses use the envelope `{ success: true, data }` or
`{ success: false, error: { code, message } }`.

| Method | Route | Access |
|--------|-------|--------|
| `GET` | `/health` | public |
| `GET` | `/api/me` | authenticated |
| `POST` | `/api/workspaces` | authenticated |
| `PATCH` | `/api/workspaces/:workspaceId` | ADMIN |
| `GET` | `/api/workspaces/:workspaceId/members` | any member |
| `PATCH` | `/api/workspaces/:workspaceId/members/:memberId` | ADMIN |
| `DELETE` | `/api/workspaces/:workspaceId/members/:memberId` | ADMIN, or self-leave |
| `POST` | `/api/workspaces/:workspaceId/invites` | ADMIN |
| `DELETE` | `/api/workspaces/:workspaceId/invites/:inviteId` | ADMIN |
| `POST` | `/api/invites/:inviteId/accept` | invitee |
| `POST` | `/api/invites/:inviteId/decline` | invitee |
| `GET` | `/api/workspaces/:workspaceId/agents` | any member |
| `GET` | `/api/workspaces/:workspaceId/agents/:agentId` | any member |
| `GET` | `/api/workspaces/:workspaceId/agents/:agentId/documents` | any member |
| `GET` | `/api/workspaces/:workspaceId/agents/:agentId/functions` | any member |
| `GET` | `/api/workspaces/:workspaceId/agents/:agentId/tools` | any member |
| `POST` | `/api/workspaces/:workspaceId/agents/sync` | any member |
| `POST` | `/api/admin/agents/sync` | staff token |
| `GET` | `/api/admin/agents` | staff token |
| `POST` | `/api/admin/agents/:agentId/assignment` | staff token |

`/api/admin/*` is rate limited per caller address (`ADMIN_RATE_LIMIT_MAX`,
default 60 a minute). Going over returns `RATE_LIMITED` (429) with a
`Retry-After` header. The limit is applied before the token is checked, so it
bounds guessing rather than staff work.

Error codes: `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`,
`INVITE_EMAIL_MISMATCH`, `ALREADY_MEMBER`, `ALREADY_INVITED`,
`CANNOT_MODIFY_OWNER`, `RATE_LIMITED`, `UPSTREAM_ERROR`, `INTERNAL_ERROR`.

`UPSTREAM_ERROR` (502) means Vocobase could not be reached or
refused the request. It is deliberately distinct from `NOT_FOUND`, so a caller
can tell "retry later" from "this agent is not yours".

## Agents

Agents are configured in Vocobase and mirrored into a local `Agent` table.
There is one partner account, so all agents arrive in one pool; a nullable
`workspaceId` assigns each to at most one workspace. Unassigned agents are
invisible to every workspace and reachable only through `/api/admin/*`.

Workspaces get a read-only view: there is no route to create, edit or delete
an agent. Requesting an agent that belongs to another workspace returns 404,
identical to one that does not exist — a 403 would confirm the id is real.

Sync owns configuration; staff own assignment. The sync upsert never writes
`workspaceId`.

## Tenancy

`Account` → `Workspace` → `WorkspaceMember`. Clerk authenticates people only;
membership and permissions live in Postgres. A workspace owner also holds an
ADMIN member row, so every permission check is a membership lookup. ADMIN and
owner are equivalent inside a workspace except that the owner cannot be demoted
or removed.
