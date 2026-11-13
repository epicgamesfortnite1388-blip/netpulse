/**
 * NANI — typed, versioned event contracts for the reactive UI layer.
 *
 * These events flow from the control plane through the existing
 * RealtimeBus → WebSocket → frontend. Each payload is small, typed, and
 * versioned so the frontend subscribes selectively and never receives a
 * full state snapshot for a single telemetry update.
 *
 * All payloads are sanitized: no credentials, no secrets, no raw proxy
 * addresses unless explicitly configured by the user.
 *
 * Event envelope version. Bump when any payload shape changes.
 */
export const NANI_EVENT_VERSION = 1;

/** Every NANI event type the frontend can subscribe to. */
export type NaniEventType =
  | 'nani:health:started'
  | 'nani:health:updated'
  | 'nani:health:completed'
  | 'nani:diagnosis:started'
  | 'nani:diagnosis:updated'
  | 'nani:diagnosis:completed'
  | 'nani:recovery:planned'
  | 'nani:recovery:step:running'
  | 'nani:recovery:step:succeeded'
  | 'nani:recovery:step:failed'
  | 'nani:recovery:step:skipped'
  | 'nani:recovery:step:requires-permission'
  | 'nani:recovery:step:insufficient-evidence'
  | 'nani:recovery:rollback:started'
  | 'nani:recovery:rollback:completed'
  | 'nani:recovery:rollback:failed'
  | 'nani:recovery:completed'
  | 'nani:recovery:exhausted'
  | 'nani:route:activated'
  | 'nani:route:demoted'
  | 'nani:circuit:opened'
  | 'nani:circuit:closed'
  | 'nani:circuit:half-open'
  | 'nani:drift:detected'
  | 'nani:learning:updated'
  | 'nani:llm:reasoning:started'
  | 'nani:llm:reasoning:completed'
  | 'nani:error';

export interface NaniEventEnvelope<T = unknown> {
  seq: number;
  at: number;
  type: NaniEventType;
  payload: T;
  version: number;
}

/* ----------------------------- health events ----------------------------- */

export interface NaniHealthStarted {
  apiId: string;
  provider: string;
  endpoint: string;
  layers: Array<'dns' | 'tcp' | 'tls' | 'http' | 'auth' | 'application'>;
}

export interface NaniHealthUpdated {
  apiId: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  category: string;
  action: string;
  latencyMs?: number;
  retryAfterSeconds?: number;
  circuitState: 'closed' | 'open' | 'half-open';
  directReachable: boolean;
  upstreamReachable?: boolean;
  at: number;
}

export interface NaniHealthCompleted {
  apiId: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  lastVerifiedAt: number;
  consecutiveFailures: number;
}

/* --------------------------- diagnosis events ---------------------------- */

export interface NaniDiagnosisStarted {
  target: string;
  hypotheses: string[];
}

export interface NaniDiagnosisUpdated {
  target: string;
  top: string | null;
  confidence: number;
  entropy: number;
  insufficientEvidence: boolean;
  evidenceCount: number;
  ranked: Array<{ hypothesis: string; probability: number }>;
}

export interface NaniDiagnosisCompleted {
  target: string;
  top: string | null;
  confidence: number;
  action: string;
  explanation: string;
}

/* ---------------------------- recovery events ---------------------------- */

export interface NaniRecoveryPlanned {
  recoveryId: string;
  target: string;
  status: 'ready' | 'requires-permission' | 'insufficient-evidence';
  reason?: string;
  steps: Array<{
    id: string;
    kind: 'probe-direct' | 'probe-upstream' | 'activate-route' | 'verify-operation' | 'rollback';
    routeId: string;
    requiresAuthorization: boolean;
  }>;
  rejected: Array<{ id: string; reason: string }>;
}

export interface NaniRecoveryStepEvent {
  recoveryId: string;
  stepId: string;
  kind: 'probe-direct' | 'probe-upstream' | 'activate-route' | 'verify-operation' | 'rollback';
  routeId: string;
  status: 'running' | 'succeeded' | 'failed' | 'skipped' | 'requires-permission' | 'insufficient-evidence';
  latencyMs?: number;
  message?: string;
}

export interface NaniRecoveryRollbackEvent {
  recoveryId: string;
  routeId: string;
  status: 'started' | 'completed' | 'failed';
  message?: string;
}

export interface NaniRecoveryCompleted {
  recoveryId: string;
  target: string;
  activatedRouteId: string | null;
  verified: boolean;
  attempts: number;
  rolledBack: boolean;
}

export interface NaniRecoveryExhausted {
  recoveryId: string;
  target: string;
  reason: string;
  attempts: number;
}

/* ------------------------------ route events ----------------------------- */

export interface NaniRouteActivated {
  apiId: string;
  routeId: string;
  kind: string;
  successProbability: number;
}

export interface NaniRouteDemoted {
  apiId: string;
  routeId: string;
  reason: string;
  cooldownUntil: number;
}

/* --------------------------- circuit events ------------------------------ */

export interface NaniCircuitEvent {
  apiId: string;
  state: 'closed' | 'open' | 'half-open';
  failures: number;
  successes: number;
  openedAt?: number;
}

/* ---------------------------- drift events ------------------------------- */

export interface NaniDriftEvent {
  context: string;
  detector: 'page-hinkley' | 'cusum';
  statistic: number;
  direction: -1 | 0 | 1;
  threshold: number;
}

/* --------------------------- learning events ----------------------------- */

export interface NaniLearningUpdated {
  context: string;
  model: 'bayesian-logistic' | 'beta-bernoulli';
  successProbability: number;
  conservativeBound: number;
  observations: number;
  brierScore?: number;
  ece?: number;
}

/* --------------------------- LLM reasoning events ------------------------ */

export interface NaniLlmReasoningEvent {
  recoveryId: string | null;
  promptHash: string;
  status: 'started' | 'completed';
  summary?: string;
}

/* ------------------------------ error events ----------------------------- */

export interface NaniErrorEvent {
  recoveryId?: string;
  apiId?: string;
  code: string;
  message: string;
  fatal: boolean;
}

/* ---------------------------------- union ------------------------------- */

export type NaniEventPayload =
  | NaniHealthStarted
  | NaniHealthUpdated
  | NaniHealthCompleted
  | NaniDiagnosisStarted
  | NaniDiagnosisUpdated
  | NaniDiagnosisCompleted
  | NaniRecoveryPlanned
  | NaniRecoveryStepEvent
  | NaniRecoveryRollbackEvent
  | NaniRecoveryCompleted
  | NaniRecoveryExhausted
  | NaniRouteActivated
  | NaniRouteDemoted
  | NaniCircuitEvent
  | NaniDriftEvent
  | NaniLearningUpdated
  | NaniLlmReasoningEvent
  | NaniErrorEvent;

/**
 * Type-safe event factory. Returns an envelope with a sequence number and
 * timestamp. The caller assigns a monotonic seq.
 */
export function makeNaniEvent<T extends NaniEventPayload>(
  seq: number,
  type: NaniEventType,
  payload: T,
  version = NANI_EVENT_VERSION,
): NaniEventEnvelope<T> {
  return {
    seq,
    at: Date.now(),
    type,
    payload,
    version,
  };
}

