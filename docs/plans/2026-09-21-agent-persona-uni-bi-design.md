# An agent is uni-directional or bi-directional — design

2026-09-21. Supersedes `2026-09-18-agent-direction-modes-design.md`, which
shipped (backend #89, dashboard #63/#64, backend #90) and is in production.
Spans  (enum, routes, one migration, one script) and
 (the control, the labels, the scoping).

## 1. What is wrong with three modes

The Direction control offers `Outbound`, `Inbound`, `Inbound + Outbound`.
Two of those are the same thing to the person choosing: an agent with **one**
persona. The only decision a reader actually makes is whether the agent has one
configuration or two. Asking them to also decide whether that one configuration
"is outbound" or "is inbound" is a question about the platform's plumbing (does a
face exist upstream) dressed up as a product choice, and it produced a mode —
`OUTBOUND` — whose agents silently cannot answer a call until somebody finds
the dropdown.

## 2. The model

`Agent.direction` keeps its name and becomes a two-value enum:

| Value | Label | Meaning |
| --- | --- | --- |
| `UNI` | Uni-directional | one persona; whatever the agent does — dial out or answer — it uses this configuration |
| `BI` | Bi-directional | two personas; the outbound and inbound configurations are edited separately |

The platform's inbound face is unchanged and stays the platform's fact,
mirrored into `Agent.inboundEnabled` by sync as today. What changes is who
decides when a face exists:

- **`UNI`**: the face is created **lazily, by the backend, the first time
  something routes inbound to the agent** — today that is exactly one place,
  starting an inbound campaign (`inboundStart.ts`, which currently refuses with
  `AGENT_INBOUND_NOT_ENABLED`; it now enables instead). From that moment every
  save of the one editor writes the base config **and** the face, same body,
  the mirror the previous design built for its `INBOUND` mode. An agent that is
  never used inbound never pays for a face (the platform deep-copies the
  knowledge base on enable, which is why "a face for every agent" is the wrong
  default).
- **`BI`**: the face is created when the mode is chosen, if it does not exist
  yet (a deep copy of the base, so both sides start identical), and from then
  on each side is saved independently. Nothing is mirrored.

So the mirror rule in `PATCH /agents/:id` becomes
`direction === 'UNI' && inboundEnabled` — the same predicate as before with
`INBOUND` renamed.

The "Answers inbound" badge stays and keeps its meaning: a face exists, so the
platform can route a call here. In `UNI` it appears the first time an inbound
campaign uses the agent, which is when it becomes true.

## 3. Changing mode

Two moves, down from six.

| From → To | Upstream | Confirmed |
| --- | --- | --- |
| `UNI` → `BI` | enable the face if there is none (deep copy of the base); otherwise nothing — the two sides are identical and simply stop syncing | no |
| `BI` → `UNI` | if a face exists, overwrite it with the base (`baseConfigForFace`, unchanged); otherwise nothing | **yes** — "the inbound persona will be replaced by the outbound one" |

The platform's `CONFIRM_REQUIRED` two-step no longer arises: **nothing here ever
disables a face**. Numbers stay linked, inbound campaigns keep running, and
turning an agent bi-directional and back loses nothing but the inbound edits it
warns about. The dashboard's `platformConsequence` reader and its ref-carried
second press are deleted with the move that needed them.

`PATCH /:ws/agents/:id/direction` keeps its shape — `{ direction: 'UNI' | 'BI',
confirm?: boolean }` — and its 409 `DIRECTION_CHANGED` race guard.

## 4. Migration

```sql
-- new type, three-way mapping, drop old type
OUTBOUND → UNI     (no face; one is made when an inbound campaign first needs it)
INBOUND  → UNI     (face on, mirrored — behaviour unchanged)
BOTH     → BI
```

Nothing is rewritten upstream and no platform call is made by the migration.
The one behavioural change lands on former-`OUTBOUND` agents: an inbound
campaign that used to be refused with `AGENT_INBOUND_NOT_ENABLED` now enables
the face and starts. That is the intent.

A script, `scripts/report-agent-direction.ts`, prints the per-workspace count of
`UNI`-without-face / `UNI`-with-face / `BI` after deploy, so the rollout can be
checked against the mirror (`docs/deploy.md` gets the row).

## 5. The page

```
Dhandha Support Triage  [Active]  [Answers inbound]
Anisha · en

  ┌──────────┬─────────┐            This agent is: [Bi-directional ▾]
  │ Outbound │ Inbound │
  └──────────┴─────────┘
Instructions  Settings  Test  Extraction  Tools  Knowledge base  Dictionary  Functions  Variables & actions
```

- The dropdown has two options and a one-line helper under it:
  *Uni-directional: one configuration, used whether the agent dials out or
  answers. Bi-directional: separate outbound and inbound configurations.*
- The switcher appears only in `BI`, exactly as today's `BOTH`.
- **Scoping changes for one tab.** Instructions, Settings and Extraction stay
  scoped. **Variables & actions becomes scoped too**: the platform copies
  lifecycle hooks and tool bindings into the face when it is created, so in
  `BI` the two sides genuinely have separate action lists (see
  `ye-voice-backend/docs/plans/2026-09-21-agent-actions-google-design.md`
  for how the actions editor reads and writes each side). Test, Tools,
  Knowledge base, Dictionary and Functions stay unscoped — upstream they
  attach to the agent id and cannot differ.
- `blockedReason` while a form is dirty is unchanged.
- The agents list column `Direction` reads `Uni-directional` /
  `Bi-directional`. The list helper `direction(agent)` falls back, for a
  backend that still answers the old values, by mapping
  `OUTBOUND|INBOUND → UNI`, `BOTH → BI` — the deploy-skew rule
 : the dashboard ships first and must read
  both vocabularies for one release.

## 6. `faceUnavailable` and the husk guard

Unchanged in mechanism, re-keyed: `wantsFace = direction === 'BI' &&
inbound_enabled`, `faceUnavailable = direction === 'BI' && side === 'inbound'
&& !editingFace`. The `missing` copy changes from "bounce the direction to
recreate the face" to "switch to uni-directional and back to recreate it",
which is the only move left that creates one.

## 7. Known gaps

- **`UNI` with the face on is two configs the reader never sees as two.** The
  mirror keeps them equal on every save from this dashboard; a platform-side
  edit to the face alone drifts them until the next save. This was true of
  `INBOUND` and stays a stated fact, not a fix.
- **Test still runs the base config**, in both modes. Said on the tab.
- **`agent_type` is still never written.**
