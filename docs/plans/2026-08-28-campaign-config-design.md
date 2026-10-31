# Campaign Overview: dialing window and caller number — design

Two changes to the campaign Overview tab, both from user feedback. They ship
together because they land in the same file and the same PR pair, but they are
independent: either could be reverted without the other.

1. **The dialing window is rebuilt as one coherent control.** Today it is two
   bare `<input type="time">` boxes and a timezone select whose first option is
   "Not set". It becomes a single card that reads as a sentence, with presets,
   a sensible default timezone, inline validation and a live summary.
2. **A campaign gains a caller phone number.** A workspace rents DIDs; a
   campaign must be able to say which of them it dials from. This slice is
   selection and persistence only.

## What this slice is not

**No Vocobase call, anywhere.** Not a `dids` lookup, not a number/agent map,
not a routing hint, not a validation probe. The caller number is a column, a
validated reference and a `<select>`. Nothing upstream learns it exists.

**No dialer behaviour.** Nothing reads `fromTime`/`toTime`/`timezone` to decide
when to place a call today, and nothing reads `phoneNumberId` to decide what to
dial from. Those are the dispatcher's, and the dispatcher is not written. Both
fields are configuration that the dialer slice will consume.

**No new backend rule for the dialing window.** The window's validation stays
exactly as it is: `HH:MM` shape, IANA timezone, each field independently
nullable. `from < to` and both-or-neither are enforced *in the browser only*,
as guidance on a form. This is deliberate and is argued below.

## Part 1 — the dialing window

### The problem with what is there

Three controls in two groups, none of which explain each other:

- `<input type="time">` renders differently in every browser and, on several,
  offers a seconds field the API rejects and a free-text minute the operator
  has no reason to want. A campaign is not scheduled to the minute.
- The timezone select's empty option reads **"Not set"**, which is what a
  workspace sees on first open. It is a legitimate state — no timezone means no
  window — but as a *default* it is the wrong one: nearly every workspace here
  dials India, and the operator has to know to change it.
- Nothing says what the three fields add up to. "09:00", "18:00" and
  "Asia/Kolkata" sitting in separate boxes is data, not a sentence, and the
  operator has to assemble the meaning themselves.
- Nothing catches `from = 18:00, to = 09:00`. The API accepts it, and the
  campaign is then configured to dial in a window that does not exist.

### The control

One card, laid out as a sentence:

```
Dialing window
[ Business hours 9–6 ]  [ Extended 8–9 ]  [ All day ]  [ Clear ]

Call between [ 09:00 ▾ ] and [ 18:00 ▾ ] in [ Asia/Kolkata ▾ ]

Calls go out 09:00–18:00 IST; contacts are never dialed outside this window.
```

**Times are two native `<select>`s at 30-minute steps** — 48 options, `00:00`
through `23:30`. Native rather than a hand-built listbox because the platform
gives keyboard behaviour, screen-reader announcement and the mobile wheel for
free, and this codebase has already paid the cost of building that once (the
agent picker) for a case that genuinely needed filtering. Forty-eight fixed
options do not.

The 30-minute grid is a display decision, not a contract. A campaign saved
earlier with `09:15` must not have that silently rewritten by opening the form,
so **an off-step stored value is injected as an extra option** in its sorted
position and stays selected until the operator changes it. Dropping it would
mean loading a page rewrites data, which is the one thing a read must never do.

**Presets** write both ends at once: Business hours `09:00–18:00`, Extended
`08:00–21:00`, All day `00:00–23:30`, and Clear, which empties both. They are
buttons, not a select — a preset is an action that fills fields, and rendering
it as a fourth value would imply the form remembers which one was used.

### The timezone default

The empty option stays, because "no window" stays expressible. What changes is
what a campaign with no timezone *starts on*.

The seed is **the workspace's own prior choice**: the Overview tab reads the
campaigns list it already has an endpoint for, takes the most recently updated
campaign carrying a non-null timezone, and uses that. Falling back, and on any
failure of that request, `Asia/Kolkata`.

Two things this deliberately is not:

- It is **not the browser's timezone**. `Intl.DateTimeFormat().resolvedOptions()`
  reports the operator's laptop, which is frequently not the region being
  dialed — an YE operator in Dubai configuring an India campaign would be
  handed `Asia/Dubai` and might not notice.
- It is **not a new `Workspace.timezone` column**. That is a real field with a
  real settings surface and a migration, and this slice has not established
  that anyone wants to set it independently of a campaign. The campaigns list
  already carries the answer.

The seed applies only when `campaign.timezone` is null. A saved timezone is
never overridden, and the seed is a *form default*, not a write: it is
persisted when the operator saves, like any other field they left alone.

### Validation

In the browser, on the form, before submit:

- **Both or neither.** One end without the other is not a window; it is a
  half-typed one. The field that is empty is named.
- **From before to.** Equal is refused too — a zero-length window means the
  campaign never dials, which is not what anyone typing it meant. Overnight
  windows (`21:00`–`06:00`) are *not* supported and are refused as backwards,
  because nothing downstream knows how to read one and accepting it would
  promise behaviour the dispatcher does not have.
- **A window needs a timezone.** With the seed above this is almost never
  reachable, but an operator can still select the empty option, and `09:00` in
  no particular zone is not a time.

Errors render under the card, tied to it with `aria-describedby`, and block
submit. They are not `alert()`s and not toasts: the fix is in the fields above.

**Why the backend does not gain these rules.** The backend's contract is
unchanged, and the honest reason is that no backend rule can hold this
invariant yet. The three fields are independently `PATCH`-able and independently
nullable; enforcing `from < to` server-side means enforcing it across a partial
update against stored values, which is a real cross-field rule that belongs
with the dispatcher — the component that will finally have an opinion about
what a window *means*. Adding half of it now would create a rule the API
enforces on one path and not another, which is worse than a rule the API does
not claim to have. The browser guidance costs nothing and misleads no one,
because the API's answer is still the authority.

### The summary line

One sentence, recomputed as the fields change:

> Calls go out **09:00–18:00 IST**; contacts are never dialed outside this
> window.

The zone is shown as its short name (`IST`, `GMT+4`) resolved with
`Intl.DateTimeFormat(…, { timeZoneName: 'short' })` rather than the IANA id,
because `Asia/Kolkata` is what a computer calls it. The IANA id stays visible in
the select itself, so nothing is hidden.

With no window set the sentence says so instead: *No window set — contacts may
be dialed at any time.* A blank line where a summary was would read as a
rendering fault, and "any time" is the actual consequence.

## Part 2 — the caller phone number

### Schema

```prisma
model Campaign {
  ...
  /// The DID this campaign dials from. Nullable, and null is a real state: a
  /// draft has not chosen one, and ON DELETE SET NULL returns a campaign to it.
  ///
  /// A set value does NOT prove the number is still usable. A DID is released
  /// by an UPDATE the constraint cannot see, so every read re-resolves it.
  phoneNumberId String?
  phoneNumber   PhoneNumber? @relation(fields: [phoneNumberId], references: [id], onDelete: SetNull)

  @@index([phoneNumberId])
}
```

`SET NULL`, matching `agentId` and for the same reason: a `PhoneNumber` is the
platform's record and a campaign is the customer's, and a campaign must not be
able to pin a DID row in place.

Additive only. One new nullable column, one index, one foreign key. No existing
migration is touched, reordered or re-dated. The SQL is shown before it is run.

### Usability — the rule, mirrored from the agent exactly

A DID is assignable to a campaign when **all** hold:

- `workspaceId` equals the campaign's workspace, and
- `status` is `ASSIGNED` **or** `PAST_DUE`.

`PAST_DUE` is included on purpose. The enum's own comment settles it: *"Held by
a workspace whose renewal charge was declined. The DID still belongs to them and
still rings."* It is the workspace's number; refusing to configure with it would
punish a billing state that has not yet taken the number away.

`UNASSIGNED` and `RELEASED_NONPAYMENT` are refused — both mean the number is
back in the shared pool, and a pool number belongs to nobody.

This is expressed the way `agentVisibility.ts` expresses its rule: one SQL-side
predicate and one in-memory predicate, in one file, so the assignment check and
the serializer cannot drift into disagreement. It does **not** reuse
`agentIsUsable` — the rules are the same shape and different content, and one
function that took either would be a function that could be given the wrong one.

### The API

`PATCH /api/workspaces/:workspaceId/campaigns/:campaignId` gains
`phoneNumberId: string | null` on the existing partial-update schema.

- **422 `CAMPAIGN_PHONE_NUMBER_NOT_FOUND`** — *"That phone number is not
  available in this workspace."* Emitted identically for a number that does not
  exist, one in another workspace, one in the pool and one released for
  non-payment. Byte-identical responses, and the message names no number. Four
  causes and one answer, exactly as the agent check does: distinguishing them
  would let a caller sort ids into real and unreal one request at a time, and a
  DID is a real-world phone number worth enumerating.
- **409 `CAMPAIGN_PHONE_NUMBER_LOCKED`** — *"Pause this campaign before changing
  the number it dials from."* Applies in `RUNNING` only, and only when the value
  actually changes: the dashboard sends the whole form, and a locked field must
  not make every other edit fail. Same `AGENT_MUTABLE` set, same resubmit
  tolerance.
- `null` clears the field and validates nothing — there is no reference to check.

Serialization mirrors the agent's shape:

```json
{ "phoneNumberId": "cm…", "phoneNumber": { "id": "cm…", "did": "+14155550100" } }
```

`phoneNumberId` is emitted even when `phoneNumber` is null, for the reason the
agent field records: nulling both would make *unavailable* indistinguishable
from *not set* on the wire, and leave the dashboard unable to say why.

Two fields only. Not `status`, not `monthly_price_credits`, not
`next_renewal_at` — a campaign shows a number, and a summary that grew because
the phone-numbers page needed a field would quietly widen this payload too. The
picker gets status from the phone-numbers endpoint it already calls.

### Start is not gated on it

`start` and `resume` keep `requiresAgent` and gain nothing. A campaign with no
caller number starts today.

That is a decision, not an oversight: the dialer slice decides whether a number
is required, because it is the thing that will fail without one. Gating now
would refuse to start campaigns for a reason nothing yet enforces, and would
have to be un-gated if the dispatcher turns out to fall back to a workspace
default. **The dialer slice must revisit this.**

## Part 3 — the dashboard

### Phone number section

A sibling of the agent picker on Overview, above the dialing window.

A native `<select>` over the workspace's own numbers from
`GET /api/workspaces/:id/phone-numbers` — the endpoint the settings page
already uses, filtered client-side to `ASSIGNED` and `PAST_DUE`. Each option
carries the DID and, when it is not the unremarkable case, its state:
`+14155550100 — Past due`. A `StatusPill` renders beside the closed control for
the selected number, because an `<option>` cannot hold one.

Native here and a listbox for agents is not an inconsistency to apologise for:
a workspace holds a handful of DIDs and there is nothing to filter, while an
agent list runs to thirty and needed search. The control follows the data.

States the field must render, none of them blank:

- **Numbers available** — the select, with `Not set` first.
- **None rented** — no select. A sentence, and a link to
  `/settings/phone-numbers`: *"This workspace has no phone numbers yet."*
  An empty dropdown is a dead end; the next step is a different page.
- **Load failed** — the message and a Retry, inside the field and nowhere else.
  A campaign's retry settings must not become uneditable because one request
  failed. Same rule the agent picker already follows.
- **Unavailable** — `phoneNumberId` is set and `phoneNumber` is null: the number
  was released or moved. Shown in the danger colour with the raw id, like the
  agent's equivalent, and never collapsed into `Not set`.

### List and header

`components/campaigns/phone-cell.tsx`, mirroring `agent-cell.tsx` including its
four-state `unknown` case — an API that predates the field omits `phoneNumber`
entirely, and reading that as "unavailable" would paint every campaign in the
product red during a staggered deploy. Used in the campaigns table (a new
**Number** column) and in the detail header's meta line.

## Testing

Backend, `test/campaign-phone-number.test.ts`, against `TEST_DATABASE_URL` with
the Neon guard untouched:

- assigns a number the workspace holds; assigns a `PAST_DUE` one
- 422s a foreign number, a pool number, a `RELEASED_NONPAYMENT` one and a
  nonexistent id **byte-identically**, and stores nothing
- never names the foreign number's DID in the refusal
- clears on `null`
- 409s a change while `RUNNING`; accepts the same value resubmitted while
  `RUNNING`; accepts a change while `PAUSED`
- serializes `{ id, did }` and nothing else; emits `phoneNumberId` with a null
  `phoneNumber` when the number has gone
- `start` succeeds with no number set

Dashboard, `test/dialing-window.test.tsx` and `test/campaign-phone-picker.test.tsx`:

- presets write both ends; Clear empties both
- an off-step stored value survives a render and stays selected
- both-or-neither, from < to, and window-without-timezone each block submit
  with a named field
- the summary line for a set window, and for none
- the timezone seed: prior campaign wins, `Asia/Kolkata` when there is none,
  and a stored timezone is never overridden
- the picker's four states, and that `PAST_DUE` is offered while pool and
  released numbers are not
