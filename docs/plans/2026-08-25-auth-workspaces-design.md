# Auth & Workspaces — Design

Date: 2026-08-25. Scope: authentication, tenancy (Account → Workspace → Member), and the workspace switcher, across `ye-voice-backend` and `ye-voice-dashboard`.

## Decisions

- **Clerk is authentication only** — sign-up/sign-in, sessions, JWTs. Methods: Google OAuth, email+password, email code (OTP). No Clerk Organizations; tenancy is our own Postgres tables.
- **Single signed-in account.** The workspace switcher lists every workspace the account owns or is a member of (grouped under the account email, checkmark on active, number shortcuts). No multi-account sign-in.
- **Invites are in-app accept only** (v1). No email sending; pending invites surface in the invitee's app after sign-in, matched by email.
- **Auth UI is fully custom** (Clerk headless hooks), Linear-quality.

## Data model

```prisma
enum WorkspaceRole { ADMIN MEMBER }
enum InviteStatus  { PENDING ACCEPTED DECLINED REVOKED }

Account         id, clerkUserId @unique, email @unique, name?, imageUrl?, credits BigInt @default(0), createdAt
Workspace       id, name, slug @unique, color?, ownerAccountId, createdAt
WorkspaceMember id, workspaceId, accountId, role, createdAt, @@unique([workspaceId, accountId])
WorkspaceInvite id, workspaceId, email, role, status, invitedById, createdAt, @@unique([workspaceId, email, status])
```

- Workspace creation also inserts a `WorkspaceMember(role: ADMIN)` row for the owner, so listing and permission checks are pure membership queries; ownership matters only for delete/transfer.
- Permissions: owner and ADMIN are equivalent in-workspace. MEMBER can use the workspace but cannot manage billing, invites, roles, or members.

## Backend

- Clerk middleware verifies the Bearer JWT → `clerkUserId`; `ensureAccount` upserts the Account (email/name/image from Clerk) on first sight.
- Workspace-scoped routes resolve `clerkUserId → Account → WorkspaceMember(workspaceId) → role` and attach `{ account, workspace, role }`; missing membership → 403. ADMIN-only guard on management routes.
- Since 2026-09-16 the chain has one bypass: an `Account.isSuperAdmin` flag admits staff as ADMIN of any live workspace, audited — see `2026-09-16-super-admin-design.md`.

Routes:

```
GET    /api/me                                  → account + workspaces(with role) + pendingInvites
POST   /api/workspaces                          → create (creator = owner + ADMIN member)
PATCH  /api/workspaces/:id                      → rename (ADMIN)
GET    /api/workspaces/:id/members              → list members + pending invites (any member; invites ADMIN-only)
POST   /api/workspaces/:id/invites              → invite email+role (ADMIN)
DELETE /api/workspaces/:id/invites/:inviteId    → revoke (ADMIN)
POST   /api/invites/:id/accept                  → invitee only (Account.email must match invite.email)
POST   /api/invites/:id/decline                 → invitee only
PATCH  /api/workspaces/:id/members/:memberId    → change role (ADMIN)
DELETE /api/workspaces/:id/members/:memberId    → remove (ADMIN) or self-leave
```

JSON envelope `{ success, data | error: { code, message } }` throughout.

## Dashboard

- `/sign-in`, `/sign-up`: centered narrow card, YE wordmark; Google button, divider, email flow (password with "use a code instead" toggle); Clerk `useSignIn` / `useSignUp`; inline errors. `middleware.ts` guards all app routes.
- Bootstrap after sign-in: `GET /api/me`.
  - No workspaces & no invites → `/onboarding` (create workspace: name → auto slug, palette color).
  - Pending invites → shown above the create form (Accept / Decline).
  - Has workspaces → redirect to last-active (localStorage) else first.
- **Switcher**: top-left workspace button (avatar initial badge + name + chevron) → dropdown: Settings, Invite and manage members (ADMIN), Switch workspace ▸, Log out. Submenu: account email header, workspace rows with checkmark on active and number shortcuts 1–9, footer "Create or join a workspace…". Keyboard `O then W`.
- Active workspace in React context + localStorage; switching re-scopes all data hooks to `/api/workspaces/:id/...`.
- Members settings page: members table (role dropdown, remove), pending invites (revoke), invite form — ADMIN; read-only list for MEMBER.

## Error handling & testing

- Backend: typed error codes (`UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `INVITE_EMAIL_MISMATCH`, `ALREADY_MEMBER`, `SLUG_TAKEN`); vitest integration tests over the membership/permission matrix and invite lifecycle.
- Dashboard: playwright smoke for sign-in redirect, onboarding, switcher switching.
