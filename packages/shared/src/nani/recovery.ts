/**
 * NANI — bounded, reversible recovery planning and execution.
 *
 * Workflow: OBSERVE → CLASSIFY → GENERATE → FILTER → RANK → TEST → VERIFY →
 * ACTIVATE → MONITOR → LEARN.
 *
 * "Bounded" is literal: a plan has a maximum number of activation attempts and
 * steps, a failed route enters a cooldown instead of being retried immediately,
 * and the controller only ever exposes the *next* step. It never launches a
 * whole sequence on stale assumptions — each step's result is observed before
 * the next is offered, which is the receding-horizon requirement in practice.
 *
 * "Reversible" is literal too: a failed activation or verification makes the
 * rollback step runnable, and a rollback is never blocked by a cooldown.
 */

import { DEFAULT_ROUTE_CONSTRAINTS, filterCandidates, type RouteConstraints } from './decision';
import type {
  RecoveryObservation,
  RecoveryPolicy,
  RecoveryStep,
  RouteCandidate,
  StepStatus,
} from './types';

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = {
  maxAttempts: 2,
  maxSteps: 12,
  failureCooldownMs: 5 * 60 * 1000,
  minExpectedSuccess: 0.5,
};

export interface PlannedRecovery {
  steps: RecoveryStep[];
  rejected: Array<{ id: string; reason: string }>;
  status: 'ready' | 'requires-permission' | 'insufficient-evidence';
  reason?: string;
}

function probeKind(route: RouteCandidate): RecoveryStep['kind'] {
  return route.kind === 'direct' ? 'probe-direct' : 'probe-upstream';
}

/**
 * Build a plan from candidate routes. Only authorized, TLS-verified, low-risk
 * routes produce steps; the rest are reported as rejections for the UI.
 */
export function planRecovery(
  routes: readonly RouteCandidate[],
  policy: RecoveryPolicy = DEFAULT_RECOVERY_POLICY,
  constraints: RouteConstraints = DEFAULT_ROUTE_CONSTRAINTS,
  knownGoodRouteId: string | null = null,
): PlannedRecovery {
  const { allowed, rejected } = filterCandidates(routes, constraints);
  if (allowed.length === 0) {
    return {
      steps: [],
      rejected,
      status: 'insufficient-evidence',
      reason: 'No authorized, verified, low-risk route is available.',
    };
  }

  const steps: RecoveryStep[] = [];
  for (const route of allowed) {
    steps.push({
      id: `${route.id}:probe`,
      kind: probeKind(route),
      routeId: route.id,
      requiresAuthorization: false,
    });
    steps.push({
      id: `${route.id}:activate`,
      kind: 'activate-route',
      routeId: route.id,
      // Application-level route changes are automatic; a system-wide change
      // would set this true and be blocked without explicit user consent.
      requiresAuthorization: false,
    });
    steps.push({
      id: `${route.id}:verify`,
      kind: 'verify-operation',
      routeId: route.id,
      requiresAuthorization: false,
    });
  }

  if (knownGoodRouteId) {
    steps.push({
      id: `rollback:${knownGoodRouteId}`,
      kind: 'rollback',
      routeId: knownGoodRouteId,
      requiresAuthorization: false,
    });
  }

  const bounded = steps.slice(0, Math.max(1, policy.maxSteps));
  return { steps: bounded, rejected, status: 'ready' };
}

export interface RecoverySnapshot {
  statuses: Array<{ stepId: string; status: StepStatus }>;
  attempts: number;
  done: boolean;
  exhausted: boolean;
  planStatus: PlannedRecovery['status'];
  reason?: string;
}

/**
 * Executes a plan one step at a time. The caller drives it: ask `next()`, run the
 * real operation, feed the measured result to `record()`, ask again.
 */
export class RecoveryController {
  private readonly plan: PlannedRecovery;
  private readonly policy: RecoveryPolicy;
  private readonly statuses = new Map<string, StepStatus>();
  private readonly stepsById = new Map<string, RecoveryStep>();
  private readonly cooldowns = new Map<string, number>();
  private attempts = 0;
  private exhausted = false;

  constructor(plan: PlannedRecovery, policy: RecoveryPolicy = DEFAULT_RECOVERY_POLICY) {
    this.plan = plan;
    this.policy = policy;
    for (const step of plan.steps) {
      this.statuses.set(step.id, 'pending');
      this.stepsById.set(step.id, step);
    }
  }

  /** The next runnable step, or null when the plan is finished/blocked. */
  next(now: number): RecoveryStep | null {
    if (this.plan.status !== 'ready' || this.exhausted) return null;
    for (const step of this.plan.steps) {
      if (this.statuses.get(step.id) !== 'pending') continue;
      if (step.kind !== 'rollback') {
        const until = this.cooldowns.get(step.routeId) ?? 0;
        if (now < until) continue;
      }
      if (step.requiresAuthorization) {
        this.statuses.set(step.id, 'requires-permission');
        continue;
      }
      return step;
    }
    return null;
  }

  /** Record a measured outcome for a step. */
  record(observation: RecoveryObservation, now: number): void {
    const step = this.stepsById.get(observation.stepId);
    if (!step) return;

    this.statuses.set(observation.stepId, observation.status);

    if (observation.status === 'succeeded' && step.kind === 'verify-operation') {
      // Verified success ends the plan: nothing else — including a rollback —
      // is attempted once the chosen route is proven to work.
      for (const other of this.plan.steps) {
        if (this.statuses.get(other.id) === 'pending') {
          this.statuses.set(other.id, 'skipped');
        }
      }
      this.cooldowns.delete(step.routeId);
      return;
    }

    const failed = observation.status === 'failed' || observation.status === 'insufficient-evidence';
    const failedActivation =
      (step.kind === 'activate-route' || step.kind === 'verify-operation') && failed;

    if (failed) {
      // Whatever failed, this route must not be activated or retried in this
      // pass. A failed *probe* is still disqualifying: activation is never
      // attempted on a route we could not reach.
      for (const other of this.plan.steps) {
        if (other.routeId === step.routeId && this.statuses.get(other.id) === 'pending') {
          this.statuses.set(other.id, 'skipped');
        }
      }
      this.cooldowns.set(step.routeId, now + this.policy.failureCooldownMs);
    }

    // `attempts` counts activation attempts (successful or not), which is what
    // the policy bounds. A verification failure belongs to an activation that
    // was already counted; only count it if the caller never reported one.
    if (step.kind === 'activate-route' && (observation.status === 'succeeded' || failed)) {
      this.attempts += 1;
    } else if (step.kind === 'verify-operation' && failed && this.attempts === 0) {
      this.attempts += 1;
    }

    if (failedActivation) {

      // Make the rollback runnable if the plan has one.
      const rollback = this.plan.steps.find((s) => s.kind === 'rollback');
      if (rollback && this.statuses.get(rollback.id) === 'skipped') {
        this.statuses.set(rollback.id, 'pending');
      }

      if (this.attempts >= this.policy.maxAttempts) {
        this.exhausted = true;
      }
    }
  }

  snapshot(): RecoverySnapshot {
    return {
      statuses: this.plan.steps.map((step) => ({ stepId: step.id, status: this.statuses.get(step.id) ?? 'pending' })),
      attempts: this.attempts,
      done: this.plan.steps.every((step) => {
        const s = this.statuses.get(step.id);
        return s !== 'pending' && s !== 'running';
      }),
      exhausted: this.exhausted,
      planStatus: this.plan.status,
      reason: this.plan.reason,
    };
  }
}
