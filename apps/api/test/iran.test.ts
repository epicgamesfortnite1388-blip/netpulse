import { describe, expect, it } from 'vitest';

import { IRAN_CATALOG } from '../src/services/iranCatalog';
import { applyDifferential, buildSummary, classifyCell, dnsDifferential, scoreCell } from '../src/services/iranClassifier';

import type { ConnectivityMeasurement, IranDnsProbe, IranHttpProbe, IranTcpProbe, IranTlsProbe } from '@netpulse/shared';

function probe(
  over: Partial<{
    dns: IranDnsProbe | null;
    tcp: IranTcpProbe | null;
    tls: IranTlsProbe | null;
    http: IranHttpProbe | null;
    endpointOnly: boolean;
    vpnConnected: boolean;
    repeats: number;
    successRate: number;
    medianLatencyMs: number | null;
  }>,
): Parameters<typeof classifyCell>[0] {
  return {
    dns: over.dns ?? { ok: true, latencyMs: 12, resolver: null, a: ['1.2.3.4'], aaaa: [], cname: null, rcode: '0', nxdomain: false, error: null },
    tcp: over.tcp ?? { ok: true, latencyMs: 30, port: 443, family: 4, error: null },
    tls: over.tls ?? { ok: true, latencyMs: 45, tlsVersion: 'TLSv1.3', authorized: true, error: null },
    http: over.http ?? { ok: true, latencyMs: 60, status: 200, redirectChain: ['https://example.com/'], contentType: 'text/html', error: null },
    endpointOnly: over.endpointOnly ?? false,
    vpnConnected: over.vpnConnected ?? false,
    repeats: over.repeats ?? 1,
    successRate: over.successRate ?? 1,
    medianLatencyMs: over.medianLatencyMs ?? 60,
  };
}

function measurement(over: Partial<ConnectivityMeasurement>): ConnectivityMeasurement {
  return {
    sessionId: 's',
    targetId: 't1',
    connectionId: 'direct',
    connectionName: 'Direct Internet',
    samples: 1,
    startedAt: 0,
    durationMs: 100,
    dns: null,
    tcp: null,
    tls: null,
    http: null,
    route: null,
    classification: { state: 'Reachable', assessment: 'Likely Reachable', confidence: 'Medium', evidence: [] },
    score: null,
    ...over,
  };
}

describe('iran catalog', () => {
  it('has unique ids and valid hostnames', () => {
    const ids = new Set(IRAN_CATALOG.map((t) => t.id));
    expect(ids.size).toBe(IRAN_CATALOG.length);
    for (const t of IRAN_CATALOG) {
      expect(t.hostnames.length).toBeGreaterThan(0);
      expect(t.name.length).toBeGreaterThan(0);
    }
  });

  it('covers all major categories', () => {
    const cats = new Set(IRAN_CATALOG.map((t) => t.category));
    for (const c of ['Search', 'Social', 'Messaging', 'Developer', 'AI', 'Gaming', 'Finance', 'CDN'] as const) {
      expect(cats.has(c)).toBe(true);
    }
  });

  it('never asserts a service is blocked or reachable', () => {
    // catalog entries carry no reachability claim fields
    for (const t of IRAN_CATALOG) {
      expect('blocked' in t).toBe(false);
      expect('reachable' in t).toBe(false);
      expect('status' in t).toBe(false);
    }
  });
});

describe('classifyCell', () => {
  it('classifies a fully healthy path as Likely Reachable', () => {
    const c = classifyCell(probe({ repeats: 3 }));
    expect(c.state).toBe('Reachable');
    expect(c.assessment).toBe('Likely Reachable');
    expect(c.confidence).toBe('High');
    expect(c.evidence.length).toBeGreaterThan(0);
  });

  it('classifies DNS failure as DNS Failure', () => {
    const c = classifyCell(
      probe({
        dns: { ok: false, latencyMs: null, resolver: null, a: null, aaaa: null, cname: null, rcode: null, nxdomain: true, error: 'NXDOMAIN' },
        tcp: null,
        tls: null,
        http: null,
      }),
    );
    expect(c.state).toBe('DNS Failure');
    expect(c.assessment).toBe('Service Failure');
  });

  it('classifies TCP reset as Possible Filtering (never assert filtered on one sample)', () => {
    const c = classifyCell(
      probe({
        dns: probe({}).dns,
        tcp: { ok: false, latencyMs: null, port: 443, family: 4, error: 'ECONNRESET' },
        tls: null,
        http: null,
        repeats: 1,
      }),
    );
    expect(c.state).toBe('Connection Reset');
    expect(c.assessment).toBe('Possible Filtering');
    expect(c.confidence).toBe('Low');
  });

  it('classifies TLS interruption after TCP success as Possible Filtering', () => {
    const c = classifyCell(
      probe({
        tcp: { ok: true, latencyMs: 30, port: 443, family: 4, error: null },
        tls: { ok: false, latencyMs: null, tlsVersion: null, authorized: null, error: 'socket hang up' },
        http: null,
        repeats: 2,
      }),
    );
    expect(c.state).toBe('TLS Failure');
    expect(c.assessment).toBe('Possible Filtering');
    expect(c.confidence).toBe('Medium');
    expect(c.evidence.some((e) => e.includes('interference'))).toBe(true);
  });

  it('classifies HTTP 4xx as Service Failure (reachable at network level)', () => {
    const c = classifyCell(
      probe({
        http: { ok: true, latencyMs: 60, status: 403, redirectChain: ['https://example.com/'], contentType: 'text/html', error: null },
      }),
    );
    expect(c.state).toBe('HTTP Error');
    expect(c.assessment).toBe('Service Failure');
  });

  it('never classifies a timeout as filtering without differential evidence', () => {
    const c = classifyCell(
      probe({
        tcp: { ok: false, latencyMs: null, port: 443, family: 4, error: 'timeout' },
        tls: null,
        http: null,
        repeats: 1,
      }),
    );
    expect(c.state).toBe('Timeout');
    expect(c.assessment).toBe('Network Failure');
  });

  it('VPN endpoint-only probe is honest about the tunnel being down', () => {
    const c = classifyCell(probe({ endpointOnly: true, tcp: { ok: true, latencyMs: 80, port: 51820, family: 4, error: null }, tls: null, http: null }));
    expect(c.state).toBe('Reachable');
    expect(c.assessment).toBe('Insufficient Evidence');
    expect(c.evidence.some((e) => e.includes('not connected'))).toBe(true);
  });
});

describe('applyDifferential', () => {
  it('labels direct-fail + vpn-success as Likely Filtered (differential evidence)', () => {
    const direct = measurement({
      connectionId: 'direct',
      classification: { state: 'Connection Reset', assessment: 'Possible Filtering', confidence: 'Medium', evidence: ['reset'] },
    });
    const vpn = measurement({
      connectionId: 'vpn:x',
      classification: { state: 'Reachable', assessment: 'Likely Reachable', confidence: 'High', evidence: ['ok'] },
    });
    const [d2, v2] = applyDifferential([
      { connectionId: 'direct', connectionName: 'Direct', measurement: direct },
      { connectionId: 'vpn:x', connectionName: 'VPN', measurement: vpn },
    ]);
    expect(v2.classification.assessment).toBe('Likely Filtered');
    expect(d2.classification.evidence.some((e) => e.includes('DNS-level interference') || e.includes('differential'))).toBe(true);
  });

  it('does not claim filtering when both paths fail the same way', () => {
    const direct = measurement({
      connectionId: 'direct',
      classification: { state: 'Timeout', assessment: 'Network Failure', confidence: 'Low', evidence: ['timeout'] },
    });
    const vpn = measurement({
      connectionId: 'vpn:x',
      classification: { state: 'Timeout', assessment: 'Network Failure', confidence: 'Low', evidence: ['timeout'] },
    });
    const [, v2] = applyDifferential([
      { connectionId: 'direct', connectionName: 'Direct', measurement: direct },
      { connectionId: 'vpn:x', connectionName: 'VPN', measurement: vpn },
    ]);
    expect(v2.classification.assessment).toBe('Network Failure');
    expect(v2.classification.state).toBe('Timeout');
  });
});

describe('dnsDifferential', () => {
  it('reports differing resolver answers without asserting censorship', () => {
    const sys: IranDnsProbe = { ok: true, latencyMs: 10, resolver: null, a: ['1.1.1.1'], aaaa: [], cname: null, rcode: '0', nxdomain: false, error: null };
    const alt: IranDnsProbe = { ok: true, latencyMs: 20, resolver: '1.1.1.1', a: ['9.9.9.9'], aaaa: [], cname: null, rcode: '0', nxdomain: false, error: null };
    const d = dnsDifferential(sys, alt);
    expect(d.differs).toBe(true);
    expect(d.note).toMatch(/manipulation is one possible explanation/);
  });

  it('reports agreement when answers match', () => {
    const a: IranDnsProbe = { ok: true, latencyMs: 10, resolver: null, a: ['1.1.1.1'], aaaa: [], cname: null, rcode: '0', nxdomain: false, error: null };
    const b: IranDnsProbe = { ok: true, latencyMs: 20, resolver: '1.1.1.1', a: ['1.1.1.1'], aaaa: [], cname: null, rcode: '0', nxdomain: false, error: null };
    expect(dnsDifferential(a, b).differs).toBe(false);
  });
});

describe('scoreCell', () => {
  it('scores a healthy cell transparently', () => {
    const m = measurement({
      dns: probe({}).dns,
      tcp: probe({}).tcp,
      tls: probe({}).tls,
      http: probe({}).http,
      classification: { state: 'Reachable', assessment: 'Likely Reachable', confidence: 'High', evidence: [] },
    });
    const s = scoreCell(m);
    expect(s).not.toBeNull();
    expect(s!.reachability).toBe(100);
    expect(s!.total).toBeGreaterThan(80);
  });

  it('returns null when nothing was measured', () => {
    expect(scoreCell(measurement({}))).toBeNull();
  });
});

describe('buildSummary', () => {
  it('computes health from real measurements', () => {
    const ok = measurement({
      connectionId: 'direct',
      classification: { state: 'Reachable', assessment: 'Likely Reachable', confidence: 'High', evidence: [] },
      score: { reachability: 100, latency: 90, stability: 100, tls: 100, route: 100, total: 97 },
    });
    const bad = measurement({
      targetId: 't2',
      connectionId: 'direct',
      classification: { state: 'Connection Reset', assessment: 'Possible Filtering', confidence: 'Low', evidence: [] },
      score: { reachability: 0, latency: 0, stability: 100, tls: 0, route: 0, total: 15 },
    });
    const s = buildSummary([ok, bad], [{ id: 'direct', name: 'Direct Internet' }]);
    expect(s.total).toBe(2);
    expect(s.reachable).toBe(1);
    expect(s.healthScore).toBe(50);
    expect(s.possibleFiltering).toBe(1);
    expect(s.bestConnectionId).toBe('direct');
  });
});