import type { Backend } from './boot.js';
import {
  apiClient,
  drainPlacementQueue,
  drainWebhookQueue,
  mockClient,
  truncateAll,
  seedCampaign,
  seedWorkspace,
  type ApiResponse,
  type CampaignSpec,
  type MockState,
  type SeededCampaign,
  type SeededWorkspace,
  type SeedOptions,
} from './lib.js';
import { diffIntoTrace, renderTrace, takeSnapshot, type Snapshot, type TraceEvent } from './trace.js';

/**
 * The virtual clock starts at real wall-clock now (per process, rounded to a
 * second). It cannot be a fixed instant: the engine's webhook and charge
 * paths stamp real `new Date()` timestamps, and the reaper compares the
 * injected sweep time against them — a virtual origin in the future would
 * make every live attempt look hours old (instant reaping), one in the past
 * would make every cooldown already elapsed. Scenarios advance from here.
 */
export const T0 = Date.now() - (Date.now() % 1000);
export const MINUTE = 60_000;

export interface Scenario {
  name: string;
  /** Matrix rows this scenario grades (ids from the conformance design doc). */
  rows: string[];
  /** Default number of repetitions (concurrency-sensitive scenarios run more). */
  runs: number;
  run(d: Driver): Promise<void>;
}

export class Violation {
  constructor(
    public row: string,
    public detail: string,
  ) {}
}

/**
 * The per-run driver: virtual clock, sweep/advance orchestration, trace
 * assembly, and check recording. One Driver per scenario run, on a truncated
 * database and a reset mock.
 */
export class Driver {
  nowMs = T0;
  trace: TraceEvent[] = [];
  violations: Violation[] = [];
  notes: string[] = [];
  private prev: Snapshot | null = null;
  private lastMock: MockState | null = null;

  constructor(
    public backend: Backend,
    public seed: number,
  ) {}

  /* ---------------- clock ---------------- */

  now(): Date {
    return new Date(this.nowMs);
  }

  /** Moves virtual time forward (never backward). */
  advanceBy(ms: number): void {
    this.nowMs += ms;
  }

  /* ---------------- orchestration ---------------- */

  /**
   * One engine tick at the current virtual instant: fire everything the mock
   * owes up to now, run `sweeps` concurrent dispatch passes, **let the calls
   * those passes posted actually be placed**, let the mock deliver what they
   * provoked, and record the delta into the trace.
   *
   * The drain is where a tick stopped being one thing. A pass is now a tick
   * plus the placements it posted, and the drain is what makes this harness
   * observe the whole of it — the same world state, at the same virtual
   * instant, as when the tick dialed inline.
   *
   * It sits **before** the second `advance`, deliberately: the mock cannot
   * deliver a webhook for a call that has not been placed, and a drain after
   * the advance would leave every dial one tick behind its own outcome.
   */
  async tick(sweeps = 1): Promise<void> {
    await this.deliverPending();
    const now = this.now();
    await Promise.all(
      Array.from({ length: sweeps }, () => this.backend.runDialerSweep({ now })),
    );
    await drainPlacementQueue(this.backend);
    await this.deliverPending();
    await this.snapshot();
  }

  /**
   * Fires everything the mock owes up to now, and waits until it has been
   * *applied* rather than merely delivered.
   *
   * A scenario that samples the world between passes has to call this rather
   * than `mockClient.advance` alone. A delivery used to do its work on the
   * request thread, so an advance that had returned was an advance whose
   * outcomes were in the database; now the handler verifies and enqueues, and
   * the charge, the contact resolution and the callback happen on the webhook
   * worker. Without the drain, a sample taken straight after an advance sees
   * the world as it was before the calls resolved — every retry still counted
   * as live, and no lane ever observed as due.
   */
  async deliverPending(): Promise<void> {
    await mockClient.advance(this.nowMs);
    await drainWebhookQueue(this.backend);
  }

  /** Records the current world state delta into the trace without ticking. */
  async snapshot(): Promise<void> {
    const state = await mockClient.state();
    const snap = await takeSnapshot(this.backend, state);
    diffIntoTrace(this.trace, this.nowMs, this.prev, snap, state, this.backend);
    this.prev = snap;
    this.lastMock = state;
  }

  /**
   * Ticks with `stepMs` between passes until no contact is PENDING/QUEUED/
   * CALLING and the mock has nothing live or queued, or maxTicks elapse.
   */
  async drain(opts: { stepMs?: number; maxTicks?: number } = {}): Promise<number> {
    const { stepMs = MINUTE, maxTicks = 200 } = opts;
    for (let i = 0; i < maxTicks; i++) {
      await this.tick();
      const unfinished = await this.backend.prisma.campaignContact.count({
        where: { status: { in: ['PENDING', 'QUEUED', 'CALLING'] } },
      });
      const mock = this.lastMock!;
      if (unfinished === 0 && mock.active === 0 && mock.pending_timeline === 0) return i + 1;
      this.advanceBy(stepMs);
    }
    return opts.maxTicks ?? 200;
  }

  /* ---------------- seeding + API ---------------- */

  async seedWorkspace(options: SeedOptions): Promise<SeededWorkspace> {
    return seedWorkspace(this.backend, options);
  }

  async seedCampaign(ws: SeededWorkspace, spec: CampaignSpec): Promise<SeededCampaign> {
    return seedCampaign(this.backend, ws, spec);
  }

  api(ws: SeededWorkspace) {
    return apiClient({ clerkUserId: ws.clerkUserId, email: ws.email });
  }

  async start(ws: SeededWorkspace, campaignId: string): Promise<ApiResponse> {
    const res = await this.api(ws)('POST', `/workspaces/${ws.workspaceId}/campaigns/${campaignId}/start`);
    if (res.status !== 200) {
      throw new Error(`campaign start refused (${res.status}): ${JSON.stringify(res.body)}`);
    }
    return res;
  }

  /** Scripts the mock's dial rules for a set of numbers. */
  async script(body: Record<string, unknown>): Promise<void> {
    await mockClient.script(body);
  }

  async mockState(): Promise<MockState> {
    return mockClient.state();
  }

  /* ---------------- checks ---------------- */

  check(row: string, ok: boolean, detail: string): void {
    if (!ok) this.violations.push(new Violation(row, detail));
  }

  note(text: string): void {
    this.notes.push(text);
  }

  /** The suite-wide invariants every scenario asserts at the end. */
  async checkGlobalInvariants(): Promise<void> {
    const mock = this.lastMock ?? (await this.mockState());
    this.check('GLOBAL', mock.breaches.length === 0, `mock concurrency breaches: ${mock.breaches.join('; ')}`);
    this.check(
      'GLOBAL',
      mock.webhookFailures.length === 0,
      `webhook deliveries failed: ${mock.webhookFailures.join('; ')}`,
    );
    for (const [ref, count] of Object.entries(mock.refCounts)) {
      this.check('X2', count === 1, `reference ${ref} dialed ${count} times`);
    }
  }

  renderTrace(): string {
    return renderTrace(this.trace, T0);
  }
}

export interface RunResult {
  scenario: string;
  runIndex: number;
  seed: number;
  wallMs: number;
  ticks: number | null;
  dials: number;
  violations: Violation[];
  notes: string[];
  trace: string;
}

/**
 * A clean world for one run: the queues quiesced, the database emptied, the
 * mock reset to `T0` with `seed`, and a fresh Driver on top. Exported so the
 * campaign simulator's driver starts from exactly the state a conformance
 * run does, without repeating the steps (and their ordering) there.
 */
export async function prepareRun(backend: Backend, seed: number): Promise<Driver> {
  // Nothing from the previous run may still be in flight when its rows are
  // deleted underneath it.
  await drainPlacementQueue(backend);
  await drainWebhookQueue(backend);
  await truncateAll(backend);
  await mockClient.reset(seed, T0);
  return new Driver(backend, seed);
}

export async function runScenario(
  backend: Backend,
  scenario: Scenario,
  runIndex: number,
  seed: number,
): Promise<RunResult> {
  const startedAt = Date.now();
  const driver = await prepareRun(backend, seed);
  try {
    await scenario.run(driver);
    await driver.checkGlobalInvariants();
  } catch (err) {
    driver.violations.push(new Violation('ABORT', `scenario threw: ${(err as Error)?.stack ?? err}`));
  }
  const dials = driver.trace.filter((e) => e.kind === 'dial').length;
  return {
    scenario: scenario.name,
    runIndex,
    seed,
    wallMs: Date.now() - startedAt,
    ticks: null,
    dials,
    violations: driver.violations,
    notes: driver.notes,
    trace: driver.renderTrace(),
  };
}
