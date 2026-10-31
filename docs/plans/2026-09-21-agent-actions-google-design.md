# Agent actions: pre-call, post-call, and Google — design

2026-09-21. Spans  (the bulk),  (the
editor and the Integrations page) and one Vocobase platform release (three
hook sources and a V2 route family — see §9).

**Supersedes `2026-09-01-call-actions-design.md` for v1.** That proposal built
a second action engine inside this backend — its own tables, its own queue, its
own egress guard, its own encryption key — and left twelve questions open. The
platform already runs the engine this design needs: pre-call and post-call
lifecycle hooks executed backend-side, Google Sheets lookup and append, custom
function hooks, OAuth tokens stored encrypted with single-flight refresh, an
audit row per run, hosted OAuth for a partner's customers, and CRUD for all of
it on the V2 partner API. v1 **drives that engine** and adds the three things
it lacks (Calendar and Gmail as post-call sources, conditional hooks, and V2
access to the inbound face). The in-house engine remains the answer if
per-campaign actions or customer-URL webhooks are ever wanted on their own
terms; nothing here forecloses it.

## 1. What a reader can do when this ships

On an agent's **Variables & actions** tab:

- **Before the call** — add *Look up a row in Google Sheets* (match the
  callee's phone against a column, map columns to variables the prompt can
  use), or *Call a function* (one of the workspace's functions, with a
  templated input; its result is exposed under a name).
- **After the call** — add *Append the extraction to a sheet*, *Append a
  custom row*, *Create a calendar event* (e.g. at `{{extraction.callback_at}}`),
  *Send an email* (e.g. a summary to the lead's `{{extraction.email}}`), or
  *Call a function*. Each can be **conditional**: it runs only when named
  values are present (`skip_unless: ["extraction.callback_at"]`), so an agent
  that books a callback on one call in five does not error on the other four.
- Every template field has a **picker** listing what exists at that moment:
  the agent's declared variables, the call-time fields, what earlier pre-call
  actions supply, the extraction keys, the post-call facts (duration, transcript
  summary, recording link), and the campaign context this dialer stamps on
  every outbound call.
- Reorder, pause, delete, and **preview** an action's rendered input against
  sample variables.

On **Settings → Integrations** (admins): connect Google Sheets, Google Calendar
and Gmail for this workspace, see which account is connected, disconnect.

On a **call's detail page**: which actions ran around this call, each with its
outcome, latency and a one-line error when it failed.

## 2. Ownership and tenancy

The platform's connections are **partner-wide** — one partner account, every
workspace's OAuth tokens in one pool. Today
this backend keeps workspaces apart with `WorkspaceResource(kind=CONNECTION)`
mappings created by staff. This design makes the mapping self-service and
exact by giving each workspace its own **partner customer** upstream:

- `Workspace.partnerCustomerId String?` — the platform's `PartnerCustomer.id`,
  created on first use with `POST /api/v2/customers { external_id: <workspace.id>,
  name }` (idempotent on `external_id`, so a retry after a lost response finds
  the same row).
- A Google connection is minted through `POST /api/v2/customers/:id/connect-link`,
  so the token row upstream is owned by *this workspace's* customer, never by
  the partner user. Connections the platform reports for that customer are
  claimed into `WorkspaceResource` as they arrive, and `resourceInWorkspace('CONNECTION', …)`
  stays the single gate every bind and hook passes through — the invariant
  the tools surface already holds.

**Who may do what.** Connecting and disconnecting a Google account is
**ADMIN**: it is the act that authorises call content to leave for a mailbox or
spreadsheet of someone's choosing, and the 2026-09-01 design's argument about
egress applies to it in full. Configuring actions on an agent is **MEMBER**,
like every other agent edit: an action can
only reach a connection an admin already approved, or a function the workspace
already owns.

## 3. The connect flow

```
dashboard  POST /api/workspaces/:ws/integrations/:slug/connect        (ADMIN)
backend    ensure partner customer → nonce in Redis {ws, slug, account} TTL 15m
           POST /api/v2/customers/:pcid/connect-link
             { tool_slug, redirect_uri: `${PUBLIC_API_URL}/integrations/google/return/${nonce}` }
           → { url }                                  → dashboard: window.location = url
platform   consent → callback → redirects to redirect_uri?status=ok&tool=&connection_id=
backend    GET /integrations/google/return/:nonce   (public; the nonce is the auth)
           nonce single-use; on status=ok:
             GET /api/v2/customers/:pcid/connections  — connection_id must be in the list
             claimResource('CONNECTION', connection_id, ws, providerEmail)
           302 → `${DASHBOARD_URL}/settings/integrations?connected=<slug>`
                 or `?error=<denied|expired|not_ours|failed>`
```

- The redirect host must be on the partner user's `allowedRedirectHosts`
  upstream — an ops step per environment, listed in the handoff.
- `not_ours`: the platform named a connection the workspace's customer does
  not hold. Refused, not claimed; nothing is written.
- Slugs: `google_sheets`, `google_calendar`, `gmail` (the platform's seeded
  tools; scopes are the tool definition's).
- Disconnect: `DELETE /api/v2/customers/:pcid/connections/:connId`, then
  `unmapResource`. Tool bindings referencing it upstream go `EXPIRED/REVOKED`
  and the platform's health surface reports them; the tools tab already renders
  that status.

## 4. Actions on an agent — the YE API

All under `/api/workspaces/:ws/agents/:agentId`, `requireMembership()`.

| Route | Does |
| --- | --- |
| `GET  /lifecycle-hooks[?side=inbound]` | existing read, **extended** (§5) |
| `POST /lifecycle-hooks[?side=inbound]` | create; body §4.1 |
| `PATCH /lifecycle-hooks/:hookId[?side=inbound]` | `{ name?, input?, expose_as?, required?, timeout_ms?, enabled?, skip_unless? }` |
| `DELETE /lifecycle-hooks/:hookId[?side=inbound]` | |
| `POST /lifecycle-hooks/reorder[?side=inbound]` | `{ stage, ids }` |
| `POST /lifecycle-hooks/:hookId/preview[?side=inbound]` | `{ variables? }` → `{ input }` rendered |
| `GET  /tools/google_sheets/sheet-columns?spreadsheet_id=&sheet_name=` | proxy; requires an owned `google_sheets` binding |
| `GET  /action-runs?from=&to=&session_id=` | proxy of `GET /api/v2/integration-logs?agentId=` |

And on calls: `GET /api/workspaces/:ws/calls/:id/actions` → the runs whose
`sessionId` is this attempt's upstream session (§7).

### 4.1 Create body

```ts
{
  stage: 'pre_call' | 'post_call',
  name: string,                              // ≤ 200
  source:
    | { kind: 'tool', tool_slug: 'google_sheets'|'google_calendar'|'gmail', tool_fn: string, connection_id?: string }
    | { kind: 'function', function_id: string },
  input: Record<string, unknown>,            // per-fn shape, §6
  expose_as?: string,                        // pre_call only; required for lookup_row
  required?: boolean, timeout_ms?: number,
  skip_unless?: string[],                    // post_call only; template paths
}
```

- **Tool hooks need the tool bound on the agent** (the platform 422s
  `TOOL_NOT_CONNECTED` otherwise). The backend binds it inside the create when
  it is not: `connection_id` is then required, must pass
  `resourceInWorkspace('CONNECTION')`, and goes to `PUT /api/v2/agent/:id/tools/:slug`
  before the hook `POST`. An already-bound tool ignores `connection_id`.
  Same rule as the tools tab: enabling without naming a connection is refused,
  because upstream's default would pick from the partner pool.
- **Function hooks** must name a function the workspace owns
  (`resourceInWorkspace('FUNCTION')`) and it must be attached to the agent;
  the platform's own function-attached check is the second line.
- Platform 422 `VALIDATION_FAILED { issues }` passes through **verbatim** as
  422 with the same envelope — the issues name fields the form shows
  (`input.columns[2].header`, `expose_as`) and rewriting them loses that.
- **Sides.** `?side=inbound` is honoured only when `direction === 'BI'` and a
  face exists; otherwise 404 `INBOUND_NOT_ENABLED`. It routes to the platform's
  `/api/v2/agents/:id/inbound/lifecycle-hooks` family (§9). In `UNI` with a
  face, **every write mirrors**: after the base write succeeds the backend
  `PUT`s the face's list wholesale from the base's current list
  (`PUT /api/v2/agents/:id/inbound/lifecycle-hooks { hooks }`, replace-all).
  A face sync failure returns 200 with `inboundActionsSynced: false` and
  `inboundActionsError`, the pattern the agent save already uses; the next
  successful write re-syncs, because replace-all is idempotent. Tool binds
  mirror the same way through `PUT .../inbound/tools/:slug`.

## 5. The read, extended

`serializeLifecycleHooks` today withholds `input` and the source ids because
the rows were YE-staff configuration. They are now the workspace's own, so a
row carries, **when the workspace owns its source**: `tool_slug`, `tool_fn`,
`function_id`, `input`, `skip_unless`, and `owned: true`. Ownership is decided
by the predicate the tools list already uses (`toolOwnership` — the agent's
binding for that slug maps to this workspace; for a function,
`resourceInWorkspace('FUNCTION')`). An unowned row (bound by staff to a pool
connection) keeps today's summary shape with `owned: false`, and every write to
it 404s `RESOURCE_NOT_FOUND` — identical to the tools tab's rule. `supplies`
and `declares_fields` are unchanged and keep feeding the Variables list.

## 6. Sources and their inputs

The platform's own shapes, restated so the editor and the picker have one
table to read. `{{path}}` placeholders resolve against the scope in §7.

| Stage | Source | `tool_fn` | `input` |
| --- | --- | --- | --- |
| pre | Google Sheets | `lookup_row` | `{ match_column, match_value: "{{callee_phone}}", match_mode: 'phone'\|'exact', columns: [{header, variable}], spreadsheet_id, sheet_name }` — requires `expose_as`; a miss fills the variables with `''`, never fails |
| pre / post | Function | — | free object; result exposed under `expose_as` (pre) |
| post | Google Sheets | `append_extraction` | `{ spreadsheet_id, sheet_name, columns?: [{header, value}] }` — without `columns` the platform writes `[timestamp, session_id, …extraction values]` |
| post | Google Sheets | `append_row` | `{ spreadsheet_id, sheet_name, values: string[] }` |
| post | Google Calendar | `create_event` | `{ summary, start, end?, duration_minutes?=30, timezone?, description?, attendees?, calendar_id?='primary', add_meet?=false }` **(new, §9)** |
| post | Gmail | `send_email` | `{ to, subject, body, cc?, reply_to? }` **(new, §9)** |

`spreadsheet_id` / `sheet_name` are always carried on the hook input, never on
the agent's `googleSheetId` columns — the V2 agent update does not accept those,
and per-hook is the shape that lets two sheets coexist.

## 7. The template scope, and what this dialer adds to it

What a `{{path}}` can name, by stage — the platform's contract:

- **pre-call**: call-time fields (`from_number`, `to_number`, `caller_phone`,
  `callee_phone`, `call_direction`, `session_id`, `agent_name`); the variables
  the call started with; `pre_call.<expose_as>.<field>` from earlier actions
  (they run in `position` order).
- **post-call**: all of the above, plus `extraction.<key>` for every key in
  the agent's extraction config, and `duration_secs`, `ended_at`,
  `ended_at_offset`, `recording_url` (a signed link minted only when a
  template names it), `transcript_text`, `transcript_summary`, `agent_id`.

**Campaign context, stamped by this dialer.** An outbound call started by a
campaign carries, beside the goal variable it already sends, four reserved
variables spread after the contact projection so a CSV column cannot shadow
them: `ezo_campaign_id`, `ezo_campaign_name`, `ezo_contact_id`,
`ezo_attempt_no`. They ride in `Session.variables`, so a post-call template can
write `{{ezo_campaign_name}}` into a sheet column and a function hook can key
its side on `{{ezo_contact_id}}`. The `ezo_` prefix is reserved: declaring such
a name as a per-call variable is refused the way a hook-supplied name is
(`agents.routes.ts:317`), and the CSV mapper never offers it. Inbound calls
carry none of these — nothing dialed them — and the picker says so
("outbound campaign calls only"); an inbound agent gets its context from a
pre-call lookup on `caller_phone` instead, which is the point of having one.

The dashboard's picker is built from data it already holds plus the extended
hook read: the agent detail (`variables`, `extraction_config.keys`), the
pre-call rows' `supplies` and, for owned `lookup_row` rows, the `columns`
their `input` names, and three static lists (call-time, post-call synthetic,
campaign context) kept in one module beside `lib/variables/registry`.

## 8. Run visibility

The platform writes one `IntegrationCallLog` row per hook run (`fn:
pre_call_<fn>` / `post_call_<fn>`, status `OK | UPSTREAM_ERROR | DENIED |
RATE_LIMITED | MISSING_REQUIRED_FIELDS | SKIPPED`, `latencyMs`, a redacted
args summary, an error message) and serves them on
`GET /api/v2/integration-logs?agentId=&toolSlug=&from=&to=&sessionId=`
(30-day window; the `sessionId` filter is new, §9). Two YE reads:

- **per agent** — `GET …/agents/:id/action-runs?from&to`: the last 24h by
  default, paged by the platform cursor, rendered at the foot of the
  Variables & actions tab as *Recent runs*.
- **per call** — `GET …/calls/:id/actions`: the attempt's
  `upstreamSessionId` is the `sessionId` filter; a call with no upstream
  session (never placed) answers an empty list with `reason: 'not_placed'`.

Nothing is stored here; a pruned platform window renders as "older than the
platform keeps", not as "nothing ran".

## 9. What the platform has to ship first (Vocobase release)

Designed in `backend/docs/plans/2026-09-21-lifecycle-hooks-google-actions-v2-face-design.md`
in the platform repo. In one line each:

1. `google_calendar · create_event` and `gmail · send_email` as `POST_CALL`
   hook sources in `lifecycleHooks/source.ts`, using the tokens the mid-call
   handlers already get.
2. `AgentLifecycleHook.skipUnless String[]` — skip (logged `SKIPPED`) when any
   named path renders empty.
3. `/api/v2/agents/:id/inbound/lifecycle-hooks` (GET, PUT replace-all, POST,
   PATCH, DELETE, reorder, preview) and `/api/v2/agent/:id/inbound/tools[/:slug]`,
   resolved through `resolveInboundFace`; 404 `INBOUND_NOT_ENABLED` without one.
4. `sessionId` on `GET /api/v2/integration-logs`.
5. Ops: YE's API hosts on the partner user's `allowedRedirectHosts`.

Until 1–2 land, the YE editor offers Sheets and functions only (the source
catalog is one array). Until 3 lands, `?side=inbound` and the `UNI` mirror
return 501 `INBOUND_ACTIONS_UNAVAILABLE` and the dashboard shows the face's
actions read-only with that sentence — a stated gap, not a silent one.

## 10. What this does not do

- **Per-campaign actions.** Hooks are per agent (per face). A campaign that
  wants its own sheet gets its own agent, or a column keyed on
  `{{ezo_campaign_name}}`. Templating `spreadsheet_id` from a variable is the
  cheap upgrade (the platform's save-time write probe would need to skip
  templated ids); the in-house engine is the expensive one.
- **Customer-URL webhooks with YE signing.** A function hook already POSTs to
  any URL with stored headers; a signed, retried, redeliverable outbox is the
  2026-09-01 design, deferred.
- **Retries and a ladder.** The platform's post-call queue retries a *job*
  three times; a hook that fails inside the job is logged, not re-run.
  Redeliver is not offered.
- **Pre-call Calendar** (free/busy into a variable) — v2, once a customer asks.
