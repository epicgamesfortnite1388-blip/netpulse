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
  source: 'ipwho.is';
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
