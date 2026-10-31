import type { NextFunction, Request, RequestHandler, Response } from 'express';

export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'INVITE_EMAIL_MISMATCH'
  | 'ALREADY_MEMBER'
  | 'ALREADY_INVITED'
  | 'CANNOT_MODIFY_OWNER'
  | 'SLUG_TAKEN'
  | 'RATE_LIMITED'
  | 'INSUFFICIENT_CREDITS'
  | 'DUPLICATE_REFERENCE'
  | 'UPSTREAM_ERROR'
  | 'RECORDING_NOT_AVAILABLE'
  | 'AGENT_NAME_TAKEN'
  | 'NAME_TAKEN'
  // The supplier wallet already has the maximum number of unpaid payment
  // links open. Distinguished from NAME_TAKEN, which is what every other
  // upstream 409 means, because the console must show the open links.
  | 'OPEN_ORDER_LIMIT'
  // A top-up link that records a payment — credited, or paid for an amount
  // that did not match — and so cannot be removed from the listing. Its own
  // code rather than a bare 409 because the console re-renders the row with
  // the status the refusal discovered, which is usually news to the reader.
  | 'TOPUP_PAID'
  | 'AGENT_IN_USE'
  // Two direction changes raced and this one decided from a mode that has
  // since moved. Not retried for the caller: the upstream half of the losing
  // move may already have happened, so what to do next depends on where the
  // agent actually ended up.
  | 'DIRECTION_CHANGED'
  | 'AGENT_CREATED_UNASSIGNED'
  | 'UPLOAD_TOO_LARGE'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'RESOURCE_NOT_FOUND'
  | 'RESOURCE_ALREADY_MAPPED'
  | 'RESOURCE_CREATED_UNMAPPED'
  | 'HANDOVER_INCOMPLETE'
  | 'UPSTREAM_WRITE_UNCONFIRMED'
  // Distinguished from the generic UPSTREAM_ERROR because the dialer must act
  // differently on each: both are transient and account-wide, so a contact's
  // attempt is given back rather than spent, and the sweep pass halts rather
  // than collecting the identical failure from every other campaign.
  | 'UPSTREAM_FORBIDDEN'
  | 'UPSTREAM_PAYMENT_REQUIRED'
  | 'UPSTREAM_RATE_LIMITED'
  // The outbound dialer's own refusals.
  | 'DIALER_DISABLED'
  | 'CAMPAIGN_PHONE_NUMBER_REQUIRED'
  | 'CAMPAIGN_RATE_UNAVAILABLE'
  | 'CAMPAIGN_WINDOW_INCOMPLETE'
  | 'CAMPAIGN_DID_NOT_CALL_READY'
  | 'WEBHOOK_UNVERIFIED'
  | 'INSUFFICIENT_CREDITS'
  | 'PHONE_NUMBER_TAKEN'
  | 'PHONE_NUMBER_IN_USE'
  | 'TIER_NOT_PRICEABLE'
  | 'TIER_NOT_ASSIGNABLE'
  | 'INVALID_CAMPAIGN_TRANSITION'
  | 'CAMPAIGN_AGENT_REQUIRED'
  | 'CAMPAIGN_AGENT_NOT_FOUND'
  | 'CAMPAIGN_AGENT_LOCKED'
  // An INBOUND/BOTH campaign whose agent has no inbound face. Distinct from
  // CAMPAIGN_AGENT_REQUIRED (which means no usable agent at all): here the agent
  // is fine, it just cannot answer calls until inbound is enabled on it.
  // Retired 2026-09-21 with the uni/bi move: configuring an inbound campaign
  // no longer requires the agent to already have a face, because the face is
  // now created when the campaign starts. Kept in the union so a dashboard
  // still branching on it typechecks for the release the two are out of step.
  | 'CAMPAIGN_AGENT_INBOUND_NOT_ENABLED'
  // The inbound-campaign start/claim refusals (design §9).
  | 'INBOUND_DISABLED'
  | 'AGENT_INBOUND_NOT_ENABLED'
  | 'CAMPAIGN_INBOUND_DID_REQUIRED'
  | 'CAMPAIGN_INBOUND_DID_UNAVAILABLE'
  | 'CAMPAIGN_INBOUND_DID_CONFLICT'
  | 'CAMPAIGN_DID_NOT_INBOUND_READY'
  | 'CAMPAIGN_PHONE_NUMBER_NOT_FOUND'
  | 'CAMPAIGN_NEEDS_PHONE_NUMBER'
  | 'CAMPAIGN_INBOUND_NUMBERS_LOCKED'
  | 'CAMPAIGN_REQUIRES_PENDING_CONTACTS'
  | 'CAMPAIGN_CONTACTS_LOCKED'
  | 'CAMPAIGN_CALLS_IN_FLIGHT'
  | 'CAMPAIGN_CONFIG_LOCKED'
  // Browser test sessions. Each names a different thing to fix — a rate nobody
  // set, a session already running, every line busy, a retired agent — so each
  // gets its own sentence rather than one generic apology.
  | 'TEST_SESSION_RATE_UNAVAILABLE'
  | 'TEST_SESSION_IN_PROGRESS'
  | 'TEST_SESSION_UNAVAILABLE'
  | 'TEST_SESSION_STARTED_UNTRACKED'
  | 'AGENT_NOT_USABLE'
  | 'CSV_FILE_REQUIRED'
  | 'CSV_PARSE_ERROR'
  | 'CSV_PHONE_COLUMN_MISSING'
  | 'PAYLOAD_TOO_LARGE'
  | 'MALFORMED_JSON'
  // Distinct from NOT_FOUND: nothing was looked up and missed. This backend has
  // simply never registered the endpoint the platform delivers outcomes to, and
  // the remedy is setting its URL rather than correcting an id.
  | 'WEBHOOK_ENDPOINT_NOT_CONFIGURED'
  // Passed straight through from the platform, because the endpoint's contract
  // IS the upstream code rather than an HTTP status this service reinterprets:
  // the inbound enable/disable two-step (CONFIRM_REQUIRED, whose `details` name
  // the numbers and campaigns a disable would unlink) and writing the inbound
  // config before it exists (INBOUND_NOT_ENABLED). Inventing a local code for
  // either would hide the one thing the dashboard needs to render.
  | 'CONFIRM_REQUIRED'
  | 'INBOUND_NOT_ENABLED'
  // The connect-link refusals, likewise passed through wearing the platform's
  // own code (`adapter/vocobase.ts`, CONNECT_LINK_CODES). Listed so the union
  // stays an honest account of what can be thrown — but **in flight only**:
  // `integrations.routes.ts` catches every one of them and answers with a code
  // below, because none of the five is anything the reader who clicked
  // Connect can act on.
  | 'INVALID_REDIRECT_URI'
  | 'TOOL_NOT_FOUND'
  | 'TOOL_INACTIVE'
  | 'CUSTOMER_ARCHIVED'
  | 'PARTNER_MISMATCH'
  // Agent actions (pre-call and post-call lifecycle hooks).
  //
  // VALIDATION_FAILED is the platform's own, carried through with its
  // `issues` rather than flattened to VALIDATION_ERROR: the issues name the
  // exact form fields the editor drew (`input.columns[2].header`,
  // `expose_as`), and a rewritten sentence loses the only thing that says
  // which input to fix.
  //
  // NOT_CONNECTED, SHEET_NOT_CONFIGURED and TAB_NOT_FOUND are the
  // sheet-columns proxy's, also the platform's own words — each names a
  // different thing to do (connect an account, pick a spreadsheet, pick one
  // of the tabs `details.tabs` lists), and none is reconstructible from a
  // generic 502. NOT_CONNECTED is in flight only: the route answers
  // INTEGRATION_NOT_CONNECTED below.
  | 'VALIDATION_FAILED'
  | 'NOT_CONNECTED'
  | 'SHEET_NOT_CONFIGURED'
  | 'TAB_NOT_FOUND'
  // The connected Google account cannot open that spreadsheet (a wrong id, or
  // one it was never shared with), and any other Sheets failure — 429 when
  // Google is rate limiting, 502 otherwise. NOT_AUTHENTICATED is in flight
  // only: the route answers INTEGRATION_REAUTH_REQUIRED below.
  | 'SHEET_NOT_FOUND'
  | 'SHEETS_ERROR'
  | 'NOT_AUTHENTICATED'
  // A connection exists but Google rejected its stored token: somebody has
  // to reconnect it. Distinct from INTEGRATION_NOT_CONNECTED, where there is
  // no account at all, so the dashboard can say which to do.
  | 'INTEGRATION_REAUTH_REQUIRED'
  // The workspace has no Google Sheets connection behind this agent, so
  // there is no account to ask for a spreadsheet's headers. Distinct from
  // RESOURCE_NOT_FOUND: nothing is hidden, an admin simply has to connect one.
  | 'INTEGRATION_NOT_CONNECTED'
  // The platform release carrying the inbound lifecycle-hook routes has not
  // been deployed. A stated gap rather than a silent one: the base write that
  // preceded it DID happen, and the face is simply out of step until the
  // release lands and the next write re-syncs it.
  | 'INBOUND_ACTIONS_UNAVAILABLE'
  // Keeping the inbound persona on a BI → UNI move. UNAVAILABLE: the platform
  // does not carry the base replace-all route yet, so nothing was written.
  // UNREADABLE / EMPTY: there is no inbound persona worth keeping — the face
  // could not be read, or holds no prompt — so nothing was written either.
  // FIELDS_REFUSED: a face field the base's write schema will not take, so
  // keeping would have erased it; nothing was written. FAILED: the config
  // write failed and the base's own actions were put back, so nothing
  // changed. PARTIAL: the inbound actions reached the base, its configuration
  // did not, and putting them back failed too; the direction was left where
  // it was and the OUTBOUND snapshot undoes it.
  | 'KEEP_INBOUND_UNAVAILABLE'
  | 'KEEP_INBOUND_UNREADABLE'
  | 'KEEP_INBOUND_EMPTY'
  | 'KEEP_INBOUND_FIELDS_REFUSED'
  | 'KEEP_INBOUND_FAILED'
  | 'KEEP_INBOUND_PARTIAL'
  // A BI → UNI move over two sides that differ. CONFIRM_REQUIRED: no `keep`
  // or no `fingerprint` was sent, so there is no default to fall back on and
  // `details` carries the comparison to choose from. STALE: the fingerprint
  // names a comparison the agent has since moved away from, and `details`
  // carries the fresh one.
  | 'OVERWRITE_CONFIRM_REQUIRED'
  | 'DIRECTION_PREVIEW_STALE'
  // The side about to be overwritten could not be read or saved first, so
  // nothing was overwritten. An overwrite without a snapshot is the incident.
  | 'SNAPSHOT_FAILED'
  // Restoring an inbound snapshot onto an agent that has no inbound side to
  // restore it to.
  | 'RESTORE_NEEDS_BI'
  // An OUTBOUND restore writes the actions first. UNAVAILABLE: the platform
  // lacks the base replace-all route; FAILED: the actions write failed any
  // other way. Nothing but the RESTORE snapshot was written in either case.
  // PARTIAL: the actions landed and the configuration did not.
  | 'RESTORE_UNAVAILABLE'
  | 'RESTORE_FAILED'
  | 'RESTORE_PARTIAL'
  // Staff onboarding and account transfer. Each names a different thing to
  // fix — a pool resource somebody else took, a slug claimed mid-request, two
  // accounts that are one, an account with nothing to hand over — so each gets
  // its own sentence rather than one generic refusal.
  | 'AGENT_NOT_AVAILABLE'
  | 'PHONE_NUMBER_NOT_AVAILABLE'
  | 'WORKSPACE_SLUG_TAKEN'
  | 'SAME_ACCOUNT'
  | 'NO_WORKSPACES'
  | 'CONCURRENT_MODIFICATION'
  // A campaign staff cannot move right now — running, scheduled to start,
  // still holding a line, or pointed at a target that is the source itself or
  // has been deleted. One code for all four, carrying the service's own
  // sentence: the operator acts on the sentence, and four codes a console
  // renders identically buy nothing but four ways to drift apart.
  | 'CAMPAIGN_NOT_TRANSFERABLE'
  // Clerk refused or could not be reached. Distinct from UPSTREAM_ERROR, which
  // means the voice platform: the remedy is different and so is who to ask.
  | 'CLERK_ERROR'
  // Deleting a workspace. Each names a different thing the owner has to clear
  // first — a rented number, a campaign that is still live, a call on the
  // line, a test session in a browser — so each gets its own sentence and
  // carries the offending list in `details`: a flat "you cannot delete this"
  // leaves the reader hunting for what is in the way. **Nothing is
  // auto-released or auto-stopped.** Releasing a DID returns it to the shared
  // pool where anyone may rent it, which is irreversible, and stopping a
  // campaign mid-dial ends calls somebody is waiting on; neither is something
  // a button labelled Delete may do on the reader's behalf.
  | 'WORKSPACE_HAS_PHONE_NUMBERS'
  | 'WORKSPACE_HAS_LIVE_CAMPAIGNS'
  | 'WORKSPACE_HAS_CALLS_IN_FLIGHT'
  | 'WORKSPACE_HAS_ACTIVE_TEST_SESSION'
  // The connect flow's own refusals, both of which mean "not the reader's
  // fault". `INTEGRATIONS_NOT_CONFIGURED` is an ops step that was skipped in
  // this environment — most often this API's host missing from the partner
  // user's `allowedRedirectHosts` upstream. `INTEGRATION_UNAVAILABLE` is the
  // connector itself being absent or switched off on the platform. Neither is
  // something the admin who clicked Connect can act on, which is why neither
  // is a VALIDATION_ERROR.
  | 'INTEGRATIONS_NOT_CONFIGURED'
  | 'INTEGRATION_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    /**
     * Structured payload emitted alongside `error`, as a SIBLING of it — the
     * shape the platform uses for CONFIRM_REQUIRED. Only set where a caller
     * needs more than a sentence (the numbers and campaigns a disable unlinks);
     * omitted, the response is the usual `{ success, error }`.
     */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function fail(
  res: Response,
  status: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
): Response {
  const body: Record<string, unknown> = { success: false, error: { code, message } };
  // A sibling of `error`, never nested inside it — the dashboard reads it there.
  if (details !== undefined) body.details = details;
  return res.status(status).json(body);
}

/** Wraps an async handler so rejections reach the error middleware instead of hanging. */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

/**
 * Errors body-parser raises before any route runs.
 *
 * These arrive as plain `Error`s carrying a `type` and a `status`, so without
 * this they fell through to the 500 below. Both were reachable by an ordinary
 * request: the prompt this product exists to edit is allowed 120,000
 * characters, and a body that size answered "Something went wrong" — the least
 * actionable thing the service can say, about the one field that matters most.
 */
function bodyParserFailure(err: unknown): ApiError | null {
  if (!(err instanceof Error) || !('type' in err)) return null;

  switch ((err as { type?: string }).type) {
    case 'entity.too.large':
      return new ApiError(413, 'PAYLOAD_TOO_LARGE', 'That request body is too large.');
    case 'entity.parse.failed':
      return new ApiError(400, 'MALFORMED_JSON', 'That request body is not valid JSON.');
    case 'encoding.unsupported':
      return new ApiError(415, 'VALIDATION_ERROR', 'That content encoding is not supported.');
    default:
      return null;
  }
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // A response that has already started — a CSV export failing mid-stream
  // destroys its connection and rethrows — has no status line left to write a
  // body under. Log and stop; setting headers here would only add
  // ERR_HTTP_HEADERS_SENT noise on top of the real failure.
  if (res.headersSent || res.destroyed) {
    console.error('Error after the response had started:', err);
    return;
  }

  if (err instanceof ApiError) {
    fail(res, err.status, err.code, err.message, err.details);
    return;
  }

  const parsed = bodyParserFailure(err);
  if (parsed) {
    fail(res, parsed.status, parsed.code, parsed.message);
    return;
  }

  console.error('Unhandled error:', err);
  fail(res, 500, 'INTERNAL_ERROR', 'Something went wrong.');
}
