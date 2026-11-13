/**
 * NANI — API health classification, bounded retry and circuit breaking.
 *
 * The central rule: a non-200 response is not automatically a network failure.
 * A 401 means "fix the credential", a 400 means "fix the request", a 429 means
 * "wait", a 5xx means "the provider is unwell". Only DNS/TCP/TLS/reset/timeout
 * justify considering a different route. Conflating these is how a self-repair
 * system ends up switching proxies forever while the real bug is a bad token.
 */

import type {
  ApiClassification,
  ApiFailureCategory,
  ApiHealthStatus,
  ApiProbeResult,
} from './types';

const LABEL: Record<ApiFailureCategory, { status: ApiHealthStatus; action: ApiClassification['action']; retryable: boolean; explanation: string }> = {
  dns: {
    status: 'unhealthy',
    action: 'switch-route',
    retryable: true,
    explanation: 'The hostname did not resolve. Try an approved DNS resolver before changing routes.',
  },
  tcp: {
    status: 'unhealthy',
    action: 'switch-route',
    retryable: true,
    explanation: 'The endpoint could not be reached over TCP. A different route or upstream may help.',
  },
  tls: {
    status: 'unhealthy',
    action: 'none',
    retryable: false,
    explanation: 'TLS verification did not complete. Certificate checks must stay enabled; do not disable verification.',
  },
  auth: {
    status: 'unhealthy',
    action: 'fix-credentials',
    retryable: false,
    explanation: 'The provider rejected the credential (401). Refresh or replace the key; a route change will not help.',
  },
  forbidden: {
    status: 'unhealthy',
    action: 'fix-credentials',
    retryable: false,
    explanation: 'The provider refused access (403). The credential may lack the required permission or entitlement.',
  },
  'rate-limit': {
    status: 'degraded',
    action: 'backoff',
    retryable: true,
    explanation: 'The provider is rate limiting (429). Wait for Retry-After before retrying.',
  },
  'invalid-request': {
    status: 'unhealthy',
    action: 'fix-request',
    retryable: false,
    explanation: 'The request was rejected as invalid (4xx). This is an application bug, not a network problem.',
  },
  server: {
    status: 'degraded',
    action: 'retry',
    retryable: true,
    explanation: 'The provider returned a server error. Retry with backoff; a fallback provider may be used.',
  },
  reset: {
    status: 'degraded',
    action: 'switch-route',
    retryable: true,
    explanation: 'The connection was reset. A different route may be more stable.',
  },
  timeout: {
    status: 'degraded',
    action: 'retry',
    retryable: true,
    explanation: 'The request timed out. Retry with backoff, then consider another route if it repeats.',
  },
  'malformed-response': {
    status: 'unhealthy',
    action: 'none',
    retryable: false,
    explanation: 'The provider response could not be parsed. Treat as an API compatibility problem, not a route problem.',
  },
  unknown: {
    status: 'unknown',
    action: 'none',
    retryable: false,
    explanation: 'Insufficient evidence to classify this failure.',
  },
};

/**
 * Classify one layered probe result. Order encodes precedence:
 * transport evidence outranks HTTP status, and authentication outranks a reset,
 * because an auth rejection also closes the socket.
 */
export function classifyApiFailure(probe: ApiProbeResult): ApiClassification {
  const category = categoryOf(probe);
  const meta = LABEL[category];
  return {
    category,
    status: meta.status,
    action: meta.action,
    retryable: meta.retryable,
    explanation: meta.explanation,
  };
}

function categoryOf(probe: ApiProbeResult): ApiFailureCategory {
  // Explicit, measured negatives first. `undefined` means "not tested".
  if (probe.dns === false) return 'dns';
  if (probe.tcp === false) return 'tcp';
  if (probe.reset === true) return 'reset';
  if (probe.timedOut === true && probe.status === undefined) return 'timeout';
  if (probe.tls === false) return 'tls';

  const status = probe.status;
  if (status !== undefined) {
    if (status === 401) return 'auth';
    if (status === 403) return 'forbidden';
    if (status === 429) return 'rate-limit';
    if (status === 408) return 'timeout';
    if (status >= 500) return 'server';
    if (status >= 400) {
      if (probe.parsed === false) return 'malformed-response';
      return 'invalid-request';
    }
    if (status >= 200 && status < 300) {
      if (probe.parsed === false) return 'malformed-response';
      if (probe.operationOk === false) return 'server';
      return 'server'; // healthy path is reported by `assessApiHealth`
    }
  }

  if (probe.parsed === false) return 'malformed-response';
  if (probe.operationOk === false) return 'server';
  return 'unknown';
}

/** Aggregate status for a probe that may have succeeded. */
export function assessApiHealth(probe: ApiProbeResult): ApiClassification {
  const classified = classifyApiFailure(probe);
  const ok =
    probe.dns !== false &&
    probe.tcp !== false &&
    probe.tls !== false &&
    probe.reset !== true &&
    probe.timedOut !== true &&
    probe.parsed !== false &&
    probe.operationOk === true &&
    typeof probe.status === 'number' &&
    probe.status >= 200 &&
    probe.status < 300;

  if (ok) {
    return {
      category: 'unknown',
      status: 'healthy',
      action: 'none',
      retryable: false,
      explanation: 'The API responded correctly and the operation succeeded.',
    };
  }
  return classified;
}

/* -------------------------------- retry ---------------------------------- */

export interface RetryPolicy {
  baseMs: number;
  maxMs: number;
  factor: number;
  /** Jitter fraction in [0,1]; delay is multiplied by U(1-j, 1+j). */
  jitter: number;
  maxAttempts: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseMs: 400,
  maxMs: 30_000,
  factor: 2,
  jitter: 0.2,
  maxAttempts: 4,
};

/**
 * Bounded exponential backoff with jitter:
 *   t_n = min(maxMs, baseMs · factor^n) · U(1-j, 1+j)
 * `Retry-After` wins when present (and is itself capped). `rng` is injected so
 * tests are deterministic and production can use `Math.random`.
 */
export function retryDelayMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  opts: { retryAfterSeconds?: number; rng?: () => number } = {},
): number {
  if (opts.retryAfterSeconds !== undefined && Number.isFinite(opts.retryAfterSeconds)) {
    return clampDelay(opts.retryAfterSeconds * 1000, policy.maxMs);
  }
  const n = Math.max(0, Math.floor(attempt));
  const raw = policy.baseMs * Math.pow(policy.factor, n);
  const jitter = Math.min(1, Math.max(0, policy.jitter));
  const rng = opts.rng ?? Math.random;
  const factor = 1 - jitter + 2 * jitter * rng();
  return clampDelay(raw * factor, policy.maxMs);
}

function clampDelay(ms: number, maxMs: number): number {
  return Math.min(maxMs, Math.max(0, Math.round(ms)));
}

/** Whether another attempt is allowed at all. */
export function canRetry(attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY): boolean {
  return attempt + 1 < policy.maxAttempts;
}

/* ----------------------------- circuit breaker ---------------------------- */

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerOptions {
  failureThreshold: number;
  successThreshold: number;
  openMs: number;
}

export const DEFAULT_BREAKER_OPTIONS: BreakerOptions = {
  failureThreshold: 5,
  successThreshold: 2,
  openMs: 60_000,
};

/**
 * Minimal, deterministic circuit breaker.
 * - closed: requests allowed; consecutive failures open it at the threshold.
 * - open: requests denied until `openMs` elapses.
 * - half-open: a limited number of probes allowed; enough successes close it,
 *   one failure re-opens it.
 */
export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures = 0;
  private successes = 0;
  private openedAt = 0;
  private readonly options: BreakerOptions;

  constructor(options: Partial<BreakerOptions> = {}) {
    this.options = { ...DEFAULT_BREAKER_OPTIONS, ...options };
  }

  get currentState(): BreakerState {
    return this.state;
  }

  /** True when a request may be attempted now. */
  allow(now: number): boolean {
    if (this.state === 'open') {
      if (now - this.openedAt >= this.options.openMs) {
        this.state = 'half-open';
        this.successes = 0;
        return true;
      }
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.successes += 1;
      if (this.successes >= this.options.successThreshold) {
        this.state = 'closed';
        this.failures = 0;
        this.successes = 0;
      }
      return;
    }
    this.failures = 0;
  }

  recordFailure(now: number): void {
    if (this.state === 'half-open') {
      this.state = 'open';
      this.openedAt = now;
      this.successes = 0;
      return;
    }
    this.failures += 1;
    if (this.failures >= this.options.failureThreshold) {
      this.state = 'open';
      this.openedAt = now;
    }
  }

  snapshot(): { state: BreakerState; failures: number; successes: number } {
    return { state: this.state, failures: this.failures, successes: this.successes };
  }
}
