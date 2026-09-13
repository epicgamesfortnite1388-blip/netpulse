import { z } from 'zod';

import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context';

const QuerySchema = z.object({
  family: z.enum(['4', '6']).default('4'),
  force: z.enum(['true', 'false']).default('false'),
});

export function registerIpRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/ip', async (req) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) throw parsed.error;
    const family = parsed.data.family === '6' ? 6 : 4;
    const info = await ctx.services.ipInfo.lookup(family, { force: parsed.data.force === 'true' });
    return { info };
  });
}
