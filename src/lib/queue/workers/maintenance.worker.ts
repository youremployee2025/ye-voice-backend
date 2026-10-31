import { Worker } from 'bullmq';
import { env } from '../../env.js';
import { createWorkerConnection } from '../connection.js';
import { QUEUE_NAMES, type MaintenanceJobData, type MaintenanceJobKind } from '../types.js';
import { runScheduleScan } from '../../../services/scheduleScanner.js';
import { runRenewalSweep } from '../../../services/didRenewal.js';
import { runAnalyticsSync } from '../../../services/analyticsIngest.js';
import { syncAllAgents } from '../../../services/agentSync.js';
import { refreshOpenTopups } from '../../../services/platformWallet.js';

/**
 * The slow, upstream-facing sweeps, on one queue and three schedules.
 *
 * One queue rather than three because they share a shape — a periodic pass
 * over the partner API that logs what it did — and a queue per sweep would be
 * three sets of counters on the admin panel saying the same thing. They keep
 * their own repeatable keys and their own intervals, so nothing about *when*
 * each one runs is pooled; only the worker is.
 *
 * **Concurrency 3, deliberately.** These run on independent timers today and a
 * slow renewal sweep does not delay a schedule scan. At concurrency 1 an hour's
 * worth of DID renewals would sit in front of a scan that is supposed to happen
 * every thirty seconds, and campaigns somebody scheduled for 9am would start
 * whenever the renewals finished. Three is one lane per sweep, which is the
 * arrangement they already have.
 */

/**
 * One pass of each kind at a time, in this process.
 *
 * This is the `let running = false` each timer carried, moved rather than
 * dropped. A repeatable's next job is produced when the previous one is picked
 * up, not when it finishes, so a pass that outlives its interval *can* be
 * joined by the next — which the timers deliberately prevented. Their reason
 * stands: overlapping passes stay correct (every write is a compare-and-set or
 * DRAFT-guarded), but they pile identical requests onto the rate-limited
 * partner API that is usually the reason the pass was slow in the first place.
 *
 * In-process, as it always was. Two instances can still overlap, and that is
 * the same thing two instances have always been able to do.
 */
const running = new Set<MaintenanceJobKind>();

async function runOnce(kind: MaintenanceJobKind): Promise<void> {
  if (running.has(kind)) {
    console.warn(`[maintenance] ${kind} still running; skipping this tick.`);

    return;
  }

  running.add(kind);

  try {
    await dispatch(kind);
  } finally {
    running.delete(kind);
  }
}

/**
 * How many agents one unattended pass may retire before it stops reading as
 * routine. Small on purpose: a handful is churn, a dozen is an incident.
 */
const MASS_RETIREMENT = 5;

export async function dispatch(kind: MaintenanceJobKind): Promise<void> {
  switch (kind) {
    case 'schedule-scan': {
      // The switch, checked at the consumer as well as at registration — the
      // discipline runDialerSweep already holds. Registration cannot reach a
      // scheduler that already exists in Redis (an older build's, or one
      // orphaned by a renamed id), and a scan that runs with the dialer off
      // records DIALER_DISABLED as a permanent refusal, unscheduling every
      // due campaign.
      if (!env.dialerEnabled) return;

      const { started, refused, errored } = await runScheduleScan();

      if (started || refused || errored) {
        console.log(`[schedule] started=${started} refused=${refused} errored=${errored}`);
      }

      return;
    }

    /**
     * Renewals are money owed, and are gated on nothing.
     *
     * The result is logged rather than discarded, for the reason the timer
     * gave: a pass in which every DID failed used to be indistinguishable from
     * a healthy one outside per-row errors, so "nobody was charged this month"
     * was a thing you found out from a customer.
     */
    case 'did-renewal': {
      const { renewed, pastDue, released, failed, haltedOnReleaseCap } = await runRenewalSweep();

      if (renewed || pastDue || released || failed || haltedOnReleaseCap) {
        console.log(
          `Renewal sweep: renewed=${renewed} pastDue=${pastDue} released=${released} failed=${failed}` +
            (haltedOnReleaseCap ? ' HALTED_ON_RELEASE_CAP' : ''),
        );
      }

      return;
    }

    /**
     * The agent mirror, refreshed on a timer because nothing else refreshes it.
     *
     * `refreshAgent` covers an edit made through this backend, and
     * `syncWorkspaceAgents` covers a workspace whose list somebody happens to
     * open. Neither covers an agent edited on the platform directly, which is
     * the ordinary way a prompt gains a variable — so without this pass the
     * local `variables` can disagree with the platform indefinitely, and the
     * CSV column mapper offers an empty picker for an agent that genuinely
     * declares names.
     *
     * Logged only when it changed something or fell short. A quiet pass every
     * fifteen minutes that announced itself would bury the ones that matter.
     */
    case 'agent-sync': {
      const { synced, removed, truncated } = await syncAllAgents();

      if (removed || truncated) {
        const line =
          `[agents] sync: synced=${synced} removed=${removed}` +
          (truncated ? ' TRUNCATED_LISTING' : '');

        /**
         * A retirement is not a refresh, and this entry point does both.
         *
         * `syncAllAgents` ends in an `updateMany` marking every agent the
         * listing did not mention `removed`, which `agentIsUsable` then treats
         * as unusable — and before this sweep existed that only ever ran when
         * staff pressed a button, with somebody watching. It now runs
         * unattended ninety-six times a day. The coverage floor and the
         * empty-listing guard bound the damage, but they leave a live band: a
         * listing that is complete and non-empty but short retires the
         * remainder, and at info level that is shaped exactly like a routine
         * pass. Anything past a handful gets a level somebody alerts on.
         */
        if (removed > MASS_RETIREMENT) console.error(`${line} MASS_RETIREMENT`);
        else console.log(line);
      }

      return;
    }

    case 'analytics-sync': {
      /**
       * The fact table's incremental walk, behind its own switch.
       *
       * `runAnalyticsSync` joins a pass already in flight rather than starting
       * a second one — the manual refresh route is the other caller and the
       * two overlap by design — so the guard below is belt to its braces. Both
       * stay: the guard is what keeps the *log* honest about a skipped pass.
       */
      // Consumer-side check, same shape as the scan's: a stale scheduler must
      // not spend the shared partner rate limit with the switch off. The gate
      // sits here and not inside runAnalyticsSync, because the manual refresh
      // route is deliberately not gated on the flag — an operator pressing it
      // has asked for a pass.
      if (!env.analyticsSyncEnabled) return;

      await runAnalyticsSync();

      return;
    }

    /**
     * Open supplier payment links, re-read because nothing tells us.
     *
     * The platform has no callback for a paid link, so a link paid at
     * midnight stays CREATED in this mirror until something asks. The
     * console's own poll only runs while somebody has the page open; this is
     * what covers the rest of the day.
     */
    case 'wallet-topup-poll': {
      const { refreshed, credited, expired, failed } = await refreshOpenTopups();

      // Quiet unless something moved: a pass that finds nothing open is the
      // usual case and would bury the one line that says money landed.
      if (credited || expired || failed) {
        console.log(
          `[wallet] top-up poll: refreshed=${refreshed} credited=${credited} ` +
            `expired=${expired} failed=${failed}`,
        );
      }

      return;
    }

    default:
      // Not yet migrated. Each one arrives with its own commit and its own
      // conformance gate, and its timer is deleted only once it is here.
      throw new Error(`[maintenance] no handler for ${kind}`);
  }
}

export function createMaintenanceWorker(): Worker<MaintenanceJobData> {
  const worker = new Worker<MaintenanceJobData>(
    QUEUE_NAMES.MAINTENANCE,
    async (job) => runOnce(job.data.kind),
    { connection: createWorkerConnection(), concurrency: 3 },
  );

  worker.on('failed', (job, err) => {
    console.error(
      `[queue:${QUEUE_NAMES.MAINTENANCE}] ${job?.data?.kind ?? 'unknown'} job ` +
        `${job?.id ?? 'unknown'} attempt ${job?.attemptsMade ?? 0} failed:`,
      err,
    );
  });

  return worker;
}
