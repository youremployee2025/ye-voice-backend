# Reports menu and custom campaign export

Date: 2026-09-17. Repos: ye-voice-backend, ye-voice-dashboard.

## Problem

A campaign page shows three export buttons — Leads CSV and Call detail CSV in
the header, Export CSV on the Analytics tab — and none of them lets an operator
pick what a row carries. Transcripts, recordings, per-dial credits and session
identifiers are stored on `CallAttempt` and never reach a file.

## Decisions

1. **One `Reports` dropdown in the header** replaces the two header buttons.
   Items: Leads CSV, Call detail CSV, Custom export…. Built on the dashboard's
   own `OverflowMenu` widget (real `role="menu"`, keyboard traversal, focus
   return), not radix, so it matches the `…` menu beside it.
2. **The Analytics tab's `Export CSV` becomes `Custom export`**, which opens a
   dialog scoped to the tab's date range. The old workspace-level analytics
   export route is untouched; the campaign tab simply stops offering it, since
   every column it had is a subset of the custom export's Attempts + Credits
   groups.
3. **Row grain is one row per dial** (`CallAttempt`). Transcript, recording,
   credits and session metadata are per-call facts; a per-lead sheet already
   exists for the lead question.
4. **Field groups are checkboxes**, each mapping to a fixed column set:

   | Group | Columns |
   |---|---|
   | (always) | Lead ID, Lead Name, Phone, Attempt ID, Attempt No, Started At |
   | attempts | Status, Disposition, Reached (Yes/No), Answered At, Ended At, Duration (Seconds), Disconnected By, End Call Reason (`errorCode`) |
   | credits | Cost Credits (display units), Billed Seconds, Rate Credits/Min, Tier, Charged At |
   | variables | one column per variable name the campaign sends (same derivation as the leads sheet); value = what the dial stored, else the dialer's projection |
   | extractions | one `Extraction <key>` column per key present in the campaign's attempts, reserved keys dropped; **per-dial** value (the leads sheet's "speaks for the lead" rule does not apply here, and the dialog says so) |
   | transcript | Transcript: turns joined with `\n` as `role: content`; empty when the stored value is not an array |
   | recording | Recording: a link to the dashboard call page when `recordingAvailable` is true, else empty. The audio itself is behind a short-lived token, so a spreadsheet cannot hold a playable URL. |
   | session | Upstream Call ID, Upstream Session ID, Answered By, Hangup Cause, Hangup Source, Upstream Status, Call Kind, Error Message |

5. **Route**: `GET /:workspaceId/campaigns/:campaignId/export/custom?fields=a,b&from=&to=`.
   Member read like the other two. `fields` is a comma list of group names;
   unknown names 400, empty list 400 (a file with only identity columns is a
   mistake, not a request). `from`/`to` parse through `parseAnalyticsRange`
   and filter on `startedAt`; both optional, defaulting as that parser does.
   Streams through the existing `streamExport` helper, keyset on
   `(startedAt, id)` like the calls sheet.
6. Filename: `<campaign>_custom_<stamp>.csv`.

## Not doing

- No saved presets, no XLSX, no per-column picking below the group level.
- No changes to the two existing sheets: parity with the reference file is a
  tested contract.

## Testing

Backend: service test seeds attempts and grades each group's columns and the
range filter; route test grades 401/403/404, the 400 on bad `fields`, and the
Content-Disposition. Dashboard: menu test grades that the three items ask for
the right paths; dialog test grades the query string it builds and that a
failure is visible.
