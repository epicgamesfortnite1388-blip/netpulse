import { describe, expect, it } from 'vitest';

import {
  BayesianLogistic,
  CircuitBreaker,
  Cusum,
  DEFAULT_RETRY_POLICY,
  DEFAULT_ROUTE_CONSTRAINTS,
  DEFAULT_TESTS,
  PageHinkley,
  RecoveryController,
  assessApiHealth,
  brierScore,
  binaryClassification,
  canRetry,
  classifyApiFailure,
  diagnose,
  entropyOf,
  expectedCalibrationError,
  expectedInformationGain,
  filterCandidates,
  latencyCvar,
  logLoss,
  mulberry32,
  planRecovery,
  retryDelayMs,
  routeCost,
  selectNextTest,
  selectRoute,
  sigmoid,
  uniformPrior,
  type DiagnosticObservation,
  type RouteCandidate,
} from '../src/nani';

const NOW = 1_700_000_000_000;

function route(overrides: Partial<RouteCandidate> = {}): RouteCandidate {
  return {
    id: 'direct-1',
    kind: 'direct',
    authorized: true,
    tlsVerification: true,
    features: {
      successPrior: 0.5,
      latencyMs: 100,
      latencyStdMs: 20,
      jitterMs: 10,
      packetLoss: 0,
      recoveryMs: 500,
      resourceCost: 0.1,
      risk: 0.1,
    },
    ...overrides,
  };
}

describe('Bayesian diagnosis', () => {
  it('identifies DNS as the cause from a DNS-only failure', () => {
    const obs: DiagnosticObservation[] = [{ testId: 'dns-lookup', outcome: 'failure', at: NOW }];
    const result = diagnose(obs, DEFAULT_TESTS, NOW);
    expect(result.top).toBe('dns');
    // One test cannot make a cause certain; it must, however, discriminate.
    expect(result.confidence).toBeGreaterThan(0.25);
    expect(result.insufficientEvidence).toBe(false);
  });

  it('gains confidence when corroborating evidence repeats', () => {
    const obs: DiagnosticObservation[] = Array.from({ length: 4 }, (_, i) => ({
      testId: 'dns-lookup',
      outcome: 'failure',
      at: NOW + i,
    }));
    const result = diagnose(obs, DEFAULT_TESTS, NOW + 4);
    expect(result.top).toBe('dns');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('treats skipped and unknown outcomes as no evidence, not failure', () => {
    const obs: DiagnosticObservation[] = [
      { testId: 'dns-lookup', outcome: 'skipped', at: NOW },
      { testId: 'tcp-connect', outcome: 'unknown', at: NOW },
    ];
    const result = diagnose(obs, DEFAULT_TESTS, NOW);
    expect(result.evidenceCount).toBe(0);
    expect(result.top).toBeNull();
    expect(result.insufficientEvidence).toBe(true);
  });

  it('reduces entropy as informative evidence arrives', () => {
    const priorEntropy = entropyOf(uniformPrior());
    const one = diagnose([{ testId: 'tcp-connect', outcome: 'failure', at: NOW }], DEFAULT_TESTS, NOW);
    expect(one.entropy).toBeLessThan(priorEntropy);
    expect(one.evidenceCount).toBe(1);
  });

  it('discounts stale evidence instead of trusting it', () => {
    const fresh = diagnose([{ testId: 'dns-lookup', outcome: 'failure', at: NOW }], DEFAULT_TESTS, NOW);
    const stale = diagnose(
      [{ testId: 'dns-lookup', outcome: 'failure', at: NOW - 60 * 60 * 1000 }],
      DEFAULT_TESTS,
      NOW,
    );
    expect(stale.confidence).toBeLessThan(fresh.confidence);
  });

  it('never treats a zero-reliability observation as certainty', () => {
    const obs: DiagnosticObservation[] = [
      { testId: 'dns-lookup', outcome: 'failure', at: NOW, reliability: 0 },
    ];
    const result = diagnose(obs, DEFAULT_TESTS, NOW);
    expect(result.insufficientEvidence).toBe(true);
  });

  it('selects a test with positive information gain', () => {
    const posterior = uniformPrior();
    const choice = selectNextTest(posterior, DEFAULT_TESTS, new Set(), NOW);
    expect(choice).not.toBeNull();
    expect(choice!.informationGain).toBeGreaterThan(0);
  });

  it('respects an excluded test set', () => {
    const exclude = new Set(DEFAULT_TESTS.map((t) => t.id));
    expect(selectNextTest(uniformPrior(), DEFAULT_TESTS, exclude, NOW)).toBeNull();
  });

  it('reports zero gain for a test that cannot separate hypotheses', () => {
    const flat = {
      id: 'flat',
      layer: 'tcp' as const,
      label: 'flat',
      cost: 1,
      likelihoods: Object.fromEntries(
        Object.keys(uniformPrior()).map((h) => [
          h,
          { success: 0.25, failure: 0.25, timeout: 0.25, skipped: 0.25, unknown: 0 },
        ]),
      ),
    } as never;
    expect(expectedInformationGain(uniformPrior(), flat as never, NOW)).toBeLessThan(1e-6);
  });
});

describe('API health classification', () => {
  const cases: Array<[string, Parameters<typeof classifyApiFailure>[0], string]> = [
    ['DNS', { dns: false, at: NOW }, 'dns'],
    ['TCP', { tcp: false, at: NOW }, 'tcp'],
    ['TLS', { tls: false, at: NOW }, 'tls'],
    ['401', { status: 401, at: NOW }, 'auth'],
    ['403', { status: 403, at: NOW }, 'forbidden'],
    ['429', { status: 429, at: NOW }, 'rate-limit'],
    ['400', { status: 400, parsed: true, at: NOW }, 'invalid-request'],
    ['500', { status: 500, at: NOW }, 'server'],
    ['malformed', { status: 200, parsed: false, at: NOW }, 'malformed-response'],
    ['timeout', { timedOut: true, at: NOW }, 'timeout'],
    ['reset', { reset: true, at: NOW }, 'reset'],
  ];

  it.each(cases)('classifies %s correctly', (_name, probe, expected) => {
    expect(classifyApiFailure(probe).category).toBe(expected);
  });

  it('does not recommend a route change for an authentication failure', () => {
    const result = classifyApiFailure({ status: 401, at: NOW });
    expect(result.action).toBe('fix-credentials');
    expect(result.retryable).toBe(false);
  });

  it('never recommends disabling TLS verification', () => {
    const result = classifyApiFailure({ tls: false, at: NOW });
    expect(result.action).toBe('none');
    expect(result.explanation).toMatch(/must stay enabled/i);
  });

  it('marks a fully verified operation as healthy', () => {
    const result = assessApiHealth({
      dns: true,
      tcp: true,
      tls: true,
      status: 200,
      parsed: true,
      operationOk: true,
      at: NOW,
    });
    expect(result.status).toBe('healthy');
  });

  it('does not call HTTP 200 with a failed operation healthy', () => {
    const result = assessApiHealth({
      dns: true,
      tcp: true,
      tls: true,
      status: 200,
      parsed: true,
      operationOk: false,
      at: NOW,
    });
    expect(result.status).not.toBe('healthy');
  });
});

describe('retry and circuit breaking', () => {
  const policy = { baseMs: 100, maxMs: 1000, factor: 2, jitter: 0, maxAttempts: 4 };

  it('grows exponentially and caps at maxMs', () => {
    expect(retryDelayMs(0, policy)).toBe(100);
    expect(retryDelayMs(2, policy)).toBe(400);
    expect(retryDelayMs(10, policy)).toBe(1000);
  });

  it('honours Retry-After and caps it', () => {
    expect(retryDelayMs(0, policy, { retryAfterSeconds: 3 })).toBe(1000);
  });

  it('applies jitter within the configured band', () => {
    const low = retryDelayMs(0, { ...policy, jitter: 0.2 }, { rng: () => 0 });
    const high = retryDelayMs(0, { ...policy, jitter: 0.2 }, { rng: () => 1 });
    expect(low).toBe(80);
    expect(high).toBe(120);
  });

  it('bounds the number of attempts', () => {
    expect(canRetry(0, DEFAULT_RETRY_POLICY)).toBe(true);
    expect(canRetry(DEFAULT_RETRY_POLICY.maxAttempts - 1, DEFAULT_RETRY_POLICY)).toBe(false);
  });

  it('opens, cools down, half-opens and closes', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, successThreshold: 2, openMs: 1000 });
    for (let i = 0; i < 3; i += 1) breaker.recordFailure(0);
    expect(breaker.currentState).toBe('open');
    expect(breaker.allow(500)).toBe(false);
    expect(breaker.allow(1000)).toBe(true);
    expect(breaker.currentState).toBe('half-open');
    breaker.recordSuccess();
    breaker.recordSuccess();
    expect(breaker.currentState).toBe('closed');
  });

  it('re-opens on a half-open failure', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, successThreshold: 1, openMs: 10 });
    breaker.recordFailure(0);
    expect(breaker.allow(10)).toBe(true);
    breaker.recordFailure(10);
    expect(breaker.currentState).toBe('open');
  });
});

describe('calibrated success prediction', () => {
  it('has a numerically stable sigmoid', () => {
    expect(sigmoid(0)).toBeCloseTo(0.5);
    expect(sigmoid(1000)).toBe(1);
    expect(sigmoid(-1000)).toBe(0);
  });

  it('learns to separate a linearly separable feature', () => {
    const model = new BayesianLogistic(2);
    const positive = [1, 1];
    const negative = [1, -1];
    for (let i = 0; i < 40; i += 1) {
      model.observe(positive, 1);
      model.observe(negative, 0);
    }
    const pPositive = model.predict(positive).probability;
    const pNegative = model.predict(negative).probability;
    expect(pPositive).toBeGreaterThan(0.7);
    expect(pNegative).toBeLessThan(0.3);
  });

  it('reports a conservative bound below the mean probability', () => {
    const model = new BayesianLogistic(2);
    const prediction = model.predict([1, 1]);
    expect(prediction.conservative).toBeLessThanOrEqual(prediction.probability + 1e-9);
  });

  it('is deterministic for a fixed seed', () => {
    const model = new BayesianLogistic(2);
    const a = model.sampleProbability([1, 0.5], mulberry32(42));
    const b = model.sampleProbability([1, 0.5], mulberry32(42));
    expect(a).toBe(b);
  });
});

describe('safe route selection', () => {
  it('rejects unauthorized, unverified and high-risk candidates before scoring', () => {
    const { allowed, rejected } = filterCandidates(
      [
        route({ id: 'ok' }),
        route({ id: 'unauthorized', authorized: false }),
        route({ id: 'no-tls', tlsVerification: false }),
        route({ id: 'risky', features: { ...route().features, risk: 0.9 } }),
      ],
      DEFAULT_ROUTE_CONSTRAINTS,
    );
    expect(allowed.map((c) => c.id)).toEqual(['ok']);
    expect(rejected.map((r) => r.id)).toEqual(['unauthorized', 'no-tls', 'risky']);
  });

  it('never selects an unauthorized route, even with the best prior', () => {
    const model = new BayesianLogistic(2);
    const selection = selectRoute(
      [
        route({ id: 'fast-but-unauthorized', authorized: false, features: { ...route().features, successPrior: 1 } }),
        route({ id: 'ok' }),
      ],
      model,
      { featuresOf: (c) => [1, c.features.successPrior], rng: mulberry32(1) },
    );
    expect(selection.candidate?.id).toBe('ok');
    expect(selection.rejected.map((r) => r.id)).toContain('fast-but-unauthorized');
  });

  it('is deterministic for the same seed', () => {
    const model = new BayesianLogistic(2);
    const candidates = [route({ id: 'a' }), route({ id: 'b' })];
    const make = () =>
      selectRoute(candidates, model, { featuresOf: (c) => [1, c.features.successPrior], rng: mulberry32(7) })
        .candidate?.id;
    expect(make()).toBe(make());
  });

  it('returns no candidate when every route is filtered out', () => {
    const selection = selectRoute([route({ authorized: false })], new BayesianLogistic(2), {
      featuresOf: () => [1],
      rng: mulberry32(1),
    });
    expect(selection.candidate).toBeNull();
  });

  it('penalises the latency tail and prefers higher success', () => {
    const safe = route({ id: 'safe', features: { ...route().features, successPrior: 0.95 } });
    const risky = route({ id: 'risky', features: { ...route().features, successPrior: 0.4 } });
    expect(routeCost(safe.features, safe.features.successPrior)).toBeLessThan(
      routeCost(risky.features, risky.features.successPrior),
    );

    const tail = latencyCvar({ ...route().features, latencyStdMs: 200 });
    expect(tail).toBeGreaterThan(route().features.latencyMs);

    const wide = route({ id: 'wide', features: { ...route().features, latencyStdMs: 300 } });
    expect(routeCost(wide.features, 0.9)).toBeGreaterThan(routeCost(route().features, 0.9));
  });
});

describe('drift detection', () => {
  it('Page–Hinkley flags a sustained upward shift', () => {
    const detector = new PageHinkley({ delta: 0.005, threshold: 3 });
    for (let i = 0; i < 50; i += 1) detector.update(0.05);
    let flagged = false;
    for (let i = 0; i < 10; i += 1) flagged = detector.update(0.9).drift || flagged;
    expect(flagged).toBe(true);
  });

  it('Page–Hinkley stays quiet on a stable process', () => {
    const detector = new PageHinkley({ delta: 0.005, threshold: 3 });
    let flagged = false;
    for (let i = 0; i < 100; i += 1) flagged = detector.update(0.5 + (i % 2) * 0.001).drift || flagged;
    expect(flagged).toBe(false);
  });

  it('CUSUM detects a step change', () => {
    const cusum = new Cusum({ target: 0.1, slack: 0.02, threshold: 2 });
    for (let i = 0; i < 10; i += 1) cusum.update(0.1);
    let flagged = false;
    for (let i = 0; i < 5; i += 1) flagged = cusum.update(0.9).drift || flagged;
    expect(flagged).toBe(true);
  });
});

describe('evaluation metrics', () => {
  it('computes Brier and log loss for known values', () => {
    const predictions = [
      { p: 1, y: 1 as const },
      { p: 0, y: 0 as const },
    ];
    expect(brierScore(predictions)).toBeCloseTo(0, 6);
    expect(logLoss(predictions)).toBeLessThan(1e-9);
  });

  it('reports zero calibration error for perfectly calibrated bins', () => {
    const predictions = [
      { p: 0.05, y: 0 as const },
      { p: 0.95, y: 1 as const },
    ];
    expect(expectedCalibrationError(predictions, 10)).toBeLessThan(0.06);
  });

  it('scores a binary classifier', () => {
    const result = binaryClassification([true, true, false, false], [true, false, false, true]);
    expect(result.truePositives).toBe(1);
    expect(result.falsePositives).toBe(1);
    expect(result.falseNegatives).toBe(1);
    expect(result.accuracy).toBeCloseTo(0.5);
  });
});

describe('bounded recovery', () => {
  it('plans probe → activate → verify and exposes one step at a time', () => {
    const plan = planRecovery([route({ id: 'r1' })], undefined, undefined, 'known-good');
    expect(plan.status).toBe('ready');
    expect(plan.steps.map((s) => s.kind)).toEqual([
      'probe-direct',
      'activate-route',
      'verify-operation',
      'rollback',
    ]);
    const controller = new RecoveryController(plan);
    expect(controller.next(NOW)?.id).toBe('r1:probe');
  });

  it('reports insufficient evidence when nothing is authorized', () => {
    const plan = planRecovery([route({ authorized: false })]);
    expect(plan.status).toBe('insufficient-evidence');
    expect(plan.steps).toHaveLength(0);
  });

  it('makes rollback runnable after a failed activation and cools the route down', () => {
    const plan = planRecovery([route({ id: 'r1' })], undefined, undefined, 'known-good');
    const controller = new RecoveryController(plan, {
      maxAttempts: 2,
      maxSteps: 12,
      failureCooldownMs: 1000,
      minExpectedSuccess: 0.5,
    });

    expect(controller.next(NOW)?.id).toBe('r1:probe');
    controller.record({ stepId: 'r1:probe', status: 'succeeded' }, NOW);
    expect(controller.next(NOW)?.id).toBe('r1:activate');
    controller.record({ stepId: 'r1:activate', status: 'failed' }, NOW);

    // The failed route is cooling down; the rollback is the runnable step.
    expect(controller.next(NOW)?.id).toBe('rollback:known-good');
  });

  it('stops after maxAttempts', () => {
    const plan = planRecovery([route({ id: 'r1' }), route({ id: 'r2' })], undefined, undefined, null);
    const controller = new RecoveryController(plan, {
      maxAttempts: 1,
      maxSteps: 12,
      failureCooldownMs: 0,
      minExpectedSuccess: 0.5,
    });
    controller.record({ stepId: 'r1:activate', status: 'failed' }, NOW);
    expect(controller.snapshot().exhausted).toBe(true);
    expect(controller.next(NOW)).toBeNull();
  });

  it('ends the plan on verified success and never offers a rollback', () => {
    const plan = planRecovery([route({ id: 'r1' })], undefined, undefined, 'known-good');
    const controller = new RecoveryController(plan);
    controller.record({ stepId: 'r1:probe', status: 'succeeded' }, NOW);
    controller.record({ stepId: 'r1:activate', status: 'succeeded' }, NOW);
    controller.record({ stepId: 'r1:verify', status: 'succeeded' }, NOW);
    expect(controller.next(NOW)).toBeNull();
    expect(controller.snapshot().done).toBe(true);
  });

  it('never marks a success indicator before verification', () => {
    const plan = planRecovery([route({ id: 'r1' })]);
    const controller = new RecoveryController(plan);
    controller.record({ stepId: 'r1:probe', status: 'succeeded' }, NOW);
    controller.record({ stepId: 'r1:activate', status: 'succeeded' }, NOW);
    const snapshot = controller.snapshot();
    expect(snapshot.statuses.find((s) => s.stepId === 'r1:verify')?.status).toBe('pending');
    expect(snapshot.done).toBe(false);
  });
});
