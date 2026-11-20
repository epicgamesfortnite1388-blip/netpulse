import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/naniProbeAdapter', () => ({
  runDiagnosticTest: vi.fn(async (_c: unknown, test: { id: string }) => ({
    testId: test.id,
    outcome: 'success',
    at: Date.now(),
    reliability: 1,
  })),
}));

import { NaniService } from '../src/services/naniService';

function service() {
  const bus = { publish: vi.fn() };
  const events = { record: vi.fn() };
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as any;
  return new NaniService({ controller: {} as any, bus: bus as any, events: events as any, log });
}

function route(overrides: Record<string, unknown> = {}) {
  return {
    id: 'direct-1',
    kind: 'direct',
    authorized: true,
    tlsVerification: true,
    features: {
      successPrior: 0.6,
      latencyMs: 150,
      latencyStdMs: 40,
      jitterMs: 10,
      packetLoss: 0.01,
      recoveryMs: 2000,
      resourceCost: 0.3,
      risk: 0.2,
    },
    ...overrides,
  } as any;
}

function register(nani: NaniService) {
  nani.registerApi({
    id: 'provider',
    provider: 'test-provider',
    endpoint: 'provider.example:443',
    authType: 'none',
    healthCheck: 'http-get',
    timeoutMs: 1000,
    directPermitted: true,
    autoRecoveryPermitted: true,
    dependsOn: [],
  } as any);
}

describe('NaniService recovery controls', () => {
  it('exposes a newly registered API in listApis immediately', () => {
    const nani = service();
    expect(nani.listApis()).toHaveLength(0);
    register(nani);
    expect(nani.listApis().map((a) => a.entry.id)).toEqual(['provider']);
  });

  it('plans a ready recovery for an authorized, verified route', () => {
    const nani = service();
    register(nani);
    const plan = nani.planRecovery('provider', [route()], null);
    expect(plan.status).toBe('ready');
    expect(plan.steps.map((s) => s.id)).toEqual([
      'direct-1:probe',
      'direct-1:activate',
      'direct-1:verify',
    ]);
  });

  it('refuses to plan for an unauthorized route', () => {
    const nani = service();
    register(nani);
    const plan = nani.planRecovery('provider', [route({ authorized: false })], null);
    expect(plan.status).toBe('insufficient-evidence');
    expect(plan.steps).toHaveLength(0);
    expect(plan.reason).toMatch(/authorized/i);
  });

  it('rejects recovery for an unknown API', () => {
    const nani = service();
    expect(() => nani.planRecovery('missing', [route()], null)).toThrow('unknown api: missing');
  });

  it('refuses to record a step without an active plan', () => {
    const nani = service();
    register(nani);
    expect(() =>
      nani.recordRecoveryStep('provider', { stepId: 'direct-1:probe', status: 'succeeded' } as any),
    ).toThrow(/no active recovery controller/);
  });

  // ---------------------------------------------------------------------
  // Reset: the endpoint used to be a no-op that reported success anyway.
  // ---------------------------------------------------------------------

  it('reset discards the active recovery and reports what was cleared', () => {
    const nani = service();
    register(nani);
    const plan = nani.planRecovery('provider', [route()], null);
    expect(nani.nextRecoveryStep('provider', 0).step).not.toBeNull();

    const result = nani.resetRecovery('provider');

    expect(result.cleared).toBe(true);
    expect(result.previousRecoveryId).toBe(plan.recoveryId);
    expect(nani.nextRecoveryStep('provider', 0)).toEqual({
      step: null,
      snapshot: null,
      knownGoodRouteId: null,
    });
  });

  it('reset on an API with no plan reports nothing cleared instead of claiming success', () => {
    const nani = service();
    register(nani);

    const result = nani.resetRecovery('provider');

    expect(result.cleared).toBe(false);
    expect(result.previousRecoveryId).toBeNull();
  });

  it('a step recorded after reset is refused rather than silently dropped', () => {
    const nani = service();
    register(nani);
    nani.planRecovery('provider', [route()], null);
    nani.resetRecovery('provider');

    expect(() =>
      nani.recordRecoveryStep('provider', { stepId: 'direct-1:probe', status: 'succeeded' } as any),
    ).toThrow(/no active recovery controller/);
  });

  it('reset rejects an unknown API', () => {
    const nani = service();
    expect(() => nani.resetRecovery('missing')).toThrow(/unknown api: missing/);
  });

  // ---------------------------------------------------------------------
  // Rollback to known-good.
  // ---------------------------------------------------------------------

  it('a verified success becomes the known-good route', () => {
    const nani = service();
    register(nani);
    nani.planRecovery('provider', [route()], null);
    nani.recordRecoveryStep('provider', { stepId: 'direct-1:probe', status: 'succeeded' } as any);
    nani.recordRecoveryStep('provider', { stepId: 'direct-1:activate', status: 'succeeded' } as any);

    const result = nani.recordRecoveryStep('provider', { stepId: 'direct-1:verify', status: 'succeeded' } as any);

    expect(nani.nextRecoveryStep('provider', 0).knownGoodRouteId).toBe('direct-1');
    expect(result.status).toBe('succeeded');
  });

  it('rollback reverts an unfinished plan and skips the rest', () => {
    const nani = service();
    register(nani);
    // First pass verifies direct-1, which makes it the known-good route.
    nani.planRecovery('provider', [route()], null);
    nani.recordRecoveryStep('provider', { stepId: 'direct-1:probe', status: 'succeeded' } as any);
    nani.recordRecoveryStep('provider', { stepId: 'direct-1:activate', status: 'succeeded' } as any);
    nani.recordRecoveryStep('provider', { stepId: 'direct-1:verify', status: 'succeeded' } as any);
    nani.resetRecovery('provider');

    // Second pass: the operator plans again carrying the known-good route.
    const planned = nani.planRecovery('provider', [route()], 'direct-1');
    expect(planned.steps.map((s) => s.id)).toContain('rollback:direct-1');
    nani.recordRecoveryStep('provider', { stepId: 'direct-1:probe', status: 'succeeded' } as any);

    const rollback = nani.rollbackToKnownGood('provider', 1000);

    expect(rollback.routeId).toBe('direct-1');
    expect(rollback.recoveryId).toBe(planned.recoveryId);
    expect(rollback.revertedStepId).toBe('rollback:direct-1');
    const snapshot = rollback.snapshot as any;
    expect(snapshot.done).toBe(true);
    const statuses = new Map(snapshot.statuses.map((s: any) => [s.stepId, s.status]));
    expect(statuses.get('rollback:direct-1')).toBe('succeeded');
    expect(statuses.get('direct-1:probe')).toBe('succeeded');
    expect(rollback.skippedStepIds).toEqual(['direct-1:activate', 'direct-1:verify']);
    // No further step is offered once the plan is reverted.
    expect(nani.nextRecoveryStep('provider', 2000).step).toBeNull();
    expect(rollback.message).toMatch(/no network configuration was altered/);
  });

  it('does not claim a revert for a rollback step that targets another route', () => {
    const nani = service();
    register(nani);
    nani.planRecovery('provider', [route()], null);
    nani.recordRecoveryStep('provider', { stepId: 'direct-1:probe', status: 'succeeded' } as any);
    nani.recordRecoveryStep('provider', { stepId: 'direct-1:activate', status: 'succeeded' } as any);
    nani.recordRecoveryStep('provider', { stepId: 'direct-1:verify', status: 'succeeded' } as any);
    nani.resetRecovery('provider');

    // Plan names a different known-good route than the one that was verified.
    nani.planRecovery('provider', [route()], 'other-route');
    const rollback = nani.rollbackToKnownGood('provider', 1000);

    expect(rollback.routeId).toBe('direct-1');
    expect(rollback.revertedStepId).toBeNull();
    expect(rollback.message).not.toMatch(/recorded as succeeded/);
  });

  it('rollback publishes a recovered event naming the route and its source', () => {
    const bus = { publish: vi.fn() };
    const nani = new NaniService({
      controller: {} as any,
      bus: bus as any,
      events: { record: vi.fn() } as any,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as any,
    });
    register(nani);
    nani.planRecovery('provider', [route()], 'direct-1');
    nani.recordRecoveryStep('provider', { stepId: 'direct-1:probe', status: 'succeeded' } as any);
    bus.publish.mockClear();
    // Establish known-good through a verified success on a prior pass.
    nani.recordRecoveryStep('provider', { stepId: 'direct-1:activate', status: 'succeeded' } as any);
    nani.recordRecoveryStep('provider', { stepId: 'direct-1:verify', status: 'succeeded' } as any);
    bus.publish.mockClear();

    nani.rollbackToKnownGood('provider', 1000);

    const published = bus.publish.mock.calls.map((c) => c[0]);
    expect(published).toContain('nani:recovery:rolledback');
    const call = bus.publish.mock.calls.find((c) => c[0] === 'nani:recovery:rolledback');
    const envelope = call?.[1] as { payload?: Record<string, unknown> };
    expect(envelope?.payload).toMatchObject({
      apiId: 'provider',
      routeId: 'direct-1',
      source: 'operator',
    });
  });

  it('rollback refuses when no route was ever verified', () => {
    const nani = service();
    register(nani);
    nani.planRecovery('provider', [route()], null);

    expect(() => nani.rollbackToKnownGood('provider')).toThrow(/no known-good route recorded for provider/);
  });

  it('rollback rejects an unknown API', () => {
    const nani = service();
    expect(() => nani.rollbackToKnownGood('missing')).toThrow(/unknown api: missing/);
  });
});
