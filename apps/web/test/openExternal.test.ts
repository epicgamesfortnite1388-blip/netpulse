import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * External links must be handed to the OS in the packaged app.
 *
 * `window.open` inside the Tauri webview is subject to the popup blocker (the
 * Telegram deep link is only known after an await) and cannot hand `t.me` to
 * Telegram. This pins the branch: IPC when it exists, a normal tab otherwise.
 */
const invoke = vi.fn();

vi.mock('@/lib/transport', () => ({ tauriInvoke: invoke }));

const { openExternalUrl } = await import('../src/lib/openExternal');

describe('openExternalUrl', () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.restoreAllMocks();
  });

  it('uses the desktop open_external command when IPC is available', () => {
    invoke.mockReturnValue(Promise.resolve());
    const tab = vi.spyOn(window, 'open').mockImplementation(() => null);

    expect(openExternalUrl('https://t.me/AbystralBot?start=code')).toBe(true);

    expect(invoke).toHaveBeenCalledWith('open_external', { url: 'https://t.me/AbystralBot?start=code' });
    expect(tab).not.toHaveBeenCalled();
  });

  it('falls back to a new tab in web mode', () => {
    invoke.mockReturnValue(null);
    const tab = vi.spyOn(window, 'open').mockImplementation(() => null);

    expect(openExternalUrl('https://t.me/AbystralBot?start=code')).toBe(false);

    expect(tab).toHaveBeenCalledWith('https://t.me/AbystralBot?start=code', '_blank', 'noopener,noreferrer');
  });

  it('never rejects the caller when the bridge refuses a URL', async () => {
    invoke.mockReturnValue(Promise.reject(new Error('only https:// URLs can be opened')));

    expect(openExternalUrl('https://example.test')).toBe(true);
    // The rejection is swallowed inside the helper; no unhandled rejection
    // reaches the sign-in flow that triggered it.
    await Promise.resolve();
  });
});
