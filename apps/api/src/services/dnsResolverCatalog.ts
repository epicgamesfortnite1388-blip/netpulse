import type { DnsServerSpec } from '@netpulse/shared';

export interface DnsProviderGroup {
  id: string;
  name: string;
  description: string;
  homepage: string;
  resolvers: DnsServerSpec[];
  /** Regional/niche groups are listed in the catalog but excluded from the
   *  default benchmark set — opt in by selecting them in the UI. */
  regional?: boolean;
}

/**
 * When the entry data was verified against the provider's official
 * documentation (see `source`) on 2026-09-04.
 */
const VERIFIED_AT = 1_788_480_000_000;

export const DNS_PROVIDER_GROUPS: DnsProviderGroup[] = [
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    description: 'Fast anycast resolver with strict privacy commitments. 1.1.1.1 for Families variants block malware and adult content.',
    homepage: 'https://developers.cloudflare.com/1.1.1.1/',
    resolvers: [
      { id: 'cloudflare-1111', name: 'Cloudflare 1.1.1.1', category: 'standard', ipv4: '1.1.1.1', ipv6: '2606:4700:4700::1111', dohUrl: 'https://cloudflare-dns.com/dns-query', dotHost: 'cloudflare-dns.com', dnssec: true, kind: 'public', source: 'https://developers.cloudflare.com/1.1.1.1/setup/', verified: true, verifiedAt: VERIFIED_AT },
      { id: 'cloudflare-1001', name: 'Cloudflare 1.0.0.1 (secondary)', category: 'standard', ipv4: '1.0.0.1', ipv6: '2606:4700:4700::1001', dohUrl: 'https://cloudflare-dns.com/dns-query', dotHost: 'cloudflare-dns.com', dnssec: true, kind: 'public', source: 'https://developers.cloudflare.com/1.1.1.1/setup/', verified: true, verifiedAt: VERIFIED_AT },
      { id: 'cloudflare-security', name: 'Cloudflare 1.1.1.2 (blocks malware)', category: 'security', ipv4: '1.1.1.2', ipv6: '2606:4700:4700::1112', dohUrl: 'https://security.cloudflare-dns.com/dns-query', dotHost: 'security.cloudflare-dns.com', dnssec: true, kind: 'public', source: 'https://developers.cloudflare.com/1.1.1.1/setup/', verified: true, verifiedAt: VERIFIED_AT },
      { id: 'cloudflare-family', name: 'Cloudflare 1.1.1.3 (malware + adult)', category: 'family', ipv4: '1.1.1.3', ipv6: '2606:4700:4700::1113', dohUrl: 'https://family.cloudflare-dns.com/dns-query', dotHost: 'family.cloudflare-dns.com', dnssec: true, kind: 'public', source: 'https://developers.cloudflare.com/1.1.1.1/setup/', verified: true, verifiedAt: VERIFIED_AT },
    ],
  },
  {
    id: 'google',
    name: 'Google Public DNS',
    description: "Google's global anycast resolver. No content filtering on the standard endpoints.",
    homepage: 'https://developers.google.com/speed/public-dns/',
    resolvers: [
      { id: 'google-8888', name: 'Google 8.8.8.8', category: 'standard', ipv4: '8.8.8.8', ipv6: '2001:4860:4860::8888', dohUrl: 'https://dns.google/dns-query', dotHost: 'dns.google', dnssec: true, kind: 'public', source: 'https://developers.google.com/speed/public-dns/', verified: false },
      { id: 'google-8844', name: 'Google 8.8.4.4 (secondary)', category: 'standard', ipv4: '8.8.4.4', ipv6: '2001:4860:4860::8844', dohUrl: 'https://dns.google/dns-query', dotHost: 'dns.google', dnssec: true, kind: 'public', source: 'https://developers.google.com/speed/public-dns/', verified: false },
    ],
  },
  {
    id: 'quad9',
    name: 'Quad9',
    description: 'Security-focused resolver that blocks malicious domains. DNSSEC validating.',
    homepage: 'https://quad9.net/',
    resolvers: [
      { id: 'quad9-9999', name: 'Quad9 9.9.9.9 (blocks malware)', category: 'security', ipv4: '9.9.9.9', ipv6: '2620:fe::fe', dohUrl: 'https://dns.quad9.net/dns-query', dotHost: 'dns.quad9.net', dnssec: true, kind: 'public', source: 'https://quad9.net/service/service-providers/', verified: false },
      { id: 'quad9-149112', name: 'Quad9 149.112.112.112 (secondary)', category: 'security', ipv4: '149.112.112.112', ipv6: null, dohUrl: 'https://dns.quad9.net/dns-query', dotHost: 'dns.quad9.net', dnssec: true, kind: 'public', source: 'https://quad9.net/service/service-providers/', verified: false },
    ],
  },
  {
    id: 'adguard',
    name: 'AdGuard DNS',
    description: 'Ad/tracker-blocking DNS with unfiltered and family variants. Default endpoint filters ads and trackers.',
    homepage: 'https://adguard-dns.io/en/public-dns.html',
    resolvers: [
      { id: 'adguard-default', name: 'AdGuard 94.140.14.14 (default, blocks ads/trackers)', category: 'privacy', ipv4: '94.140.14.14', ipv6: '2a10:50c0::ad1:ff', dohUrl: 'https://dns.adguard-dns.com/dns-query', dotHost: 'dns.adguard-dns.com', dnssec: true, kind: 'public', source: 'https://adguard-dns.io/en/public-dns.html', verified: true, verifiedAt: VERIFIED_AT },
      { id: 'adguard-unfiltered', name: 'AdGuard 94.140.14.140 (non-filtering)', category: 'unfiltered', ipv4: '94.140.14.140', ipv6: '2a10:50c0::1:ff', dohUrl: null, dotHost: 'unfiltered.adguard-dns.com', dnssec: true, kind: 'public', source: 'https://adguard-dns.io/en/public-dns.html', verified: true, verifiedAt: VERIFIED_AT },
      { id: 'adguard-family', name: 'AdGuard 94.140.14.15 (family protection)', category: 'family', ipv4: '94.140.14.15', ipv6: '2a10:50c0::bad1:ff', dohUrl: null, dotHost: 'family.adguard-dns.com', dnssec: true, kind: 'public', source: 'https://adguard-dns.io/en/public-dns.html', verified: true, verifiedAt: VERIFIED_AT },
    ],
  },
  {
    id: 'opendns',
    name: 'OpenDNS / Cisco',
    description: 'Cisco-owned resolver with optional content filtering. FamilyShield blocks adult content.',
    homepage: 'https://www.opendns.com/setupguide/',
    resolvers: [
      { id: 'opendns-home', name: 'OpenDNS 208.67.222.222', category: 'standard', ipv4: '208.67.222.222', ipv6: null, dohUrl: 'https://doh.opendns.com/dns-query', dotHost: 'doh.opendns.com', dnssec: false, kind: 'public', source: 'https://www.opendns.com/setupguide/', verified: false },
      { id: 'opendns-home2', name: 'OpenDNS 208.67.220.220 (secondary)', category: 'standard', ipv4: '208.67.220.220', ipv6: null, dohUrl: 'https://doh.opendns.com/dns-query', dotHost: 'doh.opendns.com', dnssec: false, kind: 'public', source: 'https://www.opendns.com/setupguide/', verified: false },
      { id: 'opendns-family', name: 'OpenDNS FamilyShield (adult blocking)', category: 'family', ipv4: '208.67.222.123', ipv6: null, dohUrl: 'https://doh.opendns.com/dns-query', dotHost: 'doh.opendns.com', dnssec: false, kind: 'public', source: 'https://www.opendns.com/setupguide/', verified: false },
    ],
  },
  {
    id: 'cleanbrowsing',
    name: 'CleanBrowsing',
    description: 'Free DNS filters blocking adult content, malware and phishing. Family/Adult/Security variants.',
    homepage: 'https://cleanbrowsing.org/filters',
    resolvers: [
      { id: 'cleanbrowsing-family', name: 'CleanBrowsing Family Filter', category: 'family', ipv4: '185.228.168.168', ipv6: '2a0d:2a00:1::', dohUrl: 'https://doh.cleanbrowsing.org/doh/family-filter/', dotHost: 'family-filter-dns.cleanbrowsing.org', dnssec: false, kind: 'public', source: 'https://cleanbrowsing.org/filters', verified: true, verifiedAt: VERIFIED_AT, note: 'Secondary address 185.228.169.168; secondary IPv6 2a0d:2a00:2::' },
      { id: 'cleanbrowsing-adult', name: 'CleanBrowsing Adult Filter', category: 'family', ipv4: '185.228.168.10', ipv6: '2a0d:2a00:1::1', dohUrl: 'https://doh.cleanbrowsing.org/doh/adult-filter/', dotHost: 'adult-filter-dns.cleanbrowsing.org', dnssec: false, kind: 'public', source: 'https://cleanbrowsing.org/filters', verified: true, verifiedAt: VERIFIED_AT, note: 'Secondary address 185.228.169.11; secondary IPv6 2a0d:2a00:2::1' },
      { id: 'cleanbrowsing-security', name: 'CleanBrowsing Security Filter', category: 'security', ipv4: '185.228.168.9', ipv6: '2a0d:2a00:1::2', dohUrl: 'https://doh.cleanbrowsing.org/doh/security-filter/', dotHost: 'security-filter-dns.cleanbrowsing.org', dnssec: false, kind: 'public', source: 'https://cleanbrowsing.org/filters', verified: true, verifiedAt: VERIFIED_AT, note: 'Secondary address 185.228.169.9; secondary IPv6 2a0d:2a00:2::2' },
    ],
  },
  {
    id: 'controld',
    name: 'Control D',
    description: 'Privacy DNS with free filtering profiles. Plain DNS listed; DoH/DoT endpoints require a registered profile for full function.',
    homepage: 'https://controld.com/',
    resolvers: [
      { id: 'controld-standard', name: 'Control D 76.76.2.0 (unfiltered)', category: 'unfiltered', ipv4: '76.76.2.0', ipv6: '2606:1a40::', dohUrl: null, dotHost: null, dnssec: false, kind: 'public', source: 'https://controld.com/', verified: false },
      { id: 'controld-security', name: 'Control D 76.76.10.0 (blocks malware)', category: 'security', ipv4: '76.76.10.0', ipv6: '2606:1a40:10::', dohUrl: null, dotHost: null, dnssec: false, kind: 'public', source: 'https://controld.com/', verified: false },
      { id: 'controld-family', name: 'Control D 76.76.100.0 (family)', category: 'family', ipv4: '76.76.100.0', ipv6: '2606:1a40:100::', dohUrl: null, dotHost: null, dnssec: false, kind: 'public', source: 'https://controld.com/', verified: false },
    ],
  },
  {
    id: 'dnssb',
    name: 'DNS.SB',
    description: 'Privacy-focused anycast DNS. Only the base unfiltered address is bundled; variant addresses were not re-verified.',
    homepage: 'https://dns.sb/',
    resolvers: [
      { id: 'dnssb-standard', name: 'DNS.SB 185.222.222.222 (unfiltered)', category: 'standard', ipv4: '185.222.222.222', ipv6: null, dohUrl: 'https://dns.sb/dns-query', dotHost: 'dns.sb', dnssec: true, kind: 'public', source: 'https://dns.sb/', verified: false },
    ],
  },
  {
    id: 'mullvad',
    name: 'Mullvad DNS',
    description: 'Minimal privacy DNS. Public queries are served over DoH/DoT only (plaintext UDP addresses exist solely inside a Mullvad tunnel).',
    homepage: 'https://mullvad.net/en/help/dns-over-https-and-dns-over-tls',
    resolvers: [
      { id: 'mullvad-standard', name: 'Mullvad dns.mullvad.net (no filtering)', category: 'privacy', ipv4: null, ipv6: null, dohUrl: 'https://dns.mullvad.net/dns-query', dotHost: 'dns.mullvad.net', dnssec: true, kind: 'public', source: 'https://mullvad.net/en/help/dns-over-https-and-dns-over-tls', verified: false, note: 'Plain DNS is only available through a Mullvad VPN tunnel — benchmarks use DoH/DoT.' },
    ],
  },
  {
    id: 'wikimedia',
    name: 'Wikimedia DNS',
    description: 'Encrypted DNS operated by the Wikimedia Foundation. DoH-first; plaintext is supported but discouraged.',
    homepage: 'https://wikimedia-dns.org/',
    resolvers: [
      { id: 'wikimedia-dns', name: 'Wikimedia DNS 185.71.138.138', category: 'privacy', ipv4: '185.71.138.138', ipv6: null, dohUrl: 'https://wikimedia-dns.org/dns-query', dotHost: null, dnssec: true, kind: 'public', source: 'https://wikimedia-dns.org/', verified: false },
    ],
  },
  {
    id: 'nextdns',
    name: 'NextDNS',
    description: 'Customizable privacy DNS with per-profile filtering. Requires a registered profile before queries are served.',
    homepage: 'https://nextdns.io/',
    resolvers: [
      { id: 'nextdns-profile', name: 'NextDNS (profile required)', category: 'privacy', ipv4: null, ipv6: null, dohUrl: null, dotHost: null, dnssec: true, kind: 'public', source: 'https://nextdns.io/', verified: false, skipBenchmarkReason: 'NextDNS only answers for registered profiles. Create one at nextdns.io and add its endpoint as a custom resolver.' },
    ],
  },
  {
    id: 'iran',
    name: 'Iranian DNS (sanction resolvers)',
    description: "Operator-documented Iranian DNS services built to restore access to internationally-sanctioned services (most games geo-block Iranian IPs). They resolve blocked hostnames to reachable nodes, so from inside Iran they're typically the fastest resolvers for game services. From outside Iran they answer slowly or not at all — benchmarks report that honestly.",
    homepage: 'https://shecan.ir/',
    regional: true,
    resolvers: [
      { id: 'shecan-1', name: 'Shecan 178.22.122.100', category: 'standard', ipv4: '178.22.122.100', ipv6: null, dohUrl: null, dotHost: null, dnssec: false, kind: 'public', source: 'https://shecan.ir/', verified: true, verifiedAt: VERIFIED_AT, note: 'Iranian sanction-resolver for gamers; DNS-verified live on 2026-09-04.' },
      { id: 'shecan-2', name: 'Shecan 185.51.200.2 (secondary)', category: 'standard', ipv4: '185.51.200.2', ipv6: null, dohUrl: null, dotHost: null, dnssec: false, kind: 'public', source: 'https://shecan.ir/', verified: true, verifiedAt: VERIFIED_AT, note: 'Iranian sanction-resolver for gamers; DNS-verified live on 2026-09-04.' },
      { id: 'begzar-1', name: 'Begzar 185.55.226.26', category: 'standard', ipv4: '185.55.226.26', ipv6: null, dohUrl: null, dotHost: null, dnssec: false, kind: 'public', source: 'https://begzar.ir/', verified: true, verifiedAt: VERIFIED_AT, note: 'Iranian sanction-resolver; DNS-verified live on 2026-09-04. Begzar also lists 185.55.225.25 and 185.55.224.24 as alternates.' },
      { id: 'begzar-2', name: 'Begzar 185.55.225.25 (secondary)', category: 'standard', ipv4: '185.55.225.25', ipv6: null, dohUrl: null, dotHost: null, dnssec: false, kind: 'public', source: 'https://begzar.ir/', verified: true, verifiedAt: VERIFIED_AT, note: 'Iranian sanction-resolver alternate; did not answer from this test network (may be Iran-only).' },
    ],
  },
];

/** Every resolver across all provider groups. */
export function allResolvers(): DnsServerSpec[] {
  return DNS_PROVIDER_GROUPS.flatMap((g) => g.resolvers);
}

/** Resolvers that can actually be benchmarked (have at least one transport target). */
export function benchmarkableResolvers(): DnsServerSpec[] {
  return allResolvers().filter(benchmarkable);
}

/** Curated default benchmark set: the first benchmarkable resolver of each
 *  non-regional provider group. Regional groups (e.g. Iranian DNS) stay opt-in
 *  so a default benchmark from elsewhere is not polluted by them. */
export function primaryResolvers(): DnsServerSpec[] {
  const seen = new Set<string>();
  const out: DnsServerSpec[] = [];
  for (const group of DNS_PROVIDER_GROUPS) {
    if (group.regional) continue;
    for (const r of group.resolvers) {
      if (!seen.has(group.id) && benchmarkable(r)) {
        out.push(r);
        seen.add(group.id);
        break;
      }
    }
  }
  return out;
}

export function benchmarkable(spec: DnsServerSpec): boolean {
  return !spec.skipBenchmarkReason && (Boolean(spec.ipv4) || Boolean(spec.dohUrl) || Boolean(spec.dotHost));
}

export function providerById(id: string): DnsServerSpec | null {
  for (const group of DNS_PROVIDER_GROUPS) {
    for (const r of group.resolvers) {
      if (r.id === id) return r;
    }
  }
  return null;
}

export function providerGroup(id: string): DnsProviderGroup | null {
  return DNS_PROVIDER_GROUPS.find((g) => g.id === id) ?? null;
}
