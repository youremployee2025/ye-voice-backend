import { runDialerSweep, type DialerSweepOptions, type DialerSweepResult } from '../src/services/dialer.js';
import { placeClaimedCall } from '../src/services/dialerPlacement.js';
import { callPlacementQueue, closeQueues } from '../src/lib/queue/queues.js';
import { closeQueueConnection } from '../src/lib/queue/connection.js';

/**
 * A whole dialing pass, tick and placements together.
 *
 * The engine's pass is now two halves: a tick that claims contacts and posts
 * them, and placement jobs that dial them. The behaviour the suite grades —
 * what was launched, what failed, what paused, what halted — is the sum of the
 * two, and it is exactly what one call to the old `runDialerSweep` returned.
 * So the cases keep asserting on that sum, and this is where it is put back
 * together.
 *
 * The jobs go through **the real queue and the real processor**. Nothing here
 * simulates a placement: the tick writes to Redis, this reads what it wrote and
 * runs `placeClaimedCall` over it. What is missing is only BullMQ's own worker
 * loop — the polling, the concurrency, the retry timers — which is a thing to
 * grade with a real worker under a real clock, and the conformance and battle
 * harnesses do exactly that.
 *
 * Draining **serially, in job order** is a deliberate difference from
 * production, where four placements run at once. It makes the batch-halt
 * marker fully effective here and only partly effective there, and that is the
 * honest shape of it: the marker is advisory, so a suite that proves what it
 * does when it is seen is proving the thing the marker is for. What happens
 * when it is not seen is graded by the conformance suite, against a real
 * worker at the real concurrency.
 */
export async function runDialerPass(options: DialerSweepOptions = {}): Promise<DialerSweepResult> {
  const result = await runDialerSweep(options);

  await drainPlacements(result);

  return result;
}

/**
 * Runs every posted placement job, oldest first, folding what each one did
 * back into the pass's result.
 *
 * Loops until the queue is empty rather than draining once: a placement can
 * settle a contact, and a settled contact is not re-posted — but the loop
 * costs nothing and a drain that stopped at the first empty read would be a
 * silent partial pass the day something does post from a job.
 */
export async function drainPlacements(result: DialerSweepResult): Promise<void> {
  for (;;) {
    const jobs = await callPlacementQueue.getJobs(['waiting', 'delayed', 'prioritized'], 0, -1);

    if (jobs.length === 0) return;

    // `getJobs` reads several Redis structures and concatenates them; the ids
    // are monotonic, so sorting by id is the order the tick posted in — which
    // is the order the rotation was paired in and the order a halt would have
    // been met in.
    jobs.sort((a, b) => Number(a.id) - Number(b.id));

    for (const job of jobs) {
      const outcome = await placeClaimedCall(job.data);

      if (outcome.disposition === 'launched') result.launched += 1;
      // The same rule the sequential loop held: a claim disposed of before any
      // request went out is not a failed launch. Reporting a stopped campaign
      // as one whose calls are failing is the mistake that rule prevents.
      else if (outcome.disposition === 'launch-failed') result.launchFailed += 1;

      if (outcome.paused) result.paused += 1;
      result.halted ??= outcome.halt;

      await job.remove();
    }
  }
}

/** Empties the placement queue between cases, so no pass inherits another's. */
export async function clearPlacements(): Promise<void> {
  await callPlacementQueue.obliterate({ force: true });
}

/** Closes the queue's Redis handles, so the file's worker can exit. */
export async function closePlacementQueue(): Promise<void> {
  await closeQueues();
  await closeQueueConnection();
}
