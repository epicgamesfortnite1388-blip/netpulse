import { z } from 'zod';

import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context';

const BufferbloatSchema = z.object({
  loadDurationMs: z.coerce.number().int().min(3_000).max(12_000).optional(),
});

export function registerDiagnosticRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    '/api/v1/diagnostics/complete',
    { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } },
    async (_req, reply) => {
      const testId = crypto.randomUUID();
      void ctx.services.diagnostics.runCompleteDiagnostic(testId).catch(() => undefined);
      return reply.status(202).send({ testId });
    },
  );

  app.post(
    '/api/v1/diagnostics/mtu',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = (req.body ?? {}) as { target?: string; family?: 4 | 6 };
      const testId = crypto.randomUUID();
      void ctx.services.diagnostics
        .mtuTest(body.target, body.family, testId)
        .catch(() => undefined);
      return reply.status(202).send({ testId });
    },
  );

  app.post(
    '/api/v1/diagnostics/cgnat',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async () => ctx.services.diagnostics.cgnatCheck(),
  );

  app.post(
    '/api/v1/diagnostics/bufferbloat',
    { config: { rateLimit: { max: 4, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = BufferbloatSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw parsed.error;
      const testId = crypto.randomUUID();
      void ctx.services.diagnostics
        .bufferbloatTest({ ...parsed.data, testId })
        .catch(() => undefined);
      return reply.status(202).send({ testId });
    },
  );
}
