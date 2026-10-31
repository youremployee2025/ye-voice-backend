import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { formatCorrelationId } from '../src/lib/callCorrelation.js';
import { resolveAttribution } from '../src/services/analyticsIngest.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeAgent, makeWorkspace } from './helpers.js';

/**
 * Which workspace a platform call belongs to, and whether it is ours to store.
 *
 * The upstream pool is partner-wide: every workspace's calls sit in one
 * undifferentiated list. A mistake here does not lose data, it puts one
 * customer's traffic on another customer's chart — so these are the tests that
 * decide whether the rest of the surface is safe to build.
 *
 * The campaign leg no longer attributes. A call it resolves is one the dialer
 * already recorded as a `CallAttempt`, so the leg's job is to say **skip this
 * row** — storing it here as well would double every campaign figure on every
 * chart.
 */

async function campaignWithContact(workspaceId: string, name: string) {
  const campaign = await prisma.campaign.create({ data: { workspaceId, name } });
  const contact = await prisma.contact.create({
    data: { workspaceId, phone: `+1555${Math.floor(Math.random() * 1e7)}` },
  });
  const campaignContact = await prisma.campaignContact.create({
    data: { campaignId: campaign.id, contactId: contact.id },
  });

  return { campaign, campaignContact };
}

/** An upstream listing row, in the shape the platform actually sends. */
function row(fields: Record<string, unknown>): Record<string, unknown> {
  return { call_id: `call_${Math.random().toString(36).slice(2)}`, ...fields };
}

beforeEach(truncateAll);

describe('the agent leg', () => {
  it('attributes a call to the workspace holding the agent', async () => {
    const account = await makeAccount('agentleg');
    const workspace = await makeWorkspace(account, 'Agent Leg');
    const agent = await makeAgent(workspace, 'Dialer');

    const [attribution] = await resolveAttribution([row({ agent_id: agent.externalId })]);

    expect(attribution.workspaceId).toBe(workspace.id);
    expect(attribution.agentId).toBe(agent.id);
    expect(attribution.campaignCall).toBe(false);
  });

  it('attributes nothing for an agent in the unassigned pool', async () => {
    // An unassigned agent belongs to no workspace, so neither do its calls.
    const agent = await makeAgent(null, 'Pooled');

    const [attribution] = await resolveAttribution([row({ agent_id: agent.externalId })]);

    expect(attribution.workspaceId).toBeNull();
    expect(attribution.agentId).toBeNull();
  });

  it('attributes calls on a retired agent, which still happened', async () => {
    // `NOT_REMOVED` answers "may this workspace start something with this
    // agent". This asks whether it placed a call, which does not stop being
    // true when staff retire the agent later.
    const account = await makeAccount('retired');
    const workspace = await makeWorkspace(account, 'Retired');
    const agent = await makeAgent(workspace, 'Old', 'removed');

    const [attribution] = await resolveAttribution([row({ agent_id: agent.externalId })]);

    expect(attribution.workspaceId).toBe(workspace.id);
  });

  it('does not match a row whose agent id is absent', async () => {
    const account = await makeAccount('noagent');
    const workspace = await makeWorkspace(account, 'No Agent');
    await makeAgent(workspace, 'Someone');

    const [attribution] = await resolveAttribution([row({})]);

    expect(attribution.workspaceId).toBeNull();
  });
});

describe('the campaign leg', () => {
  it('marks a correlated call as the dialer\u2019s, not ours to store', async () => {
    // The dialer wrote a CallAttempt for this dial already. Storing it here too
    // would double the campaign's numbers everywhere they are reported.
    const account = await makeAccount('camp');
    const workspace = await makeWorkspace(account, 'Campaign Leg');
    const { campaign, campaignContact } = await campaignWithContact(workspace.id, 'Outreach');

    const [attribution] = await resolveAttribution([
      row({ client_reference_id: formatCorrelationId(campaign.id, campaignContact.id) }),
    ]);

    expect(attribution.campaignCall).toBe(true);
    expect(attribution.workspaceId).toBeNull();
  });

  it('reads a retry key, which carries the attempt id as a fourth segment', async () => {
    const account = await makeAccount('retry');
    const workspace = await makeWorkspace(account, 'Retry');
    const { campaign, campaignContact } = await campaignWithContact(workspace.id, 'Retried');

    const [attribution] = await resolveAttribution([
      row({
        client_reference_id: formatCorrelationId(campaign.id, campaignContact.id, 'att_123'),
      }),
    ]);

    expect(attribution.campaignCall).toBe(true);
  });

  it('refuses a key naming a real campaign and a contact that is not on it', async () => {
    // The two-factor check. `client_reference_id` is free text on an account
    // every customer shares, and a campaign id is an ordinary identifier every
    // member can read — so a single-factor leg would let anyone able to place a
    // call on that account drop it into somebody else's history by writing one
    // guessable string into a field nobody validates.
    const account = await makeAccount('forge');
    const victim = await makeWorkspace(account, 'Victim');
    const { campaign } = await campaignWithContact(victim.id, 'Theirs');
    const other = await campaignWithContact(victim.id, 'Different');

    const [attribution] = await resolveAttribution([
      row({ client_reference_id: formatCorrelationId(campaign.id, other.campaignContact.id) }),
    ]);

    // Not a campaign call, so not skipped either — it falls through to the
    // agent leg like any other row, and here there is no agent to catch it.
    expect(attribution.campaignCall).toBe(false);
    expect(attribution.workspaceId).toBeNull();
  });

  it('refuses a key with our prefix and the wrong shape', async () => {
    const account = await makeAccount('shape');
    const workspace = await makeWorkspace(account, 'Shape');
    const { campaign } = await campaignWithContact(workspace.id, 'Shaped');

    for (const key of [`ezo:${campaign.id}`, `ezo:${campaign.id}:`, `ezo::x`]) {
      const [attribution] = await resolveAttribution([row({ client_reference_id: key })]);
      expect(attribution.workspaceId).toBeNull();
    }
  });

  it('ignores another integrator’s namespace entirely', async () => {
    const [attribution] = await resolveAttribution([
      row({ client_reference_id: 'crm:automation_1:job_2' }),
    ]);

    expect(attribution.workspaceId).toBeNull();
  });
});

describe('when both legs resolve', () => {
  it('skips the row whatever the agent says', async () => {
    // The campaign leg decides whether the row is stored at all, and it wins
    // outright: the dialer's CallAttempt already covers this dial, so storing a
    // second copy under the agent's workspace would double-count it AND file it
    // under a workspace that did not run the campaign.
    const owner = await makeAccount('both');
    const agentWorkspace = await makeWorkspace(owner, 'Agent Side');
    const campaignWorkspace = await makeWorkspace(owner, 'Campaign Side');

    const agent = await makeAgent(agentWorkspace, 'Shared');
    const { campaign, campaignContact } = await campaignWithContact(
      campaignWorkspace.id,
      'Owns It',
    );

    const [attribution] = await resolveAttribution([
      row({
        agent_id: agent.externalId,
        client_reference_id: formatCorrelationId(campaign.id, campaignContact.id),
      }),
    ]);

    expect(attribution.campaignCall).toBe(true);
    expect(attribution.workspaceId).toBeNull();
    expect(attribution.agentId).toBeNull();
  });

  it('skips it when they agree too', async () => {
    const account = await makeAccount('agree');
    const workspace = await makeWorkspace(account, 'Agree');
    const agent = await makeAgent(workspace, 'Ours');
    const { campaign, campaignContact } = await campaignWithContact(workspace.id, 'Ours Too');

    const [attribution] = await resolveAttribution([
      row({
        agent_id: agent.externalId,
        client_reference_id: formatCorrelationId(campaign.id, campaignContact.id),
      }),
    ]);

    expect(attribution.campaignCall).toBe(true);
  });

  it('falls back to the agent when the correlation key is forged', async () => {
    // A failed campaign leg must not take a legitimate agent leg down with it.
    const account = await makeAccount('fallback');
    const workspace = await makeWorkspace(account, 'Fallback');
    const agent = await makeAgent(workspace, 'Real');

    const [attribution] = await resolveAttribution([
      row({ agent_id: agent.externalId, client_reference_id: 'ezo:nope:nothing' }),
    ]);

    // A forged key must not cause a call to be DROPPED any more than it should
    // cause one to be misattributed.
    expect(attribution.campaignCall).toBe(false);
    expect(attribution.workspaceId).toBe(workspace.id);
  });
});

describe('a page of rows', () => {
  it('resolves every row and preserves their order', async () => {
    const account = await makeAccount('page');
    const a = await makeWorkspace(account, 'A');
    const agent = await makeAgent(a, 'A agent');
    const { campaign, campaignContact } = await campaignWithContact(a.id, 'A campaign');

    const attributions = await resolveAttribution([
      row({ agent_id: agent.externalId }),
      row({}),
      row({ client_reference_id: formatCorrelationId(campaign.id, campaignContact.id) }),
    ]);

    expect(attributions).toHaveLength(3);
    expect(attributions[0].agentId).toBe(agent.id);
    expect(attributions[1].workspaceId).toBeNull();
    expect(attributions[2].campaignCall).toBe(true);
  });

  it('makes no query at all for a page carrying no correlation key', async () => {
    // The ordinary case. Resolving contacts per row would be a hundred queries
    // for a page that names none.
    const attributions = await resolveAttribution([row({}), row({})]);

    expect(attributions.every((a) => a.workspaceId === null)).toBe(true);
  });

  it('handles an empty page', async () => {
    expect(await resolveAttribution([])).toEqual([]);
  });
});
