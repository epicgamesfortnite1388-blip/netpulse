import type { IpFamily } from './common';

export interface SpeedTestRequest {
  /** Cloudflare by default; extensible via SpeedTestProvider registry */
  provider?: string;
  downloadStreams?: number;
  uploadStreams?: number;
  /** per-direction measurement window, ms */
  durationMs?: number;
  family?: IpFamily;
}

export interface ThroughputSample {
  t: number;
  /** bytes transferred so far in this direction */
  bytes: number;
  /** instantaneous throughput estimate, Mbps */
  mbps: number;
}

export interface SpeedTestResult {
  downloadMbps: number | null;
  uploadMbps: number | null;
  pingMin: number | null;
  pingAvg: number | null;
  pingMax: number | null;
  pingMedian: number | null;
  jitterMs: number | null;
  packetLoss: number | null;
  /** latency measured under download load, for bufferbloat context */
  loadedLatencyMs: number | null;
  server: string;
  durationMs: number;
  downloadSamples: ThroughputSample[];
  uploadSamples: ThroughputSample[];
  error?: string;
  /**
   * Whether a VPN tunnel was routing traffic while this run executed, sampled
   * at the start and again at the end. A run that straddles a connect (the
   * state changed between the two samples) measures a MIX of direct and
   * tunneled traffic — the numbers are real but their meaning needs this
   * context; `connectedAtStart === connectedAtEnd === false` is a plain direct
   * measurement, both true is measured through the tunnel. Omitted (never
   * fabricated) when the tunnel state could not be sampled at all.
   */
  tunnel?: {
    connectedAtStart: boolean;
    connectedAtEnd: boolean;
    providerId: string | null;
  };
}
