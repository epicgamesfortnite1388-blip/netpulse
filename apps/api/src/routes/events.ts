import { z } from 'zod';

import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context';

const QuerySchema = z.object({
  level: z.enum(['info', 'warn', 'error']).optional(),
  category: z.enum(['network', 'vpn', 'dns', 'routing', 'system']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.coerce.number().optional(),
});

export function registerEventRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/events', async (req) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) throw parsed.error;
    const { before, ...rest } = parsed.data;
    const events = ctx.services.events.list({ ...rest, beforeTs: before });
    return { events };
  });
}
