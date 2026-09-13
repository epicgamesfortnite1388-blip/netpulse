export type EndpointStatus =
  | 'excellent'
  | 'good'
  | 'fair'
  | 'poor'
  | 'reachable'
  | 'unreachable'
  | 'untested';

export interface EndpointProbeResult {
  endpoint: string;
  port: number;
  family: 4 | 6 | null;
  tcpMs: number | null;
  tlsMs: number | null;
  httpMs: number | null;
  httpStatus: number | null;
  tlsError: string | null;
  icmpAvgMs: number | null;
  packetLoss: number | null;
  score: number | null;
  /** honest labels — never "clean" without a reputation source */
  status: EndpointStatus;
  label: string;
}

export interface ScanConfig {
  /** CIDR list or explicit host:port entries to test */
  cidrs: string[];
  ports: number[];
  /** concurrency cap (server clamps this) */
  concurrency: number;
  timeoutMs: number;
  maxCandidates: number;
}

export type ScanStatus = 'running' | 'completed' | 'cancelled' | 'error';

export interface ScanCandidate {
  endpoint: string;
  port: number;
  tcpMs: number | null;
  tlsMs: number | null;
  httpMs: number | null;
  httpStatus: number | null;
  ok: boolean;
  stage: 'discovered' | 'tcp' | 'tls' | 'http';
  /** Cloudflare edge colo code (e.g. FRA, IST) learned from /cdn-cgi/trace */
  colo: string | null;
  /** Two-letter country code of the serving edge, from trace `loc` */
  loc: string | null;
  /** Packet loss % across validation tries (0-100) */
  lossPct: number | null;
  /** Latency standard deviation across validation tries, ms */
  jitterMs: number | null;
  /** Download throughput through this endpoint, Mbps */
  downloadMbps: number | null;
  /** Time to first byte of the download probe, ms */
  ttfbMs: number | null;
  /** True once the shortlist validation ran on this endpoint */
  validated: boolean;
  /** SenPai-style health verdict: true when the endpoint can carry traffic */
  clean: boolean | null;
}

export interface ScanValidateRequest {
  /** Restrict to these candidate ids (defaults to the best alive by score) */
  candidateIds?: number[];
  /** Latency tries per endpoint (2-5, default 3) */
  tries?: number;
  /** Download sample size in bytes (1-50 MB, default 4 MB) */
  downloadBytes?: number;
  /** Concurrency cap (1-8, default 4) */
  concurrency?: number;
}

export interface ScanSummary {
  id: string;
  status: ScanStatus;
  config: ScanConfig;
  startedAt: number;
  finishedAt: number | null;
  discovered: number;
  tested: number;
  alive: number;
  error?: string;
}

export interface ScanCandidateRow extends ScanCandidate {
  id: number;
  scanId: string;
  icmpAvgMs: number | null;
  score: number | null;
  status: EndpointStatus;
  label: string;
  favorite: boolean;
}

export interface ScanProgress {
  type: 'scan:progress' | 'scan:candidate' | 'scan:done' | 'scan:error';
  scanId: string;
  tested?: number;
  total?: number;
  candidate?: ScanCandidateRow;
  message?: string;
}
