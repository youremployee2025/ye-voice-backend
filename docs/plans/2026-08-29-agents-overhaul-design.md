# Agents Overhaul — Design

Date: 2026-08-29. Scope: a revision pass over the agent surface across `ye-voice-backend` and `ye-voice-dashboard`, driven by user feedback on the shipped editing slice.

Nothing here is a new capability the voice platform does not already have. Every field this slice adds is one the platform's `POST`/`PUT /agent` already accepts, and the two structured ones — the transfer destination catalog and the extraction config — are adopted with **the platform's own validation rules restated**, not approximated. A control for a field the API ignores reports success and changes nothing, which is worse than no control; a control that accepts a shape the API rejects is worse still, because it fails after the reader has done the work.

## What the feedback actually said

Six items, in priority order. Two are removals, three are replacements, one is a confirmation.

1. **The create modal is the wrong container.** Creating an agent is the start of writing its prompt, not a dialog to dismiss. It gets a full page, laid out like the detail view.
2. **Settings reads as a form dump.** Regroup into purposeful cards; delete rows that state facts shown elsewhere; delete the knowledge-base tuning section outright.
3. **Transfer is single-number and the platform is not.** Replace with a destination catalog, without forcing the array on someone who has one number.
4. **The voice control is a bare `<select>`.** Replace with the platform's picker pattern: cards, filtered by language.
5. **Extraction has a toggle and nothing behind it.** Give it a tab.
6. **Respond-to-silence stays.** It maps to `user_idle_enabled` and nothing else.

Explicitly out of scope: pre-call and post-call actions. That is a pending product decision, and this slice neither builds nor scaffolds it — no route, no type, no placeholder tab.

## What the platform actually accepts

Verified field by field against the platform's own request validation rather than inferred from its documentation. Three findings shape the whole slice.

**`transfer_destinations` is accepted on create and on update.** An array of `{ key, label, number, llmDescription }`. Its rules, restated:

| Rule | Value |
|---|---|
| Max entries | 20 |
| `key` | required, `^[a-z][a-z0-9_]*$`, ≤ 40 chars, unique within the array |
| `label` | required, non-blank, ≤ 100 chars |
| `llmDescription` | required, non-blank, ≤ 500 chars |
| `number` | required, non-blank, valid E.164 **or** a `{{template}}` |
| `null` | clears the catalog |
| `[]` | a real value — "catalog emptied" — and must survive as `[]` |

`llmDescription` being *required* is the load-bearing rule. With no description the model has nothing but the key to choose on, and picking the wrong branch mid-call is the failure this feature exists to prevent. The editor therefore treats a blank description as a blocking error, not a warning.

**When the catalog is non-empty it replaces `transfer_number`.** That is a runtime behaviour of the platform, not a write-time constraint: both fields persist independently, and the platform simply prefers the catalog when it has one. This is why the design below *hides* the single-number field rather than clearing it — the stored value is still meaningful the day the catalog is emptied.

**`extraction_config` is accepted on update only.** The create route destructures `extraction_enabled` but never `extraction_config`. So the Extraction tab is an edit-only surface, and the create page does not offer it. The alternative — create, then immediately PATCH — was rejected: create already carries an orphan hazard (an agent minted upstream that cannot be attached locally), and a second call that can fail independently would add a second half-configured outcome to the one path that must stay simple.

Its shape:

```
extraction_config = {
  prompt:           string, required, ≤ 50 000 chars
  keys:             [{ name, type, description?, analytics?, values? }], ≤ 50
  includeToolLogs?: boolean
  inlineEnabled?:   boolean   // defaults true; false opts out
}
```

Per key: `name` matches `^[a-zA-Z_][a-zA-Z0-9_]*$` and is unique; `type` is one of `string | number | integer | boolean | array | date | datetime`; `description` ≤ 500 chars; `analytics` marks the key as choosable as a campaign's lead bucket; `values` is the ordered list of answers the key is pinned to — ≤ 40 entries, each ≤ 100 chars, non-blank, and unique **case-insensitively**, because the readout collapses `Hot` and `hot` into one bucket and a pin must not promise a distinction that is not honoured.

`callback_at` is reserved by the platform and cannot be introduced. An agent that already stores it keeps it — the platform grandfathers names already on the row — so this surface must not reject a config it just read back. It rejects `callback_at` only when the reader is *adding* it.

Two toggles, deliberately distinct and easy to conflate:

- `extraction_enabled` — the feature is on for this agent at all.
- `extraction_config.inlineEnabled` — the extraction runs in the bot at the end of each call. Missing means on.

The UI names them "Extract details from calls" and "Run after each call" and never collapses them into one switch.

**`GET /agent/voices` carries language and tier.** Each row has `id`, `display_name`, `description`, `language`, `gender`, `tier`, plus provider fields that are none of a workspace's business. `voice_id` is that `id`. `language` is read-only on an agent and *follows the voice* — which is the fact that makes a language filter over voice cards the right control rather than two independent pickers that can disagree.

## Backend

### The two allow-lists stay honest

This service keeps two lists that must agree: `WRITABLE_AGENT_FIELDS` (what may be sent upstream) and `VISIBLE_CONFIG_KEYS` (what may be read back). A field editable but unreadable renders blank in a form and overwrites the real value the moment someone saves. A test holds them against each other; this slice does not weaken it.

**Removed from both:** `kb_threshold`, `kb_include_summaries`, `kb_result_format`. Not moved — gone. The feedback is that these are tuning knobs nobody in this product turns, and a control whose correct setting is "whatever the platform defaults to" is a control that only creates support load. After this slice the backend does not forward them, so an existing agent's stored values are left exactly as they are and simply stop being editable here.

`kb_enable_llm_processing` and `kb_llm_system_prompt` stay in the payload schema. They have no UI today and gain none here; they were not named in the feedback and removing them would be scope this slice was not given.

**Added to both:** `transfer_destinations` and `extraction_config`, with `extraction_config` restricted to the update schema for the reason above.

### Structured fields are rebuilt, never passed through

`VISIBLE_CONFIG_KEYS` is an allow-list over a cached snapshot of the *whole* upstream record. Everything on it so far has been a scalar, so "allow the key" and "allow the value" were the same act. These two are not: they are JSON columns whose contents the platform controls, and passing one through would publish whatever the platform adds to it next, to every workspace member, with no code change here and no test failing.

So both are projected to a fixed shape on the way out, the same rule the sub-resource serializers already follow:

- `serializeTransferDestinations` emits exactly `{ key, label, number, llmDescription }` per entry, dropping anything else, and returns `null` for a non-array so an absent catalog and an empty one stay distinguishable.
- `serializeExtractionConfig` emits `{ prompt, keys: [{ name, type, description, analytics, values }], includeToolLogs, inlineEnabled }` and nothing else.

Validation on the way *in* is the same restatement, in Zod, in `agentPayload.ts`. It exists so an invalid catalog fails in this process with a message naming the field and the entry index, rather than spending an upstream round trip to be told the same thing less precisely. It is not a second source of truth: where the platform's rule and this one could drift, the test names the platform's rule as the expectation.

### Numbers are canonicalized before they are stored

A literal destination number goes through this service's existing `canonicalizeE164` — the same `libphonenumber-js/max` path every other number in the system passes through — so operator-typed spacing never reaches the dial path, and `+91 98765 43210` and `+919876543210` are one number rather than two. A templated number (`{{manager_phone}}`) resolves per call against session variables and cannot be canonicalized at save time, so it passes through untouched, exactly as the platform does it.

`transfer_number` itself is canonicalized the same way, which it was not before. That is a behaviour change on an existing field and it is deliberate: the field is dialed, and storing a cosmetically-spaced number that the platform then has to parse is how one number becomes two.

### The voice projection widens by two fields

`VOICE_FIELDS` gains `tier` and `description`. Both are platform-wide catalog attributes — they name nothing about any workspace and leak nothing about who else is on the platform, which is the same reasoning that already lets the voice `id` through.

### What does not change

No schema change. `Agent.rawConfig` already stores the whole upstream record, so both structured fields are already mirrored and simply become readable. No migration, no backfill, no new table, no new route. The agent routes, the sync service and the workspace scoping are untouched.

## Dashboard

### The create page

`/agents/new`, a real route. A static segment beats the `[agentId]` dynamic one in the App Router, so no disambiguation is needed.

Its layout is deliberately the detail view's layout, because the feedback is that creating and editing should feel like one surface:

```
← Agents

New agent                                        [ Create agent ]

┌───────────────────────┐  ┌──────────────────────────────────┐
│ Name                  │  │ Instructions                     │
│ [ Reception         ] │  │                                  │
│                       │  │  How the agent handles a call.   │
│ Type                  │  │                                  │
│ ( ) Inbound           │  │  [                             ] │
│ (•) Outbound          │  │  [                             ] │
│                       │  │  [                             ] │
│ Greeting              │  │  [                             ] │
│ [                   ] │  │                                  │
│                       │  │                                  │
│ Voice                 │  │                                  │
│ ┌───────────────────┐ │  │                                  │
│ │ language filter   │ │  │                                  │
│ │ [voice cards]     │ │  │                                  │
│ └───────────────────┘ │  │                                  │
└───────────────────────┘  └──────────────────────────────────┘
```

Left rail: identity and voice. Main body: the prompt, given the room it needs. Type lives in the left rail because the API requires it and there is nowhere else honest to put it.

On success the reader lands on `/agents/:id?tab=instructions`, as the modal did. Creation still auto-assigns to the workspace — that is the backend's `assignAgent` step and it is untouched.

The unsaved-work guard covers this page. A half-written prompt is the most expensive thing on this surface to lose, and it is now a page a stray sidebar click can leave.

`new-agent-modal.tsx` is deleted, not left orphaned.

### The voice picker

One component, used by the create page and by Settings, so the two cannot drift.

A language filter over voice cards. Choosing a voice sets the language — there is no separate language control, because the platform has no separate language field to set. The read-only "Language" row disappears with the control that made it necessary.

```
Language   [ All ] [ English ] [ Hindi ] [ Marathi ] [ Tamil ]

┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ ● Aditi      │ │   Rohan      │ │   Meera      │
│ English      │ │ English      │ │ Hindi        │
│ va-1-pro     │ │ va-1-pro     │ │ va-1         │
│      selected│ │              │ │              │
└──────────────┘ └──────────────┘ └──────────────┘
```

The filter is derived from the catalogue that came back, not from a hardcoded list — the platform adds languages on its own schedule, and a hardcoded set would silently hide the new one. Tier rides along as a card badge; this product does not gate on tier, and a filter for something nobody chooses by would be noise.

The currently-selected voice is always rendered even when the language filter excludes it, and the filter opens on that voice's language. A picker that hides the current selection reads as having lost it.

An unreachable catalogue says so. An empty picker with no explanation reads as a product with no voices.

### Settings, regrouped

Four cards, down from six, with the two dead rows and one whole section gone.

| Card | Rows |
|---|---|
| **Identity** | Name, Type, Voice (the picker) |
| **Call behaviour** | Record calls, Respond to silence, Maximum call length |
| **Ending a call** | Let the agent end the call, Farewell, When to end |
| **Transfer** | Allow transfer, Number *or* destinations, Announcement, When to transfer |
| **Voicemail** | Detect voicemail, Handle screeners, Message to leave |

**Removed: "Status".** It is already the pill next to the agent's name in the header, two inches above. A field stated twice is a field that will eventually be stated two different ways.

**Removed: "Knowledge sources".** It is a count of what the Knowledge base tab lists, on a tab that cannot change it.

**Removed: the entire "Knowledge base" card.** Match strictness, include summaries, result format — gone, and no longer sent upstream.

**Kept: "Post-call extraction"** moves out of Call behaviour and onto its own tab, where it has something to configure.

**Kept: "Respond to silence"**, mapping to `user_idle_enabled`. The platform manages the timing values themselves and rejects them on write, so this surface offers the switch and nothing else. Offering a threshold control that upstream refuses would be the exact failure this design keeps naming.

### Transfer, with a catalog

The card holds the toggle, the announcement and the when-to-transfer instructions at all times. What changes is the middle.

**With no named destinations** — the common case, and the one that must not get harder:

```
[x] Allow transfer to a person
    Number            [ +91 98765 43210            ]
    Announcement      [ Putting you through now.   ]
    When to transfer  [                            ]

    Named destinations (optional)
    Add named destinations — one per branch or team — and the agent
    chooses between them mid-call.
    [ + Add destination ]
```

**With one or more**, the single-number field is hidden and the catalog is what gets sent. The stored `transfer_number` is not cleared: emptying the catalog brings it back, which is what makes this reversible.

```
[x] Allow transfer to a person
    Announcement      [ Putting you through now.   ]
    When to transfer  [                            ]

    Named destinations                                    2 of 20
    ┌─────────────────────────────────────────────── ⇅ ✕ ┐
    │ Label        [ Sales desk                        ]  │
    │ Number       [ +91 98765 43210                   ]  │
    │ When to use  [ Pricing, quotes, new business.    ]  │
    └─────────────────────────────────────────────────────┘
    ┌─────────────────────────────────────────────── ⇅ ✕ ┐
    │ Label        [ Support                           ]  │
    │ Number       [ +91 98765 43211                   ]  │
    │ When to use  [ Anything about an existing order. ]  │
    └─────────────────────────────────────────────────────┘
    [ + Add destination ]
```

**`key` is never typed.** It is derived from the label by slugification, and stops tracking the label the moment the reader edits it directly — which they can, behind a disclosure, because it is the value the model sees. A required field with a regex, sitting next to a plain-English label that could generate it, is a form asking the reader to do the computer's job.

**Order is preserved and reorderable.** The array order is the order the model is shown the branches in, so it is meaningful and the reader controls it.

**A pristine, untouched new row does not show errors.** Pressing "Add destination" and being met with three red messages for fields nobody has typed in yet is hostile. Validation lights up per field once that field has been touched, and blocks Save either way.

### The Extraction tab

A sixth tab on the agent detail, sharing the page's single dirty form and single Save — the same rule Instructions and Settings already follow, so a reader who edits two tabs saves once.

```
[x] Extract details from calls
[x] Run after each call
[ ] Include tool call logs

Analysis prompt                                     0 / 50 000
[                                                            ]
[                                                            ]

Fields to extract                                       3 of 50
┌──────────────────────────────────────────────────── ⇅ ✕ ┐
│ Name  [ intent          ]   Type [ string      ▾ ]      │
│ Description  [ What the caller was trying to do.  ]     │
│ [x] Use for lead buckets                                │
│     Answers                                     4 of 40 │
│     [ Interested        ] ✕                             │
│     [ Not interested    ] ✕                             │
│     [ Call back later   ] ✕                             │
│     [ Wrong number      ] ✕                             │
│     [ + Add answer ]                                    │
│     Leave empty to let the answers be whatever comes    │
│     back.                                               │
└──────────────────────────────────────────────────────────┘
[ + Add field ]
```

The answer list is only offered on a key marked for lead buckets, because that is the only place a pinned vocabulary is read. Leaving it empty is a real and different choice — buckets become whatever values actually came back — and the hint says so rather than leaving an empty list looking unfinished.

Every limit that can be hit is shown as a live counter, not discovered on save. The 50 000-character prompt limit is surfaced because the feedback asked for it specifically.

On an agent with extraction never configured, the tab shows the toggle off and an empty editor. Turning the toggle on does not invent a prompt.

### Types and the form

`AgentFormValues` gains `transfer_destinations: TransferDestination[]`, `extraction_enabled` (already present), and `extraction_config: ExtractionConfigValues | null`, and loses the three `kb_*` fields.

`useDirtyForm`'s `same()` compares arrays one level deep by `Object.is`, which is correct for the string arrays it was written for and **wrong for arrays of objects** — every render would report the destination list as changed. Rather than deepen a hook every other form depends on, both structured fields are held in the form as their **serialized JSON string** and parsed at the edges. The comparison stays exactly as cheap and exactly as correct, and the patch still carries only what changed.

`toUpdate` maps them out: a destination list that is empty sends `[]` (a real value meaning "catalog emptied"), never `null`, and never omission. Omitting it would make emptying the catalog silently do nothing.

## Testing

Backend, all with the platform adapter mocked — no test may make a real network call, because the partner account is production:

- every transfer-destination rule, each as its own case, including `[]` surviving as `[]` and `null` clearing;
- `key` uniqueness, and the error naming the offending index;
- a literal number canonicalized on the way in; a `{{template}}` passed through untouched;
- every extraction rule, including case-insensitive duplicate answers and the reserved `callback_at` name being rejected on add but accepted on a round-trip of a config that already holds it;
- `extraction_config` rejected by the create schema and accepted by the update schema;
- the three `kb_*` fields no longer forwarded, and no longer readable;
- the writable/visible list agreement test still passing;
- both structured fields rebuilt rather than passed through — an unexpected upstream key does not reach the response.

Dashboard:

- the create page submits exactly the platform's create fields and routes to the new agent's instructions;
- the voice picker filters by language, keeps the selected voice visible under a filter that excludes it, and reports an unreachable catalogue;
- Settings no longer renders Status, Knowledge sources, or any `kb_*` control;
- the single number shows when the catalog is empty and hides when it is not, without clearing the stored value;
- `key` derives from the label and stops tracking once edited directly;
- a pristine new destination row shows no errors; a touched empty one blocks Save;
- the extraction editor round-trips a config unchanged — the strongest guard against a form that silently drops a field it does not render.

## Manual verification

One throwaway agent, `zz-ezo-dev-scratch`, hard-deleted through the staff route afterwards. No calls endpoint is touched by this slice and none will be exercised.
