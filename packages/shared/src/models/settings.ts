import type { DnsServerSpec } from './dns';
import type { ScanProfileId } from './scanProfile';
import type { VpnBypassSettings } from './vpnBypass';

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

/**
 * User-adjustable type scale. The whole `--text-*` ramp is multiplied by this,
 * so every size on every page moves together and the hierarchy is preserved.
 *
 * `default` is 1x (the designed ramp, floor 12px). The larger steps exist for
 * high-DPI panels and for anyone who needs bigger type to read comfortably --
 * the app window has no browser zoom of its own, so without this the only way
 * to enlarge text is scaling the OS, which blurs a WebView2 surface.
 *
 * Capped at 125%: measured at a 1024px window, 150% overflowed the sidebar's
 * tracked uppercase section labels by 7px on every page, because em-based
 * letter-spacing grows with the text while the fixed-width nav column does
 * not. 125% keeps document overflow, offscreen boxes and clipped text at zero
 * on every route. Going higher needs the nav column to reflow, not a bigger
 * multiplier.
 */
export type TypeScaleSetting = 'default' | 'large' | 'xl';

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
    /** Multiplier applied to the whole type ramp; see TypeScaleSetting. */
    typeScale: TypeScaleSetting;
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
    /** Split-tunnel: destinations that bypass the tunnel and dial direct. */
    bypass: VpnBypassSettings;
    /** Discovery profile the one-click connect uses to find a working node. */
    scanProfile: ScanProfileId;
  };
  /** Public-node proxy-test core preference. */
  proxyEngine: {
    /**
     * 'auto' picks the first available engine (xray first for Reality/XTLS).
     * `hysteria` only ever dials hysteria2 nodes, so preferring it does not
     * change which core handles every other protocol.
     */
    preferred: 'auto' | 'sing-box' | 'xray' | 'v2ray' | 'hysteria';
  };
  /** Primary IP-geolocation provider with automatic failover. */
  geoProvider: {
    /** 'auto' = ipwho.is first, geojs.io on failure/rate-limit. */
    preferred: 'auto' | 'ipwho.is' | 'geojs.io';
  };
  /** Adaptive node auto-tester (bounded TCP-probe batches on a cadence). */
  automation: {
    autoTestNodes: {
      enabled: boolean;
      intervalMinutes: number;
    };
  };
  /**
   * Adaptive connectivity.
   *
   * `enabled` lets the engine ORDER the approved strategies from what it has
   * observed. It is on by default because with no stored evidence the engine
   * reproduces the previous order exactly (asserted in the policy tests), so a
   * fresh install behaves identically — and once there IS evidence, using it is
   * the whole point of the feature.
   *
   * `exploration` lets it spend part of an attempt budget trying a strategy that
   * is NOT expected to win, in order to learn. That is deliberately off: it is
   * the part that can cost the user a slower connect, so it is opt-in until the
   * replay evaluation says otherwise.
   */
  adaptive: {
    enabled: boolean;
    exploration: boolean;
  };
  scheduling: ScheduleSettings;
}
