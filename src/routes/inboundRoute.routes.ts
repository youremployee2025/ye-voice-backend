import { Router } from 'express';
import express from 'express';
import { verifyInboundRoute } from '../lib/inboundRouteSignature.js';
import { decideInboundRoute, type InboundRouteDecision } from '../services/inboundRouteDecide.js';
import { readRecord, readString } from '../lib/upstream.js';

/**
 * The inbound routing-policy endpoint the platform calls before it creates a
 * session for an incoming call.
 *
 * Mounted OUTSIDE `/api`, BEFORE `express.json`, with its own `express.raw`:
 * the signature is over the exact bytes, so the body must reach the verifier
 * unparsed. Its verifier is the sibling of the outcome-webhook one, with its
 * own secret and header.
 */
export const inboundRouteRoutes: Router = Router();

const ANSWER_BLANK: InboundRouteDecision = { action: 'ANSWER_WITH_AI' };

/**
 * The arrival writes still in flight after their responses went out. A test
 * seam, the shape `flushNotifications` has: production never waits on it.
 */
const inflight = new Set<Promise<void>>();

export async function flushInboundArrivals(): Promise<void> {
  await Promise.allSettled([...inflight]);
}

inboundRouteRoutes.post(
  '/',
  express.raw({ type: '*/*', limit: '256kb' }),
  async (req, res) => {
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

    const verified = verifyInboundRoute(
      raw,
      req.headers['x-vocobase-signature'],
      req.headers['x-vocobase-timestamp'],
    );
    if (!verified.ok) {
      res.status(401).json({ success: false, error: { code: 'WEBHOOK_UNVERIFIED', message: 'Unverified.' } });
      return;
    }

    // Fail open, always: a slow query, a parse error, a deploy blip must degrade
    // to an agent answering without variables — never a dropped customer call.
    // `failure_action` upstream is ANSWER_WITH_AI, and this is its local twin.
    try {
      const body = JSON.parse(raw.toString('utf8')) as unknown;
      const root = readRecord(body, ['call', 'data']) ?? (typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {});
      // Accept the two numbers at the top level or nested under call/data.
      const source = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

      const fromNumber = readString(source, ['from_number', 'fromNumber']) ?? readString(root, ['from_number', 'fromNumber']);
      const toNumber = readString(source, ['to_number', 'toNumber']) ?? readString(root, ['to_number', 'toNumber']);

      if (!fromNumber || !toNumber) {
        res.json(ANSWER_BLANK);
        return;
      }

      const callId =
        readString(source, ['call_id', 'callId', 'provider_call_id']) ??
        readString(root, ['call_id', 'callId', 'provider_call_id']);
      const sessionId =
        readString(source, ['session_id', 'sessionId']) ?? readString(root, ['session_id', 'sessionId']);

      const { decision, record } = await decideInboundRoute({ fromNumber, toNumber, callId, sessionId });
      // Respond FIRST. The caller hears everything after `res.json` as nothing
      // at all, and everything before it as ring time. The arrival row is
      // best-effort here; the settle recreates it from the claim if this
      // write never lands (`campaignInbound.ts`).
      res.json(decision);
      if (record) {
        const pending: Promise<void> = record()
          .catch((err) => console.error('[inbound-route] arrival row not written:', err))
          .finally(() => inflight.delete(pending));
        inflight.add(pending);
      }
    } catch (err) {
      console.error('[inbound-route] decide failed; answering unseeded:', err);
      res.json(ANSWER_BLANK);
    }
  },
);
