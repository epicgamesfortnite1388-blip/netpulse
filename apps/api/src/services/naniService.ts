/**
 * NANI service — orchestrates the adaptive network intelligence engine inside
 * the live NetPulse API.
 *
 * Side effects are confined here: health checks, recovery activation, route
 * changes. The NANI core (packages/shared/src/nani) is pure.
 */

import type {
  ApiClassification,
  ApiHealthStatus,
  ApiProbeResult,
  ApiRegistration,
  ApiRegistry,
  ApiRegistryEntry,
  DiagnosticObservation,
  HypothesisPosterior,
  NaniDiagnosisCompleted,
  NaniEventEnvelope,
  NaniEventPayload,
  NaniEventType,
  NaniHealthUpdated,
  NaniRecoveryExhausted,
  NaniRecoveryPlanned,
  NaniRecoveryResetEvent,
  NaniRecoveryRolledBackEvent,
  NaniRecoveryStepEvent,
  NaniRouteActivated,
  RecoveryObservation,
  RecoveryPolicy,
  RecoverySnapshot,
  RecoveryStep,
  RecoveryStepKind,
  RouteCandidate,
  RouteKind,
  StepStatus,
} from '@netpulse/shared';
import {
  assessApiHealth,
  classifyApiFailure,
  createApiRegistry,
  DEFAULT_RECOVERY_POLICY,
  DEFAULT_ROUTE_CONSTRAINTS,
  DEFAULT_TESTS,
  diagnose,
  planRecovery,
  RecoveryController,
  registerApi,
  selectNextTest,
  setApiHealth,
  verifyRoute,
} from '@netpulse/shared';

import type { PlatformNetworkController } from '../providers/platform/types';
import type { EventService } from './eventService';
import type { RealtimeBus } from '../realtime/bus';
import type { Logger } from '../logger';
import { runDiagnosticTest } from './naniProbeAdapter';

export interface NaniServiceDeps {
  controller: PlatformNetworkController;
  bus: RealtimeBus;
  events: EventService;
  log: Logger;
}

interface ApiRuntimeState {
  entry: ApiRegistryEntry;
  failures: number;
  successes: number;
  lastProbe: ApiProbeResult | null;
  lastDiagnosis: HypothesisPosterior | null;
  knownGoodRouteId: string | null;
  recoveryId: string | null;
  /** Steps of the active plan, in plan order (needed to revert all of them). */
  recoverySteps: Array<{ id: string; kind: RecoveryStepKind; routeId: string; routeKind: RouteKind }>;
  /** Active bounded controller, created only when the plan has runnable steps. */
  recoveryController?: RecoveryController;
}

export interface NaniHealthCheckOptions {
  apiId: string;
  target: string;
  layers?: Array<'dns' | 'tcp' | 'tls' | 'http' | 'auth' | 'application'>;
}

export interface NaniShadowAssessment {
  apiId: string;
  at: number;
  classification: ApiClassification;
  probe: ApiProbeResult;
}

export interface NaniDiagnosisResult {
  target: string;
  posterior: HypothesisPosterior;
  top: string | null;
  confidence: number;
  entropy: number;
  insufficientEvidence: boolean;
  action: string;
  explanation: string;
  recommendedTest: string | null;
}

export interface NaniRecoveryPlan {
  recoveryId: string;
  apiId: string;
  status: 'ready' | 'requires-permission' | 'insufficient-evidence';
  reason?: string;
  steps: Array<{ id: string; kind: string; routeId: string; requiresAuthorization: boolean }>;
  rejected: Array<{ id: string; reason: string }>;
  /** Route verified working by this engine, if it has one; the rollback target. */
  knownGoodRouteId: string | null;
}

/** Outcome of an operator-requested rollback to the last verified route. */
export interface NaniRollbackResult {
  apiId: string;
  routeId: string;
  recoveryId: string | null;
  /** Steps marked skipped because the plan was reverted. */
  skippedStepIds: string[];
  /** The plan's rollback step, when the plan had one. */
  revertedStepId: string | null;
  snapshot: RecoverySnapshot | null;
  message: string;
}

export interface NaniRecoveryStepResult {
  recoveryId: string;
  stepId: string;
  status: StepStatus;
  snapshot: RecoverySnapshot;
  nextStepId: string | null;
}

function isStepEventStatus(status: StepStatus): status is NaniRecoveryStepEvent['status'] {
  return status !== 'pending';
}

type HealthLayer = 'dns' | 'tcp' | 'tls' | 'http';

/** Loopback host forms that a local sidecar can listen on. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1' || h.startsWith('127.');
}

/**
 * The layers a health probe can actually exercise for this endpoint.
 *
 * The desktop sidecar listens on loopback with plain HTTP; a TLS handshake
 * against it fails by design (`ERR_SSL_WRONG_VERSION_NUMBER`) and would mark a
 * perfectly healthy local service as down. Every other endpoint keeps the full
 * DNS → TCP → TLS → HTTP chain, because skipping TLS there would hide real
 * certificate failures.
 */
export function healthProbeLayers(
  host: string,
  requested: ReadonlyArray<HealthLayer>,
): HealthLayer[] {
  return isLoopbackHost(host) ? requested.filter((layer) => layer !== 'tls') : [...requested];
}

/**
 * A provider's health path, when it is concrete. Templated paths such as
 * `/bot<token>/getMe` cannot be requested literally, so they fall back to the
 * layer default instead of probing a URL that cannot exist.
 */
export function healthProbePath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const trimmed = path.trim();
  if (!trimmed.startsWith('/') || trimmed.includes('<')) return undefined;
  return trimmed;
}

export class NaniService {
  private readonly apis = new Map<string, ApiRuntimeState>();
  private readonly registry: ApiRegistry;
  private seq = 0;
  private readonly deps: NaniServiceDeps;
  private recoveryPolicy: RecoveryPolicy;
  private readonly shadowHealth = new Map<string, NaniShadowAssessment>();

  constructor(deps: NaniServiceDeps, policy: Partial<RecoveryPolicy> = {}) {
    this.deps = deps;
    this.registry = createApiRegistry();
    this.recoveryPolicy = { ...DEFAULT_RECOVERY_POLICY, ...policy };
  }

  getRegistry(): ApiRegistry {
    return this.registry;
  }

  registerApi(entry: ApiRegistration): void {
    registerApi(this.registry, entry);
    this.apis.delete(entry.id);
    // Materialise the runtime state so listApis()/the UI can see the provider
    // immediately. Without this, a freshly registered API was invisible until
    // its first health check created the state lazily.
    const registered = this.registry.entries.get(entry.id);
    if (registered) this.getRuntimeState(registered);
    this.deps.log.info({ apiId: entry.id, provider: entry.provider }, 'nani api registered');
  }

  listApis(): Array<{ entry: ApiRegistryEntry; health: ApiHealthStatus; failures: number; successes: number }> {
    return Array.from(this.apis.values()).map((state) => ({
      entry: state.entry,
      health: state.entry.health as ApiHealthStatus,
      failures: state.failures,
      successes: state.successes,
    }));
  }

  async checkApiHealth(opts: NaniHealthCheckOptions): Promise<{
    classification: ApiClassification;
    probe: ApiProbeResult;
  }> {
    const now = Date.now();
    const entry = this.registry.entries.get(opts.apiId);
    if (!entry) throw new Error(`unknown api: ${opts.apiId}`);
    const state = this.getRuntimeState(entry);

    const probe = await this.probeHealth(
      opts.target,
      opts.layers,
      now,
      healthProbePath(entry.healthCheckPath),
    );
    const classification = classifyApiFailure(probe);

    if (classification.category === 'dns' || classification.category === 'tcp' || classification.category === 'tls') {
      state.failures += 1;
      state.successes = 0;
    } else if (classification.category === 'auth' || classification.category === 'forbidden') {
      state.failures += 1;
    } else if (classification.category === 'server' || classification.category === 'timeout' || classification.category === 'reset') {
      state.failures += 1;
    } else {
      state.successes += 1;
      state.failures = 0;
    }

    const healthy: ApiHealthStatus = classification.status;
    setApiHealth(this.registry, opts.apiId, healthy, {
      lastFailureCategory: classification.category,
      lastVerifiedAt: now,
      consecutiveFailures: state.failures,
    });
    state.lastProbe = probe;

    const update: NaniHealthUpdated = {
      apiId: opts.apiId,
      status: healthy,
      category: classification.category,
      action: classification.action,
      latencyMs: probe.latencyMs,
      retryAfterSeconds: probe.retryAfterSeconds,
      circuitState: state.failures >= 5 ? 'open' : 'closed',
      directReachable: probe.tcp ?? false,
      upstreamReachable: undefined,
      at: now,
    };
    this.publish('nani:health:updated', update);

    this.deps.events.record(
      classification.retryable ? 'warn' : 'error',
      'connectivity',
      `API ${opts.apiId}: ${classification.explanation}`,
      { apiId: opts.apiId, category: classification.category, action: classification.action },
    );

    return { classification, probe };
  }

  diagnoseTarget(target: string, observations: DiagnosticObservation[]): NaniDiagnosisResult {
    const now = Date.now();
    const result = diagnose(observations, DEFAULT_TESTS, now);

    let action = 'none';
    let explanation = 'Insufficient evidence to diagnose.';

    if (!result.insufficientEvidence && result.top) {
      switch (result.top) {
        case 'dns':
          action = 'switch-route';
          explanation = 'DNS resolution appears to be the cause. Try an approved DNS resolver.';
          break;
        case 'tcp':
        case 'routing':
        case 'gateway':
          action = 'switch-route';
          explanation = 'Transport or routing failure detected. An alternative route may help.';
          break;
        case 'tls':
          action = 'none';
          explanation = 'TLS verification failed. Certificate checks remain enabled; do not disable verification.';
          break;
        case 'api-auth':
          action = 'fix-credentials';
          explanation = 'Authentication failure. Refresh or replace credentials; a route change will not help.';
          break;
        case 'api-rate-limit':
          action = 'backoff';
          explanation = 'Rate limited by the provider. Wait before retrying.';
          break;
        case 'application':
        case 'server':
          action = 'retry';
          explanation = 'Application or server-side failure. Retry with backoff or use a fallback provider.';
          break;
        default:
          explanation = `Diagnosis points to ${result.top} with ${Math.round(result.confidence * 100)}% confidence.`;
      }
    }

    const excluded = new Set(observations.map((o) => o.testId));
    const nextTest = selectNextTest(result.posterior, DEFAULT_TESTS, excluded, now);

    const completed: NaniDiagnosisCompleted = {
      target,
      top: result.top,
      confidence: result.confidence,
      action,
      explanation,
    };
    this.publish('nani:diagnosis:completed', completed);

    return {
      target,
      posterior: result.posterior,
      top: result.top,
      confidence: result.confidence,
      entropy: result.entropy,
      insufficientEvidence: result.insufficientEvidence,
      action,
      explanation,
      recommendedTest: nextTest?.test.id ?? null,
    };
  }

  planRecovery(
    apiId: string,
    routes: RouteCandidate[],
    knownGoodRouteId: string | null = null,
  ): NaniRecoveryPlan {
    const entry = this.registry.entries.get(apiId);
    if (!entry) throw new Error(`unknown api: ${apiId}`);
    const state = this.getRuntimeState(entry);
    const now = Date.now();

    const plan = planRecovery(routes, this.recoveryPolicy, DEFAULT_ROUTE_CONSTRAINTS, knownGoodRouteId);
    const recoveryId = `nani-recovery-${apiId}-${now}`;
    state.recoveryId = recoveryId;
    // A new plan invalidates any controller left by an earlier plan, even when
    // the new plan has no runnable steps.
    state.recoveryController = undefined;

    const routeKindById = new Map(routes.map((r) => [r.id, r.kind]));
    state.recoverySteps = plan.steps.map((s) => ({
      id: s.id,
      kind: s.kind,
      routeId: s.routeId,
      routeKind: routeKindById.get(s.routeId) ?? 'direct',
    }));

    // Create the recovery controller only when there are actionable steps.
    if (plan.status === 'ready' && plan.steps.length > 0) {
      const controller = new RecoveryController(plan, this.recoveryPolicy);
      this.attachRecoveryController(apiId, controller);
    }

    const planned: NaniRecoveryPlanned = {
      recoveryId,
      target: apiId,
      status: plan.status,
      reason: plan.reason,
      steps: plan.steps.map((s) => ({ id: s.id, kind: s.kind, routeId: s.routeId, requiresAuthorization: s.requiresAuthorization })),
      rejected: plan.rejected,
    };
    this.publish('nani:recovery:planned', planned);

    return {
      recoveryId,
      apiId,
      status: plan.status as 'ready' | 'requires-permission' | 'insufficient-evidence',
      reason: plan.reason,
      steps: plan.steps.map((s) => ({ id: s.id, kind: s.kind, routeId: s.routeId, requiresAuthorization: s.requiresAuthorization })),
      rejected: plan.rejected.map((r) => ({ id: r.id, reason: r.reason })),
      knownGoodRouteId: state.knownGoodRouteId,
    };
  }

  nextRecoveryStep(
    apiId: string,
    now: number = Date.now(),
  ): { step: RecoveryStep | null; snapshot: RecoverySnapshot | null; knownGoodRouteId: string | null } {
    const state = this.apis.get(apiId);
    if (!state) return { step: null, snapshot: null, knownGoodRouteId: null };
    if (!state.recoveryId) return { step: null, snapshot: null, knownGoodRouteId: state.knownGoodRouteId };
    const controller = state.recoveryController;
    // Re-deriving a plan here would invent steps that were never approved.
    if (!controller) return { step: null, snapshot: null, knownGoodRouteId: state.knownGoodRouteId };
    const step = controller.next(now);
    return { step, snapshot: controller.snapshot(), knownGoodRouteId: state.knownGoodRouteId };
  }

  recordRecoveryStep(apiId: string, observation: RecoveryObservation, now: number = Date.now()): NaniRecoveryStepResult {
    const state = this.apis.get(apiId);
    const controller = state?.recoveryController;
    if (!state || !controller) throw new Error(`no active recovery controller for ${apiId}`);
    const plannedStep = state.recoverySteps.find((s) => s.id === observation.stepId);
    if (!plannedStep) throw new Error(`unknown recovery step ${observation.stepId} for ${apiId}`);
    controller.record(observation, now);
    const snapshot = controller.snapshot();

    if (isStepEventStatus(observation.status)) {
      const stepEvent: NaniRecoveryStepEvent = {
        recoveryId: state.recoveryId ?? '',
        stepId: observation.stepId,
        kind: plannedStep.kind,
        routeId: plannedStep.routeId,
        status: observation.status,
        latencyMs: observation.latencyMs,
        message: observation.message,
      };
      this.publish(`nani:recovery:step:${stepEvent.status}`, stepEvent);
    }

    if (observation.status === 'succeeded' && observation.stepId.includes('verify')) {
      const routeId = plannedStep.routeId;
      // A route the engine just verified working is the known-good target a
      // rollback reverts to. Nothing else sets this: it is evidence, not a
      // user preference.
      state.knownGoodRouteId = routeId;
      verifyRoute(this.registry, apiId, routeId, { successPrior: 0.9 }, now);
      const activated: NaniRouteActivated = {
        apiId,
        routeId,
        kind: plannedStep.routeKind,
        successProbability: 0.9,
      };
      this.publish('nani:route:activated', activated);
    }

    if (snapshot.exhausted) {
      const exhausted: NaniRecoveryExhausted = {
        recoveryId: state.recoveryId ?? '',
        target: apiId,
        reason: 'max attempts reached',
        attempts: snapshot.attempts,
      };
      this.publish('nani:recovery:exhausted', exhausted);
    }

    const next = controller.next(now);
    return {
      recoveryId: state.recoveryId ?? '',
      stepId: observation.stepId,
      status: observation.status,
      snapshot,
      nextStepId: next?.id ?? null,
    };
  }

  /**
   * Roll the active recovery plan back to the last route this engine verified.
   *
   * This is an operator decision, not an automatic one: a failed activation
   * makes the plan's own rollback step runnable, but only the operator can say
   * "give up on this plan and revert". The method therefore ends the plan in a
   * reverted state — the rollback step (when the plan has one) is recorded as
   * succeeded and every other unfinished step is recorded as skipped ("not
   * attempted", which is exactly what happened).
   *
   * It records state; it does not reconfigure the network. The route marked
   * known-good is the one a previous run verified, and the response says so
   * instead of implying a connection was switched.
   */
  rollbackToKnownGood(apiId: string, now: number = Date.now()): NaniRollbackResult {
    const state = this.apis.get(apiId);
    if (!state) throw new Error(`unknown api: ${apiId}`);
    const routeId = state.knownGoodRouteId;
    if (!routeId) {
      throw new Error(`no known-good route recorded for ${apiId}`);
    }

    const controller = state.recoveryController;
    // Only a rollback step that actually targets this route may be recorded as
    // reverted. Planning can carry a different known-good route, and recording
    // that step as succeeded would claim a revert that never happened.
    const revertedStepId =
      state.recoverySteps.find((s) => s.kind === 'rollback' && s.routeId === routeId)?.id ?? null;
    const skippedStepIds: string[] = [];

    if (controller) {
      if (revertedStepId) {
        controller.record({ stepId: revertedStepId, status: 'succeeded' }, now);
      }
      // Everything still unfinished is neither run nor failed: skipped.
      for (const step of state.recoverySteps) {
        if (step.id === revertedStepId) continue;
        const status = controller.snapshot().statuses.find((s) => s.stepId === step.id)?.status;
        if (status === 'pending' || status === 'running' || status === 'requires-permission') {
          controller.record({ stepId: step.id, status: 'skipped' }, now);
          skippedStepIds.push(step.id);
        }
      }
    }

    const snapshot = controller ? controller.snapshot() : null;
    const recoveryId = state.recoveryId;

    const rolledBack: NaniRecoveryRolledBackEvent = {
      recoveryId: recoveryId ?? '',
      apiId,
      routeId,
      revertedStepId,
      skippedStepIds,
      source: 'operator',
    };
    this.publish('nani:recovery:rolledback', rolledBack);

    return {
      apiId,
      routeId,
      recoveryId,
      skippedStepIds,
      revertedStepId,
      snapshot,
      message:
        `rolled back to known-good route ${routeId}` +
        (revertedStepId ? `; ${revertedStepId} recorded as succeeded` : '') +
        (skippedStepIds.length ? `; ${skippedStepIds.length} unfinished step(s) marked skipped` : '') +
        ' (state change only — no network configuration was altered)',
    };
  }

  /** Attach a recovery controller to an API's runtime state (called by planRecovery). */
  attachRecoveryController(apiId: string, controller: RecoveryController): void {
    const state = this.apis.get(apiId);
    if (state) state.recoveryController = controller;
  }

  /**
   * Discard an API's runtime recovery state.
   *
   * This is how an operator abandons a plan that is exhausted or stuck behind a
   * failure cooldown: the controller and its recovery id are dropped so the next
   * plan starts clean. Route health, failure counts and learned reliability are
   * deliberately *not* touched — that is evidence about the network, not UI
   * state, and a reset button must not rewrite it.
   *
   * Returns the id of the plan that was discarded so the caller can report what
   * actually happened instead of claiming success unconditionally.
   */
  resetRecovery(apiId: string): { apiId: string; previousRecoveryId: string | null; cleared: boolean } {
    const state = this.apis.get(apiId);
    if (!state) throw new Error(`unknown api: ${apiId}`);
    const previousRecoveryId = state.recoveryId;
    state.recoveryController = undefined;
    state.recoveryId = null;
    if (previousRecoveryId) {
      const reset: NaniRecoveryResetEvent = {
        apiId,
        recoveryId: previousRecoveryId,
        cleared: true,
      };
      this.publish('nani:recovery:reset', reset);
    }
    return { apiId, previousRecoveryId, cleared: previousRecoveryId !== null };
  }

  /** Configured provider ids, in registry order. */
  configuredApiIds(): string[] {
    return Array.from(this.registry.entries.keys());
  }

  /**
   * Shadow health assessment.
   *
   * Runs the same read-only layered probe as `checkApiHealth`, but classifies
   * it with the pure `assessApiHealth` and stores the result only in a private
   * shadow buffer. It deliberately does NOT call `setApiHealth`, publish
   * events, increment failure counters, touch circuit state, or plan recovery.
   * A shadow result can therefore be compared with the live path without
   * changing what the engine decides or what the UI is told.
   */
  async assessApiHealthShadow(apiId: string): Promise<NaniShadowAssessment> {
    const entry = this.registry.entries.get(apiId);
    if (!entry) throw new Error(`unknown api: ${apiId}`);
    const now = Date.now();
    const probe = await this.probeHealth(
      entry.endpoint,
      undefined,
      now,
      healthProbePath(entry.healthCheckPath),
    );
    const classification = assessApiHealth(probe);
    const assessment: NaniShadowAssessment = { apiId, at: now, classification, probe };
    this.shadowHealth.set(apiId, assessment);
    this.deps.log.debug(
      { apiId, status: classification.status, category: classification.category },
      'nani shadow api health assessed (advisory only)',
    );
    return assessment;
  }

  /** One shadow pass over every configured provider. Never throws per API. */
  async runShadowHealthPass(): Promise<NaniShadowAssessment[]> {
    const results: NaniShadowAssessment[] = [];
    for (const apiId of this.configuredApiIds()) {
      try {
        results.push(await this.assessApiHealthShadow(apiId));
      } catch (err) {
        this.deps.log.warn(
          { apiId, error: err instanceof Error ? err.message : String(err) },
          'nani shadow health probe failed (no action taken)',
        );
      }
    }
    return results;
  }

  /** Last shadow assessment per provider, for diagnostics/tests. */
  shadowSnapshot(): NaniShadowAssessment[] {
    return Array.from(this.shadowHealth.values());
  }

  private async probeHealth(
    target: string,
    layers: NaniHealthCheckOptions['layers'],
    now: number,
    pathOverride?: string,
  ): Promise<ApiProbeResult> {
    const probe: ApiProbeResult = { at: now };
    const host = target.split(':')[0] ?? '';
    const requested = (layers ?? ['dns', 'tcp', 'tls', 'http']) as HealthLayer[];
    const selected = healthProbeLayers(host, requested);
    let failed = false;

    for (const layer of selected) {
      const test = DEFAULT_TESTS.find((t) => t.layer === layer);
      if (!test) continue;
      const obs = await runDiagnosticTest(
        this.deps.controller,
        test,
        target,
        now,
        this.deps.log,
        pathOverride,
      );
      if (obs.outcome === 'success') {
        if (obs.testId === 'dns-lookup') probe.dns = true;
        if (obs.testId === 'tcp-connect') probe.tcp = true;
        if (obs.testId === 'tls-handshake') probe.tls = true;
      } else if (obs.outcome === 'failure' || obs.outcome === 'timeout') {
        if (obs.testId === 'dns-lookup') probe.dns = false;
        if (obs.testId === 'tcp-connect') probe.tcp = false;
        if (obs.testId === 'tls-handshake') probe.tls = false;
        probe.timedOut = obs.outcome === 'timeout';
        failed = true;
        break;
      }
    }

    probe.operationOk = !failed;
    probe.status = probe.status ?? (probe.tcp === false ? 0 : 200);
    probe.latencyMs = probe.latencyMs ?? 200;
    return probe;
  }

  private getRuntimeState(entry: ApiRegistryEntry): ApiRuntimeState {
    let state = this.apis.get(entry.id);
    if (!state) {
      state = {
        entry,
        failures: 0,
        successes: 0,
        lastProbe: null,
        lastDiagnosis: null,
        knownGoodRouteId: null,
        recoveryId: null,
        recoverySteps: [],
      };
      this.apis.set(entry.id, state);
    }
    return state;
  }

  private publish<T extends NaniEventPayload>(type: NaniEventType, payload: T): void {
    this.seq += 1;
    const envelope: NaniEventEnvelope<T> = {
      seq: this.seq,
      at: Date.now(),
      type,
      payload,
      version: 1,
    };
    const topic = type.split(':').slice(1).join(':');
    this.deps.bus.publish(`nani:${topic}`, { ...envelope });
    this.deps.events.record('info', 'connectivity', `event: ${type}`, { type });
  }

}
