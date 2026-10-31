-- The id Vocobase's `session.completed` carries (`call.call_id`, its PhoneCall
-- id). The routing-policy callback that writes the arrival row never has it —
-- that event carries only the carrier's `provider_call_id` — so it is learned
-- at settle. Nullable and additive: every existing row keeps NULL, and the
-- table is days old, so the unique index builds instantly.
ALTER TABLE "CampaignInboundCall" ADD COLUMN "upstreamPhoneCallId" TEXT;

CREATE UNIQUE INDEX "CampaignInboundCall_upstreamPhoneCallId_key"
  ON "CampaignInboundCall"("upstreamPhoneCallId");
