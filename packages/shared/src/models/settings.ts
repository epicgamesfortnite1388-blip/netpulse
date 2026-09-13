import type { DnsServerSpec } from './dns';

export interface ScoreWeights {
  latency: number;
  packetLoss: number;
  jitter: number;
  throughput: number;
  routeQuality: number;
  load: number;
}

export type IpPreference = 'auto' | '4' | '6';

export type ThemeSetting = 'dark' | 'light' | 'system';

/** Recurring benchmark scheduling for the DNS Lab and Gaming sections. */
export interface ScheduleSettings {
  /** Run the DNS benchmark automatically every dnsIntervalMin minutes. */
  dnsEnabled: boolean;
  dnsIntervalMin: number;
  /** Run a gaming region test automatically every gamingIntervalMin minutes. */
  gamingEnabled: boolean;
  gamingIntervalMin: number;
  /** Game id to test; null = auto-pick the first catalog game. */
  gamingGameId: string | null;
  /** Periodic VPN tunnel dry-run self-test (no elevation, never changes state). */
  vpnSelfTestEnabled: boolean;
  vpnSelfTestIntervalMin: number;
}

/**
 * Result of one VPN tunnel dry-run self-test (server-side, not persisted).
 *
 * The check NEVER creates or modifies a tunnel: it verifies everything that can
 * be verified without elevation — engine availability, key-material integrity
 * for stored profiles, and reachability of the stored profile endpoints.
 */
export interface VpnSelfTestResult {
  /** ok = all checks passed; unavailable = engine/profiles missing (environmental); error = check itself failed */
  state: 'ok' | 'unavailable' | 'error';
  /** One line, safe for display: what was checked and what failed. */
  detail: string;
  /** Per-engine binary presence at check time. */
  engines: Record<string, boolean>;
  /** Number of stored profiles whose key material decrypted and validated. */
  profilesChecked: number;
  /** Stored profiles whose endpoint answered TCP within the budget. */
  endpointsReachable: number | null;
  checkedAt: number;
  tookMs: number;
}

/** Live state of one recurring benchmark (server-side, not persisted). */
export interface ScheduledRunStatus {
  enabled: boolean;
  intervalMin: number;
  running: boolean;
  lastRunAt: number | null;
  lastResult: 'ok' | 'error' | null;
  lastError: string | null;
  nextRunAt: number | null;
}

export interface ScheduleStatus {
  dns: ScheduledRunStatus;
  gaming: ScheduledRunStatus;
  /** Periodic VPN dry-run self-test (never touches tunnel state). */
  vpn: ScheduledRunStatus;
  updatedAt: number;
}

export interface AppSettings {
  general: {
    theme: ThemeSetting;
    language: string;
    units: 'metric' | 'imperial';
    notifications: boolean;
  };
  network: {
    ipPreference: IpPreference;
    /** DNS resolver id preferred for tests; null = system resolver */
    dnsPreference: string | null;
    testTimeoutMs: number;
    probes: number;
    /** User-added custom DNS resolvers, stored in settings */
    customResolvers: DnsServerSpec[];
  };
  diagnostics: {
    defaultTestTarget: string;
    pingCount: number;
    routeDepth: number;
    packetLossThresholdPct: number;
  };
  optimization: {
    weights: ScoreWeights;
    preferredRegions: string[];
    preferredProtocols: string[];
  };
  vpn: {
    killSwitch: boolean;
    autoConnect: boolean;
    autoSelectServer: boolean;
    dnsThroughVpn: boolean;
    ipv6Behavior: 'block' | 'allow' | 'auto';
  };
  /** Public-node proxy-test core preference. */
  proxyEngine: {
    /** 'auto' picks the first available engine (xray first for Reality/XTLS). */
    preferred: 'auto' | 'sing-box' | 'xray';
  };
  /** Adaptive node auto-tester (bounded TCP-probe batches on a cadence). */
  automation: {
    autoTestNodes: {
      enabled: boolean;
      intervalMinutes: number;
    };
  };
  scheduling: ScheduleSettings;
}
