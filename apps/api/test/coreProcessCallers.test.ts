import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The three callers of the shared core-process owner (./coreProcess) keep only
 * what is theirs: config generation, failure classification, retry policy and
 * the measurement. These tests pin those seams, including the retry rule that
 * was dead code before the lifecycle was unified (the handler meant to catch a
 * taken port ran after the one that had already reported the failure, so every
 * clash was blamed on the config).
 */

const h = vi.hoisted(() => ({
  /** Ports handed out by the reservation seam, in order (repeats the last). */
  ports: [45_100] as number[],
  reserveCalls: 0,
  /** What the owner should return per call, in order (repeats the last). */
  results: [] as Array<Record<string, unknown>>,
  spawnCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/services/coreProcess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/coreProcess')>();
  return {
    ...actual,
    reservePort: () => {
      const port = h.ports[Math.min(h.reserveCalls, h.ports.length - 1)]!;
      h.reserveCalls += 1;
      return Promise.resolve(port);
    },
    spawnCoreProcess: (spec: Record<string, unknown>) => {
      h.spawnCalls.push(spec);
      const result = h.results[Math.min(h.spawnCalls.length - 1, h.results.length - 1)]!;
      return Promise.resolve(result);
    },
  };
});

import { startCore, startTunGateway } from '../src/services/proxyCores';
import { proxyProbe } from '../src/services/proxyProbe';

import type { ParsedNodeConfig } from '@netpulse/shared';

const OK_PROCESS = {
  ok: true,
  process: {
    child: { once: () => undefined, kill: () => true },
    readyPort: 45_100,
    output: '',
    cleanup: () => undefined,
  },
};

const PORT_CLASH = {
  ok: false,
  failure: 'port_clash',
  error: 'port 45100 was taken between reservation and start — the core was not spawned',
  output: '',
  exitCode: null,
};

function cfg(overrides: Partial<ParsedNodeConfig> = {}): ParsedNodeConfig {
  return {
    protocol: 'vless',
    host: '203.0.113.10',
    port: 443,
    transport: 'tcp',
    security: 'tls',
    sni: 'example.com',
    alpn: [],
    fingerprint: null,
    flow: null,
    alterId: null,
    path: null,
    hostHeader: null,
    serviceName: null,
    allowInsecure: false,
    encryption: null,
    ssrProtocol: null,
    remark: null,
    ...overrides,
  } as ParsedNodeConfig;
}

const ENGINE = { id: 'sing-box', bin: 'C:/fake/sing-box.exe', args: ['run'] } as const;

beforeEach(() => {
  h.ports = [45_100];
  h.reserveCalls = 0;
  h.results = [OK_PROCESS];
  h.spawnCalls = [];
});

describe('startCore on the shared owner', () => {
  it('retries ONCE on a taken port, with a fresh port and a regenerated config', async () => {
    h.ports = [45_100, 45_200];
    h.results = [PORT_CLASH, OK_PROCESS];

    const res = await startCore({ ...ENGINE }, cfg(), 'uuid', 500);

    expect(res.ok).toBe(true);
    expect(h.reserveCalls).toBe(2);
    expect(h.spawnCalls).toHaveLength(2);
    // The retry must not reuse the clashing port: a second attempt on the same
    // port would fail the same way and look like a node problem.
    expect(h.spawnCalls.map((c) => c['readyPort'])).toEqual([45_100, 45_200]);
  });

  it('reports honestly instead of looping when the port is still taken', async () => {
    h.results = [PORT_CLASH];

    const res = await startCore({ ...ENGINE }, cfg(), 'uuid', 500);

    expect(res.ok).toBe(false);
    // Two attempts: the first, and one honest retry.
    expect(h.spawnCalls).toHaveLength(2);
    if (res.ok) return;
    expect(res.error).toContain('45');
    // A taken port is not the node's fault and not a config problem — the
    // honest classification is that the core could not be started at all.
    expect(res.failure).toBe('engine_unavailable');
  });

  it('classifies an unexecutable core as engine_unavailable, carrying the reason', async () => {
    h.results = [
      { ok: false, failure: 'spawn_error', error: 'core spawn failed: ENOENT', output: '', exitCode: null },
    ];

    const res = await startCore({ ...ENGINE }, cfg(), 'uuid', 500);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure).toBe('engine_unavailable');
    expect(res.error).toBe('core spawn failed: ENOENT');
  });
});

describe('startTunGateway on the shared owner', () => {
  it('surfaces the owner’s failure verbatim and hands back its cleanup on success', async () => {
    h.results = [
      { ok: false, failure: 'timeout', error: 'TUN gateway did not become ready in 12000ms', output: '', exitCode: null },
    ];
    const failed = await startTunGateway('C:/fake/sing-box.exe', 45_000, null, 12_000, 'http', []);
    expect(failed).toEqual({ ok: false, error: 'TUN gateway did not become ready in 12000ms' });

    const cleanup = vi.fn();
    h.spawnCalls = [];
    h.results = [{ ok: true, process: { ...OK_PROCESS.process, cleanup } }];
    const started = await startTunGateway('C:/fake/sing-box.exe', 45_000, null, 12_000, 'http', []);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.gatewayPort).toBe(45_100);
    started.run.cleanup();
    expect(cleanup).toHaveBeenCalledTimes(1);
    // The gateway is spawned as the config the builder produced, by the owner.
    expect(h.spawnCalls[0]!['label']).toBe('TUN gateway');
    expect(h.spawnCalls[0]!['args']).toEqual(['run', '-c', expect.stringContaining('gateway.json')]);
  });
});

describe('the legacy single-engine probe on the shared owner', () => {
  it('still reports a missing core as engine_unavailable, never as a node result', async () => {
    h.results = [
      { ok: false, failure: 'spawn_error', error: 'sing-box spawn failed: ENOENT', output: '', exitCode: null },
    ];

    const r = await proxyProbe(cfg(), { secret: null, timeoutMs: 1_000 });

    expect(r.status).toBe('failed');
    expect(r.failureKind).toBe('engine_unavailable');
    expect(r.error).toContain('sing-box is not installed');
    expect(h.spawnCalls[0]!['label']).toBe('sing-box');
  });

  it('reports a core that started but never answered as engine_start_failed', async () => {
    h.results = [
      { ok: false, failure: 'timeout', error: 'sing-box did not become ready in 5000ms', output: '', exitCode: null },
    ];

    const r = await proxyProbe(cfg(), { secret: null, timeoutMs: 1_000 });

    expect(r.status).toBe('failed');
    expect(r.failureKind).toBe('engine_start_failed');
    expect(r.error).toBe('sing-box did not become ready in 5000ms');
  });
});
