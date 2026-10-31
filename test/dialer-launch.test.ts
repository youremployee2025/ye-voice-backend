import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/adapter/vocobase.js', () => ({
  startCall: vi.fn(),
  getConcurrency: vi.fn(),
  getCall: vi.fn(),
  // The managed goal block comes off the agent when the sweep completes a
  // goal campaign, which is one read and one write upstream.
  getAgent: vi.fn(),
  updateAgent: vi.fn(),
}));

const { getAgent, getCall, getConcurrency, startCall, updateAgent } =
  await import('../src/adapter/vocobase.js');
const { withGoalBlock } = await import('../src/lib/goalPromptBlock.js');
const { FOLLOW_UP_NOTE } = await import('../src/lib/goalVariables.js');
const { YE_CONTEXT_VARIABLE_NAMES } = await import('../src/lib/contextVariables.js');
const { runDialerPass, clearPlacements, closePlacementQueue } = await import('./dialer-pass.js');
const { stopCampaign } = await import('../src/lib/campaignLifecycle.js');
const { prisma } = await import('../src/lib/prisma.js');
const { ApiError } = await import('../src/lib/errors.js');
const { flushNotifications } = await import('../src/lib/notify.js');
const { toInternalCredits } = await import('../src/lib/credits.js');
const { truncateAll } = await import('./setup.js');
const { makeAccount, makeAgent, makeWorkspace, makePhoneNumber } = await import('./helpers.js');

const mockedStartCall = vi.mocked(startCall);
const mockedGetConcurrency = vi.mocked(getConcurrency);
const mockedGetCall = vi.mocked(getCall);
const mockedGetAgent = vi.mocked(getAgent);
const mockedUpdateAgent = vi.mocked(updateAgent);

/**
 * The variables the CONTACT PROJECTION produced, with the four reserved
 * campaign-context names taken off.
 *
 * Every assertion that uses it is about the projection — which column became
 * which variable — and the context stamp is orthogonal to all of them.
 * Stripping it here rather than widening the `toEqual`s into `toMatchObject`
 * keeps them exact: a projection that grows a key it should not have still
 * fails, which is the whole point of asserting the map's output whole.
 *
 * The stamp itself is asserted in its own describe, against the campaign and
 * contact it names.
 */
function projected(sent: { variables?: Record<string, string> }): Record<string, string> {
  const rest = { ...(sent.variables ?? {}) };
  for (const name of YE_CONTEXT_VARIABLE_NAMES) delete rest[name];
  return rest;
}

const NOW = new Date('2026-08-30T10:00:00Z');

/**
 * Distinguishes one seeded workspace from another within a single test.
 *
 * A DID is unique across the platform and the tier catalogue holds one row per
 * slug, so a fixture that hard-codes both can only be called once — and the
 * campaign-level refusals need two campaigns in one pass to show that pausing
 * one does not stop the other.
 */
let seeded = 0;

async function seed(contacts = 1, concurrencyLimit = 5) {
  seeded += 1;
  const account = await makeAccount(`l${Math.random().toString(36).slice(2, 7)}`);
  await prisma.account.update({
    where: { id: account.id },
    data: { credits: toInternalCredits('100'), concurrencyLimit: 10 },
  });

  const workspace = await makeWorkspace(account, 'Launchers');
  const agent = await makeAgent(workspace, 'caller');
  await prisma.agent.update({
    where: { id: agent.id },
    data: { voiceTierSlug: 'va-pro', variables: ['name', 'city'] },
  });
  await prisma.tier.upsert({
    where: { slug: 'va-pro' },
    update: {},
    create: {
      slug: 'va-pro',
      name: 'Pro',
      defaultPriceCreditsPerMin: toInternalCredits('1.00'),
      billingIncrementSecs: 30,
      isDefault: true,
    },
  });
  const did = await makePhoneNumber(workspace, `+9180112233${String(43 + seeded).slice(-2)}`, 'ASSIGNED');

  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: workspace.id,
      name: 'Outreach',
      agentId: agent.id,
      phoneNumberId: did.id,
      status: 'RUNNING',
      concurrencyLimit,
      // Three dials in total: the first, plus two retries.
      retryCount: 2,
      cooldownMinutes: 30,
    },
  });

  const links: string[] = [];

  for (let i = 0; i < contacts; i += 1) {
    const contact = await prisma.contact.create({
      data: {
        workspaceId: workspace.id,
        phone: `+91987650${String(2000 + i).slice(-4)}`,
        name: `Contact ${i}`,
        metadata: { city: 'Pune', unused_column: 'ignored' },
      },
    });
    const link = await prisma.campaignContact.create({
      data: { campaignId: campaign.id, contactId: contact.id },
    });
    links.push(link.id);
  }

  return { campaignId: campaign.id, links, did: did.did, agentExternalId: agent.externalId };
}

beforeEach(async () => {
  await truncateAll();
  await clearPlacements();
  vi.clearAllMocks();
  mockedGetConcurrency.mockResolvedValue({ limit: 100, active: 0, remaining: 100 });
  mockedGetCall.mockResolvedValue(null);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  await flushNotifications();
  await truncateAll();
  vi.restoreAllMocks();
});

afterAll(closePlacementQueue);

describe('the launch request', () => {
  it('sends the campaign’s agent, number and a four-segment reference', async () => {
    mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1', status: 'pending' });
    const { campaignId, links, did, agentExternalId } = await seed();

    await runDialerPass({ now: NOW });

    const sent = mockedStartCall.mock.calls[0]![0]!;
    expect(sent.agent_id).toBe(agentExternalId);
    expect(sent.from_number).toBe(did);
    expect(sent.provider).toBe('voicelink');

    const attempt = await prisma.callAttempt.findFirstOrThrow({ where: { campaignId } });
    expect(sent.client_reference_id).toBe(`ezo:${campaignId}:${links[0]}:${attempt.id}`);
  });

  /**
   * The platform requires variable keys to match the agent's declared names,
   * and a contact's metadata is whatever columns the customer's CSV happened
   * to carry. Sending it whole would put arbitrary customer data on a request
   * that has no use for it.
   */
  it('sends only the variables the agent declares', async () => {
    mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
    await seed();

    await runDialerPass({ now: NOW });

    const sent = mockedStartCall.mock.calls[0]![0]!;
    expect(projected(sent)).toEqual({ name: 'Contact 0', city: 'Pune' });
    expect(sent.variables).not.toHaveProperty('unused_column');
  });

  it('records the platform’s ids on the attempt', async () => {
    mockedStartCall.mockResolvedValue({ call_id: 'c_9', session_id: 's_9', status: 'pending' });
    const { campaignId } = await seed();

    await runDialerPass({ now: NOW });

    const attempt = await prisma.callAttempt.findFirstOrThrow({ where: { campaignId } });
    expect(attempt.upstreamCallId).toBe('c_9');
    expect(attempt.upstreamSessionId).toBe('s_9');
    expect(attempt.status).toBe('QUEUED');
    // Snapshotted at dial time, so re-pricing the tier mid-call cannot change
    // what this call costs. The increment travels with the rate for the same
    // reason and from the same resolution — a call billed at one plan's rate
    // and another's pulse is billed on a plan nobody sold.
    expect(attempt.rateCreditsPerMin).toBe(toInternalCredits('1.00'));
    expect(attempt.billingIncrementSecs).toBe(30);
  });

  /**
   * The campaign's own mapping, when it has one.
   *
   * The agent's declared list is an allow-list over keys the CSV already named
   * correctly; a `variableMap` is the operator saying which column feeds which
   * variable, and the two answer different questions. So a campaign carrying a
   * map is projected through the map ALONE — running both would put a column
   * on the wire under two names, one of which the operator deliberately
   * renamed away from.
   */
  it('projects through the campaign’s variable map instead of the agent’s list', async () => {
    mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
    const { campaignId, links } = await seed();
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { variableMap: { city: 'lead_city', unused_column: 'note' } },
    });

    await runDialerPass({ now: NOW });

    const sent = mockedStartCall.mock.calls[0]![0]!;
    expect(projected(sent)).toEqual({ lead_city: 'Pune', note: 'ignored' });
    // The agent declares `name`, and the map does not name it. The map wins.
    expect(sent.variables).not.toHaveProperty('name');

    // Untouched by any of this: the correlation key is what a webhook finds
    // its attempt by, and it has four segments whatever the variables say.
    const attempt = await prisma.callAttempt.findFirstOrThrow({ where: { campaignId } });
    expect(sent.client_reference_id).toBe(`ezo:${campaignId}:${links[0]}:${attempt.id}`);
  });

  /**
   * A mapped column the contact does not carry sends an empty string rather
   * than being omitted. The operator mapped it, so the agent's prompt
   * references it — and a variable the prompt names but the request omits is
   * the platform's own error, not a quietly shorter payload.
   */
  it('sends an empty string for a mapped column the contact has no value for', async () => {
    mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
    const { campaignId } = await seed();
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { variableMap: { city: 'lead_city', never_uploaded: 'lead_stage' } },
    });

    await runDialerPass({ now: NOW });

    expect(projected(mockedStartCall.mock.calls[0]![0]!))
      .toEqual({ lead_city: 'Pune', lead_stage: '' });
  });

  /** Set-but-empty is a map, and a map replaces the projection. An operator
   *  who cleared every row asked for no variables, not for the old defaults. */
  it('sends no variables when the map is set and empty', async () => {
    mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
    const { campaignId } = await seed();
    await prisma.campaign.update({ where: { id: campaignId }, data: { variableMap: {} } });

    await runDialerPass({ now: NOW });

    expect(projected(mockedStartCall.mock.calls[0]![0]!)).toEqual({});
  });

  /**
   * The four columns the importer lifts OUT of metadata onto the contact —
   * `phone`, `name`, `email`, `tags` — are still mappable.
   *
   * `contacts-csv.ts` stores every column as metadata EXCEPT those four, which
   * become columns of their own. Resolving a map against metadata alone would
   * therefore make exactly the columns every spreadsheet carries the ones that
   * cannot be mapped: "Name" would send an empty string on every call for the
   * life of the campaign, and the operator would have no way to see why.
   *
   * The contact's own columns win over a metadata key of the same name, which
   * is the precedence the legacy projection already uses.
   */
  it('resolves a mapped column the importer lifted onto the contact', async () => {
    mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
    const { campaignId, links } = await seed();
    const link = await prisma.campaignContact.findUniqueOrThrow({ where: { id: links[0]! } });
    await prisma.contact.update({
      where: { id: link.contactId },
      data: { email: 'asha@example.test', tags: ['vip', 'lapsed'] },
    });
    await prisma.campaign.update({
      where: { id: campaignId },
      data: {
        variableMap: {
          name: 'customer_name',
          email: 'customer_email',
          tags: 'customer_tags',
          phone: 'customer_phone',
        },
      },
    });

    await runDialerPass({ now: NOW });

    const contact = await prisma.contact.findUniqueOrThrow({ where: { id: link.contactId } });
    expect(projected(mockedStartCall.mock.calls[0]![0]!)).toEqual({
      customer_name: 'Contact 0',
      customer_email: 'asha@example.test',
      customer_tags: 'vip, lapsed',
      customer_phone: contact.phone,
    });
  });

  /**
   * A campaign that maps something unrelated must not lose the contact's name.
   *
   * This is the regression that makes the rule above matter: the moment ANY
   * map is saved, the agent-declared projection stops running — so a source
   * that could not see `contact.name` would drop it from every call on a
   * campaign whose operator only meant to add a city.
   */
  it('keeps the name reachable on a campaign that maps something else', async () => {
    mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
    const { campaignId } = await seed();
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { variableMap: { city: 'lead_city', name: 'name' } },
    });

    await runDialerPass({ now: NOW });

    expect(projected(mockedStartCall.mock.calls[0]![0]!))
      .toEqual({ lead_city: 'Pune', name: 'Contact 0' });
  });

  /** A contact column that is genuinely empty is still an empty string, not an
   *  omission: the operator mapped it, so the prompt names it. */
  it('sends an empty string for a mapped contact column with no value', async () => {
    mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
    const { campaignId } = await seed();
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { variableMap: { email: 'customer_email' } },
    });

    await runDialerPass({ now: NOW });

    expect(projected(mockedStartCall.mock.calls[0]![0]!)).toEqual({ customer_email: '' });
  });

  /** Metadata is uploaded free text, but nothing guarantees a row was written
   *  by the importer. A non-string value is stringified, never sent raw. */
  it('stringifies a mapped value that is not already a string', async () => {
    mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
    const { campaignId, links } = await seed();
    const link = await prisma.campaignContact.findUniqueOrThrow({ where: { id: links[0]! } });
    await prisma.contact.update({
      where: { id: link.contactId },
      data: { metadata: { score: 42 } },
    });
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { variableMap: { score: 'lead_score' } },
    });

    await runDialerPass({ now: NOW });

    expect(projected(mockedStartCall.mock.calls[0]![0]!)).toEqual({ lead_score: '42' });
  });

  /**
   * The call-note overlay: the one reserved variable, on a dial of a goal
   * campaign whose contact has a note, rendered from the context record.
   *
   * It is what the YE-managed prompt block interpolates, and it is a JSON
   * object YE assembles — its own “this is a follow-up” frame plus the
   * instructions the last call wrote. A first dial carries nothing from YE
   * at all — no goal, no call number, no memory paragraph, and no frame
   * either, because on a first call there has been no previous one to
   * continue from; the block then renders over nothing.
   */
  describe('the goal variables', () => {
    const NOTE_VARIABLE = 'next_call_instructions_vocobaseplatform';
    const RETIRED = [
      'follow_up_instruction', 'campaign_goal', 'call_number', 'previous_attempts',
      'memory', 'last_call_note', 'goal_missing',
    ];

    const goalCampaign = async () => {
      const seeded = await seed();
      await prisma.campaign.update({
        where: { id: seeded.campaignId },
        data: { goalEnabled: true },
      });
      return seeded;
    };

    it('carries nothing of YE’s on a campaign with no goal', async () => {
      mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
      await seed();

      await runDialerPass({ now: NOW });

      const sent = mockedStartCall.mock.calls[0]![0]!.variables!;
      expect(sent).not.toHaveProperty(NOTE_VARIABLE);
      for (const name of RETIRED) expect(sent).not.toHaveProperty(name);
    });

    /** The first dial: no record exists yet, and an absence is exactly what
     *  "nobody has been spoken to" means — no sentence stands in for it. */
    it('carries no variable on the first dial', async () => {
      mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
      await goalCampaign();

      await runDialerPass({ now: NOW });

      const sent = mockedStartCall.mock.calls[0]![0]!.variables!;
      expect(sent).not.toHaveProperty(NOTE_VARIABLE);
      for (const name of RETIRED) expect(sent).not.toHaveProperty(name);
    });

    /** A record exists but holds no note — every attempt so far was a
     *  silence. Still nothing: a voicemail leaves the next call an opening
     *  call. */
    it('carries no variable when the record holds no note', async () => {
      mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
      const { links } = await goalCampaign();
      await prisma.campaignContactGoal.create({
        data: { campaignContactId: links[0]!, memory: null, lastCallNote: 'reached voicemail' },
      });

      await runDialerPass({ now: NOW });

      expect(mockedStartCall.mock.calls[0]![0]!.variables).not.toHaveProperty(NOTE_VARIABLE);
    });

    it('renders the stored note, and only the note, on a later dial', async () => {
      mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
      const { campaignId, links } = await goalCampaign();
      await prisma.campaignContactGoal.create({
        data: {
          campaignContactId: links[0]!,
          memory: 'Open with: "Hi Asha, we spoke on Tuesday about Baner." Then wait.',
          lastCallNote: 'spoke, worth calling again: wants to check with her husband',
        },
      });
      // One closed attempt, so this dial takes the next ordinal — the number
      // is `MAX(attemptNo) + 1` over the rows, never the retry counter.
      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      const workspace = await prisma.workspace.findUniqueOrThrow({
        where: { id: campaign.workspaceId },
      });
      await prisma.callAttempt.create({
        data: {
          campaignId,
          campaignContactId: links[0]!,
          workspaceId: workspace.id,
          accountId: workspace.ownerAccountId,
          attemptNo: 1,
          status: 'COMPLETED',
          upstreamCallId: 'c_prior',
          resolvedAt: new Date(NOW.getTime() - 3_600_000),
        },
      });
      await prisma.campaignContact.update({
        where: { id: links[0]! },
        data: { attempts: 1, followUpCount: 1, nextEligibleAt: new Date(NOW.getTime() - 60_000) },
      });

      await runDialerPass({ now: NOW });

      const sent = mockedStartCall.mock.calls[0]![0]!.variables!;
      expect(JSON.parse(sent[NOTE_VARIABLE]!)).toEqual({
        note: FOLLOW_UP_NOTE,
        instructions: 'Open with: "Hi Asha, we spoke on Tuesday about Baner." Then wait.',
      });
      expect(sent[NOTE_VARIABLE]).toContain('THIS IS A FOLLOW-UP CALL');
      for (const name of RETIRED) expect(sent).not.toHaveProperty(name);
    });

    /**
     * The reserved name wins a collision, which is why the overlay is spread
     * last. An operator whose spreadsheet has a column mapped to the note's
     * name has not asked to replace what the last call told the next one to
     * say — and a dial that let them would hand the agent a city where the
     * header promises a note.
     */
    it('beats a variableMap that claims the note’s name', async () => {
      mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
      const { campaignId, links } = await goalCampaign();
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { variableMap: { city: NOTE_VARIABLE } },
      });
      await prisma.campaignContactGoal.create({
        data: { campaignContactId: links[0]!, memory: 'Resume from the budget question.' },
      });

      await runDialerPass({ now: NOW });

      const sent = mockedStartCall.mock.calls[0]![0]!.variables!;
      expect(JSON.parse(sent[NOTE_VARIABLE]!).instructions).toBe('Resume from the budget question.');
    });

    /**
     * The opener is told to say when the last call was if it was more than an
     * hour ago, so the time has to reach the dial — and it has to be the time
     * of the call that wrote the memory, not of whatever attempt was recorded
     * last. A silence after a conversation records an attempt and never
     * touches `memory`; pairing its clock with the earlier call's account
     * would tell the next dial the conversation happened at a time nobody
     * spoke.
     */
    it('carries the timestamp of the attempt that wrote the memory', async () => {
      mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
      const { links } = await goalCampaign();
      await prisma.campaignContactGoal.create({
        data: {
          campaignContactId: links[0]!,
          memory: 'Dropped after the first report number.',
          memoryAttempt: 1,
          attemptLog: [
            { attemptNo: 1, callTimestamp: '2026-09-02T14:30+05' },
            { attemptNo: 2, callTimestamp: '2026-09-03T09:05+05' },
          ],
        },
      });

      await runDialerPass({ now: NOW });

      const sent = mockedStartCall.mock.calls[0]![0]!.variables!;
      expect(JSON.parse(sent[NOTE_VARIABLE]!)).toEqual({
        note: FOLLOW_UP_NOTE,
        previous_call_end_timestamp: 'Previous call ended at 2026-09-02T14:30+05',
        instructions: 'Dropped after the first report number.',
      });
    });

    /** A record written before the timestamp key existed, or by a call whose
     *  extraction had no readable one, carries the memory and no time — never
     *  a sentence ending in a full stop after nothing. */
    it('carries the memory without a time when the attempt left none', async () => {
      mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
      const { links } = await goalCampaign();
      await prisma.campaignContactGoal.create({
        data: {
          campaignContactId: links[0]!,
          memory: 'Dropped after the first report number.',
          memoryAttempt: 1,
          attemptLog: [{ attemptNo: 1, callTimestamp: null }],
        },
      });

      await runDialerPass({ now: NOW });

      const sent = mockedStartCall.mock.calls[0]![0]!.variables!;
      expect(JSON.parse(sent[NOTE_VARIABLE]!)).toEqual({
        note: FOLLOW_UP_NOTE,
        instructions: 'Dropped after the first report number.',
      });
    });
  });

  it('claims the contact exactly once even when two passes race', async () => {
    mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
    const { campaignId } = await seed(1);

    await Promise.all([runDialerPass({ now: NOW }), runDialerPass({ now: NOW })]);

    const attempts = await prisma.callAttempt.count({ where: { campaignId } });
    expect(attempts).toBe(1);
  });
});

/**
 * The five branches. Collapsing any two of these is how a dialer spends a
 * customer's retry budget for reasons that have nothing to do with them.
 */
describe('when a launch fails', () => {
  const failWith = (status: number, code: string) => {
    mockedStartCall.mockRejectedValue(new ApiError(status as never, code as never, 'nope'));
  };

  it('consumes the attempt when the platform rejects the request outright', async () => {
    failWith(400, 'VALIDATION_ERROR');
    const { campaignId, links } = await seed();

    const result = await runDialerPass({ now: NOW });

    expect(result.launchFailed).toBe(1);

    // Settled, not given back. Given back, this contact would be re-claimed
    // every pass forever, spend the sweep budget, and leave the campaign unable
    // to complete because its pool never drains.
    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: links[0]! } });
    expect(contact.status).toBe('FAILED');
    // `attempts` counts retries consumed, and the claim consumes none — only
    // the re-arm at resolution time does.
    expect(contact.attempts).toBe(0);

    // The counter moves with the status, in the same transaction. Every other
    // terminal write in this tree pairs the two; a settled contact whose
    // campaign never counted it leaves the stats page disagreeing with the
    // contact list forever, and nothing later reconciles them.
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.failedCount).toBe(1);

    const attempt = await prisma.callAttempt.findFirstOrThrow({});
    expect(attempt.status).toBe('FAILED');
    expect(attempt.launchError).toContain('VALIDATION_ERROR');
  });

  /**
   * The counter is the *paired* half of the status write, not a consequence of
   * reaching this branch. A rejection that arrives after something else already
   * moved the contact out of `QUEUED` writes nothing — and must count nothing,
   * or one contact is settled once and counted twice.
   */
  it('counts nothing when the contact has already left the queue', async () => {
    failWith(400, 'VALIDATION_ERROR');
    const { campaignId, links } = await seed();

    mockedStartCall.mockImplementationOnce(async () => {
      // Something else settles the contact while the dial is in flight.
      await prisma.campaignContact.update({
        where: { id: links[0]! },
        data: { status: 'EXCLUDED' },
      });

      throw new ApiError(400 as never, 'VALIDATION_ERROR' as never, 'nope');
    });

    await runDialerPass({ now: NOW });

    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).failedCount).toBe(0);
    expect(
      (await prisma.campaignContact.findUniqueOrThrow({ where: { id: links[0]! } })).status,
    ).toBe('EXCLUDED');
  });

  it('never re-claims a contact the platform rejected outright', async () => {
    failWith(400, 'VALIDATION_ERROR');
    await seed();

    await runDialerPass({ now: NOW });
    const again = await runDialerPass({ now: new Date(NOW.getTime() + 31 * 60_000) });

    expect(again.launched).toBe(0);
    expect(mockedStartCall).toHaveBeenCalledTimes(1);
  });

  it('gives the attempt back when the platform is merely unwell', async () => {
    failWith(502, 'UPSTREAM_ERROR');
    const { links } = await seed();

    await runDialerPass({ now: NOW });

    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: links[0]! } });
    // The call never left, so this was not an attempt.
    expect(contact.status).toBe('PENDING');
    expect(contact.attempts).toBe(0);
    // The backoff is a stored instant now, not `lastAttemptAt` plus arithmetic
    // at query time — a promised callback is an instant no formula over the
    // campaign's settings can reproduce, so eligibility had to become a column.
    expect(contact.lastAttemptAt).not.toBeNull();
    expect(contact.nextEligibleAt).toEqual(new Date(NOW.getTime() + 30 * 60_000));
    // Nothing manufactured a promise nobody made.
    expect(contact.callbackAt).toBeNull();
  });

  /**
   * The give-back is the one path that pushes a contact's eligibility out
   * without knowing what the row is waiting for. It keys on `armKind`, so a
   * promise is preserved in both directions and everything else — a resume
   * included — takes the plain backoff.
   */
  describe('and the contact is holding a promised callback', () => {
    const armAt = async (id: string, at: Date) => {
      await prisma.campaignContact.update({
        where: { id },
        data: { armKind: 'CALLBACK', callbackAt: at, nextEligibleAt: at },
      });
    };

    it('moves both columns together when the backoff would overrun the promise', async () => {
      failWith(502, 'UPSTREAM_ERROR');
      const { links } = await seed();
      await armAt(links[0]!, new Date(NOW.getTime() - 60_000));

      await runDialerPass({ now: NOW });

      const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: links[0]! } });
      const backoff = new Date(NOW.getTime() + 30 * 60_000);
      expect(contact.status).toBe('PENDING');
      // Honoured late rather than destroyed: the pair is still equal, so this
      // is still a callback and still exempt from the retry budget.
      expect(contact.nextEligibleAt).toEqual(backoff);
      expect(contact.callbackAt).toEqual(backoff);
    });

    /**
     * A promise booked while this very dial was in flight — the lead picked up,
     * asked for tomorrow, and the outcome landed before the launch failure did.
     * Reached here through the mocked upstream call, which is the one seam
     * where the contact is QUEUED and something else can write to it.
     */
    it('moves neither column when the promise is still ahead of the backoff', async () => {
      const { links } = await seed();
      const promised = new Date(NOW.getTime() + 2 * 60 * 60_000);

      mockedStartCall.mockImplementation(async () => {
        await prisma.campaignContact.update({
          where: { id: links[0]! },
          data: { armKind: 'CALLBACK', callbackAt: promised, nextEligibleAt: promised },
        });

        throw new ApiError(502, 'UPSTREAM_ERROR', 'nope');
      });

      await runDialerPass({ now: NOW });

      const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: links[0]! } });
      expect(contact.status).toBe('PENDING');
      // Untouched. Pushing `nextEligibleAt` to the backoff would break the pair
      // and silently downgrade a promise to a plain retry.
      expect(contact.nextEligibleAt).toEqual(promised);
      expect(contact.callbackAt).toEqual(promised);
    });

    /**
     * `callbackAt` left behind as history after a callback call completed, on
     * a contact the retry ladder has re-armed since. The arm says RETRY, so
     * this is a plain retry and only `nextEligibleAt` moves — stamping the
     * other column would rewrite the record of a promise that was kept.
     */
    it('moves one column only when the callback time is mere history', async () => {
      failWith(502, 'UPSTREAM_ERROR');
      const { links } = await seed();
      const history = new Date(NOW.getTime() - 4 * 60 * 60_000);
      await prisma.campaignContact.update({
        where: { id: links[0]! },
        data: {
          armKind: 'RETRY',
          callbackAt: history,
          nextEligibleAt: new Date(NOW.getTime() - 60_000),
        },
      });

      await runDialerPass({ now: NOW });

      const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: links[0]! } });
      expect(contact.status).toBe('PENDING');
      expect(contact.nextEligibleAt).toEqual(new Date(NOW.getTime() + 30 * 60_000));
      expect(contact.callbackAt).toEqual(history);
    });

    /**
     * A resume, given back after a transient launch failure.
     *
     * It carries no `callbackAt` of its own but may still carry a stale one,
     * and the give-back used to key on the two columns being equal — so a
     * resume whose instant happened to coincide with an old promise had that
     * promise rewritten to the backoff. Keyed on the arm, this takes the plain
     * branch: the clock moves, the history stands, and the row goes back into
     * the resume lane it came out of.
     */
    it('gives a resume back on the plain backoff, still armed as a resume', async () => {
      failWith(502, 'UPSTREAM_ERROR');
      const { links } = await seed();
      const history = new Date(NOW.getTime() - 4 * 60 * 60_000);
      await prisma.campaignContact.update({
        where: { id: links[0]! },
        data: {
          armKind: 'RESUME',
          followUpCount: 1,
          callbackAt: history,
          nextEligibleAt: new Date(NOW.getTime() - 60_000),
        },
      });

      await runDialerPass({ now: NOW });

      const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: links[0]! } });
      expect(contact.status).toBe('PENDING');
      expect(contact.armKind).toBe('RESUME');
      expect(contact.nextEligibleAt).toEqual(new Date(NOW.getTime() + 30 * 60_000));
      expect(contact.callbackAt).toEqual(history);
    });
  });

  it('does not re-dial a rolled-back contact on the very next pass', async () => {
    failWith(502, 'UPSTREAM_ERROR');
    const { links } = await seed();

    await runDialerPass({ now: NOW });
    mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });

    // One second later. The retry delay is thirty minutes.
    const second = await runDialerPass({ now: new Date(NOW.getTime() + 1_000) });

    expect(second.launched).toBe(0);

    // ...and does dial once the delay has elapsed.
    const third = await runDialerPass({ now: new Date(NOW.getTime() + 31 * 60_000) });
    expect(third.launched).toBe(1);
    expect(links).toHaveLength(1);
  });

  /**
   * `attemptNo` is `MAX(attemptNo) + 1` over the contact's own attempt rows,
   * not the contact's counter plus one.
   *
   * A give-back hands the counter back while leaving the failed attempt row
   * standing, so the counter and the history disagree from that moment on —
   * and `attempts` has stopped counting dials at all, since a retry re-arm and
   * not a claim is what moves it. Derived from the counter, the second dial
   * here would be numbered 1 again: two rows claiming to be the same call,
   * which is exactly what `@@unique([campaignContactId, attemptNo])` refuses.
   */
  it('numbers a re-dial from the attempt history, not from the counter', async () => {
    failWith(502, 'UPSTREAM_ERROR');
    const { links } = await seed();

    await runDialerPass({ now: NOW });
    mockedStartCall.mockResolvedValue({ call_id: 'c_2', session_id: 's_2' });

    const second = await runDialerPass({ now: new Date(NOW.getTime() + 31 * 60_000) });
    expect(second.launched).toBe(1);

    const attempts = await prisma.callAttempt.findMany({
      where: { campaignContactId: links[0]! },
      orderBy: { attemptNo: 'asc' },
    });

    expect(attempts.map((a) => a.attemptNo)).toEqual([1, 2]);
  });

  /**
   * The shared account is at its ceiling — very often because of somebody
   * else's traffic. Not this contact's fault, and every remaining campaign
   * would hit the identical wall.
   */
  it('gives the attempt back and halts the pass on a rate limit', async () => {
    failWith(429, 'UPSTREAM_RATE_LIMITED');
    const { links } = await seed(3);

    const result = await runDialerPass({ now: NOW });

    expect(result.halted).toBe('rate_limited');
    expect(mockedStartCall).toHaveBeenCalledTimes(1);

    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: links[0]! } });
    expect(contact.status).toBe('PENDING');
    expect(contact.attempts).toBe(0);
  });

  /**
   * The two campaign-level refusals.
   *
   * Neither is a fact about the contact whose dial happened to collect it, so
   * neither may be filed against that contact. A 403 is the account refused
   * outright; a 404 mid-campaign is the agent gone from the platform. Both
   * would be met identically by the very next contact, and by every contact
   * after that — which is how a campaign burns its whole list one row per pass
   * while staying RUNNING and telling nobody.
   */
  describe('and the refusal is about the account rather than the contact', () => {
    const notificationsOf = async (type: string) => {
      await flushNotifications();

      return prisma.notification.findMany({ where: { type } });
    };

    it('pauses the campaign and halts the pass when the platform refuses outright', async () => {
      failWith(403, 'UPSTREAM_FORBIDDEN');
      const { campaignId, links } = await seed(3);

      const result = await runDialerPass({ now: NOW });

      expect(result.halted).toBe('supplier_refused');
      expect(result.paused).toBe(1);
      // One dial, then nothing. The second and third contacts were claimed and
      // are released untouched rather than thrown at the same wall.
      expect(mockedStartCall).toHaveBeenCalledTimes(1);

      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      expect(campaign.status).toBe('PAUSED');
      expect(campaign.pausedAt).not.toBeNull();
      // The campaign page's answer to "why", the same sentence the
      // notification carries.
      expect(campaign.haltReason).toContain('The voice platform refused');

      // Given back whole: the call never left, so it consumed no retry and
      // manufactured no promise.
      const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: links[0]! } });
      expect(contact.status).toBe('PENDING');
      expect(contact.attempts).toBe(0);
      expect(contact.nextEligibleAt).toEqual(new Date(NOW.getTime() + 30 * 60_000));
      expect(contact.callbackAt).toBeNull();
    });

    /**
     * The supplier's wallet running dry, at LAUNCH.
     *
     * This is how it actually arrived in production on 2026-09-06/07: VoiceLink
     * refused `add_lead` with a 402 and the platform returned that to
     * `/calls/start`, so the dial never got a call id and never reached the
     * settle path at all. The adapter collapsed the 402 into a generic
     * `UPSTREAM_ERROR`, this triage read that as "transient", and the contact
     * was handed back with one cooldown — correctly, as far as the ladder
     * goes — while the campaign stayed RUNNING. 3,803 refusals over thirty
     * hours, every contact re-claimed and re-failed each cooldown against a
     * wallet that could not place a call, and nothing on any screen saying
     * why. No leads were lost; the campaign simply spun.
     *
     * A 402 is account-wide and not this contact's fault, exactly like the
     * 403 above, so it takes the same shape: give the contact back whole,
     * pause the campaign, halt the pass. What differs is the sentence and the
     * notification type — the customer can do nothing about the supplier's
     * wallet, so the pause must not send them to their own billing page.
     */
    it('pauses the campaign and halts the pass when the supplier has no funds to place the call', async () => {
      failWith(402, 'UPSTREAM_PAYMENT_REQUIRED');
      const { campaignId, links } = await seed(3);

      const result = await runDialerPass({ now: NOW });

      expect(result.halted).toBe('supplier_unfunded');
      expect(result.paused).toBe(1);
      expect(mockedStartCall).toHaveBeenCalledTimes(1);

      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      expect(campaign.status).toBe('PAUSED');
      // The SAME sentence the settle path writes for this fact, from the same
      // constant — two paths, one answer on the campaign page.
      expect(campaign.haltReason).toContain('voice platform');
      expect(campaign.haltReason).not.toContain('refused');

      // Given back whole, as any launch failure is: no retry, no promise.
      const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: links[0]! } });
      expect(contact.status).toBe('PENDING');
      expect(contact.attempts).toBe(0);
      expect(contact.callbackAt).toBeNull();

      // The platform-credit type, not the refusal type: the dashboard tells
      // the two apart by it, and this one must not point at the customer's
      // own billing.
      const [note, ...rest] = await notificationsOf('campaign.paused_platform_credit_exhausted');
      expect(rest).toHaveLength(0);
      expect(note!.scope).toBe('ADMINS_ONLY');
      expect(await notificationsOf('campaign.paused_upstream_refusal')).toHaveLength(0);
    });

    it('says what to check, to the admins who can check it', async () => {
      failWith(403, 'UPSTREAM_FORBIDDEN');
      await seed();

      await runDialerPass({ now: NOW });

      const [note, ...rest] = await notificationsOf('campaign.paused_upstream_refusal');
      expect(rest).toHaveLength(0);
      // The reason is billing, so it goes where credits and the plan go
      // everywhere else in this service.
      expect(note!.scope).toBe('ADMINS_ONLY');
      expect(note!.body).toContain('credits');
      expect(note!.body).toContain('plan');
      // The supplier is never named to a customer.
      expect(note!.body).toContain('voice platform');
      expect(note!.body).not.toContain('Vocobase');
    });

    /**
     * A 404 from the launch is very nearly always the agent: the number was
     * canonicalized here and the campaign's own ids were resolved on this pass.
     * Filed as a per-contact failure it settled one contact per pass, forever,
     * and the operator's only signal was a campaign that never finished.
     */
    it('pauses the campaign when the agent is gone from the platform', async () => {
      failWith(404, 'RESOURCE_NOT_FOUND');
      const { campaignId, links } = await seed(3);

      const result = await runDialerPass({ now: NOW });

      expect(result.paused).toBe(1);
      expect(mockedStartCall).toHaveBeenCalledTimes(1);

      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      expect(campaign.status).toBe('PAUSED');

      // Not settled. The contact did nothing wrong and its retry budget is
      // intact for whenever an agent is assigned.
      const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: links[0]! } });
      expect(contact.status).toBe('PENDING');
      expect(contact.attempts).toBe(0);

      const [note, ...rest] = await notificationsOf('campaign.paused_agent_missing_upstream');
      expect(rest).toHaveLength(0);
      expect(note!.body).toContain('agent');
    });

    /**
     * A campaign-level pause stops this campaign, not the platform's dialing.
     * A 403 is account-wide and halts everything; a missing agent is one
     * customer's misconfiguration and must not stop anybody else's calls.
     */
    it('lets another campaign dial in the same pass after a missing agent', async () => {
      const first = await seed(1);
      const second = await seed(1);

      mockedStartCall.mockImplementation(async (body) => {
        if (body.agent_id === first.agentExternalId) {
          throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'nope');
        }

        return { call_id: 'c_1', session_id: 's_1' };
      });

      const result = await runDialerPass({ now: NOW });

      expect(result.halted).toBeNull();
      expect(result.launched).toBe(1);

      const other = await prisma.campaign.findUniqueOrThrow({ where: { id: second.campaignId } });
      expect(other.status).toBe('RUNNING');
    });

    it('dials the given-back contact normally once the campaign is resumed', async () => {
      failWith(403, 'UPSTREAM_FORBIDDEN');
      const { campaignId, links } = await seed();

      await runDialerPass({ now: NOW });

      mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { status: 'RUNNING', pausedAt: null },
      });

      const after = await runDialerPass({ now: new Date(NOW.getTime() + 31 * 60_000) });

      expect(after.launched).toBe(1);

      const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: links[0]! } });
      expect(contact.status).toBe('QUEUED');
    });

    /**
     * The pause is a conditional `updateMany` on RUNNING for the reason every
     * other transition here is: two runners meeting the same wall must produce
     * one pause and one notification, not two of each.
     */
    it('pauses once and notifies once when two passes race', async () => {
      failWith(403, 'UPSTREAM_FORBIDDEN');
      const { campaignId } = await seed(4);

      await Promise.all([runDialerPass({ now: NOW }), runDialerPass({ now: NOW })]);

      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      expect(campaign.status).toBe('PAUSED');

      expect(await notificationsOf('campaign.paused_upstream_refusal')).toHaveLength(1);
    });
  });

  /**
   * The response was lost; the call may be ringing right now. Rolling back
   * would dial the same person twice.
   */
  it('leaves an unconfirmed write in flight for the reaper', async () => {
    failWith(502, 'UPSTREAM_WRITE_UNCONFIRMED');
    const { links } = await seed();

    await runDialerPass({ now: NOW });

    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: links[0]! } });
    expect(contact.status).toBe('QUEUED');
    expect(contact.attempts).toBe(0);

    const attempt = await prisma.callAttempt.findFirstOrThrow({});
    expect(attempt.status).toBe('QUEUED');
    expect(attempt.launchError).toContain('UPSTREAM_WRITE_UNCONFIRMED');
  });

  /**
   * The retry budget is enforced at claim time, against a `retryCount` re-read
   * on every pass — so lowering it mid-campaign stops a retry that is already
   * waiting, rather than only the ones not yet scheduled. Without that the
   * setting is a control that lies.
   */
  it('does not claim a contact that has spent its whole retry budget', async () => {
    const { campaignId, links } = await seed();
    await prisma.campaignContact.update({
      where: { id: links[0]! },
      data: { attempts: 3, nextEligibleAt: new Date(NOW.getTime() - 60_000) },
    });

    const result = await runDialerPass({ now: NOW });

    expect(result.launched).toBe(0);
    expect(mockedStartCall).not.toHaveBeenCalled();

    // ...and does dial it again the moment the budget is raised to cover it.
    mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
    await prisma.campaign.update({ where: { id: campaignId }, data: { retryCount: 3 } });
    const after = await runDialerPass({ now: NOW });
    expect(after.launched).toBe(1);
  });
});

describe('completing a campaign', () => {
  it('completes when nothing is left to dial and nothing is in flight', async () => {
    mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
    const { campaignId, links } = await seed(1);

    // The one contact has already been called and answered.
    await prisma.campaignContact.update({
      where: { id: links[0]! },
      data: { status: 'COMPLETED', attempts: 1, lastAttemptAt: NOW },
    });

    const result = await runDialerPass({ now: NOW });

    expect(result.completed).toBe(1);
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe('COMPLETED');
  });

  /**
   * A campaign in its last minutes is not a finished one. Announcing it early
   * would be a false statement about the customer's own results.
   */
  it('does not complete while a call is still in flight', async () => {
    mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
    const { campaignId } = await seed(1);

    await runDialerPass({ now: NOW });
    // The attempt row is stamped by the database clock, which this file's
    // injected `now` runs ahead of; without this the reaper would close it as
    // stale and the case would be testing the reaper instead.
    await prisma.callAttempt.updateMany({ where: { campaignId }, data: { startedAt: NOW } });

    const after = await runDialerPass({ now: NOW });

    expect(after.completed).toBe(0);
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe('RUNNING');
  });

  /**
   * A contact inside its cooldown is `PENDING` with a `nextEligibleAt` still
   * ahead: not dialable *yet*, and not finished either. Counting only what the
   * claim would take right now would complete a campaign that still has retries
   * waiting on it.
   */
  it('does not complete while a contact is still inside its retry delay', async () => {
    const { campaignId, links } = await seed(1);

    await prisma.campaignContact.update({
      where: { id: links[0]! },
      data: { attempts: 1, lastAttemptAt: NOW, nextEligibleAt: new Date(NOW.getTime() + 60_000) },
    });

    const result = await runDialerPass({ now: NOW });

    expect(result.completed).toBe(0);
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe('RUNNING');
  });

  /**
   * The completion pass counts and flips under a `FOR UPDATE` lock on the
   * campaign row. Without it a writer that adds work to a running campaign — a
   * callback re-arm, a top-up — can slip between the count and the status
   * check, see RUNNING, skip its own re-open, and be completed on top of the
   * contact it just put back on the queue.
   */
  it('stamps completedAt when it finishes a campaign', async () => {
    const { campaignId, links } = await seed(1);
    await prisma.campaignContact.update({
      where: { id: links[0]! },
      data: { status: 'COMPLETED', lastAttemptAt: NOW },
    });

    await runDialerPass({ now: NOW });

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe('COMPLETED');
    expect(campaign.completedAt).toEqual(NOW);
  });

  it('announces a completion once even when two passes race', async () => {
    const { campaignId, links } = await seed(1);
    await prisma.campaignContact.update({
      where: { id: links[0]! },
      data: { status: 'COMPLETED', attempts: 1, lastAttemptAt: NOW },
    });

    await Promise.all([runDialerPass({ now: NOW }), runDialerPass({ now: NOW })]);
    await flushNotifications();

    const announced = await prisma.notification.count({
      where: { type: 'campaign.completed' },
    });
    expect(announced).toBe(1);
    expect(campaignId).toBeTruthy();
  });

  /**
   * The same release a manual stop performs. Most goal campaigns end here,
   * in the sweep, and not under an operator's finger — and a block left on
   * the agent after its last campaign is a prompt still promising the model
   * variables no dial will ever send it.
   */
  it('takes the managed goal block off the agent when it completes a goal campaign', async () => {
    const { campaignId, links } = await seed(1);
    await prisma.campaign.update({ where: { id: campaignId }, data: { goalEnabled: true } });
    await prisma.campaignContact.update({
      where: { id: links[0]! },
      data: { status: 'COMPLETED', attempts: 1, lastAttemptAt: NOW },
    });
    mockedGetAgent.mockResolvedValue({ prompt: withGoalBlock('You are Asha.') });
    mockedUpdateAgent.mockResolvedValue({});

    await runDialerPass({ now: NOW });

    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe(
      'COMPLETED',
    );
    expect(mockedUpdateAgent).toHaveBeenCalledWith(expect.any(String), { prompt: 'You are Asha.' });
  });

  /** The release is per AGENT and not per campaign: another live campaign on
   *  the same agent still needs the block, so nothing is taken back. */
  it('leaves the agent alone while another live campaign still points at it', async () => {
    const { campaignId, links } = await seed(1);
    const finishing = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    await prisma.campaign.create({
      data: {
        workspaceId: finishing.workspaceId,
        name: 'Still running',
        agentId: finishing.agentId,
        status: 'RUNNING',
      },
    });
    await prisma.campaignContact.update({
      where: { id: links[0]! },
      data: { status: 'COMPLETED', attempts: 1, lastAttemptAt: NOW },
    });

    await runDialerPass({ now: NOW });

    expect(mockedGetAgent).not.toHaveBeenCalled();
    expect(mockedUpdateAgent).not.toHaveBeenCalled();
  });

  /** The release swallows its own failures; a campaign that is finished is
   *  finished whether or not the platform could be reached to say so. */
  it('still completes the campaign when the block cannot be removed', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { campaignId, links } = await seed(1);
    await prisma.campaign.update({ where: { id: campaignId }, data: { goalEnabled: true } });
    await prisma.campaignContact.update({
      where: { id: links[0]! },
      data: { status: 'COMPLETED', attempts: 1, lastAttemptAt: NOW },
    });
    mockedGetAgent.mockRejectedValue(new Error('upstream is down'));

    const result = await runDialerPass({ now: NOW });

    expect(result.completed).toBe(1);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe(
      'COMPLETED',
    );
    logged.mockRestore();
  });
});

/**
 * A batch is claimed whole and dialled one at a time, so an operator who
 * presses Stop is racing the loop rather than the pass. `stop` sweeps every
 * `PENDING` contact and cannot see these — they are already `QUEUED` — and the
 * pre-dial check only ever re-read the contact's own status, which `stop`
 * leaves exactly where it is. Every contact after the one in flight was
 * therefore dialled *after* the campaign was stopped.
 */
describe('a campaign that stops while its batch is being dialled', () => {
  const statuses = async (campaignId: string) => {
    const rows = await prisma.campaignContact.findMany({ where: { campaignId } });

    return rows.map((row) => row.status).sort();
  };

  it('skips the rest of the claimed batch, and counts them', async () => {
    const { campaignId } = await seed(3);

    mockedStartCall.mockImplementationOnce(async () => {
      // The operator presses Stop while the first call is being placed.
      await stopCampaign(campaignId, NOW, 'ops@ezo.test');

      return { call_id: 'c_1', session_id: 's_1' };
    });
    mockedStartCall.mockResolvedValue({ call_id: 'c_x', session_id: 's_x' });

    const result = await runDialerPass({ now: NOW });

    // The one already in flight, and nothing after it.
    expect(mockedStartCall).toHaveBeenCalledTimes(1);
    // Abandoned before the dial, so not a launch failure — nothing was tried.
    expect(result.launchFailed).toBe(0);

    // `SKIPPED`, the same status `stop` writes, rather than back to `PENDING`:
    // a stopped campaign left holding pending rows is a queue the sweep already
    // decided was never going to be called.
    expect(await statuses(campaignId)).toEqual(['QUEUED', 'SKIPPED', 'SKIPPED']);

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.skippedCount).toBe(2);
  });

  /**
   * A pause is not the same decision. It says these calls are not to be made
   * *now*, so the contacts go back exactly as they were — no timestamp touched,
   * no counter moved — and resume dials them.
   */
  it('gives the rest of the batch back untouched when the campaign is merely paused', async () => {
    const { campaignId } = await seed(3);

    mockedStartCall.mockImplementationOnce(async () => {
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { status: 'PAUSED', pausedAt: NOW },
      });

      return { call_id: 'c_1', session_id: 's_1' };
    });
    mockedStartCall.mockResolvedValue({ call_id: 'c_x', session_id: 's_x' });

    await runDialerPass({ now: NOW });

    expect(mockedStartCall).toHaveBeenCalledTimes(1);
    expect(await statuses(campaignId)).toEqual(['PENDING', 'PENDING', 'QUEUED']);

    const held = await prisma.campaignContact.findMany({
      where: { campaignId, status: 'PENDING' },
    });
    for (const row of held) {
      expect(row.nextEligibleAt).toBeNull();
      expect(row.attempts).toBe(0);
    }

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.skippedCount).toBe(0);
  });
});

/**
 * The attempt row is written before the dial, and its insert can fail —
 * a lost connection, a constraint, a pool timeout. The contact was left
 * `QUEUED` when it did: outside `releaseUnlaunched`'s slice (the loop has
 * already walked past it), invisible to the reaper (which reconciles attempt
 * rows, and there is none), and counted as remaining work by the completion
 * pass forever. One failed INSERT stranded a contact and, with it, its
 * campaign's ability to finish.
 */
describe('when the attempt row cannot be written', () => {
  /** Fails the first interactive transaction of the pass, which is the
   *  pre-dial one, and lets every later transaction through. */
  function poisonFirstTransaction() {
    const real = prisma.$transaction.bind(prisma);
    let armed = true;

    return vi.spyOn(prisma, '$transaction').mockImplementation(((...args: unknown[]) => {
      if (armed && typeof args[0] === 'function') {
        armed = false;

        return Promise.reject(new Error('the attempt row could not be written'));
      }

      return (real as (...a: unknown[]) => unknown)(...args);
    }) as never);
  }

  it('puts the contact back on the queue instead of stranding it', async () => {
    mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
    const { campaignId, links } = await seed(1);

    poisonFirstTransaction();

    await runDialerPass({ now: NOW });

    // No attempt row, so nothing was dialled and the reaper will never see it.
    expect(mockedStartCall).not.toHaveBeenCalled();
    expect(await prisma.callAttempt.count({ where: { campaignId } })).toBe(0);

    // Back on the queue, untouched: the call never left, so nothing was spent.
    const contact = await prisma.campaignContact.findUniqueOrThrow({ where: { id: links[0]! } });
    expect(contact.status).toBe('PENDING');
    expect(contact.attempts).toBe(0);
    expect(contact.nextEligibleAt).toBeNull();
  });

  /**
   * The reason the release matters. Nothing else would ever free this row —
   * the reaper reconciles attempt rows and there is none — so a stranded
   * contact is never dialled again, and its campaign can neither complete nor
   * be completed by hand (`complete` answers 409 while any contact is QUEUED).
   */
  it('dials the contact on the very next pass', async () => {
    mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
    const { campaignId } = await seed(1);

    const poison = poisonFirstTransaction();
    await runDialerPass({ now: NOW });
    expect(mockedStartCall).not.toHaveBeenCalled();

    poison.mockRestore();

    await runDialerPass({ now: new Date(NOW.getTime() + 60_000) });

    expect(mockedStartCall).toHaveBeenCalledTimes(1);
    expect(await prisma.callAttempt.count({ where: { campaignId } })).toBe(1);
  });
});

/**
 * Campaign context, stamped on every outbound dial.
 *
 * Four reserved variables so a post-call action can write which campaign and
 * which contact this call belonged to into a sheet, or key a function hook on
 * the contact. They ride in `Session.variables` like everything else, which
 * is the only channel the platform's template scope reads.
 */
describe('the campaign context variables', () => {
  it('sends the campaign, the contact and the attempt number on every dial', async () => {
    mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
    const { campaignId, links } = await seed();

    await runDialerPass({ now: NOW });

    const sent = mockedStartCall.mock.calls[0]![0]!;
    expect(sent.variables).toMatchObject({
      ezo_campaign_id: campaignId,
      ezo_campaign_name: 'Outreach',
      ezo_contact_id: links[0],
      ezo_attempt_no: '1',
    });
  });

  it('counts up with the ordinal, so a retry says which attempt it is', async () => {
    mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
    const { campaignId, links } = await seed();
    // One closed attempt behind this dial, so it takes the next ordinal.
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: campaign.workspaceId },
    });
    await prisma.callAttempt.create({
      data: {
        campaignId,
        campaignContactId: links[0]!,
        workspaceId: workspace.id,
        accountId: workspace.ownerAccountId,
        attemptNo: 1,
        status: 'FAILED',
        disposition: 'no_answer',
        resolvedAt: new Date(NOW.getTime() - 3_600_000),
      },
    });
    await prisma.campaignContact.update({
      where: { id: links[0]! },
      data: { attempts: 1, nextEligibleAt: new Date(NOW.getTime() - 60_000) },
    });

    await runDialerPass({ now: NOW });

    const sent = mockedStartCall.mock.calls[0]![0]!;
    expect(sent.variables).toMatchObject({ ezo_attempt_no: '2' });
  });

  it('cannot be shadowed by a CSV column mapped onto the same name', async () => {
    mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
    const { campaignId } = await seed();
    // A map that predates the reservation — the validator refuses this on
    // write now, but a stored row is JSON in a column and the dialer must
    // not be the thing that trusts it.
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { variableMap: { city: 'ezo_campaign_id', name: 'name' } },
    });

    await runDialerPass({ now: NOW });

    const sent = mockedStartCall.mock.calls[0]![0]!;
    expect(sent.variables).toMatchObject({ ezo_campaign_id: campaignId });
    expect(sent.variables!.ezo_campaign_id).not.toBe('Pune');
  });

  it('carries the note variable alongside, not instead of', async () => {
    mockedStartCall.mockResolvedValue({ call_id: 'c_1', session_id: 's_1' });
    const { campaignId, links } = await seed();
    await prisma.campaignContactGoal.create({
      data: {
        campaignContactId: links[0]!,
        memory: 'Ask about the quote they asked for.',
      },
    });

    await runDialerPass({ now: NOW });

    const sent = mockedStartCall.mock.calls[0]![0]!;
    expect(sent.variables).toHaveProperty('next_call_instructions_vocobaseplatform');
    expect(sent.variables).toMatchObject({ ezo_campaign_id: campaignId });
  });
});
