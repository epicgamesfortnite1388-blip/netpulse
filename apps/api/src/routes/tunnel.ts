/**
 * Proxy tunnel routes — route the system through a tested public node.
 *
 * POST   /api/v1/vpn/tunnel/start      { nodeId?, auto?, systemProxy? }
 * POST   /api/v1/vpn/tunnel/stop
 * GET    /api/v1/vpn/tunnel/status
 * POST   /api/v1/vpn/tunnel/reconnect
 * GET    /api/v1/vpn/tunnel/gateways                 remembered last-known-good gateways
 * DELETE /api/v1/vpn/tunnel/gateways                 forget all
 * DELETE /api/v1/vpn/tunnel/gateways/:nodeId         forget one
 * POST   /api/v1/vpn/tunnel/quick      { systemProxy?, profile?, maxMemoryAttempts? }
 * POST   /api/v1/vpn/discover          { profile?, limit?, protocol? }
 */
import { z } from 'zod';

import {
  normalizeBypass,
  type BypassRuleSet,
} from '@netpulse/shared';
import { badRequest, newNotFound } from '../util/appError';
import { chainExitProtocolUnsupported, type DnsThroughTunnel } from '../services/proxyCores';
import { QuickConnectSchema, DiscoverSchema } from '@netpulse/shared';
import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context';
import { serializeVpnOp } from '../vpn/networkOwnership';
import { quickConnectCore } from '../services/autoConnect';
import type { PublicNodeRow } from '../db/repositories';
import type { TunnelNodeInput } from '../services/proxyTunnel';

export const TunnelStartSchema = z.object({
  /** explicit node id — or omit + auto:true to pick the best tested node */
  nodeId: z.string().trim().min(1).optional(),
  auto: z.boolean().optional(),
  systemProxy: z.boolean().optional(),
  /**
   * `nested` chains two local cores (entry hop → exit hop) so the observed
   * exit address is not the entry edge. Implied when either hop id is given.
   */
  mode: z.enum(['single', 'nested']).optional(),
  /** entry hop node id (nested only) */
  entryNodeId: z.string().trim().min(1).optional(),
  /** exit hop node id (nested only; `nodeId` is accepted as an alias) */
  exitNodeId: z.string().trim().min(1).optional(),
  /**
   * TUN mode: capture ALL system traffic (not just proxy-aware apps) by
   * putting a sing-box TUN gateway in front of the engine hop. Needs
   * administrator rights on Windows — a request that cannot be honoured
   * degrades to proxy mode with `tunError` set, never a silent fake.
   */
  tun: z.boolean().optional(),
});

const DEFAULTS = {
  systemProxy: true,
};

/** Encrypted resolver reached through the tunnel (dnsThroughVpn). */
const DNS_DOH_URL = 'https://1.1.1.1/dns-query';
/** Classic UDP fallback for exits where DoH is blocked (still via the node). */
const DNS_PLAIN_FALLBACK = '1.1.1.1';

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

/** Split-tunnel rules, applied only when the user enabled them. */
function activeBypass(ctx: AppContext): BypassRuleSet | null {
  const settings = ctx.services.settings.get();
  if (!settings.vpn?.bypass?.enabled) return null;
  const rules = normalizeBypass(settings.vpn.bypass);
  return rules;
}

/**
 * DNS-through-tunnel wiring, applied only when the user enabled it. The
 * resolver lives inside the tunnel core and egresses via the node outbound, so
 * lookups the core makes never touch the local network path.
 */
function activeDns(ctx: AppContext): DnsThroughTunnel | null {
  const settings = ctx.services.settings.get();
  if (!settings.vpn?.dnsThroughVpn) return null;
  return { doh: DNS_DOH_URL, plainFallback: DNS_PLAIN_FALLBACK };
}

/**
 * Auto-select server (settings.vpn.autoSelectServer): when off, the app never
 * picks a node itself — auto-start demands an explicit node and the route says
 * so instead of silently choosing for the user.
 */
function autoSelectEnabled(ctx: AppContext): boolean {
  return ctx.services.settings.get().vpn?.autoSelectServer ?? true;
}

/**
 * Hand the machine's network over from the engine VPNs to the proxy tunnel.
 *
 * The two modes write the same system proxy, arm the same kill-switch hold
 * and (in TUN form) claim the same default route; each captures a
 * `previousProxy` at its own start and restores it at stop. Starting the
 * tunnel while an engine still held those made the restore paths overwrite
 * each other — the survivor's handoff was wiped, or a mode restored a port
 * that had belonged to the mode before it, and traffic ended up on a dead
 * proxy. The only safe order is: the previous owner fully releases, then the
 * new mode starts.
 *
 * Callers MUST hold the ownership queue (serializeVpnOp) — that is what makes
 * "stop the other mode, then start this one" atomic against a connect arriving
 * from the other surface. The watchdog is acknowledged first, deliberately:
 * this is a mode switch, not a crash to recover from, and an unacknowledged
 * drop would let it reconnect the engine in the middle of the handover.
 */
async function handOverFromEngines(ctx: AppContext): Promise<void> {
  ctx.services.watchdog?.acknowledgeUserDisconnect();
  const statuses = await Promise.all(ctx.vpn.all().map((p) => p.status().catch(() => null)));
  const active = statuses.find((s) => s?.connected);
  if (!active?.providerId) return;
  const provider = ctx.vpn.get(active.providerId);
  if (!provider) return;
  await provider.disconnect().catch(() => undefined);
  ctx.services.events.record(
    'info',
    'vpn',
    `Engine VPN \"${active.serverName ?? active.providerId}\" disconnected to hand the network over to the proxy tunnel`,
  );
}

export function registerTunnelRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/vpn/tunnel/status', async () => {
    return { tunnel: ctx.services.tunnel.getStatus() };
  });

  app.post('/api/v1/vpn/tunnel/start', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => serializeVpnOp(async () => {
    await handOverFromEngines(ctx);
    const body = TunnelStartSchema.parse(req.body ?? {});
    const wantSystemProxy = body.systemProxy ?? DEFAULTS.systemProxy;
    const preferred = ctx.services.settings.get().proxyEngine?.preferred ?? 'auto';
    const wantTun = body.tun ?? false;

    /* ----------------------------- nested mode ----------------------------- */

    if (body.mode === 'nested' || body.entryNodeId || body.exitNodeId) {
      const exitId = body.exitNodeId ?? body.nodeId;
      const entryRow = body.entryNodeId ? ctx.repos.publicNodes.get(body.entryNodeId) : null;
      if (body.entryNodeId && !entryRow) throw newNotFound(`Node "${body.entryNodeId}" not found`);
      const exitRow = exitId ? ctx.repos.publicNodes.get(exitId) : null;
      if (exitId && !exitRow) throw newNotFound(`Node "${exitId}" not found`);

      // Auto-fill whichever hop the caller left out, from the tested pool.
      let exitPick: PublicNodeRow | null = exitRow ?? null;
      if (!exitPick) {
        if (!autoSelectEnabled(ctx)) throw badRequest('tunnel_auto_select_disabled', 'auto-select server is off — pick an exit node explicitly');
        exitPick = pickBestNode(ctx, entryRow?.id);
        if (!exitPick) throw badRequest('tunnel_no_candidates', 'no tested-healthy node available to tunnel through — run node tests first');
      }
      let entryPick: PublicNodeRow | null = entryRow ?? null;
      if (!entryPick) {
        if (!autoSelectEnabled(ctx)) throw badRequest('tunnel_auto_select_disabled', 'auto-select server is off — pick an entry node explicitly');
        entryPick = pickBestNode(ctx, exitPick.id);
        if (!entryPick) throw badRequest('tunnel_no_candidates', 'nested mode needs a second tested-healthy node for the entry hop — run more node tests first');
      }
      const exitNode: TunnelNodeInput = exitPick;
      const entryNode: TunnelNodeInput = entryPick;
      if (entryNode.id === exitNode.id) {
        throw badRequest('tunnel_same_node', 'nested mode needs two DIFFERENT nodes — pick a distinct entry and exit');
      }
      if (!tunnelable(exitPick)) throw badRequest('tunnel_node_untested', 'exit node has no recent successful proxy test — run a test before tunnelling through it');
      if (!tunnelable(entryPick)) throw badRequest('tunnel_node_untested', 'entry node has no recent successful proxy test — run a test before tunnelling through it');
      // Refuse a hop that provably cannot chain, instead of starting cores that
      // can only produce a direct (single-hop) path labelled as a chain.
      const why = chainExitProtocolUnsupported(exitNode.protocol);
      if (why) throw badRequest('tunnel_exit_unusable', why);

      const nested = await ctx.services.tunnel.startNested(
        { entry: entryNode, exit: exitNode },
        { systemProxy: wantSystemProxy, preferredEngine: preferred, bypass: activeBypass(ctx), dns: activeDns(ctx), tun: wantTun, source: 'explicit' },
      );
      return { tunnel: nested };
    }

    let nodeId = body.nodeId;
    let source: 'explicit' | 'auto' = 'explicit';
    if (!nodeId) {
      if (!body.auto) throw badRequest('tunnel_missing_target', 'provide nodeId or auto:true');
      if (!autoSelectEnabled(ctx)) throw badRequest('tunnel_auto_select_disabled', 'auto-select server is off — pick a node explicitly');
      const best = pickBestNode(ctx);
      if (!best) throw badRequest('tunnel_no_candidates', 'no tested-healthy node available to tunnel through — run node tests first');
      nodeId = best.id;
      source = 'auto';
    }

    const node = ctx.repos.publicNodes.get(nodeId);
    if (!node) throw newNotFound(`Node "${nodeId}" not found`);
    if (!tunnelable(node)) {
      throw badRequest('tunnel_node_untested', 'node has no recent successful proxy test — run a test before tunneling through it');
    }

    const status = await ctx.services.tunnel.start(node, {
      systemProxy: wantSystemProxy,
      preferredEngine: preferred,
      bypass: activeBypass(ctx),
      dns: activeDns(ctx),
      tun: wantTun,
      source,
    });
    return { tunnel: status };
  }));

  app.post('/api/v1/vpn/tunnel/stop', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async () => serializeVpnOp(async () => {
    return { tunnel: await ctx.services.tunnel.stop() };
  }));

  app.post('/api/v1/vpn/tunnel/reconnect', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async () => serializeVpnOp(async () => {
    const cur = ctx.services.tunnel.getStatus();
    if (!cur.nodeId) throw badRequest('tunnel_not_active', 'no tunnel to reconnect');
    await handOverFromEngines(ctx);
    // A nested tunnel re-establishes the whole pair it was started with —
    // re-resolving only the exit node would silently drop to one hop.
    if (cur.chain) return { tunnel: await ctx.services.tunnel.restartStored() };
    const node = ctx.repos.publicNodes.get(cur.nodeId);
    if (!node) throw newNotFound(`Node "${cur.nodeId}" no longer exists`);
    const preferred = ctx.services.settings.get().proxyEngine?.preferred ?? 'auto';
    return {
      tunnel: await ctx.services.tunnel.start(node, {
        systemProxy: cur.systemProxy,
        preferredEngine: preferred,
        bypass: activeBypass(ctx),
        dns: activeDns(ctx),
        tun: cur.tun === 'active' || cur.tun === 'requested',
        source: 'explicit',
      }),
    };
  }));

  /* --------------------------- gateway memory ---------------------------- */

  app.get('/api/v1/vpn/tunnel/gateways', async () => {
    return { gateways: ctx.services.gatewayMemory.ranked() };
  });

  app.delete('/api/v1/vpn/tunnel/gateways', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async () => {
    return { gateways: ctx.services.gatewayMemory.forget() };
  });

  app.delete('/api/v1/vpn/tunnel/gateways/:nodeId', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { nodeId } = req.params as { nodeId: string };
    const remaining = ctx.services.gatewayMemory.forget(nodeId);
    return { gateways: remaining };
  });

  /* ----------------------------- discovery ------------------------------- */

  app.post('/api/v1/vpn/discover', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    const body = DiscoverSchema.parse(req.body ?? {});
    const profile = (body.profile ?? ctx.services.settings.get().vpn?.scanProfile ?? 'balanced') as never;
    const report = await ctx.services.discovery.run({
      profile,
      ...(body.limit !== undefined ? { limit: body.limit } : {}),
      ...(body.protocol ? { protocol: body.protocol } : {}),
    });
    // Every completed run is history — the dashboard aggregates the real ones.
    ctx.services.vpnHistory.recordDiscoveryRun(report, 'manual', 'user');
    return { report };
  });

  /* --------------------------- quick connect ----------------------------- */

  /**
   * One click: retry the gateways this app has already proven, then discover
   * something new, and verify whichever candidate is tried. Every attempt is a
   * real tunnel start, so the result is never a memory-based claim.
   *
   * This route WRAPS the shared `quickConnectCore` (defined in
   * `autoConnect.ts`) in the global VPN-op FIFO (`serializeVpnOp`) so a user
   * quick-connect cannot race with a concurrent start/stop/reconnect. The boot
   * autoConnect path calls `quickConnectCore` DIRECTLY (no FIFO) so a slow
   * boot verification cannot wedge every subsequent user VPN action.
   */
  app.post('/api/v1/vpn/tunnel/quick', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => serializeVpnOp(async () => {
    const body = QuickConnectSchema.parse(req.body ?? {});
    return quickConnectCore(ctx, {
      systemProxy: body.systemProxy ?? DEFAULTS.systemProxy,
      wantTun: body.tun ?? false,
      maxMemoryAttempts: body.maxMemoryAttempts,
      profile: body.profile ?? undefined,
    });
  }));

  /* ------------------------------- history -------------------------------- */

  /**
   * Dashboard payload: per-profile discovery rollups + recent runs, quick
   * connect outcomes, and gateway reliability — every number computed from
   * stored rows (discovery/quick events + gateway memory), never invented.
   */
  app.get('/api/v1/vpn/history', async () => {
    return { history: ctx.services.vpnHistory.report() };
  });
}

/**
 * Auto-pick: best tested-healthy node by (recent reliability, then latency,
 * then freshness). Pure DB-derived ranking — no invention.
 */
function pickBestNode(ctx: AppContext, excludeNodeId?: string): PublicNodeRow | null {
  // Fetch the best-tested pool: proxyLatency sort already surfaces nodes with
  // measurements; widen the net so single-success nodes (lastProxyMs only)
  // are included, then rank in memory.
  const { rows } = ctx.repos.publicNodes.list({
    limit: 200,
    sortField: 'proxyLatency',
    sortDir: 'asc',
  });
  const healthy = rows.filter((r) => tunnelable(r) && (r.status === 'healthy' || r.status === 'degraded') && r.id !== excludeNodeId);
  if (healthy.length === 0) return null;
  // Among healthy, prefer highest reliability ratio, then lowest measured latency (median, then last).
  const ranked = [...healthy].sort((a, b) => {
    const ra = a.recentTestCount > 0 ? a.recentSuccessCount / a.recentTestCount : 0;
    const rb = b.recentTestCount > 0 ? b.recentSuccessCount / b.recentTestCount : 0;
    if (rb !== ra) return rb - ra;
    return (a.medianProxyMs ?? a.lastProxyMs ?? Infinity) - (b.medianProxyMs ?? b.lastProxyMs ?? Infinity);
  });
  return ranked[0]!;
}
