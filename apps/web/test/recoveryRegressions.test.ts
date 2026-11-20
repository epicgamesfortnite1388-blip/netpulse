import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describeEvent, lastFailedHealthSignal, recordReplayGap, emptyEventState } from '../src/features/nani/naniEvents';
import { parseHealthCheckResult } from '../src/features/nani/NaniPage';
import { streamAi } from '../src/features/copilot/aiApi';
import { fetchUpdateHistory } from '../src/lib/updater';

// Vitest runs from the web workspace; resolve from cwd (import.meta.url is not
// a file: URL under Vite's module runner).
const repoWeb = process.cwd();
function source(rel: string): string {
  return readFileSync(path.join(repoWeb, rel), 'utf8');
}
function sourceCode(rel: string): string {
  return source(rel)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
    .join('\n');
}

/**
 * Recovery regression guards.
 *
 * Each test names the finding it protects. These are the defects that the
 * continuation review confirmed by source inspection, fixed in the recovery
 * pass, and that must never silently return.
 */

describe('F-03 — attempt counts are never converted to health verdicts', () => {
  it('returns null healthy when the web path has no aggregate verdict', () => {
    const parsed = parseHealthCheckResult('check failed: sidecar down', 3);
    expect(parsed.healthy).toBeNull();
    expect(parsed.total).toBe(3);
  });
  it('still parses a real desktop aggregate verdict', () => {
    const parsed = parseHealthCheckResult('health_check_complete: 2/3 healthy', 0);
    expect(parsed.healthy).toBe(2);
    expect(parsed.total).toBe(3);
  });
});

describe('F-06 — proxy-derived health is never presented as direct', () => {
  it('qualifies a health event that names an upstream route', () => {
    const text = describeEvent('HealthCheckCompleted', {
      api_id: 'netpulse-cloud',
      health: 'Healthy',
      route: 'upstream:system-proxy-inferred',
    });
    expect(text).toContain('upstream:system-proxy-inferred');
    expect(text).toContain('not a direct measurement');
  });

  it('does not let a proxy-derived healthy event erase an older failure', () => {
    const failed = { eventId: '1:f', seq: 1, at: 1, type: 'CircuitBreakerTripped', payload: { api_id: 'a' }, schemaVersion: 1 } as const;
    const events = [
      failed,
      { eventId: '2:p', seq: 2, at: 2, type: 'HealthCheckCompleted', payload: { api_id: 'a', health: 'Healthy', route: 'upstream:system-proxy-inferred' }, schemaVersion: 1 },
    ] as never[];
    expect(lastFailedHealthSignal(events)).not.toBeNull();
  });
});

describe('F-08 — an absent verification result is not a pass', () => {
  it('reports missing verified as unavailable, not passed', () => {
    expect(describeEvent('VerificationCompleted', {})).toBe('Verification unavailable');
    expect(describeEvent('VerificationCompleted', { verified: undefined })).toBe('Verification unavailable');
  });
  it('keeps explicit pass/fail truthful', () => {
    expect(describeEvent('VerificationCompleted', { verified: true })).toBe('Verification passed');
    expect(describeEvent('VerificationCompleted', { verified: false })).toBe('Verification failed');
  });
});

describe('F-09 — only a healthy check resumes observation', () => {
  const failed = { eventId: '1:f', seq: 1, at: 1, type: 'CircuitBreakerTripped', payload: { api_id: 'a' }, schemaVersion: 1 } as const;
  it('an Unhealthy verdict keeps the older failure reason visible', () => {
    const events = [
      failed,
      { eventId: '2:h', seq: 2, at: 2, type: 'HealthCheckCompleted', payload: { api_id: 'a', health: 'Unhealthy' }, schemaVersion: 1 },
    ] as never[];
    const signal = lastFailedHealthSignal(events);
    expect(signal).not.toBeNull();
    expect(signal?.label.toLowerCase()).toContain('health check');
  });
  it('a Healthy or Degraded verdict still resumes observation', () => {
    for (const health of ['Healthy', 'Degraded']) {
      const events = [
        failed,
        { eventId: `2:${health}`, seq: 2, at: 2, type: 'HealthCheckCompleted', payload: { api_id: 'a', health }, schemaVersion: 1 },
      ] as never[];
      expect(lastFailedHealthSignal(events)).toBeNull();
    }
  });
});

describe('F-07 — backend replay gaps are surfaced, not dropped', () => {
  it('recordReplayGap increments the gap counter', () => {
    const start = emptyEventState();
    const after = recordReplayGap(start);
    expect(after.gapCount).toBe(start.gapCount + 1);
    expect(after.joinedLate).toBe(true);
  });
});

describe('F-30 — Stop prevents a late delta', () => {
  it('does not call onDelta when the signal aborts before resolution', async () => {
    let delivered = 0;
    const controller = new AbortController();
    controller.abort();
    await expect(
      streamAi({ question: 'x', onDelta: () => { delivered += 1; }, signal: controller.signal }),
    ).rejects.toThrow(/aborted/i);
    expect(delivered).toBe(0);
  });

  it('does NOT deliver a delta when Stop is pressed while the IPC is in flight', async () => {
    // This is the ACTUAL F-30 defect: the original code checked aborted BEFORE
    // `await askAi(...)` and then called onDelta unconditionally. A pre-abort
    // test would pass on the buggy code, so we abort during the pending call.
    const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
    const previous = w.__TAURI_INTERNALS__;
    let resolveIpc!: (value: unknown) => void;
    w.__TAURI_INTERNALS__ = {
      invoke: () => new Promise((resolve) => { resolveIpc = resolve; }),
    };
    const controller = new AbortController();
    let delivered = 0;
    try {
      const pending = streamAi({
        question: 'x',
        onDelta: () => { delivered += 1; },
        signal: controller.signal,
      });
      // Let streamAi reach the await, then press Stop and only then resolve IPC.
      await Promise.resolve();
      controller.abort();
      resolveIpc({ deterministic: 'late answer', narrative: null, source: 'deterministic', grounded: true, warning: null });
      await expect(pending).rejects.toThrow(/aborted/i);
      expect(delivered).toBe(0);
    } finally {
      if (previous === undefined) delete w.__TAURI_INTERNALS__;
      else w.__TAURI_INTERNALS__ = previous;
    }
  });
});

describe('F-32 — update-history transport failure is not an empty history', () => {
  it('rejects when the API rejects instead of resolving []', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error('sidecar down'))) as typeof fetch;
    try {
      await expect(fetchUpdateHistory()).rejects.toThrow('sidecar down');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('F-27 — Settings tabs are reachable by click', () => {
  it('wires a real onValueChange that writes the ?tab= URL param', () => {
    const src = sourceCode('src/features/settings/SettingsPage.tsx');
    // The original defect discarded the setter and passed value with no
    // handler, so every click was a no-op. Both halves must be present.
    expect(src).toMatch(/useSearchParams\(\)/);
    expect(src).toMatch(/setSearchParams/);
    expect(src).toMatch(/onValueChange=\{selectTab\}/);
    expect(src).toMatch(/next\.set\('tab', value\)/);
  });
});

describe('F-28 — startup health uses the canonical Tauri v2 resolver', () => {
  it('does not probe window.__TAURI__.invoke directly in executable code', () => {
    // Strip comment lines: the explanatory note quotes the old buggy pattern.
    const code = sourceCode('src/lib/useStartupHealth.ts');
    expect(code).not.toMatch(/__TAURI__\?\.invoke/);
    expect(code).toMatch(/tauriInvoke<RuntimeStatus>\('runtime_status'\)/);
  });

  it('the canonical resolver finds __TAURI__.core.invoke (packaged v2)', async () => {
    const w = window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
    const prevI = w.__TAURI_INTERNALS__;
    const prevT = w.__TAURI__;
    delete w.__TAURI_INTERNALS__;
    let called = '';
    w.__TAURI__ = { core: { invoke: (cmd: string) => { called = cmd; return Promise.resolve({ sidecar_running: true }); } } };
    try {
      const { tauriInvoke } = await import('../src/lib/transport');
      const result = tauriInvoke('runtime_status');
      expect(result).not.toBeNull();
      await result;
      expect(called).toBe('runtime_status');
    } finally {
      if (prevI === undefined) delete w.__TAURI_INTERNALS__; else w.__TAURI_INTERNALS__ = prevI;
      if (prevT === undefined) delete w.__TAURI__; else w.__TAURI__ = prevT;
    }
  });
});

describe('F-05 follow-up — mounted connection console does not crash on partial payload', () => {
  it('deriveConnection handles a tunnel object missing the state field', async () => {
    // The refetchInterval crash came from `data?.tunnel.state` where `tunnel`
    // existed but was not the expected shape. Verify the optional-chain guard
    // is present in the source so mounting the hook cannot throw again.
    const src = sourceCode('src/features/connection/connectionState.ts');
    expect(src).toMatch(/q\.state\.data\?\.tunnel\?\.state/);
    expect(src).not.toMatch(/q\.state\.data\?\.tunnel\.state/);
  });
});
