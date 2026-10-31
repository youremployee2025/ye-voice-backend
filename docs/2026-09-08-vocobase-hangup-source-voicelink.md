# `hangup_source` is never populated on `voicelink` calls

**To:** Vocobase platform team
**From:** YE (partner integration)
**Date:** 2026-09-08
**Asking for:** confirmation of the behaviour, and whether it is expected

---

## Summary

Every call we place returns `hangup_source: null`, on both `GET /calls` and
`GET /calls/{id}`. `hangup_cause` is returned normally on the same calls.

Sampling the partner account's own listing suggests this tracks the
**provider** rather than a date or an account setting: `vobiz` calls carry a
source almost always, `voicelink` calls never do. We dial `voicelink`
exclusively, so we have never seen the field populated.

We would like to know whether that is expected for `voicelink` — and if so,
whether "who ended the call" is available from some other field we should be
reading instead.

## What we measured

Sampled `GET /calls?limit=100&offset=…` against the production partner account
on 2026-09-08 (`total` was 31,303 at the time), counting rows where
`hangup_source` is neither null nor absent, grouped by the row's own `provider`:

| offset | `started_at` | `vobiz` | `voicelink` |
|--------|--------------|---------|-------------|
| 30,500 | 2026-08-16   | 99/100  | —           |
| 29,500 | 2026-08-18   | 100/100 | —           |
| 29,000 | 2026-08-20   | **84/84** | **0/16**  |
| 26,000 | 2026-08-25   | —       | 0/100       |
| 20,000 | 2026-08-29   | —       | 0/100       |
| 12,000 | 2026-09-05   | —       | 0/100       |
|  6,000 | 2026-09-06   | —       | 0/100       |
|      0 | 2026-09-07   | —       | 0/100       |

Totals across the sample: **`vobiz` 283/284**, **`voicelink` 0/516**.

The offset-29,000 page is the informative one: both providers appear on the
same day, and they differ completely. That is what points at the provider
rather than at a change in behaviour around 20 August, which is what we first
assumed.

Values observed on `vobiz` rows, for reference: `carrier`, `caller`, `callee`,
`api`.

## Three of our own calls, if you would like to look them up

All `provider: voicelink`, all settled, all with a cause and no source. The
detail endpoint agrees with the listing on each.

| `call_id` | `started_at` | `disposition` | `hangup_cause` | `hangup_source` |
|---|---|---|---|---|
| `230ccb6b-4da2-4002-8525-5a39000351a8` | 2026-09-06T10:41:50.940Z | `completed` | `"16"` | `null` |
| `9742fe60-1bb6-45cd-b7a0-9c3216ea3d45` | 2026-09-06T10:41:40.620Z | `no_answer` | `"16 - Normal Clearing"` | `null` |
| `be7a5297-a912-4743-8374-2b300fd7cec5` | 2026-09-06T10:41:30.730Z | `completed` | `"16"` | `null` |

## Why it matters to us

We are building a per-call export for our customers that reports **who ended
the call** — the customer, the assistant, or the platform. `hangup_cause` tells
us how a call ended but not by whom: a customer hanging up and the assistant
hanging up can both end a call with cause 16.

Without the source we leave that column blank rather than infer it, since
guessing would put a wrong attribution in a customer's spreadsheet. We have the
storage and both capture paths in place already, so if the field starts arriving
on `voicelink` we will pick it up with no further change on our side.

## What we checked before asking

We looked for the answer elsewhere in the payload first. None of it attributes
the hangup:

| Field | What it tells us | Why it does not answer this |
|---|---|---|
| `hangup_cause` | Q.850 cause | `16` is "normal clearing" — that the call ended cleanly, not by whom. It is the same value whether the assistant or the customer ended the call. |
| `answered_by` | `human` / `machine` / `null` | Who **answered**, not who ended it. |
| `disposition` | `no_answer`, `completed`, `voicemail` | Only those three values appear across 2,000 of our calls. |
| transcript tail | which side spoke last | Not a proxy. Cause `16` occurs with a final `bot` turn and with a final `user` turn alike — the assistant says goodbye and the customer hangs up, which looks identical to the assistant hanging up. |

Two things stood out while checking, and both may be more informative to you
than to us:

- **`user_hangup_no_speech` never appears.** It is in the documented
  disposition set and would attribute a hangup to the customer, but we see it
  zero times in 2,000 calls — only `no_answer`, `completed` and `voicemail`.
  If it is only emitted on some providers, that would be consistent with what
  we see for `hangup_source`.
- **`hangup_cause` arrives in two formats that correlate with connectedness.**
  Bare numerics (`"16"`, `"32"`) appear on answered calls; the suffixed form
  (`"16 - Normal Clearing"`, `"19 - User alerting, no answer"`) appears on
  unanswered ones. That reads like two different layers populating the same
  field, which may be where the source is being lost.

We have not been able to check the platform's own **tool/integration call
logs**. Our assistants end calls with an `end_call` tool, so a
bot-initiated hangup should be visible there — if that is where the
distinction lives, telling us so would be enough.

## What would help

1. **Is `hangup_source` expected to be null on `voicelink`?** If it is a
   provider limitation rather than something in our integration, knowing that
   lets us stop looking.
2. **If it is available another way** — a different field, a webhook property
   we are not reading, or something on the session — we would rather read that
   than leave the column empty.
3. **If it could be populated for `voicelink`**, we would use it immediately.

## Two smaller observations from the same sample

Not blocking anything, and possibly already known — mentioning them only
because we noticed them while measuring the above.

1. **`hangup_cause` formatting is inconsistent** between rows: we see both
   `"16"` and `"16 - Normal Clearing"` on the same provider, same day. We parse
   the leading number, so this does not break us, but a consumer matching on
   the whole string would see them as different causes.

2. **Cause 16 sometimes arrives with `disposition: no_answer`** — see
   `9742fe60…` above, which reports normal clearing on a call classified as
   unanswered. We had been told to expect this and we handle it (we treat
   `answered_by: human` as evidence of a connection regardless of the
   disposition label), so this is a confirmation rather than a request.

---

*Measured with read-only `GET /calls` and `GET /calls/{id}` requests against
the partner account. Happy to share the sampling script or re-run it at
whatever offsets are useful.*
