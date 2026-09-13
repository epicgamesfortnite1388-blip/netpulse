export type DnsTransport = 'udp' | 'doh' | 'dot';

export type DnsResolverCategory =
  | 'standard'
  | 'unfiltered'
  | 'privacy'
  | 'security'
  | 'family'
  | 'custom';

export interface DnsServerSpec {
  id: string;
  name: string;
  /** Primary IPv4 address (plain DNS). null when the provider has no public plaintext resolver. */
  ipv4: string | null;
  /** Primary IPv6 address (plain DNS). */
  ipv6: string | null;
  dohUrl: string | null;
  dotHost: string | null;
  dnssec: boolean;
  kind: 'public' | 'custom';
  category: DnsResolverCategory;
  /** Official documentation URL the entry was sourced from. */
  source?: string;
  /** True only when the entry was checked against its official source (see source/verifiedAt). */
  verified: boolean;
  /** Unix ms timestamp of the last verification against the official source. */
  verifiedAt?: number;
  /** When set, the resolver cannot be benchmarked directly (e.g. requires an account/profile); explains why. */
  skipBenchmarkReason?: string;
  /** Short human note (e.g. "secondary address 8.8.4.4"). */
  note?: string;
}

export type DnsQualityLabel = 'excellent' | 'good' | 'fair' | 'poor' | 'unreachable';

export interface DnsProviderMetrics {
  providerId: string;
  name: string;
  latencyMs: number | null;
  ok: boolean;
  /** null = not testable, false = DNSSEC validation failed or not advertised, true = validating */
  dnssec: boolean | null;
  transport: DnsTransport;
  status: DnsQualityLabel;
}

export interface DnsLeakResolver {
  ip: string;
  country: string | null;
  hostname: string | null;
  /** true = resolver matches the expected provider / ISP */
  expected: boolean;
}

export interface DnsLeakResult {
  leaked: boolean;
  resolvers: DnsLeakResolver[];
  explanation: string;
  testedAt: number;
}

/* ------------------------------- Benchmark ------------------------------- */

export interface DnsBenchmarkRow {
  providerId: string;
  name: string;
  transport: DnsTransport;
  queries: number;
  ok: number;
  timeouts: number;
  errors: number;
  latencyMinMs: number | null;
  latencyAvgMs: number | null;
  latencyMedianMs: number | null;
  latencyMaxMs: number | null;
  latencyP95Ms: number | null;
  jitterMs: number | null;
  reliabilityPct: number | null;
  status: DnsQualityLabel;
  /** 0-100, higher is better; null when the provider never answered */
  score: number | null;
  /** DNSSEC validation result (null = not tested), only meaningful for UDP/DoT transports */
  dnssec: boolean | null;
  /** True when an IPv6 plaintext probe to the resolver answered (null = not tested / no IPv6) */
  ipv6Ok?: boolean | null;
  /** True when the benchmark ran while a VPN tunnel was connected (traffic routed through it). */
  vpnActive?: boolean;
  error?: string;
}

export interface DnsBenchmarkResult {
  testId: string;
  startedAt: number;
  durationMs: number;
  queriesPerProvider: number;
  rows: DnsBenchmarkRow[];
}

/* ----------------------------- DNSSEC deep ------------------------------- */

export type DnssecDeepClassification = 'validating' | 'not-validating' | 'unreachable' | 'unknown';

export interface DnssecDeepResult {
  providerId: string;
  name: string;
  transport: 'udp';
  classification: DnssecDeepClassification;
  /** Deliberately broken zone (dnssec-failed.org): how the resolver answered. */
  brokenZone: 'servfail' | 'answered' | 'no-response' | 'error';
  /** Signed zone (iana.org) answered NOERROR (null when it did not answer). */
  signedNoError: boolean | null;
  /** Authenticated-data bit seen on the signed-zone response. */
  adBit: boolean | null;
  detail: string;
  testedAt: number;
}
