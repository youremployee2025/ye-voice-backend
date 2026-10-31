-- The leads export walks a campaign's contacts by keyset on (createdAt, id).
--
-- CampaignContact had no index carrying createdAt, so every page of that walk
-- sorted the campaign's entire contact list before taking its two hundred rows:
-- quadratic in the campaign, on the one export that promises no row cap.
CREATE INDEX "campaign_contacts_export_keyset_idx"
  ON "CampaignContact" ("campaignId", "createdAt", "id");
