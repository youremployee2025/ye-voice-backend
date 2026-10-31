import { classifyOutcome } from './callOutcome.js';
import { normaliseEndCallReason } from './endCallReason.js';
import { RESERVED_EXTRACTION_KEYS } from './extractionConfig.js';

/**
 * Deciding which extraction keys become columns on the leads export, and under
 * which of its two headings.
 *
 * The export this replaces splits a campaign's extracted answers into
 * `Lead Metric <Key>` — each with a `<Key> Reason` beside it — and
 * `Lead Entity <Key>`, which has none. Nothing in this service's data records
 * that distinction, and nothing upstream reports it either, so it has to be
 * derived. The rule below is not an approximation of that file's split; it
 * reproduces it exactly:
 *
 * > A key with a sibling `<key>_reason` is a **Metric**. A key without one is
 * > an **Entity**.
 *
 * Checked against the reference export: all ten of its Metrics carry a Reason
 * and none of its five Entities does. The rule is also the one the call-note
 * contract already follows — `call_outcome_vocobaseplatform` is paired with
 * `call_outcome_reason_vocobaseplatform` — so it is the convention this
 * platform's own keys are written in rather than a convention invented here.
 */

/** The suffix that makes one key the justification for another. */
const REASON_SUFFIX = '_reason';

export interface ExportMetric {
  /** The key whose answer becomes the `Lead Metric <key>` column. */
  key: string;
  /** The sibling holding its justification, for `Lead Metric <key> Reason`. */
  reasonKey: string;
}

export interface ExtractionColumns {
  metrics: ExportMetric[];
  entities: string[];
}

/**
 * The two column groups, from the key names a campaign's calls actually
 * carried.
 *
 * **Reserved keys are dropped**, not filed under either heading.
 * `RESERVED_EXTRACTION_KEYS` is this platform's own machinery — the call-note
 * contract and the two callback keys — and every one of them already reaches
 * the row as a first-class column: the outcome as `goal_achieved`, the note as
 * `last_call_note`, the callback keys as the callback counters and `arm_kind`.
 * Emitted here as well they would put two versions of one fact side by side in
 * the same row, one of them phrased for a language model. Reusing that set
 * rather than listing the names again is what keeps this filter correct when
 * the contract next gains a key.
 *
 * Both groups are sorted, because a header that follows the order Postgres
 * happened to return `jsonb_object_keys` in is a header that can differ
 * between two exports of one campaign.
 */
export function splitExtractionKeys(keys: readonly string[]): ExtractionColumns {
  // Deduplicated first: the caller reads these out of many rows' JSONB, and a
  // key present on two attempts must not become two columns.
  const present = new Set(keys.filter((key) => !RESERVED_EXTRACTION_KEYS.has(key)));

  const metrics: ExportMetric[] = [];
  const entities: string[] = [];

  for (const key of present) {
    // A reason is carried by its parent and is never a column of its own. It
    // is skipped whether or not that parent survived the reserved filter: a
    // reserved key's reason is reserved by the same argument, and emitting it
    // alone would surface half of a pair whose other half was withheld.
    if (key.endsWith(REASON_SUFFIX) && present.has(key.slice(0, -REASON_SUFFIX.length))) continue;
    if (key.endsWith(REASON_SUFFIX) && RESERVED_EXTRACTION_KEYS.has(key.slice(0, -REASON_SUFFIX.length))) continue;

    const reasonKey = `${key}${REASON_SUFFIX}`;

    if (present.has(reasonKey)) metrics.push({ key, reasonKey });
    else entities.push(key);
  }

  metrics.sort((a, b) => a.key.localeCompare(b.key));
  entities.sort((a, b) => a.localeCompare(b));

  return { metrics, entities };
}

/**
 * The two disconnect columns, in the vocabulary of the export this replaces.
 *
 * Cross-tabulating the reference file's 5,328 rows leaves `Disconnect Reason
 * Key` and `Call Disconnected By` a pure function of each other, with exactly
 * four combinations occurring — so this is a translation of a mapping that was
 * measured, not a scheme invented to fill two columns.
 *
 * **`Telephony Disposition` is deliberately absent.** In that same file the
 * one `user` key splits across two of its values (1,250 "User connection lost"
 * against 28 "User disconnected"), which makes it a function of the hangup
 * CAUSE as well as the source. No cause distribution has been verified against
 * production yet, and a guessed value in a column an operator reconciles
 * against the carrier is worse than a blank one. The export emits it empty
 * until the mapping is measured the way this one was.
 */
export interface DisconnectSource {
  /** The platform's `end_call_reason` — the bot's own account of the ending,
   *  set on every answered call. Read before the inferred per-leg source. */
  endCallReason?: string | null;
  /** Upstream's `hangup_source`, verbatim. */
  hangupSource: string | null | undefined;
  /** The carrier's disposition, used only when there is no source to read. */
  disposition: string | null | undefined;
  /** Set when the dial never left this service, so nothing ever disconnected. */
  launchError?: string | null;
}

export interface DisconnectColumns {
  reasonKey: string;
  disconnectedBy: string;
}

/**
 * Who hung up, in the platform's own vocabulary, mapped to the two columns.
 *
 * **Taken from `backend/docs/partner-hangup-source.md`, not inferred**, and
 * the difference is not academic: read as outbound SIP, `caller` looks like our
 * own bot and `system` like neither party. Both readings are wrong, and on
 * `voicelink` — which emits only those two, 49%/51% — being wrong about them is
 * being wrong about every connected call in the export.
 *
 *   caller   the person on the other end hung up
 *   system   the agent ended the call
 *   callee   the dialled leg released it — the person, where a carrier
 *            distinguishes the two legs at the switch
 *   carrier  the network tore the call down
 *   api      a programmatic hangup, neither party
 *
 * `carrier` and `api` are neither party, which is what this file's `System`
 * bucket means; the reference export uses it for exactly that.
 *
 * An **allow-list**, and the platform asks for one: "New values may be added to
 * this enum over time. Treat an unrecognised string as unattributed rather than
 * failing the payload." `error` and `unknown` are named there as meaning the
 * teardown failed or the carrier said something unrecognised — "treat as
 * unattributed, same as null" — so they are deliberately absent below and fall
 * through with everything else.
 */
const HANGUP_SOURCES: Readonly<Record<string, DisconnectColumns>> = {
  caller: { reasonKey: 'user', disconnectedBy: 'Customer' },
  callee: { reasonKey: 'user', disconnectedBy: 'Customer' },
  system: { reasonKey: 'voicebot_hangup', disconnectedBy: 'AI Assistant' },
  carrier: { reasonKey: '', disconnectedBy: 'System' },
  api: { reasonKey: '', disconnectedBy: 'System' },
};

/**
 * The platform's `end_call_reason`, mapped onto the SAME four combinations —
 * nothing is emitted here that the reference export did not already contain.
 *
 * This is the bot's own account of the ending, so it is read before
 * `hangup_source`: the bot witnessed which side ended the call, where the
 * source was inferred from the legs after the fact. `COMPLETED` means the bot
 * ended the call — its pipeline finished — and NOT that the call succeeded;
 * a bot that hung up mid-refusal reports it just the same. `TRANSFERRED` is
 * the bot handing the line to a person, which is the bot ending its own leg.
 *
 * `BUSY` / `NO_ANSWER` is a line nobody was ever on — the "not a party" bucket
 * the reference file calls `System`, the same one the unsourced `no_answer` /
 * `busy` disposition rule below already credits.
 *
 * Everything else — `VOICEMAIL`, `SCREENER`, the failure values, `UNKNOWN`,
 * and anything the platform adds later — is deliberately absent, and an
 * absent reason FALLS THROUGH to the source and the disposition rule rather
 * than stopping here. Two reasons. `VOICEMAIL` / `SCREENER`: the reference
 * file never attributes a voicemail, and the disposition rule below holds
 * that; a table entry would flip thousands of historical rows from blank to
 * `System` the day the backfill fills them. The failures and `UNKNOWN`: the
 * platform derives the reason from the Q.850 cause but the disposition
 * WITHOUT it, so `INVALID_NUMBER` arrives beside `no_answer`, which the
 * reference file files under `System`; stopping here would export the same
 * carrier outcome as `System` before 2026-09-15 and blank after. And `UNKNOWN`
 * is what the listing derives for every connected call before the platform
 * stored the bot's report (2026-09-14), which the backfill would otherwise
 * write over the ~5,500 rows the hangup-source backfill already attributed.
 * A reason that says nothing about who hung up leaves the question to the
 * evidence that does.
 */
const END_REASONS: Readonly<Record<string, DisconnectColumns>> = {
  CUSTOMER_HUNG_UP: { reasonKey: 'user', disconnectedBy: 'Customer' },
  COMPLETED: { reasonKey: 'voicebot_hangup', disconnectedBy: 'AI Assistant' },
  TRANSFERRED: { reasonKey: 'voicebot_hangup', disconnectedBy: 'AI Assistant' },
  BUSY: { reasonKey: '', disconnectedBy: 'System' },
  NO_ANSWER: { reasonKey: '', disconnectedBy: 'System' },
};

/** Neither column has anything to report. */
const UNATTRIBUTED: DisconnectColumns = { reasonKey: '', disconnectedBy: '' };

export function disconnectColumns(source: DisconnectSource): DisconnectColumns {
  // A dial that never left this service disconnected nothing. Read before the
  // source, because a refused launch can still carry whatever the platform
  // last said about the attempt.
  if (source.launchError) return UNATTRIBUTED;

  // The bot's account first, where it says who hung up. A reason that says
  // nothing about that (see the table's comment) leaves the question to the
  // source and the disposition, exactly as no reason at all does.
  const reason = normaliseEndCallReason(source.endCallReason);
  const fromReason = reason === null ? undefined : END_REASONS[reason];

  if (fromReason) return fromReason;

  const named = source.hangupSource?.trim().toLowerCase();

  if (named) return HANGUP_SOURCES[named] ?? UNATTRIBUTED;

  /**
   * No attributing reason and no source: the path for rows settled BEFORE
   * `end_call_reason` existed (2026-09-15), which on this platform's traffic
   * was **every** call until then, not the rare fallback this was written as
   * — and, since then, for every reason the table above leaves out.
   *
   * `hangup_source` is a **provider** difference rather than a regression:
   * measured on 2026-09-08, `vobiz` carried one on 283 of 284 sampled calls
   * and `voicelink` on 0 of 516, with both providers present on 2026-08-20.
   * This service dials `voicelink` exclusively, and the detail endpoint does
   * not carry it either, so every YE call settled before the reason shipped
   * lands here and nothing recovers it.
   *
   * That is what makes over-claiming expensive. The reference file attributes
   * an unsourced row exactly two ways — `no_answer` to the system, `failed`
   * to nobody — and contains no unsourced *completed* call at all. Reading
   * "somebody answered and we were not told who hung up" as "the system hung
   * up" extrapolates past that onto thousands of rows: a conversation ends
   * because one of the two parties ended it, and which one is precisely what
   * we no longer know.
   *
   * So the system is credited only where **nobody was ever on the line** —
   * the call rang out or the line was busy, and there was no one to hang up.
   * Everything else unsourced is unattributed, the same answer this module
   * gives `Telephony Disposition` and for the same reason: a blank is
   * recoverable and a wrong attribution in a spreadsheet is not.
   *
   * `classifyOutcome` rather than literal comparisons: it is the one place
   * this service decides what a carrier's free text means, and a second copy
   * would eventually disagree with the outcome column printed beside these
   * two in the same row.
   */
  const outcome = classifyOutcome(source.disposition, null);

  return outcome === 'no_answer' || outcome === 'busy'
    ? { reasonKey: '', disconnectedBy: 'System' }
    : UNATTRIBUTED;
}
