import dns from 'node:dns/promises';

import { fetchIpWhoIs } from '../providers/ipinfo/ipwhoIs';
import { familyOfIp, isPrivateIp } from '../util/targetGuard';
import { classifyGeoTarget, geoForcedLocation, geoVouchedByOverride } from './geoGuard';

import type { PublicNodeRow, PublicNodesRepository } from '../db/repositories';
import type { Logger } from '../logger';

/**
 * IP-evidence-based node geolocation.
 *
 * Rules (see FEATURE_GAPS.md — map accuracy):
 *   - Geography comes ONLY from the node's resolved public IP (ipwho.is), a
 *     Cloudflare colo probe when the host is fronted by Cloudflare, or an
 *     explicit ASN country answer. Never from node names, remarks, flag
 *     emoji, TLDs, or provider branding — those lie constantly.
 *   - ANYCAST IPs (Cloudflare 1.1.1.1, Google 8.8.8.8, AWS/Azure/GCP front
 *     doors) have NO true location: GeoIP databases fabricate a city for
 *     them (e.g. 1.1.1.1 "Brisbane, AU" from an Iranian vantage). Well-known
 *     anycast ranges are therefore refused a city pin entirely — the node
 *     shows Unknown instead of a confident lie.
 *   - A lookup that cannot establish location writes NOTHING (country stays
 *     null) and merely records the attempt, so the UI shows Unknown instead
 *     of inventing coordinates.
 *   - Every attempt is rate-limited per node (geo_last_attempt) and the whole
 *     worker is bounded + serialized, so a large node DB cannot cause a
 *     lookup storm.
 *   - Credentials never enter this module: only host/port/protocol metadata
 *     is read, and only host + geo metadata is written.
 */

/** Per-node minimum spacing between geo attempts. */
const ATTEMPT_SPACING_MS = 60_000;
/** Abort ipwho.is lookups quickly; the worker reruns on a schedule. */
const LOOKUP_TIMEOUT_MS = 6_000;
/** Never look up more than this many distinct hosts per pass. */
const MAX_HOSTS_PER_PASS = 20;

/**
 * Why a node has (or lacks) a map location. Surfaced on the node detail page
 * so "Unknown" is explained instead of looking like missing data.
 */
export type GeoStatusReason = 'known' | 'anycast' | 'edge_fabric' | 'lookup_failed' | 'pending';

export function geoStatusReasonFor(row: {
  host: string;
  lat: number | null;
  asn: number | null;
  geoLastAttempt: number | null;
}): GeoStatusReason {
  if (row.lat != null) return 'known';
  // Classification (anycast hosts, edge-fabric ASNs, user overrides) lives in
  // geoGuard.ts so the curated data and the per-user override file stay in
  // one place and are shared by the enrichment path and the boot scrub.
  const cls = classifyGeoTarget(row.host, row.asn);
  if (cls === 'anycast') return 'anycast';
  if (cls === 'edge_fabric') return 'edge_fabric';
  // A user-vouched IP awaits its forced pin — 'lookup_failed' would be a lie.
  if (geoVouchedByOverride(row.host, row.asn)) return 'pending';
  if (row.geoLastAttempt != null) return 'lookup_failed';
  return 'pending';
}

export interface GeoEnrichmentOutcome {
  attempted: number;
  resolved: number;
  skippedPrivate: number;
  anycastRefused: number;
  failed: number;
}

interface GeoVerdict {
  country: string | null;
  countryCode: string | null;
  city: string | null;
  region: string | null;
  lat: number | null;
  lon: number | null;
  asn: number | null;
  isp: string | null;
  organization: string | null;
}

/** In-process cache keyed by IP: identical hosts across nodes share one answer. */
const ipCache = new Map<string, { verdict: GeoVerdict | null; at: number }>();
const IP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Serialized execution guard — one enrichment pass at a time, ever. */
let running = false;

function isRefusedByGuard(ip: string, asn: number | null): boolean {
  return classifyGeoTarget(ip, asn) !== 'unicast';
}

/** All candidate public IPs for a node row (explicit fields first). */
function candidateIps(row: PublicNodeRow): string[] {
  const out: string[] = [];
  for (const ip of [...(row.ipv4 ?? []), ...(row.ipv6 ?? [])]) {
    if (ip && !out.includes(ip)) out.push(ip);
  }
  return out;
}

async function resolveHostIps(host: string): Promise<string[]> {
  const isLiteral = familyOfIp(host) !== null;
  if (isLiteral) return [host];
  try {
    const records = (await dns.lookup(host, { all: true, verbatim: true })) as unknown as Array<{ address: string }>;
    return records.map((r) => r.address);
  } catch {
    return [];
  }
}

/** Query ipwho.is for one IP; returns null when it cannot be geolocated. */
async function geoForIp(ip: string): Promise<GeoVerdict | null> {
  const cached = ipCache.get(ip);
  if (cached && Date.now() - cached.at < IP_CACHE_TTL_MS) return cached.verdict;
  let verdict: GeoVerdict | null = null;
  try {
    const d = await fetchIpWhoIs(ip, LOOKUP_TIMEOUT_MS);
    if (d && d.countryCode) {
      verdict = {
        country: d.country ?? null,
        countryCode: d.countryCode ?? null,
        city: d.city ?? null,
        region: d.region ?? null,
        lat: typeof d.latitude === 'number' ? d.latitude : null,
        lon: typeof d.longitude === 'number' ? d.longitude : null,
        asn: typeof d.asn === 'number' ? d.asn : null,
        isp: d.isp ?? null,
        organization: d.org ?? d.asnOrg ?? null,
      };
      // ipwho.is answers with 0/0 when it knows the country but not the city —
      // treat that as "no coordinates" rather than a Gulf-of-Guinea pin.
      if (verdict.lat === 0 && verdict.lon === 0) {
        verdict.lat = null;
        verdict.lon = null;
      }
      // Anycast/edge-fabric guard: keep the ASN/ISP facts, drop the fabricated
      // geography. A pin at "nearest Google/Cloudflare PoP" is a lie.
      if (verdict.lat != null && isRefusedByGuard(ip, verdict.asn)) {
        verdict.lat = null;
        verdict.lon = null;
        verdict.city = null;
        verdict.region = null;
      }
    }
  } catch {
    verdict = null;
  }
  ipCache.set(ip, { verdict, at: Date.now() });
  return verdict;
}

/**
 * Enrich a batch of nodes with IP-evidence geolocation.
 * Serialized + bounded; safe to call from a scheduler tick.
 */
export async function enrichNodeGeoBatch(
  nodesRepo: PublicNodesRepository,
  rows: PublicNodeRow[],
  log: Logger,
): Promise<GeoEnrichmentOutcome> {
  const outcome: GeoEnrichmentOutcome = { attempted: 0, resolved: 0, skippedPrivate: 0, anycastRefused: 0, failed: 0 };
  if (running || rows.length === 0) return outcome;
  running = true;
  try {
    const now = Date.now();
    // One attempt per node per pass; per-node spacing enforced here.
    const eligible = rows.filter((r) => r.geoLastAttempt == null || now - r.geoLastAttempt >= ATTEMPT_SPACING_MS);
    // Group by host so identical endpoints share a single DNS/geo lookup.
    const byHost = new Map<string, PublicNodeRow[]>();
    for (const row of eligible) {
      if (byHost.size >= MAX_HOSTS_PER_PASS) break;
      const list = byHost.get(row.host) ?? [];
      list.push(row);
      byHost.set(row.host, list);
    }

    for (const [host, group] of byHost) {
      if (group.length === 0) continue;
      outcome.attempted += group.length;
      for (const row of group) nodesRepo.markGeoAttempt(row.id, now);

      let ips = candidateIps(group[0]!);
      if (ips.length === 0) ips = await resolveHostIps(host);
      if (ips.length === 0) {
        outcome.failed += group.length;
        continue;
      }

      // Prefer the first public IP — private addresses prove nothing about
      // where a public service sits.
      const publicIp = ips.find((ip) => !isPrivateIp(ip));
      if (!publicIp) {
        outcome.skippedPrivate += group.length;
        continue;
      }

      const verdict = await geoForIp(publicIp);
      if (!verdict) {
        outcome.failed += group.length;
        continue;
      }

      // User override with class "unicast" + force coordinates: the user has
      // vouched this IP/ASN is a real server at a known place — pin it as
      // given, skipping the lookup entirely. Highest precedence.
      const forced = geoForcedLocation(publicIp, verdict?.asn ?? null);
      if (forced) {
        for (const row of group) {
          nodesRepo.updateGeo(row.id, {
            country: forced.country,
            city: forced.city ?? null,
            asn: verdict?.asn ?? null,
            isp: verdict?.isp ?? null,
            organization: verdict?.organization ?? null,
            lat: forced.lat,
            lon: forced.lon,
            confidence: 'high', // user-attested, stronger than any GeoIP guess
            geoSourceCount: 1,
          });
        }
        outcome.resolved += group.length;
        continue;
      }

      // Guard-refused target (anycast host, edge-fabric ASN, or a user
      // refuse-override) → record ISP/ASN facts but no geography at all —
      // for these networks even the COUNTRY in a GeoIP answer is an
      // artifact. The node honestly shows Unknown on the map. (A normal IP
      // whose lookup yielded country-only evidence falls through to the
      // normal write below, keeping country + 'low' confidence.)
      if (isRefusedByGuard(publicIp, verdict.asn)) {
        for (const row of group) {
          nodesRepo.updateGeo(row.id, {
            country: null,
            city: null,
            asn: verdict.asn,
            isp: verdict.isp,
            organization: verdict.organization,
            lat: null,
            lon: null,
            confidence: 'unknown',
            geoSourceCount: 1,
          });
        }
        outcome.anycastRefused += group.length;
        continue;
      }

      for (const row of group) {
        nodesRepo.updateGeo(row.id, {
          country: verdict.countryCode ?? verdict.country,
          city: verdict.city ?? verdict.region ?? null,
          asn: verdict.asn,
          isp: verdict.isp,
          organization: verdict.organization,
          lat: verdict.lat,
          lon: verdict.lon,
          // NodeConfidence scale: city-level GeoIP is approximate ('medium'),
          // country/ASN-only evidence is 'low'. 'high' is reserved for
          // known-endpoint probes (Cloudflare colo), not GeoIP guesses.
          confidence: verdict.lat != null ? 'medium' : 'low',
          geoSourceCount: 1,
        });
      }
      outcome.resolved += group.length;
    }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'node geo enrichment pass failed');
  } finally {
    running = false;
  }
  return outcome;
}

/** Test hook: clear the module-level IP cache. */
export function clearGeoIpCacheForTests(): void {
  ipCache.clear();
}

/**
 * One-time boot scrub: nodes the guard refuses (anycast hosts, edge-fabric
 * ASNs, user overrides) must not carry coordinates from an earlier build's
 * GeoIP answer (e.g. 1.1.1.1 "Brisbane, AU", Cloudflare IPs "San Francisco").
 * Clears the fabricated geography, keeps ASN/ISP facts. A user override with
 * class "unicast" + force coordinates re-pins a node instead.
 * Returns how many rows were touched.
 */
export function scrubAnycastGeo(nodesRepo: {
  list(opts: { limit: number }): { rows: PublicNodeRow[] };
  updateGeo(id: string, geo: Record<string, unknown>): void;
}): number {
  let scrubbed = 0;
  try {
    for (const row of nodesRepo.list({ limit: 5000 }).rows) {
      const cls = classifyGeoTarget(row.host, row.asn);
      if (cls === 'unicast') continue;
      if (row.lat == null && row.lon == null && row.country == null) continue;
      nodesRepo.updateGeo(row.id, {
        country: null,
        city: null,
        lat: null,
        lon: null,
        confidence: 'unknown',
        geoSourceCount: 1,
        geoLastAttempt: Date.now(),
      });
      scrubbed += 1;
    }
  } catch {
    // scrub is best-effort; the geo worker refuses refused-classes going forward
  }
  return scrubbed;
}
