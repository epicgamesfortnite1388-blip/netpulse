/**
 * Iran Connectivity Intelligence — shared models.
 *
 * The feature measures, classifies, compares and recommends which connection
 * (direct vs. a VPN profile) works best for services commonly used from Iran.
 * Filtering is always an *inference* from measurements, never an assertion,
 * and every assessment carries a confidence + evidence list.
 */

export type ConnectivityCategory =
  | 'Search'
  | 'Social'
  | 'Messaging'
  | 'Developer'
  | 'Cloud'
  | 'AI'
  | 'Video'
  | 'Streaming'
  | 'Gaming'
  | 'Education'
  | 'News'
  | 'Productivity'
  | 'Finance'
  | 'Open Source'
  | 'Software Distribution'
  | 'Maps'
  | 'Email'
  | 'CDN'
  | 'Infrastructure';

/** Data-driven catalog entry — logic never lives in React components. */
export interface ConnectivityTarget {
  id: string;
  name: string;
  category: ConnectivityCategory;
  hostnames: string[];
  /** HTTPS URLs used for HTTP-stage probing (lightweight requests only). */
  urls?: string[];
  /** Known ports to TCP-probe, e.g. [443]. Never scanned arbitrarily. */
  expectedProtocols?: string[];
  /** Primary probe port (443 unless the catalog says otherwise). */
  port?: number;
  region?: string;
  /** Documentation/registration source for this entry. */
  source?: string;
  verifiedAt?: number;
  /** true for user-added targets (validated, SSRF-guarded). */
  custom?: boolean;
}

/* ------------------------------ probe stages ------------------------------ */

export interface IranDnsProbe {
  ok: boolean;
  latencyMs: number | null;
  resolver: string | null;
  a: string[] | null;
  aaaa: string[] | null;
  cname: string[] | null;
  rcode: string | null;
  nxdomain: boolean;
  error: string | null;
}

export interface IranTcpProbe {
  ok: boolean;
  latencyMs: number | null;
  port: number;
  family: 4 | 6 | null;
  error: string | null;
}

export interface IranTlsProbe {
  ok: boolean;
  latencyMs: number | null;
  tlsVersion: string | null;
  authorized: boolean | null;
  error: string | null;
}

export interface IranHttpProbe {
  ok: boolean;
  latencyMs: number | null;
  status: number | null;
  redirectChain: string[];
  contentType: string | null;
  error: string | null;
}

export interface IranRouteHopAsn {
  hop: number;
  asn: number | null;
  org: string | null;
  country: string | null;
}

export interface IranRouteProbe {
  ok: boolean;
  hops: number;
  /** distinct ASNs crossed (deduped, in order) */
  asnPath: IranRouteHopAsn[];
  latencyMs: number | null;
  note: string | null;
}

/* --------------------------- classification ------------------------------ */

export type ConnectivityState =
  | 'Reachable'
  | 'Partially Reachable'
  | 'DNS Failure'
  | 'TCP Blocked'
  | 'TLS Failure'
  | 'HTTP Blocked'
  | 'HTTP Error'
  | 'Timeout'
  | 'Connection Reset'
  | 'Routing Failure'
  | 'IPv4 Only'
  | 'IPv6 Only'
  | 'VPN Only'
  | 'Direct Only'
  | 'Endpoint Unavailable'
  | 'Unknown';

export type ConnectivityAssessment =
  | 'Likely Reachable'
  | 'Likely Filtered'
  | 'Possible Filtering'
  | 'Network Failure'
  | 'Service Failure'
  | 'Insufficient Evidence';

export type IranConfidence = 'High' | 'Medium' | 'Low' | 'Unknown';

/** Evidence-based classification of one measurement. */
export interface IranClassification {
  state: ConnectivityState;
  assessment: ConnectivityAssessment;
  confidence: IranConfidence;
  /** human-readable evidence lines backing the classification */
  evidence: string[];
}

/* ----------------------------- measurements ------------------------------ */

export interface IranScoreBreakdown {
  reachability: number;
  latency: number;
  stability: number;
  tls: number;
  route: number;
  total: number;
}

export interface ConnectivityMeasurement {
  sessionId: string;
  targetId: string;
  connectionId: string;
  connectionName: string;
  /** repeats actually executed for this cell */
  samples: number;
  startedAt: number;
  durationMs: number;
  dns: IranDnsProbe | null;
  tcp: IranTcpProbe | null;
  tls: IranTlsProbe | null;
  http: IranHttpProbe | null;
  route: IranRouteProbe | null;
  classification: IranClassification;
  /** transparent 0-100 score; null when nothing was measurable */
  score: IranScoreBreakdown | null;
}

/** Connection context snapshot (no secrets, redactable). */
export interface IranConnectionSnapshot {
  id: string;
  name: string;
  mode: 'direct' | 'vpn';
  publicIp: string | null;
  isp: string | null;
  asn: number | null;
  country: string | null;
  vpnServerName: string | null;
  vpnProtocol: string | null;
  vpnEndpoint: string | null;
}

export interface IranSessionSummary {
  /** 0-100 composite over tested connections */
  healthScore: number;
  /** targets reachable on at least one tested connection */
  reachable: number;
  total: number;
  possibleFiltering: number;
  networkFailures: number;
  unavailableServices: number;
  bestConnectionId: string | null;
  bestConnectionName: string | null;
}

export interface IranSession {
  id: string;
  kind: 'interactive' | 'scheduled';
  status: 'running' | 'done' | 'error';
  error: string | null;
  startedAt: number;
  completedAt: number | null;
  connections: IranConnectionSnapshot[];
  targetIds: string[];
  /** progress 0-100 while running */
  progress: number;
  summary: IranSessionSummary | null;
  measurements: ConnectivityMeasurement[];
}

/** Direct-vs-VPN comparison matrix row (populated from real measurements). */
export interface IranMatrixRow {
  targetId: string;
  name: string;
  category: ConnectivityCategory;
  cells: {
    connectionId: string;
    connectionName: string;
    state: ConnectivityState;
    latencyMs: number | null;
    score: number | null;
  }[];
}

/** A recommendation for a target or a category, backed by evidence. */
export interface IranRecommendation {
  targetId: string | null;
  targetName: string | null;
  category: ConnectivityCategory | null;
  connectionId: string;
  connectionName: string;
  reason: string;
  evidence: string[];
  confidence: IranConfidence;
  score: number | null;
}

/** A detected change between historical measurements (personal history, not a blocklist). */
export interface IranIncident {
  id: string;
  targetId: string;
  targetName: string;
  type: 'became-unreachable' | 'recovered' | 'dns-changed' | 'route-changed' | 'latency-increased' | 'vpn-became-less-reliable';
  severity: 'info' | 'warn' | 'critical';
  message: string;
  observedAt: number;
}

export interface IranReport {
  sessionId: string;
  generatedAt: number;
  connection: IranConnectionSnapshot | null;
  targetResults: {
    targetId: string;
    name: string;
    state: ConnectivityState;
    assessment: ConnectivityAssessment;
    confidence: IranConfidence;
    latencyMs: number | null;
    score: number | null;
  }[];
  recommendations: IranRecommendation[];
  privacy: { publicIpRedacted: boolean; hostnamesRedacted: boolean };
}