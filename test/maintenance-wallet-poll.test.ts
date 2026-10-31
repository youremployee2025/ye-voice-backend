import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/platformWallet.js', () => ({
  refreshOpenTopups: vi.fn(),
}));

const { refreshOpenTopups } = await import('../src/services/platformWallet.js');
const { dispatch } = await import('../src/lib/queue/workers/maintenance.worker.js');

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('the wallet top-up poll', () => {
  it('refreshes the open links', async () => {
    vi.mocked(refreshOpenTopups).mockResolvedValue({
      refreshed: 0,
      credited: 0,
      expired: 0,
      failed: 0,
    });
    await dispatch('wallet-topup-poll');
    expect(refreshOpenTopups).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalled();
  });

  it('logs a line only when something changed', async () => {
    vi.mocked(refreshOpenTopups).mockResolvedValue({
      refreshed: 2,
      credited: 1,
      expired: 0,
      failed: 1,
    });
    await dispatch('wallet-topup-poll');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('credited=1'));
  });
});
