import dns from 'node:dns/promises';

import type { IpFamily, RouteAnalysis, RouteFinding, RouteHop, RouteVpnTag, TraceResult, VpnRouteCompareResult, VpnRouteCompareSide } from '@netpulse/shared';
import { scoreRoute } from '@netpulse/shared';

import type { RealtimeBus } from '../realtime/bus';
import type { RouteComparisonRepository, TestsRepository } from '../db/repositories';
import type { PlatformNetworkController } from '../providers/platform/types';
import { parseCymruOrigin } from '../util/traceParse';
import { familyOfIp, pickIp, resolveTarget } from '../util/targetGuard';
import type { SettingsService } from './settingsService';
import type { EventService } from './eventService';

import type { Logger } from '../logger';

/** Minimal surface of the VPN registry the route service needs. */
export interface VpnStatusSource {
  status(): Promise<{ connected: boolean; providerId?: string | null; verifiedPublicIp?: string | null } | null>;
}

/* --------------------------- per-hop enrichment --------------------------- */

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/** Reverse DNS for a hop (1s budget, failures are not errors). */
async function reverseDns(ip: string): Promise<string | null> {
  try {
    const names = await withTimeout(dns.reverse(ip), 1_000);
    return names?.[0] ?? null;
  } catch {
    return null;
  }
}

/** ASN/org/country for a hop via Team Cymru's origin.asn DNS service (no HTTP dependency). */
async function asnFor(ip: string): Promise<{ asn: number | null; org: string | null; country: string | null }> {
  if (familyOfIp(ip) === 6) return { asn: null, org: null, country: null };
  const reversed = ip.split('.').reverse().join('.');
  try {
    const txts = await withTimeout(dns.resolveTxt(`${reversed}.origin.asn.cymru.com`), 1_500);
    const flat = txts?.map((parts) => parts.join('')) ?? [];
    const parsed = flat.map(parseCymruOrigin).find((v) => v !== null);
    return parsed ?? { asn: null, org: null, country: null };
  } catch {
    return { asn: null, org: null, country: null };
  }
}

async function enrichHops(hops: RouteHop[], concurrency = 5): Promise<RouteHop[]> {
  const result = [...hops];
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, result.length) }, async () => {
    for (;;) {
      const i = index++;
      const hop = result[i];
      if (!hop || hop.ip === null) return;
      const [hostname, asn] = await Promise.all([reverseDns(hop.ip), asnFor(hop.ip)]);
      hop.hostname = hostname;
      hop.asn = asn.asn;
      hop.org = asn.org;
      hop.country = asn.country;
    }
  });
  await Promise.all(workers);
  return result;
}

/* ------------------------------ analysis engine --------------------------- */

/**
 * Honest route analysis: distinguishes "non-responsive hop" (ICMP filtered /
 * deprioritized) from end-to-end loss (measured at the destination).
 * Never blames an intermediate hop for end-to-end loss.
 */
export function analyzeTrace(trace: TraceResult, opts: { lossPctAtDestination?: number | null; target: string }): RouteAnalysis {
  const findings: RouteFinding[] = [];
  const { hops } = trace;

  const responsive = hops.filter((h) => h.latencyMs != null);
  const unresponsive = hops.filter((h) => h.latencyMs == null);

  if (responsive.length >= 2) {
    // latency jump detection between consecutive responsive hops
    for (let i = 1; i < responsive.length; i++) {
      const prev = responsive[i - 1]!;
      const cur = responsive[i]!;
      const delta = (cur.latencyMs as number) - (prev.latencyMs as number);
      if (delta >= Math.max(20, (prev.latencyMs as number) * 2)) {
        findings.push({
          severity: delta >= 100 ? 'error' : 'warn',
          message: `Latency increases significantly between hop ${prev.hop} and hop ${cur.hop} (+${Math.round(delta)} ms).`,
        });
      }
    }
  }

  if (unresponsive.length > 0 && responsive.length > 0) {
    findings.push({
      severity: 'info',
      message: `${unresponsive.length} of ${hops.length} hops did not answer probes. This is usually ICMP filtering or deprioritization on those routers, not proof of packet loss — later hops still responded.`,
    });
  }

  const destLoss = opts.lossPctAtDestination ?? null;
  if (destLoss != null && destLoss > 0) {
    findings.push({
      severity: destLoss >= 5 ? 'error' : 'warn',
      message: `End-to-end packet loss to ${opts.target} measured at ${destLoss}%. This is measured at the destination, so it reflects real loss.`,
    });
  } else if (destLoss === 0) {
    findings.push({ severity: 'info', message: 'No measurable end-to-end packet loss to the destination.' });
  }

  if (trace.totalHops > 15) {
    findings.push({
      severity: 'info',
      message: `Unusually long path: ${trace.totalHops} hops. Extra hops can indicate detours or suboptimal peering.`,
    });
  }

  const lastHop = responsive[responsive.length - 1];
  if (lastHop && lastHop.ip !== trace.resolvedIp && trace.resolvedIp != null) {
    findings.push({
      severity: 'info',
      message: `The trace reached hop ${lastHop.hop} (${lastHop.ip}) — the destination ${trace.resolvedIp} did not answer directly (common for CDNs that deprioritize ICMP).`,
    });
  }

  // score: end-to-end latency + destination loss + hop count
  const scored = scoreRoute(
    {
      latencyMs: trace.totalLatencyMs,
      packetLossPct: destLoss,
      hops: trace.totalHops,
    },
    // weights come from settings at the call site via computeRouteScore
    { latency: 30, packetLoss: 20, jitter: 15, throughput: 20, routeQuality: 10, load: 5 },
  );

  return {
    score: scored.score,
    label: scored.label,
    findings,
  };
}

/* --------------------------------- service -------------------------------- */

export interface RouteTestRequest {
  target: string;
  family?: IpFamily;
  maxHops?: number;
  timeoutMs?: number;
  measureLoss?: boolean;
}

export interface RouteTestResult {
  testId: string;
  trace: TraceResult;
  analysis: RouteAnalysis;
  lossPctAtDestination: number | null;
}

export class RouteService {
  constructor(
    private readonly deps: {
      controller: PlatformNetworkController;
      tests: TestsRepository;
      comparisons: RouteComparisonRepository;
      events: EventService;
      settings: SettingsService;
      bus: RealtimeBus;
      /** VPN registry (or null controller in Safe Mode): captures whether a
       * tunnel was up when a trace ran, so traces can be paired later. */
      vpn?: VpnStatusSource | null;
      log: Logger;
    },
  ) {}

  async runTrace(req: RouteTestRequest, testIdOverride?: string): Promise<RouteTestResult> {
    const { controller, tests, events, bus } = this.deps;

    const target = await resolveTarget(req.target);
    const ip = pickIp(target.ips, req.family);
    const family = familyOfIp(ip);
    const testId = testIdOverride ?? crypto.randomUUID();
    // VPN state AT CAPTURE TIME is what makes before/after pairing honest:
    // a trace taken while a tunnel was up is never 'direct', whatever the
    // user assumed. Read before the first packet leaves.
    const vpnTag = await this.currentVpnTag();
    tests.create(testId, 'route', { ...req, resolvedIp: ip, vpn: vpnTag });

    try {
      const maxHops = Math.min(Math.max(req.maxHops ?? 15, 3), 30);
      const timeoutMs = req.timeoutMs ?? 1_500;

      bus.publish(testId, { type: 'test:progress', testId, task: 'trace', pct: 1, message: `Tracing route to ${ip}` });

      let trace = await controller.traceroute(ip, {
        maxHops,
        timeoutMs,
        family,
        onHop: (hop) => {
          bus.publish(testId, {
            type: 'test:progress',
            testId,
            task: 'trace',
            pct: Math.round((hop.hop / maxHops) * 70),
            message: `hop ${hop.hop}: ${hop.ip ?? 'no response'}`,
          });
        },
      });

      // second short run merges into hop loss estimates when the first run has stars
      if (trace.hops.some((h) => (h.packetLoss ?? 0) > 0) && trace.totalHops < maxHops) {
        try {
          const second = await controller.traceroute(ip, { maxHops: trace.totalHops, timeoutMs, family });
          trace = mergeTraces(trace, second);
        } catch {
          // single-run loss estimates remain, honestly labeled
        }
      }

      bus.publish(testId, { type: 'test:progress', testId, task: 'enrich', pct: 75, message: 'Resolving hostnames and ASNs' });
      trace.hops = await enrichHops(trace.hops);

      // end-to-end loss at destination via a short ICMP run
      let lossPctAtDestination: number | null = null;
      if (req.measureLoss !== false) {
        try {
          const ping = await controller.icmpPing(ip, { count: 4, timeoutMs: 1_000, family });
          lossPctAtDestination = ping.lossPct;
        } catch {
          lossPctAtDestination = null;
        }
      }

      const analysis = analyzeTrace(trace, { lossPctAtDestination, target: target.host });

      tests.finish(testId, {
        status: 'done',
        summary: {
          target: target.host,
          resolvedIp: ip,
          family,
          hops: trace.totalHops,
          totalLatencyMs: trace.totalLatencyMs,
          lossPct: lossPctAtDestination,
          score: analysis.score,
        },
        result: { testId, trace, analysis, lossPctAtDestination },
      });
      events.record(
        'info',
        'routing',
        `Route to ${target.host}: ${trace.totalHops} hops, ${trace.totalLatencyMs ?? '—'} ms, score ${analysis.score ?? '—'}`,
        { testId },
      );

      bus.publish(testId, { type: 'test:done', testId, result: { testId, trace, analysis, lossPctAtDestination } });
      return { testId, trace, analysis, lossPctAtDestination };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tests.finish(testId, { status: 'error', error: message });
      events.record('error', 'routing', `Route test to ${req.target} failed: ${message}`, { testId });
      throw err;
    }
  }

  /** VPN state at this instant; null registry (tests/Safe Mode) = honest disconnected. */
  private async currentVpnTag(): Promise<RouteVpnTag> {
    const s = await this.deps.vpn?.status().catch(() => null);
    if (!s) return { connected: false, providerId: null, verifiedPublicIp: null };
    return {
      connected: s.connected === true,
      providerId: s.connected ? (s.providerId ?? null) : null,
      verifiedPublicIp: s.connected ? (s.verifiedPublicIp ?? null) : null,
    };
  }

  /**
   * Direct-vs-VPN route comparison for one target, built ONLY from stored
   * route tests (each tagged with the VPN state captured while it ran).
   * Never invents a side: missing data is reported, not fabricated.
   */
  async compareVpnRoutes(targetInput: string, opts: { limit?: number } = {}): Promise<VpnRouteCompareResult> {
    const { tests } = this.deps;
    // Reuse the list endpoint's filter path: type 'route', newest first.
    // 200 rows is plenty of pairing context while staying bounded.
    const limit = Math.min(Math.max(opts.limit ?? 200, 10), 500);
    const rows = tests.list({ type: 'route', limit });

    const wanted = targetInput.trim().toLowerCase();
    const withTrace: { row: (typeof rows)[number]; vpn: RouteVpnTag; trace: TraceResult | null; loss: number | null }[] = [];
    for (const row of rows) {
      if (row.status !== 'done') continue;
      const params = row.params as { target?: string; resolvedIp?: string; vpn?: RouteVpnTag } | null;
      const result = row.summary as { resolvedIp?: string } | null;
      const rowTarget = String(params?.target ?? '').toLowerCase();
      const rowResolved = String(params?.resolvedIp ?? result?.resolvedIp ?? '').toLowerCase();
      // Match on the target the user asked for OR its resolved IP (a trace
      // stored by hostname still pairs with one stored by IP).
      if (wanted !== rowTarget && wanted !== rowResolved) continue;
      const full = tests.get(row.id);
      const trace = (full?.result as { trace?: TraceResult } | null)?.trace ?? null;
      const analysis = (full?.result as { analysis?: RouteAnalysis } | null)?.analysis ?? null;
      withTrace.push({
        row,
        vpn: params?.vpn ?? { connected: false, providerId: null, verifiedPublicIp: null },
        trace: trace && analysis ? trace : null,
        loss: (full?.result as { lossPctAtDestination?: number | null } | null)?.lossPctAtDestination ?? null,
      });
    }

    const pickNewest = (connected: boolean): VpnRouteCompareSide | null => {
      for (const e of withTrace) {
        if (e.vpn.connected === connected && e.trace) {
          const analysis = (this.deps.tests.get(e.row.id)?.result as { analysis?: RouteAnalysis } | null)?.analysis ?? null;
          if (!analysis) continue;
          return {
            testId: e.row.id,
            startedAt: e.row.startedAt,
            trace: e.trace,
            analysis,
            lossPctAtDestination: e.loss,
            vpn: e.vpn,
          };
        }
      }
      return null;
    };

    const direct = pickNewest(false);
    const vpn = pickNewest(true);

    if (!direct && !vpn) {
      return {
        target: targetInput,
        direct: null,
        vpn: null,
        status: 'unavailable',
        note: `No stored traceroutes for "${targetInput}" yet. Run a trace (ideally once disconnected, then once connected) and the comparison will appear here.`,
        deltas: null,
      };
    }
    if (!vpn) {
      return {
        target: targetInput,
        direct,
        vpn: null,
        status: 'unpaired_vpn',
        note: 'Only direct traces exist for this target. Connect the VPN and run a trace to the same target to complete the comparison.',
        deltas: null,
      };
    }
    if (!direct) {
      return {
        target: targetInput,
        direct: null,
        vpn,
        status: 'unpaired_direct',
        note: 'Only VPN traces exist for this target. Disconnect and run a trace to the same target to complete the comparison.',
        deltas: null,
      };
    }

    const latencyDeltaMs =
      direct.trace.totalLatencyMs != null && vpn.trace.totalLatencyMs != null
        ? Math.round((vpn.trace.totalLatencyMs - direct.trace.totalLatencyMs) * 10) / 10
        : null;
    const hopsDelta = vpn.trace.totalHops - direct.trace.totalHops;
    const lossDeltaPct =
      direct.lossPctAtDestination != null && vpn.lossPctAtDestination != null
        ? Math.round((vpn.lossPctAtDestination - direct.lossPctAtDestination) * 10) / 10
        : null;
    const scoreDelta =
      direct.analysis.score != null && vpn.analysis.score != null ? vpn.analysis.score - direct.analysis.score : null;
    let preferred: 'direct' | 'vpn' | null = null;
    let reason: string | null = null;
    if (scoreDelta != null && Math.abs(scoreDelta) >= 10) {
      preferred = scoreDelta > 0 ? 'vpn' : 'direct';
      const better = preferred === 'vpn' ? vpn : direct;
      const worse = preferred === 'vpn' ? direct : vpn;
      reason = `The ${preferred === 'vpn' ? 'VPN' : 'direct'} route scores ${Math.abs(scoreDelta)} points higher (${better.analysis.score} vs ${worse.analysis.score}).`;
    } else if (scoreDelta != null) {
      reason = 'Route scores are within 10 points — the difference is not meaningful from single runs.';
    }
    return {
      target: targetInput,
      direct,
      vpn,
      status: 'complete',
      note: null,
      deltas: { latencyDeltaMs, hopsDelta, lossDeltaPct, scoreDelta, preferred, reason },
    };
  }

  /** List recent stored route tests with their VPN tags (for the UI picker). */
  listRouteHistory(opts: { limit?: number } = {}): {
    id: string;
    startedAt: number;
    target: string;
    resolvedIp: string | null;
    hops: number | null;
    latencyMs: number | null;
    score: number | null;
    vpn: RouteVpnTag;
  }[] {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
    return this.deps.tests
      .list({ type: 'route', limit })
      .filter((r) => r.status === 'done')
      .map((r) => {
        const params = r.params as { target?: string; resolvedIp?: string; vpn?: RouteVpnTag } | null;
        const summary = r.summary as { hops?: number; totalLatencyMs?: number; score?: number } | null;
        return {
          id: r.id,
          startedAt: r.startedAt,
          target: String(params?.target ?? ''),
          resolvedIp: params?.resolvedIp ?? null,
          hops: summary?.hops ?? null,
          latencyMs: summary?.totalLatencyMs ?? null,
          score: summary?.score ?? null,
          vpn: params?.vpn ?? { connected: false, providerId: null, verifiedPublicIp: null },
        };
      });
  }

  /** IPv4 vs IPv6 route comparison with statistical honesty. */
  async runComparison(req: { target: string; maxHops?: number }, testIdOverride?: string): Promise<{
    testId: string;
    target: string;
    routes: { family: IpFamily; trace: TraceResult; analysis: RouteAnalysis }[];
    winner: IpFamily | null;
    reason: string | null;
  }> {
    const { tests, comparisons, events } = this.deps;
    const testId = testIdOverride ?? crypto.randomUUID();
    tests.create(testId, 'route_compare', { ...req });

    const resolved = await resolveTarget(req.target);
    const v4 = resolved.ips.find((ip) => familyOfIp(ip) === 4);
    const v6 = resolved.ips.find((ip) => familyOfIp(ip) === 6);

    const routes: { family: IpFamily; trace: TraceResult; analysis: RouteAnalysis }[] = [];
    if (v4) {
      const r = await this.runTrace({ target: v4, family: 4, maxHops: req.maxHops }, `${testId}:4`);
      routes.push({ family: 4, trace: r.trace, analysis: r.analysis });
    }
    if (v6) {
      const r = await this.runTrace({ target: v6, family: 6, maxHops: req.maxHops }, `${testId}:6`);
      routes.push({ family: 6, trace: r.trace, analysis: r.analysis });
    }

    if (routes.length < 2) {
      const have = routes[0]?.family ?? null;
      tests.finish(testId, { status: 'done', summary: { target: req.target, compared: false, note: `Only IPv${have ?? '?'} is available on this network` }, result: { testId, target: req.target, compared: false, family: have ?? null } });
      this.deps.bus.publish(testId, { type: 'test:done', testId, result: { testId, target: req.target, routes, winner: null, reason: `Only IPv${have ?? '?'} is available on this network, so there is nothing to compare yet.` } });
      return { testId, target: req.target, routes, winner: null, reason: `Only IPv${have ?? '?'} is available on this network, so there is nothing to compare yet.` };
    }

    const a = routes[0]!;
    const b = routes[1]!;
    let winner: IpFamily | null = null;
    let reason: string | null = null;
    if (a.analysis.score != null && b.analysis.score != null) {
      const diff = b.analysis.score - a.analysis.score;
      if (Math.abs(diff) >= 10) {
        winner = diff > 0 ? b.family : a.family;
        const better = diff > 0 ? b : a;
        const worse = diff > 0 ? a : b;
        reason = `IPv${winner} scores ${Math.abs(diff)} points higher than IPv${worse.family} (IPv${better.family}: ${better.analysis.score}, IPv${worse.family}: ${worse.analysis.score}).`;
      } else {
        reason = 'Both protocol scores are within 10 points — the difference is not statistically meaningful from a single run.';
      }
    }

    comparisons.insert({
      id: crypto.randomUUID(),
      testId,
      target: req.target,
      routes: routes.map((r) => ({ family: r.family, hops: r.trace.totalHops, latencyMs: r.trace.totalLatencyMs, score: r.analysis.score })),
      winner: winner == null ? null : String(winner),
      reason,
    });

    tests.finish(testId, {
      status: 'done',
      summary: { target: req.target, winner, reason, routes: routes.map((r) => ({ family: r.family, score: r.analysis.score, hops: r.trace.totalHops })) },
      result: { testId, target: req.target, routes, winner, reason },
    });
    events.record('info', 'routing', `Route comparison ${req.target}: ${winner ? `IPv${winner} preferred` : 'no significant difference'}`, { testId });
    this.deps.bus.publish(testId, { type: 'test:done', testId, result: { testId, target: req.target, routes, winner, reason } });
    return { testId, target: req.target, routes, winner, reason };
  }
}

/**
 * Combine two observations of the same hop.
 *
 * A hop that produced no measurement contributes nothing rather than a zero.
 * Averaging an unmeasured loss in as 0% invents a figure out of a probe that
 * never ran, and the UI reads 0% as "no loss at all" — the most reassuring
 * thing it can say about a leg it never checked. Latency and packet loss both
 * come through here, so they cannot drift apart again.
 */
export function mergeMeasurement(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  if (a == null) return b;
  if (b == null) return a;
  return Math.round(((a + b) / 2) * 10) / 10;
}

export function mergeTraces(primary: TraceResult, second: TraceResult): TraceResult {
  const byHop = new Map<number, RouteHop>();
  for (const hop of [...primary.hops, ...second.hops]) {
    const existing = byHop.get(hop.hop);
    if (!existing) {
      byHop.set(hop.hop, { ...hop });
      continue;
    }
    if (existing.ip === null && hop.ip !== null) {
      existing.ip = hop.ip;
      existing.status = 'ok';
    }
    existing.latencyMs = mergeMeasurement(existing.latencyMs, hop.latencyMs);
    existing.packetLoss = mergeMeasurement(existing.packetLoss, hop.packetLoss);
  }
  const hops = [...byHop.values()].sort((x, y) => x.hop - y.hop);
  const last = [...hops].reverse().find((h) => h.latencyMs != null) ?? null;
  return { ...primary, hops, totalHops: hops.length, totalLatencyMs: last?.latencyMs ?? primary.totalLatencyMs };
}
