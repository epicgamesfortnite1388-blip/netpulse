/**
 * NANI — deterministic fault-injection simulations.
 *
 * No sockets, no timers, no randomness beyond a seeded PRNG: each scenario is a
 * replayable observation set. This is the closest thing to "unseen network
 * conditions" we can check in CI, and it is what the release gates in
 * `NANI_IMPLEMENTATION_REPORT.md` refer to.
 */

import { describe, expect, it } from 'vitest';

import {
  BayesianLogistic,
  DEFAULT_TESTS,
  PageHinkley,
  RecoveryController,
  brierScore,
  classifyApiFailure,
  diagnose,
  expectedCalibrationError,
  mulberry32,
  planRecovery,
  selectNextTest,
  sigmoid,
  uniformPrior,
  type DiagnosticObservation,
  type ProbeOutcome,
  type RouteCandidate,
} from '../src/nani';

const T0 = 1_700_000_000_000;

function observations(entries: Array<[string, ProbeOutcome]>, at = T0): DiagnosticObservation[] {
  return entries.map(([testId, outcome], i) => ({ testId, outcome, at: at + i }));
}

function candidate(id: string, kind: RouteCandidate['kind'], successPrior: number): RouteCandidate {
  return {
    id,
    kind,
    authorized: true,
    tlsVerification: true,
    features: {
      successPrior,
      latencyMs: kind === 'direct' ? 90 : 180,
      latencyStdMs: kind === 'direct' ? 15 : 40,
      jitterMs: kind === 'direct' ? 8 : 25,
      packetLoss: 0,
      recoveryMs: 400,
      resourceCost: kind === 'direct' ? 0.05 : 0.2,
      risk: 0.1,
    },
  };
}

describe('fault-injection: network diagnosis', () => {
  const cases: Array<{
    name: string;
    obs: DiagnosticObservation[];
    expected: string | string[];
    /** False when the evidence only ranks the cause without confirming it. */
    confident?: boolean;
  }> = [
    {
      name: 'DNS unavailable (downstream untestable)',
      obs: observations([
        ['dns-lookup', 'failure'],
        ['tcp-connect', 'skipped'],
        ['http-reachability', 'skipped'],
      ]),
      expected: 'dns',
    },
    {
      name: 'DNS resolves, TCP blocked',
      obs: observations([
        ['dns-lookup', 'success'],
        // Gateway reachable rules out local-interface/gateway/routing causes.
        ['gateway-ping', 'success'],
        ['tcp-connect', 'failure'],
      ]),
      expected: 'tcp',
      // TCP blocked and endpoint down are genuinely hard to separate here:
      // the leader is TCP, but the system must not claim a confirmed cause.
      confident: false,
    },
    {
      name: 'TCP opens, TLS certificate rejected',
      obs: observations([
        ['dns-lookup', 'success'],
        ['tcp-connect', 'success'],
        ['tls-handshake', 'failure'],
      ]),
      expected: 'tls',
    },
    {
      name: 'Path MTU black hole',
      obs: observations([
        ['dns-lookup', 'success'],
        ['tcp-connect', 'success'],
        ['mtu-probe', 'timeout'],
      ]),
      expected: 'mtu',
    },
    {
      name: 'IPv6 path down while IPv4 works',
      obs: observations([
        ['ipv6-connect', 'failure'],
        ['tcp-connect', 'success'],
      ]),
      expected: 'ipv6',
    },
    {
      name: 'API authentication rejected',
      obs: observations([
        ['dns-lookup', 'success'],
        ['tcp-connect', 'success'],
        ['tls-handshake', 'success'],
        ['http-reachability', 'success'],
        ['auth-check', 'failure'],
      ]),
      expected: 'api-auth',
    },
    {
      name: 'Provider rate limit',
      obs: observations([
        ['dns-lookup', 'success'],
        ['http-reachability', 'success'],
        ['rate-limit-check', 'failure'],
      ]),
      expected: 'api-rate-limit',
    },
    {
      name: 'Server-side application failure',
      obs: observations([
        ['dns-lookup', 'success'],
        ['tcp-connect', 'success'],
        ['tls-handshake', 'success'],
        ['http-reachability', 'success'],
        ['app-operation', 'failure'],
      ]),
      expected: 'server-application',
    },
    {
      name: 'Healthy path yields no confident cause',
      obs: observations([
        ['dns-lookup', 'success'],
        ['tcp-connect', 'success'],
        ['tls-handshake', 'success'],
        ['http-reachability', 'success'],
        ['app-operation', 'success'],
      ]),
      expected: [],
    },
  ];

  it.each(cases)('diagnoses $name', ({ obs, expected, confident }) => {
    const result = diagnose(obs, DEFAULT_TESTS, T0 + 100);
    if (expected.length === 0) {
      expect(result.insufficientEvidence).toBe(true);
      expect(result.top).toBeNull();
    } else {
      // The ranking is always available, even when confidence is too low to
      // report a diagnosis; the top is only set when evidence is sufficient.
      expect(result.ranked[0]?.hypothesis).toBe(expected);
      if (confident === false) {
        expect(result.insufficientEvidence).toBe(true);
        expect(result.top).toBeNull();
      } else {
        expect(result.top).toBe(expected);
      }
    }
  });

  it('chooses a cheap discriminating test, never the side-effecting one', () => {
    const posterior = uniformPrior();
    const choice = selectNextTest(posterior, DEFAULT_TESTS, new Set(), T0);
    expect(choice).not.toBeNull();
    expect(choice!.test.id).not.toBe('app-operation');
    expect(choice!.informationGain).toBeGreaterThan(0);
    expect(choice!.efficiency).toBeGreaterThan(0);
  });

  it('reports TLS certificate failures without recommending verification bypass', () => {
    const result = classifyApiFailure({ dns: true, tcp: true, tls: false, at: T0 });
    expect(result.category).toBe('tls');
    expect(result.action).not.toBe('switch-route');
    expect(result.explanation).toMatch(/must stay enabled/i);
  });
});

describe('fault-injection: bounded recovery', () => {
  it('recovers direct → approved upstream, one observed step at a time', () => {
    const plan = planRecovery(
      [candidate('direct', 'direct', 0.2), candidate('proxy', 'upstream-proxy', 0.9)],
      { maxAttempts: 2, maxSteps: 12, failureCooldownMs: 1000, minExpectedSuccess: 0.5 },
      undefined,
      'direct',
    );
    const controller = new RecoveryController(plan, {
      maxAttempts: 2,
      maxSteps: 12,
      failureCooldownMs: 1000,
      minExpectedSuccess: 0.5,
    });

    // Direct probe fails: no activation is attempted for it.
    expect(controller.next(T0)?.id).toBe('direct:probe');
    controller.record({ stepId: 'direct:probe', status: 'failed' }, T0);

    // Proxy is probed, activated, then verified against the real operation.
    expect(controller.next(T0)?.id).toBe('proxy:probe');
    controller.record({ stepId: 'proxy:probe', status: 'succeeded' }, T0);
    expect(controller.next(T0)?.id).toBe('proxy:activate');
    controller.record({ stepId: 'proxy:activate', status: 'succeeded' }, T0);
    expect(controller.next(T0)?.id).toBe('proxy:verify');
    controller.record({ stepId: 'proxy:verify', status: 'succeeded' }, T0);

    expect(controller.next(T0)).toBeNull();
    expect(controller.snapshot().done).toBe(true);
    expect(controller.snapshot().attempts).toBe(1);
  });

  it('rolls back when the activated route fails verification', () => {
    const plan = planRecovery(
      [candidate('proxy', 'upstream-proxy', 0.8)],
      undefined,
      undefined,
      'direct',
    );
    const controller = new RecoveryController(plan, {
      maxAttempts: 2,
      maxSteps: 12,
      failureCooldownMs: 1000,
      minExpectedSuccess: 0.5,
    });
    controller.record({ stepId: 'proxy:probe', status: 'succeeded' }, T0);
    controller.record({ stepId: 'proxy:activate', status: 'succeeded' }, T0);
    controller.record({ stepId: 'proxy:verify', status: 'failed' }, T0);

    expect(controller.next(T0)?.id).toBe('rollback:direct');
    controller.record({ stepId: 'rollback:direct', status: 'succeeded' }, T0);
    expect(controller.next(T0)).toBeNull();
    expect(controller.snapshot().attempts).toBe(1);
  });

  it('does not plan anything when no route is authorized', () => {
    const unauthorized = {
      ...candidate('public-proxy', 'upstream-proxy', 0.99),
      authorized: false,
    };
    const plan = planRecovery([unauthorized]);
    expect(plan.status).toBe('insufficient-evidence');
    expect(plan.steps).toHaveLength(0);
    expect(plan.rejected[0]?.reason).toMatch(/not authorized/i);
  });
});

describe('fault-injection: drift and learning', () => {
  it('detects a route degradation within a bounded number of samples', () => {
    const detector = new PageHinkley({ delta: 0.01, threshold: 2 });
    for (let i = 0; i < 60; i += 1) detector.update(0.1);
    let detectedAt = -1;
    for (let i = 0; i < 20 && detectedAt < 0; i += 1) {
      if (detector.update(0.85).drift) detectedAt = i;
    }
    expect(detectedAt).toBeGreaterThanOrEqual(0);
    expect(detectedAt).toBeLessThan(10);
  });

  it('beats a fixed 0.5 baseline on held-out data (Brier)', () => {
    const rng = mulberry32(2026);
    const rows: Array<{ phi: number[]; y: 0 | 1 }> = [];
    for (let i = 0; i < 400; i += 1) {
      const load = rng();
      const jitter = rng();
      const p = sigmoid(1.6 - 3.2 * load - 1.4 * jitter);
      rows.push({ phi: [1, load, jitter], y: rng() < p ? 1 : 0 });
    }

    const model = new BayesianLogistic(3);
    const train = rows.slice(0, 250);
    const test = rows.slice(250);

    for (const row of train) model.observe(row.phi, row.y);

    const adaptive = test.map((row) => ({ p: model.predict(row.phi).probability, y: row.y }));
    const baseline = test.map((row) => ({ p: 0.5, y: row.y }));

    const adaptiveBrier = brierScore(adaptive);
    const baselineBrier = brierScore(baseline);
    expect(adaptiveBrier).toBeLessThan(baselineBrier);
    expect(expectedCalibrationError(adaptive, 10)).toBeLessThan(0.2);
    expect(Number.isFinite(adaptiveBrier)).toBe(true);
  });
});
