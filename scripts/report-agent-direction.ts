/**
 * The operator's end of the uni/bi rollout check.
 *
 *   npx tsx scripts/report-agent-direction.ts
 *
 * Read-only: it runs one grouped `SELECT` and writes nothing, anywhere, which
 * is why it takes no `--production` flag and no confirmation. The target is
 * printed regardless, because reading the right number off the wrong database
 * is the failure this line exists to prevent.
 *
 * Wiring, and deliberately nothing else: the query and the split live in
 * `src/services/agentDirectionReport.ts`, where they are typechecked and have
 * tests.
 *
 * Run after deploying the `agent_direction_uni_bi` migration. `BI` should be
 * exactly the agents that were `BOTH` before it; `UNI with a face` is the
 * population whose every save now writes both sides, and `BI without a face`
 * should be zero — see the service for why a non-zero count is worth a look
 * rather than a fix.
 */
import { reportAgentDirections } from '../src/services/agentDirectionReport.js';
import { prisma } from '../src/lib/prisma.js';
import { describeDatabaseTarget } from '../src/lib/scriptTarget.js';

function pad(value: string | number, width: number): string {
  return String(value).padStart(width);
}

async function main(): Promise<void> {
  const target = describeDatabaseTarget(process.env.DATABASE_URL);
  console.log(
    `Database: ${target.host ?? '?'}/${target.database ?? '?'}${target.isLocal ? '  (LOCAL)' : ''}`,
  );
  console.log('');

  const { rows, totals } = await reportAgentDirections();

  if (rows.length === 0) {
    // Distinct from a report of zeroes: there are no agents at all, which on
    // a production database is a reason to check the target line above.
    console.log('No agents in the mirror.');
    return;
  }

  const width = Math.max(9, ...rows.map((row) => (row.workspaceName ?? 'unassigned').length));
  console.log(
    `${'workspace'.padEnd(width)}  ${pad('UNI/no face', 12)}  ${pad('UNI/face', 9)}  ${pad('BI', 5)}  ${pad('BI/no face', 11)}`,
  );

  for (const row of rows) {
    console.log(
      `${(row.workspaceName ?? 'unassigned').padEnd(width)}  ${pad(row.uniNoFace, 12)}  ` +
        `${pad(row.uniWithFace, 9)}  ${pad(row.bi, 5)}  ${pad(row.biNoFace, 11)}`,
    );
  }

  console.log(
    `${'TOTAL'.padEnd(width)}  ${pad(totals.uniNoFace, 12)}  ${pad(totals.uniWithFace, 9)}  ` +
      `${pad(totals.bi, 5)}  ${pad(totals.biNoFace, 11)}`,
  );

  if (totals.biNoFace > 0) {
    // Never silent. A bi-directional agent with no face offers an inbound
    // editor for a configuration that does not exist, and nothing in this
    // release can produce one — so it means a face was disabled upstream.
    console.warn(
      `\n${totals.biNoFace} bi-directional agent(s) have no inbound face. Nothing here creates ` +
        'that state, so it means a face was disabled on the platform directly — those agents ' +
        'offer an inbound editor for a configuration that is not there.',
    );
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
