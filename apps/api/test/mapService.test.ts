import { describe, expect, it } from 'vitest';

import { asnPath, coloInfo, diffObservations, summarizeLatencies } from '@netpulse/shared';

import type { MapObservation, NetworkTarget } from '@netpulse/shared';

function obs(partial: Partial<MapObservation>): MapObservation {
  const target: NetworkTarget = { id: 't:1', type: 'cloudflare', name: 'Cloudflare FRA', host: 'x.cloudflare.com', port: 443, protocol: 'https' };
  return {
    id: 'obs',
    target,
    family: 4,
    resolvedIp: '1.2.3.4',
    protocol: 'tcp',
    port: 443,
    vpnActive: false,
    vpnLabel: null,
    createdAt: 1000,
    durationMs: 300,
    hops: [],
    measurements: [{ method: 'tcp', protocol: 'tcp', port: 443, latencyMs: 40, samples: 3, minMs: 38, avgMs: 41, p95Ms: 45, maxMs: 46, jitterMs: 3, lossPct: 0, ok: true }],
    status: 'good',
    statusLabel: 'Good',
    note: null,
    insights: [],
    ...partial,
  };
}

describe('summarizeLatencies', () => {
  it('computes min/median/avg/p95/max/jitter from real samples', () => {
    const s = summarizeLatencies([30, 40, 50, 60, 70]);
    expect(s.minMs).toBe(30);
    expect(s.medianMs).toBe(50);
    expect(s.avgMs).toBe(50);
    expect(s.maxMs).toBe(70);
    expect(s.p95Ms).toBe(70);
    expect(s.jitterMs).toBeCloseTo(14.14, 1);
    expect(s.samples).toBe(5);
  });

  it('drops failed (zero) samples but reports the attempted count', () => {
    const s = summarizeLatencies([40, 0, 0]);
    expect(s.samples).toBe(1);
    expect(s.medianMs).toBe(40);
    expect(s.jitterMs).toBe(0);
  });

  it('returns nulls when nothing succeeded (attempted count is preserved)', () => {
    const s = summarizeLatencies([0, 0]);
    expect(s.samples).toBe(2); // attempted samples, all failed
    expect(s.medianMs).toBeNull();
    expect(s.minMs).toBeNull();
  });
});

describe('asnPath', () => {
  it('deduplicates consecutive ASNs into the path', () => {
    const o = obs({
      hops: [
        { hop: 1, ip: '192.168.1.1', hostname: null, latencyMs: 1, packetLoss: 0, asn: null, org: null, country: null, status: 'ok', geo: null },
        { hop: 2, ip: '10.0.0.1', hostname: null, latencyMs: 2, packetLoss: 0, asn: 48147, org: 'ISP', country: 'IR', status: 'ok', geo: null },
        { hop: 3, ip: '1.1.1.1', hostname: null, latencyMs: 4, packetLoss: 0, asn: 48147, org: 'ISP', country: 'IR', status: 'ok', geo: null },
        { hop: 4, ip: '2.2.2.2', hostname: null, latencyMs: 5, packetLoss: 0, asn: 13335, org: 'Cloudflare', country: 'DE', status: 'ok', geo: null },
      ],
    });
    expect(asnPath(o)).toEqual([null, 48147, 13335]);
  });
});

describe('diffObservations', () => {
  it('reports no change between identical observations', () => {
    const a = obs({ createdAt: 1000 });
    const b = obs({ createdAt: 2000, hops: a.hops, measurements: a.measurements, resolvedIp: a.resolvedIp });
    const d = diffObservations(b, a);
    expect(d.changed).toBe(false);
    expect(d.latencyDeltaMs).toBe(0);
  });

  it('detects an ASN path change and quantifies the latency delta', () => {
    const prev = obs({
      createdAt: 1000,
      hops: [
        { hop: 1, ip: '10.0.0.1', hostname: null, latencyMs: 2, packetLoss: 0, asn: 48147, org: 'ISP', country: 'IR', status: 'ok', geo: null },
        { hop: 2, ip: '2.2.2.2', hostname: null, latencyMs: 45, packetLoss: 0, asn: 13335, org: 'Cloudflare', country: 'DE', status: 'ok', geo: null },
      ],
      measurements: [{ method: 'tcp', protocol: 'tcp', port: 443, latencyMs: 45, samples: 3, minMs: 44, avgMs: 46, p95Ms: 48, maxMs: 49, jitterMs: 2, lossPct: 0, ok: true }],
    });
    const cur = obs({
      createdAt: 2000,
      hops: [
        { hop: 1, ip: '10.0.0.1', hostname: null, latencyMs: 2, packetLoss: 0, asn: 48147, org: 'ISP', country: 'IR', status: 'ok', geo: null },
        { hop: 2, ip: '3.3.3.3', hostname: null, latencyMs: 60, packetLoss: 0, asn: 9009, org: 'Transit', country: 'TR', status: 'ok', geo: null },
        { hop: 3, ip: '2.2.2.2', hostname: null, latencyMs: 62, packetLoss: 0, asn: 13335, org: 'Cloudflare', country: 'DE', status: 'ok', geo: null },
      ],
      measurements: [{ method: 'tcp', protocol: 'tcp', port: 443, latencyMs: 62, samples: 3, minMs: 60, avgMs: 63, p95Ms: 66, maxMs: 67, jitterMs: 3, lossPct: 0, ok: true }],
    });
    const d = diffObservations(cur, prev);
    expect(d.changed).toBe(true);
    expect(d.changes.some((c) => c.includes('ASN path changed'))).toBe(true);
    expect(d.latencyDeltaMs).toBe(17);
    expect(d.insight).toContain('increased by 17 ms');
  });

  it('detects VPN state changes and destination address changes', () => {
    const prev = obs({ createdAt: 1000, vpnActive: false, resolvedIp: '1.2.3.4' });
    const cur = obs({ createdAt: 2000, vpnActive: true, vpnLabel: 'Warsaw', resolvedIp: '5.6.7.8' });
    const d = diffObservations(cur, prev);
    expect(d.changed).toBe(true);
    expect(d.changes.some((c) => c.includes('VPN tunnel'))).toBe(true);
    expect(d.changes.some((c) => c.includes('Destination address changed'))).toBe(true);
  });

  it('flags latency change without route change as congestion, not a new path', () => {
    const prev = obs({ createdAt: 1000, resolvedIp: '1.2.3.4' });
    const cur = obs({ createdAt: 2000, resolvedIp: '1.2.3.4', measurements: [{ method: 'tcp', protocol: 'tcp', port: 443, latencyMs: 90, samples: 3, minMs: 88, avgMs: 91, p95Ms: 95, maxMs: 96, jitterMs: 3, lossPct: 0, ok: true }] });
    const d = diffObservations(cur, prev);
    expect(d.changes.some((c) => c.includes('no route change observed'))).toBe(true);
    expect(d.insight).toContain('congestion');
  });
});

describe('colo geography (known-endpoint confidence)', () => {
  it('exposes city-level coordinates for mapped edges', () => {
    const fra = coloInfo('FRA');
    expect(fra?.lat).toBeTypeOf('number');
    expect(fra?.lon).toBeTypeOf('number');
    expect(fra?.city).toBe('Frankfurt');
    const ist = coloInfo('IST');
    expect(ist?.countryCode).toBe('TR');
  });

  it('never fabricates coords for unmapped codes', () => {
    expect(coloInfo('ZZZ')).toBeNull();
  });
});