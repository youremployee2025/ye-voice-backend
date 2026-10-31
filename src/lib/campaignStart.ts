import { ApiError, type ErrorCode } from './errors.js';
import { env } from './env.js';
import { prisma } from './prisma.js';
import { evaluateWindow } from './dialingWindow.js';
import { phoneNumberIsUsable } from './phoneNumberVisibility.js';
import { resolveCallRate } from './dialerPricing.js';
import { TierRateUnavailableError } from './tierPricing.js';
import { voicelinkCallReady } from '../adapter/vocobase.js';
import type { CampaignWithAgent } from './campaign.js';

/**
 * Everything that must be true before a campaign may start dialing.
 *
 * The campaigns slice deliberately left `start` as a state transition that
 * placed no call and required no number, on the grounds that the dialer would
 * decide what it actually needs. This is that decision, and it is the moment
 * `start` stops being a local write and begins reaching the voice platform.
 *
 * **Order matters.** Every local gate runs first and the single upstream call
 * runs last, so a start that is going to be refused never touches the
 * platform — no routing built for a campaign that cannot run, no write against
 * a shared partner account on behalf of a request that was invalid anyway.
 */

/**
 * Readiness states that stop a DID being an outbound caller id, mapped to
 * sentences a customer can act on.
 *
 * The platform's own `action_items` labels name the supplier, and which
 * supplier sits under this product is not something a customer learns from an
 * error — the two-registers rule every other message string here follows.
 *
 * `NO_VOCOBASE_AGENT` is deliberately **absent**. It means the platform's own
 * phone-number row has no agent bound, which governs *inbound* routing; this
 * dialer places outbound calls with an explicit `from_number` and an explicit
 * `agent_id`, so it is not a blocker and refusing on it would make every
 * campaign unstartable for a reason that does not apply to it.
 */
const BLOCKING_READINESS: Record<string, string> = {
  NO_CLIENT_MAPPING:
    'This number has not been set up for outbound calling yet. Contact support to have it enabled.',
  NO_BOT: 'This number is not connected for outbound calling yet. Contact support to finish setup.',
  ROUTING_MISSING: 'Outbound calling is not routed for this number yet. Contact support to finish setup.',
  ROUTING_CHANGED: 'Outbound routing for this number needs attention. Contact support to restore it.',
  REMOTE_DID_EXPIRED: 'This number has expired with the carrier and can no longer place calls.',
  REMOTE_DID_DELETED: 'This number is no longer served by the carrier and cannot place calls.',
  NOT_IMPORTED: 'This number is not available for outbound calling yet. Contact support to enable it.',
};

/**
 * One local gate, as a fact rather than a throw.
 *
 * `httpStatus` and `code` carry the refusal `start` raises for this gate, so
 * the throwing door and the reporting door cannot disagree about what a
 * failure means.
 */
export type StartCheckKey =
  | 'dialer'
  | 'caller_number'
  | 'dialing_window'
  | 'voice_tier'
  | 'credits';

export type StartCheck =
  | { key: StartCheckKey; label: string; status: 'ok'; detail: null; code: null; httpStatus: null }
  | {
      key: StartCheckKey;
      label: string;
      status: 'blocked';
      detail: string;
      code: ErrorCode;
      httpStatus: number;
    };

/** Operator-facing names. The key is the contract; this is the heading. */
const CHECK_LABELS: Record<StartCheckKey, string> = {
  dialer: 'Outbound calling',
  caller_number: 'Caller number',
  dialing_window: 'Dialing window',
  voice_tier: 'Call pricing',
  credits: 'Credit balance',
};

const passed = (key: StartCheckKey): StartCheck => ({
  key,
  label: CHECK_LABELS[key],
  status: 'ok',
  detail: null,
  code: null,
  httpStatus: null,
});

const failed = (
  key: StartCheckKey,
  httpStatus: number,
  code: ErrorCode,
  detail: string,
): StartCheck => ({ key, label: CHECK_LABELS[key], status: 'blocked', detail, code, httpStatus });

/**
 * The local gates, read out instead of thrown.
 *
 * Nothing here reaches the network, so assembling this costs one round trip to
 * the database and leaves no trace anywhere else — which is what lets a
 * read-only endpoint serve it on every load of the review screen.
 *
 * **One list, two doors.** `assertCampaignDialable` throws the first blocked
 * entry; `GET .../preflight` reports all of them. A second copy of these
 * predicates written for the report would pass its own tests forever while
 * drifting from the refusal that actually stops a start, so there is one copy
 * and both callers consume it.
 *
 * **Order is the contract.** The entries come back in the order the gates were
 * checked when this function threw on the first failure, because that order
 * decides which refusal an operator sees when two things are wrong at once.
 *
 * Every entry is evaluated, so a blocked gate no longer short-circuits the
 * ones after it: that costs the workspace read and the rate resolution on a
 * start already doomed — both local, both cheap — and buys a review screen
 * that lists everything to fix rather than one thing per attempt.
 *
 * The upstream readiness step is deliberately **not** here.
 * `ensureCallerNumberReady` *makes* a DID usable rather than asking whether it
 * is, and a preview must not write to a partner account every customer shares.
 * A start can therefore still fail after a clean report, and the review screen
 * says so rather than promising otherwise.
 */
export async function campaignStartChecks(campaign: CampaignWithAgent): Promise<StartCheck[]> {
  const checks: StartCheck[] = [];

  // The master switch, checked on the customer path as well as in the sweep.
  // Letting a campaign go RUNNING while nothing dials would make the campaigns
  // page assert something false about the customer's own data — the one
  // outcome this product's conventions forbid everywhere else.
  checks.push(
    env.dialerEnabled
      ? passed('dialer')
      : failed(
          'dialer',
          409,
          'DIALER_DISABLED',
          'Outbound calling is turned off on this deployment, so this campaign cannot start.',
        ),
  );

  /**
   * A caller number is required — the decision the campaigns slice deferred to
   * this one.
   *
   * `from_number` must name a number active on the connection, so a campaign
   * without one would dial from whatever the connection happens to default
   * to: some other customer's caller id, on somebody else's published business
   * number.
   */
  checks.push(
    campaign.phoneNumber && phoneNumberIsUsable(campaign.phoneNumber, campaign.workspaceId)
      ? passed('caller_number')
      : failed(
          'caller_number',
          409,
          'CAMPAIGN_PHONE_NUMBER_REQUIRED',
          'Choose a phone number for this campaign to call from before starting it.',
        ),
  );

  // A window that is not a window. Fail closed here as well as in the sweep,
  // so the operator learns at the click rather than from a pause a minute
  // later.
  const window = evaluateWindow(campaign, new Date());

  checks.push(
    window.state === 'incomplete'
      ? failed(
          'dialing_window',
          409,
          'CAMPAIGN_WINDOW_INCOMPLETE',
          `This campaign's dialing window is missing ${window.reason}. Complete it before starting.`,
        )
      : passed('dialing_window'),
  );

  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: campaign.workspaceId },
    select: { owner: { select: { id: true, credits: true } } },
  });

  /**
   * Resolvable, not merely present. A freshly synced tier is unpriced, and
   * unpriced is not free.
   *
   * Only `TierRateUnavailableError` is a blocked gate. Anything else is a
   * fault in the pricing read itself and propagates, because reporting "call
   * pricing is fine" off a failed lookup would be the report asserting
   * something it does not know.
   */
  let tierUnpriced = false;

  try {
    await resolveCallRate(workspace.owner.id, campaign.agent?.voiceTierSlug ?? null);
  } catch (err) {
    if (!(err instanceof TierRateUnavailableError)) throw err;

    tierUnpriced = true;
  }

  checks.push(
    tierUnpriced
      ? failed(
          'voice_tier',
          409,
          'CAMPAIGN_RATE_UNAVAILABLE',
          'Calling is not priced for this account yet. Contact support before starting a campaign.',
        )
      : passed('voice_tier'),
  );

  // Checked before the first call rather than at charge time, because a call
  // is charged minutes after it is placed.
  checks.push(
    workspace.owner.credits < env.dialerMinBalanceCredits
      ? failed(
          'credits',
          402,
          'INSUFFICIENT_CREDITS',
          'This workspace does not have enough credits to start calling. Top up to continue.',
        )
      : passed('credits'),
  );

  return checks;
}

/**
 * The local gates. Throws the first failure.
 *
 * The order `campaignStartChecks` returns is what makes "first" meaningful:
 * with two gates blocked, the refusal an operator sees is the earlier one,
 * exactly as it was when this function tested them inline.
 */
export async function assertCampaignDialable(campaign: CampaignWithAgent): Promise<void> {
  for (const check of await campaignStartChecks(campaign)) {
    if (check.status === 'blocked') {
      throw new ApiError(check.httpStatus, check.code, check.detail);
    }
  }
}

/**
 * Makes the campaign's DID usable as a caller id, idempotently.
 *
 * Done at **start** rather than at rent time: renting is an internal
 * book-keeping act that creates nothing upstream, and a number nobody dials
 * from should not have routing built for it. Re-running it is free — every
 * step reports `already` when there is nothing to do.
 *
 * **This is the last thing `start` does**, after every local gate, so a
 * refused start never writes to the shared partner account.
 */
export async function ensureCallerNumberReady(did: string): Promise<void> {
  const result = await voicelinkCallReady(did);

  if (result.ready === true) return;

  const issues = result.readiness?.issues ?? [];

  for (const issue of issues) {
    const message = BLOCKING_READINESS[issue];
    if (message) throw new ApiError(409, 'CAMPAIGN_DID_NOT_CALL_READY', message);
  }

  /**
   * `ready: false` with nothing blocking in it.
   *
   * Reached when the only outstanding issue is one this dialer does not need —
   * `NO_VOCOBASE_AGENT` today — so the campaign starts. An unrecognised issue
   * is logged rather than refused: the readiness vocabulary is the platform's
   * and it grows, and turning next month's new state into a hard refusal would
   * stop every campaign starting for a reason nobody here has considered.
   */
  if (issues.length > 0) {
    console.warn(`[dialer] ${did} reports non-blocking readiness issues: ${issues.join(', ')}`);
  }
}
