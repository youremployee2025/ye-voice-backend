import { Redis } from 'ioredis';
import { env } from '../env.js';

/**
 * The Redis connections the queues and workers run on.
 *
 * Two rules from BullMQ shape this file.
 *
 * The first is `maxRetriesPerRequest: null`. BullMQ's workers hold a blocking
 * `BRPOPLPUSH` open for seconds at a time; ioredis's default retry cap counts
 * that as a stalled request and tears the connection down under a worker that
 * is behaving perfectly. `null` is not "retry forever" carelessness, it is the
 * setting BullMQ requires and refuses to start without.
 *
 * The second is that a blocking connection cannot also serve commands. Every
 * worker therefore gets its own connection, while the queues — which only ever
 * issue ordinary commands — share one. That is the difference between the
 * singleton below and the factory beside it, and it is why the factory is a
 * factory.
 */

let queueConnection: Redis | null = null;

/** The one connection every `Queue` shares. Opened on first use. */
export function getQueueConnection(): Redis {
  // `enableOfflineQueue: false` on the producer side only: a command issued
  // while Redis is unreachable rejects immediately instead of sitting in
  // ioredis's offline queue while the retry strategy reconnects forever — a
  // promise that never settles, under a webhook handler or a dispatch tick
  // that is awaiting it. Workers keep the default: their blocking reads are
  // *supposed* to outwait a reconnect.
  queueConnection ??= new Redis(env.redisUrl, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
  });

  return queueConnection;
}

/**
 * Every worker connection this factory has handed out and not yet closed.
 *
 * BullMQ treats a caller-supplied ioredis instance as shared and does not
 * quit it on `worker.close()` — it closes only the blocking duplicate it made
 * internally. So the process that constructs these owns their teardown, and a
 * registry is what makes `closeWorkerConnections()` cover every call site
 * (bootstrap, tests, the conformance harness) rather than only the ones that
 * remembered to keep a reference.
 */
const workerConnections = new Set<Redis>();

/**
 * A fresh connection for one worker.
 *
 * Never share the return value between two workers: each blocks on its own
 * queue, and two blocking readers on one socket is a deadlock waiting for a
 * quiet afternoon.
 */
export function createWorkerConnection(): Redis {
  const connection = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
  workerConnections.add(connection);
  connection.once('end', () => workerConnections.delete(connection));

  return connection;
}

/** How many worker connections are still open. A teardown assertion hook. */
export function openWorkerConnectionCount(): number {
  return workerConnections.size;
}

/**
 * Quits every worker connection still open.
 *
 * Runs after `worker.close()` (nothing is blocking on them any more) and
 * before `closeQueues()` — the same reasoning as the shared connection going
 * last: close a socket while something still uses it and a clean shutdown
 * logs like a crash.
 */
export async function closeWorkerConnections(): Promise<void> {
  const open = [...workerConnections];
  workerConnections.clear();
  await Promise.all(
    open.map((connection) => connection.quit().catch(() => connection.disconnect())),
  );
}

/**
 * Closes the shared connection, last in the shutdown order.
 *
 * Workers close first, then queues, then this. Closing here while a queue
 * still holds a write is how a clean shutdown produces an error log that looks
 * like a crash.
 */
export async function closeQueueConnection(): Promise<void> {
  if (!queueConnection) return;

  const connection = queueConnection;
  queueConnection = null;
  await connection.quit();
}
