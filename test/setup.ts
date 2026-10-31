import http from 'node:http';
import dotenv from 'dotenv';

dotenv.config();

process.env.NODE_ENV = 'test';

/**
 * A known admin rate limit at the start of every file.
 *
 * `admin-rate-limit.test.ts` lowers this to 3 so the cap is reachable without
 * firing sixty requests — but it does so on `process.env`, which is shared by
 * every file that loads after it in the same worker. The suite therefore
 * passed or failed on file order: any file making more than three admin
 * requests started returning 429 from tests that had nothing to do with rate
 * limiting. Setup runs before each test module, so restoring the default here
 * makes each file independent while leaving that file's own override intact.
 */
process.env.ADMIN_RATE_LIMIT_MAX = '1000';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Tests must never run against the production database. ' +
      'Start a local Postgres and set TEST_DATABASE_URL (see README).',
  );
}

if (testDatabaseUrl.includes('neon.tech')) {
  throw new Error(
    'TEST_DATABASE_URL points at a Neon host. That is the production database — refusing to run tests.',
  );
}

// Everything downstream (Prisma included) must see the test database only.
process.env.DATABASE_URL = testDatabaseUrl;

/**
 * The same rule for Redis, for the same reason.
 *
 * The queues are keyed by name, not by database, so a suite pointed at the
 * development Redis would share `campaign-dispatch` with a running dev server
 * — and a test that enqueues a placement job would be handing a real dial to
 * whatever worker happened to be listening. `TEST_REDIS_URL` must therefore be
 * a database index of its own.
 *
 * Workers never start under vitest regardless (see `env.workersEnabled`), so
 * this is the second lock on a door that is already bolted. Both are worth
 * having: the first stops us consuming, this stops us publishing.
 */
const testRedisUrl = process.env.TEST_REDIS_URL;

if (!testRedisUrl) {
  throw new Error(
    'TEST_REDIS_URL is not set. Tests must never share a Redis database with a running server. ' +
      'Point it at a dedicated database index on the local Redis (see README).',
  );
}

process.env.REDIS_URL = testRedisUrl;

/**
 * One listening socket per app, for the whole file.
 *
 * `supertest` binds a **fresh ephemeral port for every request**: it wraps the
 * express app in `http.createServer(app)`, calls `listen(0)`, and closes the
 * server when the response settles. Across this suite that is on the order of
 * a thousand bind/close cycles in twenty seconds, and each closed socket sits
 * in TIME_WAIT for two MSL — around 800 of them at peak here.
 *
 * Node sets `SO_REUSEADDR`, so `listen(0)` may be handed a port that is still
 * in TIME_WAIT from a previous exchange. When that happens a late segment from
 * the dead connection is delivered to the new server, and the two requests
 * cross: a client receives another request's response, or a fragment of one.
 * The symptoms are exactly what this suite was producing intermittently —
 * `Parse Error: Expected HTTP/`, a `res.body.data` that is `undefined`, and
 * worst of all an isolation test reporting **200 where it asserted 403**.
 *
 * That last one is why this is worth fixing rather than retrying. A harness
 * that can spontaneously report "a non-member reached this workspace" will one
 * day report it when it is true, and be dismissed as flake.
 *
 * The fix is to stop churning ports. `http.createServer` is memoised on the
 * request listener, so every `request(app)` in a file reaches the same server
 * on the same port. supertest only closes a server it started itself — it
 * checks `app.address()` first and skips the `listen` when one already exists
 * — so the cached server survives, and no test file needs to change.
 *
 * The socket is `unref`'d, so it never holds the worker's event loop open;
 * vitest tears the worker down per file, which is what releases it.
 *
 * This does not remove the churn on the **client** side, and it cannot:
 * superagent sends `Connection: close` on every request, so each exchange
 * still leaves a four-tuple in TIME_WAIT and client keep-alive has no effect
 * (measured — the header is unconditional). What remains is a much smaller
 * hazard, because the pairs now differ only in the client port rather than in
 * both. Closing it entirely means each file owning its client agent as well,
 * which is a change to every test file rather than to this one.
 */
const cachedServers = new WeakMap<http.RequestListener, http.Server>();
const createServer = http.createServer.bind(http);

http.createServer = ((...args: unknown[]) => {
  const [listener] = args;

  // Only the single-argument, plain-listener form — the shape supertest uses.
  // Anything else (options objects, no listener) is passed straight through,
  // so this cannot change how the application itself creates servers.
  if (args.length !== 1 || typeof listener !== 'function') {
    return (createServer as (...a: unknown[]) => http.Server)(...args);
  }

  const app = listener as http.RequestListener;
  let server = cachedServers.get(app);

  if (!server) {
    server = createServer(app);
    server.listen(0);
    server.unref();
    cachedServers.set(app, server);
  }

  return server;
}) as typeof http.createServer;

/**
 * The dialer is ON for the suite, and the adapter is mocked in every file that
 * touches it.
 *
 * `DIALER_ENABLED` defaults to false, which is right for every real
 * deployment and useless for testing: left off, every case asserting what the
 * sweep does would pass by asserting nothing. Setting it here — before
 * `env.ts` is first imported — exercises the real paths against a mocked
 * client, and `dialer-disabled.test.ts` overrides it back to `false` to prove
 * the switch itself works.
 *
 * This is safe only because no test may make a real network call. If that ever
 * stops being true, this line is the one that turns a test run into a phone
 * bill.
 */
process.env.DIALER_ENABLED ??= 'true';

/**
 * Inbound calling on for the suite, the same way and for the same reason the
 * dialer is: `env.ts` is read once at import, so the flag has to be set before
 * the app module graph loads. Safe only because no test reaches a live account.
 * A test needing it OFF stubs `env.inboundEnabled` itself.
 */
process.env.INBOUND_ENABLED ??= 'true';
/** A valid-length routing-policy secret, so the inbound-route endpoint verifies
 *  in tests without each file re-declaring it. */
process.env.INBOUND_ROUTE_POLICY_SECRET ??= 'i'.repeat(48);

/**
 * Low call-history ceilings, so a test can reach one.
 *
 * Set here rather than in the test file because `env.ts` is read once, at
 * import, and the app module graph is already loaded by the time a test body
 * runs. The production defaults are hundreds of requests a minute; exhausting
 * those over HTTP would cost a thousand round trips to assert one middleware
 * is mounted. See `test/calls.test.ts`, "rate limiting".
 */
/**
 * A public origin for the Google connect flow, set here for the reason every
 * value above it is: `env.ts` is read once at import, and the app module graph
 * is already loaded by the time a test body runs. The connect route refuses to
 * mint a link without one — a link pointing at `undefined` is worse than a
 * refusal — so without this every case in `integrations.test.ts` would be
 * exercising that refusal. The file that tests the refusal clears
 * `env.publicApiUrl` itself.
 */
process.env.PUBLIC_API_URL ??= 'http://localhost:3001';

process.env.CALL_LIST_RATE_LIMIT_MAX ??= '5';
process.env.CALL_DETAIL_RATE_LIMIT_MAX ??= '8';
process.env.CALL_RECORDING_RATE_LIMIT_MAX ??= '10';

/**
 * Child tables first, so each delete is satisfied by the time its parent goes.
 *
 * Deliberately DELETE rather than TRUNCATE. TRUNCATE takes an ACCESS EXCLUSIVE
 * lock on every table it names, and once the list grew past four tables that
 * occasionally left a reset incomplete — tests then saw a previous case's rows
 * and authorisation checks returned the permissive answer. DELETE takes row
 * locks, runs in one transaction, and is all-or-nothing; on tables this small
 * it is no slower.
 */
const TABLES = [
  // The analytics fact table names a workspace and an agent by id and holds no
  // constraint on either, deliberately — see the schema. Its position here is
  // free, so it sits at the top with the other childless rows.
  'CallRecord',
  'AnalyticsCursor',
  // Nothing points at a top-up and it points at nothing; position is free.
  'PlatformTopup',
  'NotificationRead',
  'Notification',
  // Before `CallAttempt` and `TestSession`: a ledger row points at whichever it
  // charged for, and both foreign keys are Restrict rather than Cascade.
  'CreditTransaction',
  'CallAttempt',
  'TestSession',
  // Unrelated to the rest of the graph, so its position is free.
  'WebhookEvent',
  // Inbound-campaign rows. The claim cascades from both PhoneNumber and
  // Campaign, and the call has no foreign key at all — but both are deleted
  // ahead of Campaign/PhoneNumber so a leftover row never has to be cascaded.
  'CampaignInboundClaim',
  'CampaignInboundCall',
  'CampaignContact',
  // Before `PhoneNumber` above all: that key is Restrict, so a leftover
  // rotation row blocks the reset rather than cascading with it.
  'CampaignPhoneNumber',
  'Campaign',
  'Contact',
  'PhoneNumber',
  // Cascades from Agent, but deleted first so a reset never depends on it.
  'AgentPersonaSnapshot',
  'Agent',
  'WorkspaceResource',
  'WorkspaceInvite',
  // Points at Account twice (both Restrict) and Workspace (SetNull); before
  // all of them. Restrict rather than Cascade is the point of the table —
  // deleting a super admin must not delete the record of what they did — so
  // a leftover row here blocks the reset instead of quietly vanishing with it.
  'SuperAdminAction',
  'WorkspaceMember',
  'Workspace',
  'AccountTier',
  'Tier',
  'Account',
] as const;

export async function truncateAll(): Promise<void> {
  const { prisma } = await import('../src/lib/prisma.js');

  // Every route that emits a notification does so with `void notify(...)`, so a
  // write can still be in flight when the next test resets. Settling them first
  // keeps the stray INSERT from racing the DELETE below — the foreign key
  // cascade means it was never a correctness problem, but it is lock contention
  // and console noise that appears in files which never mention notifications.
  const { flushNotifications } = await import('../src/lib/notify.js');
  await flushNotifications();

  await prisma.$transaction(
    TABLES.map((table) => prisma.$executeRawUnsafe(`DELETE FROM "${table}"`)),
  );
}
