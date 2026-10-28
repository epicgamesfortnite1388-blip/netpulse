import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  starts: [] as Array<{ engine: string; count: number }>,
  cleanups: 0,
  probedPorts: [] as number[],
  nextPortBase: 46_000,
  engines: {} as Record<string, boolean>,
  failStarts: false,
}));

vi.mock('../src/services/proxyCores', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxyCores')>();
  return {
    ...actual,
    findEngineBinary: (id: string) => (h.engines[id] ? `C:/fake/${id}.exe` : null),
    startMultiCore: async (engine: { id: string }, nodes: unknown[]) => {
      if (h.failStarts) {
        return { ok: false, failure: 'engine_start_failed', error: `${engine.id} (batch) exited during startup (code 23)` };
      }
      h.starts.push({ engine: engine.id, count: nodes.length });
      const ports = nodes.map((_, i) => h.nextPortBase + i);
      h.nextPortBase += 100;
      return {
        ok: true,
        run: {
          inboundPorts: ports,
          cleanup: () => { h.cleanups += 1; },
          stderrTail: '',
        },
      };
    },
  };
});

vi.mock('../src/services/proxyProbe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxyProbe')>();
  return {
    ...actual,
    httpsViaConnectRef: async (port: number) => {
      h.probedPorts.push(port);
      return { status: 200, latencyMs: 12, tlsVersion: 'TLSv1.3' };
    },
  };
});

vi.mock('../src/services/nodeTestProbes', () => ({
  runProbe: vi.fn(),
  proxyProbeMany: vi.fn(),
}));

import { proxyProbeManyWithEngine } from '../src/services/proxyEngineRunner';
import { NodesService } from '../src/services/nodesService';
import { proxyProbeMany, runProbe } from '../src/services/nodeTestProbes';

import type { MultiCoreNode } from '../src/services/proxyCores';
import type { NodeTestResult } from '../src/services/nodesService';
import type { ParsedNodeConfig, PublicNode } from '@netpulse/shared';
import type { RealtimeBus } from '../src/realtime/bus';
import type { Logger } from '../src/logger';

function cfg(overrides: Partial<ParsedNodeConfig> = {}): ParsedNodeConfig {
  return {
    protocol: 'vless',
    host: 'node.example',
    port: 443,
    transport: 'tcp',
    security: 'tls',
    sni: 'node.example',
    ...overrides,
  } as ParsedNodeConfig;
}

function entries(n: number, overrides: Partial<ParsedNodeConfig> = {}): MultiCoreNode[] {
  return Array.from({ length: n }, (_, i) => ({
    config: cfg({ host: `node-${i}.example`, ...overrides }),
    secret: `secret-${i}`,
  }));
}

beforeEach(() => {
  h.starts = [];
  h.cleanups = 0;
  h.probedPorts = [];
  h.nextPortBase = 46_000;
  h.engines = { xray: true, 'sing-box': true };
  h.failStarts = false;
});

/* ----------------------------- runner grouping ---------------------------- */

describe('proxyProbeManyWithEngine grouping', () => {
  it('serves many nodes through a few shared cores instead of one per node', async () => {
    const res = await proxyProbeManyWithEngine(entries(20), {
      preferred: 'auto',
      nodesPerCore: 8,
      coresInFlight: 1,
    });

    // 20 nodes → 3 cores (8 + 8 + 4), not 20.
    expect(h.starts.map((s) => s.count)).toEqual([8, 8, 4]);
    expect(h.starts.every((s) => s.engine === 'xray')).toBe(true);
    expect(h.cleanups).toBe(3);

    expect(res).toHaveLength(20);
    expect(res.every((r) => r?.status === 'done' && r.engine === 'xray')).toBe(true);
    // Every node was probed through its own port, and each port was used once.
    expect(h.probedPorts).toHaveLength(20);
    expect(new Set(h.probedPorts).size).toBe(20);
  });

  it('reports per-node engine and latency from the shared core', async () => {
    const res = await proxyProbeManyWithEngine(entries(3), { preferred: 'auto', nodesPerCore: 8 });
    for (const r of res) {
      expect(r).toMatchObject({ status: 'done', engine: 'xray', latencyMs: 12, httpStatus: 200, failureKind: null });
    }
  });

  it('fails only the node whose config no core can run, and spawns no core for it', async () => {
    const mixed = [
      ...entries(2),
      { config: cfg({ protocol: 'shadowsocksr' as ParsedNodeConfig['protocol'] }), secret: 'ssr' },
    ];
    const res = await proxyProbeManyWithEngine(mixed, { preferred: 'auto', nodesPerCore: 8 });

    expect(res[0]?.status).toBe('done');
    expect(res[1]?.status).toBe('done');
    expect(res[2]?.status).toBe('failed');
    expect(res[2]?.failureKind).toBe('engine_unavailable');
    expect(res[2]?.error).toContain('shadowsocksr');
    // The two runnable nodes still shared one core.
    expect(h.starts).toEqual([{ engine: 'xray', count: 2 }]);
  });

  it('routes hysteria2 through sing-box (the Hysteria client cannot batch)', async () => {
    const res = await proxyProbeManyWithEngine(
      entries(2, { protocol: 'hysteria2' as ParsedNodeConfig['protocol'] }),
      { preferred: 'hysteria', nodesPerCore: 8 },
    );
    expect(h.starts).toEqual([{ engine: 'sing-box', count: 2 }]);
    expect(res.every((r) => r?.engine === 'sing-box')).toBe(true);
  });

  it('never puts a credential-less node in a shared core (its config would kill the group)', async () => {
    // Evidence: xray 26.3.27 exits 23 during startup on a batch that contains
    // one node with no uuid/password, so sharing a core with it would report
    // its siblings as failed too. It must be probed on its own instead.
    const mixed = [...entries(2), { config: cfg({ host: 'no-secret.example' }), secret: null }];
    const res = await proxyProbeManyWithEngine(mixed, { preferred: 'auto', nodesPerCore: 8 });

    // The two credentialed nodes still shared ONE core; the third spawned none.
    expect(h.starts).toEqual([{ engine: 'xray', count: 2 }]);
    expect(res[0]?.status).toBe('done');
    expect(res[1]?.status).toBe('done');
    // Its own failure, not the group's: never the batch-startup error.
    expect(res[2]?.status).toBe('failed');
    expect(res[2]?.error).not.toContain('exited during startup');
  });

  it('falls back to the single-node path when no shared core can dial the node', async () => {
    h.engines = {};
    const res = await proxyProbeManyWithEngine(entries(2), { preferred: 'auto' });
    expect(h.starts).toHaveLength(0);
    expect(res.every((r) => r?.status === 'failed' && r.failureKind === 'engine_unavailable')).toBe(true);
    expect(res[0]?.error).toMatch(/no proxy core installed/i);
  });

  it('announces single-path nodes too, so the caller can open a row for them', async () => {
    // The service opens each test row on onGroupStart. Before this, a node that
    // took the single path was probed and then reported nowhere: `test-batch`
    // returned no entry for it and its health counters never moved.
    h.engines = {};
    const groups: number[][] = [];
    const res = await proxyProbeManyWithEngine(entries(2), {
      preferred: 'auto',
      onGroupStart: (indexes) => groups.push([...indexes]),
    });
    expect(groups.every((g) => g.length === 1)).toBe(true);
    expect(groups.flat().sort((a, b) => a - b)).toEqual([0, 1]);
    expect(res.every((r) => r?.status === 'failed')).toBe(true);
  });

  it('stops starting new cores when shouldStop flips, leaving the rest unprobed', async () => {
    let groups = 0;
    const res = await proxyProbeManyWithEngine(entries(20), {
      preferred: 'auto',
      nodesPerCore: 8,
      coresInFlight: 1,
      shouldStop: () => groups++ > 0,
    });
    expect(h.starts).toHaveLength(1);
    expect(res.slice(0, 8).every((r) => r?.status === 'done')).toBe(true);
    // Never reached: null, not a fabricated failure.
    expect(res.slice(8).every((r) => r === null)).toBe(true);
  });

  it('reports a batch that could not start as an environment failure for every node in it', async () => {
    h.failStarts = true;
    const res = await proxyProbeManyWithEngine(entries(3), { preferred: 'auto' });
    expect(res.every((r) => r?.status === 'failed' && r?.failureKind === 'engine_start_failed')).toBe(true);
    expect(res[0]?.error).toContain('exited during startup');
    expect(h.cleanups).toBe(0);
  });

  it('fires onGroupStart with the SAME indexes that are later probed', async () => {
    const groups: number[][] = [];
    const settled: number[] = [];
    await proxyProbeManyWithEngine(entries(10), {
      preferred: 'auto',
      nodesPerCore: 4,
      coresInFlight: 1,
      onGroupStart: (indexes) => groups.push([...indexes]),
      onResult: (index) => settled.push(index),
    });
    expect(groups).toEqual([[0, 1, 2, 3], [4, 5, 6, 7], [8, 9]]);
    expect(settled.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

/* ------------------------- service bulk wiring ---------------------------- */

function nodeRow(id: string): PublicNode {
  const now = Date.now();
  return {
    id,
    canonicalFingerprint: id,
    fingerprint: null,
    protocol: 'vless',
    host: '198.51.100.7',
    ipv4: [],
    ipv6: [],
    port: 443,
    transport: 'tcp',
    security: 'tls',
    sni: 'example.test',
    alpn: [],
    flow: null,
    alterId: null,
    encryption: null,
    ssrProtocol: null,
    path: null,
    hostHeader: null,
    serviceName: null,
    allowInsecure: false,
    realityPublicKey: null,
    realityShortId: null,
    realityServerName: null,
    remark: null,
    sourceIds: [],
    sourceUrls: [],
    sourceCount: 0,
    firstSeen: now,
    lastSeen: now,
    lastValidated: null,
    status: 'discovered',
    confidence: 'unknown',
    country: null,
    city: null,
    asn: null,
    geoLastAttempt: null,
    isp: null,
    organization: null,
    lat: null,
    lon: null,
    geoSourceCount: 0,
    userNotes: null,
    score: 0,
    reliabilityPct: 0,
    medianProxyMs: null,
    medianTcpMs: null,
    medianTlsMs: null,
    recentLossPct: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    freshness: 'stale',
    tags: [],
    favorite: false,
    lastProxyMs: null,
    lastEngine: null,
    lastTcpMs: null,
    lastTlsMs: null,
    testCount: 0,
    successCount: 0,
    failureCount: 0,
    consecutiveFailures: 0,
    recentTestCount: 0,
    recentSuccessCount: 0,
    recentFailureCount: 0,
    createdAt: now,
    updatedAt: now,
  } as unknown as PublicNode;
}

function resultFor(nodeId: string, type: 'proxy' | 'tcp'): NodeTestResult {
  return {
    nodeId,
    type,
    status: 'done',
    startedAt: Date.now(),
    finishedAt: Date.now(),
    latencyMs: 42,
    totalMs: 80,
    tlsVersion: type === 'proxy' ? 'TLSv1.3' : null,
    authorized: type === 'proxy' ? true : null,
    httpStatus: type === 'proxy' ? 200 : null,
    responseSize: null,
    error: null,
    family: 4,
    probedIp: '198.51.100.7',
    testEndpoint: type === 'proxy' ? 'https://example.test/ip' : null,
    engine: type === 'proxy' ? 'xray' : null,
  } as NodeTestResult;
}

function makeService(ids: string[]) {
  const rows = new Map(ids.map((id) => [id, nodeRow(id)]));
  const tests = { insert: vi.fn(), update: vi.fn(), listByNode: vi.fn(() => []) };
  const nodes = {
    get: vi.fn((id: string) => rows.get(id)),
    update: vi.fn(),
  };
  const events = { insert: vi.fn() };
  const health = { get: vi.fn(() => null), upsert: vi.fn() };
  const vault = { get: vi.fn(() => 'vaulted-secret') };
  const svc = new NodesService({
    nodes,
    events,
    tests,
    health,
    addresses: { insert: vi.fn() },
    sourceRepo: { get: () => null, update: vi.fn() },
    testEndpoints: { list: () => [] },
    nodeVault: vault,
    bus: { publish: vi.fn() } as unknown as RealtimeBus,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger,
  } as never);
  return { svc, tests, nodes, vault, events };
}

describe('NodesService.testNodes', () => {
  it('opens rows per shared group and finalizes each node from the batched result', async () => {
    const { svc, tests, vault } = makeService(['node:a', 'node:b']);

    vi.mocked(proxyProbeMany).mockImplementation(async (_nodes, _deps, opts) => {
      opts.onGroupStart?.([0, 1]);
      return [resultFor('node:a', 'proxy'), resultFor('node:b', 'proxy')];
    });

    const outcomes = await svc.testNodes(['node:a', 'node:b'], 'proxy');

    expect(proxyProbeMany).toHaveBeenCalledTimes(1);
    // The service hands the runner a per-node secret lookup backed by the vault
    // (the runner is what actually calls it, per node, as it builds the batch).
    const runnerOpts = vi.mocked(proxyProbeMany).mock.calls[0]?.[2];
    expect(runnerOpts?.secretFor('node:a')).toBe('vaulted-secret');
    expect(runnerOpts?.secretFor('node:b')).toBe('vaulted-secret');
    expect(vault.get).toHaveBeenCalledWith('node:a');
    expect(vault.get).toHaveBeenCalledWith('node:b');
    expect(outcomes.map((o) => o?.result?.status)).toEqual(['done', 'done']);
    // One row per node, opened when the group started.
    expect(tests.insert).toHaveBeenCalledTimes(2);
    const finals = tests.update.mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(finals.filter((f) => f['status'] === 'done')).toHaveLength(2);
    expect(finals.every((f) => f['engine'] === 'xray')).toBe(true);
  });

  it('leaves a cancelled node without a row and without an outcome', async () => {
    const { svc, tests } = makeService(['node:a', 'node:b']);

    vi.mocked(proxyProbeMany).mockImplementation(async (_nodes, _deps, opts) => {
      opts.onGroupStart?.([0]);
      return [resultFor('node:a', 'proxy'), null];
    });

    const outcomes = await svc.testNodes(['node:a', 'node:b'], 'proxy', { shouldStop: () => true });

    expect(tests.insert).toHaveBeenCalledTimes(1);
    expect(outcomes[0]?.result?.status).toBe('done');
    // Cancelled nodes are untouched: no outcome, no orphaned 'running' row.
    expect(outcomes[1]).toBeNull();
  });

  it('reports an unknown node id without stopping the rest of the batch', async () => {
    const { svc } = makeService(['node:a']);
    vi.mocked(proxyProbeMany).mockImplementation(async (nodes, _deps, opts) => {
      opts.onGroupStart?.([0]);
      return nodes.map((n) => resultFor(n.id, 'proxy'));
    });

    const outcomes = await svc.testNodes(['node:a', 'node:missing'], 'proxy');

    expect(outcomes[0]?.result?.status).toBe('done');
    expect(outcomes[1]?.error).toContain('node not found');
    // The batched runner never saw the unknown id.
    expect(vi.mocked(proxyProbeMany).mock.calls[0]?.[0].map((n) => n.id)).toEqual(['node:a']);
  });

  it('marks every started row failed when the batched runner throws', async () => {
    const { svc, tests } = makeService(['node:a']);
    vi.mocked(proxyProbeMany).mockImplementation(async (_nodes, _deps, opts) => {
      opts.onGroupStart?.([0]);
      throw new Error('config generation bug');
    });

    const outcomes = await svc.testNodes(['node:a'], 'proxy');

    expect(outcomes[0]?.error).toBe('config generation bug');
    const finals = tests.update.mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(finals.some((f) => f['status'] === 'failed')).toBe(true);
  });

  it('uses the worker pool for cheap probes (no cores to share)', async () => {
    const { svc, tests, events } = makeService(['node:a', 'node:b']);
    vi.mocked(runProbe).mockResolvedValue(resultFor('node:a', 'tcp'));

    const outcomes = await svc.testNodes(['node:a', 'node:b'], 'tcp', { concurrency: 2 });

    expect(runProbe).toHaveBeenCalledTimes(2);
    expect(proxyProbeMany).not.toHaveBeenCalled();
    expect(tests.insert).toHaveBeenCalledTimes(2);
    expect(outcomes.every((o) => o?.result?.status === 'done')).toBe(true);
    expect(events.insert.mock.calls.filter((c) => (c[0] as { kind: string }).kind === 'node.test.started')).toHaveLength(2);
  });

  it('retries a failed cheap probe once before recording it (a stall is not a dead node)', async () => {
    // reports/adaptive/RAW_PATH_IR_ISP.txt D1/D3: the ISP stalls a single port
    // intermittently. One timed-out attempt must not reach the node's history.
    const { svc, tests } = makeService(['node:a']);
    vi.mocked(runProbe).mockReset();
    vi.mocked(runProbe)
      .mockResolvedValueOnce({ ...resultFor('node:a', 'tcp'), status: 'failed', latencyMs: null, error: 'timeout' } as NodeTestResult)
      .mockResolvedValueOnce(resultFor('node:a', 'tcp'));

    const outcomes = await svc.testNodes(['node:a'], 'tcp', { concurrency: 1 });

    expect(runProbe).toHaveBeenCalledTimes(2);
    expect(outcomes[0]?.result?.status).toBe('done');
    const finals = tests.update.mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(finals.filter((f) => f['status'] === 'done')).toHaveLength(1);
    expect(finals.some((f) => f['status'] === 'failed')).toBe(false);
  });

  it('stops at one retry and records the failure when both attempts stall', async () => {
    const { svc, tests } = makeService(['node:a']);
    vi.mocked(runProbe).mockReset();
    vi.mocked(runProbe).mockResolvedValue({
      ...resultFor('node:a', 'tcp'), status: 'failed', latencyMs: null, error: 'timeout',
    } as NodeTestResult);

    const outcomes = await svc.testNodes(['node:a'], 'tcp', { concurrency: 1 });

    expect(runProbe).toHaveBeenCalledTimes(2);
    expect(outcomes[0]?.result?.status).toBe('failed');
    const finals = tests.update.mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(finals.filter((f) => f['status'] === 'failed')).toHaveLength(1);
    expect(finals.some((f) => f['status'] === 'done')).toBe(false);
  });
});
