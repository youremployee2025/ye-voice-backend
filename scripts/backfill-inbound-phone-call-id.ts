/**
 * The operator's end of the inbound platform-id backfill.
 *
 *   npm run backfill:inbound-call-id                                  # dry run, every campaign
 *   npm run backfill:inbound-call-id -- --campaign cmtw11gux0002ru11xsydcuxa
 *   npm run backfill:inbound-call-id -- --production                  # write
 *
 * Wiring, and deliberately nothing else: every decision with a consequence
 * lives in `src/services/inboundPhoneCallIdBackfill.ts`, where it is
 * typechecked and has tests.
 *
 * **Dry by default.** `--production` is what writes; without it the walk still
 * asks the platform about every candidate id and reports exactly what it would
 * have done, which is the number worth seeing before spending a write.
 *
 * Safe to re-run and safe to interrupt: it fills absences only, so a second
 * pass sees no candidates for the rows the first one filled, and a run killed
 * halfway leaves the rows it did fill filled.
 *
 * One `GET /calls/:id` per candidate row, against the partner-wide listing
 * every YE customer shares. That cost is the point — see the service for why
 * no rule derived from the row itself can tell an imported id from a carrier
 * one.
 */
import { backfillInboundPhoneCallId } from '../src/services/inboundPhoneCallIdBackfill.js';
import { prisma } from '../src/lib/prisma.js';
import { guardDatabaseTarget } from '../src/lib/scriptTarget.js';

function flag(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);

  return at === -1 ? null : (process.argv[at + 1] ?? '');
}

async function main(): Promise<void> {
  const production = process.argv.includes('--production');
  // Dry unless told otherwise, and `--dry-run` is accepted so the command
  // reads the same as every other script here.
  const dryRun = !production;

  // Said before anything else. Three runs in one day went to the wrong
  // database — `dotenv` loads `.env` from the working directory and does not
  // override a shell variable, so the same command reaches production from one
  // shell and localhost from another with nothing on screen saying which.
  const stop = guardDatabaseTarget({ url: process.env.DATABASE_URL, production, dryRun });

  if (stop) {
    console.error(stop);
    process.exit(1);
  }

  const campaignId = flag('campaign') || undefined;

  if (campaignId !== undefined && campaignId === '') {
    console.error('--campaign needs a campaign id.');
    process.exit(1);
  }

  console.log(
    campaignId
      ? `Campaign ${campaignId}.`
      : 'Every campaign — the column is missing everywhere history was imported.',
  );

  const result = await backfillInboundPhoneCallId({
    campaignId,
    dryRun,
    onRow: ({ upstreamCallId, resolved }) => {
      if (!resolved) console.log(`  ${upstreamCallId}: the platform does not know it — left alone`);
    },
  });

  // Both counts, always. "Filled 136" alone would let an operator believe the
  // walk had nothing to refuse, and the refusals are the interesting half:
  // they are the rows whose platform id genuinely was never learned.
  console.log(
    `${result.candidates} candidate(s): ${result.filled} ${dryRun ? 'would be linked' : 'linked'}, ` +
      `${result.unresolved} left alone (no such call upstream)` +
      (result.conflicted > 0 ? `, ${result.conflicted} refused (id already claimed)` : ''),
  );

  if (dryRun) {
    console.log('Dry run: nothing was written. Re-run with --production to apply.');
  }

  if (result.conflicted > 0) {
    // Never silent. Two rows claiming one platform call is the state the settle
    // dedupe exists to prevent, and a run that met it has found something worth
    // looking at by hand.
    console.warn(
      `${result.conflicted} row(s) hold a resolving id that another row already claims. ` +
        'Those were not written — inspect them before deciding which row owns the call.',
    );
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
