import { describe, expect, it } from 'vitest';

import { nodePinsFromDb } from '../src/features/map/nodePins';

import type { NodeView } from '@netpulse/shared';

/**
 * Globe pins are seeded from `NodeView` — the shape the API actually sends,
 * which has no `host`, `port` or `ipv4`. The old contract here asserted the
 * OPPOSITE of the current one: that a pin without a remark falls back to the
 * host. That fallback was the address reaching the globe, so it is gone, and
 * these tests now pin what replaced it — a label that is always present and
 * never an address, and a subtitle that always says something.
 */
function dbNode(over: Partial<NodeView>): NodeView {
  return {
    id: 'n1',
    canonicalFingerprint: '20ea8e831399eea9346097285a1a84115653c3d6d9da57db7f1020adc46057ab',
    protocol: 'vless',
    protocolLabel: 'VLESS',
    label: 'Frankfurt relay',
    endpointHidden: true,
    transport: 'tcp',
    transportLabel: 'TCP',
    security: 'tls',
    securityLabel: 'TLS',
    alpn: [],
    fingerprint: null,
    flow: null,
    alterId: null,
    path: null,
    serviceName: null,
    allowInsecure: false,
    realityPublicKey: null,
    realityShortId: null,
    encryption: null,
    ssrProtocol: null,
    remark: 'Frankfurt relay',
    sourceIds: [],
    sourceUrls: [],
    sourceCount: 1,
    firstSeen: 0,
    lastSeen: 0,
    lastValidated: null,
    status: 'healthy',
    confidence: 'medium',
    country: 'DE',
    city: 'Frankfurt',
    asn: 24940,
    isp: null,
    organization: null,
    lat: 50.11,
    lon: 8.68,
    geoSourceCount: 1,
    geoStatusReason: 'known',
    tags: [],
    favorite: false,
    userNotes: null,
    lastProxyMs: 42,
    lastEngine: null,
    lastTcpMs: 40,
    lastTlsMs: null,
    testCount: 1,
    successCount: 1,
    failureCount: 0,
    consecutiveFailures: 0,
    recentTestCount: 0,
    recentSuccessCount: 0,
    recentFailureCount: 0,
    score: 80,
    reliabilityPct: 100,
    medianProxyMs: 42,
    medianTcpMs: 40,
    medianTlsMs: null,
    recentLossPct: 0,
    lastSuccessAt: 0,
    lastFailureAt: null,
    freshness: 'fresh',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe('nodePinsFromDb (globe seeding from the node DB)', () => {
  it('maps a geo-verified healthy node to an honest pin', () => {
    const pins = nodePinsFromDb([dbNode({})]);
    expect(pins).toHaveLength(1);
    const p = pins[0]!;
    expect(p.id).toBe('node:n1');
    expect(p.label).toBe('Frankfurt relay');
    // The subtitle carries place and protocol — not `host:port`.
    expect(p.sub).toBe('Frankfurt, DE · VLESS');
    expect(p.lat).toBe(50.11);
    expect(p.lon).toBe(8.68);
    expect(p.kind).toBe('vpn');
    expect(p.status).toBe('good');
    expect(p.latencyMs).toBe(42);
    expect(p.geoConfidence).toBe('medium');
  });

  it('never places a node without coordinates (Unknown stays Unknown)', () => {
    const pins = nodePinsFromDb([dbNode({ lat: null, lon: null })]);
    expect(pins).toHaveLength(0);
  });

  it('refused geo statuses (anycast/edge_fabric/lookup_failed/pending) get no pin', () => {
    const pins = nodePinsFromDb([
      dbNode({ id: 'a', geoStatusReason: 'anycast' }),
      dbNode({ id: 'b', geoStatusReason: 'edge_fabric' }),
      dbNode({ id: 'c', geoStatusReason: 'lookup_failed' }),
      dbNode({ id: 'd', geoStatusReason: 'pending' }),
    ]);
    expect(pins).toHaveLength(0);
  });

  it('unhealthy lifecycle maps to honest statuses', () => {
    expect(nodePinsFromDb([dbNode({ status: 'degraded' })])[0]!.status).toBe('fair');
    expect(nodePinsFromDb([dbNode({ status: 'failed' })])[0]!.status).toBe('unreachable');
    expect(nodePinsFromDb([dbNode({ status: 'stale' })])[0]!.status).toBe('unknown');
    expect(nodePinsFromDb([dbNode({ status: 'discovered', lastProxyMs: null, lastTcpMs: null })])[0]!.status).toBe('unknown');
  });

  it('latency prefers measured proxy time, falls back to TCP, then null', () => {
    expect(nodePinsFromDb([dbNode({ lastProxyMs: null, lastTcpMs: 30 })])[0]!.latencyMs).toBe(30);
    expect(nodePinsFromDb([dbNode({ lastProxyMs: null, lastTcpMs: null })])[0]!.latencyMs).toBeNull();
  });

  it('labels an unnamed node with the server-supplied label, never an address', () => {
    // The API builds this fallback (protocol + fingerprint short-hash) when a
    // node has no usable remark. The pin must pass it through verbatim rather
    // than reaching for something missing.
    const pins = nodePinsFromDb([dbNode({ remark: null, label: 'VLESS · 20ea8e83' })]);
    expect(pins[0]!.label).toBe('VLESS · 20ea8e83');
    expect(pins[0]!.label).not.toBe('');
  });

  it('a label is never rendered blank, whatever the remark', () => {
    for (const remark of [null, '', '   ']) {
      const pins = nodePinsFromDb([dbNode({ remark, label: 'VLESS · 20ea8e83' })]);
      expect(pins[0]!.label, `remark=${String(remark)}`).not.toBe('');
      expect(pins[0]!.label, `remark=${String(remark)}`).not.toBe('undefined');
    }
  });

  it('sub never degenerates to an address when place is unknown', () => {
    // The old fallback here was `${host}:${port}`. Now the line always has
    // something to say: place (or an honest admission) and the protocol.
    const pins = nodePinsFromDb([dbNode({ city: null, country: null, label: 'VLESS · 20ea8e83' })]);
    expect(pins[0]!.sub).toBe('Location unknown · VLESS');
    expect(pins[0]!.sub).not.toContain(':443');
  });
});
