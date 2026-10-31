import { env } from '../lib/env.js';
import { ApiError, type ErrorCode } from '../lib/errors.js';

/**
 * Client for Vocobase's V2 partner API.
 *
 * The partner key authenticates the whole platform, so it lives here and
 * nowhere else — no route, service, or response may pass it outward. Upstream
 * failures all surface as 502 UPSTREAM_ERROR with a generic message: the
 * caller needs to know Vocobase is unreachable, not what it said.
 *
 * Two registers on purpose. Comments and internal docs say Vocobase, matching
 * the file names, env vars and schema. The message strings below reach a
 * customer's screen and say "the voice platform" instead — which supplier is
 * under the product is not theirs to learn from an error.
 */

const TIMEOUT_MS = 15_000;

/** Longer than a normal call: this one carries a file, not a JSON document. */
const UPLOAD_TIMEOUT_MS = 60_000;

/** Upstream mixes snake_case and camelCase and omits fields freely, so every
 *  field is optional and unrecognised keys are preserved rather than dropped. */
export type UpstreamRecord = Record<string, unknown>;

export interface ListAgentsQuery {
  limit: number;
  offset: number;
}

export interface ListAgentsResponse {
  agents?: UpstreamRecord[];
  total?: number;
  limit?: number;
  offset?: number;
}

export interface AgentDocumentsResponse {
  documents?: UpstreamRecord[];
  total?: number;
}

export interface AgentFunctionsResponse {
  functions?: UpstreamRecord[];
}

export interface AgentToolsResponse {
  tools?: UpstreamRecord[];
}

export interface VoicesResponse {
  voices?: UpstreamRecord[];
}

export interface VoiceTiersResponse {
  tiers?: UpstreamRecord[];
}

export interface ConnectionsResponse {
  connections?: UpstreamRecord[];
}

export interface LifecycleHooksResponse {
  hooks?: UpstreamRecord[];
}

export interface SetAgentToolBody {
  enabled: boolean;
  connection_id?: string;
}

export interface DocumentUploadTicket {
  document_id?: string;
  upload_url?: string;
  expires_in?: number;
}

export interface DocumentSyncStatusResponse {
  summary?: UpstreamRecord;
  documents?: UpstreamRecord[];
}

export interface DictionariesResponse {
  dictionaries?: UpstreamRecord[];
}

export interface LinkDocumentsResponse {
  linked?: UpstreamRecord[];
  skipped?: string[];
}

export interface PurchasedDidsQuery {
  page: number;
  perPage: number;
}

export interface PurchasedDidsPage {
  rows: UpstreamRecord[];
  /** Null when the payload did not say; the caller then walks until a short page. */
  lastPage: number | null;
}

function upstreamError(message: string): ApiError {
  return new ApiError(502, 'UPSTREAM_ERROR', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Masks the partner key before an upstream message reaches a log sink —
 * keeping it out of the response is not enough if it is shipped to logging
 * instead.
 *
 * The configured key is redacted first and by value. Matching only the
 * `rg_live_` prefix encoded a guess about how Vocobase issues keys into a
 * security control: the property wanted is "our key never lands in a log", and
 * a key rotated to a different prefix silently stopped satisfying it. The
 * pattern stays as a second net for keys seen in a message that are not ours.
 */
function redact(message: string): string {
  const key = env.vocobaseApiKey;
  const masked = key ? message.split(key).join('***') : message;

  return (
    masked
      .replace(/rg_live_[A-Za-z0-9_-]+/g, 'rg_live_***')
      /**
       * Webhook signing secrets, by the same argument.
       *
       * They are minted upstream, shown exactly once, and never readable
       * again — so unlike the partner key there is no configured value to
       * redact by. A prefix net is all there is, and it is worth having: a
       * secret that reaches a log sink signs completions and charges credits,
       * which is a strictly worse leak than the read key's. Nothing here
       * quotes one back today; this is for the message that starts to.
       */
      .replace(/whsec_[A-Za-z0-9_-]+/g, 'whsec_***')
      .slice(0, 300)
  );
}

/**
 * Unwraps `{ success, data | error }`.
 *
 * A failure envelope carries the upstream's own wording, which is logged
 * redacted and, for all but two statuses, never returned.
 *
 * **400 is the deliberate exception.** A validation failure is the one case
 * where the upstream message is the only thing that tells the caller what to
 * fix — "prompt must be 120000 characters or fewer" cannot be reconstructed
 * here without duplicating every upstream limit and then drifting from it. So
 * it is passed through, but only after the *same* `redact()` that protects the
 * logs: one control, one code path, so the two cannot diverge.
 *
 * 409 is mapped to its own code because a duplicate name is a mistake the
 * customer can correct, and a generic "could not complete that request" leaves
 * them with nothing to do. It deliberately does **not** say that an agent with
 * that name exists: the partner namespace is shared, so the colliding agent is
 * very often another workspace's, invisible by every other route. Confirming
 * it exists would turn create into a name-enumeration oracle over the whole
 * platform — the same fact the identical-404s elsewhere exist to withhold.
 *
 * 404 is passed through rather than flattened to 502. A resource that is
 * already gone is not a platform outage, and reporting it as one makes a
 * double-clicked delete read as a fault, and — worse — stops the caller from
 * cleaning up the local row that points at it.
 */
function unwrap<T>(
  body: unknown,
  status: number,
  conflictCode?: RequestOptions['conflictCode'],
): T {
  if (isRecord(body) && body.success === true && 'data' in body) {
    return body.data as T;
  }

  const raw = isRecord(body) && isRecord(body.error) ? body.error.message : undefined;
  const detail = typeof raw === 'string' ? redact(raw) : undefined;
  console.error('Voice platform request failed:', { status, detail });

  if (status === 400) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      // Stripped of anything shaped like an identifier before it is repeated.
      // `redact` protects our credential; it does not protect another
      // workspace's entity names, and an upstream message such as "document
      // doc_x is already linked to agent ag_y" would otherwise be read out
      // verbatim to a customer who is entitled to neither id.
      detail ? scrubIdentifiers(detail) : 'The voice platform rejected those values.',
    );
  }

  if (status === 404) {
    throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Not found.');
  }

  if (status === 409) {
    if (conflictCode) {
      throw new ApiError(
        409,
        conflictCode,
        detail ? scrubIdentifiers(detail) : 'The voice platform refused that request as a conflict.',
      );
    }
    throw new ApiError(409, 'NAME_TAKEN', 'That name is already in use. Choose another.');
  }

  // 403 and 429 exist for the dialer, which is the first caller here that has
  // to act differently on each. Collapsed into the generic 502 below — as they
  // were — a sweep cannot tell "the shared account is at its call ceiling"
  // from "YE's balance with the supplier ran out" from "the platform is
  // down", and all three take the same branch. The first two are transient and
  // account-wide, so the contact's attempt must be given back rather than
  // spent; the third is not.
  //
  // Neither message repeats upstream's wording and neither says why. A 429 is
  // usually another integrator's traffic on the shared partner account, and a
  // 403 means YE is short with its supplier — the customer reading this is
  // entitled to learn about neither, the same rule that keeps `credits_used`
  // and the carrier's name off the calls surface.
  if (status === 403) {
    throw new ApiError(
      403,
      'UPSTREAM_FORBIDDEN',
      'The voice platform refused that request. Please contact support.',
    );
  }
  // The supplier's own wallet is empty: VoiceLink's `add_lead` answers 402 and
  // `/calls/start` returns it before any call exists. Collapsed into the
  // generic `UPSTREAM_ERROR` the dialer read it as transient, and on
  // 2026-09-06/07 that meant 3,803 dials re-claimed and re-failed over thirty
  // hours with both campaigns still RUNNING. A status the dialer must act on
  // differently from an outage gets its own code — the rule 403 and 429 set.
  //
  // The message names neither the supplier nor the reason: which supplier is
  // under the product, and whether it is out of money, is not the customer's
  // to learn from an error.
  if (status === 402) {
    throw new ApiError(
      402,
      'UPSTREAM_PAYMENT_REQUIRED',
      'The voice platform could not place that call right now. Please contact support.',
    );
  }

  if (status === 429) {
    throw new ApiError(
      429,
      'UPSTREAM_RATE_LIMITED',
      'The voice platform is at capacity right now. Please try again shortly.',
    );
  }

  throw upstreamError('The voice platform could not complete that request.');
}

/**
 * Sentinel for a read where upstream's 404 is a fact about the resource, not a
 * failure of the platform. Only reads that opt in ever see it.
 */
const ABSENT = Symbol('absent');

/**
 * Removes token-shaped runs from a message that is about to be repeated to a
 * customer.
 *
 * Deliberately blunt. The alternative — allow-listing which upstream messages
 * may pass through — drifts the moment upstream adds a message, and drifts
 * silently in the unsafe direction.
 */
function scrubIdentifiers(message: string): string {
  return message
    .replace(/\b[a-z]{2,12}_[A-Za-z0-9]{6,}\b/g, '***')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '***')
    .replace(/\b[0-9a-f]{24,}\b/gi, '***');
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number>;
  /** Serialised as JSON. Omitted entirely when undefined, so a DELETE sends no
   *  body and no Content-Type. */
  body?: unknown;
  /** Opt-in: upstream's 404 is a fact about the resource, not a failure of the
   *  platform. The call resolves to the ABSENT sentinel instead of throwing. */
  absentOn404?: boolean;
  /**
   * Opt-out for the one V2 surface — lifecycle hooks — that answers a 2xx
   * with a bare document instead of `{ success, data }`.
   *
   * A **predicate over the parsed body, not the name of a key**. The bypass
   * skips `unwrap`, and `unwrap` is the only thing standing between a failure
   * dressed as a 200 — `{ success: false, error }` — and a route that reads
   * the missing key as "this agent has none". Testing `key in body` did not
   * hold that line: `in` is true for a key present with a null value, so
   * `{ hooks: null, success: false, error }` took the bypass and reached the
   * route as an empty list — the exact outcome this option exists to prevent.
   * The predicate must recognise the *document*, so a body that only mentions
   * it falls through to `unwrap` and maps by status as usual.
   */
  bareBody?: (body: Record<string, unknown>) => boolean;
  /**
   * Opt-in: this surface answers a FAILURE with the bare envelope too.
   *
   * The lifecycle-hook routes are consistent about it in both directions —
   * a 2xx is `{ hooks }` and a 4xx is `{ error: 'VALIDATION_FAILED', issues }`,
   * where `error` is a **code string** rather than the `{ code, message }`
   * object `unwrap` and `passUpstreamError` both read. Without this, a 422
   * whose whole value is its `issues` fell through the status mapping to a
   * generic 502 and the editor was told the platform was down when what
   * actually happened is that one field was blank.
   *
   * A predicate, and a named code only, for the reason `passUpstreamError`
   * is one: the default must stay "map by status", so nothing new leaks by
   * accident the day upstream invents a word. The `issues` ride along as
   * `details`, untouched — they name fields the caller itself submitted, so
   * there is nothing of another workspace's in them to scrub.
   */
  bareError?: (code: string) => boolean;
  /**
   * Opt-in: for a failure whose upstream `error.code` matches this predicate,
   * re-throw the platform's OWN code and message rather than mapping by HTTP
   * status through `unwrap`. Used only where the endpoint's contract IS the
   * upstream code — the inbound enable/disable two-step (`CONFIRM_REQUIRED`,
   * whose top-level `details` are carried through) and writing the inbound
   * config before enabling it (`INBOUND_NOT_ENABLED`). Everything else still
   * collapses to the generic status mapping, so this never widens what a route
   * leaks by accident: a code has to be named to pass.
   */
  passUpstreamError?: (code: string) => boolean;
  /**
   * Opt-in: an upstream 409 on this call means this, not a name collision.
   *
   * `unwrap` reads every 409 as `NAME_TAKEN` because, until the wallet, every
   * write that could conflict was a create-by-name. A payment link conflicts
   * on a count of open links instead, and the console has to act on that
   * differently — so the one call that can hit it says so here.
   */
  conflictCode?: 'OPEN_ORDER_LIMIT';
  /**
   * Opt-in: what a route the platform does not carry yet means to this call.
   *
   * The platform's catch-all answers an absent route with a bare
   * `{ error: 'Not found' }` (app.ts:426), where a live route's own "no such
   * agent" words it differently (`{ error: 'Agent not found' }`). Only that
   * exact body throws this; every other 404 still maps by status, so a
   * missing agent is never reported as a missing deployment.
   */
  routeAbsent?: () => ApiError;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const {
    method = 'GET',
    query,
    body,
    absentOn404,
    bareBody,
    bareError,
    passUpstreamError,
    conflictCode,
    routeAbsent,
  } = options;

  if (!env.vocobaseApiKey) {
    throw upstreamError('The voice platform integration is not configured.');
  }

  // Inside the guard: `new URL` throws a bare `TypeError` on a malformed base,
  // which outside it surfaces as a generic 500 rather than the deliberate
  // "could not reach the voice platform". `env.ts` now parses the base at boot
  // so this should be unreachable — which is the point of it still being here.
  let url: URL;
  try {
    url = new URL(`${env.vocobaseApiUrl.replace(/\/$/, '')}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, String(value));
    }
  } catch (err) {
    console.error('Voice platform URL is malformed:', err);
    throw upstreamError('Could not reach the voice platform.');
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.vocobaseApiKey}`,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.error('Voice platform request failed:', err);

    /**
     * A write whose *response* never arrived may well have been applied.
     *
     * "Could not reach the voice platform" is true of a read and reads as
     * "nothing happened", which for a read it is. For a create it is the one
     * message that must not be sent: the agent, dictionary or function may
     * exist upstream already, and a caller told nothing happened retries and
     * makes a second one. The post-201 orphan path was carefully handled; this
     * window — request sent, answer lost — was not, and produces the same
     * outcome the handling exists to prevent.
     */
    if (method !== 'GET') {
      throw new ApiError(
        502,
        'UPSTREAM_WRITE_UNCONFIRMED',
        'The voice platform did not answer, so it is not known whether that was applied. ' +
          'Check before trying again, or you may end up with two.',
      );
    }

    throw upstreamError('Could not reach the voice platform.');
  }

  // Before the body is read, deliberately. A gateway, a CDN or a bare nginx
  // answers 404 with HTML or with nothing at all, and requiring a JSON envelope
  // first turned every one of those into "the platform is unreadable" — an
  // outage — when the status had already answered the only question asked.
  if (absentOn404 && response.status === 404) {
    return ABSENT as T;
  }


  // A successful delete answers 204 with no body at all. Calling `.json()` on
  // it throws, which would report a working call as an unreadable response.
  //
  // Except where a document was the whole promise: a `bareBody` caller has no
  // envelope to fall back on, so an empty 204 reaches it as `undefined` and
  // destructures into a TypeError — an unreadable upstream reported as a 500
  // of ours. It is an unreadable response, and says so.
  if (response.status === 204) {
    if (bareBody) throw upstreamError('The voice platform returned an unreadable response.');
    return undefined as T;
  }

  let body_: unknown;
  try {
    body_ = await response.json();
  } catch {
    // A gateway error page is not JSON; the status is all we have.
    console.error('Voice platform returned a non-JSON response:', response.status);
    throw upstreamError('The voice platform returned an unreadable response.');
  }

  // `success !== false` as well as the predicate: an upstream that answers a
  // well-formed document *and* flags the call failed is telling us the
  // document is not to be trusted, and `unwrap` is where that is turned into
  // a 502 rather than read out as content.
  if (bareBody && response.ok && isRecord(body_) && body_.success !== false && bareBody(body_)) {
    return body_ as T;
  }

  if (
    routeAbsent &&
    response.status === 404 &&
    isRecord(body_) &&
    body_.error === 'Not found'
  ) {
    throw routeAbsent();
  }

  // The bare failure envelope, before either of the two below: `error` is a
  // string here, so `unwrap` reads it as "no message" and maps by status, and
  // `passUpstreamError` never fires because it requires `error` to be an
  // object. A named code keeps its status and its `issues`.
  if (
    bareError &&
    !response.ok &&
    isRecord(body_) &&
    typeof body_.error === 'string' &&
    bareError(body_.error)
  ) {
    const code = body_.error as ErrorCode;
    console.error('Voice platform request failed:', { status: response.status, detail: code });
    throw new ApiError(
      response.status,
      code,
      'The voice platform rejected those values.',
      Array.isArray(body_.issues) ? { issues: body_.issues } : undefined,
    );
  }

  // Before the generic status mapping: re-throw the platform's own error code
  // and message, and carry its top-level `details` through untouched. The
  // details belong to this workspace's own agent (the route resolved ownership
  // first), so there is nothing to scrub; the message runs through `redact` to
  // keep our partner key out of it, exactly as `unwrap` does.
  if (
    passUpstreamError &&
    isRecord(body_) &&
    body_.success === false &&
    isRecord(body_.error) &&
    typeof body_.error.code === 'string' &&
    passUpstreamError(body_.error.code)
  ) {
    const message =
      typeof body_.error.message === 'string'
        ? redact(body_.error.message)
        : 'The voice platform refused that request.';
    // The platform puts structured payload in two places: `details` beside
    // the envelope (CONFIRM_REQUIRED) and `error.details` inside it
    // (TAB_NOT_FOUND's `tabs`), and `issues` ride inside `error` where the
    // bare envelope puts them at the top. All three are folded into one
    // `details` so a route reads one shape whichever family answered — the
    // issues name form fields, the tabs name the picker's next move, and a
    // caller who cannot find either cannot say what to fix.
    const outer = isRecord(body_.details) ? body_.details : undefined;
    const inner = isRecord(body_.error.details) ? body_.error.details : undefined;
    const issues = Array.isArray(body_.error.issues) ? { issues: body_.error.issues } : undefined;
    const details =
      outer === undefined && inner === undefined && issues === undefined
        ? body_.details
        : { ...outer, ...inner, ...issues };
    throw new ApiError(response.status, body_.error.code as ErrorCode, message, details);
  }

  return unwrap<T>(body_, response.status, conflictCode);
}

const agentPath = (id: string, suffix = ''): string =>
  `/agent/${encodeURIComponent(id)}${suffix}`;

/** One page of the agent pool. `limit` is capped at 100 upstream. */
export function listAgents(query: ListAgentsQuery): Promise<ListAgentsResponse> {
  return request<ListAgentsResponse>('/agent/all', {
    query: { limit: query.limit, offset: query.offset },
  });
}

/**
 * A single agent's full configuration — used to refresh one row without
 * re-listing the pool.
 *
 * `includeInbound` asks the platform to return the agent's second, inbound
 * configuration alongside the outbound one (under an `inbound` key). Sync does
 * not need it — `inbound.enabled` rides along on every read — so it is opt-in
 * and off by default, and only the inbound-config editor pays for the larger
 * payload.
 */
export function getAgent(
  id: string,
  { includeInbound = false }: { includeInbound?: boolean } = {},
): Promise<UpstreamRecord> {
  return request<UpstreamRecord>(agentPath(id), {
    query: includeInbound ? { include: 'inbound' } : undefined,
  });
}

export function getAgentDocuments(id: string): Promise<AgentDocumentsResponse> {
  return request<AgentDocumentsResponse>(agentPath(id, '/documents'));
}

export function getAgentFunctions(id: string): Promise<AgentFunctionsResponse> {
  return request<AgentFunctionsResponse>(agentPath(id, '/functions'));
}

export function getAgentTools(id: string): Promise<AgentToolsResponse> {
  return request<AgentToolsResponse>(agentPath(id, '/tools'));
}

/**
 * The pre-call and post-call actions configured on an agent.
 *
 * Twice the odd one out upstream: mounted at `/agents/…` — plural — where
 * every other agent read is `/agent/…`, and answering 2xx with the bare
 * `{ hooks }` document rather than the success envelope. Both are pinned by
 * tests; neither is ours to normalise.
 */
export function getAgentLifecycleHooks(id: string): Promise<LifecycleHooksResponse> {
  return request<LifecycleHooksResponse>(
    `/agents/${encodeURIComponent(id)}/lifecycle-hooks`,
    // The document is the list, so that is what is required — not merely a
    // body that mentions `hooks`.
    { bareBody: (body) => Array.isArray(body.hooks) },
  );
}

/**
 * The voice catalogue.
 *
 * Used to resolve an agent's voice id into a name, and to fill the voice
 * picker. Each row carries the `tier` slug it belongs to, which is what the
 * entitlement filter reads.
 *
 * `tier` narrows the list upstream. The voices route deliberately does not
 * pass it: an account holding three tiers would spend three requests against a
 * partner rate limit every workspace on the platform shares, to assemble a
 * list one unfiltered request already contains. The parameter is here because
 * it is upstream's contract and is the seam to use the day a catalogue is too
 * large to filter in this process.
 */
export function listVoices(query: { tier?: string } = {}): Promise<VoicesResponse> {
  return request<VoicesResponse>('/agent/voices', {
    query: query.tier ? { tier: query.tier } : undefined,
  });
}

/**
 * The tiers this partner account may sell.
 *
 * Two facts per row and no more — a slug and a label. No price, no status:
 * what a tier costs an YE customer is YE's to decide, and so is retiring
 * one. That is why the local mirror owns every other column and why sync must
 * never write past `name`.
 */
export function listVoiceTiers(): Promise<VoiceTiersResponse> {
  return request<VoiceTiersResponse>('/agent/voice-tiers');
}

/*
 * Writes.
 *
 * Every one of these is reachable only from a route that has already resolved
 * the caller's membership and confirmed the agent belongs to that workspace.
 * Nothing here re-checks that — this layer speaks to the platform, it does not
 * decide who may.
 */

export function createAgent(body: UpstreamRecord): Promise<UpstreamRecord> {
  return request<UpstreamRecord>('/agent', { method: 'POST', body });
}

/** Partial update: only the keys supplied are changed upstream. */
export function updateAgent(id: string, body: UpstreamRecord): Promise<UpstreamRecord> {
  return request<UpstreamRecord>(agentPath(id), { method: 'PUT', body });
}

export function deleteAgent(id: string): Promise<void> {
  return request<void>(agentPath(id), { method: 'DELETE' });
}

/**
 * Turns an agent's inbound face on or off.
 *
 * Enable deep-copies the outbound configuration into a second, independent one
 * and is idempotent. Disable is a two-step confirm: called without `confirm`
 * while numbers or campaigns are still bound, upstream answers 409
 * `CONFIRM_REQUIRED` with a `details` payload naming them — which
 * `passUpstreamError` carries straight through so the dashboard can render it,
 * rather than letting the generic 409 mapping flatten it to `NAME_TAKEN`.
 */
export function setAgentInbound(
  id: string,
  enabled: boolean,
  confirm?: boolean,
): Promise<UpstreamRecord> {
  return request<UpstreamRecord>(agentPath(id, '/inbound'), {
    method: 'PATCH',
    body: confirm === undefined ? { enabled } : { enabled, confirm },
    passUpstreamError: (code) => code === 'CONFIRM_REQUIRED',
  });
}

/**
 * Writes the inbound face's configuration. Same body as an outbound update —
 * the two configurations share a shape — addressed with the agent's id, since
 * the inbound face has no id of its own.
 *
 * Called before the face is enabled, the platform answers 404
 * `INBOUND_NOT_ENABLED`; that is passed straight through rather than flattened
 * to `RESOURCE_NOT_FOUND`, so the caller learns the fix is to enable inbound
 * first rather than that some id was wrong.
 */
export function updateAgentInbound(id: string, body: UpstreamRecord): Promise<UpstreamRecord> {
  return request<UpstreamRecord>(agentPath(id, '/inbound/config'), {
    method: 'PUT',
    body,
    passUpstreamError: (code) => code === 'INBOUND_NOT_ENABLED',
  });
}

/**
 * The inbound face's knowledge-base sync state, read through the PARENT's id.
 *
 * What the inbound start waits on. Enabling a face commits it — and the
 * parent's `inboundEnabled` — inside one transaction and only then queues the
 * copied documents `PENDING` (Vocobase `agentFace.service.ts:604-607`, then
 * `:616-636`), so the agent read reports the face on at once while its
 * knowledge base is still being built. This is the signal that actually moves.
 *
 * Proxied to the face by `inboundFaceProxy.ts:78,115` and answered by
 * `agent-document.routes.ts:111-201` in the ordinary V2 envelope, so `unwrap`
 * reads it and no bypass is needed: `data` is `{ agent_id, summary, documents }`
 * and `summary` is `{ total, pending, syncing, synced, failed, deleted }`.
 * `agent_id` there is the FACE's own id and is never read. A face-less agent
 * answers the enveloped 404 `INBOUND_NOT_ENABLED` (`inboundFaceProxy.ts:102-111`),
 * which `unwrap` keeps a 404.
 *
 * Named for its one caller rather than for the route: the actions work
 * carries a fuller adapter for the face's sub-resources, and on that rebase
 * this is the function to fold into it.
 */
export function getFaceDocumentSyncStatusForStart(
  id: string,
): Promise<DocumentSyncStatusResponse> {
  return request<DocumentSyncStatusResponse>(agentPath(id, '/inbound/documents/sync-status'));
}

// ---------------------------------------------------------------------------
// Extraction sets: named, reusable key lists that attach to an agent.
//
// YE manages two of these — the campaign callback key and the call-note
// set — so the surface here is the calls that find-or-create one, attach it
// and take it back off again, and no more.
// The list endpoints are partner-wide, like every other pool on this platform,
// which is why the set is found by a name of ours rather than by a stored id.
// ---------------------------------------------------------------------------

export interface ExtractionSetKeyBody {
  name: string;
  type: string;
  description?: string;
  /** The answers this key is pinned to. An instruction carried into the
   *  model's prompt rather than a schema the platform enforces, so a pinned
   *  key can still come back null or off-list, and every reader of a call
   *  note re-judges the value instead of trusting it because it was pinned
   *  here. */
  values?: string[];
}

export interface ExtractionSetBody {
  name: string;
  description?: string;
  keys: ExtractionSetKeyBody[];
}

/** Envelopes vary by endpoint and the sets ride under their own key. Read
 *  defensively: an unrecognised shape is no sets rather than a throw. */
export interface ExtractionSetsResponse {
  extraction_sets?: UpstreamRecord[];
}

export function listExtractionSets(): Promise<ExtractionSetsResponse> {
  return request<ExtractionSetsResponse>('/extraction-sets');
}

export function createExtractionSet(body: ExtractionSetBody): Promise<UpstreamRecord> {
  return request<UpstreamRecord>('/extraction-sets', { method: 'POST', body });
}

/** The sets attached to one agent, in the order their keys merge. */
export function listAgentExtractionSets(agentId: string): Promise<ExtractionSetsResponse> {
  return request<ExtractionSetsResponse>(agentPath(agentId, '/extraction-sets'));
}

/**
 * Attaches a set to an agent. Idempotent upstream — 201 for a new attachment,
 * 200 when it was already there — and both are a success envelope, so neither
 * needs telling apart here.
 */
export function attachAgentExtractionSet(
  agentId: string,
  setId: string,
): Promise<UpstreamRecord> {
  return request<UpstreamRecord>(
    agentPath(agentId, `/extraction-sets/${encodeURIComponent(setId)}`),
    { method: 'POST' },
  );
}

/**
 * Detaches a set from an agent. The mirror of the attach above, and the half
 * that makes an YE-managed set a switch rather than a one-way door: a flag
 * turned back off has to stop the extraction it turned on, or the customer
 * goes on paying for a key nothing reads.
 */
export function detachAgentExtractionSet(agentId: string, setId: string): Promise<void> {
  return request<void>(
    agentPath(agentId, `/extraction-sets/${encodeURIComponent(setId)}`),
    { method: 'DELETE' },
  );
}

/** Connections eligible to be bound to this agent. Partner-wide upstream —
 *  the caller narrows it to what the workspace owns. */
export function getAvailableConnections(id: string): Promise<ConnectionsResponse> {
  return request<ConnectionsResponse>(agentPath(id, '/available-connections'));
}

export function setAgentTool(
  id: string,
  slug: string,
  body: SetAgentToolBody,
): Promise<UpstreamRecord> {
  return request<UpstreamRecord>(agentPath(id, `/tools/${encodeURIComponent(slug)}`), {
    method: 'PUT',
    body,
  });
}

export function detachFunction(agentId: string, functionId: string): Promise<void> {
  return request<void>(
    agentPath(agentId, `/functions/${encodeURIComponent(functionId)}`),
    { method: 'DELETE' },
  );
}

/**
 * Uploads bytes to a presigned storage URL.
 *
 * Deliberately not `request()`: that helper attaches the partner key to every
 * call, and this one goes to a storage host rather than to the platform. The
 * signature in the URL is the whole authorisation; sending the partner
 * credential to a third-party host as well would leak it for no benefit.
 */
export async function putToPresignedUrl(
  url: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    console.error('Upload to storage failed:', err);
    throw upstreamError('Could not upload the file to the voice platform.');
  }

  if (!response.ok) {
    console.error('Upload to storage failed:', response.status);
    throw upstreamError('Could not upload the file to the voice platform.');
  }
}

/*
 * Knowledge-base documents.
 *
 * A document belongs to the partner account, not to an agent: it is created
 * once and then linked. Adding a file is therefore four calls — presign, PUT,
 * confirm, link — while pasted text and a web link produce a ready document in
 * one, which is why both are worth having rather than only the file path.
 */

/** Step one of a file upload: reserves a document and a presigned URL. */
export function createDocumentUpload(body: {
  name: string;
  file_size: number;
  mime_type: string;
}): Promise<DocumentUploadTicket> {
  return request<DocumentUploadTicket>('/documents/upload', { method: 'POST', body });
}

/** Step three: marks the reserved document ready once the bytes have landed. */
export function confirmDocument(id: string): Promise<UpstreamRecord> {
  return request<UpstreamRecord>(`/documents/${encodeURIComponent(id)}/confirm`, {
    method: 'POST',
  });
}

export function createParagraphDocument(body: {
  name: string;
  content: string;
  description?: string;
}): Promise<UpstreamRecord> {
  return request<UpstreamRecord>('/documents/paragraph', { method: 'POST', body });
}

export function createWebLinkDocument(body: {
  name: string;
  url: string;
  description?: string;
}): Promise<UpstreamRecord> {
  return request<UpstreamRecord>('/documents/web-link', { method: 'POST', body });
}

export function deleteDocument(id: string): Promise<void> {
  return request<void>(`/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Upstream accepts 1–20 ids per call and caps an agent at 100 linked docs. */
export function linkDocuments(agentId: string, documentIds: string[]): Promise<LinkDocumentsResponse> {
  return request<LinkDocumentsResponse>(agentPath(agentId, '/documents'), {
    method: 'POST',
    body: { document_ids: documentIds },
  });
}

export function unlinkDocument(agentId: string, documentId: string): Promise<UpstreamRecord> {
  return request<UpstreamRecord>(
    agentPath(agentId, `/documents/${encodeURIComponent(documentId)}`),
    { method: 'DELETE' },
  );
}

/** Per-document indexing state, which the list merges in so a row can say
 *  whether the agent can actually read the document yet. */
export function getDocumentSyncStatus(agentId: string): Promise<DocumentSyncStatusResponse> {
  return request<DocumentSyncStatusResponse>(agentPath(agentId, '/documents/sync-status'));
}

/*
 * Speech-recognition dictionaries.
 *
 * Partner-level like documents: a dictionary is created once and attached to
 * any number of agents. Attachment is an idempotent set-replace rather than
 * add/remove, which is why the surface above it is a replace flow.
 */

export function listDictionaries(): Promise<DictionariesResponse> {
  return request<DictionariesResponse>('/dictionaries');
}

export function createDictionary(body: {
  name: string;
  description?: string;
  terms: string[];
}): Promise<UpstreamRecord> {
  return request<UpstreamRecord>('/dictionaries', { method: 'POST', body });
}

export function updateDictionary(
  id: string,
  body: { name?: string; description?: string; terms?: string[] },
): Promise<UpstreamRecord> {
  return request<UpstreamRecord>(`/dictionaries/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
  });
}

export function getDictionary(id: string): Promise<UpstreamRecord> {
  return request<UpstreamRecord>(`/dictionaries/${encodeURIComponent(id)}`);
}

export function deleteDictionary(id: string): Promise<void> {
  return request<void>(`/dictionaries/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function getAgentDictionaries(agentId: string): Promise<DictionariesResponse> {
  return request<DictionariesResponse>(agentPath(agentId, '/dictionaries'));
}

/** Idempotent set-replace. An empty array detaches everything. */
export function replaceAgentDictionaries(
  agentId: string,
  dictionaryIds: string[],
): Promise<DictionariesResponse> {
  return request<DictionariesResponse>(agentPath(agentId, '/dictionaries'), {
    method: 'PUT',
    body: { dictionary_ids: dictionaryIds },
  });
}

/*
 * Callable functions.
 *
 * Partner-level like the other pools: a function is defined once and attached
 * to any number of agents, and an agent's copy carries only an enabled flag.
 * So "add a function to this agent" is two different acts — define, and
 * attach — and both live here.
 */

export function listFunctions(): Promise<AgentFunctionsResponse> {
  return request<AgentFunctionsResponse>('/functions');
}

export function createFunction(body: UpstreamRecord): Promise<UpstreamRecord> {
  return request<UpstreamRecord>('/functions', { method: 'POST', body });
}

export function updateFunction(id: string, body: UpstreamRecord): Promise<UpstreamRecord> {
  return request<UpstreamRecord>(`/functions/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body,
  });
}

export function deleteFunction(id: string): Promise<void> {
  return request<void>(`/functions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function attachFunction(agentId: string, functionId: string): Promise<UpstreamRecord> {
  return request<UpstreamRecord>(
    agentPath(agentId, `/functions/${encodeURIComponent(functionId)}`),
    { method: 'POST' },
  );
}

export function toggleFunction(
  agentId: string,
  functionId: string,
  enabled: boolean,
): Promise<UpstreamRecord> {
  return request<UpstreamRecord>(
    agentPath(agentId, `/functions/${encodeURIComponent(functionId)}`),
    { method: 'PATCH', body: { enabled } },
  );
}

/**
 * Finds the DID array inside the telephony payload.
 *
 * That payload is nested one level deeper than the rest of the API: the
 * partner envelope's `data` holds the provider's own `{ status, message, data }`,
 * whose `data` is the paginated body, whose `data` is finally the array. The
 * shape has moved before, so each plausible nesting is tried in turn and an
 * unrecognised body yields no rows rather than throwing — a listing that
 * cannot be read is an empty sync, not a crashed one.
 */
function readDidRows(payload: unknown): PurchasedDidsPage {
  const layers = [payload, isRecord(payload) ? payload.data : undefined];

  for (const layer of layers) {
    if (Array.isArray(layer)) return { rows: layer as UpstreamRecord[], lastPage: null };
    if (!isRecord(layer)) continue;

    for (const key of ['data', 'items', 'records']) {
      const value = layer[key];
      if (Array.isArray(value)) {
        const lastPage = layer.last_page ?? layer.lastPage;
        return {
          rows: value as UpstreamRecord[],
          lastPage: typeof lastPage === 'number' && Number.isInteger(lastPage) ? lastPage : null,
        };
      }
    }
  }

  return { rows: [], lastPage: null };
}

/**
 * One page of the DIDs the platform's telephony connection has purchased.
 *
 * The only telephony call this service makes, and a read. Mapping a DID to a
 * client, creating routing or a bot, and anything that places a call all
 * mutate a live account that serves real customers, and none of them is needed
 * to record who owns a number here.
 */
export async function listPurchasedDids(query: PurchasedDidsQuery): Promise<PurchasedDidsPage> {
  // A partner holding several VoiceLink connections has to name the one this
  // inventory mirrors — upstream refuses to guess between them. With one
  // connection the id is omitted and upstream resolves it as it always has.
  const connectionId = env.vocobaseVoicelinkConnectionId;
  const payload = await request<unknown>('/voicelink/dids/purchased', {
    query: {
      page: query.page,
      per_page: query.perPage,
      ...(connectionId ? { connection_id: connectionId } : {}),
    },
  });

  return readDidRows(payload);
}

// ---------------------------------------------------------------------------
// Browser test sessions
// ---------------------------------------------------------------------------

export interface StartWebSessionBody {
  agent_id: string;
  variables?: Record<string, string>;
}

export interface StartWebSessionResponse {
  session_id?: string;
  agent_id?: string;
  daily_room_url?: string;
  daily_token?: string;
}

/**
 * Opens one browser WebRTC session against an agent.
 *
 * The room URL and the token it returns are the only upstream values on this
 * path that reach a browser. Both are single-use and scoped to one room, and
 * neither is the partner key — which is why this is the one place a caller may
 * hand something from upstream straight to the client.
 *
 * **There is no duration parameter.** The platform accepts `agent_id` and
 * `variables` and nothing else here, so nothing upstream stops a session that
 * nobody hangs up. `TEST_SESSION_MAX_SECS` and the reaper are the whole of the
 * cap, and the browser is told the number rather than assuming it.
 *
 * `variables` is omitted entirely when absent rather than sent as `{}`: an
 * absent key and an empty object are different requests, and only the first
 * means "none were asked for".
 */
export function startWebSession(body: StartWebSessionBody): Promise<StartWebSessionResponse> {
  return request<StartWebSessionResponse>('/sessions/webrtc', { method: 'POST', body });
}

/**
 * One session, browser or telephony, by the platform's own session id.
 *
 * `null` means the platform is certain there is no such session. Every other
 * failure still throws, because the two are different facts and the reaper acts
 * on them differently: "no such session" settles a row at zero, and an outage
 * leaves it for the next tick. This is the same distinction `getCall` draws a
 * few functions below, for the same reason.
 */
export async function getSession(id: string): Promise<UpstreamRecord | null> {
  const session = await request<UpstreamRecord | typeof ABSENT>(
    `/sessions/${encodeURIComponent(id)}`,
    { absentOn404: true },
  );

  return session === ABSENT ? null : session;
}

// ---------------------------------------------------------------------------
// Call history
// ---------------------------------------------------------------------------

export interface ListCallsQuery {
  limit: number;
  offset: number;
}

export interface ListCallsResponse {
  calls?: UpstreamRecord[];
  total?: number;
  limit?: number;
  offset?: number;
}

export interface RecordingUrlResponse {
  call_id?: string;
  recording_url?: string;
  expires_in?: number;
  expires_at?: string;
}

const callPath = (id: string, suffix = ''): string => `/calls/${encodeURIComponent(id)}${suffix}`;

/**
 * One page of the call listing, newest first by `started_at`.
 *
 * Deliberately no filter parameters beyond paging. Upstream accepts `status`,
 * but its values are provider-controlled and one it does not recognise is a
 * 400 — which would turn a new carrier disposition into a broken filter rather
 * than an empty result. Every filter this platform offers is applied here,
 * against rows already fetched. See `src/services/callHistory.ts`.
 */
export function listCalls(query: ListCallsQuery): Promise<ListCallsResponse> {
  return request<ListCallsResponse>('/calls', {
    query: { limit: query.limit, offset: query.offset },
  });
}

/**
 * One call, with its session: transcript, variables, extraction, recording.
 *
 * `null` means upstream is certain there is no such call. Every other failure
 * still throws `UPSTREAM_ERROR`, because the two are different facts and the
 * caller acts on them differently: "no such call" is about the call, and an
 * outage is about the platform. Collapsing them tells a reader their call was
 * deleted at the exact moment nobody could look it up.
 */
export async function getCall(id: string): Promise<UpstreamRecord | null> {
  const call = await request<UpstreamRecord | typeof ABSENT>(callPath(id), { absentOn404: true });

  return call === ABSENT ? null : call;
}

/** A freshly signed recording URL. The previous one expires after seven days. */
export function getCallRecordingUrl(id: string): Promise<RecordingUrlResponse> {
  return request<RecordingUrlResponse>(callPath(id, '/recording-url'));
}

/**
 * Fetches recording bytes from the presigned URL.
 *
 * Deliberately not built on `request()`. That helper attaches the partner key
 * to every call, and this URL points at the supplier's object storage rather
 * than the API — sending our credential to a third-party host would leak it to
 * somebody who never needed it, in a request that is already authorized by its
 * own signature.
 *
 * The raw `Response` comes back rather than a parsed body: the caller streams
 * it to the browser, and a recording is an hour of audio that must never be
 * held in memory. `Range` is forwarded so `<audio>` seeking works.
 */
/**
 * Addresses this service will not fetch a recording from.
 *
 * Loopback, link-local (which is where cloud metadata services live) and the
 * private ranges. The presigned URL arrives as a string in an upstream JSON
 * body and is handed to `fetch`, so without this the route relays whatever
 * answers at whatever address upstream names — a read primitive pointed at our
 * own network, reachable through an endpoint that looks like ordinary
 * playback.
 *
 * A literal check, not a resolved one: a name that resolves into these ranges
 * still passes. Closing that means resolving the host ourselves and pinning the
 * address, which is the stronger move if the supplier's storage hosts ever
 * become stable enough to allow-list outright.
 */
const BLOCKED_HOSTS =
  /^(localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd])/i;

/** The presigned URL, or an upstream error if it is not somewhere we will go. */
function fetchableRecordingUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    console.error('Voice platform returned a recording url that is not a url.');
    throw upstreamError('The voice platform could not return that recording.');
  }

  // https only. The bytes are a customer's call audio and the link is a bearer
  // credential; neither belongs on a plaintext hop.
  if (url.protocol !== 'https:' || BLOCKED_HOSTS.test(url.hostname)) {
    console.error('Voice platform returned an unfetchable recording host:', url.protocol);
    throw upstreamError('The voice platform could not return that recording.');
  }

  return url.toString();
}

export async function fetchRecording(url: string, range?: string): Promise<Response> {
  const target = fetchableRecordingUrl(url);

  const headers: Record<string, string> = {};
  if (range) headers.Range = range;
  // Storage rarely gzips audio, but undici would decode it on the way in and
  // leave the compressed Content-Length on the response. Asking for the bytes
  // as stored keeps the header describing the body.
  headers['Accept-Encoding'] = 'identity';

  // A deadline on *reaching* storage, not on the transfer. `AbortSignal.timeout`
  // keeps running once the headers arrive and would tear the body down
  // mid-play — and the recordings that take longest to send are exactly the
  // ones worth listening to. Cleared as soon as the response resolves, which
  // is the moment the fetch stops being a request and becomes a stream.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    return await fetch(target, {
      method: 'GET',
      headers,
      // Not followed. A redirect would be validated by nothing — the check
      // above applies to the URL upstream named, not to wherever that URL
      // points next. A 3xx surfaces to the caller as an upstream failure,
      // which is the safe reading if the supplier ever starts redirecting.
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (err) {
    // The name only. Some fetch failures carry the request URL on the error,
    // and that URL is a presigned link to a customer's audio, valid for a week.
    console.error('Voice platform recording fetch failed:', err instanceof Error ? err.name : 'unknown');
    throw upstreamError('Could not reach the voice platform.');
  } finally {
    clearTimeout(deadline);
  }
}

// ---------------------------------------------------------------------------
// Outbound dialing
//
// The first writes this service makes to the platform's telephony surface.
// Everything above is either a read or a write against agents and their
// pooled resources; these two place calls and build routing, which is why
// they are the only upstream calls in this repo gated behind a master switch.
// ---------------------------------------------------------------------------

export interface StartCallBody {
  agent_id: string;
  to_number: string;
  provider: string;
  from_number: string;
  client_reference_id: string;
  variables: Record<string, string>;
}

/**
 * `StartCallBody` plus the connection this deployment dials on.
 *
 * Separate from the caller-facing type on purpose: the connection is a
 * property of the deployment, not of the call, so no caller should be able to
 * pass one — and none should have to.
 */
type StartCallRequest = StartCallBody & { connection_id?: string };

export interface StartCallResponse {
  call_id?: string;
  session_id?: string;
  status?: string;
  provider?: string;
  from_number?: string;
  to_number?: string;
  agent_id?: string;
  /** Present when the platform replayed an existing call for this reference. */
  idempotent_replay?: boolean;
}

/**
 * Places one outbound call.
 *
 * `from_number` must name a number that is active on the selected connection,
 * which is what makes `voicelinkCallReady` below a precondition rather than a
 * nicety: a DID this platform has not imported cannot be a caller id.
 *
 * `client_reference_id` carries `ezo:<campaignId>:<contactId>:<attemptId>`.
 * The attempt id is the fourth segment and it matters: the platform documents
 * this field as a per-account idempotency key, so a reference repeated across
 * two attempts would replay the first call instead of dialing again, and
 * retries would silently never happen.
 */
export function startCall(body: StartCallBody): Promise<StartCallResponse> {
  // The same connection pin the VoiceLink endpoints carry. Upstream answers
  // `CONNECTION_AMBIGUOUS` here once a partner holds more than one active
  // connection, so without it a second connection stops every dial — while
  // the DID mirror, which already named one, carries on looking healthy.
  //
  // Spread first, so the pin cannot overwrite a field the caller set, and
  // `client_reference_id` in particular reaches upstream exactly as built:
  // it is the per-account idempotency key, and a retry that changed it would
  // place a second call instead of replaying the first.
  const connectionId = env.vocobaseVoicelinkConnectionId;
  const payload: StartCallRequest = {
    ...body,
    ...(connectionId ? { connection_id: connectionId } : {}),
  };

  return request<StartCallResponse>('/calls/start', { method: 'POST', body: payload });
}

export interface CallReadyStep {
  step?: string;
  status?: string;
  detail?: string;
}

export interface CallReadyReadiness {
  state?: string;
  issues?: string[];
  actions?: string[];
}

export interface CallReadyResponse {
  phone_number?: string;
  ready?: boolean;
  steps?: CallReadyStep[];
  readiness_before?: CallReadyReadiness | null;
  readiness?: CallReadyReadiness | null;
}

/**
 * Makes a purchased DID usable as an outbound caller id, idempotently.
 *
 * Resolves the DID, imports it into the platform's own number inventory if it
 * is missing, ensures a media bot exists, and points outbound routing at it —
 * preserving existing inbound routing, which is why this composed endpoint is
 * the documented safe path and the raw routing update is not: that one
 * REPLACES the record, so an inbound setting omitted is an inbound setting
 * lost.
 *
 * Deliberately called with `did_number` alone. Passing a client id would let
 * this service map an unmapped DID on a shared partner account off a value
 * somebody typed into a form, and mapping is the one step in that workflow
 * that is not idempotent in a recoverable direction. An unmapped DID therefore
 * cannot be made callable from here, and campaign start refuses it by name.
 */
export function voicelinkCallReady(didNumber: string): Promise<CallReadyResponse> {
  // Named for the reason `listPurchasedDids` names it: upstream refuses to
  // guess between a partner's connections and answers that this field is
  // required. Omitted when unset, so the single-connection deployment sends
  // exactly what it always sent.
  //
  // This is not the `client_id` the paragraph above rules out. That one would
  // come from whatever a caller typed; this comes from the deployment's own
  // environment, and it selects between connections rather than mapping a DID
  // to a client.
  const connectionId = env.vocobaseVoicelinkConnectionId;

  return request<CallReadyResponse>('/voicelink/call-ready', {
    method: 'POST',
    body: {
      did_number: didNumber,
      ...(connectionId ? { connection_id: connectionId } : {}),
    },
  });
}

/**
 * Inbound readiness for one DID. The nested `readiness.inbound.ready` is the
 * field that matters — distinct from the outbound `readiness` above, which is
 * flat — and the asymmetry is deliberate: for inbound a call that reaches the
 * bot and resolves no agent is rejected, so an agent that did not bind must
 * read as NOT ready, where the outbound path ignores that same state.
 */
export interface InboundReadyResponse {
  ready?: boolean;
  readiness?: {
    inbound?: { ready?: boolean; issues?: string[] };
    issues?: string[];
  } | null;
}

/**
 * Binds a DID to an agent for inbound and reports whether the number is ready
 * to answer. Points inbound routing at `agentExternalId`; the call is the
 * inbound twin of `voicelinkCallReady` and, like it, passes `connection_id` so
 * a multi-connection partner account picks the right one.
 *
 * `bot_name` is intentionally not sent: nothing in this deployment carries one,
 * and the platform resolves the media bot from the bound agent — the same way
 * `voicelinkCallReady` ensures a bot without naming it. If upstream ever
 * requires it, it is the one field to add here.
 */
export function voicelinkInboundReady(
  didNumber: string,
  agentExternalId: string,
): Promise<InboundReadyResponse> {
  const connectionId = env.vocobaseVoicelinkConnectionId;

  return request<InboundReadyResponse>('/voicelink/inbound-ready', {
    method: 'POST',
    body: {
      did_number: didNumber,
      agent_id: agentExternalId,
      ...(connectionId ? { connection_id: connectionId } : {}),
    },
  });
}

/**
 * Clears the inbound agent binding on the platform's phone-number row —
 * `agent_id: null`, which also turns `inbound_enabled` off. An inbound call on
 * the number then reaches the bot, resolves no agent, and is rejected, which is
 * the required behaviour when a campaign releases the DID.
 *
 * Idempotent, and it writes nothing to VoiceLink — the bot and the routing
 * record stay as they are — so there is nothing to unwind. A 404 (the row is
 * already gone) is a fact about the number, not an outage, so it resolves
 * rather than throwing.
 */
export function clearPhoneNumberAgent(phoneNumberExternalId: string): Promise<void> {
  return request<void>(`/phone-numbers/${encodeURIComponent(phoneNumberExternalId)}`, {
    method: 'PUT',
    body: { agent_id: null },
    absentOn404: true,
  });
}

/**
 * The account-wide inbound routing policy. One per partner account (scope
 * PARTNER): it fires for every inbound call on the account, and the claim table
 * — not a per-DID policy — decides which campaign owns each number, so there is
 * one lifecycle to keep in step rather than one per DID.
 */
export interface InboundRoutePolicyRecord {
  id?: string;
  scope?: string;
  name?: string;
  enabled?: boolean;
  webhook_url?: string;
  timeout_ms?: number;
  failure_action?: string;
  allowed_actions?: string[];
}

export interface InboundRoutePoliciesResponse {
  policies?: InboundRoutePolicyRecord[];
}

export function listInboundRoutePolicies(): Promise<InboundRoutePoliciesResponse> {
  return request<InboundRoutePoliciesResponse>('/inbound-route-policies');
}

export function createInboundRoutePolicy(
  body: Record<string, unknown>,
): Promise<InboundRoutePolicyRecord> {
  return request<InboundRoutePolicyRecord>('/inbound-route-policies', { method: 'POST', body });
}

export function updateInboundRoutePolicy(
  policyId: string,
  body: Record<string, unknown>,
): Promise<InboundRoutePolicyRecord> {
  return request<InboundRoutePolicyRecord>(
    `/inbound-route-policies/${encodeURIComponent(policyId)}`,
    { method: 'PATCH', body },
  );
}

export interface ConcurrencyResponse {
  /** Null means the partner account is uncapped. NEVER coerce this to 0. */
  limit?: number | null;
  limit_source?: string;
  active?: number;
  remaining?: number | null;
  statuses_counted?: string[];
}

/**
 * How much of the shared account's call capacity is left.
 *
 * The platform names this as the endpoint to pace a dialer against, and it is
 * account-wide: every YE customer and every other integrator on the partner
 * account draws from the one pool. Read once per sweep pass rather than per
 * call — the point of reading it at all is to stop before the 429, not to
 * discover the ceiling one wasted attempt at a time.
 *
 * `limit` and `remaining` are null for an uncapped account. A `?? 0` here
 * would stop an unlimited platform from placing a single call.
 */
export function getConcurrency(): Promise<ConcurrencyResponse> {
  return request<ConcurrencyResponse>('/calls/concurrency');
}

/*
 * Webhook configuration.
 *
 * The endpoint this backend receives outcomes on is registered upstream, and
 * until now it was registered by hand. These are the reads and writes behind
 * the staff surface that does it instead — see `routes/admin/webhookConfig`.
 *
 * One property shapes all of it: a signing secret is generated upstream and
 * returned **in full exactly once**, on create and on rotation. It is not
 * readable afterwards by any route — the account config answers with a literal
 * placeholder — so the only recovery from a lost secret is another rotation.
 * This layer therefore passes that value through untouched: a secret edited,
 * trimmed or truncated here is a secret no signature verifies, and the failure
 * would look like the platform sending bad deliveries.
 */

/** One endpoint, as every read returns it. Never carries a secret. */
export interface WebhookEndpointRecord {
  id?: string;
  label?: string;
  url?: string;
  enabled?: boolean;
  agent_id?: string | null;
  agent_name?: string | null;
  /** The event allowlist. **Empty means every event**, including ones the
   *  platform adds later — not "none". */
  events?: string[];
  last_delivery_at?: string | null;
  last_delivery_status?: number | null;
  created_at?: string;
  updated_at?: string;
}

/** A create's answer: the endpoint, plus the one sight of its secret. */
export interface CreatedWebhookEndpoint extends WebhookEndpointRecord {
  secret?: string;
  message?: string;
}

/** A rotation's answer. Deliberately not the whole endpoint — upstream returns
 *  four fields, and inventing the rest here would be fiction. */
export interface RotatedWebhookSecret {
  id?: string;
  label?: string;
  secret?: string;
  message?: string;
}

export interface WebhookEndpointsResponse {
  endpoints?: WebhookEndpointRecord[];
  /** The catalogue an allowlist may draw from, echoed by upstream so a client
   *  never has to hard-code it and drift. */
  available_events?: string[];
}

export interface PartnerConfigResponse {
  /**
   * The account's singular webhook block. `secret` is upstream's own masked
   * placeholder — the real value is unreadable here, by design.
   */
  webhook?: { configured?: boolean; url?: string | null; secret?: string | null } | null;
  webhooks?: WebhookEndpointRecord[];
}

export interface CreateWebhookEndpointBody {
  /** Lowercase alnum and hyphens, 1-31 chars, unique across the account.
   *  `default` is reserved upstream and refused. */
  label: string;
  url: string;
  enabled?: boolean;
  events?: string[];
}

/** Every key optional: only what is supplied is written. `agent_id` is
 *  deliberately absent — upstream refuses it even at its current value. */
export interface UpdateWebhookEndpointBody {
  label?: string;
  url?: string;
  enabled?: boolean;
  events?: string[];
}

const webhookEndpointPath = (id: string, suffix = ''): string =>
  `/config/webhooks/${encodeURIComponent(id)}${suffix}`;

/** The whole account configuration, whose webhook block echoes a masked
 *  secret. One request answers both "is an endpoint registered" and "which". */
export function getPartnerConfig(): Promise<PartnerConfigResponse> {
  return request<PartnerConfigResponse>('/config');
}

/** Every endpoint on the account. `agent_id` narrows the scope; omitted, the
 *  whole account's rows come back. */
export function listWebhookEndpoints(
  query: { agent_id?: string } = {},
): Promise<WebhookEndpointsResponse> {
  return request<WebhookEndpointsResponse>('/config/webhooks', {
    query: query.agent_id ? { agent_id: query.agent_id } : undefined,
  });
}

/** Registers an endpoint. The 201 carries the secret; there is no second
 *  chance to read it. */
export function createWebhookEndpoint(
  body: CreateWebhookEndpointBody,
): Promise<CreatedWebhookEndpoint> {
  return request<CreatedWebhookEndpoint>('/config/webhooks', { method: 'POST', body });
}

export function updateWebhookEndpoint(
  id: string,
  body: UpdateWebhookEndpointBody,
): Promise<WebhookEndpointRecord> {
  return request<WebhookEndpointRecord>(webhookEndpointPath(id), { method: 'PATCH', body });
}

export function deleteWebhookEndpoint(id: string): Promise<void> {
  return request<void>(webhookEndpointPath(id), { method: 'DELETE' });
}

/**
 * Mints a new secret for an endpoint and returns it, once.
 *
 * Deliveries already enqueued keep signing with the pre-rotation secret, so a
 * receiver that accepts both values for a while drops nothing — which is what
 * `VOCOBASE_WEBHOOK_SECRET_PREVIOUS` is for.
 */
export function rotateWebhookSecret(id: string): Promise<RotatedWebhookSecret> {
  return request<RotatedWebhookSecret>(webhookEndpointPath(id, '/rotate-secret'), {
    method: 'POST',
  });
}

/**
 * Enqueues a signed test delivery to one endpoint.
 *
 * Answers 202: enqueued, not accepted. Whether the receiver liked it is a
 * separate question this does not answer.
 */
export function testWebhookEndpoint(id: string): Promise<{ delivery_id?: string }> {
  return request<{ delivery_id?: string }>(webhookEndpointPath(id, '/test'), { method: 'POST' });
}

/*
 * The supplier wallet.
 *
 * Every YE customer's calls are paid for out of one partner balance. These
 * are the reads and the one write behind the staff console's Platform wallet
 * page — see `routes/admin/wallet.routes.ts`. Nothing here is reachable from a
 * customer route, and nothing here must ever be: the link credits YE's wallet.
 */

export interface BalanceResponse {
  /** Decimal string or number, in display credits (₹). Read through the
   *  service, which refuses anything that is not a finite number. */
  credits?: string | number;
  balance?: string | number;
  currency?: string;
}

export interface TopupConfigResponse {
  presets: number[];
  min: number;
  max: number;
  gst_rate_bps: number;
}

export interface TopupQuote {
  base: number;
  gst: number;
  total: number;
}

export interface TopupLink extends TopupQuote {
  payment_order_id: string;
  short_url: string;
  expires_at: string;
}

export type TopupLinkStatus =
  | 'CREATED'
  | 'ATTEMPTED'
  | 'FAILED'
  | 'CREDITED'
  | 'EXPIRED'
  | 'MISMATCH';

export interface TopupLinkStatusResponse extends TopupQuote {
  payment_order_id: string;
  status: TopupLinkStatus;
  credited_at: string | null;
  created_at: string;
}

export function getBalance(): Promise<BalanceResponse> {
  return request<BalanceResponse>('/billing/balance');
}

export function getTopupConfig(): Promise<TopupConfigResponse> {
  return request<TopupConfigResponse>('/billing/topup/config');
}

/** Pure arithmetic upstream; 60 per hour. */
export function quoteTopup(amountRupees: number): Promise<TopupQuote> {
  return request<TopupQuote>('/billing/topup/quote', {
    method: 'POST',
    body: { amount_rupees: amountRupees },
  });
}

/** Mints a payment link; 10 per hour, at most 5 open. The amount must be a
 *  JSON number — a string is an upstream 400. */
export function createTopupLink(amountRupees: number): Promise<TopupLink> {
  return request<TopupLink>('/billing/topup/links', {
    method: 'POST',
    body: { amount_rupees: amountRupees },
    conflictCode: 'OPEN_ORDER_LIMIT',
  });
}

export function getTopupLink(paymentOrderId: string): Promise<TopupLinkStatusResponse> {
  return request<TopupLinkStatusResponse>(
    `/billing/topup/links/${encodeURIComponent(paymentOrderId)}`,
  );
}

// ---- partner customers & connections ----
//
// One fenced block, at the end of the file, because a sibling branch appends
// its own beside it. Everything the Google connect flow (design §2–§3) needs
// from the platform lives here and nowhere else in this file.
//
// The platform's OAuth connections are partner-wide: one account, every YE
// workspace's tokens in one pool. A **partner customer** per workspace is what
// makes a token row upstream belong to the workspace that consented to it, and
// `GET /customers/:id/connections` is then the authoritative answer to "is this
// connection theirs" — the check the return leg makes before it maps anything.

export interface PartnerCustomerBody {
  /** The workspace id. Upstream de-duplicates on it, so a retried create after
   *  a lost response finds the same customer rather than making a second. */
  external_id: string;
  name: string;
}

export interface PartnerCustomer {
  id?: string;
  external_id?: string;
  name?: string;
  email?: string | null;
  status?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ConnectLinkBody {
  tool_slug: string;
  /** Must be on the partner user's `allowedRedirectHosts` upstream, or the
   *  call is refused — an ops step per environment, not something a request
   *  can arrange. See `docs/deploy.md`. */
  redirect_uri: string;
  expires_in_seconds?: number;
}

export interface ConnectLink {
  url?: string;
  expires_at?: string;
}

export interface CustomerConnection {
  id?: string;
  tool_slug?: string;
  tool_name?: string;
  status?: string;
  provider_email?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface CustomerConnectionsResponse {
  connections?: CustomerConnection[];
}

export interface Connector {
  id?: string;
  slug?: string;
  name?: string;
  description?: string | null;
  provider?: string;
  status?: string;
  oauth_scopes?: unknown;
  capabilities?: unknown;
}

export interface ConnectorsResponse {
  connectors?: Connector[];
}

/**
 * The connect-link refusals that are passed through wearing upstream's own
 * code instead of being mapped by HTTP status.
 *
 * Every one of them is a 400 that the customer clicking *Connect* cannot do
 * anything about, and `unwrap` would flatten all five into `VALIDATION_ERROR`
 * — "the voice platform rejected those values", said to somebody who supplied
 * none. `INVALID_REDIRECT_URI` in particular means this environment's API host
 * was never added to the partner's `allowedRedirectHosts`, which is an ops
 * step; the integrations route turns it into `INTEGRATIONS_NOT_CONFIGURED` so
 * the dashboard can say so rather than blaming the reader.
 *
 * An **allow-list**, deliberately: a 400 the platform adds later still arrives
 * as the mapped validation failure rather than as an unknown code the
 * dashboard has no branch for.
 */
const CONNECT_LINK_CODES = new Set([
  'INVALID_REDIRECT_URI',
  'TOOL_NOT_FOUND',
  'TOOL_INACTIVE',
  'CUSTOMER_ARCHIVED',
  'PARTNER_MISMATCH',
]);

const customerPath = (id: string, suffix = ''): string =>
  `/customers/${encodeURIComponent(id)}${suffix}`;

/**
 * Creates — or finds — the customer standing for one workspace.
 *
 * Idempotent upstream on `(partner, external_id)` and answers 200 rather than
 * 201 for both cases, so there is nothing here to tell a create from a
 * re-read. That is the property `ensurePartnerCustomer` leans on when a
 * response is lost: calling again is safe and returns the same id.
 */
export function createPartnerCustomer(body: PartnerCustomerBody): Promise<PartnerCustomer> {
  return request<PartnerCustomer>('/customers', { method: 'POST', body });
}

/** Mints the hosted-OAuth URL the admin's browser is sent to. */
export function createConnectLink(
  customerId: string,
  body: ConnectLinkBody,
): Promise<ConnectLink> {
  return request<ConnectLink>(customerPath(customerId, '/connect-link'), {
    method: 'POST',
    // Spread rather than passed whole so an absent `expires_in_seconds` is
    // omitted from the JSON instead of sent as null — upstream reads a null as
    // a malformed value, not as "use your default".
    body: {
      tool_slug: body.tool_slug,
      redirect_uri: body.redirect_uri,
      ...(body.expires_in_seconds === undefined
        ? {}
        : { expires_in_seconds: body.expires_in_seconds }),
    },
    passUpstreamError: (code) => CONNECT_LINK_CODES.has(code),
  });
}

/**
 * Every connection this workspace's customer holds.
 *
 * The isolation boundary as well as a listing: a connection id that is not in
 * this answer is not this workspace's, whoever claims otherwise. The return
 * leg checks the id the platform redirected with against it before mapping
 * anything.
 */
export function listCustomerConnections(customerId: string): Promise<CustomerConnectionsResponse> {
  return request<CustomerConnectionsResponse>(customerPath(customerId, '/connections'));
}

/** Revokes the connection upstream. 204 on success; 404 when it is already
 *  gone, which the route treats as "drop the mapping" rather than as a fault. */
export function deleteCustomerConnection(
  customerId: string,
  connectionId: string,
): Promise<void> {
  return request<void>(
    customerPath(customerId, `/connections/${encodeURIComponent(connectionId)}`),
    { method: 'DELETE' },
  );
}

/**
 * The connector catalogue: what this partner account may offer at all.
 *
 * Partner-level and carries no customer data, so unlike the listings in the
 * rest of this file it needs no intersection — a connector is a product, not
 * somebody's resource.
 */
export function listConnectors(): Promise<ConnectorsResponse> {
  return request<ConnectorsResponse>('/connectors');
}

// ---- lifecycle hooks & runs ----
//
// The write half of the pre-call / post-call action surface, the two read
// proxies beside it, and the inbound face's mirror of all of it.
//
// Kept in one block at the foot of the file on purpose: `feat/google-connect`
// appends its customer and connect-link functions here too, and a single
// fenced region is the one shape two branches can both grow without meeting
// in the middle of somebody else's function.
//
// Two conventions this family does not share with the rest of the client, and
// neither is ours to normalise — both are pinned by tests:
//
//  - The path is `/agents/…` (plural) where every other agent call is
//    `/agent/…`. The *tools* half of the face is the singular one, because it
//    hangs off the tools surface rather than the hooks surface.
//  - Both envelopes are bare. A 2xx is the document itself (`{ hooks }`,
//    `{ hook }`, `{ input }`) and a failure is `{ error: '<CODE>', issues? }`,
//    so every call here opts into `bareBody` **and** `bareError`.

/** The bare `{ hook }` document a create, update or read-one answers. */
export interface LifecycleHookResponse {
  hook?: UpstreamRecord;
}

/**
 * The preview document: the template rendered, and whether the hook's
 * `skipUnless` guard would have skipped it against the sample variables
 * (crud.service.ts:1056-1062).
 */
export interface LifecycleHookPreviewResponse {
  renderedInput?: UpstreamRecord;
  hook?: UpstreamRecord;
  skipped?: boolean;
  /** The one `skipUnless` path that was empty, when `skipped` is true. */
  skippedOn?: string | null;
}

/**
 * A hook as the platform accepts it on create and on the face's replace-all.
 *
 * camelCase, because that is what the V2 hook routes read — the YE API's own
 * body is snake_case and the route translates. Everything but `stage` and
 * `name` is optional: which of the rest apply depends on the source, and the
 * platform is the authority on that combination, not a type here that would
 * have to be kept in step with a catalogue it cannot see.
 */
export interface LifecycleHookWrite {
  stage: 'PRE_CALL' | 'POST_CALL';
  name: string;
  toolSlug?: string | null;
  toolFn?: string | null;
  functionId?: string | null;
  input?: Record<string, unknown>;
  exposeAs?: string | null;
  required?: boolean;
  timeoutMs?: number;
  enabled?: boolean;
  skipUnless?: string[];
}

/** A partial of the above; `stage` and the source are fixed once created. */
export type LifecycleHookPatch = Partial<
  Pick<
    LifecycleHookWrite,
    'name' | 'input' | 'exposeAs' | 'required' | 'timeoutMs' | 'enabled' | 'skipUnless'
  >
>;

export interface LifecycleHookReorder {
  stage: 'PRE_CALL' | 'POST_CALL';
  ids: string[];
}

export interface SheetColumnsQuery {
  spreadsheet_id: string;
  /** Omitted when the caller wants the workbook's tab list rather than one
   *  tab's headers — the editor's first step, before a sheet is chosen. */
  sheet_name?: string;
}

/** The platform's document: one tab's headers plus the workbook's tab list. */
export interface SheetColumnsResponse {
  columns?: unknown[];
  /** The tab that was read — the first one, when the caller named none. */
  sheet_name?: string;
  spreadsheet_id?: string;
  /** Every tab in the workbook, for the picker's first step. */
  tabs?: unknown[];
  /** True when the header row was cut at the platform's column cap. */
  truncated?: boolean;
}

export interface IntegrationLogsQuery {
  /**
   * Optional: an inbound call asks by `sessionId` alone. A bare `agentId` is
   * the PARENT and, without `side`, excludes the face's rows
   * (integration-logs.routes.ts:153-170), which is exactly where an inbound
   * call's runs are. The partner-key scope still bounds the read.
   */
  agentId?: string;
  toolSlug?: string;
  /** ISO 8601. The platform keeps a 30-day window whatever is asked for. */
  from?: string;
  to?: string;
  /** The platform's own session id — an YE attempt's `upstreamSessionId`. */
  sessionId?: string;
  /**
   * `'inbound'` asks for the face's rows. The face has no id of its own on
   * this surface: the rows are keyed on the PARENT agent and `side` picks
   * which face's (integration-logs.routes.ts:171-185).
   */
  side?: 'inbound';
  cursor?: string;
  limit?: number;
}

export interface IntegrationLogsResponse {
  logs?: UpstreamRecord[];
  nextCursor?: string | null;
}

/** The two bare-envelope opts, applied to every call in this family. */
function hookEnvelope(
  document: (body: Record<string, unknown>) => boolean,
): Pick<RequestOptions, 'bareBody' | 'bareError'> {
  return {
    bareBody: document,
    // Only the one code. A refusal the platform words differently is still an
    // upstream failure mapped by status, which is the safe default.
    bareError: (code) => code === 'VALIDATION_FAILED',
  };
}

/**
 * The inbound family's opts. The face's routes answer the ordinary V2
 * envelope — `{ success, data }` on success, `{ success: false, error: {
 * code, message, issues? } }` on failure — where the base family is bare, so
 * `bareBody` still recognises a bare document (a `data`-wrapped one falls
 * through to `unwrap`, which reads it), and the codes a reader must see as
 * themselves are passed through: VALIDATION_FAILED with its `issues`,
 * INBOUND_NOT_ENABLED, the platform's own "this agent has no face", and
 * NOT_FOUND, a stale hook id or a missing face
 * (inbound-lifecycle-hooks.routes.ts:83-91,343,361,416).
 *
 * That last one is what tells the two 404s apart by BODY. A route the
 * platform does not carry is its catch-all, `{ error: 'Not found' }` with no
 * envelope (app.ts:426), which `unwrap` maps to RESOURCE_NOT_FOUND — the
 * only 404 the route reads as "not deployed".
 */
const FACE_PASSED_CODES = new Set(['VALIDATION_FAILED', 'INBOUND_NOT_ENABLED', 'NOT_FOUND']);

function inboundHookEnvelope(
  document?: (body: Record<string, unknown>) => boolean,
): Pick<RequestOptions, 'bareBody' | 'bareError' | 'passUpstreamError'> {
  return {
    ...(document === undefined ? {} : { bareBody: document }),
    bareError: (code) => code === 'VALIDATION_FAILED',
    passUpstreamError: (code) => FACE_PASSED_CODES.has(code),
  };
}

const isHookList = (body: Record<string, unknown>): boolean => Array.isArray(body.hooks);
const isHook = (body: Record<string, unknown>): boolean => isRecord(body.hook);
const isPreview = (body: Record<string, unknown>): boolean => isRecord(body.renderedInput);

const hooksPath = (id: string, suffix = ''): string =>
  `/agents/${encodeURIComponent(id)}/lifecycle-hooks${suffix}`;

/** The same family on the agent's inbound face (platform release — see §9). */
const inboundHooksPath = (id: string, suffix = ''): string =>
  `/agents/${encodeURIComponent(id)}/inbound/lifecycle-hooks${suffix}`;

/**
 * Replaces the BASE agent's whole list in one call — the base twin of
 * `replaceInboundLifecycleHooks`, used when a `BI` agent keeps its inbound
 * persona on the way to `UNI`.
 *
 * `PUT /agents/:id/lifecycle-hooks` with `{ hooks }`, answered like the rest
 * of the base family: the bare `{ hooks }` document on success, the bare
 * `{ error: 'VALIDATION_FAILED', issues }` on a refusal. A newer platform
 * route than the rest of the family, so a deployment without it answers the
 * catch-all 404, which is reported as that rather than as a missing agent.
 */
export function replaceAgentLifecycleHooks(
  id: string,
  hooks: LifecycleHookWrite[],
): Promise<LifecycleHooksResponse> {
  return request<LifecycleHooksResponse>(hooksPath(id), {
    method: 'PUT',
    body: { hooks },
    ...hookEnvelope(isHookList),
    routeAbsent: () =>
      new ApiError(
        501,
        'KEEP_INBOUND_UNAVAILABLE',
        'Keeping the inbound persona needs a platform update that is not live yet. ' +
          'Keep the outbound persona, or try again later.',
      ),
  });
}

export function createAgentLifecycleHook(
  id: string,
  body: LifecycleHookWrite,
): Promise<LifecycleHookResponse> {
  return request<LifecycleHookResponse>(hooksPath(id), {
    method: 'POST',
    body,
    ...hookEnvelope(isHook),
  });
}

export function updateAgentLifecycleHook(
  id: string,
  hookId: string,
  body: LifecycleHookPatch,
): Promise<LifecycleHookResponse> {
  return request<LifecycleHookResponse>(hooksPath(id, `/${encodeURIComponent(hookId)}`), {
    method: 'PATCH',
    body,
    ...hookEnvelope(isHook),
  });
}

export function deleteAgentLifecycleHook(id: string, hookId: string): Promise<void> {
  return request<void>(hooksPath(id, `/${encodeURIComponent(hookId)}`), {
    method: 'DELETE',
    // No `bareBody`: a delete answers 204 with nothing, and requiring a
    // document of it would report a working delete as an unreadable response.
    bareError: (code) => code === 'VALIDATION_FAILED',
  });
}

export function reorderAgentLifecycleHooks(
  id: string,
  body: LifecycleHookReorder,
): Promise<LifecycleHooksResponse> {
  return request<LifecycleHooksResponse>(hooksPath(id, '/reorder'), {
    method: 'POST',
    body,
    ...hookEnvelope(isHookList),
  });
}

export function previewAgentLifecycleHook(
  id: string,
  hookId: string,
  body: { variables?: Record<string, unknown> },
): Promise<LifecycleHookPreviewResponse> {
  return request<LifecycleHookPreviewResponse>(
    hooksPath(id, `/${encodeURIComponent(hookId)}/preview`),
    { method: 'POST', body, ...hookEnvelope(isPreview) },
  );
}

/**
 * One tab's column headers, and the workbook's tab list beside them.
 *
 * The tools surface, not the hooks surface, so it is the singular `/agent/`
 * path and the ordinary success envelope. The platform's typed refusals are
 * passed through as themselves: `NOT_CONNECTED` (409, no Google account),
 * `NOT_AUTHENTICATED` (409, Google rejected the stored token),
 * `SHEET_NOT_CONFIGURED` (422, no spreadsheet id to read), `TAB_NOT_FOUND`
 * (404, whose `error.details.tabs` lists the tabs that do exist),
 * `SHEET_NOT_FOUND` (404, the account cannot open it) and `SHEETS_ERROR`
 * (429 rate limit, 502/500 otherwise). The route turns each into a sentence
 * a reader can act on, and none is reconstructible from the status mapping.
 */
const SHEET_COLUMNS_CODES = new Set([
  'NOT_CONNECTED',
  'SHEET_NOT_CONFIGURED',
  'TAB_NOT_FOUND',
  // sheetColumns.service.ts:222-248. Mapped by status these were worse than
  // generic: NOT_AUTHENTICATED is a 409, and `unwrap` reads every other 409
  // as NAME_TAKEN, so a revoked Google token said "that name is in use".
  'NOT_AUTHENTICATED',
  'SHEET_NOT_FOUND',
  'SHEETS_ERROR',
]);

export function getSheetColumns(
  id: string,
  query: SheetColumnsQuery,
): Promise<SheetColumnsResponse> {
  return request<SheetColumnsResponse>(agentPath(id, '/tools/google_sheets/sheet-columns'), {
    query: {
      spreadsheet_id: query.spreadsheet_id,
      ...(query.sheet_name === undefined ? {} : { sheet_name: query.sheet_name }),
    },
    passUpstreamError: (code) => SHEET_COLUMNS_CODES.has(code),
  });
}

/**
 * The platform's audit row per hook run, filtered.
 *
 * Nothing is stored on this side, so a window the platform has pruned comes
 * back empty and the route says "older than the platform keeps" rather than
 * "nothing ran". Undefined filters are dropped rather than sent empty: an
 * empty `sessionId` upstream is a filter on the empty string, which matches
 * nothing, and would render every agent's runs as none.
 */
export function listIntegrationLogs(
  query: IntegrationLogsQuery,
): Promise<IntegrationLogsResponse> {
  const params: Record<string, string | number> = {};
  if (query.agentId !== undefined) params.agentId = query.agentId;
  if (query.toolSlug !== undefined) params.toolSlug = query.toolSlug;
  if (query.from !== undefined) params.from = query.from;
  if (query.to !== undefined) params.to = query.to;
  if (query.sessionId !== undefined) params.sessionId = query.sessionId;
  if (query.side !== undefined) params.side = query.side;
  if (query.cursor !== undefined) params.cursor = query.cursor;
  if (query.limit !== undefined) params.limit = query.limit;

  return request<IntegrationLogsResponse>('/integration-logs', {
    query: params,
    // Success is BARE: the platform answers `res.json({ logs, nextCursor })`
    // with no `{ success, data }` around it (integration-logs.routes.ts:215-
    // 233). Without this `unwrap` found no envelope and threw a 502 on every
    // real answer. A predicate on the document, not on a key's presence, so
    // the enveloped 404 NOT_FOUND (:140-144) still maps by status.
    bareBody: (b) => Array.isArray(b.logs),
    // The face read's own refusal, passed through wearing the platform's
    // code. Fires only on the V2 failure envelope, so a base read (which
    // never earns it) is unaffected.
    passUpstreamError: (code) => code === 'INBOUND_NOT_ENABLED',
  });
}

export function getInboundLifecycleHooks(id: string): Promise<LifecycleHooksResponse> {
  return request<LifecycleHooksResponse>(inboundHooksPath(id), inboundHookEnvelope(isHookList));
}

/**
 * Replaces the face's whole list in one call.
 *
 * Replace-all rather than a diff because the mirror has to be **idempotent**:
 * a sync that fails leaves the face at some unknown point, and the next
 * successful write has to be able to put it right without knowing where it
 * stopped. A diff cannot promise that; this can.
 */
export function replaceInboundLifecycleHooks(
  id: string,
  hooks: LifecycleHookWrite[],
): Promise<LifecycleHooksResponse> {
  return request<LifecycleHooksResponse>(inboundHooksPath(id), {
    method: 'PUT',
    body: { hooks },
    ...inboundHookEnvelope(isHookList),
  });
}

export function createInboundLifecycleHook(
  id: string,
  body: LifecycleHookWrite,
): Promise<LifecycleHookResponse> {
  return request<LifecycleHookResponse>(inboundHooksPath(id), {
    method: 'POST',
    body,
    ...inboundHookEnvelope(isHook),
  });
}

export function updateInboundLifecycleHook(
  id: string,
  hookId: string,
  body: LifecycleHookPatch,
): Promise<LifecycleHookResponse> {
  return request<LifecycleHookResponse>(inboundHooksPath(id, `/${encodeURIComponent(hookId)}`), {
    method: 'PATCH',
    body,
    ...inboundHookEnvelope(isHook),
  });
}

export function deleteInboundLifecycleHook(id: string, hookId: string): Promise<void> {
  return request<void>(inboundHooksPath(id, `/${encodeURIComponent(hookId)}`), {
    method: 'DELETE',
    // No document: a delete answers 204 with nothing.
    ...inboundHookEnvelope(),
  });
}

export function reorderInboundLifecycleHooks(
  id: string,
  body: LifecycleHookReorder,
): Promise<LifecycleHooksResponse> {
  return request<LifecycleHooksResponse>(inboundHooksPath(id, '/reorder'), {
    method: 'POST',
    body,
    ...inboundHookEnvelope(isHookList),
  });
}

export function previewInboundLifecycleHook(
  id: string,
  hookId: string,
  body: { variables?: Record<string, unknown> },
): Promise<LifecycleHookPreviewResponse> {
  return request<LifecycleHookPreviewResponse>(
    inboundHooksPath(id, `/${encodeURIComponent(hookId)}/preview`),
    { method: 'POST', body, ...inboundHookEnvelope(isPreview) },
  );
}

/**
 * The face's own tool bindings — the list `setInboundAgentTool` writes to.
 *
 * A two-faced agent has two tool sets, and a hook on the face runs against
 * the face's. So "is this tool bound" for a face write is a question for
 * this list, never the base's: a base binding says nothing about what the
 * face can reach.
 */
export function getInboundAgentTools(id: string): Promise<AgentToolsResponse> {
  return request<AgentToolsResponse>(agentPath(id, '/inbound/tools'), {
    ...inboundToolsEnvelope(),
  });
}

/**
 * The face tools surface's refusals, passed through as themselves.
 *
 * The proxy answers a 404 INBOUND_NOT_ENABLED when the face is off and a 404
 * NOT_FOUND when the agent is not the caller's (inboundFaceProxy.ts:102-110),
 * both enveloped. Mapped by status each read as RESOURCE_NOT_FOUND — which
 * the route reports as the release not being deployed: a 501 for what is a
 * 404 about the agent.
 */
function inboundToolsEnvelope(): Pick<RequestOptions, 'passUpstreamError'> {
  return { passUpstreamError: (code) => code === 'INBOUND_NOT_ENABLED' || code === 'NOT_FOUND' };
}

/**
 * Binds a tool on the inbound face.
 *
 * The singular `/agent/` path and the ordinary envelope, matching
 * `setAgentTool` — the face's tools are the tools surface, not the hooks
 * surface, and the two families were deliberately not made to look alike.
 */
export function setInboundAgentTool(
  id: string,
  slug: string,
  body: SetAgentToolBody,
): Promise<UpstreamRecord> {
  return request<UpstreamRecord>(
    agentPath(id, `/inbound/tools/${encodeURIComponent(slug)}`),
    { method: 'PUT', body, ...inboundToolsEnvelope() },
  );
}
