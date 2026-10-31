import { prisma } from '../lib/prisma.js';
import { startCampaign } from './campaignStart.js';

/**
 * Firing the starts somebody scheduled.
 *
 * A **scanner**, not a timer per campaign: the schedule lives entirely in
 * `Campaign.scheduledStartAt`, so a process restart cannot lose one, cancelling
 * is a column update, and rescheduling needs no bookkeeping anywhere. What it
 * costs is precision — a start is up to one tick late — which for a campaign
 * somebody scheduled for 9am tomorrow is not a cost at all.
 */

/**
 * Campaigns one pass will start.
 *
 * A blast-radius limit rather than a throughput setting, the same shape as the
 * dialer's per-sweep cap. A tick that finds more simply finishes them on the
 * next one, thirty seconds later.
 */
const SCHEDULE_BATCH_SIZE = 20;

export interface ScheduleScanResult {
  started: number;
  /** Refused by a gate. The reason is now in `scheduleError` and will not be
   *  retried. */
  refused: number;
  /** Threw. The schedule is still standing and the next tick tries again. */
  errored: number;
}

export async function runScheduleScan({ now = new Date() }: { now?: Date } = {}): Promise<ScheduleScanResult> {
  const result: ScheduleScanResult = { started: 0, refused: 0, errored: 0 };

  const due = await prisma.campaign.findMany({
    where: { status: 'DRAFT', scheduledStartAt: { lte: now } },
    select: { id: true, workspaceId: true },
    orderBy: { scheduledStartAt: 'asc' },
    take: SCHEDULE_BATCH_SIZE,
  });

  for (const campaign of due) {
    // Per campaign, so one workspace's bad row cannot stop the platform's
    // schedules — the same rule the dialer sweep and the renewal sweep hold.
    try {
      // No overrides. A scheduled start uses the values the campaign was saved
      // with; there is nobody present to have typed anything else.
      const outcome = await startCampaign({
        campaignId: campaign.id,
        workspaceId: campaign.workspaceId,
      });

      if (outcome.ok) {
        result.started += 1;
        console.log(`[schedule] started campaign ${campaign.id}`);
        continue;
      }

      result.refused += 1;

      /**
       * A refusal is final, and it is recorded rather than retried.
       *
       * Retrying would re-run the same gates against the same campaign every
       * thirty seconds forever, and every one of them would refuse for the
       * same reason. The schedule is cleared and the reason written down,
       * because the only record the operator gets of what happened overnight
       * is this column.
       *
       * **Guarded on DRAFT**: between the read and this write an operator may
       * have started the campaign by hand and won the race, and clearing the
       * schedule of a campaign that is now RUNNING would stamp a stale failure
       * onto a start that succeeded.
       */
      await prisma.campaign.updateMany({
        where: { id: campaign.id, status: 'DRAFT' },
        data: { scheduledStartAt: null, scheduleError: outcome.message },
      });

      console.warn(`[schedule] start of campaign ${campaign.id} refused: ${outcome.message}`);
    } catch (err) {
      result.errored += 1;

      // `scheduledStartAt` is deliberately left standing. A throw here is a
      // dropped connection or a bug, not a decision about this campaign, and
      // the next tick is thirty seconds away.
      console.error(`[schedule] start of campaign ${campaign.id} errored:`, err);
    }
  }

  return result;
}
