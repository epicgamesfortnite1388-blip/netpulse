/* ------------------------------ catalog ---------------------------------- */

export type GamingProbeProtocol = 'icmp' | 'tcp' | 'tls' | 'https';

export type GameEndpointPurpose = 'latency' | 'reachability' | 'service' | 'login' | 'matchmaking' | 'custom';

export interface GameEndpoint {
  hostname: string;
  protocol: GamingProbeProtocol;
  port?: number;
  region?: string;
  purpose: GameEndpointPurpose;
  /** True when the endpoint was verified against official documentation. */
  verified: boolean;
  /** Unix ms of the verification against the documented source. */
  verifiedAt?: number;
  /** URL of the official/operator documentation the entry is based on. */
  source?: string;
  /** Caveat or provenance note (e.g. community-documented host, DNS-verified live). */
  note?: string;
}

export interface GameRegion {
  id: string;
  name: string;
  code?: string;
}

export interface GameDefinition {
  id: string;
  name: string;
  publisher?: string;
  /** 'game' for a specific title, 'platform' for a service ecosystem (Steam, Battle.net, ...) */
  category: 'game' | 'platform';
  regions: GameRegion[];
  endpoints: GameEndpoint[];
  statusUrl?: string;
  /** Methodological caveat shown in the UI (e.g. endpoints are documented service hosts, not game servers). */
  note?: string;
}

/* ------------------------------ results ----------------------------------- */

export type ReachabilityStatus =
  | 'reachable'
  | 'service-reachable-icmp-blocked'
  | 'partial'
  | 'timeout'
  | 'dns-failure'
  | 'connection-refused'
  | 'unreachable'
  | 'unknown';

export type ProbeMethod = 'icmp-rtt' | 'tcp-connect' | 'tls-handshake' | 'http';

export interface GameEndpointResult {
  endpoint: GameEndpoint;
  resolvedIp: string | null;
  method: ProbeMethod;
  latencyMs: number | null;
  lossPct: number | null;
  jitterMs: number | null;
  tlsVersion: string | null;
  reachability: ReachabilityStatus;
  error: string | null;
}

export type RegionRankLabel = 'best-region' | 'second-best' | 'unstable' | 'not-recommended' | null;

export interface GameRegionResult {
  gameId: string;
  regionId: string;
  regionName: string;
  latencyMs: number | null;
  jitterMs: number | null;
  lossPct: number | null;
  /** 0-100; only when a latency value was measured */
  score: number | null;
  reachability: ReachabilityStatus;
  rank: number | null;
  rankLabel: RegionRankLabel;
  reason: string;
  endpoints: GameEndpointResult[];
}

export interface GamingTestResult {
  testId: string;
  gameId: string;
  gameName: string;
  startedAt: number;
  durationMs: number;
  regions: GameRegionResult[];
  /** Gaming score derived from the best-measured region + stability/bufferbloat inputs. */
  score: GamingScore | null;
  /** True when the test ran while a VPN tunnel was connected (probes went through it). */
  vpnActive: boolean;
  vpnProviderId?: string | null;
  vpnServerName?: string | null;
}

/* ------------------------------- score ------------------------------------ */

export type QualityBand = 'excellent' | 'good' | 'fair' | 'poor' | 'no-data';

export interface ScoreComponent {
  key: string;
  label: string;
  band: QualityBand;
  detail: string;
}

export interface GamingScore {
  score: number | null;
  components: ScoreComponent[];
}

/* ------------------------------ session ----------------------------------- */

export interface GamingSessionSample {
  ts: number;
  latencyMs: number | null;
  jitterMs: number | null;
  lossPct: number | null;
  online: boolean;
  publicIp: string | null;
  vpnActive: boolean;
}

export interface GamingSessionState {
  sessionId: string;
  gameId: string;
  startedAt: number;
  running: boolean;
  intervalMs: number;
  samples: GamingSessionSample[];
  events: { ts: number; message: string }[];
}

/* ------------------------------ comparisons ------------------------------- */

export type ComparisonMode = 'direct' | 'vpn';

export interface GamingComparisonRow {
  id: string;
  gameId: string;
  mode: ComparisonMode;
  serverName: string | null;
  latencyMs: number | null;
  jitterMs: number | null;
  lossPct: number | null;
  createdAt: number;
}

export interface GamingComparison {
  gameId: string;
  gameName: string;
  direct: GamingComparisonRow | null;
  vpn: GamingComparisonRow | null;
  winner: ComparisonMode | null;
  differenceMs: number | null;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}
