import type { IpFamily } from './common';

export type RouteHopStatus = 'ok' | 'no_response' | 'anonymous';

export interface RouteHop {
  hop: number;
  ip: string | null;
  hostname: string | null;
  latencyMs: number | null;
  packetLoss: number | null;
  asn: number | null;
  org: string | null;
  country: string | null;
  status: RouteHopStatus;
}

export interface TraceResult {
  target: string;
  resolvedIp: string | null;
  family: IpFamily;
  hops: RouteHop[];
  totalHops: number;
  totalLatencyMs: number | null;
  durationMs?: number;
}

export interface RouteFinding {
  severity: 'info' | 'warn' | 'error';
  message: string;
}

export interface RouteAnalysis {
  score: number | null;
  label: string | null;
  findings: RouteFinding[];
}

export interface RouteCompareSide {
  label: string;
  target: string;
  resolvedIp: string | null;
  family: IpFamily | null;
  score: number | null;
  labelQuality: string | null;
  totalHops: number;
  totalLatencyMs: number | null;
  packetLossPct: number | null;
  trace: TraceResult | null;
  error?: string;
}

export interface RouteCompareResult {
  sides: RouteCompareSide[];
  /** index into sides[] of the recommended side, null when no clear winner */
  preferredIndex: number | null;
  explanation: string;
}

/** VPN state captured at the moment a route test ran. */
export interface RouteVpnTag {
  connected: boolean;
  /** tunnel provider id, e.g. 'wireguard' (null when disconnected) */
  providerId: string | null;
  /** public IP measured after connect by verifyConnect, when known */
  verifiedPublicIp: string | null;
}

/** One side of a direct-vs-VPN route comparison, built from stored traces. */
export interface VpnRouteCompareSide {
  testId: string;
  startedAt: number;
  trace: TraceResult;
  analysis: RouteAnalysis;
  lossPctAtDestination: number | null;
  vpn: RouteVpnTag;
}

/**
 * Before/after VPN route comparison assembled from REAL stored traceroutes:
 * the newest trace to the target taken while a tunnel was up, paired with the
 * newest trace to the SAME target taken while direct. No synthetic data —
 * when a side is missing the status says so instead of inventing one.
 */
export interface VpnRouteCompareResult {
  target: string;
  direct: VpnRouteCompareSide | null;
  vpn: VpnRouteCompareSide | null;
  /**
   * 'complete' — both sides present; 'unpaired_direct' / 'unpaired_vpn' —
   * only one side exists for this target; 'unavailable' — no traces at all.
   */
  status: 'complete' | 'unpaired_direct' | 'unpaired_vpn' | 'unavailable';
  /** human explanation of why a comparison is/isn't possible */
  note: string | null;
  /** delta metrics, present only when both sides exist */
  deltas: {
    latencyDeltaMs: number | null;
    hopsDelta: number | null;
    lossDeltaPct: number | null;
    scoreDelta: number | null;
    /** side with the better (higher) score, null when tied/unknown */
    preferred: 'direct' | 'vpn' | null;
    reason: string | null;
  } | null;
}
