import { describe, expect, it, vi } from 'vitest';
import type { NaniEventEnvelope, NaniEventPayload, NaniEventType } from '@netpulse/shared';

import { NaniService } from '../src/services/naniService';

interface Published {
  topic: string;
  envelope: NaniEventEnvelope<NaniEventPayload>;
}

function fixture() {
  const published: Published[] = [];
  const bus = {
    publish: vi.fn((topic: string, msg: NaniEventEnvelope<NaniEventPayload>) => {
      published.push({ topic, envelope: msg });
    }),
  };
  const events = { record: vi.fn() };
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as any;
  const nani = new NaniService({
    controller: {} as any,
    bus: bus as any,
    events: events as any,
    log,
  });
  nani.registerApi({
    id: 'provider',
    provider: 'test-provider',
    endpoint: 'provider.example:443',
    authType: 'none',
    healthCheck: 'http-get',
    timeoutMs: 1_000,
    directPermitted: true,
    autoRecoveryPermitted: true,
    dependsOn: [],
  });
  const route = {
    id: 'direct-1',
    kind: 'direct',
    authorized: true,
    tlsVerification: true,
    features: {
      successPrior: 0.7,
      latencyMs: 100,
      latencyStdMs: 20,
      jitterMs: 5,
      packetLoss: 0,
      recoveryMs: 1_000,
      resourceCost: 0.2,
      risk: 0.1,
    },
  } as const;
  return { nani, published, route };
}

describe('NANI service event contract', () => {
  it('publishes only typed recovery events on matching bus topics', () => {
    const { nani, published, route } = fixture();
    nani.planRecovery('provider', [{ ...route, features: { ...route.features } }], 'fallback-1');
    nani.recordRecoveryStep('provider', { stepId: 'direct-1:verify', status: 'succeeded' });
    nani.rollbackToKnownGood('provider');
    nani.resetRecovery('provider');

    expect(published.length).toBeGreaterThan(0);
    for (const { topic, envelope } of published) {
      expect(envelope.version).toBe(1);
      expect(typeof envelope.seq).toBe('number');
      expect(typeof envelope.at).toBe('number');
      expect(topic).toBe(`nani:${envelope.type.split(':').slice(1).join(':')}`);
    }
    expect(published.map((p) => p.envelope.type)).toContain('nani:recovery:step:succeeded');
    expect(published.map((p) => p.envelope.type)).toContain('nani:recovery:rolledback');
    expect(published.map((p) => p.envelope.type)).toContain('nani:recovery:reset');

    const step = published.find((p) => p.envelope.type === 'nani:recovery:step:succeeded');
    expect(step?.envelope.payload).toMatchObject({
      stepId: 'direct-1:verify',
      kind: 'verify-operation',
      routeId: 'direct-1',
      status: 'succeeded',
    });
  });

  it('fills registry policy defaults for providers registered over the API', () => {
    const { nani } = fixture();
    const entry = nani.getRegistry().entries.get('provider');
    expect(entry?.rateLimit).toMatchObject({ maxRequests: expect.any(Number) });
    expect(entry?.retry).toMatchObject({ maxAttempts: expect.any(Number) });
    expect(entry?.routes).toEqual([]);
    expect(entry?.health).toBe('unknown');
  });

  it('uses the planned route kind in route-activated events', () => {
    const { nani, published } = fixture();
    const upstream = {
      id: 'proxy-1',
      kind: 'upstream-proxy',
      authorized: true,
      tlsVerification: true,
      features: {
        successPrior: 0.7,
        latencyMs: 100,
        latencyStdMs: 20,
        jitterMs: 5,
        packetLoss: 0,
        recoveryMs: 1_000,
        resourceCost: 0.2,
        risk: 0.1,
      },
    } as const;
    nani.planRecovery('provider', [{ ...upstream, features: { ...upstream.features } }], null);
    nani.recordRecoveryStep('provider', { stepId: 'proxy-1:verify', status: 'succeeded' });

    const activated = published.find((p) => p.envelope.type === 'nani:route:activated');
    expect(activated?.envelope.payload).toMatchObject({ routeId: 'proxy-1', kind: 'upstream-proxy' });
  });
});
