import type { IpFamily } from './common';

/* ------------------------------ targets ---------------------------------- */

export type NetworkTargetType = 'internet' | 'dns' | 'game' | 'cloudflare' | 'vpn' | 'vps' | 'custom';

export interface NetworkTarget {
  id: string;
  type: NetworkTargetType;
  name: string;
  host: string;
  /** Destination port only when actually configured — never invented. */
  port?: number | null;
  /** 'tcp' | 'udp' | 'tls' | 'https' | 'dns' | 'wg' — the configured protocol. */
  protocol?: string | null;
  expectedRegion?: string | null;
  family?: IpFamily | 'auto';
  /** Where this target came from (catalog entry / profile / user input / scan). */
  source?: string | null;
}

/* ------------------------------ geography -------------------------------- */

export type GeoSource = 'known-endpoint' | 'provider-metadata' | 'geoip' | 'user-defined' | 'unknown';
export type GeoConfidenceLevel = 'high' | 'medium' | 'low' | 'unknown';

export interface GeoConfidence {
  source: GeoSource;
  confidence: GeoConfidenceLevel;
  /** human-readable qualification, e.g. "Approximate location", "Known endpoint" */
  label: string;
}

export interface MapGeo {
  lat: number;
  lon: number;
  city: string | null;
  country: string | null;
  countryCode: string | null;
  confidence: GeoConfidence;
}

/* ------------------------------ observation ------------------------------ */

export interface MapHop {
  hop: number;
  ip: string | null;
  hostname: string | null;
  latencyMs: number | null;
  packetLoss: number | null;
  asn: number | null;
  org: string | null;
  country: string | null;
  status: 'ok' | 'no_response' | 'anonymous';
  /** null = geography unknown — the map renders it unplaced, never guesses. */
  geo: MapGeo | null;
}

export interface MapMeasurement {
  /** how the number was actually produced */
  method: 'tcp' | 'tls' | 'https' | 'dns' | 'icmp';
  /** wire protocol of the probe (tcp/udp) */
  protocol: string;
  /** port used; null when the probe has no port (e.g. ICMP) */
  port: number | null;
  /** median latency of the successful samples */
  latencyMs: number | null;
  samples: number;
  minMs: number | null;
  avgMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  jitterMs: number | null;
  lossPct: number | null;
  ok: boolean;
  error?: string;
}

export type MapEndpointStatus = 'excellent' | 'good' | 'fair' | 'poor' | 'unreachable' | 'unknown';

export interface MapObservation {
  id: string;
  target: NetworkTarget;
  family: IpFamily | null;
  resolvedIp: string | null;
  protocol: string;
  port: number | null;
  vpnActive: boolean;
  vpnLabel: string | null;
  createdAt: number;
  durationMs: number | null;
  hops: MapHop[];
  measurements: MapMeasurement[];
  status: MapEndpointStatus;
  statusLabel: string;
  note: string | null;
  insights: string[];
}

/* ------------------------------- helpers --------------------------------- */

export interface LatencySummary {
  samples: number;
  minMs: number | null;
  avgMs: number | null;
  medianMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  jitterMs: number | null;
}

/** Summarize raw latency samples (ms). 0 / missing samples are dropped. */
export function summarizeLatencies(values: number[]): LatencySummary {
  const v = values.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (v.length === 0) {
    return { samples: values.length, minMs: null, avgMs: null, medianMs: null, p95Ms: null, maxMs: null, jitterMs: null };
  }
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  const median = v[Math.floor(v.length / 2)] ?? null;
  const p95 = v[Math.min(v.length - 1, Math.ceil(v.length * 0.95) - 1)] ?? null;
  const variance = v.reduce((a, b) => a + (b - avg) ** 2, 0) / v.length;
  const jitter = Math.round(Math.sqrt(variance) * 100) / 100;
  const r = (n: number | null): number | null => (n == null ? null : Math.round(n * 100) / 100);
  return {
    samples: v.length,
    minMs: r(v[0] ?? null),
    avgMs: r(avg),
    medianMs: r(median),
    p95Ms: r(p95),
    maxMs: r(v[v.length - 1] ?? null),
    jitterMs: r(jitter),
  };
}

/** The ASN sequence of an observation's responsive hops (deduplicated runs). */
export function asnPath(observation: Pick<MapObservation, 'hops'>): (number | null)[] {
  const path: (number | null)[] = [];
  for (const hop of observation.hops) {
    const asn = hop.asn ?? null;
    if (path.length === 0 || path[path.length - 1] !== asn) path.push(asn);
  }
  return path;
}

export interface RouteDiffResult {
  changed: boolean;
  changes: string[];
  previous: {
    createdAt: number;
    hops: number;
    latencyMs: number | null;
    asnPath: (number | null)[];
    resolvedIp: string | null;
    vpnActive: boolean;
  } | null;
  current: {
    createdAt: number;
    hops: number;
    latencyMs: number | null;
    asnPath: (number | null)[];
    resolvedIp: string | null;
    vpnActive: boolean;
  };
  latencyDeltaMs: number | null;
  insight: string | null;
}

/**
 * Compare two observations of the same target. Only reports what changed —
 * hop IPs, ASN path, destination address, address family or VPN state.
 * Latency deltas are reported with a measurement-noise caveat.
 */
export function diffObservations(current: MapObservation, previous: MapObservation | null): RouteDiffResult {
  const summarize = (o: MapObservation) => {
    const tcp = o.measurements.find((m) => m.method === 'tcp');
    return {
      createdAt: o.createdAt,
      hops: o.hops.length,
      latencyMs: tcp?.latencyMs ?? o.measurements[0]?.latencyMs ?? null,
      asnPath: asnPath(o),
      resolvedIp: o.resolvedIp,
      vpnActive: o.vpnActive,
    };
  };
  const cur = summarize(current);
  const prev = previous ? summarize(previous) : null;
  if (!prev) {
    return { changed: false, changes: [], previous: null, current: cur, latencyDeltaMs: null, insight: null };
  }

  const changes: string[] = [];
  if (prev.resolvedIp !== cur.resolvedIp && cur.resolvedIp != null) {
    changes.push(`Destination address changed from ${prev.resolvedIp ?? 'unknown'} to ${cur.resolvedIp}.`);
  }
  if (prev.vpnActive !== cur.vpnActive) {
    changes.push(cur.vpnActive ? 'Route now goes through the VPN tunnel.' : 'Route is no longer going through the VPN tunnel.');
  }
  const prevPath = prev.asnPath.filter((a): a is number => a != null).join(' → ');
  const curPath = cur.asnPath.filter((a): a is number => a != null).join(' → ');
  if (prevPath !== curPath) {
    changes.push(prevPath && curPath ? `ASN path changed from ${prevPath} to ${curPath}.` : 'The ASN path changed.');
  }
  const prevHops = prev.hops;
  const curHops = cur.hops;
  if (prevHops !== curHops && changes.length === 0) {
    changes.push(`Hop count changed from ${prevHops} to ${curHops}.`);
  }

  let latencyDeltaMs: number | null = null;
  if (prev.latencyMs != null && cur.latencyMs != null) {
    latencyDeltaMs = Math.round((cur.latencyMs - prev.latencyMs) * 10) / 10;
  }
  let insight: string | null = null;
  if (changes.length > 0 && latencyDeltaMs != null) {
    insight =
      latencyDeltaMs === 0
        ? 'The route changed but median latency is unchanged.'
        : latencyDeltaMs > 0
          ? `Median latency increased by ${latencyDeltaMs} ms after the route change (single measurements — treat as indicative).`
          : `Median latency decreased by ${Math.abs(latencyDeltaMs)} ms after the route change (single measurements — treat as indicative).`;
  } else if (changes.length === 0 && latencyDeltaMs != null && Math.abs(latencyDeltaMs) >= 5) {
    changes.push(`Median latency changed by ${latencyDeltaMs} ms with no route change observed.`);
    insight = 'Latency changed without a detectable route change — this can reflect congestion or load rather than a new path.';
  }
  return { changed: changes.length > 0, changes, previous: prev, current: cur, latencyDeltaMs, insight };
}

/* ------------------------- active connections ---------------------------- */

export interface MapConnectionRow {
  pid: number | null;
  process: string | null;
  protocol: 'tcp' | 'udp' | null;
  local: string;
  remote: string | null;
  state: string | null;
  remoteAsn: number | null;
  remoteOrg: string | null;
  remoteCountry: string | null;
  /** Latest measured RTT to this remote (ms), when the connection has been probed. */
  latencyMs?: number | null;
  /** Machine-facing remote address when known (helps the map place the node). */
  remoteIp?: string | null;
  /** ISO 3166 country code of the remote endpoint when known. */
  remoteCountryCode?: string | null;
}

/** One ranked result of a batched (server-side) game-server ping sweep. */
export interface MapSweepRow {
  target: NetworkTarget;
  resolvedIp: string | null;
  /** Primary latency: ICMP when it answered, else TCP-connect median. */
  latencyMs: number | null;
  /** Same sample quality as MapMeasurement (median of real probes). */
  jitterMs: number | null;
  lossPct: number | null;
  /** Which probe produced latencyMs. */
  method: 'icmp' | 'tcp' | 'tls' | 'https' | 'dns' | null;
  status: MapEndpointStatus;
  statusLabel: string;
  /** Server-side country of the resolved IP (Team Cymru), null when unknown. */
  country: string | null;
  error?: string | null;
}

export interface MapSweepResult {
  sweepId: string;
  /** What produced the numbers — labels the caveat that catalog hosts are service front doors. */
  sourceNote: string | null;
  startedAt: number;
  durationMs: number | null;
  rows: MapSweepRow[];
  /** null while running (poll until this is set). */
  completed: boolean;
  error?: string | null;
}

export interface MapLocalInfo {
  publicIp: string | null;
  latitude: number | null;
  longitude: number | null;
  city: string | null;
  countryCode: string | null;
  isp: string | null;
  vpn: { connected: boolean; providerId: string | null; serverName: string | null; protocol: string | null };
  geoConfidence: {
    source: GeoSource;
    confidence: GeoConfidenceLevel;
    label: string;
  } | null;
}