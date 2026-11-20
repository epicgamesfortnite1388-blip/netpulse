import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/naniProbeAdapter', () => ({
  runDiagnosticTest: vi.fn(async (_controller: unknown, test: { id: string }) => ({
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
  return { nani, bus, events, log };
}

describe('NaniService shadow assessment', () => {
  it('assesses configured providers without changing live state', async () => {
    const { nani, bus, events } = service();
    const before = JSON.stringify(nani.getRegistry().entries.get('provider'));

    const result = await nani.assessApiHealthShadow('provider');

    expect(result.classification.status).toBe('healthy');
    expect(result.classification.category).toBe('unknown');
    expect(JSON.stringify(nani.getRegistry().entries.get('provider'))).toBe(before);
    expect(nani.getRegistry().entries.get('provider')?.health).toBe('unknown');
    expect(nani.shadowSnapshot()).toHaveLength(1);
    expect(bus.publish).not.toHaveBeenCalled();
    expect(events.record).not.toHaveBeenCalled();
  });

  it('runs one pass over every configured provider', async () => {
    const { nani } = service();
    const results = await nani.runShadowHealthPass();
    expect(results.map((r) => r.apiId)).toEqual(['provider']);
    expect(nani.shadowSnapshot()).toHaveLength(1);
  });

  it('rejects an unknown provider', async () => {
    const { nani } = service();
    await expect(nani.assessApiHealthShadow('missing')).rejects.toThrow('unknown api: missing');
  });
});
