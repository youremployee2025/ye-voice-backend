/**
 * Structured logging: Pino to stdout, and to Axiom when it is configured.
 *
 * Import this module before anything that logs. Importing it:
 *   1. builds the configured logger,
 *   2. routes the existing `console.*` calls through it, so every call site in
 *      the codebase becomes structured without being rewritten,
 *   3. exports the `pino-http` middleware `app.ts` mounts.
 *
 * ## Redaction
 *
 * This product handles recorded calls for real people, so the redaction here
 * is a requirement rather than hygiene. It works in two layers, because one is
 * not enough:
 *
 * - **By key name** (`SENSITIVE_KEYS` below, plus pino's own `redact.paths`).
 *   Catches structured fields — a header, a webhook body, an extraction map.
 * - **By content** (`maskPhones`). Catches what the first layer structurally
 *   cannot: a number interpolated into a message string or a query parameter.
 *   `console.warn(`Could not mirror DID ${did}`)` produces one string, and no
 *   field-path matcher will ever see a field in it.
 *
 * The second layer exists because of a real leak of exactly that shape: a
 * request log line carrying `?from=919484957112` in `req.url`. The path-based
 * matcher had nothing to match.
 */

import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import pino from 'pino';
import { pinoHttp } from 'pino-http';

/**
 * Load `.env` here rather than relying on `env.ts` having done it.
 *
 * This module is imported first, before anything that logs — which means
 * before `env.ts`, which is where `dotenv.config()` otherwise runs. Reading
 * `process.env.AXIOM_TOKEN` at this point would find nothing, print the
 * "not configured" warning and ship to stdout only, on a deployment that had
 * configured Axiom perfectly well. Nothing would look broken; the logs would
 * simply never arrive.
 *
 * `config()` does not overwrite a variable that is already set, so the second
 * call in `env.ts` is a no-op and a real environment always wins over the file.
 */
dotenv.config();

const SERVICE_NAME = 'ye-voice-backend';
const CENSOR = '[Redacted]';

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProduction = nodeEnv === 'production';
const isTest = nodeEnv === 'test';

/**
 * Silent under test by default.
 *
 * Two reasons, both practical. A transport spawns a worker thread per target,
 * and vitest tears a worker down per file — a hundred of those is startup cost
 * for output nobody reads. And the suite has cases that assert on console
 * output; a logger writing over them would break tests that have nothing to do
 * with logging. `LOG_LEVEL` still overrides, for debugging one file.
 */
const logLevel =
  process.env.LOG_LEVEL || (isTest ? 'silent' : isProduction ? 'info' : 'debug');

// ---------------------------------------------------------------------------
// Content-based masking
// ---------------------------------------------------------------------------

/**
 * A `+`-prefixed number, tolerating the separators people and spreadsheets
 * write: `+1 (415) 555-0142`. Validated by digit count in the replacer rather
 * than by the pattern, so a near-miss is left alone instead of half-masked.
 */
const E164_CANDIDATE = /\+[\d(][\d\s().-]{5,20}\d/g;

/**
 * A bare run of phone-length digits — an E.164 number that lost its `+`, which
 * is how they arrive in query strings and provider payloads.
 *
 * The lookarounds are what keep this from eating identifiers: a run inside a
 * cuid (`cmb2xk9q0000abcd1234`) is adjacent to word characters on at least one
 * side, and a run of fewer than ten digits is a count, a port, a status code
 * or a credit amount.
 *
 * It is deliberately blunt at the edges. A 13-digit epoch-millisecond value
 * logged bare would also be masked. That trade is taken knowingly: this
 * codebase logs times as ISO strings, and over-masking a timestamp costs a
 * debugging convenience while under-masking a number costs a person's privacy.
 */
const BARE_CANDIDATE = /(?<![\w+*])\d{10,15}(?![\w])/g;

/** Digits, all but the last four replaced one-for-one. */
function maskDigits(digits: string): string {
  return '*'.repeat(Math.max(digits.length - 4, 0)) + digits.slice(-4);
}

/**
 * Mask phone-shaped runs in free text, keeping the last four digits so a
 * number stays recognisable to whoever is reading the log without being
 * readable as a number.
 *
 * Separators inside a match are dropped, so one number has one masked form
 * however it was written upstream.
 */
export function maskPhones(text: string): string {
  return text
    .replace(E164_CANDIDATE, (match) => {
      const digits = match.replace(/\D/g, '');
      if (digits.length < 8 || digits.length > 15) return match;
      return `+${maskDigits(digits)}`;
    })
    .replace(BARE_CANDIDATE, (match) => maskDigits(match));
}

// ---------------------------------------------------------------------------
// Key-based masking
// ---------------------------------------------------------------------------

/** `recording_url`, `recordingUrl` and `Recording-URL` are one key here. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

/**
 * Keys whose value never reaches a log, whatever its type.
 *
 * `name` is deliberately absent: a campaign, agent and workspace all have one,
 * none of them is a person, and redacting all three would leave the logs
 * unreadable for no privacy gained. The person-shaped variants are listed
 * individually instead.
 */
const SENSITIVE_KEYS = new Set([
  // Telephony identity
  'phone',
  'phonenumber',
  'mobile',
  'msisdn',
  'did',
  'dids',
  'tonumber',
  'fromnumber',
  'callernumber',
  'callerid',
  'contactnumber',
  // What was said
  'transcript',
  'transcripts',
  'utterance',
  'utterances',
  // What was extracted from what was said
  'extraction',
  'extractionvalue',
  'extractionvalues',
  'extractedvalues',
  // Pre-call variables carry whatever the caller merged in about the contact
  'variables',
  // Where the recording lives — the url is the credential
  'recordingurl',
  'recordingurls',
  'mediaurl',
  // Request identity
  'authorization',
  'cookie',
  'setcookie',
  // Person
  'email',
  'emailaddress',
  'customername',
  'contactname',
  'fullname',
  'firstname',
  'lastname',
]);

/**
 * Substrings that make a key sensitive wherever they appear, so a field added
 * later is covered by being named honestly: `vocobaseApiKey`,
 * `webhookSecret`, `x-webhook-signature`, `adminStaffToken`.
 */
const SENSITIVE_FRAGMENTS = ['token', 'secret', 'signature', 'apikey', 'password', 'credential'];

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SENSITIVE_KEYS.has(normalized)) return true;
  return SENSITIVE_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/**
 * Only plain objects and arrays are walked.
 *
 * Anything else — an `IncomingMessage`, an `Error`, a `Buffer`, a `Date`, a
 * Prisma model instance — is passed through for pino's serializers to handle.
 * Walking those would be pointless at best: `req` alone is a deep, circular
 * object graph, and rebuilding it as a plain object is how a request logger
 * turns into a memory problem.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/** Bounds, so one enormous argument cannot dominate a request. */
const MAX_DEPTH = 8;
const MAX_ARRAY = 100;

/**
 * Deep-mask a log argument: sensitive keys are censored outright, and every
 * surviving string is scanned for phone-shaped content.
 *
 * Numbers are never content-masked. A numeric phone number is real, but so are
 * durations, counts, credits and status codes, and there is no way to tell
 * them apart by value — so numeric PII is caught by its key name instead.
 */
export function maskDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return maskPhones(value);
  if (depth >= MAX_DEPTH) return value;

  if (Array.isArray(value)) {
    const masked = value.slice(0, MAX_ARRAY).map((entry) => maskDeep(entry, depth + 1));
    if (value.length > MAX_ARRAY) masked.push(`[${value.length - MAX_ARRAY} more]`);
    return masked;
  }

  if (!isPlainObject(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? CENSOR : maskDeep(entry, depth + 1);
  }
  return out;
}

/**
 * pino's own path matcher, kept alongside the walker above as a second line of
 * defence — and as the layer that still applies to anything reaching the
 * logger without passing through `hooks.logMethod`.
 *
 * `err.request` is listed for a specific shape: an error carrying the outbound
 * request body it failed on is two levels deep, so no single-level wildcard
 * reaches it.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-webhook-signature"]',
  'req.headers["x-webhook-timestamp"]',
  'req.headers["x-admin-token"]',
  'req.headers["x-test-clerk-user"]',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.authorization',
  '*.apiKey',
  '*.transcript',
  '*.extraction',
  '*.extractionValue',
  '*.recordingUrl',
  '*.recording_url',
  '*.variables',
  '*.password',
  '*.secret',
  '*.token',
  'err.request',
  'error.request',
];

// ---------------------------------------------------------------------------
// Options and transports
// ---------------------------------------------------------------------------

/**
 * An error, serialized and then masked.
 *
 * `pino.stdSerializers.err` yields a plain object, so the walker can reach the
 * message and stack — which is where an interpolated number ends up when a
 * `catch` block re-throws with context.
 */
function maskedErrorSerializer(err: Error): unknown {
  return maskDeep(pino.stdSerializers.err(err));
}

/**
 * The logger's options, separated from its transports so tests can run the
 * real redaction against an in-memory stream instead of a worker thread.
 */
export function buildLoggerOptions(): pino.LoggerOptions {
  return {
    level: logLevel,
    base: { service: SERVICE_NAME, environment: nodeEnv },
    redact: { paths: REDACT_PATHS, censor: CENSOR },
    serializers: {
      err: maskedErrorSerializer,
      error: maskedErrorSerializer,
    },
    hooks: {
      logMethod(args, method) {
        method.apply(this, args.map((arg) => maskDeep(arg)) as Parameters<typeof method>);
      },
    },
  };
}

export interface TransportConfig {
  isProduction: boolean;
  logLevel: string;
  axiomToken?: string;
  axiomDataset?: string;
  axiomEdge?: string;
}

/**
 * The transport targets for a given configuration, plus the warning to print
 * if Axiom was asked for and not configured.
 *
 * Returns the warning rather than printing it: this runs before the console
 * override is installed, and a pure function is a testable one.
 */
export function buildTransportTargets(config: TransportConfig): {
  targets: pino.TransportTargetOptions[];
  warning: string | null;
} {
  const { isProduction: prod, logLevel: level, axiomToken, axiomDataset, axiomEdge } = config;

  if (!prod) {
    return {
      targets: [
        {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          level,
        },
      ],
      warning: null,
    };
  }

  // Stdout always, whatever happens with Axiom. Whoever is holding the
  // container logs during an incident must never be looking at nothing
  // because a shipping token expired.
  const targets: pino.TransportTargetOptions[] = [
    { target: 'pino/file', options: { destination: 1 }, level },
  ];

  if (!axiomToken || !axiomDataset) {
    return {
      targets,
      warning:
        '[logger] AXIOM_TOKEN and AXIOM_DATASET are not both set — logs stay on stdout only.',
    };
  }

  targets.push({
    target: '@axiomhq/pino',
    options: {
      dataset: axiomDataset,
      token: axiomToken,
      ...(axiomEdge ? { edge: axiomEdge } : {}),
    },
    level,
  });

  return { targets, warning: null };
}

/**
 * Build the destination.
 *
 * Wrapped, because this is configuration and configuration is wrong sometimes.
 * A transport that will not start must degrade to plain stdout, never take the
 * API down with it — the service's job is answering calls, not shipping logs.
 */
function buildDestination(): pino.DestinationStream | undefined {
  // Under test there is nothing to ship and no worker thread worth spawning.
  if (isTest) return pino.destination({ dest: 1, sync: true });

  const { targets, warning } = buildTransportTargets({
    isProduction,
    logLevel,
    axiomToken: process.env.AXIOM_TOKEN,
    axiomDataset: process.env.AXIOM_DATASET,
    axiomEdge: process.env.AXIOM_EDGE,
  });

  if (warning) process.stdout.write(`${warning}\n`);

  try {
    return pino.transport({ targets });
  } catch (err) {
    process.stdout.write(
      `[logger] transport failed to start, falling back to stdout: ${String(err)}\n`,
    );
    return undefined;
  }
}

/**
 * What this module resolved at import time.
 *
 * Exported so the `dotenv` ordering above can be proven rather than asserted
 * in a comment: a test imports this module in a fresh process, with the
 * configuration supplied only by a `.env` file, and reads `shipsToAxiom`.
 *
 * Carries no token. A diagnostic that leaks the credential it is diagnosing
 * would be its own bug.
 */
export const loggingConfig = {
  level: logLevel,
  dataset: process.env.AXIOM_DATASET ?? null,
  shipsToAxiom: Boolean(process.env.AXIOM_TOKEN && process.env.AXIOM_DATASET),
};

export const logger = pino(buildLoggerOptions(), buildDestination());

// ---------------------------------------------------------------------------
// Request logging
// ---------------------------------------------------------------------------

/**
 * A request id is echoed into a response header, so it is caller-controlled
 * text on its way back out. Anything outside this charset — or too long — is
 * replaced with a generated one rather than sanitised, because a mangled id
 * correlates nothing and `res.setHeader` throws on a newline, which would turn
 * a log concern into a 500.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._~-]{1,128}$/;

/**
 * The path as the caller sent it, masked.
 *
 * `originalUrl` rather than `url`, because Express rewrites `req.url` for a
 * mounted router and this is read when the response finishes — by which point
 * `/api/me` reads as `/me` and `/webhooks/vocobase` as `/vocobase`. Every
 * route in this app is behind a mount, so reading `url` here would mislabel
 * essentially all of them.
 */
export function requestPath(req: { url?: string; originalUrl?: string }): string {
  return maskPhones(req.originalUrl ?? req.url ?? '');
}

export const httpLogger = pinoHttp({
  logger,

  /**
   * Take the caller's id when there is a usable one, so a trace spanning the
   * dashboard and this service shares a key; mint one otherwise. Either way it
   * goes back on the response, which is what makes an id a customer can quote
   * in a bug report.
   */
  genReqId: (req, res) => {
    const incoming = req.headers['x-request-id'];
    const candidate = typeof incoming === 'string' ? incoming.trim() : '';
    const id = SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();

    res.setHeader('x-request-id', id);
    return id;
  },

  /**
   * The pino-http defaults serialize the entire header bag on both req and
   * res — about a kilobyte of cookies, user-agents and forwarding chains per
   * request, dwarfing the part anyone reads and shipping every one of those
   * headers to Axiom. Keep the identifying fields.
   *
   * The url is masked: query strings are where a phone number reaches a
   * request log.
   */
  serializers: {
    req: (req) => ({
      method: req.method,
      url: requestPath(req),
      remoteAddress: req.remoteAddress,
    }),
    res: (res) => ({ statusCode: res.statusCode }),
  },

  /**
   * Tenancy, read off the request the auth middlewares already decorate.
   *
   * `customProps` runs when the response finishes, by which point `requireAuth`
   * has attached `account` and `requireMembership` has attached `workspace` —
   * so this reads what is there rather than resolving anything itself, and
   * neither middleware has to know the logger exists. Unauthenticated routes
   * simply contribute no fields.
   */
  customProps: (req) => {
    const decorated = req as typeof req & {
      id?: unknown;
      account?: { id?: string };
      workspace?: { id?: string };
    };

    return {
      // Top level, deliberately. pino-http only binds the id itself under
      // `quietReqLogger`, and otherwise expects it inside the serialized
      // `req` — but a nested id is far more awkward to filter a whole trace
      // on in a log aggregator than a field of its own.
      ...(decorated.id ? { requestId: String(decorated.id) } : {}),
      ...(decorated.account?.id ? { accountId: decorated.account.id } : {}),
      ...(decorated.workspace?.id ? { workspaceId: decorated.workspace.id } : {}),
    };
  },

  customSuccessMessage: (req, res) => `${req.method} ${requestPath(req)} ${res.statusCode}`,
  customErrorMessage: (req, res) => `${req.method} ${requestPath(req)} ${res.statusCode}`,

  // The load balancer polls this every few seconds forever and it says nothing.
  autoLogging: {
    ignore: (req) => req.url === '/health',
  },

});

// ---------------------------------------------------------------------------
// Console override
// ---------------------------------------------------------------------------

/** `"[dialer] sweep failed"` → component `dialer`, message `sweep failed`. */
const COMPONENT_PREFIX = /^\[([A-Za-z0-9_-]+)\]\s*/;

function parseComponent(message: string): { component: string; message: string } {
  const match = COMPONENT_PREFIX.exec(message);
  if (!match) return { component: 'app', message };
  return { component: match[1], message: message.slice(match[0].length) };
}

/**
 * Turn one `console.*` call into one structured log line.
 *
 * The call sites in this codebase are overwhelmingly
 * `console.error('some context:', err)` and
 * `console.log(`[component] something about ${id}`)`, so those two shapes are
 * what this handles well: the error becomes `err` and is serialized with its
 * stack, plain objects merge into the context, and anything else is appended
 * to the message.
 */
function forward(level: 'info' | 'warn' | 'error' | 'debug', args: unknown[]): void {
  if (args.length === 0) return;

  const [first, ...rest] = args;

  if (first instanceof Error) {
    logger[level]({ err: first, component: 'app' }, first.message);
    return;
  }

  if (typeof first !== 'string') {
    logger[level]({ component: 'app' }, args.map((arg) => String(arg)).join(' '));
    return;
  }

  const { component, message } = parseComponent(first);

  if (rest.length === 0) {
    logger[level]({ component }, message);
    return;
  }

  const context: Record<string, unknown> = { component };
  const trailing: string[] = [];

  for (const arg of rest) {
    if (arg instanceof Error) context.err = arg;
    else if (isPlainObject(arg)) Object.assign(context, arg);
    else trailing.push(String(arg));
  }

  logger[level](context, trailing.length > 0 ? `${message} ${trailing.join(' ')}` : message);
}

/** The real console, for the rare caller that must bypass the logger. */
export const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

/**
 * Route `console.*` through the logger.
 *
 * Not installed under test: vitest reports through the console, and the suite
 * has cases that assert on console output. A logger writing over either would
 * break tests that have nothing to do with logging.
 */
export function installConsoleOverride(): void {
  console.log = (...args: unknown[]) => forward('info', args);
  console.info = (...args: unknown[]) => forward('info', args);
  console.warn = (...args: unknown[]) => forward('warn', args);
  console.error = (...args: unknown[]) => forward('error', args);
  console.debug = (...args: unknown[]) => forward('debug', args);
}

if (!isTest) installConsoleOverride();

export default logger;
