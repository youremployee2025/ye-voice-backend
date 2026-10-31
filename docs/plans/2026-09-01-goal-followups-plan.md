# Goal-driven follow-ups — task plan

Design: [`2026-09-01-goal-followups-design.md`](2026-09-01-goal-followups-design.md)

Worktrees: `.worktrees/goal-followups/{ye-voice-backend,ye-voice-dashboard}`
(backend off `main` @ 40e2dd2 — queue-workers landed via PR #20 — dashboard
off `main` @ 5d416b1, branch `feat/goal-followups`, own installs, own dev+test
Postgres, redis test index 9). TDD, small imperative commits, never push.
Suite is flaky (~10% cross-file bleed): re-run failures in isolation before
concluding anything.

Baseline first: run `npm run conformance` on the untouched worktree and keep
the report — the "before" half of the zero-verdict-changes gate (the matrix
is 46 rows since the D5 reconciliation; `scripts/conformance-results/
baseline-before-queues.md` is the older committed reference).

## Phase 0 — schema and config

- [x] `feat: goal columns, the context record, and the do-not-call list` —
      `prisma/schema.prisma`: `Campaign.goalKeys/maxTotalDials/maxGoalFollowUps/
      followUpDelayHours`, `CampaignContact.followUpCount/goalAchieved`, new
      `CampaignContactGoal` (unique FK, `@@index([campaignContactId])` via the
      unique), new `DoNotCall` (`@@unique([workspaceId, phone])`).
      `npx prisma migrate dev --name goal_followups`.
- [x] `feat: validate the goal policy, reject-don't-clamp` —
      `src/lib/campaignConfig.ts`: ranges 1..15 / 0..5 / 1..168; `goalKeys`
      must be agent-declared and non-reserved (the `leadBucketKey` check);
      tests first in `test/campaign-config.test.ts` (or the file that owns
      config validation today).
- [x] `feat: gate goal edits by campaign status` — extend the PATCH
      change-list: DRAFT everything, PAUSED/CREDIT_EXHAUSTED the three knobs
      only, never `goalKeys`. Test each transition.
- [x] `feat: reserve do_not_call and call_summary extraction keys` —
      `src/lib/extractionConfig.ts` beside `CALLBACK_AT_KEY`; rejected as
      goalKeys and leadBucketKey; attached at campaign start the way
      `callback_requested_at` is (`call_summary` only when
      `GOAL_SUMMARY_LLM=on`; attach failure logged + notified, never blocking).

## Phase 1 — the context record

- [x] `feat: merge an attempt into the goal context record` — new
      `src/services/goalContext.ts`: `recordAttempt({campaignContactId,
      attemptNo, kind, disposition, answeredBy, extraction, callbackNote?,
      durationSecs?})` upserts `CampaignContactGoal`; attemptLog keyed by
      attemptNo (replace own entry), mergedExtraction later-non-empty-wins /
      empty-never-erases; `summaryNote` from a `call_summary` value when
      present. Unit tests: merge rules, replay is a byte-identical no-op,
      collectedKeys derived correctly.
- [x] `feat: update the context record from the webhook worker` — in
      `src/services/webhookOutcome.ts` beside `applyTerminalOutcome`; only for
      campaigns with goalKeys; exactly-once rides the existing `WebhookEvent`
      key, and merge idempotency covers redelivery before the marker commits.
      Integration test in `test/webhook-queue.test.ts` style: replay the same
      session.completed, context record unchanged.

## Phase 2 — resolution (the heart)

- [x] `test: the goal decision table` — extend `test/dialer-outcome.test.ts`:
      connected+all-collected → COMPLETED/goalAchieved=true;
      connected+partial+budget → PENDING, nextEligibleAt = now+delay rolled
      into the window, followUpCount+1, callbackAt untouched;
      connected+partial+exhausted (either budget) → COMPLETED/false;
      do_not_call truthy → COMPLETED + DNC row; goalKeys=[] → today's
      behavior byte-for-byte. *(landed as its own `test/goal-resolution.test.ts`
      — the existing file's fixtures carry no goal fields; adds the window
      roll, opt-out from every outcome class, and the lost race. The cap and
      DNC claim doors: `test/goal-claim.test.ts`; the webhook-side recording,
      dial-budget refusal and promise-over-re-arm booking:
      `test/goal-webhook.test.ts`; the record's merge rules:
      `test/goal-record.test.ts`)*
- [x] `feat: goal-aware settle in resolveContact` —
      `src/services/dialerOutcome.ts`: re-read goal fields live inside the
      transaction (like retryCount); only the settle-as-COMPLETED branch
      changes; re-arm guarded by the existing `claimed` predicate
      (`race_lost` drops the write). Use `rollIntoDialWindow` from
      `src/lib/callbackTime.ts`.
- [x] `feat: maxTotalDials is absolute` — the retry re-arm in
      `resolveContact`, `scheduleCampaignCallback`
      (`src/services/campaignCallback.ts`), and the claim CTE
      (`src/services/dialerClaim.ts`) all refuse past `MAX(attemptNo) >=
      maxTotalDials` for goal campaigns. One test per door.
- [x] `feat: skip do-not-call contacts at claim time` — claim CTE joins
      `DoNotCall` on workspace+phone; a listed contact settles `EXCLUDED`
      with a journey-visible reason. Test: DNC row written by campaign A
      blocks the same phone in campaign B.

## Phase 3 — the variable contract

- [x] `test: deterministic renders of the context record` — new
      `src/lib/goalVariables.ts` + `test/goal-variables.test.ts`:
      `previous_attempts`, `last_call_note` (first call / callback-note /
      drop line; `summaryNote` wins when present), `collected_summary`,
      `missing_fields` ("8 of 10 remaining: …"), `goal_state`.
- [x] `feat: overlay the reserved block on every goal-campaign dial` —
      `variablesFor` path in `src/services/dialer.ts` / `dialerPlacement.ts`:
      one indexed read of the context record at placement time; reserved
      names win over `variableMap` collisions; non-goal campaigns untouched
      (assert the overlay is absent).
- [x] `feat: the GOAL_SUMMARY_LLM flag` — env plumbing (`off` default), the
      `call_summary` attach at start, `summaryNote` preference in
      `last_call_note`. Missing/failed summary falls back silently — test
      both states of the flag. *(feature complete; the render half — the
      `summaryNote` preference, its staleness guard and the silent fallback —
      is covered by `test/goal-variables.test.ts` and the summary caching by
      `test/goal-record.test.ts`; the attach-at-start plumbing remains covered
      by the Phase 0 reserved-key work)*

## Phase 4 — API surface + agent guide

- [x] `feat: expose goal fields end to end` — campaign create/PATCH/read
      routes accept + return the four fields; journey response carries
      per-attempt context entries, `goalAchieved`, opt-out state, goal
      progress (collected vs missing); stats/overview response gains
      goal-achieved counts and the collected-fields distribution (one
      groupBy over context records). Route tests per surface.
- [x] `docs: the goal-campaigns agent guide` —
      `docs/goal-campaigns-agent-guide.md`, customer-facing clean-room tone
      ("the voice platform"): the five variables, a worked prompt block
      ("You have already spoken to {{previous_attempts}} times. Last time:
      {{last_call_note}}. Already collected: {{collected_summary}}. Still to
      ask for: {{missing_fields}}. If they ask not to be called again,
      acknowledge and note it."), and the never-re-ask rule.

## Phase 5 — conformance + battle

- [x] `test: goal rows in the conformance matrix` — new scenario(s) under
      `scripts/conformance/scenarios/` + rows in `report.ts` (G1..Gn):
      convergence, budget exhaustion, opt-out, delay spacing,
      callback-beats-delay, replay. Virtual clock; mock `/_sim/script`
      scripts per-dial extraction values (extend the mock in the sibling
      vocobase-mock repo if the script surface lacks extraction control).
      *(rows G1..G6 across `14-goal-followups` / `15-goal-timing` /
      `16-goal-optout-replay`; the mock already scripted per-dial extraction —
      it gained only a `variables` capture on the dial log, so scenarios can
      assert the overlay each dial actually carried. Two engine bugs found
      and fixed: a callback promised in a partial conversation was dropped by
      the follow-up re-arm, and the context record was lost when a webhook
      job died after its outcome committed — both `fix:` commits)*
- [x] **Gate:** `npm run conformance` — existing 46 rows show **zero verdict
      changes** against the baseline report captured before Phase 0.
      *(full 16-scenario run, 0 failed runs; 46 old verdicts byte-identical,
      G1..G6 all MATCHES)*
- [x] `test: goal scenarios in the battle driver` — `scripts/battle-test.ts`
      scenarios 4..8: 3-attempt convergence to achieved, budget exhaustion,
      mid-journey opt-out, callback↔follow-up interleaving, replay
      idempotency; 3 runs each; report appended to `scripts/battle-report.md`.
      *(hours are hours: each re-arm is asserted as state on the real clock —
      PENDING, `nextEligibleAt ≈ now+1h`, counters moved, `callbackAt`
      untouched — then `nextEligibleAt` is moved to now, the row an hour
      later; the callback promise stays a real 75s wait. The full multi-hop
      delay behavior is graded on the virtual clock in G1/G5.)*

## Phase 6 — dashboard (worktree: ye-voice-dashboard)

- [x] `feat: goal types and payload` — `lib/types.ts`, `lib/campaigns/payload.ts`:
      the four fields on create/patch, journey + stats shapes. *(new
      `lib/campaigns/goal.ts` carries the pure rules, `retry-policy.ts` style;
      contact-row progress lands as `goal.collectedCount` per the rename)*
- [x] `feat: the goal editor` — `components/campaigns/goal-editor.tsx` used by
      `app/(dash)/campaigns/[id]/settings-tab.tsx` (DRAFT form) and
      `app/(dash)/campaigns/new/page.tsx`: key picker from the agent's
      declared extraction keys, three policy fields with reject-range hints,
      cost sentence in the `retryCostSentence` style ("A contact may be
      called up to N times in total…"). Mid-campaign form: knobs only.
      *(dedicated `test/campaign-goal-editor.test.tsx` rides the deferred test
      pass; the existing settings-tab/create-page/payload suites were updated
      for the widened shapes and pass)*
- [x] `feat: goal progress on contact rows` — contacts-tab: "4 of 10
      collected", follow-up pips distinct in `AttemptPips`/`attemptTally`,
      opt-out badge prominent. *(rows carry no opt-out field, so the opt-out
      banner lives in the journey; the row shows the settle verdict instead)*
- [x] `feat: follow-ups and context notes in the journey` —
      `components/campaigns/contact-journey.tsx`: follow-up rows distinct
      from retries and callbacks; per-attempt context notes; opt-out reason.
- [x] `feat: goal tiles on the overview` — goal-achieved % (achieved /
      settled with a goal) + collected-fields distribution; nothing under
      `components/analytics/` touched.
- [x] Screenshots: the goal editor, and a journey showing a follow-up chain.
      `docs/screenshots/2026-09-01-goal-{editor,journey}.png`, captured from
      live dev servers against seeded data.

## Final report

Schema, the resolution decision table, the variable contract, guardrail test
inventory, conformance + battle results, screenshots.
