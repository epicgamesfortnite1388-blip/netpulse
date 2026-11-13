/**
 * NANI — Bayesian failure diagnosis over a dynamic hypothesis set.
 *
 * Model (explicit, because a probability is only meaningful with its
 * assumptions stated):
 *
 *   Static step   P(H_i | E_1:t) ∝ P(E_t | H_i) · P(H_i | E_1:t-1)
 *
 *   Dynamic step  P(H_t | E_1:t) ∝ P(E_t | H_t) Σ_j P(H_t | H_(t-1)=j) P(H_(t-1)=j | E_1:t-1)
 *
 * The transition kernel is mean-reverting toward the prior:
 *   P(H_t = i | H_(t-1) = j) = (1 - ε)·[i = j] + ε·prior_i
 * so ε is the probability the world changed between observations. ε = 0 gives a
 * static Bayesian filter; ε = 1 forgets the past entirely.
 *
 * Evidence freshness: an observation is weighted by `0.5^(age / halfLife)` and
 * its reliability, and its likelihood is tempered toward uniform by that weight.
 * A stale observation therefore moves the posterior only weakly instead of being
 * either ignored or trusted as if it were new.
 *
 * Missing evidence: `skipped` and `unknown` observations are NOT failures. They
 * are excluded from the update entirely (they tell us nothing), which is the
 * distinction the brief requires between "not tested" and "tested and failed".
 */

import {
  DEFAULT_DIAGNOSIS_OPTIONS,
  NETWORK_HYPOTHESES,
  type DiagnosisOptions,
  type DiagnosisResult,
  type DiagnosticObservation,
  type DiagnosticTest,
  type HypothesisPosterior,
  type NetworkHypothesis,
  type ProbeOutcome,
} from './types';

const OUTCOMES: readonly ProbeOutcome[] = ['success', 'failure', 'timeout', 'skipped', 'unknown'];

/** Outcomes that carry no information about the network state. */
export function isInformative(outcome: ProbeOutcome): boolean {
  return outcome === 'success' || outcome === 'failure' || outcome === 'timeout';
}

/* ------------------------------ distributions ----------------------------- */

/** Uniform prior over every hypothesis. */
export function uniformPrior(): HypothesisPosterior {
  const p = 1 / NETWORK_HYPOTHESES.length;
  const out = {} as HypothesisPosterior;
  for (const h of NETWORK_HYPOTHESES) out[h] = p;
  return out;
}

/** Normalize a (possibly unnormalized) vector, applying the probability floor. */
export function normalize(
  distribution: HypothesisPosterior,
  floor = DEFAULT_DIAGNOSIS_OPTIONS.probabilityFloor,
): HypothesisPosterior {
  let total = 0;
  for (const h of NETWORK_HYPOTHESES) total += Math.max(floor, distribution[h] ?? 0);
  const out = {} as HypothesisPosterior;
  for (const h of NETWORK_HYPOTHESES) out[h] = Math.max(floor, distribution[h] ?? 0) / total;
  return out;
}

/** Shannon entropy in bits. */
export function entropyOf(distribution: HypothesisPosterior): number {
  let h = 0;
  for (const key of NETWORK_HYPOTHESES) {
    const p = distribution[key];
    if (p > 0) h -= p * Math.log2(p);
  }
  return h;
}

/** Mean-reverting dynamic transition toward the prior. */
export function transition(
  distribution: HypothesisPosterior,
  prior: HypothesisPosterior,
  epsilon: number,
): HypothesisPosterior {
  const e = Math.min(1, Math.max(0, epsilon));
  const out = {} as HypothesisPosterior;
  for (const h of NETWORK_HYPOTHESES) {
    out[h] = (1 - e) * distribution[h] + e * prior[h];
  }
  return normalize(out, 0);
}

/* --------------------------------- update --------------------------------- */

function temperedLikelihood(
  test: DiagnosticTest,
  hypothesis: NetworkHypothesis,
  outcome: ProbeOutcome,
  weight: number,
): number {
  const raw = test.likelihoods[hypothesis]?.[outcome] ?? 0;
  // With zero weight the observation is uninformative → uniform over outcomes.
  const uniform = 1 / OUTCOMES.length;
  const w = Math.min(1, Math.max(0, weight));
  return w * raw + (1 - w) * uniform;
}

/** Confidence multiplier for an observation's age and measurement quality. */
export function evidenceWeight(
  observation: DiagnosticObservation,
  now: number,
  halfLifeMs: number,
): number {
  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return 1;
  const age = Math.max(0, now - observation.at);
  const decay = Math.pow(0.5, age / halfLifeMs);
  const reliability = observation.reliability === undefined ? 1 : observation.reliability;
  return Math.min(1, Math.max(0, decay * reliability));
}

/**
 * Apply one likelihood update to an ALREADY transitioned distribution. Kept
 * separate from `updatePosterior` so information gain can score the test alone,
 * without crediting the entropy the transition would add anyway.
 */
function applyLikelihood(
  predicted: HypothesisPosterior,
  test: DiagnosticTest,
  outcome: ProbeOutcome,
  weight: number,
  options: DiagnosisOptions,
): HypothesisPosterior {
  const unnormalized = {} as HypothesisPosterior;
  for (const h of NETWORK_HYPOTHESES) {
    unnormalized[h] = predicted[h] * temperedLikelihood(test, h, outcome, weight);
  }
  return normalize(unnormalized, options.probabilityFloor);
}

/**
 * Bayesian update for a single observation. Returns the input posterior
 * unchanged when the outcome is uninformative or the test is unknown.
 */
export function updatePosterior(
  posterior: HypothesisPosterior,
  observation: DiagnosticObservation,
  test: DiagnosticTest | undefined,
  now: number,
  options: DiagnosisOptions = DEFAULT_DIAGNOSIS_OPTIONS,
): HypothesisPosterior {
  if (!test || !isInformative(observation.outcome)) return posterior;

  // Dynamic step first: between observations the cause may have changed.
  const predicted = transition(posterior, uniformPrior(), options.transitionProbability);
  const weight = evidenceWeight(observation, now, options.evidenceHalfLifeMs);
  return applyLikelihood(predicted, test, observation.outcome, weight, options);
}

/** Fold a chronologically sorted observation list into a final posterior. */
export function diagnose(
  observations: readonly DiagnosticObservation[],
  tests: readonly DiagnosticTest[],
  now: number,
  options: DiagnosisOptions = DEFAULT_DIAGNOSIS_OPTIONS,
): DiagnosisResult {
  const byId = new Map(tests.map((t) => [t.id, t]));
  let posterior = uniformPrior();
  let evidenceCount = 0;

  for (const obs of [...observations].sort((a, b) => a.at - b.at)) {
    const test = byId.get(obs.testId);
    if (!test || !isInformative(obs.outcome)) continue;
    posterior = updatePosterior(posterior, obs, test, now, options);
    evidenceCount += 1;
  }

  const entropy = entropyOf(posterior);
  const maxEntropy = Math.log2(NETWORK_HYPOTHESES.length);
  let top: NetworkHypothesis | null = null;
  let confidence = 0;
  for (const h of NETWORK_HYPOTHESES) {
    if (posterior[h] > confidence) {
      confidence = posterior[h];
      top = h;
    }
  }

  // One clear leader is needed for a diagnosis; a flat distribution is not one,
  // and a leader with little posterior mass is a guess. Both are rejected.
  const insufficientEvidence =
    evidenceCount === 0 || entropy > maxEntropy * 0.9 || confidence < options.minConfidence;
  const ranked = NETWORK_HYPOTHESES.map((h) => ({ hypothesis: h, probability: posterior[h] })).sort(
    (a, b) => b.probability - a.probability,
  );

  return {
    posterior,
    ranked,
    entropy,
    top: insufficientEvidence ? null : top,
    confidence,
    insufficientEvidence,
    evidenceCount,
  };
}

/* ------------------------- information-gain selection ---------------------- */

/**
 * Expected information gain of running `test`:
 *   IG = H(H | E) − E_o[ H(H | E, o) ]
 * where `P(o) = Σ_h P(h) P(o | h)`. Costs are applied separately so the caller
 * decides how to trade bits against time/risk.
 */
export function expectedInformationGain(
  posterior: HypothesisPosterior,
  test: DiagnosticTest,
  _now = Date.now(),
  options: DiagnosisOptions = DEFAULT_DIAGNOSIS_OPTIONS,
): number {
  // Assess the test against the *predicted* distribution (after the dynamic
  // step), and apply only the likelihood below. Otherwise the transition's own
  // entropy would be credited to every test, including a useless one.
  const predicted = transition(posterior, uniformPrior(), options.transitionProbability);
  const before = entropyOf(predicted);

  // Only observable outcomes matter; skipped/unknown carry no information.
  // Normalize P(o) so the expectation is valid even if the supplied likelihood
  // matrix does not sum exactly to 1 over outcomes.
  const outcomes = ['success', 'failure', 'timeout'] as const;
  const raw: number[] = outcomes.map((outcome) => {
    let p = 0;
    for (const h of NETWORK_HYPOTHESES) p += predicted[h] * temperedLikelihood(test, h, outcome, 1);
    return p;
  });
  const mass = raw.reduce((a, b) => a + b, 0);
  if (mass <= 0) return 0;

  let expectedAfter = 0;
  for (let i = 0; i < outcomes.length; i += 1) {
    const outcome = outcomes[i];
    if (outcome === undefined) continue;
    const pOutcome = (raw[i] ?? 0) / mass;
    if (pOutcome <= 0) continue;
    const post = applyLikelihood(predicted, test, outcome, 1, options);
    expectedAfter += pOutcome * entropyOf(post);
  }

  return Math.max(0, before - expectedAfter);
}

export interface TestChoice {
  test: DiagnosticTest;
  informationGain: number;
  /** `informationGain / max(cost, floor)` — bits per unit cost. */
  efficiency: number;
}

/**
 * Rank tests by bits-per-cost and return the best one. `exclude` lets the caller
 * avoid repeating tests it already ran. Returns `null` when nothing informative
 * remains.
 */
export function selectNextTest(
  posterior: HypothesisPosterior,
  tests: readonly DiagnosticTest[],
  exclude: ReadonlySet<string> = new Set(),
  now = Date.now(),
  options: DiagnosisOptions = DEFAULT_DIAGNOSIS_OPTIONS,
): TestChoice | null {
  let best: TestChoice | null = null;
  for (const test of tests) {
    if (exclude.has(test.id)) continue;
    const gain = expectedInformationGain(posterior, test, now, options);
    if (gain <= 1e-9) continue;
    const efficiency = gain / Math.max(0.05, test.cost);
    if (!best || efficiency > best.efficiency) best = { test, informationGain: gain, efficiency };
  }
  return best;
}

export { DEFAULT_DIAGNOSIS_OPTIONS };
