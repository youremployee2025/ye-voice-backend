import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Writing and removing the managed call-note block on an agent's prompt.
 *
 * The block is how the note reaches the model at all: the platform
 * substitutes only the `{{variables}}` a prompt actually names and silently
 * drops the rest, so a variable YE sends that the prompt never mentions
 * reaches nobody. Which makes these two routines the difference between a
 * goal campaign whose agent reads its notes and one whose agent does not.
 */
vi.mock('../src/adapter/vocobase.js', () => ({ getAgent: vi.fn(), updateAgent: vi.fn() }));

const adapter = await import('../src/adapter/vocobase.js');
const { ensureGoalPromptBlock, releaseGoalPromptBlock } = await import(
  '../src/services/campaignPrompt.js'
);
const { NOTE_PROMPT_BLOCK, withGoalBlock } = await import('../src/lib/goalPromptBlock.js');

/**
 * The branded call-note block the previous release wrote, verbatim rather
 * than imported: this text is on real prompts upstream and cannot be changed
 * by editing this file, so a constant would let a rename rewrite both sides
 * of the assertion at once.
 */
const BRANDED_NOTE_BLOCK = [
  '[EZO call note — managed by EZO, do not edit]',
  '# CRITICAL CONTEXT (OVERRIDES ALL OTHER INSTRUCTIONS)',
  '',
  '{{next_call_instructions_vocobaseplatform}}',
  '',
  '========================================',
  '[end EZO call note]',
].join('\n');
const { prisma } = await import('../src/lib/prisma.js');
const { flushNotifications } = await import('../src/lib/notify.js');
const { truncateAll } = await import('./setup.js');
const { makeAccount, makeAgent, makeWorkspace } = await import('./helpers.js');

const getAgent = vi.mocked(adapter.getAgent);
const updateAgent = vi.mocked(adapter.updateAgent);

let workspaceId: string;
let agentId: string;
let externalId: string;

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});

  const account = await makeAccount(`pr${Math.random().toString(36).slice(2, 7)}`);
  const workspace = await makeWorkspace(account, 'Prompts');
  workspaceId = workspace.id;
  const agent = await makeAgent(workspace, 'caller');
  agentId = agent.id;
  externalId = agent.externalId;
});

afterEach(async () => {
  await flushNotifications();
  await truncateAll();
  vi.restoreAllMocks();
});

describe('ensureGoalPromptBlock', () => {
  it('appends the block to a prompt without one', async () => {
    getAgent.mockResolvedValue({ prompt: 'You are Asha.' });
    updateAgent.mockResolvedValue({});

    expect(await ensureGoalPromptBlock(externalId, workspaceId, 'Goals')).toBe(true);

    expect(updateAgent).toHaveBeenCalledWith(externalId, {
      prompt: withGoalBlock('You are Asha.'),
    });
  });

  /** Called on every start and every resume, so the ordinary case must cost
   *  one read and no write — otherwise a resume rewrites the agent's prompt
   *  upstream every time somebody presses a button. */
  it('writes nothing when the block is already intact', async () => {
    getAgent.mockResolvedValue({ prompt: withGoalBlock('You are Asha.') });

    await ensureGoalPromptBlock(externalId, workspaceId, 'Goals');

    expect(updateAgent).not.toHaveBeenCalled();
  });

  /**
   * A block edited by hand has drifted from the variable the dial carries,
   * which is a prompt that quietly stops seeing the note. Rewritten — but
   * said out loud, because it was somebody's edit.
   */
  it('rewrites a hand-edited block and tells an admin', async () => {
    const edited = NOTE_PROMPT_BLOCK.replace('OVERRIDES ALL OTHER INSTRUCTIONS', 'is optional');
    expect(edited).not.toBe(NOTE_PROMPT_BLOCK);
    getAgent.mockResolvedValue({ prompt: `Intro\n\n${edited}` });
    updateAgent.mockResolvedValue({});

    await ensureGoalPromptBlock(externalId, workspaceId, 'Goals');

    expect(updateAgent).toHaveBeenCalledWith(externalId, { prompt: withGoalBlock('Intro') });
    await flushNotifications();
    const n = await prisma.notification.findFirst({
      where: { workspaceId, type: 'campaign.goal_prompt_rewritten' },
    });
    expect(n).not.toBeNull();
    expect(n!.title).toContain('call-note block');
    expect(n!.body).toContain('call-note block');
  });

  /**
   * An agent that served a goal campaign under the previous release carries
   * that release's campaign-context block, whose seven variables nothing
   * sends any more. Replaced with the note block — but silently: nobody
   * edited anything, the contract moved under the prompt, and a notification
   * saying the block "had been edited" would be telling an ADMIN a story
   * about a person who does not exist.
   */
  it('migrates the previous release’s block silently', async () => {
    const old = [
      '[EZO campaign context — managed by EZO, do not edit]',
      'Campaign goal: {{campaign_goal}}',
      'What you already know about them: {{memory}}',
      '[end EZO campaign context]',
    ].join('\n');
    getAgent.mockResolvedValue({ prompt: `${old}\n\nIntro` });
    updateAgent.mockResolvedValue({});

    expect(await ensureGoalPromptBlock(externalId, workspaceId, 'Goals')).toBe(true);

    expect(updateAgent).toHaveBeenCalledWith(externalId, { prompt: withGoalBlock('Intro') });
    expect(updateAgent.mock.calls[0]![1]).toEqual({ prompt: `${NOTE_PROMPT_BLOCK}\n\nIntro` });
    await flushNotifications();
    expect(await prisma.notification.count({ where: { workspaceId } })).toBe(0);
  });


  /**
   * The case the idempotent early return got wrong: this release's block is
   * already at the top and intact, so the read returned `true` and never
   * looked further — leaving the previous release's branded block trailing
   * below it for good, since every later start took the same exit.
   */
  it('strips a branded block trailing an already-correct one', async () => {
    getAgent.mockResolvedValue({
      prompt: `${NOTE_PROMPT_BLOCK}\n\nAsha\n\n${BRANDED_NOTE_BLOCK}`,
    });
    updateAgent.mockResolvedValue({});

    expect(await ensureGoalPromptBlock(externalId, workspaceId, 'Goals')).toBe(true);

    expect(updateAgent).toHaveBeenCalledWith(externalId, { prompt: withGoalBlock('Asha') });
    expect(updateAgent.mock.calls[0]![1]).toEqual({ prompt: `${NOTE_PROMPT_BLOCK}\n\nAsha` });
  });

  /** And it is a migration, not somebody's edit: the branded block below was
   *  exactly what the previous release wrote. Nobody touched it, so nobody is
   *  told they did. */
  it('migrates an untouched branded block silently', async () => {
    getAgent.mockResolvedValue({ prompt: `${BRANDED_NOTE_BLOCK}\n\nAsha` });
    updateAgent.mockResolvedValue({});

    await ensureGoalPromptBlock(externalId, workspaceId, 'Goals');

    await flushNotifications();
    expect(await prisma.notification.count({ where: { workspaceId } })).toBe(0);
  });

  /**
   * An edit inside the PREVIOUS release's markers is still an edit. The
   * rewrite discards it either way — the block has to name the variable the
   * dial carries — but discarding somebody's words without saying so is the
   * half this must not lose in a rename.
   */
  it('tells an admin about a hand-edited branded block', async () => {
    const edited = BRANDED_NOTE_BLOCK.replace('OVERRIDES ALL OTHER INSTRUCTIONS', 'is optional');
    getAgent.mockResolvedValue({ prompt: `Intro\n\n${edited}` });
    updateAgent.mockResolvedValue({});

    await ensureGoalPromptBlock(externalId, workspaceId, 'Goals');

    expect(updateAgent).toHaveBeenCalledWith(externalId, { prompt: withGoalBlock('Intro') });
    await flushNotifications();
    expect(
      await prisma.notification.findFirst({
        where: { workspaceId, type: 'campaign.goal_prompt_rewritten' },
      }),
    ).not.toBeNull();
  });

  /**
   * A marker whose em-dash was normalised to a hyphen somewhere upstream is a
   * marker no span can match, so the block under it stacks beside the one
   * this release writes and the model reads the note twice. Nothing here can
   * remove it; naming it is the whole of what can be done.
   */
  it('tells an admin about a managed marker it cannot recognise', async () => {
    getAgent.mockResolvedValue({
      prompt: `${NOTE_PROMPT_BLOCK}\n\nAsha\n\n${BRANDED_NOTE_BLOCK.replace('—', '-')}`,
    });
    updateAgent.mockResolvedValue({});

    await ensureGoalPromptBlock(externalId, workspaceId, 'Goals');

    await flushNotifications();
    const n = await prisma.notification.findFirst({
      where: { workspaceId, type: 'campaign.goal_prompt_marker_unrecognised' },
    });
    expect(n).not.toBeNull();
    expect(n!.body).toContain('[EZO call note - managed by EZO, do not edit]');
  });

  /**
   * Said once, not once per start.
   *
   * Nothing can remove the marker, so the condition that triggers this
   * notification is permanent — and this routine runs on every start, every
   * resume AND on every worker boot, where `campaignAgentSweep` walks every
   * RUNNING goal campaign. Left unguarded that is an unbounded pile of
   * identical rows in one workspace's bell, which is how a real warning
   * becomes noise somebody switches off.
   */
  it('tells an admin about an unrecognised marker only once', async () => {
    const prompt = `${NOTE_PROMPT_BLOCK}\n\nAsha\n\n${BRANDED_NOTE_BLOCK.replace('—', '-')}`;
    getAgent.mockResolvedValue({ prompt });
    updateAgent.mockResolvedValue({});

    await ensureGoalPromptBlock(externalId, workspaceId, 'Goals');
    await flushNotifications();
    await ensureGoalPromptBlock(externalId, workspaceId, 'Goals');
    await ensureGoalPromptBlock(externalId, workspaceId, 'Goals');
    await flushNotifications();

    expect(
      await prisma.notification.count({
        where: { workspaceId, type: 'campaign.goal_prompt_marker_unrecognised' },
      }),
    ).toBe(1);
  });

  /** A different campaign on the same agent is a different sentence, and its
   *  operator has not been told anything yet. */
  it('still tells an admin about a second campaign on the same agent', async () => {
    const prompt = `${NOTE_PROMPT_BLOCK}\n\nAsha\n\n${BRANDED_NOTE_BLOCK.replace('—', '-')}`;
    getAgent.mockResolvedValue({ prompt });
    updateAgent.mockResolvedValue({});

    await ensureGoalPromptBlock(externalId, workspaceId, 'Goals');
    await ensureGoalPromptBlock(externalId, workspaceId, 'Winter outreach');
    await flushNotifications();

    expect(
      await prisma.notification.count({
        where: { workspaceId, type: 'campaign.goal_prompt_marker_unrecognised' },
      }),
    ).toBe(2);
  });

  /**
   * The same block, from an operator whose prompt editor writes CRLF. The
   * block is intact and nobody edited anything, so this must be the ordinary
   * one-read-no-write case — not a rewrite, and above all not a notification
   * telling an ADMIN their block was tampered with.
   */
  it('leaves a CRLF prompt whose block is intact alone', async () => {
    getAgent.mockResolvedValue({ prompt: withGoalBlock('You are Asha.').replace(/\n/g, '\r\n') });

    expect(await ensureGoalPromptBlock(externalId, workspaceId, 'Goals')).toBe(true);

    expect(updateAgent).not.toHaveBeenCalled();
    await flushNotifications();
    expect(await prisma.notification.count({ where: { workspaceId } })).toBe(0);
  });

  /** The same read that finds it must still cost nothing when there is
   *  nothing to find — this runs on every start and every resume. */
  it('says nothing about an ordinary prompt', async () => {
    getAgent.mockResolvedValue({ prompt: withGoalBlock('Asha') });

    await ensureGoalPromptBlock(externalId, workspaceId, 'Goals');

    expect(updateAgent).not.toHaveBeenCalled();
    await flushNotifications();
    expect(await prisma.notification.count({ where: { workspaceId } })).toBe(0);
  });

  /** The same promise the managed-key attach makes: never able to fail a
   *  transition. A campaign whose agent could not be given the block still
   *  dials, and the notification is what tells an ADMIN. */
  it('notifies and returns false on failure', async () => {
    getAgent.mockRejectedValue(new Error('down'));

    expect(await ensureGoalPromptBlock(externalId, workspaceId, 'Goals')).toBe(false);

    await flushNotifications();
    expect(
      await prisma.notification.findFirst({
        where: { workspaceId, type: 'campaign.goal_prompt_unavailable' },
      }),
    ).not.toBeNull();
  });
});

describe('releaseGoalPromptBlock', () => {
  it('removes the block when no live goal campaign shares the agent', async () => {
    await prisma.campaign.create({
      data: { workspaceId, name: 'done', agentId, status: 'STOPPED', goalEnabled: true },
    });
    getAgent.mockResolvedValue({ prompt: withGoalBlock('You are Asha.') });
    updateAgent.mockResolvedValue({});

    await releaseGoalPromptBlock(agentId, workspaceId);

    expect(updateAgent).toHaveBeenCalledWith(externalId, { prompt: 'You are Asha.' });
  });

  /** Agents are many-to-one with campaigns, so stopping one campaign must not
   *  silence another's — which is the whole reason the block's text is
   *  identical for every campaign and everything per-campaign is a variable. */
  it('keeps the block while another goal campaign is running or paused', async () => {
    await prisma.campaign.create({
      data: { workspaceId, name: 'live', agentId, status: 'PAUSED', goalEnabled: true },
    });

    await releaseGoalPromptBlock(agentId, workspaceId);

    expect(getAgent).not.toHaveBeenCalled();
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it('leaves a plain campaign’s agent prompt alone', async () => {
    await prisma.campaign.create({
      data: { workspaceId, name: 'plain', agentId, status: 'STOPPED', goalEnabled: false },
    });
    getAgent.mockResolvedValue({ prompt: 'You are Asha.' });

    await releaseGoalPromptBlock(agentId, workspaceId);

    // Read, because nothing else can prove the block is gone — but not
    // written, because there was nothing to take off.
    expect(updateAgent).not.toHaveBeenCalled();
  });

  /** A removal that could throw would be a stop that fails when the platform
   *  is down, which is exactly when an operator most needs one. */
  it('swallows an upstream failure', async () => {
    await prisma.campaign.create({
      data: { workspaceId, name: 'done', agentId, status: 'STOPPED', goalEnabled: true },
    });
    getAgent.mockRejectedValue(new Error('down'));

    await expect(releaseGoalPromptBlock(agentId, workspaceId)).resolves.toBeUndefined();
  });
});
