import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyGeoTarget,
  curatedEdgeAsnName,
  defaultGeoOverridePath,
  expireGeoOverrideCheckForTests,
  geoForcedLocation,
  geoOverrideError,
  geoVouchedByOverride,
  parseGeoOverrides,
  resetGeoGuardForTests,
  setGeoOverrideFile,
  setGeoOverridesForTest,
} from '../src/services/geoGuard';

/**
 * Geo guard contract (anycast/edge-fabric + user overrides):
 *   - curated anycast hosts and edge-fabric ASNs refuse GeoIP geography
 *   - the user override file wins over the curated data in BOTH directions:
 *     refuse a normally-trustworthy IP, or vouch ("unicast" + force) an IP
 *     the curated guard would refuse
 *   - a malformed override file is reported, never crashes, and never blanks
 *     previously-loaded overrides
 *   - the file is hot-reloaded on mtime change
 */

describe('curated classification', () => {
  afterEach(() => resetGeoGuardForTests());

  it('classifies well-known anycast hosts', () => {
    expect(classifyGeoTarget('1.1.1.1', 13335)).toBe('anycast');
    expect(classifyGeoTarget('8.8.8.8', null)).toBe('anycast');
    expect(classifyGeoTarget('9.9.9.9', null)).toBe('anycast');
  });

  it('classifies curated edge-fabric ASNs', () => {
    expect(classifyGeoTarget('104.17.147.22', 13335)).toBe('edge_fabric'); // Cloudflare
    expect(classifyGeoTarget('34.1.2.3', 15169)).toBe('edge_fabric'); // Google
    expect(classifyGeoTarget('13.1.2.3', 8075)).toBe('edge_fabric'); // Azure
    expect(classifyGeoTarget('151.101.1.1', 54113)).toBe('edge_fabric'); // Fastly
    expect(classifyGeoTarget('23.1.2.3', 20940)).toBe('edge_fabric'); // Akamai
  });

  it('leaves ordinary hosters unicast (geo answer is trustworthy)', () => {
    expect(classifyGeoTarget('188.42.89.157', 60781)).toBe('unicast');
    expect(classifyGeoTarget('45.131.7.215', null)).toBe('unicast');
    expect(classifyGeoTarget('170.64.171.83', 14061)).toBe('unicast'); // DigitalOcean
  });

  it('exposes curated names for display', () => {
    expect(curatedEdgeAsnName(13335)).toBe('Cloudflare');
    expect(curatedEdgeAsnName(60781)).toBeNull();
  });
});

describe('parseGeoOverrides', () => {
  it('accepts a valid file', () => {
    const m = parseGeoOverrides(JSON.stringify({
      version: 1,
      overrides: {
        '203.0.113.7': { class: 'anycast' },
        'AS64512': { class: 'edge_fabric' },
        '198.51.100.9': { class: 'unicast', force: { lat: 52.37, lon: 4.89, country: 'NL', city: 'Amsterdam' } },
      },
    }));
    expect(m.size).toBe(3);
    expect(m.get('as64512')?.class).toBe('edge_fabric');
  });

  it('rejects wrong version, bad keys, bad classes, unicast without force', () => {
    expect(() => parseGeoOverrides('{"version":2,"overrides":{}}')).toThrow();
    expect(() => parseGeoOverrides('{"version":1,"overrides":{"not an ip":{"class":"anycast"}}}')).toThrow(/bad override key/);
    expect(() => parseGeoOverrides('{"version":1,"overrides":{"1.2.3.4":{"class":"bogus"}}}')).toThrow(/bad class/);
    expect(() => parseGeoOverrides('{"version":1,"overrides":{"1.2.3.4":{"class":"unicast"}}}')).toThrow(/needs force/);
    expect(() => parseGeoOverrides('not json')).toThrow();
  });
});

describe('user override file', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-geoguard-'));
    resetGeoGuardForTests();
  });

  afterEach(() => {
    resetGeoGuardForTests();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows race */ }
  });

  it('user override refuses a normally-unicast IP', () => {
    fs.writeFileSync(path.join(tmp, 'geo-overrides.json'), JSON.stringify({
      version: 1,
      overrides: { '188.42.89.157': { class: 'edge_fabric', note: 'this range is anycast in practice' } },
    }));
    setGeoOverrideFile(path.join(tmp, 'geo-overrides.json'));
    expect(classifyGeoTarget('188.42.89.157', 60781)).toBe('edge_fabric');
    // other IPs unaffected
    expect(classifyGeoTarget('188.42.89.158', 60781)).toBe('unicast');
  });

  it('user override vouches an IP the curated guard refuses (unicast + force)', () => {
    fs.writeFileSync(path.join(tmp, 'geo-overrides.json'), JSON.stringify({
      version: 1,
      overrides: { '1.2.3.4': { class: 'unicast', force: { lat: -33.87, lon: 151.21, country: 'AU', city: 'Sydney' } } },
    }));
    setGeoOverrideFile(path.join(tmp, 'geo-overrides.json'));
    // IP is not anycast anyway — but force wins over GeoIP
    expect(classifyGeoTarget('1.2.3.4', null)).toBe('unicast');
    expect(geoForcedLocation('1.2.3.4', null)?.country).toBe('AU');
  });

  it('an ASN-level override reclassifies every IP under it', () => {
    fs.writeFileSync(path.join(tmp, 'geo-overrides.json'), JSON.stringify({
      version: 1,
      overrides: { 'AS60781': { class: 'edge_fabric' } },
    }));
    setGeoOverrideFile(path.join(tmp, 'geo-overrides.json'));
    expect(classifyGeoTarget('188.42.89.157', 60781)).toBe('edge_fabric');
    expect(classifyGeoTarget('188.42.90.1', 60781)).toBe('edge_fabric');
  });

  it('an IP override beats an ASN override (specificity)', () => {
    fs.writeFileSync(path.join(tmp, 'geo-overrides.json'), JSON.stringify({
      version: 1,
      overrides: {
        'AS60781': { class: 'edge_fabric' },
        '188.42.89.157': { class: 'unicast', force: { lat: 52.37, lon: 4.89, country: 'NL' } },
      },
    }));
    setGeoOverrideFile(path.join(tmp, 'geo-overrides.json'));
    expect(classifyGeoTarget('188.42.89.157', 60781)).toBe('unicast');
    expect(classifyGeoTarget('188.42.90.1', 60781)).toBe('edge_fabric');
  });

  it('user unicast override beats the curated edge-fabric refusal for a Cloudflare IP', () => {
    fs.writeFileSync(path.join(tmp, 'geo-overrides.json'), JSON.stringify({
      version: 1,
      overrides: { '104.17.147.22': { class: 'unicast', force: { lat: 37.77, lon: -122.42, country: 'US', city: 'San Francisco' }, note: 'dedicated (non-edge) IP confirmed with provider' } },
    }));
    setGeoOverrideFile(path.join(tmp, 'geo-overrides.json'));
    expect(classifyGeoTarget('104.17.147.22', 13335)).toBe('unicast');
    expect(geoForcedLocation('104.17.147.22', 13335)?.city).toBe('San Francisco');
    // sibling Cloudflare IP stays refused
    expect(classifyGeoTarget('104.17.147.23', 13335)).toBe('edge_fabric');
  });

  it('hot-reloads on mtime change', async () => {
    const file = path.join(tmp, 'geo-overrides.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, overrides: { '1.2.3.4': { class: 'anycast' } } }));
    setGeoOverrideFile(file);
    expect(classifyGeoTarget('1.2.3.4', null)).toBe('anycast');

    // mtime granularity on some filesystems is 1s–2s; force distinct mtimes
    const future = new Date(Date.now() + 5000);
    fs.writeFileSync(file, JSON.stringify({ version: 1, overrides: { '1.2.3.4': { class: 'unicast', force: { lat: 1, lon: 2, country: 'NZ' } } } }));
    fs.utimesSync(file, future, future);
    expireGeoOverrideCheckForTests(); // skip the 30 s recheck cadence
    expect(classifyGeoTarget('1.2.3.4', null)).toBe('unicast');
    expect(geoForcedLocation('1.2.3.4', null)?.country).toBe('NZ');
  });

  it('malformed file keeps prior overrides and reports the error', () => {
    const file = path.join(tmp, 'geo-overrides.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, overrides: { '1.2.3.4': { class: 'anycast' } } }));
    setGeoOverrideFile(file);
    expect(classifyGeoTarget('1.2.3.4', null)).toBe('anycast');

    const future = new Date(Date.now() + 5000);
    fs.writeFileSync(file, '{ this is not json');
    fs.utimesSync(file, future, future);
    expireGeoOverrideCheckForTests();
    expect(classifyGeoTarget('1.2.3.4', null)).toBe('anycast'); // prior data kept
    expect(geoOverrideError()).toBeTruthy();
  });

  it('deleting the file clears overrides', () => {
    const file = path.join(tmp, 'geo-overrides.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, overrides: { '1.2.3.4': { class: 'anycast' } } }));
    setGeoOverrideFile(file);
    expect(classifyGeoTarget('1.2.3.4', null)).toBe('anycast');

    fs.rmSync(file);
    expireGeoOverrideCheckForTests(); // stat() miss clears state
    expect(classifyGeoTarget('1.2.3.4', null)).toBe('unicast');
  });

  it('no file at all → purely curated behavior', () => {
    setGeoOverrideFile(path.join(tmp, 'does-not-exist.json'));
    expect(classifyGeoTarget('1.1.1.1', null)).toBe('anycast');
    expect(classifyGeoTarget('5.6.7.8', null)).toBe('unicast');
    expect(geoOverrideError()).toBeNull();
  });

  it('default path lives in the data dir', () => {
    expect(defaultGeoOverridePath('C:/data').replace(/\\/g, '/')).toBe('C:/data/geo-overrides.json');
  });
});

describe('in-memory overrides (test hook)', () => {
  afterEach(() => resetGeoGuardForTests());

  it('forced location applies at ASN level too', () => {
    const overrides = new Map(Object.entries({
      'as64512': { class: 'unicast' as const, force: { lat: 10, lon: 20, country: 'XX' } },
    }));
    setGeoOverridesForTest(overrides);
    expect(geoForcedLocation('9.9.9.9', 64512)?.country).toBe('XX');
    expect(geoForcedLocation('9.9.9.9', 999)).toBeNull();
  });

  it('vouched IPs/ASNs are detectable (used for honest status reasons)', () => {
    setGeoOverridesForTest(new Map(Object.entries({
      '1.2.3.4': { class: 'unicast' as const, force: { lat: 1, lon: 2, country: 'ZZ' } },
      'as64512': { class: 'unicast' as const, force: { lat: 3, lon: 4, country: 'YY' } },
      '5.6.7.8': { class: 'anycast' as const },
    })));
    expect(geoVouchedByOverride('1.2.3.4', null)).toBe(true);
    expect(geoVouchedByOverride('9.9.9.9', 64512)).toBe(true); // ASN vouch
    expect(geoVouchedByOverride('5.6.7.8', null)).toBe(false); // refuse, not vouch
    expect(geoVouchedByOverride('7.7.7.7', null)).toBe(false);
  });
});
