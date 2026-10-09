import { z } from 'zod';

import { AppError } from '../util/appError';

import type { FastifyInstance } from 'fastify';
import { nodeLabel } from '../services/nodeView';
import { scrubberFromRows } from '../services/endpointScrub';
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
    const routes = ctx.services.route.listRouteHistory({ limit: Number(q.limit) || undefined });
    // A stored trace can have been run against a node's own address (the map
    // traces node targets through this pipeline), so params/resolvedIp may
    // name it. Such a row is rewritten to the node's label — exactly what the
    // live comparison below does to its target — and its address field goes
    // null; rows for public or user-typed targets pass through untouched.
    const scrubber = scrubberFromRows(ctx.repos.publicNodes.listAddressRows());
    if (scrubber.size === 0) return { routes };
    return {
      routes: routes.map((r) => {
        const target = scrubber.mask(r.target);
        const hidden =
          scrubber.exactLabel(r.target) != null || (r.resolvedIp != null && scrubber.exactLabel(r.resolvedIp) != null);
        return {
          ...r,
          target,
          resolvedIp: hidden ? null : r.resolvedIp,
          ...(hidden ? { endpointHidden: true as const } : {}),
        };
      }),
    };
  });

  /**
 * Direct-vs-VPN comparison. Two ways in:
 *
 *   `?target=<host>` — a host the user typed. Echoing it discloses nothing.
 *   `?nodeId=<id>`   — a stored node the user picked. The address is the
 *                      node's configuration, so the row is resolved HERE and
 *                      the response names the node by its label instead. This
 *                      is what keeps the node-detail deep link working without
 *                      the browser ever holding the address.
 */
app.get('/api/v1/route-compare/vpn', async (req) => {
    const q = req.query as { target?: string; nodeId?: string; limit?: string };
    const nodeId = (q.nodeId ?? '').trim();
    const target = (q.target ?? '').trim();

    if (nodeId) {
      if (target) {
        throw new AppError(400, 'ambiguous_target', 'Give either a target host or a nodeId, not both.');
      }
      const row = ctx.repos.publicNodes.get(nodeId);
      if (!row) throw new AppError(404, 'not_found', `Node "${nodeId}" not found`);
      return ctx.services.route.compareVpnRoutes(
        { node: { host: row.host, ipv4: row.ipv4, ipv6: row.ipv6, label: nodeLabel(row) } },
        { limit: Number(q.limit) || undefined },
      );
    }

    if (!target || target.length > 253) {
      throw new AppError(400, 'invalid_target', 'Provide a target host or IP (max 253 chars), or a nodeId.');
    }
    return ctx.services.route.compareVpnRoutes({ target }, { limit: Number(q.limit) || undefined });
  });
}
