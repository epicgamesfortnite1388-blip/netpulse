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
}
