import { z } from 'zod';

import type { TestType } from '@netpulse/shared';
import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context';

// kept in sync with the shared TestType union via the satisfies check below
const TEST_TYPES = [
  'speed',
  'ping',
  'dns',
  'dns_leak',
  'route',
  'route_compare',
  'endpoint',
  'scan',
  'optimization',
  'bufferbloat',
  'mtu',
  'cgnat',
  'diagnostic',
  'webrtc',
  'gaming',
] as const satisfies readonly TestType[];

const QuerySchema = z.object({
  type: z.enum(TEST_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  before: z.coerce.number().optional(),
});

export function registerHistoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/history', async (req) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) throw parsed.error;
    const { before, ...rest } = parsed.data;
    const tests = ctx.repos.tests.list({ ...rest, beforeTs: before });
    return { tests };
  });

  app.get('/api/v1/history/:id', async (req) => {
    const { id } = req.params as { id: string };
    const test = ctx.repos.tests.get(id);
    if (!test) {
      return { test: null };
    }
    return { test };
  });
}
