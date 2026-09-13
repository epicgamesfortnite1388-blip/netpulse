import type { ScoreWeights } from '../models/settings';

export const DEFAULT_WEIGHTS: ScoreWeights = {
  latency: 30,
  packetLoss: 20,
  jitter: 15,
  throughput: 20,
  routeQuality: 10,
  load: 5,
};

/** Latency quality, 0-100. Piecewise curve tuned for realistic broadband. */
export function latencyScore(ms: number): number {
  if (ms <= 10) return 100;
  if (ms <= 25) return 90;
  if (ms <= 50) return 75;
  if (ms <= 100) return 55;
  if (ms <= 150) return 40;
  if (ms <= 250) return 25;
  return Math.max(5, Math.floor(25 - (ms - 250) / 50));
}

export function lossScore(pct: number): number {
  if (pct <= 0) return 100;
  if (pct <= 0.5) return 90;
  if (pct <= 1) return 75;
  if (pct <= 2) return 55;
  if (pct <= 5) return 30;
  return Math.max(0, Math.floor(30 - (pct - 5) * 5));
}

export function jitterScore(ms: number): number {
  if (ms <= 1) return 100;
  if (ms <= 3) return 85;
  if (ms <= 5) return 70;
  if (ms <= 10) return 50;
  if (ms <= 20) return 30;
  return 10;
}

export function throughputScore(mbps: number): number {
  if (mbps >= 500) return 100;
  if (mbps >= 200) return 85;
  if (mbps >= 100) return 70;
  if (mbps >= 50) return 50;
  if (mbps >= 25) return 35;
  if (mbps >= 10) return 20;
  return 10;
}

/** Fewer hops = more direct path. */
export function hopScore(hops: number): number {
  if (hops <= 5) return 100;
  if (hops <= 10) return 90;
  if (hops <= 15) return 75;
  if (hops <= 20) return 60;
  if (hops <= 30) return 40;
  return 25;
}

/** Server load 0-100 (percent) -> quality. */
export function loadScore(loadPct: number): number {
  return Math.max(0, Math.min(100, 100 - loadPct));
}

/** Stability 0..1 (1 = perfectly stable across repeated runs). */
export function stabilityScore(stability: number): number {
  return Math.max(0, Math.min(100, stability * 100));
}

export interface WeightedComponents {
  latency?: number;
  packetLoss?: number;
  jitter?: number;
  throughput?: number;
  routeQuality?: number;
  load?: number;
}

export interface WeightedResult {
  score: number;
  /** components actually included in the calculation */
  measured: (keyof ScoreWeights)[];
}

/**
 * Weighted average over the components that were actually measured.
 * Unmeasured components are excluded and the remaining weights are
 * renormalized — a score is never padded with assumed values.
 */
export function weightedScore(components: WeightedComponents, weights: ScoreWeights): WeightedResult {
  let sum = 0;
  let weightSum = 0;
  const measured: (keyof ScoreWeights)[] = [];
  for (const key of Object.keys(DEFAULT_WEIGHTS) as (keyof ScoreWeights)[]) {
    const value = components[key];
    if (value === undefined || value === null || Number.isNaN(value)) continue;
    sum += value * weights[key];
    weightSum += weights[key];
    measured.push(key);
  }
  if (weightSum === 0) return { score: 0, measured: [] };
  return { score: Math.round(sum / weightSum), measured };
}

export type QualityLabel = 'Excellent' | 'Good' | 'Fair' | 'Poor';

export function labelFor(score: number): QualityLabel {
  if (score >= 85) return 'Excellent';
  if (score >= 70) return 'Good';
  if (score >= 50) return 'Fair';
  return 'Poor';
}

export interface RouteScoreInput {
  latencyMs?: number | null;
  jitterMs?: number | null;
  packetLossPct?: number | null;
  hops?: number | null;
  /** 0..1, from repeated runs; omit when unknown */
  stability?: number | null;
}

export interface ScoredRoute {
  score: number | null;
  label: QualityLabel | null;
  reasons: string[];
}

function routeQualityComponent(input: RouteScoreInput): number | undefined {
  const parts: number[] = [];
  if (input.hops != null) parts.push(hopScore(input.hops));
  if (input.stability != null) parts.push(stabilityScore(input.stability));
  if (parts.length === 0) return undefined;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

export function scoreRoute(input: RouteScoreInput, weights: ScoreWeights): ScoredRoute {
  const components: WeightedComponents = {
    latency: input.latencyMs != null ? latencyScore(input.latencyMs) : undefined,
    packetLoss: input.packetLossPct != null ? lossScore(input.packetLossPct) : undefined,
    jitter: input.jitterMs != null ? jitterScore(input.jitterMs) : undefined,
    routeQuality: routeQualityComponent(input),
  };
  const { score, measured } = weightedScore(components, weights);
  if (measured.length === 0) return { score: null, label: null, reasons: [] };

  const reasons: string[] = [];
  if (components.latency != null) {
    if (components.latency >= 85) reasons.push('Excellent latency');
    else if (components.latency <= 40) reasons.push('High latency');
  }
  if (input.packetLossPct === 0) reasons.push('Zero packet loss');
  else if (components.packetLoss != null && components.packetLoss <= 40) {
    reasons.push(`Packet loss ${input.packetLossPct}% exceeds healthy threshold`);
  }
  if (components.jitter != null) {
    if (components.jitter >= 85) reasons.push('Low jitter');
    else if (components.jitter <= 40) reasons.push('Unstable latency (high jitter)');
  }
  if (input.hops != null && input.hops <= 8) reasons.push('Direct path');
  if (input.stability != null && input.stability >= 0.95) reasons.push('Stable route');
  if (input.stability != null && input.stability < 0.8) reasons.push('Route varies between runs');

  return { score, label: labelFor(score), reasons };
}

export interface EndpointScoreInput {
  /** total establishment cost: tcp + tls (ms) */
  connectMs?: number | null;
  httpMs?: number | null;
  packetLossPct?: number | null;
}

export function scoreEndpoint(
  input: EndpointScoreInput,
  weights: ScoreWeights,
): { score: number | null; label: QualityLabel | null } {
  const latencyParts = [input.connectMs, input.httpMs].filter(
    (v): v is number => v != null,
  );
  const components: WeightedComponents = {
    latency: latencyParts.length > 0 ? latencyScore(Math.min(...latencyParts)) : undefined,
    packetLoss: input.packetLossPct != null ? lossScore(input.packetLossPct) : undefined,
  };
  const { score, measured } = weightedScore(components, weights);
  if (measured.length === 0) return { score: null, label: null };
  return { score, label: labelFor(score) };
}

export function dnsStatusForLatency(
  latencyMs: number | null,
  ok: boolean,
): 'excellent' | 'good' | 'fair' | 'poor' | 'unreachable' {
  if (!ok || latencyMs == null) return 'unreachable';
  if (latencyMs <= 15) return 'excellent';
  if (latencyMs <= 35) return 'good';
  if (latencyMs <= 60) return 'fair';
  return 'poor';
}
