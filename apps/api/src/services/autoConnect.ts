import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../routes/context';
import {
  type ProxyEngineId,
  type QuickConnectResult,
  type QuickConnectAttempt,
  normalizeBypass,
  type ScanProfileId,
} from '@netpulse/shared';

import { findEngineBinary, PROXY_ENGINE_ORDER } from './proxyCores';
import { toParsedConfig } from './proxyTunnel';

import type { AdaptivePlan } from './adaptiveEngine';

/**
 * How many engines one candidate node may be tried with.
 *
 * Two, never more: the adaptive engine may learn that a different core reaches
 * the internet on this path, and a second attempt is how that gets tested — but
 * a node that needs five cores tried is a node wasting the user's probe budget,
 * and the discovery stage has its own candidates waiting.
 */
const MAX_ENGINE_ATTEMPTS_PER_NODE = 2;

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
  activityId?: string;
}): Promise<{ tunnel: ReturnType<typeof ctx.services.tunnel.getStatus>; quick: QuickConnectResult }> {
  const activityTopic = opts.activityId ? `quick-connect:${opts.activityId}` : null;
  const emit = (stage: string, message: string, detail?: Record<string, unknown>) => {
    if (!activityTopic) return;
    ctx.bus.publish(activityTopic, { type: 'quick-connect:activity', stage, message, at: Date.now(), ...detail });
  };
  emit('preparing', 'Preparing adaptive route checks');
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
      emit('handoff', 'Releasing the current VPN route');
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

  let attemptNumber = 0;
  const attempt = async (
    nodeId: string,
    source: 'memory' | 'discovery',
    name: string | null,
    /** the core to prefer for THIS attempt (already vetted as installed+compatible) */
    engine: ProxyEngineId,
  ) => {
    const node = ctx.repos.publicNodes.get(nodeId);
    if (!node) return null;
    const startedAt = Date.now();
    attemptNumber += 1;
    emit('attempt-start', `Attempting ${engine} with ${node.remark ?? 'candidate'}`, {
      attempt: attemptNumber,
      engine,
      node: node.remark ?? nodeLabelShared(node),
      source,
    });
    const status = await ctx.services.tunnel.start(node, {
      systemProxy: wantSystemProxy,
      preferredEngine: engine,
      bypass,
      dns: settings.vpn?.dnsThroughVpn ? { doh: 'https://1.1.1.1/dns-query', plainFallback: '1.1.1.1' } : undefined,
      tun: wantTun,
      source: source === 'memory' ? 'gateway-memory' : 'discovery',
      activity: activityTopic ? { topic: activityTopic } : undefined,
    });
    const ok = status.state === 'active';
    emit(ok ? 'connected' : 'attempt-failed', ok ? 'Tunnel verified through this route' : 'This core did not verify; evaluating the next option', {
      attempt: attemptNumber,
      engine,
      node: node.remark ?? nodeLabelShared(node),
      ok,
      latencyMs: Date.now() - startedAt,
      error: ok ? null : status.error ?? 'tunnel did not come up',
      exitIp: ok ? status.exitIp ?? null : null,
    });
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

  /**
   * Try one node with the engines the adaptive engine prefers, in its order.
   *
   * This is where the learning actually changes behaviour. Everything about it
   * is bounded: the engine list comes from the policy (which is derived from the
   * cores really installed and really compatible with this node), at most
   * `MAX_ENGINE_ATTEMPTS_PER_NODE` are attempted, and every outcome is reported
   * back with the tunnel's own verification result — `state === 'active'` alone
   * is NOT success, because the whole point of the earlier work on this path is
   * that a started core is not a working tunnel.
   */
  const attemptWithPlan = async (
    nodeId: string,
    source: 'memory' | 'discovery',
    name: string | null,
  ): Promise<ReturnType<typeof ctx.services.tunnel.getStatus> | null> => {
    const node = ctx.repos.publicNodes.get(nodeId);
    if (!node) return null;
    const baselineOrder: ProxyEngineId[] =
      preferred === 'auto' ? [...PROXY_ENGINE_ORDER] : [preferred, ...PROXY_ENGINE_ORDER.filter((e) => e !== preferred)];

    let plan: AdaptivePlan | null = null;
    try {
      // The SAME config mapping the tunnel dials, so "compatible" here means
      // compatible there.
      plan = ctx.services.adaptive.plan({ config: toParsedConfig(node), baselineOrder, profile, attemptBudget: 2 });
      if (plan.status === 'active') {
        ctx.services.events.record('info', 'vpn', `Adaptive engine: ${plan.note}`, { nodeId });
      }
      emit('adaptive-plan', plan.status === 'active' ? plan.note : 'Using the safe baseline core order', {
        node: name ?? node.remark ?? nodeId,
        engines: plan.order,
      });
      if (plan.exploratory) {
        ctx.services.events.record('info', 'vpn', `Adaptive engine: ${plan.exploratory.explanation}`, { nodeId });
      }
    } catch (err) {
      // The adaptive layer must never be able to stop a connection. A failure
      // here degrades to the plain default order.
      ctx.services.events.record('warn', 'vpn', `Adaptive engine unavailable for this attempt (${err instanceof Error ? err.message : String(err)}); using the default order`);
      plan = null;
    }

    const engines: ProxyEngineId[] = [];
    const push = (engine: ProxyEngineId | null | undefined): void => {
      if (!engine) return;
      if (engines.includes(engine)) return;
      if (engines.length >= MAX_ENGINE_ATTEMPTS_PER_NODE) return;
      engines.push(engine);
    };
    push(plan?.preferred ?? baselineOrder[0]);
    // Only a deliberate, enabled exploration is tried ahead of the fallback.
    if (plan?.exploratory) push(plan.exploratory.engine);
    // Recovery, bounded to one extra core: if the learned best fails, the next core
    // the policy approves is tried before the node is abandoned for discovery.
    // `push` enforces the cap, so this can never turn into a sweep of every core
    // on the machine — a node that needs three cores tried is a node wasting the
    // user's probe budget, and discovery has fresh candidates waiting.
    for (const engine of plan?.order ?? []) push(engine);

    for (const engine of engines) {
      emit('adaptive-choice', `Adaptive agent selected ${engine}`, {
        engine,
        node: name ?? node.remark ?? nodeId,
        attempt: attemptNumber + 1,
      });
      const startedAt = Date.now();
      const status = await attempt(nodeId, source, name, engine);
      const verified = status != null;
      // Read the tunnel's own error BEFORE the branch below narrows `status`.
      const failureMessage = status?.error ?? 'tunnel did not come up';
      try {
        ctx.services.adaptive.observe({
          nodeId,
          engine,
          ...(plan ? { context: plan.context } : {}),
          ok: verified,
          timeToWorkingMs: verified ? Date.now() - startedAt : null,
          failure: verified
            ? null
            : {
                ...failureStageFor(engine, status),
                message: failureMessage,
                engineUnavailable: findEngineBinary(engine) === null,
              },
        });
      } catch {
        // Recording an outcome must never break the attempt it describes.
      }
      if (status) return status;
    }
    return null;
  };

  // 1) remembered gateways, best-first.
  const maxMemory = opts.maxMemoryAttempts ?? 2; // QUICK_DEFAULT_MEMORY_ATTEMPTS
  const remembered = ctx.services.gatewayMemory.ranked().slice(0, maxMemory);
  emit('memory-check', remembered.length > 0 ? `Rechecking ${remembered.length} previously verified route(s)` : 'No remembered route; preparing a fresh discovery scan', {
    candidates: remembered.length,
  });
  for (const g of remembered) {
    if (Date.now() > deadline) break;
    if (!ctx.repos.publicNodes.get(g.nodeId)) {
      ctx.services.gatewayMemory.forget(g.nodeId);
      continue;
    }
    const status = await attemptWithPlan(g.nodeId, 'memory', g.name);
    if (status) {
      const memoryWin = finishQuick(true, profile, attempts);
      ctx.services.vpnHistory.recordQuickConnectRun(memoryWin, Date.now() - quickStartedAt);
      emit('complete', 'Route verified and ready', { ok: true, summary: memoryWin.summary, exitIp: status.exitIp ?? null });
      return { tunnel: status, quick: memoryWin };
    }
  }

  // 2) nothing remembered worked — discover fresh candidates.
  if (Date.now() < deadline) {
    emit('discovery-start', `Scanning candidates with the ${profile} profile`, { profile });
    const report = await ctx.services.discovery.run({
      profile,
      onProgress: (progress) => emit('candidate-probe', `${progress.label}: ${progress.ok ? `${progress.depth} check passed` : `check failed (${progress.failure ?? 'no response'})`}`, {
        done: progress.done,
        total: progress.total,
        profile: progress.profile,
        node: progress.label,
        ok: progress.ok,
        depth: progress.depth,
        latencyMs: progress.latencyMs,
        error: progress.failure,
      }),
    });
    ctx.services.vpnHistory.recordDiscoveryRun(report, 'quick-connect', 'quick-connect');
    const ordered = [...report.outcomes]
      .filter((o) => o.failure === null)
      .sort((a, b) => (a.latencyMs ?? Number.POSITIVE_INFINITY) - (b.latencyMs ?? Number.POSITIVE_INFINITY))
      .slice(0, 3);
    for (const candidate of ordered) {
      if (Date.now() > deadline) break;
      const status = await attemptWithPlan(candidate.nodeId, 'discovery', candidate.name);
      if (status) {
        const wonResult = finishQuick(true, profile, attempts, report.summary);
        ctx.services.vpnHistory.recordQuickConnectRun(wonResult, Date.now() - quickStartedAt);
        emit('complete', 'Route verified and ready', { ok: true, summary: wonResult.summary, exitIp: status.exitIp ?? null });
        return { tunnel: status, quick: wonResult };
      }
    }
    if (ordered.length === 0) {
      const noneResult = finishQuick(false, profile, attempts, report.summary);
      ctx.services.vpnHistory.recordQuickConnectRun(noneResult, Date.now() - quickStartedAt);
      emit('complete', 'No candidate passed the discovery checks', { ok: false, summary: noneResult.summary });
      return { tunnel: ctx.services.tunnel.getStatus(), quick: noneResult };
    }
  }

  const quickResult = finishQuick(false, profile, attempts);
  ctx.services.vpnHistory.recordQuickConnectRun(quickResult, Date.now() - quickStartedAt);
  emit('complete', 'Adaptive route search finished without a verified tunnel', { ok: false, summary: quickResult.summary });
  return { tunnel: ctx.services.tunnel.getStatus(), quick: quickResult };
}

async function tryAutoConnect(app: FastifyInstance, ctx: AppContext): Promise<{ summary?: string }> {
  const result = await quickConnectCore(ctx, {
    systemProxy: true,
    wantTun: false,
  });
  return { summary: result.quick.summary };
}

/**
 * Which stage a failed attempt got to, as far as the tunnel's own status says.
 *
 * Only two things are known for sure: the core did not come up, or it came up
 * and traffic was never verified through it. Both are stated as such, and the
 * classifier refines from the message (auth rejection, reset, timeout) — it never
 * concludes censorship.
 */
function failureStageFor(engine: ProxyEngineId, status: { state?: string; error?: string | null } | null): {
  stage: 'core-start' | 'verify';
} {
  if (findEngineBinary(engine) === null) return { stage: 'core-start' };
  const error = status?.error ?? '';
  if (/exited|not found|start|code \d+|spawn/i.test(error)) return { stage: 'core-start' };
  // The core reported active but the exit IP was never read through it, or the
  // tunnel came back down: either way the failure is at verification.
  return { stage: 'verify' };
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
