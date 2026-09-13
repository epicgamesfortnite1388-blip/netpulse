import { PingTestRequestSchema } from '@netpulse/shared';

import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context';

export function registerPingRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    '/api/v1/ping-test',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const parsed = PingTestRequestSchema.safeParse(req.body);
      if (!parsed.success) throw parsed.error;
      const result = await ctx.services.ping.runTest(parsed.data);
      return { testId: result.testId, result };
    },
  );
}
