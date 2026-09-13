/* ------------------------------ config formats ------------------------------ */

export type NodeProtocol =
  | 'vless'
  | 'vmess'
  | 'trojan'
  | 'shadowsocks'
  | 'shadowsocksr'
  | 'hysteria2'
  | 'tuic'
  | 'wireguard'
  | 'unknown';

export type NodeTransport =
  | 'tcp'
  | 'ws'
  | 'grpc'
  | 'http'
  | 'quic'
  | 'udp'
  | 'reality'
  | 'none'
  | 'unknown';

export type NodeSecurity = 'none' | 'tls' | 'reality' | 'unknown';

export type NodeStatus =
  | 'discovered'
  | 'parsed'
  | 'validated'
  | 'tcp-tested'
  | 'proxy-tested'
  | 'healthy'
  | 'degraded'
  | 'failed'
  | 'stale'
  | 'removed';

export type NodeConfidence = 'high' | 'medium' | 'low' | 'unknown';

export type NodeQualityPreset =
  | 'fastest'
  | 'most-stable'
  | 'lowest-loss'
  | 'best-for-gaming'
  | 'best-for-video'
  | 'best-for-current-network'
  | 'best-ipv6'
  | 'best-route'
  | 'best-recently-verified'
  | 'most-sources'
  | 'newest';

export type NodeFilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in' | 'not-in';

export interface NodeFilter {
  field: string;
  op: NodeFilterOp;
  value: string | number | boolean | string[] | null;
}

export type NodeSortField =
  | 'proxyLatency'
  | 'tcpLatency'
  | 'tlsLatency'
  | 'packetLoss'
  | 'reliability'
  | 'successRate'
  | 'uptime'
  | 'country'
  | 'city'
  | 'asn'
  | 'isp'
  | 'protocol'
  | 'port'
  | 'transport'
  | 'tls'
  | 'reality'
  | 'ipv4'
  | 'ipv6'
  | 'source'
  | 'sourceCount'
  | 'firstSeen'
  | 'lastSeen'
  | 'stability'
  | 'score';

export type NodeSortDir = 'asc' | 'desc';

export interface NodeSort {
  field: NodeSortField;
  dir: NodeSortDir;
}

export type NodeLifecycle =
  | 'new'
  | 'discovered'
  | 'parsed'
  | 'validated'
  | 'tcp-tested'
  | 'proxy-tested'
  | 'healthy'
  | 'degraded'
  | 'failed'
  | 'stale'
  | 'removed';

export type NodeFreshness = 'fresh' | 'recent' | 'aging' | 'stale' | 'dead';

/* ------------------------------ public source ------------------------------ */

export type SourceType =
  | 'github_raw'
  | 'github_repo_index'
  | 'raw_file'
  | 'subscription_url'
  | 'website'
  | 'custom';

export type SourceStatus = 'idle' | 'fetching' | 'parsing' | 'importing' | 'healthy' | 'degraded' | 'failed' | 'rate-limited';

export type SourceHealth = 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';

export interface PublicSource {
  id: string;
  name: string;
  homepage?: string | null;
  repositoryUrl?: string | null;
  enabled: boolean;
  type: SourceType;
  urls: string[];
  formats: string[];
  /** minutes between fetches */
  intervalMinutes: number;
  lastFetch: number | null;
  lastSuccess: number | null;
  lastFailure: number | null;
  status: SourceStatus;
  discoveredConfigCount: number;
  importedConfigCount: number;
  duplicateCount: number;
  invalidCount: number;
  /** last 24h counts */
  recentDiscovered: number;
  recentImported: number;
  recentHealthy: number;
  health: SourceHealth;
  /** content hash of last successful fetch */
  lastContentHash: string | null;
  /** human notes */
  notes?: string | null;
  /** when the source was added */
  createdAt: number;
}

export interface SourceFetchRecord {
  id: string;
  sourceId: string;
  startedAt: number;
  finishedAt: number | null;
  url: string | null;
  status: 'running' | 'completed' | 'failed' | 'skipped';
  rawBytes: number | null;
  configCount: number;
  importedCount: number;
  duplicateCount: number;
  invalidCount: number;
  error: string | null;
  contentHash: string | null;
}

/* ------------------------------ raw document ------------------------------ */

export interface RawDocument {
  id: string;
  sourceId: string;
  fetchId: string;
  /** where in the source this came from */
  sourceUrl: string;
  /** original text (may be base64, URI, JSON, YAML, plain text) */
  originalText: string;
  /** SHA-256 of the original text */
  originalHash: string;
  /** detected format */
  detectedFormat: string;
  /** size in bytes */
  sizeBytes: number;
  /** parsing result */
  parsedAt: number | null;
  /** number of node URIs/configs extracted */
  configCount: number;
  error: string | null;
  fetchedAt: number;
}

/* ------------------------------ parsed + normalized node ------------------------------ */

export interface ParsedNodeConfig {
  /** protocol lowercase: vless, vmess, trojan, shadowsocks, shadowsocksr, hysteria2, tuic, wireguard, unknown */
  protocol: NodeProtocol;
  /** hostname or IP as advertised */
  host: string;
  /** port (normalized to default if omitted) */
  port: number;
  /** transport: tcp, ws, grpc, http, quic, udp, reality, none, unknown */
  transport: NodeTransport;
  /** security: none, tls, reality, unknown */
  security: NodeSecurity;
  /** TLS SNI if present */
  sni?: string | null;
  /** ALPN values if present */
  alpn?: string[] | null;
  /** TLS fingerprint/type if present (e.g. 'chrome', 'firefox', 'safari') */
  fingerprint?: string | null;
  /** VLESS flow if present */
  flow?: string | null;
  /** VMess alterId */
  alterId?: number | null;
  /** VMess security (auto/chacha20...) */
  vmessSecurity?: string | null;
  /** path for ws/grpc/http transport */
  path?: string | null;
  /** host header for ws */
  hostHeader?: string | null;
  /** grpc service name */
  serviceName?: string | null;
  /** TLS allowInsecure flag */
  allowInsecure?: boolean;
  /** encrypted password/type for SS/SSR */
  encryption?: string | null;
  /** SSR protocol */
  ssrProtocol?: string | null;
  /** extra SSR params */
  ssrParams?: string | null;
  /** Reality public key (base64) if present */
  realityPublicKey?: string | null;
  /** Reality shortId if present */
  realityShortId?: string | null;
  /** Reality serverName if present */
  realityServerName?: string | null;
  /** Hysteria2/sing-box specific params as JSON-safe map */
  extra?: Record<string, unknown> | null;
  /** user-facing remark/name if present (NOT used for fingerprint) */
  remark?: string | null;
  /** any extra display metadata */
  metadata?: Record<string, unknown> | null;
}

/** Canonical normalized fingerprint (connection parameters only, no credentials, no remark). */
export interface NodeFingerprint {
  protocol: NodeProtocol;
  hostLower: string;
  port: number;
  transport: NodeTransport;
  security: NodeSecurity;
  sni: string | null;
  alpn: string[];
  flow: string | null;
  alterId: number | null;
  path: string | null;
  hostHeader: string | null;
  serviceName: string | null;
  realityPublicKey: string | null;
  realityShortId: string | null;
  realityServerName: string | null;
  encryption: string | null;
  ssrProtocol: string | null;
}

/** One canonical public node. Connection secrets are stored in the vault, not here. */
export interface PublicNode {
  id: string;
  /** fingerprint hash (sha256 of canonical JSON) */
  canonicalFingerprint: string;
  /** protocol */
  protocol: NodeProtocol;
  /** resolved/current hostname */
  host: string;
  /** all resolved IPv4 addresses (from last DNS check) */
  ipv4: string[];
  /** all resolved IPv6 addresses */
  ipv6: string[];
  /** port */
  port: number;
  /** transport */
  transport: NodeTransport;
  /** security */
  security: NodeSecurity;
  /** TLS SNI */
  sni: string | null;
  /** ALPN */
  alpn: string[];
  /** TLS fingerprint */
  fingerprint: string | null;
  /** VLESS flow */
  flow: string | null;
  /** VMess alterId */
  alterId: number | null;
  /** path for ws/grpc */
  path: string | null;
  /** host header for ws */
  hostHeader: string | null;
  /** grpc service name */
  serviceName: string | null;
  /** allowInsecure */
  allowInsecure: boolean;
  /** Reality public key (only if user has configured vault access) */
  realityPublicKey: string | null;
  /** Reality shortId */
  realityShortId: string | null;
  /** Reality serverName */
  realityServerName: string | null;
  /** SS/SSR encryption */
  encryption: string | null;
  /** SSR protocol */
  ssrProtocol: string | null;
  /** display remark (from first source) */
  remark: string | null;
  /** source IDs where this node was found */
  sourceIds: string[];
  /** source URLs where this node was found */
  sourceUrls: string[];
  /** how many independent sources carry this node */
  sourceCount: number;
  /** first time seen (unix ms) */
  firstSeen: number;
  /** last time seen (unix ms) */
  lastSeen: number;
  /** last time validated/tested (unix ms) */
  lastValidated: number | null;
  /** current lifecycle status */
  status: NodeStatus;
  /** geo/ISP confidence */
  confidence: NodeConfidence;
  /** country code (2-letter) — may be inferred */
  country: string | null;
  /** city — may be inferred, never claimed as exact */
  city: string | null;
  /** ASN */
  asn: number | null;
  /** ISP/org name */
  isp: string | null;
  /** organization */
  organization: string | null;
  /** latitude (approx; null when unknown) */
  lat: number | null;
  /** longitude (approx; null when unknown) */
  lon: number | null;
  /** number of sources that claimed a geo for this node */
  geoSourceCount: number;
  /**
   * Why the node has (or lacks) a location: known = city-level GeoIP
   * evidence; anycast = multi-site IP, no single true location; edge_fabric =
   * GeoIP would return the provider's registry HQ, not the server;
   * lookup_failed = tried, no location established; pending = not attempted.
   */
  geoStatusReason: 'known' | 'anycast' | 'edge_fabric' | 'lookup_failed' | 'pending';
  /** user tags (favorite + custom tags) */
  tags: string[];
  /** star indicator */
  favorite: boolean;
  /** user-defined notes */
  userNotes: string | null;
  /** last successful proxy test latency (ms) */
  lastProxyMs: number | null;
  /** last IP-based geolocation attempt (epoch ms; null = never attempted) */
  geoLastAttempt: number | null;
  /** last successful TCP test latency (ms) */
  lastTcpMs: number | null;
  /** last successful TLS test latency (ms) */
  lastTlsMs: number | null;
  /** test counts for lifecycle tracking */
  testCount: number;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  /** recent 24h */
  recentTestCount: number;
  recentSuccessCount: number;
  recentFailureCount: number;
  /** overall score 0-100 */
  score: number;
  /** reachability % over recent tests */
  reliabilityPct: number;
  /** median proxy latency over recent tests (ms) */
  medianProxyMs: number | null;
  /** median TCP latency over recent tests (ms) */
  medianTcpMs: number | null;
  /** median TLS latency over recent tests (ms) */
  medianTlsMs: number | null;
  /** packet loss % over recent tests */
  recentLossPct: number;
  /** last successful test at */
  lastSuccessAt: number | null;
  /** last failure at */
  lastFailureAt: number | null;
  /** freshness classification */
  freshness: NodeFreshness;
  /** when this row was created in our DB */
  createdAt: number;
  /** when this row was last updated */
  updatedAt: number;
}

/* ---------- node addresses (for IP-first view + dedup tracking) ---------- */

export interface NodeAddress {
  nodeId: string;
  ip: string;
  family: 4 | 6;
  firstSeen: number;
  lastSeen: number;
}

/* ---------- node provenance (source → node) ---------- */

export interface NodeSource {
  nodeId: string;
  sourceId: string;
  /** URL within the source where this appeared */
  sourceUrl: string;
  /** original URI/config text (stored encrypted if it contains secrets) */
  sourceConfigRef: string;
  /** parser version that normalized this */
  parserVersion: string;
  /** normalized hash at import time */
  normalizedHash: string;
  /** when discovered */
  discoveredAt: number;
}

/* ---------- node test ---------- */

export type NodeTestType = 'tcp' | 'tls' | 'proxy' | 'icmp';

export type NodeTestStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'error';

export interface NodeTestResult {
  nodeId: string;
  type: NodeTestType;
  status: NodeTestStatus;
  /** unix ms when the test started */
  startedAt: number;
  finishedAt: number | null;
  /** connection/DNS time in ms, null on failure */
  latencyMs: number | null;
  /** for proxy tests: total request time */
  totalMs: number | null;
  /** negotiated TLS version for tls/proxy tests */
  tlsVersion: string | null;
  /** certificate authorized (when checked) */
  authorized: boolean | null;
  /** for proxy tests: HTTP status from test endpoint */
  httpStatus: number | null;
  /** for proxy tests: response body size */
  responseSize: number | null;
  /** error message when failed */
  error: string | null;
  /** probe family used */
  family: 4 | 6 | null;
  /** IP actually probed (resolved at test time) */
  probedIp: string | null;
  /** test endpoint used for proxy tests */
  testEndpoint: string | null;
  /** which local core produced a proxy result: xray | sing-box */
  engine: string | null;
}

/* ---------- node health (aggregated, recent window) ---------- */

export interface NodeHealth {
  nodeId: string;
  /** test count in the recent window */
  testCount: number;
  successCount: number;
  failureCount: number;
  /** success rate 0-100 */
  reliabilityPct: number;
  /** median latency in ms */
  medianLatencyMs: number | null;
  /** p95 latency in ms */
  p95LatencyMs: number | null;
  /** packet loss % */
  lossPct: number;
  /** latency variance (stddev) */
  latencyVariance: number | null;
  /** last successful test at */
  lastSuccessAt: number | null;
  /** last failure at */
  lastFailureAt: number | null;
  /** consecutive failures */
  consecutiveFailures: number;
  /** how long this node has been continuously healthy (ms; null if unknown) */
  healthyForMs: number | null;
  /** when this aggregate was computed */
  computedAt: number;
}

/* ---------- scan job ---------- */

export type ScanJobStatus = 'queued' | 'running' | 'paused' | 'completed' | 'cancelled' | 'error';

export interface ScanJob {
  id: string;
  name: string;
  kind: 'discover' | 'test' | 'deep-test' | 'health-check';
  status: ScanJobStatus;
  /** filter predicate encoded as JSON (null = all) */
  filter: string | null;
  /** selected node IDs when kind is targeted */
  nodeIds: string[];
  /** concurrency limit */
  concurrency: number;
  /** max tests per minute (rate limit) */
  maxPerMinute: number;
  /** progress 0-100 */
  progress: number;
  discovered: number;
  tested: number;
  healthy: number;
  degraded: number;
  failed: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  createdAt: number;
}

export interface ScanJobProgress {
  jobId: string;
  progress: number;
  tested: number;
  healthy: number;
  degraded: number;
  failed: number;
  pending: number;
  throughput: number;
  medianTcpMs: number | null;
  medianProxyMs: number | null;
}

/* ---------- test endpoint registry ---------- */

export interface TestEndpoint {
  id: string;
  name: string;
  url: string;
  /** expected HTTP status */
  expectedStatus: number;
  /** timeout ms */
  timeoutMs: number;
  /** max response bytes to read */
  maxBytes: number;
  /** whether to use this endpoint for proxy tests */
  enabled: boolean;
  /** when configured */
  createdAt: number;
}

/* ---------- recommendation ---------- */

export interface NodeRecommendation {
  nodeId: string;
  nodeHost: string;
  nodeProtocol: NodeProtocol;
  nodeTransport: NodeTransport;
  nodeCountry: string | null;
  nodeCity: string | null;
  proxyLatencyMs: number | null;
  tcpLatencyMs: number | null;
  tlsLatencyMs: number | null;
  lossPct: number;
  reliabilityPct: number;
  recentTests: number;
  recentSuccesses: number;
  score: number;
  confidence: NodeConfidence;
  reason: string;
  evidence: string[];
  /** why this node is recommended for the current user context */
  rationale: string;
}

export interface RankingResult {
  preset: NodeQualityPreset;
  context: {
    country?: string;
    asn?: number;
    ipv4: boolean;
    ipv6: boolean;
    vpnActive: boolean;
    directReliable: boolean;
    targetService?: string;
  };
  nodes: NodeRecommendation[];
  generatedAt: number;
}

/* ---------- event types ---------- */

export type NodeEventKind =
  | 'source.fetch.started'
  | 'source.fetch.completed'
  | 'source.fetch.failed'
  | 'source.changed'
  | 'node.discovered'
  | 'node.imported'
  | 'node.duplicate'
  | 'node.test.started'
  | 'node.test.completed'
  | 'node.test.failed'
  | 'node.status.changed'
  | 'scanner.progress'
  | 'scanner.completed'
  | 'scanner.failed'
  | 'recommendation.updated';

export interface NodeEvent {
  kind: NodeEventKind;
  at: number;
  payload: Record<string, unknown>;
}

/* ---------- vpn use payload ---------- */

export interface UseNodeRequest {
  nodeId: string;
  /** profile name to create/use */
  profileName?: string;
}

export interface UseNodeResult {
  success: boolean;
  profileId?: string;
  protocol?: NodeProtocol;
  error?: string;
  note?: string;
}

/* ---------- export formats ---------- */

export type ExportFormat = 'uri' | 'plaintext' | 'base64' | 'json' | 'clash' | 'singbox';

export interface NodeExport {
  format: ExportFormat;
  nodes: string[];
  exportedAt: number;
  count: number;
}

/* ---------- score breakdown (transparent) ---------- */

export interface NodeScoreBreakdown {
  latency: number;
  reliability: number;
  loss: number;
  stability: number;
  proxySuccess: number;
  uptime: number;
  route: number;
  compatibility: number;
  total: number;
  /** text labels per component */
  labels: Record<string, string>;
}

/* ---------- ip/geo cache for imported nodes ---------- */

export interface NodeGeoCache {
  ip: string;
  family: 4 | 6;
  country: string | null;
  city: string | null;
  asn: number | null;
  isp: string | null;
  organization: string | null;
  lat: number | null;
  lon: number | null;
  fetchedAt: number;
}
