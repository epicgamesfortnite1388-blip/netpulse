import { describe, expect, it, vi } from 'vitest';

import { NodesService } from '../src/services/nodesService';

import type { PublicNode, PublicNodeRow } from '../src/db/repositories';
import type { NodeTestResult } from '../src/services/nodesService';
import type { RealtimeBus } from '../src/realtime/bus';
import type { Logger } from '../src/logger';

/**
 * Runtime-column regression: the explorer shows which core (xray / sing-box)
 * last tested each node. The engine recorded on the test result must be
 * denormalized onto the node row — but ONLY for proxy tests; tcp/tls/icmp
 * results carry no engine and must not clobber a previously recorded one.
 */

function nodeRow(engine: string | null): PublicNode {
  const now = Date.now();
  return {
    id: 'node:eng1',
    canonicalFingerprint: 'fp',
    fingerprint: null,
    protocol: 'shadowsocks',
    host: '198.51.100.7',
    ipv4: [],
    ipv6: [],
    port: 443,
    transport: 'tcp',
    security: 'none',
    sni: null,
    alpn: [],
    flow: null,
    alterId: null,
    encryption: 'aes-256-gcm',
    ssrProtocol: null,
    path: null,
    hostHeader: null,
    serviceName: null,
    allowInsecure: false,
    realityPublicKey: null,
    realityShortId: null,
    realityServerName: null,
    remark: null,
    sourceIds: ['src1'],
    sourceUrls: ['https://example.test/sub'],
    sourceCount: 1,
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
    lastEngine: engine as string | null,
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

type UpdatePatch = Record<string, unknown>;

function makeService(node: PublicNode) {
  const updates: UpdatePatch[] = [];
  const nodes = {
    get: vi.fn(() => node),
    update: vi.fn((id: string, patch: UpdatePatch) => {
      updates.push(patch);
      Object.assign(node, patch);
    }),
  };
  const svc = new NodesService({
    nodes,
    events: { insert: vi.fn() },
    tests: { insert: vi.fn(), update: vi.fn(), listByNode: vi.fn(() => []) },
    health: { get: vi.fn(() => null), upsert: vi.fn() },
    addresses: { insert: vi.fn() },
    sourceRepo: { get: () => null, update: vi.fn() },
    bus: { publish: vi.fn() } as unknown as RealtimeBus,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger,
  } as never);
  return { svc, updates, nodes };
}

const proxyResult = (engine: string | null): NodeTestResult =>
  ({
    nodeId: 'node:eng1',
    type: 'proxy',
    status: 'done',
    startedAt: Date.now(),
    finishedAt: Date.now(),
    latencyMs: 123,
    totalMs: 200,
    tlsVersion: 'TLSv1.2',
    authorized: true,
    httpStatus: 200,
    responseSize: 10,
    error: null,
    family: 4,
    probedIp: '198.51.100.7',
    testEndpoint: 'https://httpbin.org/ip',
    engine,
  }) as NodeTestResult;

describe('node lastEngine attribution', () => {
  it('updateNodeAfterTest stamps the engine from a proxy result', async () => {
    const node = nodeRow(null);
    const { svc, updates } = makeService(node);
    await (svc as unknown as { updateNodeAfterTest: (n: string, node: PublicNode, r: NodeTestResult, t: string) => Promise<void> }).updateNodeAfterTest(
      'node:eng1',
      node,
      proxyResult('xray'),
      'proxy',
    );
    const patch = updates.find((u) => 'lastEngine' in u);
    expect(patch?.['lastEngine']).toBe('xray');
  });

  it('sing-box attribution also lands', async () => {
    const node = nodeRow('xray');
    const { svc, updates } = makeService(node);
    await (svc as unknown as { updateNodeAfterTest: (n: string, node: PublicNode, r: NodeTestResult, t: string) => Promise<void> }).updateNodeAfterTest(
      'node:eng1',
      node,
      proxyResult('sing-box'),
      'proxy',
    );
    const patch = updates.find((u) => 'lastEngine' in u);
    expect(patch?.['lastEngine']).toBe('sing-box');
  });

  it('a tcp test does not clobber the previously recorded engine', async () => {
    const node = nodeRow('xray');
    const { svc, updates } = makeService(node);
    const tcpResult = { ...proxyResult(null), type: 'tcp', latencyMs: 30, tlsVersion: null, engine: null } as NodeTestResult;
    await (svc as unknown as { updateNodeAfterTest: (n: string, node: PublicNode, r: NodeTestResult, t: string) => Promise<void> }).updateNodeAfterTest(
      'node:eng1',
      node,
      tcpResult,
      'tcp',
    );
    const patch = updates.find((u) => 'lastEngine' in u);
    expect(patch?.['lastEngine']).toBe('xray');
  });

  it('toWebDTO sanitizes an unknown engine value to null', () => {
    const node = nodeRow('v2ray-core-obsolete');
    const { svc } = makeService(node);
    const dto = (svc as unknown as { toWebDTO: (n: PublicNode) => { lastEngine: 'xray' | 'sing-box' | null } }).toWebDTO(node);
    expect(dto.lastEngine).toBeNull();
  });

  it('toWebDTO passes a known engine through', () => {
    const node = nodeRow('sing-box');
    const { svc } = makeService(node);
    const dto = (svc as unknown as { toWebDTO: (n: PublicNode) => { lastEngine: 'xray' | 'sing-box' | null } }).toWebDTO(node);
    expect(dto.lastEngine).toBe('sing-box');
  });
});

/* ---------- Runtime filter (listNodes engine option) ---------- */

describe('listNodes engine filter', () => {
  function makeListService(rows: Array<{ lastEngine: string | null }>) {
    const nodes = {
      list: vi.fn((opts: Record<string, unknown>) => {
        // Mirror the repository's engine condition so the service-level test
        // proves the option is threaded end-to-end (route → service → repo).
        const filtered = opts.engine ? rows.filter((r) => r.lastEngine === opts.engine) : rows;
        return { rows: filtered, total: filtered.length };
      }),
    };
    const svc = new NodesService({
      nodes,
      events: { insert: vi.fn() },
      tests: { insert: vi.fn(), update: vi.fn(), listByNode: vi.fn(() => []) },
      health: { get: vi.fn(() => null), upsert: vi.fn() },
      addresses: { insert: vi.fn() },
      sourceRepo: { get: () => null, update: vi.fn() },
      bus: { publish: vi.fn() } as unknown as RealtimeBus,
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger,
    } as never);
    return { svc, nodes };
  }

  it('threads the engine option through to the repository list call', () => {
    const { svc, nodes } = makeListService([]);
    svc.listNodes({ engine: 'xray' });
    expect(nodes.list).toHaveBeenCalledWith(expect.objectContaining({ engine: 'xray' }));
  });

  it('omits the engine option when unset', () => {
    const { svc, nodes } = makeListService([]);
    svc.listNodes({});
    expect(nodes.list).toHaveBeenCalledWith(expect.not.objectContaining({ engine: expect.anything() }));
  });
});
