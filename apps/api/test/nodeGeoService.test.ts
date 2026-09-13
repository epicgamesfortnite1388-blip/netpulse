import { describe, expect, it, vi } from 'vitest';

import { enrichNodeGeoBatch, clearGeoIpCacheForTests } from '../src/services/nodeGeoService';

import type { PublicNodeRow, PublicNodesRepository } from '../src/db/repositories';
import type { Logger } from '../src/logger';

/**
 * IP-evidence geolocation rules (FEATURE_GAPS — map accuracy):
 *   - geography comes only from the resolved public IP (ipwho.is here)
 *   - private/loopback addresses are never geolocated
 *   - a failed lookup writes NOTHING (country/lat stay null) and only marks
 *     the attempt, so the UI shows Unknown instead of invented coordinates
 *   - per-node attempts are rate-limited; identical hosts share one lookup
 */

vi.mock('../src/providers/ipinfo/ipwhoIs', () => ({
  fetchIpWhoIs: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi.fn(async (host: string) => {
      if (host === 'multi.example') {
        return [{ address: '93.184.216.34', family: 4 }, { address: '93.184.216.35', family: 4 }];
      }
      if (host === 'dead.example') throw new Error('ENOTFOUND');
      return [{ address: '1.2.3.4', family: 4 }];
    }),
  },
}));

import { fetchIpWhoIs } from '../src/providers/ipinfo/ipwhoIs';

const mockFetch = vi.mocked(fetchIpWhoIs);

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

function row(overrides: Partial<PublicNodeRow> = {}): PublicNodeRow {
  const now = Date.now();
  return {
    id: 'n1',
    canonicalFingerprint: 'fp1',
    protocol: 'vmess',
    host: 'example.com',
    ipv4: [],
    ipv6: [],
    port: 443,
    transport: 'ws',
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
    remark: 'JP 🇯🇵 fast node — must NOT influence geo',
    sourceIds: ['s1'],
    sourceUrls: ['https://example.com/sub'],
    sourceCount: 1,
    firstSeen: now,
    lastSeen: now,
    lastValidated: null,
    status: 'discovered',
    confidence: 'unknown',
    country: null,
    city: null,
    asn: null,
    isp: null,
    organization: null,
    lat: null,
    lon: null,
    geoSourceCount: 0,
    geoLastAttempt: null,
    tags: [],
    favorite: false,
    userNotes: null,
    lastProxyMs: null,
    lastTcpMs: null,
    lastTlsMs: null,
    testCount: 0,
    successCount: 0,
    failureCount: 0,
    consecutiveFailures: 0,
    recentTestCount: 0,
    recentSuccessCount: 0,
    recentFailureCount: 0,
    score: 0,
    reliabilityPct: 0,
    medianProxyMs: null,
    medianTcpMs: null,
    medianTlsMs: null,
    recentLossPct: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    freshness: 'stale',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fakeRepo() {
  const geoWrites: Array<{ id: string; geo: Record<string, unknown> }> = [];
  const attempts: string[] = [];
  return {
    geoWrites,
    attempts,
    repo: {
      markGeoAttempt: (id: string, at: number) => {
        attempts.push(`${id}@${at}`);
      },
      updateGeo: (id: string, geo: Record<string, unknown>) => {
        geoWrites.push({ id, geo });
      },
    } as unknown as PublicNodesRepository,
  };
}

describe('nodeGeoService', () => {
  it('resolves geo from the public IP and never from the node name/remark', async () => {
    clearGeoIpCacheForTests();
    mockFetch.mockResolvedValue({
      ip: '1.2.3.4',
      country: 'Germany',
      countryCode: 'DE',
      region: 'Hesse',
      city: 'Frankfurt',
      latitude: 50.11,
      longitude: 8.68,
      timezone: null,
      isp: 'Hetzner',
      org: 'Hetzner Online',
      asn: 24940,
      asnOrg: 'Hetzner',
      source: 'ipwho.is',
    });
    const { repo, geoWrites, attempts } = fakeRepo();
    const out = await enrichNodeGeoBatch(repo, [row({ remark: 'JP 🇯🇵 tokyo fast' })], log);

    expect(out.attempted).toBe(1);
    expect(out.resolved).toBe(1);
    expect(attempts).toHaveLength(1);
    expect(geoWrites).toEqual([
      {
        id: 'n1',
        geo: expect.objectContaining({
          country: 'DE',
          city: 'Frankfurt',
          lat: 50.11,
          lon: 8.68,
          asn: 24940,
          confidence: 'medium',
        }),
      },
    ]);
  });

  it('writes nothing when the lookup fails — Unknown stays Unknown', async () => {
    clearGeoIpCacheForTests();
    mockFetch.mockResolvedValue(null);
    const { repo, geoWrites, attempts } = fakeRepo();
    const out = await enrichNodeGeoBatch(repo, [row()], log);

    expect(out.resolved).toBe(0);
    expect(out.failed).toBe(1);
    expect(geoWrites).toHaveLength(0); // no invented coordinates
    expect(attempts).toHaveLength(1); // attempt recorded → no tight retry loop
  });

  it('never geolocates private addresses', async () => {
    clearGeoIpCacheForTests();
    mockFetch.mockClear();
    const { repo, geoWrites } = fakeRepo();
    const out = await enrichNodeGeoBatch(repo, [row({ host: '192.168.1.1', ipv4: [] })], log);

    expect(out.skippedPrivate).toBe(1);
    expect(out.resolved).toBe(0);
    expect(geoWrites).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('treats 0.0 coordinates as no-coordinates (not Gulf of Guinea)', async () => {
    clearGeoIpCacheForTests();
    mockFetch.mockResolvedValue({
      ip: '1.2.3.4',
      country: 'Germany',
      countryCode: 'DE',
      region: null,
      city: null,
      latitude: 0,
      longitude: 0,
      timezone: null,
      isp: null,
      org: null,
      asn: 123,
      asnOrg: null,
      source: 'ipwho.is',
    });
    const { repo, geoWrites } = fakeRepo();
    await enrichNodeGeoBatch(repo, [row()], log);

    expect(geoWrites).toHaveLength(1);
    expect(geoWrites[0]!.geo.lat).toBeNull();
    expect(geoWrites[0]!.geo.lon).toBeNull();
    expect(geoWrites[0]!.geo.confidence).toBe('low'); // country evidence only
  });

  it('refuses anycast IPs a fabricated location (1.1.1.1 → Unknown, not Brisbane)', async () => {
    clearGeoIpCacheForTests();
    // Real-world reproduction: ipwho.is answers 1.1.1.1 with "Australia/Brisbane"
    // — an anycast artifact that once landed Cloudflare in the wrong continent.
    mockFetch.mockResolvedValue({
      ip: '1.1.1.1',
      country: 'Australia',
      countryCode: 'AU',
      region: 'Queensland',
      city: 'Brisbane',
      latitude: -27.4679371,
      longitude: 153.0280882,
      timezone: null,
      isp: 'Cloudflare, Inc.',
      org: 'Cloudflare, Inc.',
      asn: 13335,
      asnOrg: 'Cloudflare',
      source: 'ipwho.is',
    });
    const { repo, geoWrites } = fakeRepo();
    const out = await enrichNodeGeoBatch(repo, [row({ host: '1.1.1.1', ipv4: [] })], log);

    expect(out.anycastRefused).toBe(1);
    expect(out.resolved).toBe(0);
    const geo = geoWrites[0]!.geo;
    expect(geo.lat).toBeNull();
    expect(geo.lon).toBeNull();
    expect(geo.country).toBeNull();
    expect(geo.confidence).toBe('unknown');
    // ISP/ASN facts are still recorded (they ARE real evidence).
    expect(geo.asn).toBe(13335);
    expect(geo.isp).toBe('Cloudflare, Inc.');
  });

  it('serializes passes — a running pass is not re-entered', async () => {
    clearGeoIpCacheForTests();
    let release!: () => void;
    mockFetch.mockImplementation(
      () => new Promise((res) => { release = () => res(null); }),
    );
    const { repo } = fakeRepo();
    const first = enrichNodeGeoBatch(repo, [row()], log);
    const second = await enrichNodeGeoBatch(repo, [row({ id: 'n2' })], log);
    expect(second.attempted).toBe(0); // skipped while first is in flight
    release();
    const r1 = await first;
    expect(r1.attempted).toBe(1);
  });
});
