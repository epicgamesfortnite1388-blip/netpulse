import { describe, expect, it } from 'vitest';

import { nodePinsFromDb } from '../src/features/map/nodePins';

import type { PublicNode } from '@netpulse/shared';

/** Minimal node factory — only fields the mapper reads. */
function dbNode(over: Partial<PublicNode>): PublicNode {
  return {
    id: 'n1',
    canonicalFingerprint: 'fp',
    protocol: 'vless',
    host: 'example.com',
    ipv4: [],
    ipv6: [],
    port: 443,
    transport: 'tcp',
    security: 'tls',
    sni: null,
    alpn: [],
    fingerprint: null,
    flow: null,
    alterId: null,
    path: null,
    hostHeader: null,
    serviceName: null,
    allowInsecure: false,
    realityPublicKey: null,
    realityShortId: null,
    realityServerName: null,
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
    lastTcpMs: 40,
    geoLastAttempt: null,
    lastTlsMs: null,
    testCount: 1,
    successCount: 1,
    failureCount: 0,
    consecutiveFailures: 0,
    recentTestCount: 0,
    recentSuccessCount: 0,
    recentFailureCount: 0,
    ...over,
  } as PublicNode;
}

describe('nodePinsFromDb (globe seeding from the node DB)', () => {
  it('maps a geo-verified healthy node to an honest pin', () => {
    const pins = nodePinsFromDb([dbNode({})]);
    expect(pins).toHaveLength(1);
    const p = pins[0]!;
    expect(p.id).toBe('node:n1');
    expect(p.label).toBe('Frankfurt relay');
    expect(p.sub).toBe('Frankfurt, DE');
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

  it('label falls back to host when no remark exists', () => {
    const pins = nodePinsFromDb([dbNode({ remark: null })]);
    expect(pins[0]!.label).toBe('example.com');
  });
});
