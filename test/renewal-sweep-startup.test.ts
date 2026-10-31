import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The sweep's headline safety property, asserted rather than assumed.
 *
 * `createApp()` must not start the renewal timer. Every test in this suite
 * builds an app; if building one started a sweep, the suite would bill its own
 * fixtures on a clock, and the failures would look like flakes rather than
 * like the cause.
 *
 * Until now that property was held by an import `app.ts` merely does not have.
 * Nothing failed if somebody added it — which is the definition of an untested
 * invariant, and an unusually expensive one to get wrong.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createApp', () => {
  it('starts no timer that charges people', async () => {
    const setInterval = vi.spyOn(globalThis, 'setInterval');

    const { createApp } = await import('../src/app.js');
    createApp();

    expect(setInterval).not.toHaveBeenCalled();
  });

  /**
   * The same property for the dialer, and it matters more: that timer does not
   * merely charge people, it rings their customers' telephones. An invariant
   * held only by an import somebody happens not to have written is not held at
   * all — which is why this asserts the absence rather than trusting it.
   */
  it('does not pull the dialer into the app module graph either', async () => {
    const appSource = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/app.ts', import.meta.url), 'utf8'),
    );

    expect(appSource).not.toContain('dialer');
    expect(appSource).not.toContain('startDialerSweep');
  });

  it('does not pull the renewal sweep into the app module graph', async () => {
    // A stricter statement of the same rule: `app.ts` should not reach
    // `didRenewal.ts` at all, so the timer cannot be started by a transitive
    // import somebody adds without noticing what it does.
    const appSource = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/app.ts', import.meta.url), 'utf8'),
    );

    expect(appSource).not.toContain('didRenewal');
    expect(appSource).not.toContain('startRenewalSweep');
  });
});

const source = (file: string) =>
  import('node:fs/promises').then((fs) =>
    fs.readFile(new URL(`../src/${file}`, import.meta.url), 'utf8'),
  );

/**
 * The timers live in their own entry point now, so the API can be deployed and
 * restarted without stopping the sweeps — and so a crash in one is not a crash
 * in the other. There is exactly one composition of them and `worker.ts` is it;
 * `server.ts` reaches it behind a flag rather than repeating it, because two
 * lists of workers is how one of them silently loses a member.
 */
describe('worker.ts', () => {
  it('is an entry point over the one worker composition, and composes nothing itself', async () => {
    const worker = await source('worker.ts');

    expect(worker).toContain('startWorkers');
    expect(worker).toContain('stopWorkers');
    // The last timer is gone. Anything that looks like a schedule living here
    // again is a second list of workers growing back.
    expect(worker).not.toContain('setInterval');
  });

  it('serves no HTTP, so a worker process cannot answer a request', async () => {
    const worker = await source('worker.ts');

    expect(worker).not.toContain('createApp');
    expect(worker).not.toContain('listen');
  });
});

describe('server.ts', () => {
  it('runs the timers behind a flag, and composes none of them itself', async () => {
    const server = await source('server.ts');

    // The whole gate. Default true, so a single-process deployment is
    // unchanged; false is how the API process runs timer-free beside a worker.
    expect(server).toContain('workersEnabled');
    // Reached, not repeated: one dynamic import of the one bootstrap, so an
    // API process running work-free does not even open a Redis connection.
    expect(server).toContain('lib/queue/bootstrap.js');

    // Not a second copy of the list. `DIALER_ENABLED` still means what it
    // meant, and lives with the timers it guards.
    expect(server).not.toContain('startDialerSweep');
    expect(server).not.toContain('runRenewalSweep');
  });
});
