import type { HealthScore } from './network';
import type { SpeedTestResult } from './speed';
import type { RouteAnalysis, TraceResult } from './route';
import type { DnsBenchmarkRow, DnsLeakResult } from './dns';

/* ---------------------------------- MTU ---------------------------------- */

export interface MtuProbeResult {
  /** largest unfragmented payload size found (IP packet bytes) */
  mtu: number | null;
  /** common path: 1500 ethernet, 1492 PPPoE, 1480/1460 tunnels */
  probablePath: string | null;
  testedAt: number;
  error?: string;
}

/* --------------------------------- CGNAT --------------------------------- */

export interface CgnatResult {
  detected: boolean;
  publicIp: string | null;
  cgnatRangeHit: boolean | null;
  explanation: string;
  testedAt: number;
}

/* ------------------------------ Bufferbloat ------------------------------ */

export type BufferbloatGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface BufferbloatResult {
  idleLatencyMs: number | null;
  downloadLoadLatencyMs: number | null;
  uploadLoadLatencyMs: number | null;
  downloadIncreaseMs: number | null;
  uploadIncreaseMs: number | null;
  grade: BufferbloatGrade | null;
  explanation: string | null;
  testedAt: number;
  error?: string;
}

/* ------------------------------- Stability ------------------------------- */

export interface StabilitySample {
  t: number;
  latencyMs: number | null;
  jitterMs: number | null;
  lossPct: number | null;
  dnsMs: number | null;
  online: boolean;
}

export interface StabilityStatus {
  running: boolean;
  intervalMs: number;
  startedAt: number | null;
  samples: StabilitySample[];
}

/* --------------------------- Complete diagnostic ------------------------- */

export interface DiagnosticStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'error';
  detail?: string;
}

export interface DiagnosticFinding {
  severity: 'info' | 'good' | 'warn' | 'error';
  title: string;
  message: string;
}

export interface DiagnosticReport {
  testId: string;
  startedAt: number;
  finishedAt: number | null;
  steps: DiagnosticStep[];
  health: HealthScore;
  findings: DiagnosticFinding[];
  ip: {
    ipv4: string | null;
    ipv6: string | null;
    isp: string | null;
    asn: string | null;
    country: string | null;
    city: string | null;
  } | null;
  speed: SpeedTestResult | null;
  dns: DnsBenchmarkRow[] | null;
  dnsLeak: DnsLeakResult | null;
  route: (TraceResult & { analysis: RouteAnalysis }) | null;
  bufferbloat: BufferbloatResult | null;
  mtu: MtuProbeResult | null;
  cgnat: CgnatResult | null;
}
