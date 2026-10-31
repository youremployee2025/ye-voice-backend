import { Router } from 'express';
import { requireStaffToken } from '../../middleware/adminToken.js';
import { asyncHandler } from '../../lib/errors.js';
import { env } from '../../lib/env.js';

/**
 * What the background queues are doing, for whoever is on the other end of a
 * "campaigns have stopped dialing" message.
 *
 * The question that call always starts with is which half is broken — the
 * engine or the thing that runs it — and until now there was no way to answer
 * it from outside the process. A `waiting` count climbing with `active` at
 * zero says the workers are down. `failed` climbing with `waiting` flat says
 * they are up and the work is throwing. Those are different pages in the
 * middle of the night.
 *
 * Counts only. No job payloads: a `webhook-processing` job carries a phone
 * number and a `call-placement` job carries a contact, and neither belongs in
 * a response that exists to answer an operational question.
 */

export const adminQueueRoutes: Router = Router();

adminQueueRoutes.use(requireStaffToken);

adminQueueRoutes.get(
  '/queues',
  asyncHandler(async (_req, res) => {
    // Imported here rather than at the top of the file, for the same reason
    // webhooks.routes.ts does it: constructing a `Queue` connects, and this
    // router is mounted into the app unconditionally, so a static import
    // would open a Redis connection the moment `app.js` is evaluated — in
    // every test and in an API process running no workers at all. The module
    // cache makes this free after the first request.
    const { ALL_QUEUES } = await import('../../lib/queue/queues.js');

    /**
     * Reported before the counts, because it is the first thing that explains
     * them. Every queue reading zero on a process with the workers switched
     * off is correct and uninteresting; the same reading with them switched on
     * is the incident.
     */
    const queues = await Promise.all(
      ALL_QUEUES.map(async (queue) => ({
        name: queue.name,
        // `paused` is a queue-level state rather than a job count, so it is
        // reported separately from the five that are.
        counts: await queue.getJobCounts(
          'waiting',
          'active',
          'completed',
          'failed',
          'delayed',
        ),
        paused: await queue.isPaused(),
      })),
    );

    res.json({
      data: {
        workersEnabled: env.workersEnabled,
        dialerEnabled: env.dialerEnabled,
        queues,
      },
    });
  }),
);
