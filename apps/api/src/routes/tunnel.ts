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
  type GatewayMemoryEntry,
  type QuickConnectAttempt,
  type QuickConnectResult,
  type ScanProfileId,
} from '@netpulse/shared';
import { badRequest, newNotFound } from '../util/appError';
import { chainExitProtocolUnsupported, type DnsThroughTunnel } from '../services/proxyCores';
import { QuickConnectSchema, DiscoverSchema } from '@netpulse/shared';
import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context';
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

/** Bounded quick-connect: never spend more than this on the whole chain. */
const QUICK_BUDGET_MS = 90_000;
/** Candidates tried after the discovery run (each one is fully verified). */
const QUICK_DISCOVERY_ATTEMPTS = 3;
const QUICK_DEFAULT_MEMORY_ATTEMPTS = 2;

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

export function registerTunnelRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/vpn/tunnel/status', async () => {
    return { tunnel: ctx.services.tunnel.getStatus() };
  });

  app.post('/api/v1/vpn/tunnel/start', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = TunnelStartSchema.parse(req.body ?? {});
    const wantSystemProxy = body.systemProxy ?? DEFAULTS.systemProxy;
    const preferred = ctx.services.settings.get().proxyEngine?.preferred ?? 'auto';

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
        { systemProxy: wantSystemProxy, preferredEngine: preferred, bypass: activeBypass(ctx), dns: activeDns(ctx), source: 'explicit' },
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
      source,
    });
    return { tunnel: status };
  });

  app.post('/api/v1/vpn/tunnel/stop', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async () => {
    return { tunnel: await ctx.services.tunnel.stop() };
  });

  app.post('/api/v1/vpn/tunnel/reconnect', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async () => {
    const cur = ctx.services.tunnel.getStatus();
    if (!cur.nodeId) throw badRequest('tunnel_not_active', 'no tunnel to reconnect');
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
        source: 'explicit',
      }),
    };
  });

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
   */
  app.post('/api/v1/vpn/tunnel/quick', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    const body = QuickConnectSchema.parse(req.body ?? {});
    const settings = ctx.services.settings.get();
    const wantSystemProxy = body.systemProxy ?? DEFAULTS.systemProxy;
    const preferred = settings.proxyEngine?.preferred ?? 'auto';
    const bypass = activeBypass(ctx);
    const deadline = Date.now() + QUICK_BUDGET_MS;
    // The caller's profile wins over the stored setting. Declaring an input and
    // then ignoring it is worse than not accepting it: the request looks
    // honoured while a different trade-off runs.
    const profile = (body.profile ?? settings.vpn?.scanProfile ?? 'balanced') as ScanProfileId;

    const attempts: QuickConnectAttempt[] = [];
    const quickStartedAt = Date.now();

    /** Start the tunnel on one node and record the verified outcome. */
    const attempt = async (nodeId: string, source: QuickConnectAttempt['source'], name: string | null) => {
      const node = ctx.repos.publicNodes.get(nodeId);
      if (!node) return null;
      const startedAt = Date.now();
      const status = await ctx.services.tunnel.start(node, {
        systemProxy: wantSystemProxy,
        preferredEngine: preferred,
        bypass,
        dns: activeDns(ctx),
        source: source === 'memory' ? 'gateway-memory' : source === 'discovery' ? 'discovery' : 'auto',
      });
      const ok = status.state === 'active';
      attempts.push({
        nodeId,
        name: name ?? node.remark ?? null,
        host: node.host,
        port: node.port,
        source,
        ok,
        error: ok ? null : (status.error ?? 'tunnel did not come up'),
        exitIp: status.exitIp,
        tookMs: Date.now() - startedAt,
      });
      return ok ? status : null;
    };

    // 1) remembered gateways, best-first. A node that no longer exists is
    //    dropped from memory instead of being retried forever.
    const maxMemory = body.maxMemoryAttempts ?? QUICK_DEFAULT_MEMORY_ATTEMPTS;
    const remembered: GatewayMemoryEntry[] = ctx.services.gatewayMemory.ranked().slice(0, maxMemory);
    for (const g of remembered) {
      if (Date.now() > deadline) break;
      if (!ctx.repos.publicNodes.get(g.nodeId)) {
        ctx.services.gatewayMemory.forget(g.nodeId);
        continue;
      }
      const status = await attempt(g.nodeId, 'memory', g.name);
      if (status) {
        const memoryWin = finish(true, profile, attempts);
        ctx.services.vpnHistory.recordQuickConnectRun(memoryWin, Date.now() - quickStartedAt);
        return { tunnel: status, quick: memoryWin };
      }
    }

    // 2) nothing remembered worked — discover fresh candidates at the user's
    //    profile, then verify them one by one.
    if (Date.now() < deadline) {
      const report = await ctx.services.discovery.run({ profile });
      // The scan inside quick connect is a real discovery run; it lands in the
      // same history the dashboard reads, labelled with its origin.
      ctx.services.vpnHistory.recordDiscoveryRun(report, 'quick-connect', 'quick-connect');
      const ordered = [...report.outcomes]
        .filter((o) => o.failure === null)
        .sort((a, b) => (a.latencyMs ?? Number.POSITIVE_INFINITY) - (b.latencyMs ?? Number.POSITIVE_INFINITY))
        .slice(0, QUICK_DISCOVERY_ATTEMPTS);
      for (const candidate of ordered) {
        if (Date.now() > deadline) break;
        const status = await attempt(candidate.nodeId, 'discovery', candidate.name);
        if (status) {
          const wonResult = finish(true, profile, attempts, report.summary);
          ctx.services.vpnHistory.recordQuickConnectRun(wonResult, Date.now() - quickStartedAt);
          return { tunnel: status, quick: wonResult };
        }
      }
      if (ordered.length === 0) {
        const noneResult = finish(false, profile, attempts, report.summary);
        ctx.services.vpnHistory.recordQuickConnectRun(noneResult, Date.now() - quickStartedAt);
        return {
          tunnel: ctx.services.tunnel.getStatus(),
          quick: noneResult,
        };
      }
    }

    const quickResult = finish(false, profile, attempts);
    ctx.services.vpnHistory.recordQuickConnectRun(quickResult, Date.now() - quickStartedAt);
    return { tunnel: ctx.services.tunnel.getStatus(), quick: quickResult };
  });

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

/** Honest summary of a quick-connect run: what was tried, what was proven. */
function finish(
  ok: boolean,
  profile: ScanProfileId,
  attempts: QuickConnectAttempt[],
  discoverySummary?: string,
): QuickConnectResult {
  const tried = attempts.length;
  let summary: string;
  if (ok) {
    const won = attempts[attempts.length - 1]!;
    summary =
      won.source === 'memory'
        ? `Reconnected to remembered gateway ${won.name ?? won.nodeId} — exit ${won.exitIp ?? 'unverified'}.`
        : `Connected through a newly discovered node ${won.name ?? won.nodeId} — exit ${won.exitIp ?? 'unverified'}.`;
  } else if (tried === 0) {
    // Nothing was even attempted: say so, and hand over the discovery report
    // so the user learns why (no nodes imported, filter too narrow, ...)
    // rather than reading a bare failure.
    summary = discoverySummary
      ? `Nothing was remembered, and discovery found nothing usable. ${discoverySummary}`
      : 'Nothing was remembered and nothing was discovered.';
  } else {
    summary = `Tried ${tried} candidate${tried === 1 ? '' : 's'}; none carried traffic.${discoverySummary ? ` ${discoverySummary}` : ''}`;
  }
  return { ok, profile, attempts, summary };
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
