export interface IpWhoIsResult {
  ip: string;
  country: string | null;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  isp: string | null;
  org: string | null;
  asn: number | null;
  asnOrg: string | null;
  source: 'ipwho.is' | 'geojs.io';
}

interface IpWhoIsRaw {
  success?: boolean;
  ip?: string;
  country?: string;
  country_code?: string;
  region?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  timezone?: { id?: string };
  connection?: { asn?: number; org?: string; isp?: string; domain?: string };
}

/**
 * Free, key-less IP intelligence over HTTPS (https://ipwho.is).
 * Returns null on failure — callers must degrade gracefully.
 */
export async function fetchIpWhoIs(ip: string, timeoutMs = 6_000): Promise<IpWhoIsResult | null> {
  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'netpulse/0.1' },
    });
    if (!res.ok) return null;
    const raw = (await res.json()) as IpWhoIsRaw;
    if (raw.success === false || !raw.ip) return null;
    return {
      ip: raw.ip,
      country: raw.country ?? null,
      countryCode: raw.country_code ?? null,
      region: raw.region ?? null,
      city: raw.city ?? null,
      latitude: raw.latitude ?? null,
      longitude: raw.longitude ?? null,
      timezone: raw.timezone?.id ?? null,
      isp: raw.connection?.isp ?? null,
      org: raw.connection?.org ?? null,
      asn: raw.connection?.asn ?? null,
      asnOrg: raw.connection?.org ?? null,
      source: 'ipwho.is',
    };
  } catch {
    return null;
  }
}

interface GeoJsRaw {
  ip?: string;
  country?: string;
  country_code?: string;
  region?: string;
  city?: string;
  latitude?: string | number;
  longitude?: string | number;
  timezone?: string;
  asn?: number | string;
  organization_name?: string;
  organization?: string;
}

/** Fallback provider: geojs.io (key-less, generous limits) — used when
 *  ipwho.is is rate-limited/unreachable so lookups degrade, not die. */
export async function fetchGeoJs(ip: string, timeoutMs = 6_000): Promise<IpWhoIsResult | null> {
  try {
    const res = await fetch(`https://get.geojs.io/v1/ip/geo/${encodeURIComponent(ip)}.json`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'netpulse/0.1' },
    });
    if (!res.ok) return null;
    const raw = (await res.json()) as GeoJsRaw;
    if (!raw.ip) return null;
    // geojs returns 'nil' strings for unknown coordinates.
    const lat = raw.latitude != null && raw.latitude !== 'nil' ? Number(raw.latitude) : null;
    const lon = raw.longitude != null && raw.longitude !== 'nil' ? Number(raw.longitude) : null;
    const asn = raw.asn != null && raw.asn !== '' ? Number(raw.asn) : null;
    return {
      ip: raw.ip,
      country: raw.country ?? null,
      countryCode: raw.country_code ?? null,
      region: raw.region ?? null,
      city: raw.city ?? null,
      latitude: lat != null && Number.isFinite(lat) ? lat : null,
      longitude: lon != null && Number.isFinite(lon) ? lon : null,
      timezone: raw.timezone ?? null,
      isp: raw.organization_name ?? raw.organization ?? null,
      org: raw.organization ?? null,
      asn: asn != null && Number.isFinite(asn) ? asn : null,
      asnOrg: raw.organization ?? null,
      source: 'geojs.io',
    };
  } catch {
    return null;
  }
}

export type GeoProviderId = 'ipwho.is' | 'geojs.io';

/**
 * Failover order for the user's geoProvider preference.
 *
 *   - 'auto'      → ipwho.is, then geojs.io (default: richer verdicts first)
 *   - 'ipwho.is'  → ipwho.is, then geojs.io
 *   - 'geojs.io'  → geojs.io, then ipwho.is
 *
 * The non-preferred provider always remains as failover: a preference
 * changes the order — it never removes a provider.
 */
export function geoProviderOrder(preferred: 'auto' | GeoProviderId): GeoProviderId[] {
  return preferred === 'geojs.io' ? ['geojs.io', 'ipwho.is'] : ['ipwho.is', 'geojs.io'];
}
