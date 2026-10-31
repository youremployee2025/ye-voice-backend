import { describe, expect, it } from 'vitest';
import { signRecordingToken, verifyRecordingToken } from '../src/lib/recordingToken.js';

const SECRET = 'a-test-secret';
const NOW = 1_800_000_000_000;

describe('recording tokens', () => {
  it('round-trips the call it was minted for', () => {
    const token = signRecordingToken({ workspaceId: 'ws_1', callId: 'call_1' }, SECRET, NOW);

    expect(verifyRecordingToken(token, SECRET, NOW)).toEqual({
      workspaceId: 'ws_1',
      callId: 'call_1',
    });
  });

  it('expires, so a copied url stops working', () => {
    const token = signRecordingToken({ workspaceId: 'ws_1', callId: 'call_1' }, SECRET, NOW);

    expect(verifyRecordingToken(token, SECRET, NOW + 60_000)).not.toBeNull();
    expect(verifyRecordingToken(token, SECRET, NOW + 10 * 60_000)).toBeNull();
  });

  it('refuses a token signed with another secret', () => {
    const token = signRecordingToken({ workspaceId: 'ws_1', callId: 'call_1' }, 'other', NOW);

    expect(verifyRecordingToken(token, SECRET, NOW)).toBeNull();
  });

  it('refuses a token whose payload was edited to name another call', () => {
    // The whole point: the signature covers the call and the workspace, so a
    // token minted for one call cannot be pointed at another.
    const token = signRecordingToken({ workspaceId: 'ws_1', callId: 'call_1' }, SECRET, NOW);
    const [payload, signature] = token.split('.');
    const edited = Buffer.from(
      JSON.stringify({ w: 'ws_1', c: 'call_2', e: NOW + 120_000 }),
    ).toString('base64url');

    expect(verifyRecordingToken(`${edited}.${signature}`, SECRET, NOW)).toBeNull();
    expect(payload).not.toBe(edited);
  });

  it('refuses malformed input rather than throwing', () => {
    for (const bad of ['', 'nonsense', 'a.b.c', 'notbase64.sig', '.', 'x.']) {
      expect(verifyRecordingToken(bad, SECRET, NOW)).toBeNull();
    }
  });

  it('refuses everything when no secret is configured', () => {
    // A missing secret must not mean an open door — the same rule the staff
    // token guard holds.
    const token = signRecordingToken({ workspaceId: 'ws_1', callId: 'call_1' }, SECRET, NOW);

    expect(verifyRecordingToken(token, '', NOW)).toBeNull();
    expect(verifyRecordingToken(token, undefined as unknown as string, NOW)).toBeNull();
  });
});
