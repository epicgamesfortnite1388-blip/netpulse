import { z } from 'zod';

import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context';

const StartSchema = z.object({
  intervalMs: z.coerce.number().int().min(2_000).max(60_000).optional(),
});

export function registerStabilityRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/v1/stability/start', async (req) => {
    const parsed = StartSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw parsed.error;
    return ctx.services.stability.start(parsed.data.intervalMs);
  });

  app.post('/api/v1/stability/stop', async () => ctx.services.stability.stop());

  app.get('/api/v1/stability/status', async () => ctx.services.stability.status());

  app.get('/api/v1/stability/samples', async (req) => {
    const parsed = z
      .object({ limit: z.coerce.number().int().min(10).max(2_000).default(600) })
      .safeParse(req.query);
    if (!parsed.success) throw parsed.error;
    return { samples: ctx.repos.stability.recent(parsed.data.limit) };
  });
}
