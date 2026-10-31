# Call detail — design

**Status:** approved
**Repo:** `ye-voice-backend`
**Branch:** `feat/call-detail`

## What already exists

This wave is mostly **filling gaps in a shipped surface**, not building one. Before
designing anything, the existing call surface was read end to end. It already provides:

- `GET /api/workspaces/:id/calls/:callId` — `src/services/callHistory.ts:getWorkspaceCall`,
  projected by `src/lib/serialize.ts:serializeCallDetail`. It returns direction, both
  numbers, status, disposition, `answeredBy`, hangup cause and source, `startedAt` /
  `endedAt`, duration and billed duration, a resolved local `agent {id,name}`, a resolved
  `campaign {id,name}`, the transcript as a discriminated union, bounded `variables` and
  `extraction`, `recordingAvailable`, and `processingComplete`.
- Workspace scoping that the detail path **shares** with the list: `resolveScope` builds
  the agent and campaign maps once, `partiesOf` decides visibility on the two independent
  legs, and `visibleCall` folds "no such call", "another workspace's call" and "nonsense
  id" into one indistinguishable 404 while letting an outage through as 502.
- Recording playback: `GET .../calls/:callId/recording-token` mints an HMAC-SHA256 token
  over `{workspaceId, callId, expiry}` with a 120s TTL (`src/lib/recordingToken.ts`), and
  `GET .../calls/:callId/recording` redeems it, **re-running the full visibility check on
  every request** and re-minting the upstream presigned URL per request rather than
  persisting one. `Range` is forwarded, `Accept-Ranges` is always advertised.

So requirements "the full detail" and "recording playback with a signed short-lived token
bound to call + workspace + expiry" are **already met**. The binding is not missing and
nothing about the token scheme is extended here.

## The three real gaps

### 1. There is no per-call event source

`WebhookEvent` is a **dedupe ledger**, not an event log: `eventKey`, `event`, `receivedAt`,
and nothing else. It carries no call id, no payload and no status, so no timeline can be
assembled from it. (A comment on `CallRecord` refers to a `CallWebhookEvent.callId`; no such
model or migration exists.)

The one real local record of a call's progression is `CallAttempt`, which the dialer writes
per dial and stamps as the call moves: `startedAt`, `answeredAt`, `endedAt`, `resolvedAt`,
`chargedAt`, alongside `status`, `upstreamStatus`, `disposition` and `attemptNo`.

**Decision: build the timeline from `CallAttempt`, and say so plainly when there is none.**
No schema change, no new write path on the webhook ingest.

The cost is stated rather than hidden: `CallAttempt` exists only for **campaign** calls.
An inbound call, a hand-placed call, or a call on an agent this platform did not dial
through has no attempt row, and the response says `timeline: []` with
`timelineSource: "none"` so the dashboard can render "no timeline was recorded for this
call" instead of an empty list that reads as a rendering fault. A timeline that silently
omits events is the one outcome this surface must not produce — the same rule the list's
`truncated` flag already holds.

Events are emitted **oldest first**, each `{ kind, at, detail }`, and a stamp that is null
produces no event at all rather than an event at the epoch.

| kind | from | meaning |
|---|---|---|
| `dialed` | `startedAt` | the dial was placed |
| `answered` | `answeredAt` | the far end picked up |
| `ended` | `endedAt` | the call hung up; `detail` carries `hangupCause` when set |
| `resolved` | `resolvedAt` | the outcome was applied on our side; `detail` carries the disposition |
| `charged` | `chargedAt` | the call was metered; `detail` says `shortfall` when it was owed and not taken |

`resolvedAt` being null is meaningful and is not filled in — it is the only honest way to
tell a live dial from a settled one.

### 2. Credits are not on the detail

The prompt asks for credits in display units. Upstream's `credits_used` is deliberately
**never** emitted — it is what this platform was billed, and publishing it publishes the
margin. The customer-facing figure is `CallAttempt.costCredits`, in internal units, which
`toDisplayCredits` renders.

**Decision: emit `CallAttempt.costCredits` as `creditsCharged`, campaign calls only.**
Non-campaign calls send `creditsCharged: null`, which the dashboard states as "not charged
to this workspace" rather than as a zero — an inbound or hand-placed call on the shared
account genuinely costs the platform and not the workspace, and a `0` would assert a charge
of nothing where no charge exists.

`billedSecs` rides along on the same block. It is null on every attempt settled before pulse
billing existed, and null is **not** zero and not "the same as the duration"; readers say
the figure was not recorded.

### 3. The join, and how it is scoped

`CallAttempt.upstreamCallId` is unique and holds exactly the id this surface puts on the
wire, so one `findFirst` resolves it. It is scoped on `{ upstreamCallId, workspaceId }`
rather than on the id alone — belt to the visibility check's braces, and `workspaceId` on
`CallAttempt` is a dial-time snapshot, so it stays true after an ownership change.

The join runs **after** `visibleCall` has already granted access. It never widens what a
caller may see: an attempt that does not match adds nothing and removes nothing, and a call
already refused never reaches the query.

## Shape added to the detail response

```
billing: { creditsCharged: string | null, billedSeconds: number | null, shortfall: boolean } | null
timeline: Array<{ kind, at, detail }>          // oldest first, possibly empty
timelineSource: 'attempt' | 'none'
```

`billing: null` — not a zeroed object — when there is no attempt row, for the same reason
`creditsCharged` is null rather than 0.

## What is deliberately not here

- **No `CallWebhookEvent` table.** It would touch the webhook ingest path, which belongs to
  another in-flight branch, and the `CallAttempt` timeline answers the question for every
  call this platform actually dialed. The seam is noted for whoever adds it.
- **No transcript pagination.** Returned as-is, as specified.
- **No new rate limiter.** The detail already runs under `detailLimiter`; the join is one
  local indexed query and does not spend the shared upstream budget.
- **No change to the token scheme.** It already binds workspace, call and expiry.

## Tests

Against `TEST_DATABASE_URL` only, in the existing files' style.

1. Isolation — a call visible to workspace A is a 404 for workspace B, and the 404 is
   identical to the one a nonsense id produces.
2. Detail shape — every field present; `billing` and `timeline` populated from an attempt.
3. Timeline ordering — oldest first; null stamps produce no event; a call with no attempt
   yields `[]` and `timelineSource: 'none'`.
4. Credits — internal units render as display units; a non-campaign call sends null, never 0;
   `shortfall` is carried through.
5. Processing vs unavailable — transcript absent with `processingComplete: false` is
   distinguishable from absent with it true.
6. Token binding and expiry — a token for another call or another workspace is refused; an
   expired one is refused; an unset secret refuses everything.
