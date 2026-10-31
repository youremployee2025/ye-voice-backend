import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAll } from './setup.js';
import { makeAccount, makeWorkspace } from './helpers.js';
import { reportAgentDirections } from '../src/services/agentDirectionReport.js';

/**
 * The post-deploy check for the uni/bi enum move. It answers one question the
 * migration cannot: whether the rollout's reading of the world matches the
 * mirror's. `BI` should be exactly the agents that were `BOTH`, and the `UNI`
 * split says how many of the rest are already carrying a face — which is the
 * population whose saves now write both sides.
 */
let n = 0;
async function agent(
  workspaceId: string | null,
  direction: 'UNI' | 'BI',
  inboundEnabled: boolean,
) {
  n += 1;
  return prisma.agent.create({
    data: { externalId: `ext-${n}`, name: `Agent ${n}`, workspaceId, direction, inboundEnabled },
  });
}

beforeEach(async () => {
  await truncateAll();
  n = 0;
});

describe('reportAgentDirections', () => {
  it('splits each workspace three ways and totals them', async () => {
    const alice = await makeAccount('alice');
    const bob = await makeAccount('bob');
    const alices = await makeWorkspace(alice, 'Alice Co');
    const bobs = await makeWorkspace(bob, 'Bob Co');

    await agent(alices.id, 'UNI', false);
    await agent(alices.id, 'UNI', false);
    await agent(alices.id, 'UNI', true);
    await agent(alices.id, 'BI', true);
    await agent(bobs.id, 'BI', true);

    const report = await reportAgentDirections();

    const a = report.rows.find((row) => row.workspaceId === alices.id);
    expect(a).toMatchObject({ workspaceName: 'Alice Co', uniNoFace: 2, uniWithFace: 1, bi: 1 });
    const b = report.rows.find((row) => row.workspaceId === bobs.id);
    expect(b).toMatchObject({ workspaceName: 'Bob Co', uniNoFace: 0, uniWithFace: 0, bi: 1 });
    expect(report.totals).toMatchObject({ uniNoFace: 2, uniWithFace: 1, bi: 2 });
  });

  /**
   * An unassigned agent is invisible to every workspace and reachable only
   * through the staff surface, but it still carries a direction and still
   * cost a face if it has one. Folding it into a workspace would be a lie and
   * dropping it would make the rows fail to sum to the totals beside them, so
   * it gets its own row with a null id.
   */
  it('reports the unassigned pool as its own row', async () => {
    await agent(null, 'UNI', false);
    await agent(null, 'BI', true);

    const report = await reportAgentDirections();

    const pool = report.rows.find((row) => row.workspaceId === null);
    expect(pool).toMatchObject({ workspaceName: null, uniNoFace: 1, uniWithFace: 0, bi: 1 });
    expect(report.totals).toMatchObject({ uniNoFace: 1, uniWithFace: 0, bi: 1 });
  });

  /**
   * The one disagreement worth naming. `BI` means two personas and is
   * meaningless without a face to be the second one; a row in that state is
   * an agent offering an inbound editor for a configuration that does not
   * exist. Nothing in this release creates one — the move to BI enables the
   * face first — so a non-zero count here means staff disabled a face
   * upstream, which is a thing to go and look at rather than a thing to fix
   * from a report.
   */
  it('counts BI agents that have no face', async () => {
    const alice = await makeAccount('alice');
    const alices = await makeWorkspace(alice, 'Alice Co');
    await agent(alices.id, 'BI', false);

    const report = await reportAgentDirections();

    expect(report.rows[0]).toMatchObject({ bi: 1, biNoFace: 1 });
    expect(report.totals.biNoFace).toBe(1);
  });

  it('reports nothing on an empty mirror rather than failing', async () => {
    const report = await reportAgentDirections();

    expect(report.rows).toEqual([]);
    expect(report.totals).toMatchObject({ uniNoFace: 0, uniWithFace: 0, bi: 0, biNoFace: 0 });
  });
});
