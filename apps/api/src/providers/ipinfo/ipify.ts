/**
 * Fallback public-IP discovery via ipify. Used when the literal-IP
 * Cloudflare trace endpoint is unreachable (some networks block HTTPS to
 * raw IPs while DNS-resolved hosts work fine). ipify supports IPv4 and IPv6
 * (`api64.ipify.org`), so the address family can still be forced.
 */
export interface IpifyLookup {
  ip: string;
  source: 'ipify';
}

export async function fetchIpify(family: 4 | 6, timeoutMs = 5_000): Promise<IpifyLookup | null> {
  const host = family === 6 ? 'https://api64.ipify.org?format=json' : 'https://api.ipify.org?format=json';
  try {
    const res = await fetch(host, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'netpulse/0.1' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { ip?: unknown };
    if (typeof body.ip !== 'string' || body.ip.length === 0) return null;
    return { ip: body.ip, source: 'ipify' };
  } catch {
    return null;
  }
}
