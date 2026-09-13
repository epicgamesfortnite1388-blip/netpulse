import type { IpFamily } from './common';

export interface PingSample {
  seq: number;
  ok: boolean;
  ms: number | null;
  error?: string;
}

export interface PingStats {
  sent: number;
  received: number;
  lossPct: number;
  min: number | null;
  avg: number | null;
  max: number | null;
  median: number | null;
  jitterMs: number | null;
}

export interface PingResult extends PingStats {
  method: 'icmp' | 'tcp';
  target: string;
  resolvedIp: string | null;
  family: IpFamily | null;
  samples: PingSample[];
  durationMs: number;
  /** 'full' = per-sample latencies and statistics parsed; 'partial' = statistics only (localized output) */
  parseQuality: 'full' | 'partial';
}

export interface TcpProbeResult {
  ok: boolean;
  ms: number | null;
  error?: string;
}

export interface HealthComponent {
  component: string;
  label: string;
  /** raw measured value, if any */
  value: number | null;
  measured: boolean;
}

export interface HealthScore {
  score: number | null;
  label: string | null;
  components: HealthComponent[];
}

export interface NetworkStatus {
  online: boolean;
  checkedAt: number;
  latencyTcpMs: number | null;
  ipv4: { available: boolean; ip: string | null };
  ipv6: { available: boolean; ip: string | null };
  health: HealthScore;
}
