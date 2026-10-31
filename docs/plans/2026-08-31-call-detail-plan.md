# Call detail — implementation plan

Design: [`2026-08-31-call-detail-design.md`](./2026-08-31-call-detail-design.md).
TDD throughout: each step writes the failing test first.

## 1. Timeline and billing assembly — `src/lib/callTimeline.ts`

- [ ] Test: `buildTimeline` emits events oldest first from an attempt's stamps.
- [ ] Test: a null stamp emits no event (never an epoch event).
- [ ] Test: `ended` carries `hangupCause`, `resolved` carries the disposition,
      `charged` carries `shortfall`.
- [ ] Test: no attempt → `[]`.
- [ ] Implement `buildTimeline(attempt | null)` and `buildBilling(attempt | null)`,
      pure over a narrow input type so neither needs a database to test.
- [ ] `buildBilling` returns null for no attempt; renders `costCredits` through
      `toDisplayCredits`; passes `billedSecs` through as null when unrecorded.

## 2. The join — `src/services/callHistory.ts`

- [ ] Test: the attempt is looked up on `{ upstreamCallId, workspaceId }`, so an attempt
      belonging to another workspace does not attach.
- [ ] Test: a call with no attempt still serializes, with `billing: null`,
      `timeline: []`, `timelineSource: 'none'`.
- [ ] Implement: after `visibleCall`, one `findFirst`, passed into the serializer.

## 3. Serialization — `src/lib/serialize.ts`

- [ ] Test: `serializeCallDetail` carries `billing`, `timeline`, `timelineSource`
      and still emits none of the four forbidden upstream fields.
- [ ] Extend `serializeCallDetail` with an optional attempt argument. Summary is
      untouched — a listing must not pay for a per-row join.

## 4. Isolation and honesty regressions — `test/calls.test.ts`

- [ ] Test: workspace B gets an identical 404 for workspace A's call.
- [ ] Test: transcript absent + `processingComplete: false` differs from absent + true.
- [ ] Test: an upstream outage is 502, never 404.

## 5. Recording token — verification only

- [ ] Test (if not already covered in `test/recording-token.test.ts`): a token minted for
      call X is refused on call Y; one minted for workspace A is refused under workspace B;
      an expired token is refused; an unset secret refuses everything.
- [ ] No production change expected. Extend only if a binding proves absent.

## 6. Documentation

- [ ] Add the `billing` / `timeline` / `timelineSource` block and the `CallAttempt`-only
      caveat to the **Call history** section of `CLAUDE.md`, including that
      `WebhookEvent` is a dedupe ledger and cannot source a timeline.

## Verification

- [ ] `npm test` green, against `TEST_DATABASE_URL`.
- [ ] `npm run build` clean.
- [ ] Re-run any flaky failure in isolation before attributing it to this change.
