import { env } from '../env.js';
import {
  campaignCleanupQueue,
  campaignDispatchQueue,
  maintenanceQueue,
} from './queues.js';
import { REPEATABLE_JOB_IDS } from './types.js';

/**
 * The recurring schedules, registered once per instance and therefore many
 * times over.
 *
 * That repetition is the point rather than a wart. Every instance runs this on
 * boot, and BullMQ keys a schedule by the id given here — so the second
 * instance's registration *replaces* the first's rather than adding to it, and
 * ten replicas produce one dial sweep a minute, not ten. `test/queue-
 * repeatable.test.ts` asserts that rather than trusting it.
 *
 * It also means an interval change takes effect on the next deploy without
 * anybody clearing Redis: the same id re-registered with a new `every` moves
 * the existing schedule. Changing an **id** does not — that orphans the old
 * schedule and leaves it firing. The ids live in `types.ts` with a note saying
 * exactly that.
 *
 * The switches below decide what is registered at all, and they mean what they
 * have always meant.
 */
export async function registerRepeatableJobs(): Promise<void> {
  /**
   * The dial sweep, and the schedule scan behind the same switch.
   *
   * With the dialer off, neither runs — for the reason the timer version
   * documented: `startCampaign` refuses every scheduled start with
   * `DIALER_DISABLED`, and a scanner faithfully recording that as a permanent
   * refusal would clear the schedule of every campaign somebody set for
   * tonight. A deployment that cannot dial should leave those schedules
   * standing.
   *
   * **The off branch removes as well as skips.** A job scheduler is
   * persistent Redis state: once registered it fires forever, whether or not
   * the process that registered it still boots this branch. Under the timers,
   * not starting the interval genuinely stopped it; here, "don't register" on
   * its own would leave a scheduler from the previous deploy firing with the
   * switch off — which is exactly the wipe described above. Removing a
   * scheduler that does not exist is a no-op, so a fresh Redis is safe.
   */
  if (env.dialerEnabled) {
    await campaignDispatchQueue.upsertJobScheduler(
      REPEATABLE_JOB_IDS.CAMPAIGN_DISPATCH,
      { every: env.dialerSweepMs },
      { data: { kind: 'dispatch-tick' } },
    );

    await maintenanceQueue.upsertJobScheduler(
      REPEATABLE_JOB_IDS.SCHEDULE_SCAN,
      { every: env.scheduleScanMs },
      { data: { kind: 'schedule-scan' } },
    );
  } else {
    await campaignDispatchQueue.removeJobScheduler(REPEATABLE_JOB_IDS.CAMPAIGN_DISPATCH);
    await maintenanceQueue.removeJobScheduler(REPEATABLE_JOB_IDS.SCHEDULE_SCAN);
  }

  /**
   * The cleanup sweep runs whether or not this deployment may dial.
   *
   * It places no call — it reconciles attempts an earlier deployment placed,
   * and those need closing precisely when dialing has been turned off.
   */
  await campaignCleanupQueue.upsertJobScheduler(
    REPEATABLE_JOB_IDS.CAMPAIGN_CLEANUP,
    { every: env.campaignCleanupMs },
    { data: { kind: 'cleanup-tick' } },
  );

  /** Renewals are money owed, and are not gated on anything. */
  await maintenanceQueue.upsertJobScheduler(
    REPEATABLE_JOB_IDS.DID_RENEWAL,
    { every: env.didRenewalSweepMs },
    { data: { kind: 'did-renewal' } },
  );

  /**
   * The agent mirror, ungated.
   *
   * No switch, because there is no configuration in which a stale mirror is
   * the right answer: it places no call and spends no credit, and the local
   * copy is what the product reads variables and voices out of.
   */
  await maintenanceQueue.upsertJobScheduler(
    REPEATABLE_JOB_IDS.AGENT_SYNC,
    { every: env.agentSyncIntervalMs },
    { data: { kind: 'agent-sync' } },
  );

  /**
   * Open supplier payment links, ungated.
   *
   * There is no callback for a paid link: it becomes CREDITED only because
   * something re-read it. This is what makes a link paid overnight show up
   * before anyone opens the console. It places no call and spends no credit,
   * and a pass reads only the links that are still live — see
   * `refreshOpenTopups` for why that is not the supplier's five.
   */
  await maintenanceQueue.upsertJobScheduler(
    REPEATABLE_JOB_IDS.WALLET_TOPUP_POLL,
    { every: env.walletTopupPollMs },
    { data: { kind: 'wallet-topup-poll' } },
  );

  // Symmetric for the same reason as the dialer pair: a scheduler left over
  // from a deploy that had the switch on would keep walking the shared
  // partner listing against a rate limit every customer shares.
  if (env.analyticsSyncEnabled) {
    await maintenanceQueue.upsertJobScheduler(
      REPEATABLE_JOB_IDS.ANALYTICS_SYNC,
      { every: env.analyticsSyncIntervalMs },
      { data: { kind: 'analytics-sync' } },
    );
  } else {
    await maintenanceQueue.removeJobScheduler(REPEATABLE_JOB_IDS.ANALYTICS_SYNC);
  }
}
