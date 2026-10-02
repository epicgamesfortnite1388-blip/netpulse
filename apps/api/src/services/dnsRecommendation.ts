import type { DnsBenchmarkRow, DnsResolverCategory } from '@netpulse/shared';

export type DnsRecommendationProfile =
  | 'fastest'
  | 'reliable'
  | 'privacy'
  | 'security'
  | 'family'
  | 'gaming'
  | 'balanced';

export type Confidence = 'high' | 'medium' | 'low';

export interface DnsProviderMeta {
  providerId: string;
  name: string;
  category: DnsResolverCategory;
  /** provider-claimed DNSSEC support (used when a row was not measured) */
  dnssec: boolean;
  verified: boolean;
}

export interface DnsRecommendationEntry {
  rank: number | null;
  providerId: string;
  name: string;
  transport: 'udp' | 'doh' | 'dot';
  score: number | null;
  confidence: Confidence;
  /** short label like 'recommended' for the top pick */
  badge?: string;
  reasons: string[];
  row: DnsBenchmarkRow;
}

export interface DnsRecommendationResult {
  profile: DnsRecommendationProfile;
  profileLabel: string;
  generatedAt: number;
  entries: DnsRecommendationEntry[];
  note: string;
  /** True when the benchmark that feeds this recommendation ran through a VPN tunnel. */
  vpnActive: boolean;
  /** Server name of the tunnel (when vpnActive). */
  vpnServerName: string | null;
  /** Resolver the user currently prefers; null when unset. */
  currentProviderId: string | null;
}

type Factor = 'latency' | 'jitter' | 'reliability' | 'dnssec' | 'ipv6' | 'filterFit';

/** Profile weights (sum 100). filterFit = how well the resolver category matches the profile's intent. */
const PROFILE_WEIGHTS: Record<DnsRecommendationProfile, { label: string; w: Record<Factor, number>; intent: DnsResolverCategory[] }> = {
  fastest: { label: 'Fastest', w: { latency: 55, jitter: 20, reliability: 25, dnssec: 0, ipv6: 0, filterFit: 0 }, intent: [] },
  reliable: { label: 'Most reliable', w: { latency: 25, jitter: 15, reliability: 45, dnssec: 10, ipv6: 5, filterFit: 0 }, intent: [] },
  privacy: { label: 'Privacy', w: { latency: 20, jitter: 10, reliability: 20, dnssec: 20, ipv6: 10, filterFit: 20 }, intent: ['privacy', 'unfiltered'] },
  security: { label: 'Security', w: { latency: 15, jitter: 10, reliability: 30, dnssec: 20, ipv6: 5, filterFit: 20 }, intent: ['security'] },
  family: { label: 'Family', w: { latency: 10, jitter: 10, reliability: 25, dnssec: 10, ipv6: 5, filterFit: 40 }, intent: ['family'] },
  gaming: { label: 'Gaming', w: { latency: 45, jitter: 25, reliability: 25, dnssec: 5, ipv6: 0, filterFit: 0 }, intent: [] },
  balanced: { label: 'Balanced', w: { latency: 30, jitter: 20, reliability: 30, dnssec: 15, ipv6: 5, filterFit: 0 }, intent: [] },
};

function clamp100(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10));
}

function latencySub(latencyAvgMs: number): number {
  return clamp100(100 - latencyAvgMs * 1.5);
}

function jitterSub(jitterMs: number): number {
  return clamp100(100 - jitterMs * 8);
}

function reliabilitySub(row: DnsBenchmarkRow): number {
  return row.reliabilityPct ?? 0;
}

function dnssecSub(row: DnsBenchmarkRow, meta: DnsProviderMeta | undefined): number {
  const effective = row.dnssec ?? (meta?.dnssec === true ? true : null);
  if (effective === true) return 100;
  if (effective === false) return 30; // measured as not validating
  return 60; // unknown — neither punished nor rewarded
}

function ipv6Sub(row: DnsBenchmarkRow): number {
  if (row.ipv6Ok === true) return 100;
  if (row.ipv6Ok === false) return 40;
  return 60; // not tested
}

function filterFit(category: DnsResolverCategory, intent: DnsResolverCategory[]): number {
  if (intent.length === 0) return 100;
  return intent.includes(category) ? 100 : 0;
}

const CATEGORY_LABEL: Record<DnsResolverCategory, string> = {
  standard: 'standard resolver',
  unfiltered: 'unfiltered resolver',
  privacy: 'privacy resolver',
  security: 'security-filtering resolver',
  family: 'family-filtering resolver',
  custom: 'custom resolver',
};

function confidenceFor(row: DnsBenchmarkRow): Confidence {
  const samples = row.queries;
  if (samples >= 8 && row.ok === samples && (row.reliabilityPct ?? 0) === 100) return 'high';
  if (samples >= 4) return 'medium';
  return 'low';
}

function buildReasons(row: DnsBenchmarkRow, meta: DnsProviderMeta | undefined): string[] {
  const reasons: string[] = [];
  if (row.ok > 0) {
    reasons.push(`${row.ok}/${row.queries} queries answered`);
    if (row.latencyMedianMs != null) reasons.push(`median latency ${Math.round(row.latencyMedianMs)} ms`);
    if (row.latencyP95Ms != null) reasons.push(`p95 latency ${Math.round(row.latencyP95Ms)} ms`);
    if (row.jitterMs != null) reasons.push(`jitter ${Math.round(row.jitterMs * 10) / 10} ms`);
    if ((row.reliabilityPct ?? 0) >= 100) reasons.push('no timeouts observed');
    else if ((row.reliabilityPct ?? 0) > 0) reasons.push(`${100 - (row.reliabilityPct ?? 0)}% timeouts`);
    const dnssec = row.dnssec ?? (meta?.dnssec === true ? true : null);
    if (dnssec === true) reasons.push('DNSSEC validation confirmed');
    else if (dnssec === false) reasons.push('DNSSEC validation failed or not supported');
    if (row.ipv6Ok === true) reasons.push('IPv6 reachable');
    if (row.ipv6Ok === false) reasons.push('IPv6 endpoint did not answer');
  } else if (row.error) {
    reasons.push(`Error: ${row.error}`);
  } else {
    reasons.push('No response within the timeout');
  }
  if (meta) {
    reasons.push(`${CATEGORY_LABEL[meta.category]}${meta.verified ? '' : ' (entry not re-verified this session)'}`);
  }
  return reasons.slice(0, 6);
}

/**
 * Rank benchmark rows for a usage profile. Rows that never answered are kept
 * at the bottom with a null rank; rows with usable data are scored 0-100 and
 * ranked from best to worst. Only rows of the same transport should be passed
 * in for a meaningful comparison.
 */
export function recommendDns(opts: {
  rows: DnsBenchmarkRow[];
  profile: DnsRecommendationProfile;
  meta: Map<string, DnsProviderMeta>;
  /** The user's currently preferred resolver id; switch advice is guarded when set. */
  currentProviderId?: string | null;
  /** True when the rows were measured through an active VPN tunnel. */
  vpnActive?: boolean;
  /** Tunnel server name for labeling (when vpnActive). */
  vpnServerName?: string | null;
}): DnsRecommendationResult {
  const { rows, profile } = opts;
  const vpnActive = opts.vpnActive ?? rows.some((r) => r.vpnActive === true);
  const def = PROFILE_WEIGHTS[profile];
  const weights = def.w;

  const usable: DnsBenchmarkEntry[] = [];
  const unusable: DnsBenchmarkEntry[] = [];
  for (const row of rows) {
    const meta = opts.meta.get(row.providerId);
    const entry: DnsBenchmarkEntry = { row, meta };
    if (row.ok > 0 && row.latencyAvgMs != null) usable.push(entry);
    else unusable.push(entry);
  }

  const scored = usable
    .map((e) => {
      const row = e.row;
      const lat = latencySub(row.latencyAvgMs ?? 0);
      const jit = jitterSub(row.jitterMs ?? 0);
      const rel = reliabilitySub(row);
      const dns = dnssecSub(row, e.meta);
      const v6 = ipv6Sub(row);
      const fit = filterFit(e.meta?.category ?? 'custom', def.intent);
      const score = clamp100(
        (weights.latency * lat + weights.jitter * jit + weights.reliability * rel + weights.dnssec * dns + weights.ipv6 * v6 + weights.filterFit * fit) / 100,
      );
      return {
        row,
        meta: e.meta,
        score,
        reasons: buildReasons(row, e.meta),
        confidence: confidenceFor(row),
      };
    })
    .sort((a, b) => b.score - a.score);

  const entries: DnsRecommendationEntry[] = scored.map((s) => ({
    rank: 0,
    providerId: s.row.providerId,
    name: s.row.name,
    transport: s.row.transport,
    score: s.score,
    confidence: s.confidence,
    reasons: s.reasons,
    row: s.row,
  }));

  for (const u of unusable) {
    entries.push({
      rank: null,
      providerId: u.row.providerId,
      name: u.row.name,
      transport: u.row.transport,
      score: null,
      confidence: 'low',
      reasons: buildReasons(u.row, u.meta),
      row: u.row,
    });
  }

  // ranks: usable entries in score order (1 = best), unusable keep null
  scored.forEach((s, i) => {
    const entry = entries.find((e) => e.row === s.row);
    if (entry) entry.rank = i + 1;
  });
  const topEntry = entries.find((e) => e.rank === 1) ?? null;

  // switch guard: a switch away from the user's current resolver is only
  // recommended when the improvement exceeds the measured jitter (the noise
  // floor of the measurement), otherwise the 'recommended' badge is withheld
  // and the current resolver is marked keep-current.
  const currentProviderId = opts.currentProviderId ?? null;
  let switchNote: string | null = null;
  const current = scored.find((s) => matchesProvider(s.row.providerId, currentProviderId));
  const currentEntry = current ? entries.find((e) => e.row === current.row) ?? null : null;
  if (topEntry && current && topEntry.row.providerId !== current.row.providerId) {
    const improvementMs =
      current.row.latencyAvgMs != null && topEntry.row.latencyAvgMs != null
        ? current.row.latencyAvgMs - topEntry.row.latencyAvgMs
        : null;
    const noiseMs = Math.max(topEntry.row.jitterMs ?? 0, current.row.jitterMs ?? 0);
    const justified = improvementMs != null && improvementMs > noiseMs;
    if (justified) {
      topEntry.reasons.push(`Faster than your current resolver (${current.row.name}) by ${Math.round(improvementMs)} ms — beyond the measured jitter (${Math.round(noiseMs * 10) / 10} ms).`);
      topEntry.badge = 'recommended';
    } else {
      const because =
        improvementMs == null
          ? 'latency for the comparison could not be measured'
          : `the ${Math.round(improvementMs)} ms improvement is within the measured jitter (${Math.round(noiseMs * 10) / 10} ms)`;
      current.reasons.push(`No switch recommended: ${because}.`);
      if (currentEntry) currentEntry.badge = 'keep-current';
      switchNote = `Your current resolver (${current.row.name}) is not the top-ranked one, but switching is not recommended because the measured improvement does not exceed jitter.`;
    }
  } else if (topEntry) {
    topEntry.badge = 'recommended';
  }

  const minSamples = Math.min(...rows.map((r) => r.queries));
  const baseNote =
    rows.length === 0
      ? 'No benchmark data available yet — run a DNS test first.'
      : minSamples < 4
        ? 'Few samples per resolver — treat rankings as preliminary. Increase probe count for stronger confidence.'
        : scored.length >= 2 && scored[0]!.score - scored[1]!.score < 5
          ? 'Top picks are close — consider more probes before switching resolvers.'
          : 'Rankings are based on the latest completed benchmark.';
  const vpnNote = vpnActive
    ? `Measurements were taken through the active VPN tunnel${opts.vpnServerName ? ` (${opts.vpnServerName})` : ''} — numbers reflect the tunnel path, not your direct connection.`
    : 'Measurements were taken on the direct connection (no active VPN tunnel).';
  const note = [baseNote, vpnNote, switchNote].filter((n): n is string => n != null).join(' ');

  return {
    profile,
    profileLabel: def.label,
    generatedAt: Date.now(),
    entries,
    note,
    vpnActive,
    vpnServerName: vpnActive ? (opts.vpnServerName ?? null) : null,
    currentProviderId,
  };
}

/** Match a provider id (possibly transport-suffixed like `-doh`) against the user's preference. */
function matchesProvider(rowProviderId: string, currentProviderId: string | null): boolean {
  if (!currentProviderId) return false;
  if (rowProviderId === currentProviderId) return true;
  return rowProviderId.startsWith(`${currentProviderId}-`);
}

interface DnsBenchmarkEntry {
  row: DnsBenchmarkRow;
  meta: DnsProviderMeta | undefined;
}
