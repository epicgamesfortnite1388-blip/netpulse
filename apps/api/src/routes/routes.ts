import { z } from 'zod';

import { AppError } from '../util/appError';

import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context';

const TargetSchema = z.string().trim().min(1).max(253);

const RouteTestSchema = z.object({
  target: TargetSchema,
  family: z.union([z.literal(4), z.literal(6)]).optional(),
  maxHops: z.number().int().min(3).max(30).optional(),
  timeoutMs: z.number().int().min(300).max(5_000).optional(),
  measureLoss: z.boolean().optional(),
});

const RouteCompareSchema = z.object({
  target: TargetSchema,
  maxHops: z.number().int().min(3).max(30).optional(),
});

export function registerRouteRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/v1/route-test', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = RouteTestSchema.safeParse(req.body);
    if (!parsed.success) throw parsed.error;
    const testId = crypto.randomUUID();
    void ctx.services.route.runTrace(parsed.data, testId).catch(() => undefined);
    return reply.status(202).send({ testId });
  });

  app.post('/api/v1/route-compare', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = RouteCompareSchema.safeParse(req.body);
    if (!parsed.success) throw parsed.error;
    const testId = crypto.randomUUID();
    void ctx.services.route.runComparison(parsed.data, testId).catch(() => undefined);
    return reply.status(202).send({ testId });
  });

  // Direct-vs-VPN comparison from stored traces (no new measurement runs).
  app.get('/api/v1/route-compare/vpn/history', async (req) => {
    const q = req.query as { limit?: string };
    return { routes: ctx.services.route.listRouteHistory({ limit: Number(q.limit) || undefined }) };
  });

  app.get('/api/v1/route-compare/vpn', async (req) => {
    const q = req.query as { target?: string; limit?: string };
    const target = (q.target ?? '').trim();
    if (!target || target.length > 253) {
      throw new AppError(400, 'invalid_target', 'Provide a target host or IP (max 253 chars).');
    }
    return ctx.services.route.compareVpnRoutes(target, { limit: Number(q.limit) || undefined });
  });
}
