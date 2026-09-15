/**
 * Proxy tunnel routes — route the system through a tested public node.
 *
 * POST /api/v1/vpn/tunnel/start   { nodeId?, auto?, systemProxy? }
 * POST /api/v1/vpn/tunnel/stop
 * GET  /api/v1/vpn/tunnel/status
 * POST /api/v1/vpn/tunnel/reconnect
 */
import { z } from 'zod';

import { badRequest, newNotFound } from '../util/appError';
import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context';

export const TunnelStartSchema = z.object({
  /** explicit node id — or omit + auto:true to pick the best tested node */
  nodeId: z.string().trim().min(1).optional(),
  auto: z.boolean().optional(),
  systemProxy: z.boolean().optional(),
});

const DEFAULTS = {
  systemProxy: true,
};

/**
 * A node is tunnelable if a proxy test PROVABLY succeeded: either the median
 * exists (several successes) or the last proxy test succeeded within 7 days.
 * Recent success ratio is required when any recent attempts exist.
 */
const TUNNEL_FRESH_MS = 7 * 86_400_000;
function tunnelable(row: {
  medianProxyMs: number | null;
  lastProxyMs: number | null;
  lastSuccessAt: number | null;
  recentSuccessCount: number;
  recentFailureCount: number;
  status: string;
}): boolean {
  const hasSuccess = row.medianProxyMs !== null || (row.lastProxyMs !== null && row.lastSuccessAt != null && Date.now() - row.lastSuccessAt < TUNNEL_FRESH_MS);
  if (!hasSuccess) return false;
  if (row.recentSuccessCount + row.recentFailureCount > 0) {
    return row.recentSuccessCount >= row.recentFailureCount;
  }
  return true;
}

export function registerTunnelRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/vpn/tunnel/status', async () => {
    return { tunnel: ctx.services.tunnel.getStatus() };
  });

  app.post('/api/v1/vpn/tunnel/start', async (req) => {
    const body = TunnelStartSchema.parse(req.body ?? {});
    const wantSystemProxy = body.systemProxy ?? DEFAULTS.systemProxy;

    let nodeId = body.nodeId;
    if (!nodeId) {
      if (!body.auto) throw badRequest('tunnel_missing_target', 'provide nodeId or auto:true');
      const best = pickBestNode(ctx);
      if (!best) throw badRequest('tunnel_no_candidates', 'no tested-healthy node available to tunnel through — run node tests first');
      nodeId = best.id;
    }

    const node = ctx.repos.publicNodes.get(nodeId);
    if (!node) throw newNotFound(`Node "${nodeId}" not found`);
    if (!tunnelable(node)) {
      throw badRequest('tunnel_node_untested', 'node has no recent successful proxy test — run a test before tunneling through it');
    }

    const preferred = ctx.services.settings.get().proxyEngine?.preferred ?? 'auto';
    const status = await ctx.services.tunnel.start(node, { systemProxy: wantSystemProxy, preferredEngine: preferred });
    return { tunnel: status };
  });

  app.post('/api/v1/vpn/tunnel/stop', async () => {
    return { tunnel: await ctx.services.tunnel.stop() };
  });

  app.post('/api/v1/vpn/tunnel/reconnect', async () => {
    const cur = ctx.services.tunnel.getStatus();
    if (!cur.nodeId) throw badRequest('tunnel_not_active', 'no tunnel to reconnect');
    const node = ctx.repos.publicNodes.get(cur.nodeId);
    if (!node) throw newNotFound(`Node "${cur.nodeId}" no longer exists`);
    const preferred = ctx.services.settings.get().proxyEngine?.preferred ?? 'auto';
    return { tunnel: await ctx.services.tunnel.start(node, { systemProxy: cur.systemProxy, preferredEngine: preferred }) };
  });
}

/**
 * Auto-pick: best tested-healthy node by (recent reliability, then latency,
 * then freshness). Pure DB-derived ranking — no invention.
 */
function pickBestNode(ctx: AppContext): { id: string } | null {
  // Fetch the best-tested pool: proxyLatency sort already surfaces nodes with
  // measurements; widen the net so single-success nodes (lastProxyMs only)
  // are included, then rank in memory.
  const { rows } = ctx.repos.publicNodes.list({
    limit: 200,
    sortField: 'proxyLatency',
    sortDir: 'asc',
  });
  const healthy = rows.filter((r) => tunnelable(r) && (r.status === 'healthy' || r.status === 'degraded'));
  if (healthy.length === 0) return null;
  // Among healthy, prefer highest reliability ratio, then lowest measured latency (median, then last).
  const ranked = [...healthy].sort((a, b) => {
    const ra = a.recentTestCount > 0 ? a.recentSuccessCount / a.recentTestCount : 0;
    const rb = b.recentTestCount > 0 ? b.recentSuccessCount / b.recentTestCount : 0;
    if (rb !== ra) return rb - ra;
    return (a.medianProxyMs ?? a.lastProxyMs ?? Infinity) - (b.medianProxyMs ?? b.lastProxyMs ?? Infinity);
  });
  return { id: ranked[0]!.id };
}
