import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Secure store tests. The Tauri IPC is stubbed with a fake
 * DPAPI: `secret_protect` tags a value, `secret_unprotect`
 * untags it and throws on anything it did not tag — which
 * is exactly the contract the Rust command implements
 * (fail-closed on foreign/corrupted blobs).
 */

const MARKER = 'dpapi1:';

const originalWindow = globalThis.window;

interface WinStub {
  __TAURI_INTERNALS__?: {
    invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  };
  location: { protocol: string; host: string };
}

function stubWindow(tauri: boolean): void {
  const w: WinStub = {
    location: { protocol: 'http:', host: 'localhost:5173' },
  };
  if (tauri) {
    w.__TAURI_INTERNALS__ = {
      invoke: async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
        if (cmd === 'secret_protect') {
          // Real DPAPI output is opaque ciphertext; the fake
          // base64-encodes so plaintext never appears at rest.
          return `enc:${btoa(String(args?.plain))}` as T;
        }
        if (cmd === 'secret_unprotect') {
          const raw = String(args?.protected);
          if (!raw.startsWith('enc:')) throw new Error('corrupted blob');
          try {
            return atob(raw.slice(4)) as T;
          } catch {
            throw new Error('corrupted blob');
          }
        }
        throw new Error(`unexpected command: ${cmd}`);
      },
    };
  }
  (globalThis as { window?: unknown }).window = w;
}

/** Let fire-and-forget IPC writes settle. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('secureStore', () => {
  beforeEach(() => {
    vi.resetModules();
    try {
      localStorage.clear();
    } catch {
      // storage unavailable — tests below assert the degraded path
    }
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  it('protects writes and restores them across a restart (desktop)', async () => {
    stubWindow(true);
    const mod = await import('./secureStore');
    mod.secureSet('np.cloud.refresh', 'token-123');
    expect(mod.secureGet('np.cloud.refresh')).toBe('token-123');
    await flush();
    // At rest the value is a DPAPI blob, never plaintext.
    const stored = localStorage.getItem('np.cloud.refresh');
    expect(stored).toMatch(new RegExp(`^${MARKER}`));
    expect(stored).not.toContain('token-123');

    // Simulate a restart: fresh module instance, decrypted at prime.
    vi.resetModules();
    const restarted = await import('./secureStore');
    await restarted.primeSecureStore();
    expect(restarted.secureGet('np.cloud.refresh')).toBe('token-123');
  });

  it('drops corrupted blobs instead of failing the app (desktop)', async () => {
    stubWindow(true);
    localStorage.setItem('np.cloud.refresh', `${MARKER}not-a-real-blob`);
    const mod = await import('./secureStore');
    await mod.primeSecureStore();
    expect(mod.secureGet('np.cloud.refresh')).toBeNull();
    // The undecryptable blob is removed, not left behind.
    expect(localStorage.getItem('np.cloud.refresh')).toBeNull();
  });

  it('migrates legacy plaintext values on first write (desktop)', async () => {
    stubWindow(true);
    localStorage.setItem('np.cloud.refresh', 'legacy-plaintext');
    const mod = await import('./secureStore');
    await mod.primeSecureStore();
    // Legacy value reads as plaintext during the transition…
    expect(mod.secureGet('np.cloud.refresh')).toBe('legacy-plaintext');
    // …and the next write re-encrypts it at rest.
    mod.secureSet('np.cloud.refresh', 'next-value');
    await flush();
    expect(localStorage.getItem('np.cloud.refresh')).toMatch(new RegExp(`^${MARKER}`));
  });

  it('keeps the historical plaintext behavior in web mode', async () => {
    stubWindow(false);
    const mod = await import('./secureStore');
    mod.secureSet('np.cloud.refresh', 'token-123');
    expect(mod.secureGet('np.cloud.refresh')).toBe('token-123');
    expect(localStorage.getItem('np.cloud.refresh')).toBe('token-123');
    mod.secureRemove('np.cloud.refresh');
    expect(mod.secureGet('np.cloud.refresh')).toBeNull();
    expect(localStorage.getItem('np.cloud.refresh')).toBeNull();
  });

  it('serves values from the memory map after priming, not storage', async () => {
    stubWindow(true);
    const mod = await import('./secureStore');
    mod.secureSet('np.cloud.deviceId-x', 'v');
    await flush();
    // Storage holds only the blob; the getter serves the map.
    expect(mod.secureGet('np.cloud.deviceId-x')).toBe('v');
    expect(localStorage.getItem('np.cloud.deviceId-x')).not.toBe('v');
  });
});
