import { describe, expect, it } from 'vitest';

import { tauriInvoke } from '../src/lib/transport';

/**
 * The desktop bridge contract every IPC caller depends on.
 *
 * `tauriInvoke` is always a function — it resolves the Tauri global lazily, so
 * the way it reports "no desktop bridge" is a NULL RESULT. System Health guarded
 * on the function instead, which is never null, and crashed the whole page with
 * `null.then` in web mode; its export button also reported a save that never
 * happened (the same null awaited to undefined).
 */
describe('tauriInvoke', () => {
  const globals = window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };

  it('is always callable, and answers null when there is no desktop bridge', () => {
    delete globals.__TAURI_INTERNALS__;
    delete globals.__TAURI__;

    // The function exists (so `if (!invoke) return;` is a false guard)…
    expect(typeof tauriInvoke).toBe('function');
    // …and the absence shows up in the result, which is what callers must test.
    expect(tauriInvoke('read_log_tail', { lines: 60 })).toBeNull();
  });

  it('forwards to the bridge when one is present, returning a real promise', async () => {
    globals.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise.resolve(`${cmd}:${JSON.stringify(args ?? {})}`),
    };

    const p = tauriInvoke<string>('data_paths');
    expect(p).not.toBeNull();
    await expect(p).resolves.toBe('data_paths:{}');

    delete globals.__TAURI_INTERNALS__;
  });
});
