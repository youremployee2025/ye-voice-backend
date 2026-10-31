import { UnrecoverableError, Worker } from 'bullmq';
import { createWorkerConnection } from '../connection.js';
import { QUEUE_NAMES, type CallPlacementJobData } from '../types.js';
import { placeClaimedCall, releaseFailedPlacement } from '../../../services/dialerPlacement.js';

/**
 * **One at a time, and this is the load-bearing line in the file.**
 *
 * Not a cap on the platform — that is `concurrencyLimit`, the account
 * allotment and the shared pool, every one of them enforced in Postgres before
 * a job exists. This decides only how many call-start requests *this process*
 * has open at once, and it is one for two reasons the engine already had and
 * would otherwise have quietly lost.
 *
 * **A campaign's list is dialed in the order it was uploaded.** Contacts leave
 * the queue FIFO and the i-th of a batch takes the i-th step of the number
 * rotation; four workers racing a batch keep the pairing but scramble the
 * order the requests actually go out in, so a list dialed A,B,C arrives at the
 * platform as B,A,C. Nothing enforces that order downstream — it was a
 * property of dialing the batch in a loop, and a worker pool is where it would
 * have been dropped without anyone deciding to.
 *
 * **A batch that meets an account-wide wall stops.** The halt marker is read
 * before a job dials; with one worker every job after the refusal reads it, so
 * a rate limit costs one refused request instead of a batch of them. At four,
 * the three already in flight never see it.
 *
 * It costs nothing this engine was not already paying: the loop this replaces
 * dialed serially too, inside the tick. What the queue bought is that the tick
 * no longer *waits* for it — and parallelism, when it is wanted, is another
 * instance, which is the entire thesis of running on a queue at all.
 */
const PLACEMENT_CONCURRENCY = 1;

/**
 * The dial, on a queue instead of inside the tick.
 *
 * Everything about *whether* to call somebody happened before this job
 * existed. What this worker adds is a retry policy for the request itself —
 * three attempts, exponential backoff — which the sequential loop it replaces
 * could not have: a retry there would have been a second `MAX + 1`, a second
 * attempt row and a second telephone call. Here the ordinal is fixed by the
 * tick, so a retry re-finds the row it wrote and dials under the reference the
 * platform has already seen, which that endpoint answers with the call it
 * already placed.
 *
 * Losing a job outright is survivable and is the case the design is built
 * around: the contact stays `QUEUED`, the cleanup sweep gives it back, and
 * nobody is called twice. Placing one twice is not survivable, which is why
 * every guard here is on that side.
 */
export function createCallPlacementWorker(): Worker<CallPlacementJobData> {
  const worker = new Worker<CallPlacementJobData>(
    QUEUE_NAMES.CALL_PLACEMENT,
    async (job) => {
      const result = await placeClaimedCall(job.data);

      // A launch is the ordinary case and says nothing a dial log does not.
      // Everything else is a claim that did not become a call, which is the
      // thing an operator reading this campaign wants to find.
      if (result.disposition !== 'launched') {
        console.log(
          `[placement] contact ${job.data.contactId} attempt ${job.data.attemptNo}: ` +
            `${result.disposition}` +
            (result.halt ? ` (halt: ${result.halt})` : ''),
        );
      }

      return result;
    },
    {
      connection: createWorkerConnection(),
      concurrency: PLACEMENT_CONCURRENCY,
    },
  );

  worker.on('failed', (job, err) => {
    console.error(
      `[queue:${QUEUE_NAMES.CALL_PLACEMENT}] job ${job?.id ?? 'unknown'} ` +
        `contact ${job?.data?.contactId ?? 'unknown'} attempt ${job?.attemptsMade ?? 0} failed:`,
      err,
    );

    if (!job) return;

    /**
     * The last attempt — or a failure no retry follows.
     *
     * This event fires once per attempt, and a give-back after the first would
     * put the contact back on the queue while a retry of its own dial is still
     * pending — a tick claims it, posts a second job, and two jobs hold one
     * contact. The dial-attempt row's unique would stop the second call, which
     * is the backstop working rather than the design working.
     *
     * `UnrecoverableError` is the exception to the guard, not to the
     * reasoning: it is BullMQ's own word for "no retry is coming" — the
     * deferred failure of a job stalled past the allowance arrives this way
     * with `attemptsMade` below `attempts` — so the hazard the guard exists
     * for cannot occur, and skipping the release would strand the contact
     * until the claim lease expires.
     */
    const lastAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!lastAttempt && !(err instanceof UnrecoverableError)) return;

    void releaseFailedPlacement(job.data).catch((releaseErr) => {
      // The contact stays QUEUED. That is what the cleanup sweep is for, and
      // why losing this is survivable rather than terminal.
      console.error(
        `[queue:${QUEUE_NAMES.CALL_PLACEMENT}] could not release contact ${job.data.contactId}:`,
        releaseErr,
      );
    });
  });

  return worker;
}
