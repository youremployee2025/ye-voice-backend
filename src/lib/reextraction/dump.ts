/**
 * The one thing this run reads from the platform: a finished call's dump.
 *
 * Everything the model is shown about a call comes through here — the
 * transcript, the prompt that call actually ran with, and the moment it
 * ended. Nothing else in the run talks to the platform, so this module is
 * also the only place the debug token exists, and it never leaves it: an
 * error thrown from here names the status and the session, never the header.
 *
 * The reading is deliberately forgiving about field names and unforgiving
 * about missing ones. The dump aggregates eleven session-keyed tables whose
 * rows spell a turn's side and its words three different ways, so a turn is
 * read however it was written; but a dump with no transcript, no prompt or no
 * end time is a `ReextractionSkip`, because each of those absences would
 * otherwise produce a confident verdict about a call nobody can see.
 */
import type { DumpTranscriptTurn } from './messages.js';
import { ReextractionRefused, ReextractionSkip } from './skip.js';

export interface DumpResult {
  transcript: DumpTranscriptTurn[];
  systemPrompt: string;
  endedAt: Date;
}

export interface DumpOptions {
  /** Platform base URL, e.g. `https://api.vocobase.com`. */
  apiUrl: string;
  /** `ADMIN_DEBUG_TOKEN`; read-only and scoped to this one route. */
  token: string;
  fetchImpl?: typeof fetch;
}

/** The first of several spellings that actually carries a string. */
function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];

    if (typeof value === 'string' && value.trim() !== '') return value;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The transcript, with every turn read under whichever names its row used.
 *
 * A turn that is not an object at all is dropped rather than coerced: the
 * alternative is a `[object Object]` or a bare `null` arriving in the
 * conversation as something the lead said.
 */
function readTranscript(session: Record<string, unknown>): DumpTranscriptTurn[] {
  const raw = session.transcript;

  if (!Array.isArray(raw)) throw new ReextractionSkip('no_transcript');

  const turns: DumpTranscriptTurn[] = [];

  for (const turn of raw) {
    if (!isRecord(turn)) continue;

    const content = firstString(turn, ['content', 'text', 'message']);

    if (content === null) continue;

    turns.push({ role: firstString(turn, ['role', 'speaker', 'type']) ?? '', content });
  }

  return turns;
}

/**
 * When the call ended, which is what every relative time in the transcript is
 * resolved against.
 *
 * `startedAt` stands in for a session that never recorded an end — minutes
 * out on a months-old call, and the alternative is no anchor at all.
 */
function readEndedAt(session: Record<string, unknown>): Date {
  const stamp = firstString(session, ['endedAt', 'startedAt']);
  const at = stamp === null ? null : new Date(stamp);

  if (at === null || Number.isNaN(at.getTime())) throw new ReextractionSkip('no_ended_at');

  return at;
}

/**
 * Fetch one session's dump and read the three things the extraction needs.
 *
 * A 404 is a skip because it is a fact about that one session — the dump is
 * assembled from `SessionLog` rows, which are pruned after
 * `SESSION_LOG_RETENTION_DAYS`, so a campaign old enough to be worth
 * re-judging will have some. A 401 or 403 is a fact about the credential and is
 * a `ReextractionRefused`, which ends the run rather than the row. Every other
 * failing status is thrown as an ordinary error, recorded against the one
 * conversation it happened to.
 */
export async function fetchDump(sessionId: string, options: DumpOptions): Promise<DumpResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.apiUrl}/api/admin/sessions/${encodeURIComponent(sessionId)}/dump?format=json`;

  const res = await fetchImpl(url, { method: 'GET', headers: { 'X-Debug-Token': options.token } });

  if (res.status === 404) throw new ReextractionSkip('session_not_found', sessionId);

  /**
   * A credential is not a fact about a call.
   *
   * A wrong or expired debug token answers every session identically, so
   * recorded per row it would read as a thousand conversations that could not
   * be judged — a report an operator would believe. As a refusal it stops the
   * run on the first one, whatever the batch size, which is the only reading
   * that ends with somebody fixing the token.
   */
  if (res.status === 401 || res.status === 403) {
    throw new ReextractionRefused('dump_unauthorized', `${res.status} from the session dump`);
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);

    throw new Error(`session dump: ${res.status} for ${sessionId}: ${detail}`);
  }

  const text = await res.text();
  let body: unknown;

  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`session dump: ${res.status} for ${sessionId} was not JSON: ${text.slice(0, 200)}`);
  }

  const session = isRecord(body) ? body.session : null;

  if (!isRecord(session)) throw new Error(`session dump: ${sessionId} carried no session object`);

  const snapshot = session.promptSnapshot;
  const systemPrompt = isRecord(snapshot) ? firstString(snapshot, ['renderedPrompt', 'prompt']) : null;

  if (systemPrompt === null) throw new ReextractionSkip('no_prompt_snapshot', sessionId);

  return { transcript: readTranscript(session), systemPrompt, endedAt: readEndedAt(session) };
}
