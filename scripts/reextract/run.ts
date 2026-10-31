/**
 * The operator's end of a re-extraction.
 *
 *   npm run reextract -- --campaign <id>                 # dry run, pauses each batch
 *   npm run reextract -- --campaign-name "Diwali" --apply
 *   npm run reextract -- --campaign <id> --apply --yes   # unattended
 *   npm run reextract -- --campaign <id> --apply --max-reopened-stops 40
 *
 * Wiring, and deliberately nothing else. Every decision with a consequence —
 * which conversations are re-judged, what a new note does to a contact, what
 * the report says — lives in `src/services/reextraction.service.ts` and
 * `src/lib/reextraction/`, where it is typechecked and has tests. What is left
 * here is the four things a script is for: reading the command line, reading
 * the environment, asking the person at the keyboard whether to go on, and
 * writing the report to a file.
 *
 * Two orderings in here are not incidental.
 *
 * **The environment is validated before the service is imported.** Importing
 * the service pulls in `src/lib/env.ts`, which loads the whole backend's
 * configuration and throws on the first thing it misses — `CLERK_SECRET_KEY`,
 * say. An operator who forgot `SIM_API_KEY` would then be told about Clerk,
 * and would go looking in entirely the wrong place. So the five variables this
 * tool actually needs are checked first, and the backend's own failure is
 * caught and re-stated as what it is.
 *
 * **Everything except the report goes to stderr.** The header, the batch
 * tables, the prompt and the path written. The finished markdown goes to
 * stdout alone, so `npm run reextract -- --campaign x > report.md` yields the
 * report and still shows the operator every batch as it lands.
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';

import {
  CliRefusal,
  USAGE,
  applyPrompt,
  campaignNameError,
  parseArgs,
  readConfig,
  renderHeader,
} from '../../src/lib/reextraction/cli.js';
import type { CampaignCandidate, CliArgs, RunConfig } from '../../src/lib/reextraction/cli.js';
import { fetchDump } from '../../src/lib/reextraction/dump.js';
import { createCompleter } from '../../src/lib/reextraction/model.js';
import type { RunReport } from '../../src/services/reextraction.service.js';

/** Beside this file, and gitignored: a run report names contacts. */
const RUNS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'runs');

/** At most this many campaigns are offered when a name did not resolve. A
 *  refusal that printed four hundred rows is a refusal nobody reads. */
const MAX_CANDIDATES = 10;

function say(line: string): void {
  process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The database client and the run, loaded only once the environment is known
 * to be complete.
 *
 * Dynamic because these two imports are what drag in `src/lib/env.ts`: a
 * static import at the top of the file evaluates before `main` runs a single
 * line, and the careful refusals below would never be reached.
 */
async function load(): Promise<{
  prisma: PrismaClient;
  run: typeof import('../../src/services/reextraction.service.js').runReextraction;
  newRunId: typeof import('../../src/services/reextraction.service.js').newRunId;
}> {
  try {
    const [client, service] = await Promise.all([
      import('../../src/lib/prisma.js'),
      import('../../src/services/reextraction.service.js'),
    ]);

    return { prisma: client.prisma, run: service.runReextraction, newRunId: service.newRunId };
  } catch (error) {
    throw new CliRefusal(
      'reextract: the backend would not load. This tool imports the campaign service, which reads ' +
        'the backend\'s own configuration, so it needs a full backend .env beside the variables ' +
        `above — run it from the repo root.\n  ${messageOf(error)}`,
    );
  }
}

/**
 * The campaign this run is about, resolved before anything is printed about it.
 *
 * A name is resolved here rather than inside the service because it is an
 * operator's convenience, not part of what a re-extraction is: the service
 * takes an id, and every test of it says which campaign it meant. The refusal
 * on an ambiguous name is the whole reason the convenience is safe — two
 * campaigns can share a name, and picking the first would re-arm a thousand
 * contacts of whichever one Prisma happened to return.
 */
async function resolveCampaign(prisma: PrismaClient, args: CliArgs): Promise<CampaignCandidate> {
  const select = { id: true, name: true } as const;

  if (args.campaignId !== null) {
    const campaign = await prisma.campaign.findUnique({ where: { id: args.campaignId }, select });

    if (campaign === null) throw new CliRefusal(`reextract: no campaign has the id ${args.campaignId}.`);

    return campaign;
  }

  const name = args.campaignName ?? '';
  const matches = await prisma.campaign.findMany({
    where: { name },
    select,
    orderBy: { id: 'asc' },
    take: MAX_CANDIDATES,
  });

  if (matches.length === 1) return matches[0]!;

  // Only when nothing matched exactly: a near miss is a guess at a typo, and
  // guessing at one of two exact matches would be worse than not guessing.
  const similar =
    matches.length === 0
      ? await prisma.campaign.findMany({
          where: { name: { contains: name, mode: 'insensitive' } },
          select,
          orderBy: { id: 'asc' },
          take: MAX_CANDIDATES,
        })
      : [];

  throw new CliRefusal(campaignNameError({ name, matches, similar }));
}

/**
 * A yes/no on stderr, defaulting to no on anything that is not `y` — an empty
 * line included. Every question this tool asks is about telephoning several
 * hundred people, and a stray return must stop rather than proceed.
 */
async function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });

  try {
    return (await rl.question(question)).trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

/**
 * The pause between batches. The service does the stopping — this only answers.
 */
async function confirmBatch(summary: { batchNo: number }): Promise<boolean> {
  return ask(`Continue with batch ${summary.batchNo + 1}? [y/N] `);
}

async function writeReport(file: string, report: RunReport): Promise<string> {
  await mkdir(RUNS_DIR, { recursive: true });
  await writeFile(file, report.markdown, 'utf8');

  return file;
}

/**
 * What the shell is told, read off the outcome the run reported.
 *
 * A run the operator ended at a batch boundary did exactly what it was asked
 * to, so it is a zero; so is one whose prompt could not be asked, which stopped
 * without anything having gone wrong with the judging. An abort is a one, and
 * so is a batch abandoned to a model that stopped answering — the one `stopped`
 * that is not a run that worked, and the reason `status` alone is not enough to
 * decide on.
 *
 * Reading `outcome` rather than scanning the rows for a `batch_abandoned` skip
 * matters beyond tidiness: the rows say what happened to each contact, and they
 * carry that reason for every row of the abandoned batch whether or not the run
 * ended there. How the run ended is one fact about the run, and this is where
 * the service records it.
 */
function exitCodeFor(report: RunReport): number {
  const { outcome } = report;

  if (outcome.kind === 'aborted') return 1;

  if (outcome.kind !== 'stopped') return 0;

  // The two `stopped` reasons that are not a run that worked: a model that
  // stopped answering, and a ceiling the operator set being reached.
  return outcome.reason === 'batch_abandoned' || outcome.reason === 'reopened_cap' ? 1 : 0;
}

/**
 * The last line on stderr.
 *
 * The markdown goes to stdout and is usually redirected to a file; the closing
 * line of the report goes with it. So the ending is said once more here, where
 * the operator is actually looking — four endings that a bare exit code cannot
 * tell apart, and two of them share an exit code with something else.
 */
function outcomeLine(report: RunReport): string {
  const { outcome } = report;

  switch (outcome.kind) {
    case 'completed':
      return 'Outcome: completed.';
    case 'stopped':
      return `Outcome: stopped at batch ${outcome.batchNo} (${outcome.reason}).`;
    case 'aborted':
      return `Outcome: aborted during batch ${outcome.batchNo} (${outcome.reason}).`;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(`${USAGE}\n`);

    return 0;
  }

  const config: RunConfig = readConfig(process.env);

  // Without a terminal there is nobody to answer the prompt, and the answer to
  // an unanswered prompt is no — so an unattended run would stop after its
  // first batch and look like an operator had stopped it. Say so instead.
  if (!args.yes && process.stdin.isTTY !== true) {
    throw new CliRefusal(
      'reextract: batches pause for confirmation and stdin is not a terminal; pass --yes to run unattended.',
    );
  }

  const { prisma, run, newRunId } = await load();

  try {
    const campaign = await resolveCampaign(prisma, args);
    const target = { campaignId: campaign.id, campaignName: campaign.name };

    say(
      renderHeader({
        ...target,
        apply: args.apply,
        batchSize: args.batchSize,
        concurrency: args.concurrency,
        yes: args.yes,
      }),
    );

    /**
     * The one question asked before anything is judged.
     *
     * Every other confirmation comes after a batch has been judged and the
     * operator has read what it would do. This one guards the mistake no batch
     * table can catch: a real, paused, perfectly valid campaign that is not the
     * campaign they meant. Without it the first twenty contacts of the wrong
     * one are re-armed before there is anything to read.
     */
    if (args.apply && !args.yes && !(await ask(applyPrompt(target)))) {
      say('reextract: nothing was written.');

      return 0;
    }

    /**
     * The run's file, named and announced before the first batch lands, and
     * appended to as each one does.
     *
     * A run that is killed never writes a finished report — and what it leaves
     * behind is a database with hundreds of contacts re-armed and do-not-call
     * rows deleted. This file is then the only record of which. The finished
     * report overwrites it at the end with the whole document.
     */
    const runId = newRunId();
    const file = path.join(RUNS_DIR, `${campaign.id}-${runId}.md`);

    await mkdir(RUNS_DIR, { recursive: true });
    say(`Appending each batch to ${file}\n`);

    const report = await run(
      {
        campaignId: campaign.id,
        runId,
        apply: args.apply,
        force: args.force,
        concurrency: args.concurrency,
        batchSize: args.batchSize,
        ...(args.maxReopenedStops === null ? {} : { maxReopenedStops: args.maxReopenedStops }),
        fetchDump: (sessionId) => fetchDump(sessionId, { apiUrl: config.apiUrl, token: config.token }),
        complete: createCompleter(config.sim),
        log: say,
        onBatch: (markdown) => appendFile(file, markdown, 'utf8'),
        confirmBatch: args.yes ? undefined : confirmBatch,
      },
      prisma,
    );

    process.stdout.write(report.markdown);
    say(`\nReport written to ${await writeReport(file, report)}`);
    say(outcomeLine(report));

    return exitCodeFor(report);
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => {
    process.exit(code);
  },
  (error: unknown) => {
    // A refusal is the tool declining to start: bad arguments, a missing
    // variable, a campaign that is not there. Two, so a script wrapping this
    // can tell it from a run that started and could not finish. Anything else
    // — a `ReextractionRefused` above all — is named for the tool it came
    // from, since `campaign_is_live: RUNNING` on its own is a line an operator
    // cannot place.
    const refused = error instanceof CliRefusal;

    say(refused ? messageOf(error) : `reextract: ${messageOf(error)}`);
    process.exit(refused ? 2 : 1);
  },
);
