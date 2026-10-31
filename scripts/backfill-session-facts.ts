/**
 * The operator's end of the session-facts backfill: the conversation, the
 * variables each dial went out with, whether audio exists, and the carrier's
 * own billed duration.
 *
 *   npm run backfill:session -- --campaign <id> --production
 *   npm run backfill:session -- --campaign <id> --dry-run
 *   npm run backfill:session -- --campaign <id> --max-calls 2000
 *   npm run backfill:session -- --campaign <id> --inbound --production
 *
 * `--inbound` walks the campaign's `CampaignInboundCall` rows instead of its
 * dials: the conversation and the recording flag, keyed on the platform's own
 * call id. Same budget, same resume, same one-request-per-call cost.
 *
 * Wiring only; every decision with a consequence lives in
 * `src/services/sessionBackfill.ts`, where it is typechecked and has tests.
 *
 * **This walk costs one upstream request per call**, because the call listing
 * carries no transcript — unlike the hangup-source backfill, which reads the
 * listing and costs one per hundred. So it is scoped to one campaign, bounded,
 * and refuses to run without being told which.
 *
 * Safe to re-run and safe to interrupt: it fetches only attempts nothing has
 * been recovered for, so a second pass costs nothing for the rows a first pass
 * finished.
 */
import {
  backfillInboundSessionFacts,
  backfillSessionFacts,
  BACKFILL_MAX_CALLS,
} from '../src/services/sessionBackfill.js';
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

  const campaignId = flag('campaign');

  if (!campaignId) {
    console.error('Usage: npm run backfill:session -- --campaign <campaignId> [--inbound] [--dry-run] [--max-calls N]');
    process.exit(1);
  }

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, name: true, status: true },
  });

  if (!campaign) {
    console.error(`No campaign ${campaignId}.`);
    process.exit(1);
  }

  const maxCalls = Number(flag('max-calls') ?? BACKFILL_MAX_CALLS);

  if (!Number.isInteger(maxCalls) || maxCalls < 1) {
    console.error('--max-calls must be a positive integer.');
    process.exit(1);
  }

  // How much there is to do, and what it will cost, BEFORE spending any of it.
  // One request per call against a limit every customer on the platform
  // shares is a number an operator is entitled to see first.
  const inbound = process.argv.includes('--inbound');
  const outstanding = inbound
    ? await prisma.campaignInboundCall.count({
        where: { campaignId: campaign.id, upstreamPhoneCallId: { not: null }, recordingAvailable: null },
      })
    : await prisma.callAttempt.count({
        where: { campaignId: campaign.id, upstreamCallId: { not: null }, recordingAvailable: null },
      });

  console.log(`Campaign: ${campaign.name} (${campaign.status})${inbound ? ' — inbound calls' : ''}`);
  console.log(`${outstanding} call(s) to recover — one upstream request each.`);

  if (process.argv.includes('--dry-run')) {
    console.log('Dry run: nothing was read from the platform and nothing was written.');

    return;
  }

  const result = await (inbound ? backfillInboundSessionFacts : backfillSessionFacts)({
    campaignId: campaign.id,
    maxCalls,
    onProgress: ({ fetched, filled, gone, pending }) => {
      if (fetched % 100 === 0) {
        console.log(`  ${fetched} fetched, ${filled} recovered, ${gone} gone, ${pending} still processing`);
      }
    },
  });

  console.log(
    `Fetched ${result.fetched} of ${result.candidates}; recovered ${result.filled}, ${result.gone} no longer on the platform.`,
  );

  // Said plainly. `gone` is the number that matters most on an old campaign:
  // it is how much of the history the platform no longer holds, and no later
  // run will recover it.
  // Expected at the head of a walk over a campaign that is still dialing, and
  // harmless: those rows are untouched, so a later run picks them up.
  if (result.pending > 0) {
    console.log(
      `${result.pending} call(s) had not finished post-call processing and were left alone. ` +
        'Re-run later to pick them up.',
    );
  }

  if (result.gone > 0) {
    console.warn(
      `${result.gone} call(s) the platform no longer has. Those conversations are not recoverable.`,
    );
  }

  if (result.truncated) {
    console.warn(`Stopped at the ${maxCalls}-call budget. Re-run to continue, or raise --max-calls.`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
