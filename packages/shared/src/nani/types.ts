/**
 * NANI — NetPulse Adaptive Network Intelligence: core evidence model.
 *
 * Everything here is a *pure data contract*. The intelligence is deterministic:
 * given the same observations and seed it produces the same diagnosis. No module
 * in this folder performs I/O, reads credentials, or opens sockets — probes are
 * supplied by the caller (see `apiHealth.ts` for the health-check contracts),
 * which keeps every decision unit-testable and replayable.
 *
 * House rule inherited from `adaptive/`: a hypothesis is a *belief*, never a
 * conclusion. Nothing here may claim censorship, successful connectivity or a
 * measured latency that a probe did not produce.
 */

/* ------------------------------- hypotheses ------------------------------- */

/**
 * Failure hypotheses the diagnoser reasons over. These are deliberately more
 * granular than `adaptive.FailureKind`: the API layer needs to distinguish an
 * authentication rejection from rate limiting, and a DNS failure from a routing
 * failure, because the correct response differs.
 */
export type NetworkHypothesis =
  | 'gateway'
  | 'dns'
  | 'dns-inconsistency'
  | 'routing'
  | 'ipv4'
  | 'ipv6'
  | 'tcp'
  | 'tls'
  | 'udp'
  | 'mtu'
  | 'congestion'
  | 'filtering'
  | 'remote-endpoint'
  | 'api-auth'
  | 'api-rate-limit'
  | 'application'
  | 'server'
  | 'unknown';

export const NETWORK_HYPOTHESES: readonly NetworkHypothesis[] = [
  'gateway',
  'dns',
  'dns-inconsistency',
  'routing',
  'ipv4',
  'ipv6',
  'tcp',
  'tls',
  'udp',
  'mtu',
  'congestion',
  'filtering',
  'remote-endpoint',
  'api-auth',
  'api-rate-limit',
  'application',
  'server',
  'unknown',
] as const;

/** Network layer a probe exercises. Each layer is observed independently. */
export type NetworkLayer = 'dns' | 'tcp' | 'tls' | 'http' | 'auth' | 'application';

/** Outcome of one probe. `unknown` and `skipped` are distinct from failure. */
export type ProbeOutcome = 'success' | 'failure' | 'timeout' | 'skipped' | 'unknown';

/**
 * A single diagnostic probe definition.
 *
 * `likelihoods` is `P(outcome | hypothesis)` — the numbers a domain expert (or a
 * calibration run over real measurements) supplies. They need not be exact: the
 * update tolerates miscalibration, and `metrics.ts` measures it.
 */
export interface DiagnosticTest {
  id: string;
  layer: NetworkLayer;
  /** Human label, shown verbatim in the diagnostics UI. */
  label: string;
  /** Relative cost in [0,1]: latency + resource + risk. Used by info-gain selection. */
  cost: number;
  /** `P(outcome | hypothesis)` for each hypothesis. */
  likelihoods: Record<NetworkHypothesis, Record<ProbeOutcome, number>>;
}

/** One observation of one test. */
export interface DiagnosticObservation {
  testId: string;
  outcome: ProbeOutcome;
  /** Epoch ms when measured. */
  at: number;
  /** 0..1 measurement quality (e.g. TLS-verified vs plain TCP). Default 1. */
  reliability?: number;
}

/* -------------------------------- diagnosis ------------------------------- */

/** A probability distribution over hypotheses; always sums to ~1. */
export type HypothesisPosterior = Record<NetworkHypothesis, number>;

export interface DiagnosisOptions {
  /** Evidence older than this is progressively discounted (ms). */
  evidenceHalfLifeMs: number;
  /**
   * Probability that the world changed between two observations (DBN
   * transition). 0 = static world; 0.05 = a 5% chance per step the failure
   * cause is replaced. Applied before each update.
   */
  transitionProbability: number;
  /** Floor applied to every posterior so no hypothesis becomes exactly 0. */
  probabilityFloor: number;
  /**
   * Minimum posterior mass for the leading hypothesis to be reported as a
   * diagnosis. Below this the answer is `insufficient evidence`, not a guess.
   * 0.25 is ~3.5× the uniform prior over 14 hypotheses and still lets a single
   * strong observation discriminate; a flat posterior never reaches it.
   */
  minConfidence: number;
}

export const DEFAULT_DIAGNOSIS_OPTIONS: DiagnosisOptions = {
  // 10 minutes: a network failure cause is rarely stable for much longer.
  evidenceHalfLifeMs: 10 * 60 * 1000,
  transitionProbability: 0.05,
  probabilityFloor: 1e-6,
  minConfidence: 0.25,
};

export interface RankedHypothesis {
  hypothesis: NetworkHypothesis;
  probability: number;
}

export interface DiagnosisResult {
  posterior: HypothesisPosterior;
  /** Every hypothesis, most probable first — shown even when uncertain. */
  ranked: RankedHypothesis[];
  /** Shannon entropy in bits. */
  entropy: number;
  /** Best hypothesis, or `null` when the evidence is not yet sufficient. */
  top: NetworkHypothesis | null;
  /** Top probability. */
  confidence: number;
  /** True when the evidence cannot separate hypotheses (entropy near maximum). */
  insufficientEvidence: boolean;
  /** Number of observations actually incorporated (skipped/unknown excluded). */
  evidenceCount: number;
}

/* ------------------------------- API health -------------------------------- */

/** Failure category for an API probe, mapped to a correct response. */
export type ApiFailureCategory =
  | 'dns'
  | 'tcp'
  | 'tls'
  | 'auth'
  | 'forbidden'
  | 'rate-limit'
  | 'invalid-request'
  | 'server'
  | 'reset'
  | 'timeout'
  | 'malformed-response'
  | 'unknown';

export type ApiHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

/** Result of one layered API probe. Missing layers stay `undefined` (untested). */
export interface ApiProbeResult {
  dns?: boolean;
  tcp?: boolean;
  tls?: boolean;
  /** HTTP status, when an HTTP response was received. */
  status?: number;
  /** Parsed body was valid JSON/shape, when applicable. */
  parsed?: boolean;
  /** Application-level operation succeeded (not merely HTTP 200). */
  operationOk?: boolean;
  latencyMs?: number;
  /** Provider error text (sanitized by the caller; never credentials). */
  error?: string;
  timedOut?: boolean;
  reset?: boolean;
  /** Retry-After seconds, when supplied by the provider. */
  retryAfterSeconds?: number;
  at: number;
}

export interface ApiClassification {
  category: ApiFailureCategory;
  status: ApiHealthStatus;
  /** Actionable next step — a route change is only correct for some categories. */
  action: 'retry' | 'backoff' | 'switch-route' | 'fix-credentials' | 'fix-request' | 'none';
  /** Short, user-facing explanation. */
  explanation: string;
  retryable: boolean;
}

/* ------------------------------ route decision ----------------------------- */

export type RouteKind = 'direct' | 'upstream-proxy' | 'ipv6' | 'alternate-dns';

export interface RouteCandidate {
  id: string;
  kind: RouteKind;
  /** Hard constraints — a candidate failing any is never selected. */
  authorized: boolean;
  tlsVerification: boolean;
  /** Measured/estimated feature values. */
  features: RouteFeatures;
}

export interface RouteFeatures {
  /** Prior success probability in [0,1]. */
  successPrior: number;
  latencyMs: number;
  latencyStdMs: number;
  jitterMs: number;
  packetLoss: number;
  recoveryMs: number;
  resourceCost: number;
  risk: number;
}

export interface RouteScoreWeights {
  failure: number;
  latency: number;
  jitter: number;
  loss: number;
  recovery: number;
  resource: number;
  risk: number;
}

export const DEFAULT_ROUTE_WEIGHTS: RouteScoreWeights = {
  failure: 1.0,
  latency: 0.6,
  jitter: 0.3,
  loss: 0.8,
  recovery: 0.2,
  resource: 0.15,
  risk: 0.9,
};

/* -------------------------------- recovery -------------------------------- */

export type RecoveryStepKind =
  | 'probe-direct'
  | 'probe-upstream'
  | 'activate-route'
  | 'verify-operation'
  | 'rollback';

export interface RecoveryStep {
  id: string;
  kind: RecoveryStepKind;
  routeId: string;
  /** Must be true for activation steps; informational steps may set false. */
  requiresAuthorization: boolean;
}

export type StepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'requires-permission'
  | 'insufficient-evidence';

export interface RecoveryObservation {
  stepId: string;
  status: StepStatus;
  /** Measured effect, when the step produced one. */
  latencyMs?: number;
  message?: string;
}

export interface RecoveryPolicy {
  maxAttempts: number;
  maxSteps: number;
  /** Cooldown after a failed route before it may be retried (ms). */
  failureCooldownMs: number;
  /** Minimum expected success probability to attempt activation. */
  minExpectedSuccess: number;
}
