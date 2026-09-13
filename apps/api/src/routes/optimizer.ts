import { z } from 'zod';

import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context';

const RunSchema = z.object({
  candidates: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(128),
        host: z.string().min(1).max(253),
        port: z.coerce.number().int().min(1).max(65535).optional(),
      }),
    )
    .max(32)
    .optional(),
  probes: z.coerce.number().int().min(1).max(10).optional(),
  withRoute: z.boolean().optional(),
});

export function registerOptimizerRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    '/api/v1/optimizer/run',
    { config: { rateLimit: { max: 4, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = RunSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw parsed.error;
      const testId = crypto.randomUUID();
      void ctx.services.optimizer.run(parsed.data, testId).catch((err) => {
        // the service never rejects for network reasons (per-candidate failures
        // become honest nulls) — this is a programming/DB error; log it instead
        // of swallowing it silently
        ctx.log.error({ err, testId }, 'optimizer run failed');
      });
      return reply.status(202).send({ testId });
    },
  );
}
