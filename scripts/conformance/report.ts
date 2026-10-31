import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './boot.js';
import type { RunResult } from './scenario.js';

/**
 * Verdict base per matrix row, from the conformance design doc: a row whose
 * checks all pass grades as its base; any violation downgrades it to
 * DIVERGES-BUG for that run.
 */
export const ROW_BASE: Record<string, 'MATCHES' | 'DIVERGES-DELIBERATE'> = {
  D1: 'MATCHES', D2: 'MATCHES', D3: 'MATCHES', D4: 'MATCHES',
  D5: 'DIVERGES-DELIBERATE', D6: 'DIVERGES-DELIBERATE',
  D7: 'MATCHES', D8: 'MATCHES', D9: 'MATCHES', D10: 'DIVERGES-DELIBERATE',
  X1: 'MATCHES', X2: 'MATCHES', X3: 'DIVERGES-DELIBERATE', X4: 'DIVERGES-DELIBERATE', X5: 'MATCHES',
  R1: 'MATCHES', R2: 'MATCHES', R3: 'MATCHES', R4: 'MATCHES', R5: 'MATCHES',
  CB1: 'MATCHES', CB2: 'MATCHES', CB3: 'MATCHES', CB4: 'MATCHES', CB5: 'MATCHES',
  CB6: 'DIVERGES-DELIBERATE',
  W1: 'DIVERGES-DELIBERATE', W2: 'MATCHES', W3: 'MATCHES',
  L1: 'MATCHES', L2: 'MATCHES', L3: 'MATCHES', L4: 'MATCHES', L5: 'MATCHES',
  L6: 'MATCHES', L7: 'MATCHES', L8: 'MATCHES',
  S1: 'DIVERGES-DELIBERATE', S2: 'MATCHES', S3: 'DIVERGES-DELIBERATE', S4: 'MATCHES',
  B1: 'MATCHES', B2: 'DIVERGES-DELIBERATE', B3: 'MATCHES', B4: 'DIVERGES-DELIBERATE',
  N1: 'MATCHES', N2: 'MATCHES',
  /**
   * Goal campaigns, graded against the call note the bot returns at the end
   * of each call — `call_outcome_vocobaseplatform`,
   * `immediate_callback_needed_vocobaseplatform`,
   * `callback_requested_time_vocobaseplatform` and
   * `next_call_instructions_vocobaseplatform` — rather than against any
   * field it happened to fill. The engine should do exactly what the design
   * says, so every base here is MATCHES:
   *
   *   G1  three conversations, a note written on each, `completed` on the
   *       third — the first dial carrying nothing from YE (the retired
   *       `campaign_goal` included: the objective lives in the agent's own
   *       prompt) and every later dial carrying exactly
   *       `next_call_instructions_vocobaseplatform` = the PREVIOUS call's
   *       note.
   *   G2  an `incomplete` past the FOLLOW-UP budget (`maxGoalFollowUps`)
   *       settles COMPLETED/false. The retries are a separate budget, and a
   *       contact that has answered cannot spend them.
   *   G3  the retry budget spent on silences: it beats the note, and a silence
   *       at the cap stays FAILED.
   *   G4  `stop` on the first call settles at once and lists the number for
   *       THIS campaign only; a second campaign still dials it.
   *   G5  `incomplete`+`flexible` rolls into the dial window,
   *       `incomplete`+`requested` is moved to the promised time read from the
   *       platform's `YYYY-MM-DDTHH:mm±HH` form, and a null note is a follow-up
   *       on the campaign's own cooldown ladder with the journey saying "no
   *       outcome" rather than guessing.
   *   G6  the decision waits for the event that carries the note, and is
   *       taken once. **The regression gate for this wave**: it fails if a goal
   *       campaign's connected contact is resolved on the classified
   *       `call.status.updated` that precedes `session.completed`.
   *   G7  `incomplete`+`immediate` (the call dropped mid-conversation) re-arms
   *       at the fixed `IMMEDIATE_CALLBACK_MINUTES` (three minutes), not on
   *       the cooldown ladder — rolled into the window, armed
   *       `RESUME` and claimed on the resume lane: `followUpCount` moves,
   *       `attempts` does not, `callbackAt` stays null because nobody asked
   *       for this call, and the next dial carries the dropped call's note.
   */
  G1: 'MATCHES', G2: 'MATCHES', G3: 'MATCHES', G4: 'MATCHES', G5: 'MATCHES', G6: 'MATCHES',
  G7: 'MATCHES',
};

export interface ScenarioSummary {
  scenario: string;
  rows: string[];
  runs: number;
  failedRuns: number;
  totalDials: number;
  wallMs: number;
  violations: Array<{ run: number; seed: number; row: string; detail: string }>;
}

export function summarize(results: RunResult[], rows: string[]): ScenarioSummary {
  const violations = results.flatMap((r) =>
    r.violations.map((v) => ({ run: r.runIndex, seed: r.seed, row: v.row, detail: v.detail })),
  );
  return {
    scenario: results[0]!.scenario,
    rows,
    runs: results.length,
    failedRuns: new Set(results.filter((r) => r.violations.length > 0).map((r) => r.runIndex)).size,
    totalDials: results.reduce((s, r) => s + r.dials, 0),
    wallMs: results.reduce((s, r) => s + r.wallMs, 0),
    violations,
  };
}

export function writeResults(summaries: ScenarioSummary[], results: RunResult[]): string {
  const dir = path.join(REPO_ROOT, 'scripts', 'conformance-results');
  mkdirSync(dir, { recursive: true });

  const rowVerdicts = new Map<string, { base: string; violated: string[] }>();
  for (const [row, base] of Object.entries(ROW_BASE)) {
    rowVerdicts.set(row, { base, violated: [] });
  }
  for (const s of summaries) {
    for (const v of s.violations) {
      rowVerdicts.get(v.row)?.violated.push(`${s.scenario} run ${v.run}: ${v.detail}`);
      if (!rowVerdicts.has(v.row)) {
        rowVerdicts.set(v.row, { base: 'MATCHES', violated: [`${s.scenario} run ${v.run}: ${v.detail}`] });
      }
    }
  }

  const lines: string[] = ['# Conformance run results', ''];
  lines.push('## Scenarios', '');
  lines.push('| Scenario | Rows | Runs | Failed runs | Dials | Wall time |');
  lines.push('|---|---|---|---|---|---|');
  for (const s of summaries) {
    lines.push(
      `| ${s.scenario} | ${s.rows.join(' ')} | ${s.runs} | ${s.failedRuns} | ${s.totalDials} | ${(s.wallMs / 1000).toFixed(1)}s |`,
    );
  }
  lines.push('', '## Verdicts', '');
  lines.push('| Row | Verdict |');
  lines.push('|---|---|');
  const graded = new Set(summaries.flatMap((s) => s.rows));
  for (const [row, v] of rowVerdicts) {
    // A row no scenario grades is stated, never silently dropped — a table
    // whose row count quietly differs from ROW_BASE is how three documents
    // came to carry three different totals. D5 (sweep cadence) is graded by
    // configuration inspection, and the table should say so.
    if (!graded.has(row) && v.violated.length === 0) {
      lines.push(`| ${row} | ${v.base} (not machine-graded: configuration inspection) |`);
      continue;
    }
    lines.push(`| ${row} | ${v.violated.length > 0 ? 'DIVERGES-BUG' : v.base} |`);
  }
  const allViolations = summaries.flatMap((s) => s.violations.map((v) => ({ ...v, scenario: s.scenario })));
  if (allViolations.length > 0) {
    lines.push('', '## Violations', '');
    for (const v of allViolations) {
      lines.push(`- **${v.row}** (${v.scenario} run ${v.run}, seed ${v.seed}): ${v.detail}`);
    }
  }
  lines.push('');

  const summaryPath = path.join(dir, 'latest.md');
  writeFileSync(summaryPath, lines.join('\n'));

  // A trace per failing run, for repro reading.
  for (const r of results) {
    if (r.violations.length === 0) continue;
    const p = path.join(dir, `${r.scenario}-run${r.runIndex}-seed${r.seed}.trace.txt`);
    writeFileSync(p, `${r.violations.map((v) => `${v.row}: ${v.detail}`).join('\n')}\n\n${r.trace}\n`);
  }
  return summaryPath;
}
