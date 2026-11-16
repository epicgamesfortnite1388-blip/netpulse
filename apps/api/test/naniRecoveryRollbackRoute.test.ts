import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerNaniRoutes } from '../src/routes/nani';
import type { AppContext } from '../src/routes/context';

function appWith(nani: Record<string, unknown>) {
  const app = Fastify();
  registerNaniRoutes(app, { services: { nani } } as unknown as AppContext);
  return app;
}

describe('NANI recovery rollback routes', () => {
  // The step poll once destructured knownGoodRouteId away, so the UI never saw
  // a rollback target and could not advertise the action at all.
  it('GET /recovery/next forwards the known-good route', async () => {
    const nani = {
      nextRecoveryStep: vi.fn(() => ({
        step: null,
        snapshot: { done: true, statuses: [] },
        knownGoodRouteId: 'direct-1',
      })),
    };
    const app = appWith(nani);

    const res = await app.inject({ method: 'GET', url: '/api/v1/nani/recovery/next?apiId=provider' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, knownGoodRouteId: 'direct-1' });
  });

  it('POST /recovery/rollback returns the service result', async () => {
    const nani = {
      rollbackToKnownGood: vi.fn(() => ({
        apiId: 'provider',
        routeId: 'direct-1',
        recoveryId: 'rec-1',
        skippedStepIds: ['direct-1:verify'],
        revertedStepId: 'rollback:direct-1',
        snapshot: { done: true },
        message: 'rolled back',
      })),
    };
    const app = appWith(nani);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/nani/recovery/rollback',
      payload: { apiId: 'provider' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      apiId: 'provider',
      routeId: 'direct-1',
      revertedStepId: 'rollback:direct-1',
    });
    expect(nani.rollbackToKnownGood).toHaveBeenCalledWith('provider');
  });

  it('POST /recovery/rollback answers 409 with a hint when nothing was verified', async () => {
    const nani = {
      rollbackToKnownGood: vi.fn(() => {
        throw new Error('no known-good route recorded for provider');
      }),
    };
    const app = appWith(nani);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/nani/recovery/rollback',
      payload: { apiId: 'provider' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: {
        code: 'no_known_good_route',
        message: expect.stringContaining('no known-good route'),
        hint: expect.stringContaining('Verify a route first'),
      },
    });
  });

  it('POST /recovery/rollback answers 404 for an unknown API', async () => {
    const nani = {
      rollbackToKnownGood: vi.fn(() => {
        throw new Error('unknown api: missing');
      }),
    };
    const app = appWith(nani);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/nani/recovery/rollback',
      payload: { apiId: 'missing' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'unknown_api' } });
  });
});
