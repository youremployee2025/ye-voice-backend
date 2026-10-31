import type { Scenario } from '../scenario.js';
import { basicDrain } from './01-basic-drain.js';
import { concurrency } from './02-concurrency.js';
import { retryMatrix } from './03-retry-matrix.js';
import { retryBudgetLowering } from './04-retry-budget-lowering.js';
import { callbacks } from './05-callbacks.js';
import { dialWindow } from './06-dial-window.js';
import { lifecycle } from './07-lifecycle.js';
import { exactlyOnce } from './08-exactly-once.js';
import { transientFaults } from './09-transient-faults.js';
import { stuckCleanup } from './10-stuck-cleanup.js';
import { billing } from './11-billing.js';
import { rotation } from './12-rotation.js';
import { laneBudgets } from './13-lane-budgets.js';
import { goalFollowUps } from './14-goal-followups.js';
import { goalTiming } from './15-goal-timing.js';
import { goalOptoutReplay } from './16-goal-optout-replay.js';
import { followUpLane } from './17-follow-up-lane.js';

export const SCENARIOS: Scenario[] = [
  basicDrain,
  concurrency,
  retryMatrix,
  retryBudgetLowering,
  callbacks,
  dialWindow,
  lifecycle,
  exactlyOnce,
  transientFaults,
  stuckCleanup,
  billing,
  rotation,
  laneBudgets,
  goalFollowUps,
  goalTiming,
  goalOptoutReplay,
  followUpLane,
];
