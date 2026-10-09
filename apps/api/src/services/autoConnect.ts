import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../routes/context';
import { type QuickConnectResult, type QuickConnectAttempt, normalizeBypass, type ScanProfileId } from '@netpulse/shared';

/**
 * Boot-time auto-connect MUST NOT enter the global VPN-op FIFO
 * (`serializeVpnOp` in `apps/api/src/vpn/networkOwnership.ts`). A slow
 * verification inside the boot quick (a 12s verification timeout on a
 * non-relaying remembered gateway, for example) would wedge every subsequent
 * user VPN action until it settled.
 *
 * The boot quick therefore calls the tunnel service's own internals directly
 * (its own `enqueue`/transition chain), which is independent of the global
 * `chain`. User-initiated `POST /api/v1/vpn/tunnel/quick` stays serialized
 * through `serializeVpnOp` (see `registerTunnelRoutes`) — it must be, because
 * it can race with a concurrent user start/stop/reconnect.
 */
export function runAutoConnectIfNeeded(app: FastifyInstance, ctx: AppContext): void {
  if (!ctx.services.settings.get().vpn?.autoConnect) return;
  app.log.info('autoConnect enabled — connecting the VPN in the background');
  void tryAutoConnect(app, ctx)
    .then((result) => {
      app.log.info(`Auto-connect finished: ${result.summary ?? 'no summary'}`);
    })
    .catch((err: unknown) => {
      app.log.warn(`Auto-connect failed: ${err instanceof Error ? err.message : String(err)}`);
    });
}

/** Quick-connect core, shared by the HTTP route and the boot autoConnect.
 *
 * This runs OUTSIDE the global `serializeVpnOp` when called by boot
 * `runAutoConnectIfNeeded`, and INSIDE it when called by the HTTP route
 * (`POST /api/v1/vpn/tunnel/quick`). The tunnel-service calls inside
 * (`ctx.services.tunnel.start(...)`) use the tunnel service's own internal
 * `enqueue` chain, not the global one.
 */
export async function quickConnectCore(ctx: AppContext, opts: {
  systemProxy: boolean;
  wantTun: boolean;
  maxMemoryAttempts?: number;
  profile?: string;
}): Promise<{ tunnel: ReturnType<typeof ctx.services.tunnel.getStatus>; quick: QuickConnectResult }> {
  await ctx.services.watchdog?.acknowledgeUserDisconnect();
  // Hand the network over from any engine VPN first — outside the tunnel
  // service's own chain, but still NOT inside the global serializeVpnOp
  // (boot autoConnect calls us directly; the HTTP route wraps us).
  const statuses = await Promise.all(ctx.vpn.all().map((p) => p.status().catch(() => null)));
  const active = statuses.find((s) => s?.connected);
  if (active?.providerId) {
    const provider = ctx.vpn.get(active.providerId);
    if (provider) {
      await provider.disconnect().catch(() => undefined);
      ctx.services.events.record(
        'info',
        'vpn',
        `Engine VPN "${active.serverName ?? active.providerId}" disconnected to hand the network over to the proxy tunnel`,
      );
    }
  }

  const settings = ctx.services.settings.get();
  const wantSystemProxy = opts.systemProxy;
  const wantTun = opts.wantTun;
  const preferred = settings.proxyEngine?.preferred ?? 'auto';
  const bypass = settings.vpn?.bypass?.enabled ? normalizeBypass(settings.vpn.bypass) : null;
  const deadline = Date.now() + 90_000;
  const profile = (opts.profile ?? settings.vpn?.scanProfile ?? 'balanced') as ScanProfileId;

  const attempts: QuickConnectAttempt[] = [];
  const quickStartedAt = Date.now();

  const attempt = async (nodeId: string, source: 'memory' | 'discovery', name: string | null) => {
    const node = ctx.repos.publicNodes.get(nodeId);
    if (!node) return null;
    const startedAt = Date.now();
    const status = await ctx.services.tunnel.start(node, {
      systemProxy: wantSystemProxy,
      preferredEngine: preferred,
      bypass,
      dns: settings.vpn?.dnsThroughVpn ? { doh: 'https://1.1.1.1/dns-query', plainFallback: '1.1.1.1' } : undefined,
      tun: wantTun,
      source: source === 'memory' ? 'gateway-memory' : 'discovery',
    });
    const ok = status.state === 'active';
    attempts.push({
      nodeId,
      name: name ?? node.remark ?? null,
      label: nodeLabelShared(node),
      endpointHidden: true,
      source: source === 'memory' ? 'memory' : 'discovery',
      ok,
      error: ok ? null : (status.error ?? 'tunnel did not come up'),
      exitIp: status.exitIp ?? null,
      tookMs: Date.now() - startedAt,
    });
    return ok ? status : null;
  };

  // 1) remembered gateways, best-first.
  const maxMemory = opts.maxMemoryAttempts ?? 2; // QUICK_DEFAULT_MEMORY_ATTEMPTS
  const remembered = ctx.services.gatewayMemory.ranked().slice(0, maxMemory);
  for (const g of remembered) {
    if (Date.now() > deadline) break;
    if (!ctx.repos.publicNodes.get(g.nodeId)) {
      ctx.services.gatewayMemory.forget(g.nodeId);
      continue;
    }
    const status = await attempt(g.nodeId, 'memory', g.name);
    if (status) {
      const memoryWin = finishQuick(true, profile, attempts);
      ctx.services.vpnHistory.recordQuickConnectRun(memoryWin, Date.now() - quickStartedAt);
      return { tunnel: status, quick: memoryWin };
    }
  }

  // 2) nothing remembered worked — discover fresh candidates.
  if (Date.now() < deadline) {
    const report = await ctx.services.discovery.run({ profile });
    ctx.services.vpnHistory.recordDiscoveryRun(report, 'quick-connect', 'quick-connect');
    const ordered = [...report.outcomes]
      .filter((o) => o.failure === null)
      .sort((a, b) => (a.latencyMs ?? Number.POSITIVE_INFINITY) - (b.latencyMs ?? Number.POSITIVE_INFINITY))
      .slice(0, 3);
    for (const candidate of ordered) {
      if (Date.now() > deadline) break;
      const status = await attempt(candidate.nodeId, 'discovery', candidate.name);
      if (status) {
        const wonResult = finishQuick(true, profile, attempts, report.summary);
        ctx.services.vpnHistory.recordQuickConnectRun(wonResult, Date.now() - quickStartedAt);
        return { tunnel: status, quick: wonResult };
      }
    }
    if (ordered.length === 0) {
      const noneResult = finishQuick(false, profile, attempts, report.summary);
      ctx.services.vpnHistory.recordQuickConnectRun(noneResult, Date.now() - quickStartedAt);
      return { tunnel: ctx.services.tunnel.getStatus(), quick: noneResult };
    }
  }

  const quickResult = finishQuick(false, profile, attempts);
  ctx.services.vpnHistory.recordQuickConnectRun(quickResult, Date.now() - quickStartedAt);
  return { tunnel: ctx.services.tunnel.getStatus(), quick: quickResult };
}

async function tryAutoConnect(app: FastifyInstance, ctx: AppContext): Promise<{ summary?: string }> {
  const result = await quickConnectCore(ctx, {
    systemProxy: true,
    wantTun: false,
  });
  return { summary: result.quick.summary };
}

/** Shared summary builder (mirrors `finish` in tunnel.ts). */
function finishQuick(
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
    summary = discoverySummary
      ? `Nothing was remembered, and discovery found nothing usable. ${discoverySummary}`
      : 'Nothing was remembered and nothing was discovered.';
  } else {
    summary = `Tried ${tried} candidate${tried === 1 ? '' : 's'}; none carried traffic.${discoverySummary ? ` ${discoverySummary}` : ''}`;
  }
  return { ok, profile, attempts, summary };
}

/** Shared node label — mirrors `nodeLabel` in `services/nodeView.ts`. */
function nodeLabelShared(node: { remark: string | null; id: string }): string {
  return node.remark ?? node.id;
}
