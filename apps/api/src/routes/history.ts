import { z } from 'zod';

import { scrubEndpoints, scrubberFromRows } from '../services/endpointScrub';
import type { TestRow, TestSummaryRow } from '../db/repositories';
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
  /**
   * The endpoint boundary for STORED rows. Route tests are the only type that
   * can carry a stored node's own address: the live map traces node targets
   * through the ordinary route pipeline, so `params.target`, `summary.target`,
   * a trace's `resolvedIp`/destination hop, or an analysis sentence may name
   * it — written long before anyone looks at the row. Everything else (speed,
   * dns, gaming, user-typed traces) records public or user-supplied targets,
   * so only rows whose type is `route` pay for a node-address index, and only
   * when nodes exist. What matches is rewritten to the node's label; what
   * doesn't is passed through untouched.
   */
  const needsScrub = (rows: Array<{ type?: string }>): boolean => rows.some((r) => r.type === 'route');

  app.get('/api/v1/history', async (req) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) throw parsed.error;
    const { before, ...rest } = parsed.data;
    const tests = ctx.repos.tests.list({ ...rest, beforeTs: before });
    if (!needsScrub(tests)) return { tests };
    const scrubber = scrubberFromRows(ctx.repos.publicNodes.listAddressRows());
    if (scrubber.size === 0) return { tests };
    const scrubbed: TestSummaryRow[] = tests.map((t) =>
      t.type === 'route'
        ? { ...t, params: scrubEndpoints(t.params, scrubber), summary: scrubEndpoints(t.summary, scrubber) }
        : t,
    );
    return { tests: scrubbed };
  });

  app.get('/api/v1/history/:id', async (req) => {
    const { id } = req.params as { id: string };
    const test = ctx.repos.tests.get(id);
    if (!test) {
      return { test: null };
    }
    if (test.type !== 'route') return { test };
    const scrubber = scrubberFromRows(ctx.repos.publicNodes.listAddressRows());
    if (scrubber.size === 0) return { test };
    // The detail row includes `result` — the full stored trace and analysis,
    // the deepest place an address can hide.
    const scrubbed: TestRow = {
      ...test,
      params: scrubEndpoints(test.params, scrubber),
      summary: scrubEndpoints(test.summary, scrubber),
      result: scrubEndpoints(test.result, scrubber),
    };
    return { test: scrubbed };
  });
}
