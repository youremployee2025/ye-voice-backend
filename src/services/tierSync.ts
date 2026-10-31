import { listVoiceTiers, type UpstreamRecord } from '../adapter/vocobase.js';
import { prisma } from '../lib/prisma.js';
import { readString } from '../lib/upstream.js';

/**
 * Pulls the voice tier catalogue into the local mirror.
 *
 * **Sync owns catalogue facts; staff own pricing and assignment.** The upsert
 * below writes `name`, `status` and `lastSyncedAt` and nothing else. It must
 * never write `defaultPriceCreditsPerMin` or `isDefault` — a routine refresh
 * that reset either would re-rate every account holding the tier, silently,
 * from a button whose label says "Sync". The agent and DID mirrors hold the
 * same invariant for the same reason.
 *
 * Staff-triggered only, and the one call it makes is a read.
 */

export interface TierSyncResult {
  /** Rows the listing accounted for. */
  synced: number;
  /** Rows with no readable slug. Skipped, never stored under a made-up key. */
  skipped: number;
  /** Tiers marked REMOVED because the listing no longer names them. */
  removed: number;
  /**
   * Set when the listing was unusable, so removal detection was skipped and
   * the mirror is knowingly unreconciled. Reported because a run that decided
   * nothing otherwise looks exactly like a run that decided everything was
   * fine.
   */
  truncated: boolean;
}

/** The columns sync owns. Price and default flag are deliberately absent. */
function catalogueFields(row: UpstreamRecord, slug: string) {
  return {
    // Falls back to the slug rather than to an empty string: a tier with a
    // blank name is unreadable in every picker it appears in, and the slug is
    // at least the thing the platform calls it.
    name: readString(row, ['label', 'display_name', 'displayName', 'name']) ?? slug,
    status: 'ACTIVE' as const,
    lastSyncedAt: new Date(),
  };
}

export async function syncVoiceTiers(): Promise<TierSyncResult> {
  const { tiers } = await listVoiceTiers();
  const rows = Array.isArray(tiers) ? tiers : [];

  let synced = 0;
  let skipped = 0;
  const seen: string[] = [];

  for (const row of rows) {
    const slug = readString(row, ['tier', 'slug', 'id']);

    if (!slug) {
      // Counted rather than dropped in silence: a catalogue quietly missing a
      // band is how a whole tier of voices stops being sellable with nothing
      // saying why.
      skipped += 1;
      console.error('Tier listing carried a row with no readable slug; skipped.');
      continue;
    }

    const fields = catalogueFields(row, slug);

    // `create` and `update` carry the same two columns, so a tier that comes
    // back from REMOVED is restored to ACTIVE with the price it had.
    await prisma.tier.upsert({
      where: { slug },
      create: { slug, ...fields },
      update: fields,
    });

    synced += 1;
    seen.push(slug);
  }

  /**
   * An empty listing marks nothing removed.
   *
   * The catalogue has two or three rows on a good day, so there is no coverage
   * ratio to lean on the way the agent sync does — the only signal available
   * is "did we read anything at all". An outage that answered `{}` and was
   * believed would retire every tier and empty the voice picker across the
   * whole product, which is a far worse outcome than a mirror that stays a few
   * minutes stale.
   */
  if (seen.length === 0) {
    console.error('Tier listing returned nothing usable; skipping removal detection this run.');
    return { synced, skipped, removed: 0, truncated: true };
  }

  const { count } = await prisma.tier.updateMany({
    where: { slug: { notIn: seen }, status: 'ACTIVE' },
    data: { status: 'REMOVED' },
  });

  return { synced, skipped, removed: count, truncated: false };
}
