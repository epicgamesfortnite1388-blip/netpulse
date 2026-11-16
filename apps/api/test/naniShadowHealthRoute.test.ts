import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerNaniRoutes } from '../src/routes/nani';
import type { AppContext } from '../src/routes/context';

const classification = {
  category: 'unknown',
  status: 'healthy',
  action: 'none',
  explanation: 'All probed layers succeeded.',
  retryable: false,
} as const;

function appWith(nani: Record<string, unknown>) {
  const app = Fastify();
  registerNaniRoutes(app, { services: { nani } } as unknown as AppContext);
  return app;
}

describe('GET /api/v1/nani/health/shadow', () => {
  it('returns buffered shadow assessments beside live health', async () => {
    const nani = {
      shadowSnapshot: vi.fn(() => [{ apiId: 'provider', at: 123, classification, probe: { at: 123 } }]),
      listApis: vi.fn(() => [
        { entry: { id: 'provider' }, health: 'degraded', failures: 2, successes: 7 },
      ]),
    };
    const app = appWith(nani);

    const res = await app.inject({ method: 'GET', url: '/api/v1/nani/health/shadow' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      count: 1,
      assessments: [
        {
          apiId: 'provider',
          at: 123,
          ageMs: expect.any(Number),
          shadow: classification,
          live: { health: 'degraded', failures: 2, successes: 7 },
        },
      ],
    });
    expect(nani.shadowSnapshot).toHaveBeenCalledOnce();
    expect(nani.listApis).toHaveBeenCalledOnce();
    await app.close();
  });

  it('reports a null live side when the provider is no longer registered', async () => {
    const app = appWith({
      shadowSnapshot: () => [{ apiId: 'gone', at: 456, classification, probe: {} }],
      listApis: () => [],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/nani/health/shadow' });

    expect(res.statusCode).toBe(200);
    expect(res.json().assessments[0]).toMatchObject({ apiId: 'gone', live: null });
    await app.close();
  });

  it('is GET-only', async () => {
    const app = appWith({ shadowSnapshot: () => [], listApis: () => [] });
    const res = await app.inject({ method: 'POST', url: '/api/v1/nani/health/shadow' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
