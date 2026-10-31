import { Router } from 'express';
import express from 'express';
import { asyncHandler } from '../lib/errors.js';
import { verifyWebhook } from '../lib/webhookSignature.js';
import { readRecord, readString } from '../lib/upstream.js';
import { HANDLED_WEBHOOK_EVENTS } from '../services/webhookOutcome.js';

/**
 * Where call outcomes arrive.
 *
 * Mounted outside `/api`, with no Clerk and no workspace middleware: the caller
 * is the voice platform, not a person, and the signature is the whole of the
 * authentication.
 *
 * **The raw body matters.** A signature covers the exact bytes received, and a
 * parsed-and-restringified object is a different string — key order,
 * whitespace and number formatting all move. So this router carries its own
 * `express.raw` and is mounted **before** `express.json()` in `app.ts`.
 *
 * ## Verify here, work elsewhere
 *
 * This handler verifies the signature, enqueues the verified event, and
 * answers 200. Nothing else happens on the request path.
 *
 * It used to do the whole thing inline, and the reason given was a good one:
 * the effect is a credit charge, and a background job that dies takes the
 * charge with it, whereas a non-2xx brings a delivery the platform retries
 * four more times over eight hours. That argument was about a *timer-shaped*
 * background, where "job" meant a floating promise in a process that might be
 * redeployed under it. The queue is not that. A job is durable in Redis before
 * this handler answers, it is retried five times with backoff on its own, and
 * the outcome it applies is exactly-once through the event key
 * `applyTerminalOutcome` writes inside the same transaction as the charge. A
 * delivery that never lands is still reconciled by the reaper against the
 * platform's own record, which is the recovery path that already existed.
 *
 * What is bought is the slowest handler in the service leaving the request
 * path of a partner's retrying sender: a charge, a contact resolution and a
 * campaign lock no longer sit between the platform and its 200.
 *
 * **Verification never moves.** An event that fails it is rejected with the
 * status it has always been rejected with and is never enqueued, so everything
 * in that queue is known to have come from the platform.
 *
 * ## What an unknown call means
 *
 * This endpoint is **account-wide** on a partner account YE shares, so it
 * receives every other integrator's completions too — transcripts included. An
 * event that correlates to no attempt of ours is logged by id and answered
 * 200, and **nothing about it is persisted or written to a log in full**. That
 * is the same rule the calls surface holds, where a call matching neither the
 * agent leg nor the campaign leg is absent rather than forbidden.
 */

/**
 * How long a delivery waits for the queue before being refused.
 *
 * Long enough for a healthy Redis round trip with room to spare; short enough
 * that an outage answers the sender inside its own delivery timeout, so the
 * failure lands on the retry path rather than in a socket count.
 */
const ENQUEUE_TIMEOUT_MS = 5_000;

export const webhookRoutes: Router = Router();

webhookRoutes.post(
  '/vocobase',
  // Its own parser, and `type: '*/*'` so a delivery with an unexpected
  // Content-Type is still verified rather than arriving as an empty object
  // that fails the signature for the wrong reason.
  express.raw({ type: '*/*', limit: '1mb' }),
  asyncHandler(async (req, res) => {
    const verdict = verifyWebhook(
      req.body as Buffer,
      req.headers['x-webhook-signature'],
      req.headers['x-webhook-timestamp'],
    );

    if (!verdict.ok) {
      // The reason is logged, never returned. Telling an unauthenticated
      // caller which half of the check they failed is free help toward
      // passing it.
      console.warn(`[webhook] rejected a delivery: ${verdict.reason}`);
      res.status(401).json({
        success: false,
        error: { code: 'WEBHOOK_UNVERIFIED', message: 'Could not verify that request.' },
      });
      return;
    }

    let payload: unknown;

    try {
      payload = JSON.parse((req.body as Buffer).toString('utf8'));
    } catch {
      // A 400 rather than a 500: the body is the caller's, and retrying an
      // unparseable one four more times helps nobody.
      res.status(400).json({
        success: false,
        error: { code: 'MALFORMED_JSON', message: 'That request body is not JSON.' },
      });
      return;
    }

    const event = readString(payload, ['event']);
    const data = readRecord(payload, ['data']);

    /**
     * Enqueued only for the events this platform acts on.
     *
     * Everything else — WhatsApp events, transfers, anything the platform adds
     * later — is acknowledged and dropped here rather than posted and dropped
     * by a worker. The endpoint declares an event allowlist upstream, but an
     * endpoint that 500s on an event it did not expect would be retried into
     * an incident by the platform's own policy; and a queue that carries jobs
     * whose only outcome is to do nothing is a queue whose depth means nothing.
     */
    if (event && data && HANDLED_WEBHOOK_EVENTS.has(event)) {
      /**
       * Imported here rather than at the top of the file, so that building the
       * app does not open a Redis connection.
       *
       * Constructing a `Queue` connects, and `createApp()` is called by every
       * test in the suite and by an API process that may be running no workers
       * at all. The module cache makes this free after the first delivery.
       */
      const { webhookProcessingQueue } = await import('../lib/queue/queues.js');

      /**
       * Bounded, and a failure is a **503**, never a hang and never a 200.
       *
       * With Redis unreachable this promise can simply never settle — the
       * queue connection retries forever by design (BullMQ requires
       * `maxRetriesPerRequest: null`), and `Queue.add` waits on readiness
       * before it ever issues a command — and a request that never answers
       * holds a socket per delivery while telling the sender nothing. The
       * platform's retry policy — four more deliveries over eight hours — is
       * the recovery path for an outage, and it fires on a non-2xx; a
       * timeout is the one shape of failure it may not count. 503 rather
       * than 500, because the event was verified and well-formed: the
       * failure is availability, and the remedy is redelivery.
       */
      const enqueued = await Promise.race([
        webhookProcessingQueue
          .add('webhook', {
            kind: 'webhook',
            event,
            data,
            // The delivery's own instant, carried so that every timestamp the
            // work writes is a fact about the call rather than about when the
            // queue got round to it.
            receivedAtIso: new Date().toISOString(),
          })
          .then(
            () => 'added' as const,
            (error: unknown) => {
              console.error('[webhooks] enqueue failed', error);

              return 'failed' as const;
            },
          ),
        new Promise<'timed-out'>((resolve) => {
          const timer = setTimeout(() => resolve('timed-out'), ENQUEUE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);

      if (enqueued !== 'added') {
        res.status(503).json({
          success: false,
          error: {
            code: 'QUEUE_UNAVAILABLE',
            message: 'The delivery could not be accepted. Please retry.',
          },
        });

        return;
      }
    }

    res.status(200).json({ success: true, data: { received: true } });
  }),
);
