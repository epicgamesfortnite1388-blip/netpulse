import type { ProxyEngineId } from './proxyEngine';
import type { ScanDepth, ScanProfileId } from './scanProfile';

/* ----------------------------- tunnel status ------------------------------ */

export type ProxyTunnelState = 'idle' | 'starting' | 'active' | 'down' | 'stopping';

/** How this tunnel's node was chosen — memory is never reported as a measurement. */
export type TunnelSource = 'explicit' | 'gateway-memory' | 'discovery' | 'auto';

/**
 * One hop of a nested (Aether-style two-core) tunnel. Every field is an
 * observation: `exitIp` is what a trace fetched THROUGH that hop reported, not
 * what the node claimed.
 */
export interface TunnelHop {
  nodeId: string;
  name: string | null;
  /** local core that ran this hop — the engine that actually carried traffic */
  engine: ProxyEngineId;
  host: string;
  port: number;
  /** exit IP observed through this hop alone (entry) / through the chain (exit) */
  exitIp: string | null;
  exitCountry: string | null;
  /** proxy port this hop's core listens on (loopback) */
  inboundPort: number;
}

/**
 * Nested-mode record. `exitDiffers` is the honest verdict of the comparison the
 * user asked for: false means both hops observed the SAME exit address, which
 * is reported rather than hidden.
 */
export interface TunnelChain {
  mode: 'nested';
  /** entry hop first, exit hop last — the order traffic traverses them */
  hops: TunnelHop[];
  /** entry hop's own observed exit IP, kept for the comparison */
  entryExitIp: string | null;
  /** final hop's observed exit IP */
  exitIp: string | null;
  exitDiffers: boolean;
  /** one-line honest reading of what was observed, shown verbatim */
  note: string;
}

export interface ProxyTunnelStatus {
  state: ProxyTunnelState;
  nodeId: string | null;
  /** node label (remarks) captured at start, for display */
  nodeName: string | null;
  engine: ProxyEngineId | null;
  /** loopback HTTP proxy port apps can be pointed at */
  inboundPort: number | null;
  /** OS system proxy routed through the tunnel? */
  systemProxy: boolean;
  /** system proxy restored to this value after disconnect (null = was direct) */
  previousProxy: string | null;
  /** verified by reading ip= from a trace fetched THROUGH the tunnel */
  exitIp: string | null;
  exitCountry: string | null;
  verifiedAt: number | null;
  startedAt: number | null;
  error: string | null;
  /** auto-reconnect attempts run since this tunnel came up */
  reconnectAttempts: number;
  /** attempts the current reconnect chain will make before giving up */
  reconnectLimit: number;
  source: TunnelSource | null;
  /** e.g. "3 domains, LAN" when split-tunnel rules are active, else null */
  bypass: string | null;
  /** null for a single-hop tunnel; set when two local cores are chained */
  chain: TunnelChain | null;
}

/* ------------------------------ discovery run ----------------------------- */

/** One candidate's outcome in a discovery run, at the profile's validated depth. */
export interface DiscoveryOutcome {
  nodeId: string;
  name: string | null;
  host: string;
  port: number;
  protocol: string;
  /**
   * Deepest probe that was RUN for this candidate. This is not a claim that it
   * succeeded: a failed candidate still records the depth it was probed at.
   * Only `failure === null` means that depth was actually reached.
   */
  depth: ScanDepth;
  /** latency of the probe that produced `depth`, ms */
  latencyMs: number | null;
  /** true only when the node provably carried a proxied request */
  carrying: boolean;
  /** failure classification when it did not pass, else null */
  failure: string | null;
}

export interface DiscoveryReport {
  profile: ScanProfileId;
  /** candidates actually probed (bounded by the profile) */
  probed: number;
  /** candidates that reached the profile's required depth */
  passed: number;
  outcomes: DiscoveryOutcome[];
  winner: DiscoveryOutcome | null;
  /** what was proven and what was not — displayed verbatim */
  summary: string;
  tookMs: number;
}

/* ------------------------------ quick connect ----------------------------- */

export interface QuickConnectAttempt {
  nodeId: string;
  name: string | null;
  /** endpoint, so an attempt is identifiable when the node has no remark */
  host: string;
  port: number;
  /** where this candidate came from: remembered gateway, or a fresh DB pick */
  source: 'memory' | 'database' | 'discovery';
  ok: boolean;
  error: string | null;
  exitIp: string | null;
  /** how long this attempt took (ms) */
  tookMs: number;
}

export interface QuickConnectResult {
  ok: boolean;
  /** discovery profile the internal scan actually ran — reported, not assumed */
  profile: ScanProfileId;
  /** attempts in the order they were made (bounded) */
  attempts: QuickConnectAttempt[];
  summary: string;
}

/* ------------------------- history dashboard (real rows) ------------------ */

/** One stored discovery run — the report exactly as it completed. */
export interface DiscoveryRunRecord {
  id: number;
  at: number;
  profile: ScanProfileId;
  probed: number;
  passed: number;
  tookMs: number;
  /** what the run was for: a direct scan, or the scan inside quick connect */
  origin: 'manual' | 'quick-connect';
  /** who triggered it, when known */
  trigger: 'user' | 'quick-connect' | 'scheduler';
  winner: { host: string; port: number; protocol: string; latencyMs: number | null } | null;
  summary: string;
}

/** Per-profile rollup over stored runs — every number a COUNT/AVG of stored rows. */
export interface DiscoveryProfileRollup {
  profile: ScanProfileId;
  runs: number;
  totalProbed: number;
  totalPassed: number;
  /** mean pass rate across runs (null when no runs) — computed, never asserted */
  meanPassRatePct: number | null;
  lastRunAt: number | null;
  /** validated depth of the last run that had a passing candidate */
  lastValidatedDepth: ScanDepth | null;
}

/** One stored quick-connect run with its attempts, for the timeline. */
export interface QuickConnectRunRecord {
  id: number;
  at: number;
  ok: boolean;
  profile: ScanProfileId;
  tried: number;
  /** source of the attempt that connected, when one did */
  winningSource: 'memory' | 'database' | 'discovery' | null;
  attempts: QuickConnectAttempt[];
  summary: string;
  tookMs: number;
}

/** Gateway reliability over time — one row per remembered gateway. */
export interface GatewayReliabilityRow {
  nodeId: string;
  name: string | null;
  host: string;
  port: number;
  protocol: string;
  engine: ProxyEngineId;
  exitCountry: string | null;
  successCount: number;
  failCount: number;
  successStreak: number;
  /** successCount / (successCount + failCount), null when nothing attempted */
  reliabilityPct: number | null;
  /** mean verifyMs across stored verifications, null when never measured */
  meanVerifyMs: number | null;
  lastVerifyMs: number | null;
  firstSeenAt: number;
  lastSuccessAt: number;
  lastAttemptAt: number;
  /** ISO date of the last verified exit — the newest proof this gateway works */
  lastVerifiedAt: number;
}

export interface VpnHistoryReport {
  generatedAt: number;
  discovery: {
    /** newest runs first, bounded */
    runs: DiscoveryRunRecord[];
    rollups: DiscoveryProfileRollup[];
  };
  quickConnect: {
    /** newest runs first, bounded */
    runs: QuickConnectRunRecord[];
    totalRuns: number;
    totalAttempts: number;
    /** runs that ended connected / runs attempted, null when no runs */
    successRatePct: number | null;
  };
  gateways: GatewayReliabilityRow[];
}
