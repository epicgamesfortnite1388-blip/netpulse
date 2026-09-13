import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface TauriStub {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
}

interface WinStub {
  __TAURI_INTERNALS__?: unknown;
  __TAURI__?: { invoke: TauriStub['invoke'] };
  location: { protocol: string; host: string };
}

const BOOTSTRAP = {
  api_base: 'http://127.0.0.1:52133',
  ws_base: 'ws://127.0.0.1:52133',
  token: 'a'.repeat(64),
  desktop: true,
  app_version: '0.2.0',
  os: 'windows',
  arch: 'x86_64',
};

const originalWindow = globalThis.window;

function stubWindow(tauri: boolean): WinStub {
  const w: WinStub = {
    location: { protocol: 'http:', host: 'localhost:5173' },
  };
  if (tauri) {
    w.__TAURI_INTERNALS__ = {};
    w.__TAURI__ = {
      invoke: async <T,>(cmd: string): Promise<T> => {
        if (cmd === 'bootstrap') return BOOTSTRAP as T;
        throw new Error(`unexpected command: ${cmd}`);
      },
    };
  }
  (globalThis as { window?: unknown }).window = w;
  return w;
}

describe('transport', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  it('falls back to web transport without Tauri IPC', async () => {
    stubWindow(false);
    const mod = await import('./transport');
    const t = await mod.initTransport();
    expect(t.mode).toBe('web');
    expect(t.apiBase).toBe('/api/v1');
    expect(t.wsBase).toContain('localhost:5173');
    expect(t.authHeaders()).toEqual({});
    expect(mod.isDesktop()).toBe(false);
  });

  it('uses Tauri bootstrap in desktop mode', async () => {
    stubWindow(true);
    const mod = await import('./transport');
    const t = await mod.initTransport();
    expect(t.mode).toBe('desktop');
    expect(t.apiBase).toBe('http://127.0.0.1:52133');
    expect(t.wsBase).toBe('ws://127.0.0.1:52133');
    expect(mod.isDesktop()).toBe(true);
  });

  it('desktop transport sends bearer auth headers', async () => {
    stubWindow(true);
    const mod = await import('./transport');
    await mod.initTransport();
    const headers = mod.transport().authHeaders();
    expect(headers.authorization).toBe(`Bearer ${'a'.repeat(64)}`);
  });

  it('memoizes the chosen transport', async () => {
    stubWindow(true);
    const mod = await import('./transport');
    const a = await mod.initTransport();
    const b = await mod.initTransport();
    expect(a).toBe(b);
  });

  it('desktopInfo surfaces version/os/arch from the bootstrap contract', async () => {
    stubWindow(true);
    const mod = await import('./transport');
    await mod.initTransport();
    const info = await mod.desktopInfo();
    expect(info).toEqual({ appVersion: '0.2.0', os: 'windows', arch: 'x86_64' });
  });

  it('web mode has no desktopInfo', async () => {
    stubWindow(false);
    const mod = await import('./transport');
    await mod.initTransport();
    expect(await mod.desktopInfo()).toBeNull();
  });
});
