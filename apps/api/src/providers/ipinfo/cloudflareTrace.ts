const TRACE_ENDPOINTS: Record<4 | 6, string> = {
  4: 'https://1.1.1.1/cdn-cgi/trace',
  6: 'https://[2606:4700:4700::1111]/cdn-cgi/trace',
};

export interface CloudflareTrace {
  ip: string;
  loc: string | null;
  colo: string | null;
  http: string | null;
  tls: string | null;
  warp: string | null;
  source: 'cloudflare-trace';
}

/**
 * Fetch `cdn-cgi/trace` over a literal IP so the address family is forced:
 * 1.1.1.1 for IPv4, 2606:4700:4700::1111 for IPv6 (both covered by the
 * Cloudflare certificate). Returns null on any failure.
 */
export async function fetchCloudflareTrace(
  family: 4 | 6,
  timeoutMs = 5_000,
): Promise<CloudflareTrace | null> {
  try {
    const res = await fetch(TRACE_ENDPOINTS[family], {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'netpulse/0.1' },
    });
    if (!res.ok) return null;
    const text = await res.text();
    const fields = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
      const idx = line.indexOf('=');
      if (idx > 0) fields.set(line.slice(0, idx), line.slice(idx + 1));
    }
    const ip = fields.get('ip');
    if (!ip) return null;
    return {
      ip,
      loc: fields.get('loc') ?? null,
      colo: fields.get('colo') ?? null,
      http: fields.get('http') ?? null,
      tls: fields.get('tls') ?? null,
      warp: fields.get('warp') ?? null,
      source: 'cloudflare-trace',
    };
  } catch {
    return null;
  }
}
