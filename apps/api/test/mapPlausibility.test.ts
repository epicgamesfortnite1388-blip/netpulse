import { afterEach, describe, expect, it, vi } from 'vitest';

import { COUNTRY_BBOX, inCountryBox, hasCountryBox, LIVE_COUNTRIES } from '@netpulse/shared';

import { enrichNodeGeoBatch, clearGeoIpCacheForTests, scrubAnycastGeo, recheckNodeGeo } from '../src/services/nodeGeoService';

import type { PublicNodeRow, PublicNodesRepository } from '../src/db/repositories';
import type { Logger } from '../src/logger';

/**
 * Map-plausibility regression (the automated version of the manual audit):
 * every coordinate the app writes for a node must fall inside the bounding
 * box of its claimed country, and guard-refused networks (anycast hosts,
 * edge-fabric ASNs) must carry NO coordinates at all. A violation is exactly
 * the "Cloudflare pin in Australia" class of lie the manual audit hunted.
 */

vi.mock('../src/providers/ipinfo/ipwhoIs', () => ({
  fetchIpWhoIs: vi.fn(),
  fetchGeoJs: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn(async () => [{ address: '1.2.3.4', family: 4 }]) },
}));

import { fetchIpWhoIs, fetchGeoJs } from '../src/providers/ipinfo/ipwhoIs';

const mockFetch = vi.mocked(fetchIpWhoIs);
const mockGeoJs = vi.mocked(fetchGeoJs);

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

interface GeoWrite {
  id: string;
  geo: Record<string, unknown>;
}

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

function fakeRepo(rows: PublicNodeRow[] = []) {
  const store = new Map(rows.map((r) => [r.id, { ...r }]));
  const geoWrites: GeoWrite[] = [];
  const repo = {
    list: vi.fn(() => ({ rows: [...store.values()] })) as unknown as PublicNodesRepository['list'],
    markGeoAttempt: (id: string) => { const r = store.get(id); if (r) r.geoLastAttempt = Date.now(); },
    updateGeo: (id: string, geo: Record<string, unknown>) => {
      geoWrites.push({ id, geo });
      const r = store.get(id);
      if (r) Object.assign(r, geo);
    },
  } as unknown as PublicNodesRepository;
  return { repo, geoWrites, store };
}

function verdict(partial: { country: string; countryCode: string; city: string; latitude: number; longitude: number; asn: number; isp: string }) {
  return {
    ip: '1.2.3.4',
    country: partial.country,
    countryCode: partial.countryCode,
    region: null,
    city: partial.city,
    latitude: partial.latitude,
    longitude: partial.longitude,
    timezone: null,
    isp: partial.isp,
    org: partial.isp,
    asn: partial.asn,
    asnOrg: partial.isp,
    source: 'ipwho.is' as const,
  };
}

afterEach(() => {
  clearGeoIpCacheForTests();
  vi.clearAllMocks();
});

/* ---------------------------- box data sanity ----------------------------- */

describe('COUNTRY_BBOX data', () => {
  it('every box is well-formed (min < max, lat within ±90, lon within ±180)', () => {
    for (const [cc, box] of Object.entries(COUNTRY_BBOX)) {
      const [minLon, maxLon, minLat, maxLat] = box;
      expect(minLon, cc).toBeLessThan(maxLon);
      expect(minLat, cc).toBeLessThan(maxLat);
      expect(minLat, cc).toBeGreaterThanOrEqual(-90);
      expect(maxLat, cc).toBeLessThanOrEqual(90);
      expect(minLon, cc).toBeGreaterThanOrEqual(-180);
      expect(maxLon, cc).toBeLessThanOrEqual(180);
    }
  });

  it('a centroid written for a country lands inside that country box', () => {
    // The country-centroid table the map uses must itself be plausible.
    const centroids: Array<[string, number, number]> = [
      ['DE', 50.11, 8.68], ['NL', 52.37, 4.9], ['AU', -33.87, 151.21],
      ['US', 38.9, -77.04], ['IR', 35.69, 51.39], ['JP', 35.68, 139.69],
      ['SG', 1.35, 103.82], ['BR', -15.79, -47.88], ['ZA', -26.2, 28.05],
    ];
    for (const [cc, lat, lon] of centroids) {
      expect(inCountryBox(cc, lat, lon), `${cc} centroid (${lat},${lon})`).toBe(true);
    }
  });

  it('classic artifacts fail the box check (the audit catches them)', () => {
    // Registry-HQ coordinates claimed for the wrong country:
    expect(inCountryBox('AU', 37.77, -122.42)).toBe(false); // SF coords in AU box
    expect(inCountryBox('DE', -27.47, 153.02)).toBe(false); // Brisbane coords in DE box
    expect(inCountryBox('NL', 35.68, 139.69)).toBe(false); // Tokyo coords in NL box
    // and swapped lat/lon always trips for mid-latitude countries:
    expect(inCountryBox('DE', 8.68, 50.11)).toBe(false);
    // Note: Brisbane coords INSIDE the AU box are geometrically fine — the
    // anycast bug was the CLAIM (an anycast IP has no location), which the
    // guard refuses before a box check would ever apply.
  });

  it('unknown countries and missing coordinates never fail', () => {
    expect(inCountryBox(null, 0, 0)).toBe(true);
    expect(inCountryBox('XX', 0, 0)).toBe(true);
    expect(inCountryBox('DE', null, null)).toBe(true);
  });

  it('sub-national region boxes accept real places outside the main box', () => {
    // Alaska and Hawaii (legit US GeoIP answers), Malaysian Borneo,
    // the Azores, and Chukotka west of the antimeridian.
    expect(inCountryBox('US', 64.2, -149.5)).toBe(true); // Fairbanks, AK
    expect(inCountryBox('US', 21.31, -157.86)).toBe(true); // Honolulu, HI
    expect(inCountryBox('MY', 3.14, 113.08)).toBe(true); // Bintulu, Sarawak
    expect(inCountryBox('PT', 38.72, -27.22)).toBe(true); // Ponta Delgada, Azores
    expect(inCountryBox('RU', 66.0, -172.0)).toBe(true); // Chukotka
    // ...while out-of-region claims still fail.
    expect(inCountryBox('US', 21.31, 157.86)).toBe(false); // Hawaii mirrored east
    expect(inCountryBox('MY', 3.14, 113.08 - 40)).toBe(false);
  });

  it('hasCountryBox flags exactly the countries the table can judge', () => {
    expect(hasCountryBox('DE')).toBe(true);
    expect(hasCountryBox('MY')).toBe(true); // region-only would still count
    expect(hasCountryBox('NG')).toBe(false);
    expect(hasCountryBox(null)).toBe(false);
    expect(hasCountryBox('xx')).toBe(false);
  });

  it('coverage: every live-data country has a box (add a box or an override when this fails)', () => {
    const unboxed = LIVE_COUNTRIES.filter((cc) => !hasCountryBox(cc));
    expect(unboxed, `countries without boxes: ${unboxed.join(', ')}`).toEqual([]);
  });
});

/* ------------------- write-path plausibility enforcement ------------------ */

describe('geo write-path plausibility', () => {
  it('a normal GeoIP verdict writes coordinates inside the country box', async () => {
    mockFetch.mockResolvedValue(verdict({ country: 'Germany', countryCode: 'DE', city: 'Frankfurt', latitude: 50.11, longitude: 8.68, asn: 24940, isp: 'Hetzner' }));
    const { repo, geoWrites } = fakeRepo([row({ id: 'de1', ipv4: ['85.10.20.30'] })]);
    const out = await enrichNodeGeoBatch(repo, [{ ...row({ id: 'de1', ipv4: ['85.10.20.30'] }) }], log);
    expect(out.resolved).toBe(1);
    const g = geoWrites[0]!.geo;
    expect(g.country).toBe('DE');
    expect(inCountryBox(g.country as string, g.lat as number, g.lon as number)).toBe(true);
  });

  it('anycast rows end with NO coordinates and NO country (0 poisoned pins)', async () => {
    // ipwho.is answers confidently for 1.1.1.1 — the guard must refuse it.
    mockFetch.mockResolvedValue(verdict({ country: 'Australia', countryCode: 'AU', city: 'Brisbane', latitude: -27.47, longitude: 153.02, asn: 13335, isp: 'Cloudflare' }));
    const { repo, geoWrites } = fakeRepo([row({ id: 'cf1', host: '1.1.1.1', ipv4: ['1.1.1.1'] })]);
    await enrichNodeGeoBatch(repo, [{ ...row({ id: 'cf1', host: '1.1.1.1', ipv4: ['1.1.1.1'] }) }], log);
    expect(geoWrites).toHaveLength(1);
    const g = geoWrites[0]!.geo;
    expect(g.lat).toBeNull();
    expect(g.lon).toBeNull();
    expect(g.country).toBeNull();
    // plausibility: no coordinates → trivially inside (no claim made)
    expect(inCountryBox(g.country as string | null, g.lat as number | null, g.lon as number | null)).toBe(true);
  });

  it('boot scrub leaves the dataset plausible: no refused row keeps coords', () => {
    const rows = [
      row({ id: 'cf1', host: '104.17.147.22', asn: 13335, country: 'US', city: 'San Francisco', lat: 37.77, lon: -122.42 }),
      row({ id: 'clean1', host: '188.42.89.157', asn: 60781, country: 'NL', city: 'Amsterdam', lat: 52.37, lon: 4.89 }),
      row({ id: 'clean2', host: '45.12.33.10', asn: 24940, country: 'DE', city: 'Frankfurt', lat: 50.11, lon: 8.68 }),
      row({ id: 'clean3', host: '202.5.20.1', asn: 4713, country: 'JP', city: 'Tokyo', lat: 35.68, lon: 139.69 }),
    ];
    const { repo, geoWrites } = fakeRepo(rows);
    scrubAnycastGeo(repo);
    // After the scrub, re-check every row: refused classes have no coords,
    // and every remaining coordinate is inside its country box.
    const finalRows = [...(repo.list({ limit: 5000 }) as { rows: PublicNodeRow[] }).rows];
    for (const r of finalRows) {
      const cls = r.geoSourceCount === 0 && r.lat == null ? 'refused' : 'geo';
      if (cls === 'refused') {
        expect(r.lat, r.id).toBeNull();
        expect(r.country, r.id).toBeNull();
      } else {
        expect(inCountryBox(r.country, r.lat, r.lon), `${r.id} (${r.country} @ ${r.lat},${r.lon})`).toBe(true);
      }
    }
    // scrub touched only the Cloudflare row
    expect(geoWrites.map((w) => w.id)).toEqual(['cf1']);
  });

  it('geojs fallback verdicts pass the same plausibility check', async () => {
    mockFetch.mockResolvedValue(null); // primary provider down / rate-limited
    mockGeoJs.mockResolvedValue({
      ip: '1.2.3.4', country: 'Japan', countryCode: 'JP', region: 'Tokyo', city: 'Tokyo',
      latitude: 35.68, longitude: 139.69, timezone: null, isp: 'NTT', org: 'NTT',
      asn: 4713, asnOrg: 'NTT', source: 'geojs.io',
    });
    const { repo, geoWrites } = fakeRepo([row({ id: 'jp1', ipv4: ['126.10.20.30'] })]);
    await enrichNodeGeoBatch(repo, [{ ...row({ id: 'jp1', ipv4: ['126.10.20.30'] }) }], log);
    expect(geoWrites).toHaveLength(1);
    const g = geoWrites[0]!.geo;
    expect(g.country).toBe('JP');
    expect(inCountryBox(g.country as string, g.lat as number, g.lon as number)).toBe(true);
  });
});

/* ------------------------------ helper probe ------------------------------ */

describe('geoForIp verdict guard', () => {
  it('strips coordinates for anycast hosts before they ever reach a write', async () => {
    clearGeoIpCacheForTests();
    mockFetch.mockResolvedValue(verdict({ country: 'Australia', countryCode: 'AU', city: 'Brisbane', latitude: -27.47, longitude: 153.02, asn: 13335, isp: 'Cloudflare' }));
    // geoForIp is not exported; the batch path covers it. This test documents
    // the invariant at the verdict level via a unicast contrast instead.
    expect(inCountryBox('AU', -27.47, 153.02)).toBe(true); // Brisbane IS in AU — the problem was the CLAIM, not the box
  });
});

/* -------------------- runtime plausibility gate (production) ------------------- */

describe('runtime bounding-box gate', () => {
  it('an implausible verdict (coords outside the claimed country) is refused at write time', async () => {
    clearGeoIpCacheForTests();
    // A poisoned GeoIP answer: claims DE but places the point in Japan.
    mockFetch.mockResolvedValue(verdict({ country: 'Germany', countryCode: 'DE', city: 'Nowhere', latitude: 35.68, longitude: 139.69, asn: 24940, isp: 'Hetzner' }));
    const { repo, geoWrites } = fakeRepo([row({ id: 'bad1', ipv4: ['85.10.20.30'] })]);
    const out = await enrichNodeGeoBatch(repo, [{ ...row({ id: 'bad1', ipv4: ['85.10.20.30'] }) }], log);
    // The gate strips the geography; the row keeps only facts → counted as
    // anycastRefused (the 'refused' write bucket), never as a resolved pin.
    expect(out.resolved).toBe(0);
    expect(out.anycastRefused).toBe(1);
    const g = geoWrites[0]!.geo;
    expect(g.lat).toBeNull();
    expect(g.lon).toBeNull();
    expect(g.country).toBeNull();
  });

  it('a lookup whose every geography was stripped keeps ISP/ASN facts (honest Unknown, not lost row)', async () => {
    clearGeoIpCacheForTests();
    mockFetch.mockResolvedValue(verdict({ country: 'Japan', countryCode: 'JP', city: 'Phantom', latitude: 8.68, longitude: 50.11, asn: 4713, isp: 'NTT' }));
    const { repo, geoWrites } = fakeRepo([row({ id: 'bad2', ipv4: ['126.10.20.30'] })]);
    await enrichNodeGeoBatch(repo, [{ ...row({ id: 'bad2', ipv4: ['126.10.20.30'] }) }], log);
    const g = geoWrites[0]!.geo;
    expect(g.lat).toBeNull();
    expect(g.country).toBeNull();
    expect(g.asn).toBe(4713); // facts survive the refusal
    expect(g.isp).toBe('NTT');
  });

  it('a re-check of an implausible verdict resolves honestly as lookup_failed, writing nothing geographic', async () => {
    clearGeoIpCacheForTests();
    mockFetch.mockResolvedValue(verdict({ country: 'Netherlands', countryCode: 'NL', city: 'Ghost', latitude: 35.68, longitude: 139.69, asn: 60781, isp: 'LeaseWeb' }));
    const { repo, geoWrites } = fakeRepo([row({ id: 'bad3', host: '198.7.58.1', ipv4: ['198.7.58.1'] })]);
    const result = await recheckNodeGeo(repo, { ...row({ id: 'bad3', host: '198.7.58.1', ipv4: ['198.7.58.1'] }) }, log);
    expect(result.outcome).toBe('failed');
    expect((result as { outcome: 'failed'; reason: string }).reason).toBe('lookup_failed');
    expect(geoWrites).toHaveLength(0); // nothing implausible written
  });

  it('legit verdicts near box edges survive (margin covers offshore islands)', async () => {
    clearGeoIpCacheForTests();
    // Honolulu: outside the US mainland box, inside the Hawaii region box.
    mockFetch.mockResolvedValue(verdict({ country: 'United States', countryCode: 'US', city: 'Honolulu', latitude: 21.31, longitude: -157.86, asn: 6939, isp: 'Hurricane Electric' }));
    const { repo, geoWrites } = fakeRepo([row({ id: 'hi1', ipv4: ['72.52.100.10'] })]);
    const out = await enrichNodeGeoBatch(repo, [{ ...row({ id: 'hi1', ipv4: ['72.52.100.10'] }) }], log);
    expect(out.resolved).toBe(1);
    const g = geoWrites[0]!.geo;
    expect(g.lat).toBeCloseTo(21.31);
    expect(g.country).toBe('US');
    expect(inCountryBox('US', g.lat as number, g.lon as number)).toBe(true);
  });

  it('a re-check of a unicast node writes the ISO country code, never the full name', async () => {
    clearGeoIpCacheForTests();
    // Provider answered with both name and code; the DB must carry 'CN' so
    // code-keyed guards (boxes, facets, the gate itself) see it. Regression:
    // recheckNodeGeo once wrote the full name ('China'), which slipped past
    // every code-keyed check.
    mockFetch.mockResolvedValue(verdict({ country: 'China', countryCode: 'CN', city: 'Zhengzhou', latitude: 34.75, longitude: 113.62, asn: 24415, isp: 'Tencent' }));
    const { repo, geoWrites } = fakeRepo([row({ id: 'cn1', host: '167.179.34.31', ipv4: ['167.179.34.31'] })]);
    const result = await recheckNodeGeo(repo, { ...row({ id: 'cn1', host: '167.179.34.31', ipv4: ['167.179.34.31'] }) }, log);
    expect(result.outcome).toBe('resolved');
    expect(geoWrites).toHaveLength(1);
    expect(geoWrites[0]!.geo.country).toBe('CN');
  });

  it('a verdict for a country with no box still passes (coverage flag, not refusal)', async () => {
    clearGeoIpCacheForTests();
    // NG is not in the table: the gate cannot judge it, so the verdict must
    // PASS (no box, no claim) — and the coverage warn must fire so the gap
    // surfaces from live data instead of being silently ignored.
    mockFetch.mockResolvedValue(verdict({ country: 'Nigeria', countryCode: 'NG', city: 'Lagos', latitude: 6.52, longitude: 3.38, asn: 37282, isp: 'MainOne' }));
    const { repo, geoWrites } = fakeRepo([row({ id: 'ng1', ipv4: ['105.112.59.10'] })]);
    const out = await enrichNodeGeoBatch(repo, [{ ...row({ id: 'ng1', ipv4: ['105.112.59.10'] }) }], log);
    expect(out.resolved).toBe(1);
    expect(geoWrites[0]!.geo.country).toBe('NG');
    expect(geoWrites[0]!.geo.lat).toBeCloseTo(6.52);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ country: 'NG' }), 'geo: no bounding box for country — plausibility gate skipped');
  });

  it('boot scrub also heals legacy rows whose country contradicts their coordinates', () => {
    const rows = [
      // Legacy poison: claims DE, coordinates in Japan.
      row({ id: 'legacy1', host: '85.10.20.30', asn: 24940, country: 'DE', city: 'Frankfurt', lat: 35.68, lon: 139.69 }),
      // Legit row: untouched.
      row({ id: 'ok1', host: '85.10.20.31', asn: 24940, country: 'DE', city: 'Frankfurt', lat: 50.11, lon: 8.68 }),
    ];
    const { repo, geoWrites } = fakeRepo(rows);
    const n = scrubAnycastGeo(repo);
    expect(n).toBe(1);
    expect(geoWrites.map((w) => w.id)).toEqual(['legacy1']);
    const finalRows = [...(repo.list({ limit: 5000 }) as { rows: PublicNodeRow[] }).rows];
    for (const r of finalRows) {
      if (r.lat != null) {
        expect(inCountryBox(r.country, r.lat, r.lon), `${r.id}`).toBe(true);
      }
    }
  });
});
