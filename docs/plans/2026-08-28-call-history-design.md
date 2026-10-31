# Call History — Design

Date: 2026-08-28. Scope: the call-history slice across `ye-voice-backend` and `ye-voice-dashboard` — a read-only surface over the calls the platform has already placed: list, detail, transcript, recording.

This module **never causes a call**. It renders what happened. Every upstream request it makes is a `GET`.

## The shape of the problem

Three facts, and the whole design falls out of reconciling them.

**One partner account, all workspaces.** The platform holds a single Vocobase partner key. Every call every workspace has ever placed sits in one undifferentiated pool, exactly as agents do. Vocobase has no concept of our workspaces and cannot be asked to filter by one.

**The upstream listing filters by almost nothing.** `GET /calls` accepts `limit`, `offset`, and `status`. There is no agent filter, no date filter, no campaign filter. So the only way to answer "this workspace's calls" is to fetch and filter here.

**A call carries no campaign id.** Not on the list row, not on the detail, not anywhere in the V2 surface. Correlating a call to a campaign is something the *caller* arranges at dial time, and our dialer does not exist yet.

## Decisions

- **Proxy and shape, no mirror.** Routes call Vocobase per request, filter, and return. No local `Call` table, no sync service, no schema change in v1. Call history is read-often-briefly and never edited; a mirror would buy staleness and a backfill problem in exchange for latency we do not yet need.
- **Filter server-side, always.** The browser never receives a row it is not entitled to. Where upstream cannot filter, we fetch and drop.
- **The walk is bounded and says so.** A list request pages upstream at most `MAX_UPSTREAM_PAGES` times. When the budget runs out before the page is filled, the response says `truncated: true` and the UI prints what was searched. An incomplete list that reads as complete is the one outcome forbidden.
- **No total.** We cannot know how many calls a workspace has without walking its whole history, and upstream's `total` counts every workspace's calls. Reporting it would be a lie in the shape of a number.
- **The recording is proxied, never redirected.** The browser is handed our URL, not Vocobase's.
- **Visibility is a union of two legs, and history outlives usability.** An agent that has been retired, or a campaign that has been stopped, still shows its past calls.

## What the Vocobase API actually returns

Verified against the published OpenAPI (`docs.vocobase.com`) rather than assumed. Base URL `https://api.vocobase.com/api/v2`, `Authorization: Bearer <key>`, envelope `{ success, data | error }` — the same envelope this service speaks.

| Call | Response body under `data` |
|---|---|
| `GET /calls?limit&offset&status` | `{ calls: [...], total, limit, offset }` — newest first by `started_at`; `limit` caps at **100** |
| `GET /calls/:id` | a call object plus `session: { transcript, recording_url, variables, extraction, credits_used, ... }` |
| `GET /calls/:id/recording-url` | `{ call_id, recording_url, expires_in, expires_at }` — freshly signed, 7-day window |

**A list row is not a detail row.** The listing carries `call_id`, `agent_id`, `session_id`, `client_reference_id`, direction, both numbers, `status`, `disposition`, `answered_by`, `hangup_cause`, `hangup_source`, durations, and timestamps. It carries **no transcript, no recording, and no `variables`**. Every field the list view shows must come from that set, or the list becomes N+1 detail fetches.

**`status` and `disposition` are different questions.** `status` is the carrier/lifecycle state (`pending`, `ringing`, `in_progress`, `completed`, `failed`, `no_answer`, `busy`, `canceled`). `disposition` is the outcome (`completed`, `voicemail`, `user_hangup_no_speech`, `no_answer`, `busy`, `canceled`, `blocked`, `failed`, `transferred`). Voicemail is a *disposition*, never a status — a UI that filters voicemail by status finds nothing and tells the reader there were no voicemails.

Both are documented as enums, and both are **provider-controlled**: their values follow whichever carrier placed the call, and the set can grow without our deploying anything. This surface therefore treats them as **free text**, matched case-insensitively. It does not hardcode the enum, does not validate against it, and does not delegate the filter to upstream — a value upstream does not recognise is a `400` from Vocobase, which would turn a new carrier disposition into a broken filter rather than an empty result.

**A transcript is structured, and it is not always a transcript.** The documented shape is `[{ role: "user" | "bot", content, timestamp }]`. In real payloads the field is sometimes an *object* describing why there is no transcript — `{ error, provider, terminal_reason, provider_call_id }` on a call that never connected. The renderer must handle array, object, `null`, and absent, and must never present a failure object as a conversation.

## Visibility

A call is visible to a workspace when **either** leg resolves:

**The agent leg.** The call's `agent_id` is an upstream agent id. Local `Agent` rows are keyed by `externalId`, so the workspace's agent set is one query — `SELECT externalId FROM Agent WHERE workspaceId = ?` — resolved once per request into a `Set` and tested in memory.

Note what is *not* applied: `agentIsUsable` / `NOT_REMOVED`. Those predicates answer "may this workspace start something with this agent", and a retired agent must not accept new work. This surface asks a different question — "did this workspace place this call" — and the answer does not change when the agent is later retired. Filtering history by a start-gate predicate would silently erase a workspace's past the day an agent was removed upstream.

**The campaign leg.** By platform convention a caller stamps its own correlation ids into the call at dial time: into pre-call `variables`, and as a namespaced composite in `client_reference_id` (the shape seen in live traffic is `crm:<automationId>:<callJobId>`). `client_reference_id` is the only one of the two that appears on a list row, so it is the only viable handle for a listing.

This slice adopts the same shape for our own dialer: `ezo:<campaignId>:<campaignContactId>`. A call whose `client_reference_id` carries that prefix resolves to a local `Campaign`, and the campaign's `workspaceId` decides visibility.

Today nothing stamps it — the dispatcher is a later slice — so the campaign leg matches nothing and visibility is effectively agent-mapping only. That is stated plainly in the UI rather than hidden: the campaign filter's empty state says no calls have been attributed to a campaign yet. The parsing, resolution and filtering are real code and are tested against synthetic rows, so the day the dispatcher lands the surface works with no change here.

A call matching neither leg is invisible. Not 403, not an empty row — absent.

**Non-enumeration.** `agentId` and `campaignId` filter parameters are local row ids, resolved through a workspace-scoped `findFirst` before they are used. An id belonging to another workspace 404s exactly as a nonexistent one does, so the filter cannot be used to sort ids into real and unreal. The same rule governs the detail route: a call id the workspace cannot see is a 404, identical to one that never existed.

## Pagination, and what it costs

Our `page`/`limit` are over the **filtered** stream, not the upstream one. Serving page 3 means walking upstream from the top, discarding the first `2 × limit` matches, and collecting the next `limit`.

```
walk:
  upstreamOffset = 0
  pagesRead      = 0
  matched        = 0
  collected      = []

  while pagesRead < MAX_UPSTREAM_PAGES:
      batch = GET /calls?limit=100&offset=upstreamOffset
      pagesRead++ ; upstreamOffset += 100

      for row in batch.calls:
          if not visible(row):        continue
          if not passesFilters(row):  continue
          matched++
          if matched > skip and collected.length <= take:   collect(row)

      if collected.length > take:            break   # a full page plus one
      if batch.calls.length < 100:           break   # upstream exhausted
      if every row in batch older than `from`: break  # see below

  hasMore   = collected.length > take
  truncated = pagesRead == MAX_UPSTREAM_PAGES and not hasMore and upstream not exhausted
```

`MAX_UPSTREAM_PAGES = 20` — 2,000 most recent calls. Collecting `take + 1` is what makes `hasMore` honest without a count.

**The `from` early exit.** Upstream orders newest-first by `started_at`. Once an entire batch is older than the requested `from`, every subsequent row is older still, so the walk stops. This is the one place the ordering guarantee is load-bearing, and it is the reason a date-bounded query is cheap where an unbounded one is not — which is exactly what the truncation copy tells the reader to reach for.

**Cost and the shared budget.** One list request can cost 20 upstream requests against a rate limit every YE workspace shares. The agents surface already learned this: its sync is rate-limited **per workspace**, not per account, because keying on the caller lets a workspace's members multiply its share between them. The same limiter guards this list, for the same reason.

Response envelope:

```jsonc
{
  "items": [ /* shaped call summaries */ ],
  "page": 1,
  "limit": 25,
  "hasMore": true,
  "truncated": false,
  "scanned": 400        // upstream rows examined, so the UI can say what it searched
}
```

## Routes

All under the existing membership middleware. Any member may view; there is no ADMIN gate on this surface and no write route anywhere in it.

| Route | Notes |
|---|---|
| `GET /api/workspaces/:workspaceId/calls` | paginated; `?page`, `?limit`, `?agentId`, `?campaignId`, `?from`, `?to`, `?status`, `?disposition` |
| `GET /api/workspaces/:workspaceId/calls/:callId` | metadata, agent, campaign, transcript, variables, extraction |
| `GET /api/workspaces/:workspaceId/calls/:callId/recording` | streams the audio; `Range` passed through |

`:callId` is the **upstream** call id, and this is a deliberate deviation from the agents surface, where the local row id is on the wire and the Vocobase id stays inside the backend. With no mirror table there is no local id to use — the upstream id is the only handle that exists. It is an opaque UUID, useless without the partner key, and every route re-derives visibility from it rather than trusting that the caller got it from us. If a mirror is ever added, this becomes a local id and the upstream id goes back inside.

### The recording

The browser is never given Vocobase's URL. `GET .../calls/:callId/recording` re-checks visibility, mints a presigned URL upstream, fetches it, and streams the bytes back.

A redirect would be less code and is wrong three ways. The presigned URL names the supplier's storage, and the repo's two-registers rule says a customer never learns the supplier from a surface we control. It is valid for seven days and carries no notion of our membership, so once forwarded it plays for a week to anyone who has it, long after the person who obtained it left the workspace. And it cannot be revoked. Proxying keeps every play inside the workspace guard.

`Range` is passed through and `206`, `Content-Range`, `Accept-Ranges`, `Content-Length` and `Content-Type` are mirrored back, because `<audio>` seeking depends on it. The body is streamed, never buffered — a recording is an hour of audio and the process has other work to do.

**Amended during implementation.** This design assumed the dashboard could point an `<audio>` element at a guarded route. It cannot: a media element sends no `Authorization` header, and there is no cookie to fall back on across origins. Three ways out, two of them worse than the problem — redirect to the presigned URL (the thing this section exists to avoid), or put the Clerk session token in the query string (the whole account, for its full lifetime, in access logs and browser history), or download the audio as a blob first (no progressive playback, no seeking until an hour of audio has transferred).

So the backend mints its own credential: `GET .../calls/:callId/recording-token` returns an HMAC-signed token scoped to one workspace and one call, expiring in two minutes, which the player carries as `?token=`. It **authenticates only** — the mint endpoint runs the full visibility check before signing, and the playback route runs it again on every request, so the token never stands in for authorization. An unset `RECORDING_TOKEN_SECRET` makes every token invalid rather than opening the door.

A call with no recording is `404 RECORDING_NOT_AVAILABLE`, distinct from `404 NOT_FOUND` for a call that is not visible. The detail payload carries `recordingAvailable`, so the UI knows whether to render a player before it asks for bytes.

## Errors

`UPSTREAM_ERROR` (502) already exists and already carries a generic message; Vocobase's own wording is logged redacted, never returned, since it can quote the partner key. One code is added: `RECORDING_NOT_AVAILABLE`, for a call that has no audio.

An earlier draft also added `CALL_HISTORY_UNAVAILABLE` for a walk that could not complete at all. It was dropped: a failed walk already surfaces as `UPSTREAM_ERROR`, which says the same thing to a reader and is what the listing is tested to return. Two 502 codes a dashboard would render identically is a distinction only the backend can see.

`UPSTREAM_ERROR` and an empty list are rendered differently in the dashboard, always. Conflating them tells a workspace it has never placed a call when the truth is that we could not ask.

## What this slice does not do

Stated here rather than discovered later.

- **Telephony only.** Upstream exposes no session-listing endpoint; `GET /sessions/:id` reads a single browser session and only one the partner API itself created. Call history is therefore phone-call history, and a browser test session does not appear in it. The page says so rather than implying the list is everything.
- **No campaign attribution on historical calls.** Nothing stamped a correlation id before the dispatcher existed, and no heuristic will be invented to guess one. Deriving the link from the campaign's agent would attribute every manual and inbound call on that agent to the campaign — a false claim rendered as fact.
- **No local mirror, no schema change, no migration.**
- **No total, and no jump-to-last-page.** Both require knowing the size of a set we deliberately do not measure.
- **No search over transcript text.** Transcripts are detail-only upstream; searching them means fetching every call.
- **History deeper than the budget is unreachable.** The walk always starts at the newest call and is bounded at twenty pages, and there is no `?to` early exit — so a query for a window far back spends the budget on newer rows and returns an empty page marked `truncated`, at every page number. The date range narrows what matches; it cannot move where the walk starts. This binds once the shared pool exceeds roughly two thousand calls, and lifting it needs an upstream listing that filters by date, or a local mirror — not a bigger budget.
- **Offset paging over a live feed can repeat or skip a row at a page boundary.** A call arriving mid-walk shifts every later offset by one, and each page re-walks from zero at a later moment. Upstream offers only offset paging, so this cannot be closed here; it is why the surface is Previous/Next rather than numbered.

## Dashboard

A **Calls** nav entry replacing the `Sessions` placeholder, at `/calls` — matching the backend's noun, and matching what the surface actually contains.

**List.** A dense table: when, who (to/from), agent, campaign, direction, status, disposition, duration. A filter bar above it — agent (a picker over the workspace's agents), campaign, date range, and free-text status/disposition. Filters live in the query string so a filtered view is a link.

**Detail** as a slide-over from the list, so the reader keeps their place in a filtered result they may have waited for. Header: who, when, duration, status and disposition. Agent and campaign names come from the local mirrors and read `Not set` when unlinked — never a bare id, never a blank. Then variables and extraction when present, the transcript as a readable conversation, and an audio player when a recording exists.

**Every absent thing says which absent thing it is.** A call with no transcript says the transcript is unavailable and, when upstream gave a reason, says the call did not connect. A call with no recording says recording was not enabled or the call never connected. A failed fetch says the platform is unavailable and offers a retry. Four different sentences, because they are four different facts, and a blank pane is a fifth thing that says nothing.

**Truncation is visible.** When the walk hit its budget, a footer states what was searched — "Searched the 2,000 most recent calls; older calls are not included" — and points at the date range as the way to look further back.

Every fetch carries the workspace-currency check the agents and notifications surfaces already use: a response that arrives after the reader switched workspaces is discarded, never painted.

## Testing

No test touches Vocobase. The adapter is mocked with `vi.mock` in every case, as the agents slice does — the partner account is production, and this slice's whole job is reading it.

The cases that matter are the ones where the design could quietly fail:

- a call whose agent belongs to another workspace is absent from the list, and 404s by id;
- a call whose agent was retired (`status = "removed"`) is **still** listed — the regression that a start-gate predicate would cause;
- the walk stops at the page budget and reports `truncated: true`;
- the walk stops early when a batch falls entirely before `from`;
- `hasMore` is false on the last page and true when one more match exists;
- a transcript that arrives as an error object is not rendered as a conversation;
- the recording route never emits an upstream URL, and passes `Range` through;
- a `campaignId` naming another workspace's campaign 404s rather than filtering.
