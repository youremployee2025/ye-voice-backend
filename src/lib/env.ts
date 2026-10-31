import dotenv from 'dotenv';
import { toInternalCredits } from './credits.js';
import { canonicalizeE164 } from './phone.js';

dotenv.config();

export const isTest = process.env.NODE_ENV === 'test';

/**
 * A whole non-negative number, or the fallback.
 *
 * `Number(undefined)` and `Number('sixty')` are both `NaN`, and every
 * comparison against `NaN` is false — so a typo in `ADMIN_RATE_LIMIT_MAX` did
 * not raise the cap, it removed it: `count > NaN` never fires and the limiter
 * admits everything. A misconfigured limit must be loud at boot, not silently
 * absent at runtime.
 */
function count(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(
      min > 0
        ? `${name} must be a whole number of at least ${min}; got ${JSON.stringify(raw)}`
        : `${name} must be a non-negative whole number; got ${JSON.stringify(raw)}`,
    );
  }

  return value;
}

/**
 * A URL that parses, so a malformed base is a startup failure rather than a
 * `TypeError` on the first upstream call — which surfaces as a generic 500 and
 * looks nothing like the configuration mistake it is.
 */
function url(name: string, fallback: string): string {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === '' ? fallback : raw.trim();

  try {
    new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL; got ${JSON.stringify(raw)}`);
  }

  return value;
}

/**
 * A URL that is required as well as well-formed. `url()` substitutes its
 * fallback when the variable is unset, which is right for an endpoint with a
 * sensible default and wrong for one documented as load-bearing: an unset
 * value must be a startup failure, not a silent `localhost` that boots green
 * and does nothing. Under test it yields `''`, the same softening `required()`
 * applies, so the suite (which always sets the variable in `test/setup.ts`)
 * can exercise the missing case without the throw.
 */
function requiredUrl(name: string): string {
  const raw = process.env[name];
  const value = raw === undefined ? '' : raw.trim();

  if (value === '') {
    if (isTest) return '';
    throw new Error(`Missing required environment variable: ${name}`);
  }

  try {
    new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL; got ${JSON.stringify(raw)}`);
  }

  return value;
}

/**
 * An origin that only matters where the voice platform integration is
 * configured — the public API origin the hosted OAuth flow redirects back to.
 *
 * Neither optional nor unconditionally required. A deployment with no partner
 * key cannot mint a connect link at all, so demanding its public origin would
 * refuse to start a configuration that is entirely valid; a deployment that
 * *has* one and omits this would mint links pointing at `undefined` and only
 * find out when an admin clicked Connect. So the key decides.
 *
 * Softened under test the way `required()` and `requiredUrl()` are, so the
 * adapter suites — which set a partner key to exercise the client — do not
 * each have to set an origin they never use.
 *
 * The trailing slash is dropped because the return URL is built by
 * concatenation: `https://api.example.com//integrations/...` is a different
 * path, and one that would not match what an operator allow-listed upstream.
 */
function integrationUrl(name: string): string {
  const raw = process.env[name];
  const value = raw === undefined ? '' : raw.trim();

  if (value === '') {
    if (isTest || !process.env.VOCOBASE_API_KEY?.trim()) return '';
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        'It is required whenever VOCOBASE_API_KEY is set — the hosted OAuth flow redirects back to it.',
    );
  }

  try {
    new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL; got ${JSON.stringify(raw)}`);
  }

  return value.replace(/\/$/, '');
}

/**
 * A signing secret: absent, or long enough to be worth having.
 *
 * Empty fails closed — nothing verifies, so the feature is simply off. A short
 * value fails *open*, which is worse and looks fine: one legitimately minted
 * token is an offline oracle, and a recovered secret forges tokens for any
 * pair of ids the attacker can name, including on a workspace they have since
 * been removed from. There is no reading of `SECRET=dev` that should boot.
 */
function secret(name: string, minLength: number): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return '';

  const value = raw.trim();
  if (value.length < minLength) {
    throw new Error(
      `${name} must be at least ${minLength} characters, or unset to disable the feature it signs; got ${value.length}`,
    );
  }

  return value;
}

/**
 * A boolean switch, spelled exactly.
 *
 * Only `true` and `false` (any case) are accepted; empty falls back. Anything
 * else throws.
 *
 * A permissive parser is the wrong shape for a safety control. Read loosely,
 * `DIALER_ENABLED=yes` is either false — a switch that is off while the
 * operator believes it is on — or true, which is worse. Neither reading is
 * defensible, so neither is offered, and the operator learns at boot.
 */
function flag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const value = raw.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;

  throw new Error(`${name} must be exactly "true" or "false"; got ${JSON.stringify(raw)}`);
}

/**
 * A comma-separated list of phone numbers, canonicalized at boot.
 *
 * Parsed here rather than at the point of use because this is the control that
 * bounds a live test to the operator's own handsets. A malformed entry that
 * silently never matched would look exactly like the allowlist working —
 * right up until it was believed and taken out.
 *
 * Returns a Set of canonical E.164 strings, so `+91 98765 43210` and
 * `+919876543210` are one entry and a membership test is an exact match
 * against an already-canonical contact number.
 */
function e164List(name: string): ReadonlySet<string> {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return new Set();

  const numbers = new Set<string>();

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;

    const canonical = canonicalizeE164(trimmed);
    if (!canonical) {
      throw new Error(
        `${name} must be a comma-separated list of E.164 phone numbers; ` +
          `${JSON.stringify(trimmed)} is not one.`,
      );
    }

    numbers.add(canonical);
  }

  return numbers;
}

/**
 * A credit amount, validated through the same parser that reads a price off
 * the wire, so a malformed one cannot reach a charge.
 */
function creditAmount(name: string, fallback: string): bigint {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === '' ? fallback : raw.trim();

  try {
    return toInternalCredits(value);
  } catch {
    throw new Error(`${name} must be a non-negative credit amount; got ${JSON.stringify(raw)}`);
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    if (isTest) return '';
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * A comma-separated list of browser origins, for `CORS_ORIGIN`.
 *
 * A list because a dashboard can live at more than one address while one of
 * them is retired, and `cors()` only allows several when handed an ARRAY: a
 * string is echoed back verbatim, so `https://a,https://b` became an
 * `Access-Control-Allow-Origin` naming two origins, which every browser
 * refuses — for both dashboards at once.
 *
 * Each entry is trimmed and loses a trailing slash, because a browser's
 * `Origin` never carries one and the comparison is exact. Blank entries from a
 * stray comma are dropped. An empty result falls back, never to `[]`: an empty
 * allow-list would refuse every browser while the service looked healthy.
 */
function originList(name: string, fallback: string): string[] {
  const origins = (process.env[name] ?? '')
    .split(',')
    .map((entry) => entry.trim().replace(/\/$/, ''))
    .filter((entry) => entry !== '');
  return origins.length > 0 ? origins : [fallback];
}

const corsOrigins = originList('CORS_ORIGIN', 'http://localhost:3000');

/**
 * Whether this process runs the background workers.
 *
 * Three states rather than one, because the two kinds of "test" want opposite
 * things and conflating them makes one of them impossible.
 *
 * **Under vitest, never.** `VITEST` is set by the runner itself and cannot be
 * talked out of it here: no environment variable overrides this branch. A unit
 * suite that spun up a dispatch worker would place real calls against whatever
 * Redis it found, and the failure would look like a flaky test rather than a
 * phone bill. This is the one gate in this file that is not a preference.
 *
 * **Under `NODE_ENV=test` without vitest, off unless asked.** That combination
 * is the battle harness, which needs `NODE_ENV=test` for the header-auth path
 * and needs real workers to be worth running at all. It says so explicitly
 * with `WORKERS_ENABLED=true`; anything else that happens to set `NODE_ENV`
 * gets the safe default.
 *
 * **Otherwise, the flag, defaulting to true.** A single-process deployment is
 * exactly what it was.
 */
function resolveWorkersEnabled(): boolean {
  if (process.env.VITEST) return false;
  if (isTest) return flag('WORKERS_ENABLED', false);

  return flag('WORKERS_ENABLED', true);
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: count('PORT', 3001),
  databaseUrl: required('DATABASE_URL'),
  clerkSecretKey: required('CLERK_SECRET_KEY'),
  clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY ?? '',
  /** Every dashboard origin a browser may call this service from. */
  corsOrigins,
  /**
   * Where the dashboard lives, for the redirects this service sends a browser
   * to — the end of the Google connect flow — and the links the CSV exports
   * print. The FIRST of `corsOrigins`: a browser can be sent to one place
   * only, so with a second dashboard still allowed during a move, the first
   * entry is the one people are sent to.
   *
   * Deliberately **not a second variable**. `CORS_ORIGIN` already names the
   * dashboard origin and is already read as one (the CSV export links are
   * built from it), so a `DASHBOARD_URL` beside it would be one more thing to
   * set on a deploy and two values that disagree the first time only one of
   * them was updated. The alias exists so the connect flow reads as what it
   * is rather than as a CORS setting being borrowed.
   *
   * The trailing slash goes for the reason it goes on `publicApiUrl`: the
   * redirect is built by concatenation.
   */
  dashboardUrl: corsOrigins[0],
  /**
   * This service's own public origin — the half of the connect flow the
   * platform redirects back to, and the value that must appear on the partner
   * user's `allowedRedirectHosts` upstream before any of it works. See
   * `docs/deploy.md`.
   */
  publicApiUrl: integrationUrl('PUBLIC_API_URL'),
  // Optional at boot: a missing partner key must fail on the call that needs
  // it, not stop the whole service from starting.
  vocobaseApiKey: process.env.VOCOBASE_API_KEY ?? '',
  vocobaseApiUrl: url('VOCOBASE_API_URL', 'https://api.vocobase.com/api/v2'),
  /**
   * Which VoiceLink connection the DID sync reads, when the partner account
   * holds more than one. Optional: with a single connection upstream resolves
   * it alone, and requiring this would break the deployment that has always
   * worked. With several, upstream refuses to guess — so this must name one,
   * or the sync fails with upstream's own message saying exactly that.
   */
  vocobaseVoicelinkConnectionId: process.env.VOCOBASE_VOICELINK_CONNECTION_ID ?? '',
  /**
   * How often the agent mirror is refreshed from the platform.
   *
   * Not gated on a switch, unlike the dialer and analytics sweeps. Those spend
   * something — a call, or a walk of the shared call listing. This one reads
   * the agent pool and writes locally, and a stale mirror is wrong in every
   * configuration: `Agent.variables` is the platform's, recomputed there
   * whenever a prompt changes, and an agent edited anywhere except through
   * this backend's own PATCH leaves the local copy stale forever. The CSV
   * column mapper offers variables out of that copy, so stale reads as "this
   * agent has no variables" and a column cannot be mapped onto one.
   *
   * Floored at a minute for the reason every sweep here is: `setInterval(fn, 0)`
   * is clamped to about a millisecond, and this one walks a paged upstream
   * listing every pass.
   */
  agentSyncIntervalMs: count('AGENT_SYNC_INTERVAL_MS', 900_000, 60_000),
  /**
   * The supplier wallet balance, in rupees, under which the staff console
   * says "critically low" on every page. Every campaign on the platform halts
   * on CREDIT_EXHAUSTED when it reaches zero, so the number is chosen to leave
   * time to top up, not to be exact.
   */
  walletLowBalanceInr: count('WALLET_LOW_BALANCE_INR', 25_000),
  /**
   * How often open payment links are re-read from the supplier. There is no
   * callback for a paid link; this and the console's own 30-second poll are
   * the only ways a payment becomes visible. Floored at thirty seconds.
   */
  walletTopupPollMs: count('WALLET_TOPUP_POLL_MS', 120_000, 30_000),
  /**
   * Whether the DID sync provisions a number the moment it imports it.
   *
   * **On by default**, because the alternative is the state this replaced: a
   * number sitting in the inventory, offered in a picker, and refusing at dial
   * time with an error about VoiceLink rather than about itself. Importing a
   * DID and being able to call from it should be one fact.
   *
   * It is a switch rather than a constant because it is the one part of the
   * sync that *writes* to the telephony account — the rest of that module is a
   * paged read, and its header says so. A deployment that provisions its
   * numbers by hand, or one sharing a partner account where that is somebody
   * else's job, turns this off and gets the old read-only sweep back.
   *
   * Read through the same strict `flag()` as the dialer switch: a control over
   * writes to a live telephony account is the wrong place for a parser that
   * quietly reads `yes` as false.
   */
  voicelinkAutoCallReady: flag('VOICELINK_AUTO_CALL_READY', true),
  adminStaffToken: process.env.ADMIN_STAFF_TOKEN ?? '',
  /**
   * Signs the short-lived tokens that let an <audio> element fetch a
   * recording, which cannot send an Authorization header.
   *
   * Optional at boot and empty by default, which makes every token invalid —
   * recordings simply do not play until it is set. A missing secret must not
   * mean an open door, and it must not stop the service starting either.
   *
   * Set, it has a floor. Absent is a closed door; short is an open one that
   * looks shut. Generate with `openssl rand -hex 32`.
   */
  recordingTokenSecret: secret('RECORDING_TOKEN_SECRET', 32),
  /**
   * Fallback monthly rental price, in DISPLAY credits, for a DID staff have
   * not priced individually.
   *
   * Validated at boot rather than at rental time. A typo here is a wrong
   * charge on every unpriced number, and the moment to find that out is
   * startup — not the first customer's invoice.
   */
  didDefaultMonthlyPriceCredits: creditAmount('DID_DEFAULT_MONTHLY_PRICE_CREDITS', '500'),
  /**
   * Renewal sweep period. Read only by `server.ts`.
   *
   * Floored at a minute. `0` used to pass validation, and `setInterval(fn, 0)`
   * is clamped to ~1ms — roughly a thousand overlapping sweeps a second, each
   * opening transactions against a shared pool. The compare-and-set keeps that
   * correct; it does not keep it survivable.
   */
  didRenewalSweepMs: count('DID_RENEWAL_SWEEP_MS', 3_600_000, 60_000),
  /**
   * How long a workspace keeps a DID after a renewal charge is declined.
   *
   * Measured from the first decline, not the last attempt, so retries cannot
   * push the deadline away. Zero means release on the first decline, which is
   * the behaviour this replaced — allowed, but it has to be asked for.
   */
  didGraceDays: count('DID_GRACE_DAYS', 7),
  /**
   * Most DIDs one sweep pass may release for non-payment before it stops.
   *
   * A blast radius limit, not a throttle. The realistic cause of a mass
   * release is a pricing mistake that made every workspace insolvent at once,
   * and in that case the right behaviour is to stop and be noticed rather than
   * to work through the whole platform correctly.
   */
  didMaxReleasesPerSweep: count('DID_MAX_RELEASES_PER_SWEEP', 25),
  /**
   * Staff requests permitted per minute, per address.
   *
   * Loose, and deliberately: the staff console renders on its own server, so
   * every operator's every page load arrives from one address and shares one
   * budget. A cap sized for "a handful of requests a day" was a cap the
   * console spent on itself. Guessing is capped by
   * `ADMIN_AUTH_FAILURE_MAX` below, which is the number that needs to be
   * small; this one only needs to be finite.
   */
  adminRateLimitMax: count('ADMIN_RATE_LIMIT_MAX', 600),
  /**
   * Rejected staff tokens permitted per minute, per address, before that
   * address is turned away entirely for the rest of the window.
   *
   * This is the anti-guessing cap. Staff who paste a token wrong twice are
   * well inside it; anyone working through a keyspace is not.
   */
  adminAuthFailureMax: count('ADMIN_AUTH_FAILURE_MAX', 10),
  /**
   * Per-workspace ceilings on the call-history surface, in requests per
   * minute.
   *
   * Tunable for the same reason the staff cap is: what these protect is this
   * platform's share of a rate limit every customer of the voice platform
   * shares, and that ceiling is the supplier's to change. Finding out it moved
   * should not require a deploy.
   *
   * The listing is lowest because one request costs up to twenty upstream
   * reads. Playback is highest because seeking is bursty and every Range
   * request in a scrub is a real one.
   */
  callListRateLimitMax: count('CALL_LIST_RATE_LIMIT_MAX', 30, 1),
  callDetailRateLimitMax: count('CALL_DETAIL_RATE_LIMIT_MAX', 120, 1),
  callRecordingRateLimitMax: count('CALL_RECORDING_RATE_LIMIT_MAX', 240, 1),
  adminRateLimitWindowMs: count('ADMIN_RATE_LIMIT_WINDOW_MS', 60_000),
  /**
   * The master switch on the outbound dialer. Default **false**.
   *
   * Off, `server.ts` starts no sweep, `start`/`resume` refuse with
   * `DIALER_DISABLED`, and the module cannot ring a phone in any environment.
   * This is the one control that is sufficient on its own, and it is the one
   * that must be turned on deliberately rather than inherited from a default.
   */
  dialerEnabled: flag('DIALER_ENABLED', false),
  /**
   * Inbound calling's deployment kill switch, the shape `dialerEnabled` has.
   * Off by default and turned on deliberately: an INBOUND/BOTH campaign refuses
   * to start while it is off, so provisioning inbound routing on the shared
   * partner account never happens by inheriting a default.
   */
  inboundEnabled: flag('INBOUND_ENABLED', false),
  /**
   * Whether a call the model reports as dropped mid-conversation is resumed
   * on the three-minute RESUME lane. Off by default since 2026-09-08: the
   * `immediate_callback_needed` extraction over-reports drops — one- and
   * two-second calls come back flagged — and every wrong "yes" was a dial
   * three minutes later on a line that was never a conversation. Off, a
   * reported drop is an ordinary follow-up on the retry ladder, in the
   * FOLLOW_UP lane, and nothing rings sooner than a retry would. Contacts
   * already armed RESUME are left as they are: the lane still claims them.
   */
  immediateResumeEnabled: flag('IMMEDIATE_RESUME_ENABLED', false),
  /**
   * Sweep period — now the repeat interval of the `campaign-dispatch` job.
   *
   * A minute remains the default, and deliberately so. It is not a number
   * chosen for responsiveness: it is the rate at which this platform asks a
   * partner API, shared with every other integrator, to start calls. Moving
   * the queue underneath the sweep is a scheduling change and must not become
   * a pacing change.
   *
   * Floored at a **second** rather than a minute. The floor was never about a
   * minute being right — it was about `setInterval(fn, 0)` being clamped to
   * ~1ms, which is a thousand passes a second each able to place calls. A
   * second preserves that protection exactly, and lets the battle harness
   * drive a fast tick without a special case in production code.
   */
  dialerSweepMs: count('DIALER_SWEEP_MS', 60_000, 1_000),
  /**
   * Most calls one pass may place, across every campaign on the platform.
   *
   * A blast-radius limit rather than a throughput setting, exactly as
   * `DID_MAX_RELEASES_PER_SWEEP` is. Whatever goes wrong, it goes wrong this
   * many times before a human could notice.
   */
  dialerMaxCallsPerSweep: count('DIALER_MAX_CALLS_PER_SWEEP', 25, 1),
  /**
   * How often the schedule scanner looks for a campaign whose start time has
   * passed. Read only by `server.ts`.
   *
   * Thirty seconds is both the default and the floor. It bounds how late a
   * scheduled start can be, which is the only thing this number controls — and
   * the floor exists for the dialer sweep's reason: `setInterval(fn, 0)` is
   * clamped to about a millisecond, and here that would be a thousand passes a
   * second, each able to start a campaign that places calls.
   */
  scheduleScanMs: count('SCHEDULE_SCAN_MS', 30_000, 30_000),
  /**
   * Simultaneous calls an account may place when staff have not allotted it a
   * number of its own.
   *
   * The catalog default, in the same sense `DID_DEFAULT_MONTHLY_PRICE_CREDITS`
   * is: it prices future accounts and never reaches one staff have set
   * explicitly. Set it to `0` to make an unallotted account unable to dial at
   * all, which is the fail-closed posture for a platform that wants every
   * allotment to be a deliberate act.
   */
  dialerDefaultAccountConcurrency: count('DIALER_DEFAULT_ACCOUNT_CONCURRENCY', 2),
  /**
   * The balance a workspace owner must hold before their campaign may place
   * another call, in DISPLAY credits.
   *
   * Calls are charged minutes after they are dialed, so this float is the only
   * thing between a campaign and a queue of calls its owner cannot pay for.
   * A campaign whose owner falls below it is paused rather than dialed into
   * debt.
   */
  dialerMinBalanceCredits: creditAmount('DIALER_MIN_BALANCE_CREDITS', '1'),
  /**
   * How long an attempt may stay non-terminal before the reaper reconciles it
   * against the platform's own record.
   *
   * Not a timeout on the call — the platform owns that. This is a timeout on
   * our knowledge of it, and it exists because a webhook that never arrives
   * would otherwise hold a line forever.
   *
   * **Keep it above the platform's own pending-call reap window** (30 minutes
   * as of 2026-09-07, `PENDING_CALL_TIMEOUT_SECS` there). The platform reaps a
   * call that never connected and reports `error_code: PENDING_TIMEOUT`, which
   * hands the contact back at no cost to its ladder. Set below that window,
   * `closeStaleAttempts` abandons the attempt first as an unknown outcome — a
   * retryable silence that consumes a retry — and the platform's later verdict
   * finds the attempt already closed.
   */
  dialerAttemptTimeoutMins: count('DIALER_ATTEMPT_TIMEOUT_MINS', 60, 1),

  /**
   * The hard ceiling on one browser test session, in seconds.
   *
   * Three jobs, deliberately one number: the browser disconnects at it, the
   * start gate requires a balance that covers it, and the reaper treats an
   * `ACTIVE` row far past it as abandoned. Three numbers would eventually
   * disagree, and the disagreement is a session billed past what the customer
   * was told it could cost. It reaches the browser in the start response
   * rather than as a public build-time value, so the two cannot drift.
   *
   * The platform's `POST /sessions/webrtc` accepts no duration parameter, so
   * this is the ONLY cap there is. It is not enforced upstream.
   */
  testSessionMaxSecs: count('TEST_SESSION_MAX_SECS', 300, 30),
  /**
   * Live test sessions across the WHOLE platform, not per workspace.
   *
   * Every test takes a line from the same concurrency pool the dialer runs on,
   * and the platform's default allotment is five. The per-workspace cap is one
   * — a partial unique index on `TestSession` — but that alone bounds nothing
   * useful: enough workspaces testing at once would starve outbound dialing
   * with no campaign doing anything wrong and nothing on any screen saying
   * why. This is the ceiling that stops it.
   *
   * Minimum one. Zero reads as an off switch and is not one: the feature would
   * stay reachable and refuse every start with a message about busy lines,
   * which is a misconfiguration nobody could diagnose from the symptom.
   */
  testSessionMaxConcurrent: count('TEST_SESSION_MAX_CONCURRENT', 2, 1),
  /**
   * How long an `ACTIVE` test session may sit before the reaper asks the
   * platform what became of it.
   *
   * The same kind of value `DIALER_ATTEMPT_TIMEOUT_MINS` is, and for the same
   * reason: a completion event that never arrives would otherwise leave a
   * workspace's one slot held forever, and the Test button refusing with
   * "already running" when nothing is.
   */
  testSessionTimeoutMins: count('TEST_SESSION_TIMEOUT_MINS', 15, 1),
  /**
   * While non-empty, the ONLY numbers this deployment may dial.
   *
   * Empty is the production posture and means no restriction — not "allow
   * nothing". Non-empty is how a first live test is bounded to the operator's
   * own handsets: every other contact is skipped, counted and logged, and is
   * never claimed or marked excluded.
   */
  dialerTestAllowlist: e164List('DIALER_TEST_ALLOWLIST'),
  /**
   * Signs the webhooks the voice platform delivers to `/webhooks/vocobase`.
   *
   * Per-endpoint, issued once when the endpoint is registered and never shown
   * again. Unset makes every delivery fail verification, which is the same
   * fail-closed rule `RECORDING_TOKEN_SECRET` and `ADMIN_STAFF_TOKEN` hold: a
   * missing secret must never mean an open door, and must not stop the service
   * starting either. Short fails OPEN while looking fine, so it has a floor.
   */
  vocobaseWebhookSecret: secret('VOCOBASE_WEBHOOK_SECRET', 32),
  /**
   * The secret being rotated *out*, accepted alongside the current one.
   *
   * The platform shows a secret once and never again, so a rotation is: mint
   * upstream, write the new value here, restart. Deliveries signed before the
   * restart carry the old one, and this endpoint closes call attempts and
   * charges credits — a delivery dropped here holds a line open until the
   * reaper finds it and turns a charge into a late one or a missing one.
   *
   * Same floor as the main secret and read through the same helper, because it
   * is the same kind of value with the same failure mode. It never stands on
   * its own: with the main secret unset, verification refuses everything, so a
   * half-finished rotation is a closed door rather than a quietly open one.
   *
   * Clear it once the old secret can no longer be in flight. The runbook is in
   * `.env.example` and in CLAUDE.md's Environment section.
   */
  vocobaseWebhookSecretPrevious: secret('VOCOBASE_WEBHOOK_SECRET_PREVIOUS', 32),
  /**
   * Signs the inbound routing-policy callback the platform makes before it
   * creates a session. A sibling of `vocobaseWebhookSecret` — same HMAC shape,
   * same fail-closed floor — but its OWN secret and header, so the routing
   * verifier and the outcome-webhook verifier cannot be confused for each
   * other. Unset makes every routing callback fail verification.
   */
  inboundRoutePolicySecret: secret('INBOUND_ROUTE_POLICY_SECRET', 32),
  /**
   * Proxy hops in front of this service, for `req.ip`.
   *
   * Must be set deliberately in both directions. At 0 behind an ingress every
   * caller shares the proxy's address, so the admin limiter's budget becomes
   * global and one stranger can spend it and lock staff out. Trusting the
   * header without a hop count is worse: `X-Forwarded-For` is then
   * caller-supplied and the limiter is bypassed by rotating it. The hop count
   * is the only setting that is neither.
   */
  trustProxyHops: count('TRUST_PROXY_HOPS', 0),
  /**
   * Whether the analytics ingest runs on a timer.
   *
   * **Off by default, including in tests.** The worker walks the platform's
   * call listing against a rate limit every customer of that platform shares,
   * so it is switched on per deployment rather than inherited by anything that
   * happens to import this module. `server.ts` is the only reader, and a test
   * that builds the app must not start a timer that reads the partner account.
   *
   * The manual refresh route is not gated on this: an operator asking for a
   * pass has asked for one, and refusing them because the timer is off would
   * leave a workspace with no way to fill its own charts.
   *
   * Read through the same strict `flag()` the dialer switch uses — exactly
   * `true` or `false`, anything else throws at boot. A permissive parser is the
   * wrong shape for a switch that spends a shared upstream budget.
   */
  analyticsSyncEnabled: flag('ANALYTICS_SYNC_ENABLED', false),
  /**
   * How often that pass runs.
   *
   * Floored at a minute, for the renewal sweep's reason: `setInterval(fn, 0)`
   * is clamped to ~1ms, and every pass opens transactions and spends upstream
   * reads. Five minutes is the default because a fact table feeding charts is
   * not a live feed — the freshness a reader actually notices is measured in
   * minutes, and the cost of each pass is paid by every workspace.
   */
  analyticsSyncIntervalMs: count('ANALYTICS_SYNC_INTERVAL_MS', 300_000, 60_000),
  /**
   * Upstream pages one pass may read, at 100 calls each.
   *
   * A ceiling rather than a target. Steady state is a page or two — everything
   * since the last pass — and the budget only binds on the first pass, which
   * seeds the table. Floored at 1: at zero the worker runs forever and ingests
   * nothing, which reads as an empty product rather than as a misconfiguration.
   */
  analyticsSyncMaxPages: count('ANALYTICS_SYNC_MAX_PAGES', 20, 1),
  /**
   * How far back below the high-water mark each pass re-reads, in minutes.
   *
   * Not paranoia: upstream offsets are computed against a list that grows
   * while it is being walked, so a call placed mid-pass shifts every row down
   * one and a page boundary read after the shift skips the row that crossed
   * it. Re-reading a few minutes of already-ingested calls costs one page and
   * closes that window; the unique key on `upstreamCallId` makes the re-read
   * free of consequence.
   *
   * 0 is legal and means no overlap — allowed, but it has to be asked for.
   */
  analyticsSyncOverlapMins: count('ANALYTICS_SYNC_OVERLAP_MINS', 10, 0),
  /**
   * Manual analytics refreshes permitted per minute, per workspace.
   *
   * Small, because a refresh is one workspace's page spending the partner
   * account's ingest budget on behalf of the whole platform. Keyed on the
   * workspace rather than the caller, or its admins multiply it between them.
   */
  analyticsRefreshRateLimitMax: count('ANALYTICS_REFRESH_RATE_LIMIT_MAX', 4, 1),
  /**
   * Whether **this** process runs the background timers.
   *
   * The opposite default to every other switch here, and deliberately so: this
   * one decides *where* the workers run, not *whether* anything may happen. Off
   * by default it would silently stop the renewal sweep on every existing
   * single-process deployment — money that quietly stops being collected, with
   * nothing in a log saying why. So true unless a deployment says otherwise,
   * and `false` is how an API process runs timer-free beside a `worker.ts`.
   *
   * It is not a safety control and must never be read as one. `DIALER_ENABLED`,
   * the allowlist and the two concurrency caps still decide whether a call is
   * placed; this only decides which process asks.
   *
   * Read through the same strict `flag()` regardless, because a switch that
   * silently means its opposite is the failure mode being avoided everywhere
   * else in this file.
   *
   * The test-environment behaviour is not a plain `flag()` call — see
   * `resolveWorkersEnabled` above for why vitest gets a hard no and the battle
   * harness gets an explicit yes.
   */
  workersEnabled: resolveWorkersEnabled(),
  /**
   * Where the queues live.
   *
   * Load-bearing from this wave on: every piece of background work — the dial
   * sweep, call placement, the cleanup sweep, the maintenance sweeps, webhook
   * processing — is scheduled through BullMQ over this connection. A
   * deployment that cannot reach Redis does no background work at all. That is
   * the trade for being able to run more than one instance.
   *
   * Parsed through `requiredUrl()` so a missing value and a malformed value
   * are both startup failures rather than a connection that retries forever
   * behind a healthy-looking HTTP port. `url()`'s fallback would boot a
   * deployment that omitted the variable straight into that state, pointed at
   * a localhost Redis that does not exist.
   */
  redisUrl: requiredUrl('REDIS_URL'),
  /**
   * How often the cleanup job reconciles contacts and attempts that an
   * instance claimed and then died holding.
   *
   * The dial sweep already calls the reaper on its own cadence; this is the
   * second caller, and it exists for the one case the first cannot cover — the
   * process that was going to run it is gone. Five minutes bounds how long a
   * killed instance's claims sit before another instance frees them.
   */
  campaignCleanupMs: count('CAMPAIGN_CLEANUP_MS', 300_000, 10_000),
  /**
   * Logging, and where it ships.
   *
   * All optional. Unset means structured JSON on stdout and no shipping,
   * which is a complete configuration rather than a degraded one — logging
   * must never be able to stop this service from starting, so none of these
   * is validated here and none of them throws.
   *
   * Recorded on this object because it is where the environment surface is
   * documented, but **`logger.ts` does not read them from here**. It is
   * imported before this module — that is what lets the console override
   * reach every call site — so it loads `.env` and reads `process.env`
   * itself. Changing that ordering is what silently stops logs reaching
   * Axiom, so the duplication is deliberate.
   */
  logLevel: process.env.LOG_LEVEL ?? '',
  axiomToken: process.env.AXIOM_TOKEN ?? '',
  axiomDataset: process.env.AXIOM_DATASET ?? '',
  axiomEdge: process.env.AXIOM_EDGE ?? '',
};
