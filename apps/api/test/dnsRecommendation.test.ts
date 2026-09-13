import { describe, expect, it } from 'vitest';

import { recommendDns } from '../src/services/dnsRecommendation';
import { DNS_PROVIDER_GROUPS, primaryResolvers } from '../src/services/dnsResolverCatalog';
import { GAME_CATALOG } from '../src/services/gameCatalog';

import type { DnsBenchmarkRow } from '@netpulse/shared';

function row(partial: Partial<DnsBenchmarkRow> & { providerId: string; name: string }): DnsBenchmarkRow {
  return {
    transport: 'udp',
    queries: 4,
    ok: 0,
    timeouts: 0,
    errors: 0,
    latencyMinMs: null,
    latencyAvgMs: null,
    latencyMedianMs: null,
    latencyMaxMs: null,
    latencyP95Ms: null,
    jitterMs: null,
    reliabilityPct: null,
    status: 'unreachable',
    score: null,
    dnssec: null,
    ...partial,
  } as DnsBenchmarkRow;
}

describe('DNS resolver catalog integrity', () => {
  it('has globally unique resolver ids', () => {
    const ids = DNS_PROVIDER_GROUPS.flatMap((g) => g.resolvers.map((r) => r.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('marks benchmarkable resolvers with at least one usable transport', () => {
    for (const group of DNS_PROVIDER_GROUPS) {
      for (const r of group.resolvers) {
        if (r.skipBenchmarkReason) continue;
        const usable = Boolean(r.ipv4) || Boolean(r.dohUrl) || Boolean(r.dotHost);
        expect(usable, `${r.id} should have ipv4, dohUrl or dotHost`).toBe(true);
        expect(r.category, `${r.id} missing category`).toBeTruthy();
        expect(typeof r.verified, `${r.id} missing verified flag`).toBe('boolean');
      }
    }
  });

  it('never bundles private/loopback/doc-range plaintext addresses', () => {
    const suspicious = /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|192\.0\.|192\.0\.2\.|198\.18\.|198\.51\.100\.|203\.0\.113\.|100\.(6[4-9]|[7-9]\d|1[0-2]\d)\.|224\.|2a0[0-9]:|fe80:|fc|fd|::1$)/i;
    for (const group of DNS_PROVIDER_GROUPS) {
      for (const r of group.resolvers) {
        for (const ip of [r.ipv4, r.ipv6]) {
          if (ip == null) continue;
          expect(ip.match(suspicious), `${r.id} address ${ip} looks non-public`).toBeNull();
        }
      }
    }
  });

  it('keeps regional groups (Iranian DNS) opt-in and documented', () => {
    const iran = DNS_PROVIDER_GROUPS.find((g) => g.id === 'iran');
    expect(iran).toBeDefined();
    expect(iran!.regional).toBe(true);
    expect(iran!.resolvers.length).toBeGreaterThanOrEqual(2);
    const iranIds = new Set(iran!.resolvers.map((r) => r.id));
    for (const r of iran!.resolvers) {
      expect(r.source, `${r.id} missing operator source`).toMatch(/^https?:\/\//);
      expect(r.verified, `${r.id} should be verified against its operator page`).toBe(true);
    }
    // regional resolvers must NOT leak into the default benchmark set
    for (const r of primaryResolvers()) {
      expect(iranIds.has(r.id), `regional resolver ${r.id} leaked into the default benchmark set`).toBe(false);
    }
  });

  it('every bundled game has documented-source endpoints with purpose', () => {
    expect(GAME_CATALOG.length).toBeGreaterThan(10);
    for (const game of GAME_CATALOG) {
      expect(game.endpoints.length, `${game.id} has no endpoints`).toBeGreaterThan(0);
      for (const ep of game.endpoints) {
        expect(ep.hostname, `${game.id} endpoint hostname`).toMatch(/^[a-z0-9.-]+$/i);
        expect(['latency', 'reachability', 'service', 'login', 'matchmaking', 'custom']).toContain(ep.purpose);
        expect(typeof ep.verified).toBe('boolean');
      }
      for (const region of game.regions) {
        expect(region.id).toBeTruthy();
        expect(region.name).toBeTruthy();
      }
    }
  });
});

describe('DNS recommendation engine', () => {
  it('ranks lower-latency resolvers first with explainable reasons', () => {
    const rows = [
      row({ providerId: 'fast', name: 'Fast', ok: 4, latencyAvgMs: 12, latencyMedianMs: 11, latencyP95Ms: 16, jitterMs: 2, reliabilityPct: 100, status: 'excellent', score: 92, dnssec: true }),
      row({ providerId: 'slow', name: 'Slow', ok: 4, latencyAvgMs: 95, latencyMedianMs: 90, latencyP95Ms: 140, jitterMs: 9, reliabilityPct: 100, status: 'good', score: 60, dnssec: true }),
    ];
    const result = recommendDns({
      rows,
      profile: 'fastest',
      meta: new Map([
        ['fast', { providerId: 'fast', name: 'Fast', category: 'standard', dnssec: true, verified: false }],
        ['slow', { providerId: 'slow', name: 'Slow', category: 'standard', dnssec: true, verified: false }],
      ]),
    });
    expect(result.entries[0]!.providerId).toBe('fast');
    expect(result.entries[0]!.score).toBeGreaterThan(result.entries[1]!.score as number);
    expect(result.entries[0]!.reasons.some((r) => r.includes('median latency 11 ms'))).toBe(true);
  });

  it('flags low sample counts with low confidence and explains', () => {
    const rows = [
      row({ providerId: 'few', name: 'Few', queries: 2, ok: 1, timeouts: 1, latencyAvgMs: 40, latencyMedianMs: 40, reliabilityPct: 50, status: 'fair', score: 40, dnssec: null }),
      row({ providerId: 'many', name: 'Many', queries: 10, ok: 10, latencyAvgMs: 45, latencyMedianMs: 44, reliabilityPct: 100, status: 'good', score: 50, dnssec: true }),
    ];
    const result = recommendDns({
      rows,
      profile: 'reliable',
      meta: new Map([
        ['few', { providerId: 'few', name: 'Few', category: 'custom', dnssec: false, verified: false }],
        ['many', { providerId: 'many', name: 'Many', category: 'custom', dnssec: true, verified: false }],
      ]),
    });
    const few = result.entries.find((e) => e.providerId === 'few')!;
    const many = result.entries.find((e) => e.providerId === 'many')!;
    expect(few.confidence).toBe('low');
    expect(many.confidence).toBe('high');
    // reliability beats raw latency for the 'reliable' profile: 100% vs 50% uptime
    expect(many.rank).toBe(1);
    expect(many.reasons.some((r) => r.includes('no timeouts'))).toBe(true);
  });

  it('keeps unreachable resolvers at the bottom with null rank', () => {
    const rows = [
      row({ providerId: 'dead', name: 'Dead', ok: 0, timeouts: 4, status: 'unreachable', error: 'timeout' }),
      row({ providerId: 'alive', name: 'Alive', ok: 4, latencyAvgMs: 20, latencyMedianMs: 19, reliabilityPct: 100, status: 'excellent', score: 95 }),
    ];
    const result = recommendDns({ rows, profile: 'balanced', meta: new Map() });
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.providerId).toBe('alive');
    expect(result.entries[1]!.providerId).toBe('dead');
    expect(result.entries[1]!.rank).toBeNull();
    expect(result.entries[1]!.reasons.some((r) => r.includes('timeout'))).toBe(true);
  });

  it('family profile prefers family-filtering resolvers when latency is close', () => {
    const rows = [
      row({ providerId: 'plain', name: 'Plain', ok: 5, latencyAvgMs: 18, latencyMedianMs: 18, reliabilityPct: 100, status: 'excellent', score: 95 }),
      row({ providerId: 'family', name: 'Family filter', ok: 5, latencyAvgMs: 22, latencyMedianMs: 22, reliabilityPct: 100, status: 'excellent', score: 92 }),
    ];
    const result = recommendDns({
      rows,
      profile: 'family',
      meta: new Map([
        ['plain', { providerId: 'plain', name: 'Plain', category: 'standard', dnssec: true, verified: true }],
        ['family', { providerId: 'family', name: 'Family filter', category: 'family', dnssec: true, verified: true }],
      ]),
    });
    expect(result.entries[0]!.providerId).toBe('family');
  });

  it('withholds a switch recommendation when the improvement is within jitter', () => {
    const rows = [
      row({ providerId: 'fast', name: 'Fast', ok: 4, latencyAvgMs: 55, latencyMedianMs: 54, jitterMs: 3, reliabilityPct: 100, status: 'excellent', score: 88 }),
      row({ providerId: 'current', name: 'Current', ok: 4, latencyAvgMs: 60, latencyMedianMs: 59, jitterMs: 8, reliabilityPct: 100, status: 'excellent', score: 82 }),
    ];
    const result = recommendDns({
      rows,
      profile: 'fastest',
      meta: new Map(),
      currentProviderId: 'current',
    });
    const top = result.entries.find((e) => e.providerId === 'fast')!;
    const current = result.entries.find((e) => e.providerId === 'current')!;
    // 5 ms improvement <= 8 ms jitter → no 'recommended' badge, keep-current instead
    expect(top.badge).toBeUndefined();
    expect(current.badge).toBe('keep-current');
    expect(current.reasons.some((r) => r.includes('within the measured jitter'))).toBe(true);
    expect(result.note).toContain('does not exceed jitter');
  });

  it('recommends the switch when the improvement exceeds jitter', () => {
    const rows = [
      row({ providerId: 'fast', name: 'Fast', ok: 4, latencyAvgMs: 30, latencyMedianMs: 29, jitterMs: 4, reliabilityPct: 100, status: 'excellent', score: 95 }),
      row({ providerId: 'current', name: 'Current', ok: 4, latencyAvgMs: 90, latencyMedianMs: 88, jitterMs: 5, reliabilityPct: 100, status: 'excellent', score: 55 }),
    ];
    const result = recommendDns({
      rows,
      profile: 'fastest',
      meta: new Map(),
      currentProviderId: 'current',
    });
    const top = result.entries.find((e) => e.providerId === 'fast')!;
    expect(top.badge).toBe('recommended');
    expect(top.reasons.some((r) => r.includes('beyond the measured jitter'))).toBe(true);
    expect(result.note).not.toContain('does not exceed jitter');
  });

  it('labels recommendations computed through a VPN tunnel', () => {
    const rows = [
      row({ providerId: 'fast', name: 'Fast', ok: 4, latencyAvgMs: 20, latencyMedianMs: 19, jitterMs: 2, reliabilityPct: 100, status: 'excellent', score: 96, vpnActive: true }),
    ];
    const result = recommendDns({
      rows,
      profile: 'fastest',
      meta: new Map(),
      vpnActive: true,
      vpnServerName: 'wg-ams-01',
    });
    expect(result.vpnActive).toBe(true);
    expect(result.vpnServerName).toBe('wg-ams-01');
    expect(result.note).toContain('through the active VPN tunnel');
    expect(result.entries[0]!.row.vpnActive).toBe(true);
  });
});
