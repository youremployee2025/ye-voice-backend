/**
 * The operator's end of the hangup-source backfill.
 *
 *   npm run backfill:hangup-source -- --production   # walk until the listing runs out
 *   npm run backfill:hangup-source -- --dry-run
 *   npm run backfill:hangup-source -- --max-pages 50
 *   npm run backfill:hangup-source -- --start-offset 20000   # resume a truncated walk
 *
 * Wiring, and deliberately nothing else: every decision with a consequence
 * lives in `src/services/hangupSourceBackfill.ts`, where it is typechecked and
 * has tests.
 *
 * **Safe to re-run and safe to interrupt.** The walk fills absences only, so a
 * second pass rewrites nothing a first pass or the webhook already wrote, and
 * a run killed halfway leaves the rows it did fill filled.
 *
 * It reads the partner-wide call listing, which every YE customer and every
 * other integrator on the account shares, so it is bounded and says when the
 * bound was what stopped it.
 */
import { backfillHangupSource, BACKFILL_MAX_PAGES } from '../src/services/hangupSourceBackfill.js';
import { prisma } from '../src/lib/prisma.js';
import { guardDatabaseTarget } from '../src/lib/scriptTarget.js';

function flag(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);

  return at === -1 ? null : process.argv[at + 1] ?? '';
}

async function main(): Promise<void> {
  // Said before anything else. Three runs in one day went to the wrong
  // database — `dotenv` loads `.env` from the working directory and does not
  // override a shell variable, so the same command reaches production from one
  // shell and localhost from another with nothing on screen saying which.
  const stop = guardDatabaseTarget({
    url: process.env.DATABASE_URL,
    production: process.argv.includes('--production'),
    dryRun: process.argv.includes('--dry-run'),
  });

  if (stop) {
    console.error(stop);
    process.exit(1);
  }

  const dryRun = process.argv.includes('--dry-run');
  const maxPages = Number(flag('max-pages') ?? BACKFILL_MAX_PAGES);
  const startOffset = Number(flag('start-offset') ?? 0);

  if (!Number.isInteger(maxPages) || maxPages < 1) {
    console.error('--max-pages must be a positive integer.');
    process.exit(1);
  }

  if (!Number.isInteger(startOffset) || startOffset < 0) {
    console.error('--start-offset must be a non-negative integer.');
    process.exit(1);
  }

  // How much there is to do, before doing any of it. An operator deciding
  // whether to spend the shared rate limit deserves the number first.
  const outstanding = await prisma.callAttempt.count({
    where: { hangupSource: null, upstreamCallId: { not: null } },
  });

  console.log(`${outstanding} attempt(s) carry a call id and no hangup source.`);

  if (dryRun) {
    console.log('Dry run: nothing was read from the platform and nothing was written.');

    return;
  }

  const result = await backfillHangupSource({
    maxPages,
    startOffset,
    onPage: ({ pages, scanned, filled }) => {
      // A long walk that says nothing is indistinguishable from a hung one.
      if (pages % 10 === 0) console.log(`  ${pages} page(s), ${scanned} call(s) read, ${filled} filled`);
    },
  });

  console.log(
    `Read ${result.scanned} call(s) over ${result.pages} page(s); filled ${result.filled} attempt(s).`,
  );

  // Said plainly rather than implied. A truncated walk that reads as a
  // complete one is the one outcome forbidden on every listing in this
  // service, and here it would leave an operator believing the column is
  // filled when the oldest calls were never reached.
  if (result.complete) {
    console.log('Every attempt with a call id now carries a source; stopped before the listing ended.');
  }

  if (result.truncated) {
    console.warn(
      `Stopped at the ${result.pages}-page budget with the listing still going. ` +
        `Re-run with --start-offset ${result.nextOffset} to continue from here, or raise --max-pages.`,
    );
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
