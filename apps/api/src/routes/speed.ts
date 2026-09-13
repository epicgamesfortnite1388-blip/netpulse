import { z } from 'zod';

import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context';

const RunSchema = z.object({
  provider: z.string().max(32).optional(),
  downloadStreams: z.coerce.number().int().min(1).max(16).optional(),
  uploadStreams: z.coerce.number().int().min(1).max(16).optional(),
  durationMs: z.coerce.number().int().min(3_000).max(30_000).optional(),
});

const HistorySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function registerSpeedRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    '/api/v1/speed/run',
    { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = RunSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw parsed.error;
      const testId = crypto.randomUUID();
      void ctx.services.speed
        .runTest(parsed.data, { testId, signal: new AbortController().signal })
        .catch(() => undefined);
      return reply.status(202).send({ testId });
    },
  );

  app.get('/api/v1/speed/history', async (req) => {
    const parsed = HistorySchema.safeParse(req.query);
    if (!parsed.success) throw parsed.error;
    const tests = ctx.repos.tests.list({ type: 'speed', limit: parsed.data.limit });
    return { tests };
  });
}
