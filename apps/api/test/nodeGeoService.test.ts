import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { enrichNodeGeoBatch, clearGeoIpCacheForTests, scrubAnycastGeo, geoStatusReasonFor, recheckNodeGeo, setGeoPreferenceSource } from '../src/services/nodeGeoService';

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
  fetchGeoJs: vi.fn(),
  geoProviderOrder: vi.fn((p: 'auto' | 'ipwho.is' | 'geojs.io') => (p === 'geojs.io' ? ['geojs.io', 'ipwho.is'] : ['ipwho.is', 'geojs.io'])),
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

import { fetchIpWhoIs, fetchGeoJs, geoProviderOrder } from '../src/providers/ipinfo/ipwhoIs';

const mockFetch = vi.mocked(fetchIpWhoIs);
const mockGeoJs = vi.mocked(fetchGeoJs);
const mockOrder = vi.mocked(geoProviderOrder);

/** Minimal provider verdict with the requested source/geo. */
function verdict(source: 'ipwho.is' | 'geojs.io', country: string, lat: number, lon: number) {
  return {
    ip: '95.90.100.9',
    country,
    countryCode: country,
    region: null,
    city: null,
    latitude: lat,
    longitude: lon,
    timezone: null,
    isp: 'Test ISP',
    org: null,
    asn: 24940,
    asnOrg: null,
    source,
  };
}

afterEach(() => {
  setGeoPreferenceSource(null);
});

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
      // The scrub pages by primary key over rows that carry geo data — the
      // narrowing the repository does in SQL (see PublicNodesRepository
      // .listGeoScrubPage), reproduced here so the contract stays exercised.
      listGeoScrubPage: () => [],
    } as unknown as PublicNodesRepository,
  };
}

describe('geoStatusReasonFor', () => {
  it('says known when coordinates exist', () => {
    expect(geoStatusReasonFor({ host: '188.42.89.157', lat: 52.37, asn: 60781, geoLastAttempt: Date.now() })).toBe('known');
  });
  it('says anycast for well-known anycast hosts (1.1.1.1 shows Unknown with a reason)', () => {
    expect(geoStatusReasonFor({ host: '1.1.1.1', lat: null, asn: 13335, geoLastAttempt: Date.now() })).toBe('anycast');
  });
  it('says edge_fabric for Cloudflare/GCP/AWS ASNs without coords', () => {
    expect(geoStatusReasonFor({ host: '104.17.147.22', lat: null, asn: 13335, geoLastAttempt: Date.now() })).toBe('edge_fabric');
    expect(geoStatusReasonFor({ host: '34.11.22.33', lat: null, asn: 15169, geoLastAttempt: Date.now() })).toBe('edge_fabric');
  });
  it('says lookup_failed after a failed attempt and pending before one', () => {
    expect(geoStatusReasonFor({ host: 'dead.example', lat: null, asn: null, geoLastAttempt: Date.now() })).toBe('lookup_failed');
    expect(geoStatusReasonFor({ host: 'new.example', lat: null, asn: null, geoLastAttempt: null })).toBe('pending');
  });
});

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

  it('boot scrub clears fabricated coords from edge-fabric ASN rows (pre-guard builds)', async () => {
    // Rows enriched before the anycast guard shipped carry registry-HQ pins
    // (e.g. every Cloudflare IP geolocating to "San Francisco"). The scrub
    // must clear them too, not only exact anycast host IPs.
    const { repo, geoWrites } = fakeRepo();
    const rows = [
      row({ id: 'cf1', host: '104.17.147.22', asn: 13335, isp: 'Cloudflare, Inc.', country: 'US', city: 'San Francisco', lat: 37.77, lon: -122.42 }),
      row({ id: 'gcp1', host: '34.11.22.33', asn: 15169, country: 'US', city: 'Mountain View', lat: 37.44, lon: -122.08 }),
      row({ id: 'clean1', host: '188.42.89.157', asn: 60781, country: 'NL', city: 'Amsterdam', lat: 52.37, lon: 4.89 }),
      row({ id: 'anycast1', host: '1.1.1.1', asn: 13335, country: 'AU', city: 'Brisbane', lat: -27.4, lon: 153.06 }),
    ];
    repo.listGeoScrubPage = ((afterId: string | null, limit: number) =>
      rows
        .filter((r) => (afterId === null || r.id > afterId) && (r.country != null || r.lat != null || r.lon != null))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, limit)) as PublicNodesRepository['listGeoScrubPage'];
    const scrubbed = scrubAnycastGeo(repo);
    const scrubbedIds = geoWrites.map((w) => w.id);
    expect(scrubbed).toBe(3);
    expect(scrubbedIds).toContain('cf1');
    expect(scrubbedIds).toContain('gcp1');
    expect(scrubbedIds).toContain('anycast1');
    expect(scrubbedIds).not.toContain('clean1'); // legit unicast stays
    for (const w of geoWrites) {
      expect(w.geo.lat).toBeNull();
      expect(w.geo.country).toBeNull();
    }
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

/* ------------------------------ geo recheck ------------------------------- */
// POST /nodes/:id/geo-recheck → recheckNodeGeo: bypasses cache + spacing for
// ONE node, honors user vouches, keeps guard refusals honest.

import { recheckNodeGeo } from '../src/services/nodeGeoService';
import { resetGeoGuardForTests, setGeoOverridesForTest } from '../src/services/geoGuard';
import { afterEach } from 'vitest';

afterEach(() => resetGeoGuardForTests());

describe('recheckNodeGeo', () => {
  it('resolves coordinates for a plain unicast IP (fresh lookup)', async () => {
    mockFetch.mockResolvedValue({
      countryCode: 'DE', country: 'Germany', city: 'Frankfurt', region: 'HE',
      latitude: 50.11, longitude: 8.68, asn: 24940, isp: 'Hetzner', org: 'Hetzner Online',
    });
    const { repo, geoWrites, attempts } = fakeRepo();
    const r = await recheckNodeGeo(repo, row({ ipv4: ['95.90.100.5'] }), log);
    expect(r).toEqual({ outcome: 'resolved', reason: 'known' });
    expect(geoWrites).toHaveLength(1);
    // ISO code is written (never the provider's full name) so code-keyed
    // guards — bounding boxes, facets, the plausibility gate — see it.
    expect(geoWrites[0]!.geo).toMatchObject({ country: 'DE', city: 'Frankfurt', lat: 50.11, confidence: 'medium' });
    expect(attempts).toHaveLength(1);
  });

  it('refuses an anycast IP honestly: no coordinates, refusal outcome', async () => {
    mockFetch.mockResolvedValue({
      countryCode: 'US', country: 'United States', city: 'Brisbane', region: 'CA',
      latitude: -27.64, longitude: 153.03, asn: 13335, isp: 'Cloudflare', org: 'Cloudflare',
    });
    const { repo, geoWrites } = fakeRepo();
    const r = await recheckNodeGeo(repo, row({ host: '1.1.1.1', ipv4: ['1.1.1.1'] }), log);
    expect(r).toEqual({ outcome: 'refused', reason: 'anycast' });
    expect(geoWrites[0]!.geo).toMatchObject({ country: null, lat: null, confidence: 'refused', asn: 13335 });
  });

  it('a user vouch override wins: forced coordinates at high confidence', async () => {
    setGeoOverridesForTest(new Map([
      ['1.1.1.1', { class: 'unicast', force: { lat: -33.87, lon: 151.21, country: 'Australia', city: 'Sydney' }, note: 'attested' }],
    ]));
    mockFetch.mockResolvedValue({
      countryCode: 'US', country: 'United States', city: 'Brisbane', region: 'CA',
      latitude: -27.64, longitude: 153.03, asn: 13335, isp: 'Cloudflare', org: 'Cloudflare',
    });
    const { repo, geoWrites } = fakeRepo();
    const r = await recheckNodeGeo(repo, row({ host: '1.1.1.1', ipv4: ['1.1.1.1'] }), log);
    expect(r).toEqual({ outcome: 'vouched', reason: 'known' });
    expect(geoWrites[0]!.geo).toMatchObject({ country: 'Australia', city: 'Sydney', lat: -33.87, confidence: 'high' });
  });

  it('a failed lookup reports lookup_failed and writes no geography', async () => {
    mockFetch.mockResolvedValue(null);
    const { repo, geoWrites } = fakeRepo();
    const r = await recheckNodeGeo(repo, row({ ipv4: ['95.90.100.9'] }), log);
    expect(r).toEqual({ outcome: 'failed', reason: 'lookup_failed' });
    expect(geoWrites).toHaveLength(0);
  });

  it('private-only nodes are reported, never geolocated', async () => {
    const { repo, geoWrites } = fakeRepo();
    const r = await recheckNodeGeo(repo, row({ ipv4: ['192.168.1.10'] }), log);
    expect(r).toEqual({ outcome: 'failed', reason: 'private_only' });
    expect(geoWrites).toHaveLength(0);
  });
});

describe('geo provider failover order', () => {
  beforeEach(() => {
    clearGeoIpCacheForTests();
    mockFetch.mockReset();
    mockGeoJs.mockReset();
  });

  it('auto: ipwho.is answers first, geojs.io untouched', async () => {
    setGeoPreferenceSource(() => 'auto');
    mockFetch.mockResolvedValue(verdict('ipwho.is', 'DE', 50.11, 8.68));
    const { repo, geoWrites } = fakeRepo();
    const out = await enrichNodeGeoBatch(repo, [row({ ipv4: ['95.90.100.9'] })], log);
    expect(out.resolved).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockGeoJs).not.toHaveBeenCalled();
    expect(geoWrites[0]?.geo).toMatchObject({ country: 'DE' });
  });

  it('auto: geojs.io covers when ipwho.is fails (failover, not Unknown)', async () => {
    setGeoPreferenceSource(() => 'auto');
    mockFetch.mockResolvedValue(null);
    mockGeoJs.mockResolvedValue(verdict('geojs.io', 'NL', 52.37, 4.9));
    const { repo, geoWrites } = fakeRepo();
    const out = await enrichNodeGeoBatch(repo, [row({ ipv4: ['95.90.100.9'] })], log);
    expect(out.resolved).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockGeoJs).toHaveBeenCalledTimes(1);
    expect(geoWrites[0]?.geo).toMatchObject({ country: 'NL' });
  });

  it('geojs.io preferred: geojs.io is queried first', async () => {
    setGeoPreferenceSource(() => 'geojs.io');
    mockGeoJs.mockResolvedValue(verdict('geojs.io', 'FR', 48.85, 2.35));
    const { repo, geoWrites } = fakeRepo();
    const out = await enrichNodeGeoBatch(repo, [row({ ipv4: ['95.90.100.9'] })], log);
    expect(out.resolved).toBe(1);
    expect(mockGeoJs).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(geoWrites[0]?.geo).toMatchObject({ country: 'FR' });
  });

  it('geojs.io preferred: ipwho.is still answers when geojs.io fails (never removes a provider)', async () => {
    setGeoPreferenceSource(() => 'geojs.io');
    mockGeoJs.mockResolvedValue(null);
    mockFetch.mockResolvedValue(verdict('ipwho.is', 'PL', 52.23, 21.01));
    const { repo, geoWrites } = fakeRepo();
    const out = await enrichNodeGeoBatch(repo, [row({ ipv4: ['95.90.100.9'] })], log);
    expect(out.resolved).toBe(1);
    expect(mockGeoJs).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(geoWrites[0]?.geo).toMatchObject({ country: 'PL' });
  });

  it('a missing preference source behaves as auto', async () => {
    setGeoPreferenceSource(null);
    mockFetch.mockResolvedValue(verdict('ipwho.is', 'DE', 50.11, 8.68));
    const { repo } = fakeRepo();
    const out = await enrichNodeGeoBatch(repo, [row({ ipv4: ['95.90.100.9'] })], log);
    expect(out.resolved).toBe(1);
    expect(mockGeoJs).not.toHaveBeenCalled();
  });

  it('both providers failing stays honest (no write, lookup_failed on re-check)', async () => {
    setGeoPreferenceSource(() => 'geojs.io');
    mockGeoJs.mockResolvedValue(null);
    mockFetch.mockResolvedValue(null);
    const { repo, geoWrites } = fakeRepo();
    const r = await recheckNodeGeo(repo, row({ ipv4: ['95.90.100.9'] }), log);
    expect(r).toEqual({ outcome: 'failed', reason: 'lookup_failed' });
    expect(geoWrites).toHaveLength(0);
    expect(mockGeoJs).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
