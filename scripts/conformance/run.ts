/**
 * Campaign-engine conformance suite entry point.
 *
 *   npm run conformance                 # every scenario, its default runs
 *   npm run conformance -- --scenario basic-drain
 *   npm run conformance -- --runs 1    # override repetitions (debugging)
 *   npm run conformance -- --seed 42   # base seed
 *
 * Requires the local sim Postgres (localhost:5436, database
 * ye_voice_conformance, migrations deployed) and nothing else running on
 * ports 3941/4021 — those are the defaults; `HARNESS_*` in the shell moves
 * them, within the allowlist `boot.ts` documents. Never touches any remote
 * system: the DB pinning, the loopback-only mock, and the port preflight all
 * hard-abort otherwise.
 */
import { loadBackend } from './boot.js';
import { preflight, startServers } from './lib.js';
import { runScenario, type Scenario } from './scenario.js';
import { summarize, writeResults, type ScenarioSummary } from './report.js';
import type { RunResult } from './scenario.js';
import { SCENARIOS } from './scenarios/index.js';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const only = arg('scenario');
  const runsOverride = arg('runs') ? Number(arg('runs')) : undefined;
  const baseSeed = arg('seed') ? Number(arg('seed')) : 1000;

  const chosen: Scenario[] = SCENARIOS.filter((s) => !only || s.name === only);
  if (chosen.length === 0) {
    console.error(`No scenario named ${only}. Have: ${SCENARIOS.map((s) => s.name).join(', ')}`);
    process.exit(2);
  }

  await preflight();
  const backend = await loadBackend();
  const servers = await startServers(backend);

  const summaries: ScenarioSummary[] = [];
  const allResults: RunResult[] = [];
  let failed = false;
  try {
    for (const scenario of chosen) {
      const runs = runsOverride ?? scenario.runs;
      const results: RunResult[] = [];
      for (let i = 1; i <= runs; i++) {
        const seed = baseSeed + i * 17;
        const result = await runScenario(backend, scenario, i, seed);
        results.push(result);
        allResults.push(result);
        const status = result.violations.length === 0 ? 'ok' : `FAIL (${result.violations.length})`;
        console.log(
          `[${scenario.name}] run ${i}/${runs} seed=${seed} ${status} ` +
            `dials=${result.dials} wall=${(result.wallMs / 1000).toFixed(1)}s ${result.notes.join('; ')}`,
        );
        for (const v of result.violations) {
          console.log(`    ${v.row}: ${v.detail.split('\n')[0]}`);
          failed = true;
        }
      }
      summaries.push(summarize(results, scenario.rows));
    }
  } finally {
    await servers.stop();
    await backend.prisma.$disconnect();
  }

  const summaryPath = writeResults(summaries, allResults);
  console.log(`\nresults: ${summaryPath}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
