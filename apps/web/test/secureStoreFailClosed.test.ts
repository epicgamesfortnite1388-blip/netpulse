import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DD-011 regression: on desktop, a failed `secret_protect` must never leave
 * a refresh token / vault key in plaintext localStorage. The session stays
 * usable from the in-memory map, but nothing sensitive is persisted in the
 * clear. Previously the catch block called safeWrite(key, value).
 */
const protect = vi.fn();

vi.mock('@/lib/transport', () => ({
  hasTauriIpc: () => true,
  tauriInvoke: (cmd: string, args?: Record<string, unknown>) =>
    cmd === 'secret_protect' ? protect(args?.plain as string) : null,
}));

async function loadStore() {
  vi.resetModules();
  return await import('@/lib/cloud/secureStore');
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  localStorage.clear();
  protect.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('secureStore desktop protection failure', () => {
  it('keeps the session in memory but writes no plaintext when protection rejects', async () => {
    protect.mockRejectedValueOnce(new Error('CryptProtectData failed'));
    const store = await loadStore();

    store.secureSet('np.cloud.refreshToken', 'super-secret-value');
    await flush();

    expect(store.secureGet('np.cloud.refreshToken')).toBe('super-secret-value');
    expect(localStorage.getItem('np.cloud.refreshToken')).toBeNull();
  });

  it('removes a stale plaintext value when protection fails', async () => {
    localStorage.setItem('np.cloud.refreshToken', 'legacy-plaintext');
    protect.mockRejectedValueOnce(new Error('CryptProtectData failed'));
    const store = await loadStore();

    store.secureSet('np.cloud.refreshToken', 'new-secret');
    await flush();

    expect(localStorage.getItem('np.cloud.refreshToken')).toBeNull();
  });

  it('keeps a still-valid protected blob on a transient protection failure', async () => {
    // Kim P2: a transient IPC failure must not destroy a credential that is
    // already correctly protected.
    localStorage.setItem('np.cloud.refreshToken', 'dpapi1:VALID_EXISTING_BLOB');
    protect.mockRejectedValueOnce(new Error('transient IPC failure'));
    const store = await loadStore();

    store.secureSet('np.cloud.refreshToken', 'new-secret');
    await flush();

    expect(localStorage.getItem('np.cloud.refreshToken')).toBe('dpapi1:VALID_EXISTING_BLOB');
  });

  it('persists a DPAPI blob when protection succeeds', async () => {
    protect.mockResolvedValueOnce('ENCODED_BLOB');
    const store = await loadStore();

    store.secureSet('np.cloud.refreshToken', 'super-secret-value');
    await flush();

    expect(localStorage.getItem('np.cloud.refreshToken')).toBe('dpapi1:ENCODED_BLOB');
  });
});
