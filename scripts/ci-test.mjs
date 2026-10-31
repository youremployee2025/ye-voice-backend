// CI test runner: one full pass, then one re-run of only the failed files.
//
// The suite is known to fail a fraction of full runs on cross-file bleed —
// state one file leaves behind failing an unrelated file. Vitest's --retry
// re-runs the test inside the same polluted worker, which is exactly what
// does not help; re-running the failed FILES gives each a fresh worker and a
// clean database reset. A file that fails on the re-run too is a real
// failure, and the job fails.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';

const REPORT = 'vitest-report.json';

function runVitest(files) {
  const args = [
    'vitest',
    'run',
    '--reporter=default',
    '--reporter=json',
    `--outputFile=${REPORT}`,
    ...files,
  ];
  return spawnSync('npx', args, { stdio: 'inherit' });
}

function failedFiles() {
  let report;
  try {
    report = JSON.parse(readFileSync(REPORT, 'utf8'));
  } catch {
    return null; // no parseable report — the run crashed rather than failed
  }
  const files = new Set();
  for (const result of report.testResults ?? []) {
    if (result.status === 'failed') files.add(result.name);
  }
  return [...files];
}

const first = runVitest([]);
if (first.status === 0) {
  rmSync(REPORT, { force: true });
  process.exit(0);
}

const failed = failedFiles();
rmSync(REPORT, { force: true });

if (!failed || failed.length === 0) {
  console.error('[ci-test] first pass failed without a parseable failure report — not retrying.');
  process.exit(first.status ?? 1);
}

console.error(`\n[ci-test] first pass failed in ${failed.length} file(s); re-running only those once:`);
for (const file of failed) console.error(`  - ${file}`);

const second = runVitest(failed);
rmSync(REPORT, { force: true });

if (second.status === 0) {
  console.error('[ci-test] re-run passed — first-pass failures were flake (known cross-file bleed).');
  process.exit(0);
}

console.error('[ci-test] failed on the re-run as well — treating as a real failure.');
process.exit(second.status ?? 1);
