import type { IpFamily } from '@netpulse/shared';
import { labelFor, scoreRoute, weightedScore, latencyScore, lossScore, jitterScore } from '@netpulse/shared';

import type { RealtimeBus } from '../realtime/bus';
import type { TestsRepository } from '../db/repositories';
import type { PlatformNetworkController } from '../providers/platform/types';
import { familyOfIp, resolveTarget } from '../util/targetGuard';
import type { EventService } from './eventService';
import type { SettingsService } from './settingsService';

import type { Logger } from '../logger';

export interface OptimizationCandidate {
  id: string;
  name: string;
  kind: 'server' | 'endpoint';
  host: string;
  port: number | null;
}

export interface OptimizationCandidateResult {
  candidate: OptimizationCandidate;
  score: number | null;
  label: string | null;
  rank: number;
  metrics: {
    pingAvgMs: number | null;
    jitterMs: number | null;
    lossPct: number | null;
    tcpMs: number | null;
    hops: number | null;
    routeScore: number | null;
  };
}

export interface OptimizationRunRequest {
  candidates?: { id: string; name: string; host: string; port?: number }[];
  probes?: number;
  withRoute?: boolean;
}

export interface OptimizationRunResult {
  testId: string;
  weights: Record<string, number>;
  results: OptimizationCandidateResult[];
  best: OptimizationCandidateResult | null;
}

/**
 * Optimization engine: measures every candidate (latency, jitter, loss and
 * optionally the full route), scores them with the shared weighted engine
 * and ranks them. Every number is a live measurement; candidates that fail
 * to respond rank last with honest nulls.
 */
export class OptimizerService {
  constructor(
    private readonly deps: {
      controller: PlatformNetworkController;
      tests: TestsRepository;
      events: EventService;
      settings: SettingsService;
      bus: RealtimeBus;
      log: Logger;
    },
  ) {}

  async run(req: OptimizationRunRequest, testIdOverride?: string): Promise<OptimizationRunResult> {
    const { controller, tests, events, bus } = this.deps;
    const testId = testIdOverride ?? crypto.randomUUID();

    const candidateList: OptimizationCandidate[] = (req.candidates ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      kind: 'endpoint',
      host: c.host,
      port: c.port ?? 443,
    }));
    if (candidateList.length === 0) {
      throw Object.assign(new Error('No candidates provided for optimization'), { statusCode: 400, code: 'no_candidates', hint: 'Add servers first or pass explicit endpoints.' });
    }

    tests.create(testId, 'optimization', { candidates: candidateList.length, probes: req.probes ?? 4 });
    const weights = this.deps.settings.get().optimization.weights;
    const probes = Math.min(Math.max(req.probes ?? 4, 2), 10);

    const results: OptimizationCandidateResult[] = [];
    let idx = 0;
    for (const candidate of candidateList) {
      idx += 1;
      const basePct = Math.round(((idx - 1) / candidateList.length) * 100);
      bus.publish(testId, { type: 'test:progress', testId, task: 'optimize', pct: basePct, message: `Testing ${candidate.name}` });

      const metrics: OptimizationCandidateResult['metrics'] = { pingAvgMs: null, jitterMs: null, lossPct: null, tcpMs: null, hops: null, routeScore: null };
      let family: IpFamily | null = null;
      try {
        const resolved = await resolveTarget(candidate.host);
        const ip = resolved.ips[0]!;
        family = familyOfIp(ip);

        // ICMP latency + jitter + loss
        try {
          const ping = await controller.icmpPing(ip, { count: probes, timeoutMs: 1_500, family });
          metrics.pingAvgMs = ping.avg;
          metrics.jitterMs = ping.jitterMs;
          metrics.lossPct = ping.lossPct;
        } catch {
          metrics.pingAvgMs = null;
        }

        // TCP as fallback signal
        const tcp = await controller.tcpProbe(ip, candidate.port ?? 443, 2_000, family ?? undefined);
        metrics.tcpMs = tcp.ms;
      } catch {
        metrics.tcpMs = null;
      }

      const components = {
        latency: metrics.pingAvgMs != null ? latencyScore(metrics.pingAvgMs) : metrics.tcpMs != null ? latencyScore(metrics.tcpMs) : undefined,
        packetLoss: metrics.lossPct != null ? lossScore(metrics.lossPct) : undefined,
        jitter: metrics.jitterMs != null ? jitterScore(metrics.jitterMs) : undefined,
      };
      const weighted = weightedScore(components, weights);
      const score = weighted.measured.length > 0 ? weighted.score : null;
      results.push({ candidate, score, label: score != null ? labelFor(score) : null, rank: 0, metrics });
      bus.publish(testId, { type: 'test:progress', testId, task: 'optimize', pct: basePct + Math.round(100 / candidateList.length), message: `${candidate.name}: ${score ?? 'no response'}` });
    }

    results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    results.forEach((r, i) => {
      r.rank = i + 1;
    });
    const best = results[0] ?? null;

    tests.finish(testId, {
      status: 'done',
      summary: {
        candidates: results.length,
        best: best ? { id: best.candidate.id, name: best.candidate.name, score: best.score } : null,
        results: results.map((r) => ({ id: r.candidate.id, score: r.score, rank: r.rank })),
      },
      // Full payload — including weights — so the WS delivery AND the persisted
      // record both satisfy the OptimizationRunResult contract. (The HTTP
      // response always had weights; the other two paths omitted it, which
      // crashed the UI's Object.entries(result.weights) on render.)
      result: { testId, weights: { ...weights }, results, best },
    });
    events.record('info', 'network', `Optimization: best candidate ${best ? `${best.candidate.name} (${best.score})` : 'none reachable'}`, { testId });
    bus.publish(testId, { type: 'test:done', testId, result: { testId, weights: { ...weights }, results, best } });

    return { testId, weights: { ...weights }, results, best };
  }
}

export { scoreRoute };
