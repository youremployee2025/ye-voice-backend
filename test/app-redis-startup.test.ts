import { describe, expect, it, vi } from 'vitest';

/**
 * Building the app must not open a Redis connection.
 *
 * `src/lib/queue/queues.ts` constructs its five Queue objects at module
 * scope, and constructing a Queue connects. `webhooks.routes.ts` and
 * `dialer.ts` therefore import it lazily, inside the handler — a discipline
 * that holds only if **no** module `app.ts` reaches does it statically: one
 * top-level `import` anywhere in the graph and the connection opens the
 * moment `app.js` is evaluated, in every test file and in an API process
 * running no workers at all.
 *
 * The mock factory runs when the module is first imported, so the flag is a
 * record of whether anything in `app.ts`'s import graph pulled the queue
 * module in. It must still be false after the app module has loaded.
 */
const queueModule = vi.hoisted(() => ({ evaluated: false }));

vi.mock('../src/lib/queue/queues.js', () => {
  queueModule.evaluated = true;
  return { ALL_QUEUES: [] };
});

describe('app startup', () => {
  it('does not import the queue module when the app module loads', async () => {
    await import('../src/app.js');

    expect(queueModule.evaluated).toBe(false);
  });
});
