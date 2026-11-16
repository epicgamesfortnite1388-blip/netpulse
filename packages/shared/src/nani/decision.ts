/**
 * NANI — calibrated success prediction, safe Thompson sampling and risk-aware
 * route scoring.
 *
 * Two rules dominate this module:
 *
 *  1. **Hard constraints before scoring.** Authorization, TLS verification and a
 *     risk ceiling filter candidates *before* any probability is computed. A fast
 *     unauthorized route is not a candidate at all — no weighting can rescue it.
 *  2. **Uncertainty is part of the number.** Selection uses a sampled posterior
 *     (Thompson) and the UI/planner can use a conservative lower bound; a point
 *     estimate from three observations is not treated as fact.
 *
 * The predictor is a Bayesian logistic model with a diagonal Laplace posterior.
 * It is intentionally modest: with tens of observations per context, a
 * well-calibrated linear model beats an opaque one, and it can be audited.
 */

import type { RouteCandidate, RouteFeatures, RouteScoreWeights } from './types';
import { DEFAULT_ROUTE_WEIGHTS } from './types';

/* ------------------------------ numerics --------------------------------- */

/** Numerically stable logistic function. */
export function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

/** Deterministic PRNG (mulberry32) so tests can assert exact choices. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller, driven by an injected uniform source. */
export function randn(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* --------------------------- Bayesian logistic --------------------------- */

export interface LogisticPrediction {
  mean: number;
  /** Predictive standard deviation of the logit. */
  sigma: number;
  probability: number;
  /** Lower confidence bound on the probability (z · sigma below the mean). */
  conservative: number;
}

/**
 * Online Bayesian logistic regression with a diagonal Laplace posterior.
 *
 * For each observation (φ, y):
 *   precision_i ← precision_i + p(1−p)·φ_i²
 *   w_i         ← w_i + (y − p)·φ_i / precision_i
 *   var_i       ← 1 / precision_i
 * which is the diagonal Newton/Laplace update, numerically stable because
 * p(1−p) ≥ 0 and precision is floored.
 */
export class BayesianLogistic {
  private readonly w: number[];
  private readonly precision: number[];
  private readonly priorPrecision: number;

  constructor(dimension: number, priorVariance = 9) {
    const n = Math.max(1, Math.floor(dimension));
    this.w = new Array(n).fill(0);
    this.precision = new Array(n).fill(1 / Math.max(1e-6, priorVariance));
    this.priorPrecision = 1 / Math.max(1e-6, priorVariance);
  }

  get dimension(): number {
    return this.w.length;
  }

  /** Posterior mean weights (read-only copy). */
  weights(): readonly number[] {
    return this.w;
  }

  private linear(phi: readonly number[]): { z: number; variance: number } {
    let z = 0;
    let variance = 0;
    for (let i = 0; i < this.w.length; i += 1) {
      const x = phi[i] ?? 0;
      z += (this.w[i] ?? 0) * x;
      variance += (1 / (this.precision[i] ?? this.priorPrecision)) * x * x;
    }
    return { z, variance };
  }

  predict(phi: readonly number[]): LogisticPrediction {
    const { z, variance } = this.linear(phi);
    const sigma = Math.sqrt(Math.max(0, variance));
    const probability = sigmoid(z);
    return {
      mean: z,
      sigma,
      probability,
      conservative: sigmoid(z - 1.64 * sigma),
    };
  }

  /** One online Laplace update. Returns the pre-update probability. */
  observe(phi: readonly number[], outcome: 0 | 1): number {
    const p = sigmoid(this.linear(phi).z);
    const varianceTerm = Math.max(1e-9, p * (1 - p));
    for (let i = 0; i < this.w.length; i += 1) {
      const x = phi[i] ?? 0;
      // Keep the prior from being erased by a single observation.
      const precision = Math.max(
        this.priorPrecision * 0.05,
        (this.precision[i] ?? this.priorPrecision) + varianceTerm * x * x,
      );
      this.precision[i] = precision;
      this.w[i] = (this.w[i] ?? 0) + ((outcome - p) * x) / precision;
    }
    return p;
  }

  /** Sample weights from the diagonal posterior and predict with them. */
  sampleProbability(phi: readonly number[], rng: () => number): number {
    let z = 0;
    for (let i = 0; i < this.w.length; i += 1) {
      const std = Math.sqrt(1 / (this.precision[i] ?? this.priorPrecision));
      z += ((this.w[i] ?? 0) + std * randn(rng)) * (phi[i] ?? 0);
    }
    return sigmoid(z);
  }
}

/* ---------------------------- hard constraints ---------------------------- */

export interface RouteConstraints {
  maxRisk: number;
  requireAuthorization: boolean;
  requireTls: boolean;
}

export const DEFAULT_ROUTE_CONSTRAINTS: RouteConstraints = {
  maxRisk: 0.5,
  requireAuthorization: true,
  requireTls: true,
};

/**
 * Filter by non-negotiable policy. Ordering is never allowed to override this.
 * Returns candidates plus a reason for each rejection, for the UI timeline.
 */
export function filterCandidates(
  candidates: readonly RouteCandidate[],
  constraints: RouteConstraints = DEFAULT_ROUTE_CONSTRAINTS,
): { allowed: RouteCandidate[]; rejected: Array<{ id: string; reason: string }> } {
  const allowed: RouteCandidate[] = [];
  const rejected: Array<{ id: string; reason: string }> = [];
  for (const c of candidates) {
    if (constraints.requireAuthorization && !c.authorized) {
      rejected.push({ id: c.id, reason: 'not authorized' });
      continue;
    }
    if (constraints.requireTls && !c.tlsVerification) {
      rejected.push({ id: c.id, reason: 'TLS verification disabled' });
      continue;
    }
    if (c.features.risk > constraints.maxRisk) {
      rejected.push({ id: c.id, reason: `risk ${c.features.risk.toFixed(2)} above ceiling` });
      continue;
    }
    allowed.push(c);
  }
  return { allowed, rejected };
}

/* ------------------------- safe Thompson selection ----------------------- */

export interface RouteSelection {
  candidate: RouteCandidate | null;
  probability: number;
  rejected: Array<{ id: string; reason: string }>;
}

/**
 * Thompson sampling restricted to the allowed set. Deterministic given `rng`,
 * so the same evidence + seed picks the same route.
 */
export function selectRoute(
  candidates: readonly RouteCandidate[],
  successModel: BayesianLogistic,
  options: {
    featuresOf: (c: RouteCandidate) => readonly number[];
    rng: () => number;
    constraints?: RouteConstraints;
    minProbability?: number;
  },
): RouteSelection {
  const { allowed, rejected } = filterCandidates(candidates, options.constraints);
  if (allowed.length === 0) return { candidate: null, probability: 0, rejected };

  let best: RouteCandidate | null = null;
  let bestP = -1;
  for (const c of allowed) {
    const p = successModel.sampleProbability(options.featuresOf(c), options.rng);
    if (p > bestP) {
      bestP = p;
      best = c;
    }
  }
  if (best && options.minProbability !== undefined && bestP < options.minProbability) {
    return { candidate: null, probability: bestP, rejected };
  }
  return { candidate: best, probability: Math.max(0, bestP), rejected };
}

/* -------------------------- risk-aware scoring --------------------------- */

/** Normalizers keep every term in [0, ~1]; they are documented, not magic. */
export const NORMALIZERS = {
  latencyMs: 1000,
  jitterMs: 300,
  recoveryMs: 10_000,
} as const;

const Z_95 = 1.6448536269514722;

/** Standard normal PDF. */
function phi(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

/**
 * Conditional Value-at-Risk (expected shortfall) of latency for a normal
 * approximation, at confidence `alpha` (e.g. 0.95):
 *   CVaR = μ + σ · φ(z_α) / (1 − α)
 * This penalises the bad tail instead of only the average.
 */
export function latencyCvar(features: RouteFeatures, alpha = 0.95): number {
  const a = Math.min(0.999, Math.max(0.5, alpha));
  const z = inverseNormal(a);
  const tail = phi(z) / (1 - a);
  return features.latencyMs + features.latencyStdMs * tail;
}

/** Acklam-style inverse normal approximation (sufficient for tail weighting). */
function inverseNormal(p: number): number {
  // Rational approximation; accurate to ~1e-4 for 0.5 ≤ p < 1.
  const t = Math.sqrt(-2 * Math.log(1 - p));
  const c0 = 2.515517;
  const c1 = 0.802853;
  const c2 = 0.010328;
  const d1 = 1.432788;
  const d2 = 0.189269;
  const d3 = 0.001308;
  return t - (c0 + c1 * t + c2 * t * t) / (1 + d1 * t + d2 * t * t + d3 * t * t * t);
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Multi-objective cost J(a) — lower is better:
 *   J = w_f(1−p) + w_l·CVaR/μ_ref + w_j·σ/σ_ref + w_p·loss
 *       + w_r·recovery/ref + w_c·resource + w_risk·risk
 *
 * `p` must already be a probability from the predictor. The caller decides
 * whether `p` is the mean or the conservative bound.
 */
export function routeCost(
  features: RouteFeatures,
  successProbability: number,
  weights: RouteScoreWeights = DEFAULT_ROUTE_WEIGHTS,
): number {
  const p = clamp01(successProbability);
  const latency = clamp01(latencyCvar(features) / NORMALIZERS.latencyMs);
  const jitter = clamp01(features.latencyStdMs / NORMALIZERS.jitterMs);
  const recovery = clamp01(features.recoveryMs / NORMALIZERS.recoveryMs);
  return (
    weights.failure * (1 - p) +
    weights.latency * latency +
    weights.jitter * jitter +
    weights.loss * clamp01(features.packetLoss) +
    weights.recovery * recovery +
    weights.resource * clamp01(features.resourceCost) +
    weights.risk * clamp01(features.risk)
  );
}

/** Rank allowed candidates by cost (lower first), stable on ties. */
export function rankByCost(
  candidates: readonly RouteCandidate[],
  probabilityOf: (c: RouteCandidate) => number,
  weights: RouteScoreWeights = DEFAULT_ROUTE_WEIGHTS,
): Array<{ candidate: RouteCandidate; cost: number }> {
  return candidates
    .map((candidate) => ({ candidate, cost: routeCost(candidate.features, probabilityOf(candidate), weights) }))
    .sort((a, b) => a.cost - b.cost);
}

export { Z_95 };
