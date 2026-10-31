import { createApp } from './app.js';
import { env } from './lib/env.js';

/**
 * A rejection that escapes a job is logged loudly and does **not** end the
 * process.
 *
 * This is a deliberate reversal of Node's default, and it is worth stating
 * why. Background work now runs in the same process as the API: a `call-
 * placement` job whose upstream call rejects, a maintenance sweep that trips
 * over a partner timeout. Under the default that rejection is fatal, so one
 * failed job takes down an HTTP server that was serving other customers
 * perfectly — and the outage looks like a mystery, because the log says
 * nothing about the queue that caused it.
 *
 * Every queue already has a failure policy, and that policy is where a failed
 * job belongs: retried with backoff, or — for `call-placement` — not retried
 * at all, on purpose. The process staying up is what lets those policies run.
 *
 * `uncaughtException` is left alone. A synchronous throw with no handler is
 * not a failed job, it is a process in a state nobody reasoned about, and
 * continuing from it is how corrupt data gets written.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandled rejection (logged, continuing):', reason);
});

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(`ye-voice-backend listening on port ${env.port}`);
});

/**
 * The background workers, if this process is the one that runs them.
 *
 * Default **true**, so a single-process deployment is exactly what it was.
 * `WORKERS_ENABLED=false` is how the API runs work-free beside a `worker.ts`
 * process — the API can then be deployed and restarted without interrupting a
 * sweep, and a crash in one is not a crash in the other.
 *
 * A dynamic import rather than a static one, so an API process that is not
 * running the workers does not load the workers. It will still reach Redis —
 * the webhook handler enqueues what it verifies — but it opens that connection
 * when the first delivery arrives rather than at boot.
 *
 * `DIALER_ENABLED` is untouched and means what it always meant — whether this
 * deployment may ring a telephone at all.
 *
 * **Unlike the timers this replaces, a second instance is now useful.** Two
 * processes running these workers share the work rather than repeating it: the
 * recurring schedules are deduplicated in Redis, and everything else is
 * claimed with `FOR UPDATE SKIP LOCKED` in Postgres. What a second instance
 * still does **not** buy is upstream capacity — the call-start rate window,
 * the concurrency pool and the supplier balance belong to the one partner
 * account, and two instances share that ceiling rather than each receiving
 * one.
 */
const workers = env.workersEnabled ? await import('./lib/queue/bootstrap.js') : null;

if (workers) {
  await workers.startWorkers();
} else {
  console.log('[workers] disabled in this process. Run `npm run start:worker` alongside it.');
}

/**
 * Shutdown, in the order that leaves nothing half-done: stop taking requests,
 * then drain the workers, their queues and the Redis connection.
 *
 * The HTTP server closes first because an accepted request may enqueue work,
 * and enqueueing onto a queue that is already closing is the one ordering that
 * loses a job outright.
 */
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[shutdown] ${signal} received; draining.`);

  await new Promise<void>((resolve) => server.close(() => resolve()));

  try {
    if (workers) await workers.stopWorkers();
  } catch (err) {
    console.error('[shutdown] error while stopping workers:', err);
  }

  console.log('[shutdown] complete.');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
