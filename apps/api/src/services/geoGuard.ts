import fs from 'node:fs';
import path from 'node:path';

/**
 * Anycast / edge-fabric guard data — the evidence classes that make a GeoIP
 * city answer an artifact rather than a location.
 *
 * Layers, most specific wins:
 *   1. USER OVERRIDES  — <dataDir>/geo-overrides.json, human-editable, hot-
 *      reloaded on mtime change. Lets users fix future cases without a
 *      release: force a location (`"force": {"lat, lon, …}"`), refuse one
 *      (`"class": "anycast" | "edge_fabric"`), or vouch for an IP the guard
 *      refuses by default (`"class": "unicast"`).
 *   2. CURATED EDGE ASNS — providers whose address space is worldwide
 *      edge/PoP fabric; GeoIP answers point at the registry HQ, not the
 *      traffic exit.
 *   3. CURATED ANYCAST HOSTS — exact IPs announced from many sites at once
 *      (public DNS resolvers and similar services).
 *
 * The guard never runs: it only classifies. Callers decide what a class
 * means for their write path.
 */

export type GeoGuardClass = 'anycast' | 'edge_fabric' | 'unicast';

export interface GeoOverride {
  class: GeoGuardClass;
  /** with class "unicast": the verified location to pin (all required) */
  force?: { lat: number; lon: number; country: string; city?: string };
  /** human note, shown nowhere but useful in the file itself */
  note?: string;
}

/** Exact anycast IPs: a GeoIP city for these is always an artifact. */
const ANYCAST_HOSTS = new Set<string>([
  // Cloudflare DNS
  '1.1.1.1', '1.0.0.1', '2606:4700:4700::1111', '2606:4700:4700::1001',
  // Google DNS
  '8.8.8.8', '8.8.4.4', '2001:4860:4860::8888', '2001:4860:4860::8844',
  // Quad9
  '9.9.9.9', '149.112.112.112', '2620:fe::fe', '2620:fe::9',
  // OpenDNS
  '208.67.222.222', '208.67.220.220',
  // AdGuard
  '94.140.14.14', '94.140.15.15', '2a10:50c0::ad1:ff', '2a10:50c0::ad2:ff',
  // CleanBrowsing
  '185.228.168.9', '185.228.169.9',
  // ControlD
  '76.76.10.0',
  // Mullvad DNS
  '194.242.2.2',
  // DNS.SB
  '185.222.222.222', '45.11.45.11',
  // CIRA (Canada)
  '149.112.121.10', '149.112.122.10',
  // DNS.WATCH
  '84.200.69.80', '84.200.70.40',
  // Yandex DNS
  '77.88.8.8', '77.88.8.1',
]);

/**
 * Provider ASNs whose address space is global edge/PoP fabric. GeoIP answers
 * for these are registry/HQ artifacts. This is a deliberately conservative,
 * *curated* list: only networks whose IPs genuinely have no per-server
 * geography (CDN edges, cloud front doors) — not generic hosters.
 */
const EDGE_ASN_CLASSES = new Map<number, { name: string }>([
  // Cloudflare — the entire announced range is edge
  [13335, { name: 'Cloudflare' }],
  [396982, { name: 'Google Cloud (edge Peering)' }],
  // Google
  [15169, { name: 'Google' }],
  [396981, { name: 'Google (edge Peering)' }],
  // Amazon AWS — front doors/CloudFront; EC2 regions keep real geography,
  // but their GeoIP answers are city-of-region, which is honest; AWS-owned
  // edge ASNs below are the fabric ones.
  [16509, { name: 'Amazon AWS' }],
  [14618, { name: 'Amazon AWS' }],
  // Microsoft Azure
  [8075, { name: 'Microsoft Azure' }],
  [8068, { name: 'Microsoft' }],
  // Fastly
  [54113, { name: 'Fastly' }],
  // Akamai
  [20940, { name: 'Akamai' }],
  [16625, { name: 'Akamai' }],
  // Verizon edge
  [15133, { name: 'Verizon Edgecast' }],
  // GCore
  [209242, { name: 'GCore' }],
  [199524, { name: 'GCore' }],
  // StackPath/Highwinds
  [20446, { name: 'StackPath' }],
  [33438, { name: 'Highwinds' }],
  // Bunny CDN
  [200651, { name: 'Bunny.net' }],
  // Cloudian/others are deliberately excluded: only fabric networks belong.
  [13379, { name: 'Oracle Cloud (edge)' }],
  [14659, { name: 'Equinix' }],
  // DDoS protection / proxy networks (anycast-like behavior)
  [200001, { name: 'DDoS-Guard' }],
  [264428, { name: 'DDoS-Guard' }],
  [9009, { name: 'M247 (anycast-heavy)' }],
  [30633, { name: 'LeaseWeb (anycast services)' }],
]);

/** Shape of <dataDir>/geo-overrides.json */
export interface GeoOverridesFile {
  /** "geo-overrides" — the loader rejects files without it (typo protection) */
  version: 1;
  overrides: Record<string, GeoOverride>;
}

interface GuardState {
  overrides: Map<string, GeoOverride>;
  fileMtimeMs: number | null;
  fileCheckedAt: number;
  lastError: string | null;
}

const state: GuardState = {
  overrides: new Map(),
  fileMtimeMs: null,
  fileCheckedAt: 0,
  lastError: null,
};

/** Override-file recheck cadence — cheap stat() per geo lookup batch. */
const OVERRIDE_RECHECK_MS = 30_000;

/** Where the user override file lives; set once at boot. */
let overrideFilePath: string | null = null;

export function setGeoOverrideFile(filePath: string | null): void {
  overrideFilePath = filePath;
  state.fileMtimeMs = null;
  state.fileCheckedAt = 0;
  state.overrides = new Map();
  state.lastError = null;
}

export function geoOverrideFilePath(): string | null {
  return overrideFilePath;
}

/** Parse + validate an overrides file; throws on structural problems. */
export function parseGeoOverrides(raw: string): Map<string, GeoOverride> {
  const parsed = JSON.parse(raw) as GeoOverridesFile;
  if (parsed.version !== 1 || typeof parsed.overrides !== 'object' || parsed.overrides == null) {
    throw new Error('expected {"version":1,"overrides":{...}}');
  }
  const out = new Map<string, GeoOverride>();
  for (const [key, value] of Object.entries(parsed.overrides)) {
    const k = key.trim().toLowerCase();
    if (!k) continue;
    const isAsn = k.startsWith('as') && /^\d+$/.test(k.slice(2));
    const isIp = !k.includes('/') && /^[0-9a-f.:]+$/.test(k);
    if (!isAsn && !isIp) throw new Error(`bad override key "${key}" (expected IP or AS<number>)`);
    if (!value || typeof value !== 'object' || !['anycast', 'edge_fabric', 'unicast'].includes(value.class)) {
      throw new Error(`bad class for "${key}" (expected anycast | edge_fabric | unicast)`);
    }
    if (value.class === 'unicast') {
      const f = value.force;
      if (!f || typeof f.lat !== 'number' || typeof f.lon !== 'number' || typeof f.country !== 'string') {
        throw new Error(`"unicast" override for "${key}" needs force:{lat,lon,country}`);
      }
    }
    out.set(k, value);
  }
  return out;
}

/** Load (or hot-reload) the override file if it changed. Never throws. */
function refreshOverridesIfChanged(now: number): void {
  if (!overrideFilePath || now - state.fileCheckedAt < OVERRIDE_RECHECK_MS) return;
  state.fileCheckedAt = now;
  let mtime: number | null = null;
  try {
    mtime = fs.statSync(overrideFilePath).mtimeMs;
  } catch {
    // File absent: keep whatever we have? No — absence after deletion should
    // clear overrides so removing the file takes effect.
    if (state.overrides.size > 0 || state.fileMtimeMs != null) {
      state.overrides = new Map();
      state.fileMtimeMs = null;
      state.lastError = null;
    }
    return;
  }
  if (state.fileMtimeMs === mtime) return;
  try {
    const raw = fs.readFileSync(overrideFilePath, 'utf8');
    state.overrides = parseGeoOverrides(raw);
    state.fileMtimeMs = mtime;
    state.lastError = null;
  } catch (err) {
    // Malformed file: keep previous overrides (if any) and record why, so a
    // typo can never blank the guard or crash the worker.
    state.lastError = err instanceof Error ? err.message : String(err);
  }
}

/** Test/ops introspection: last override-file parse error, if any. */
export function geoOverrideError(): string | null {
  return state.lastError;
}

/** Test hook: reset loader state. */
export function resetGeoGuardForTests(): void {
  overrideFilePath = null;
  state.overrides = new Map();
  state.fileMtimeMs = null;
  state.fileCheckedAt = 0;
  state.lastError = null;
}

/** Test hook: force the next classify/force call to stat the file again. */
export function expireGeoOverrideCheckForTests(): void {
  state.fileCheckedAt = 0;
}

/**
 * Classify one IP/ASN pair. Returns 'unicast' (normal network — geo answer
 * is trustworthy), 'anycast', or 'edge_fabric' (GeoIP answer is an artifact).
 */
export function classifyGeoTarget(ip: string, asn: number | null): GeoGuardClass {
  const now = Date.now();
  refreshOverridesIfChanged(now);

  const ipKey = ip.toLowerCase();
  const user = state.overrides.get(ipKey);
  if (user) return user.class;
  const asnKey = asn != null ? `as${asn}` : null;
  if (asnKey) {
    const userAsn = state.overrides.get(asnKey);
    if (userAsn) return userAsn.class;
  }

  if (ANYCAST_HOSTS.has(ipKey)) return 'anycast';
  if (asn != null && EDGE_ASN_CLASSES.has(asn)) return 'edge_fabric';
  return 'unicast';
}

/**
 * User-attested coordinates for an IP/ASN, or null. Only overrides with
 * class "unicast" carry a forced location; they beat both the curated guard
 * (vouching a refused IP back into pin-able territory) and GeoIP itself.
 */
export function geoForcedLocation(ip: string, asn: number | null): { lat: number; lon: number; country: string; city?: string } | null {
  const now = Date.now();
  refreshOverridesIfChanged(now);

  const ipKey = ip.toLowerCase();
  const byIp = state.overrides.get(ipKey);
  if (byIp?.class === 'unicast' && byIp.force) return byIp.force;
  const asnKey = asn != null ? `as${asn}` : null;
  if (asnKey) {
    const byAsn = state.overrides.get(asnKey);
    if (byAsn?.class === 'unicast' && byAsn.force) return byAsn.force;
  }
  return null;
}

/**
 * Does the user vouch (unicast override) for this IP or its ASN? A vouched
 * target is user-attested real infrastructure: a missing location reads as
 * "awaiting the forced pin", never "lookup failed".
 */
export function geoVouchedByOverride(ip: string, asn: number | null): boolean {
  const now = Date.now();
  refreshOverridesIfChanged(now);
  const byIp = state.overrides.get(ip.toLowerCase());
  if (byIp?.class === 'unicast') return true;
  const byAsn = asn != null ? state.overrides.get(`as${asn}`) : undefined;
  return byAsn?.class === 'unicast';
}

/** The curated class name for an ASN, for display (null if not curated). */
export function curatedEdgeAsnName(asn: number): string | null {
  return EDGE_ASN_CLASSES.get(asn)?.name ?? null;
}

/** Test hook: inject overrides without touching the filesystem. */
export function setGeoOverridesForTest(overrides: Map<string, GeoOverride>): void {
  state.overrides = overrides;
  state.fileMtimeMs = null;
  state.fileCheckedAt = Date.now();
}

/** Default override file path for a data dir. */
export function defaultGeoOverridePath(dataDir: string): string {
  return path.join(dataDir, 'geo-overrides.json');
}
