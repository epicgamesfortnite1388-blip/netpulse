import { z } from 'zod';

import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context';

const MeasureSchema = z.object({
  targetId: z.string().trim().min(1).max(120).optional(),
  custom: z
    .object({
      host: z.string().trim().min(1).max(253),
      protocol: z.enum(['tcp', 'udp', 'tls', 'https', 'dns']).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      name: z.string().trim().max(80).optional(),
      family: z.union([z.literal(4), z.literal(6), z.literal('auto')]).optional(),
    })
    .optional(),
});

const ListQuerySchema = z.object({
  targetId: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(250).default(50),
});

export function registerMapRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/map/targets', async () => ({ targets: ctx.services.map.listTargets() }));

  app.post('/api/v1/map/measure', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (req) => {
    const parsed = MeasureSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw parsed.error;
    if (!parsed.data.targetId && !parsed.data.custom?.host) {
      throw Object.assign(new Error('Provide targetId or a custom host'), { statusCode: 400, code: 'no_target' });
    }
    return ctx.services.map.measure(parsed.data);
  });

  app.get('/api/v1/map/observations', async (req) => {
    const parsed = ListQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) throw parsed.error;
    const rows = ctx.services.map.listObservations(parsed.data);
    return {
      observations: rows.map((r) => r.payload),
      total: rows.length,
    };
  });

  app.get('/api/v1/map/observations/:id', async (req) => {
    const { id } = req.params as { id: string };
    const row = ctx.services.map.observation(id);
    if (!row) throw Object.assign(new Error(`Observation "${id}" not found`), { statusCode: 404, code: 'not_found' });
    return { observation: row.payload };
  });

  app.post('/api/v1/map/observations/clear', async () => ctx.services.map.clearObservations());

  app.get('/api/v1/map/local', async () => ctx.services.map.localInfo());

  app.get('/api/v1/map/compare', async (req) => {
    const { targetId } = req.query as { targetId?: string };
    if (!targetId) throw Object.assign(new Error('targetId query parameter required'), { statusCode: 400, code: 'bad_request' });
    return ctx.services.map.compare(targetId);
  });

  app.get('/api/v1/map/connections', async () => ctx.services.map.activeConnections());

  const SweepSchema = z.object({
    targetIds: z.array(z.string().trim().min(1).max(120)).max(60).optional(),
  });

  app.post('/api/v1/map/sweep', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    const parsed = SweepSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw parsed.error;
    return ctx.services.map.startSweep(parsed.data.targetIds ?? null);
  });

  app.get('/api/v1/map/sweep/:id', async (req) => {
    const { id } = req.params as { id: string };
    const sweep = ctx.services.map.sweep(id);
    if (!sweep) throw Object.assign(new Error(`Sweep "${id}" not found`), { statusCode: 404, code: 'not_found' });
    return { sweep };
  });
}