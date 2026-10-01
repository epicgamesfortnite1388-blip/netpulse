import https from 'node:https';
import net from 'node:net';

import type { IpFamily } from '@netpulse/shared';
import {
  jitterScore,
  labelFor,
  latencyScore,
  lossScore,
  throughputScore,
  weightedScore,
} from '@netpulse/shared';

import type { RealtimeBus } from '../realtime/bus';
import type { TestsRepository } from '../db/repositories';
import type { PlatformNetworkController } from '../providers/platform/types';
import { familyOfIp, resolveTarget, pickIp } from '../util/targetGuard';
import type { EventService } from './eventService';
import type { SettingsService } from './settingsService';

import type { Logger } from '../logger';

/**
 * Selection weights in percent. The spec default is:
 * latency 25, packet loss 20, jitter 15, download 15, upload 10,
 * route quality 10, load 5. Throughput (download+upload) and route quality
 * are optional: when a component is not measured its weight is excluded and
 * the rest renormalized — a score is never padded with assumed values.
 */
export const DEFAULT_SELECTION_WEIGHTS = {
  latency: 25,
  packetLoss: 20,
  jitter: 15,
  download: 15,
  upload: 10,
  routeQuality: 10,
  load: 5,
} as const;

export type SelectionWeightKey = keyof typeof DEFAULT_SELECTION_WEIGHTS;

export interface SelectionCandidateInput {
  id: string;
  name: string;
  host: string;
  port?: number | null;
  /** user-declared capacity in Mbps, used for the load component when known */
  capacityMbps?: number | null;
}

export interface SelectionMetrics {
  pingAvgMs: number | null;
  jitterMs: number | null;
  lossPct: number | null;
  /** measured downstream capacity estimate (bounded transfer) in Mbps */
  downloadMbps: number | null;
  /** measured upstream capacity estimate (bounded transfer) in Mbps */
  uploadMbps: number | null;
  hops: number | null;
  routeScore: number | null;
  loadPct: number | null;
}

export interface SelectionCandidateResult {
  candidate: SelectionCandidateInput;
  /** 0..100 weighted score; null when the candidate never answered */
  score: number | null;
  label: string | null;
  rank: number;
  metrics: SelectionMetrics;
  /** human-readable reasons describing this candidate's strengths/weaknesses */
  reasons: string[];
  /** which score components were actually measured */
  measured: SelectionWeightKey[];
}

export interface SelectionRequest {
  candidates?: SelectionCandidateInput[];
  probes?: number;
  /** run the (heavier) route measurement for each candidate */
  withRoute?: boolean;
  /** measured bounded-transfer sizes in KB for the capacity probes */
  transferKiB?: number;
  /** component weights; defaults to DEFAULT_SELECTION_WEIGHTS */
  weights?: Partial<Record<SelectionWeightKey, number>>;
}

export interface SelectionResult {
  testId: string;
  weights: Record<SelectionWeightKey, number>;
  results: SelectionCandidateResult[];
  recommended: SelectionCandidateResult | null;
  /** why the winner was chosen, in human terms */
  recommendation: string | null;
}

/** Milliseconds probe for a bounded capacity estimate (single TCP fetch). */
const CAPACITY_TIMEOUT_MS = 4_000;

/**
 * Estimate link capacity with a single bounded HTTPS transfer through the
 * Cloudflare speed endpoints. This is an *estimate* (one transfer, small
 * payload), not the full speed test; it keeps candidate ranking cheap.
 * Returns null when the transfer cannot be completed or timed out.
 *
 * Security (audit F3): the connection targets the ALREADY-VALIDATED IP
 * literal (resolveTarget → pickIp) with the candidate's hostname presented
 * as SNI + Host. Fetching the hostname here instead would re-resolve DNS at
 * request time and reopen the rebinding window the guard just closed — the
 * address that answers MUST be the address that was checked.
 */
/**
 * Test seam for the dial below: unit tests swap this so the rebinding
 * regression (the request MUST target the validated IP literal) is provable
 * without any real network. Production always uses node:https.request.
 */
export const capacityProbeInternals = { httpsRequest: https.request };

async function probeCapacity(ip: string, host: string, bytes: number, timeoutMs: number): Promise<number | null> {
  try {
    const started = performance.now();
    // SNI only for name-shaped hosts: a literal-IP host has no SNI, and
    // Node would reject a bracketed v6 literal as a servername.
    const servername = net.isIP(host) === 0 ? host : undefined;
    const body = await new Promise<Buffer>((resolve, reject) => {
      const req = capacityProbeInternals.httpsRequest(
        {
          host: ip,
          servername,
          path: `/__down?bytes=${bytes}`,
          method: 'GET',
          headers: { host, 'user-agent': 'netpulse/0.1' },
          timeout: timeoutMs,
        },
        (res) => {
          if ((res.statusCode ?? 0) >= 400) {
            res.resume();
            reject(new Error(`capacity probe got status ${res.statusCode}`));
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          // Hard read cap: a hostile endpoint cannot grow memory past the
          // requested payload plus slack.
          res.on('data', (c: Buffer) => {
            total += c.length;
            chunks.push(c);
            if (total > bytes + 1024 * 1024) req.destroy(new Error('capacity probe exceeded the read cap'));
          });
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`capacity probe timed out after ${timeoutMs}ms`)));
      req.on('error', reject);
      req.end();
    });
    const received = body.length;
    const elapsedSec = (performance.now() - started) / 1000;
    if (elapsedSec <= 0 || received < 1024) return null;
    return (received * 8) / elapsedSec / 1_000_000;
  } catch {
    return null;
  }
}

function reasonsFor(m: SelectionMetrics, measured: SelectionWeightKey[]): string[] {
  const reasons: string[] = [];
  if (m.pingAvgMs != null) {
    if (m.pingAvgMs <= 30) reasons.push(`Low latency (${m.pingAvgMs.toFixed(0)} ms)`);
    else if (m.pingAvgMs >= 150) reasons.push(`High latency (${m.pingAvgMs.toFixed(0)} ms)`);
  }
  if (m.lossPct != null) {
    if (m.lossPct === 0) reasons.push('Zero packet loss');
    else if (m.lossPct >= 2) reasons.push(`Packet loss ${m.lossPct.toFixed(1)}%`);
  }
  if (m.jitterMs != null && m.jitterMs >= 10) reasons.push(`Unstable latency (jitter ${m.jitterMs.toFixed(0)} ms)`);
  if (m.downloadMbps != null && m.downloadMbps >= 100) reasons.push(`Fast download (~${m.downloadMbps.toFixed(0)} Mbps)`);
  if (m.uploadMbps != null && m.uploadMbps >= 50) reasons.push(`Fast upload (~${m.uploadMbps.toFixed(0)} Mbps)`);
  if (m.routeScore != null) {
    if (m.routeScore >= 85) reasons.push('Excellent route');
    else if (m.routeScore <= 50) reasons.push('Poor route quality');
  }
  if (measured.length === 0) reasons.push('No measurements succeeded — candidate unreachable');
  return reasons;
}

/**
 * Smart server selection: measures every candidate, scores with the
 * normalized weighted engine and recommends the best one with an explicit
 * explanation. It never applies anything — the caller decides what to do
 * with the recommendation.
 */
export class SelectionService {
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

  async run(req: SelectionRequest, testIdOverride?: string): Promise<SelectionResult> {
    const { controller, tests, events, bus } = this.deps;
    const testId = testIdOverride ?? crypto.randomUUID();

    const candidates: SelectionCandidateInput[] = (req.candidates ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      host: c.host,
      port: c.port ?? 443,
      capacityMbps: c.capacityMbps ?? null,
    }));
    if (candidates.length === 0) {
      throw Object.assign(new Error('No candidates provided for selection'), {
        statusCode: 400,
        code: 'no_candidates',
        hint: 'Add servers first or pass explicit endpoints.',
      });
    }

    const weights: Record<SelectionWeightKey, number> = { ...DEFAULT_SELECTION_WEIGHTS, ...(req.weights ?? {}) };
    const probes = Math.min(Math.max(req.probes ?? 5, 3), 12);
    const transferBytes = Math.min(Math.max((req.transferKiB ?? 256) * 1024, 64 * 1024), 4 * 1024 * 1024);

    tests.create(testId, 'optimization', { candidates: candidates.length, probes, mode: 'selection' });
    bus.publish(testId, { type: 'test:progress', testId, task: 'selection', pct: 0, message: `Measuring ${candidates.length} candidate(s)` });

    const results: SelectionCandidateResult[] = [];
    let idx = 0;
    for (const candidate of candidates) {
      idx += 1;
      const basePct = Math.round(((idx - 1) / candidates.length) * 100);
      const stepPct = Math.round(100 / candidates.length);
      bus.publish(testId, { type: 'test:progress', testId, task: 'selection', pct: basePct, message: `Measuring ${candidate.name}` });

      const metrics: SelectionMetrics = {
        pingAvgMs: null, jitterMs: null, lossPct: null,
        downloadMbps: null, uploadMbps: null, hops: null, routeScore: null, loadPct: null,
      };
      let family: IpFamily | null = null;
      let ip: string | null = null;

      // resolve + ICMP latency/jitter/loss
      try {
        const resolved = await resolveTarget(candidate.host);
        ip = pickIp(resolved.ips);
        family = familyOfIp(ip);
        try {
          const ping = await controller.icmpPing(ip, { count: probes, timeoutMs: 1_500, family });
          metrics.pingAvgMs = ping.avg;
          metrics.jitterMs = ping.jitterMs;
          metrics.lossPct = ping.lossPct;
        } catch {
          // ICMP often blocked; TCP below is the fallback signal
        }
        // TCP handshake as latency fallback
        if (metrics.pingAvgMs == null) {
          try {
            const tcp = await controller.tcpProbe(ip, candidate.port ?? 443, 2_000, family ?? undefined);
            metrics.pingAvgMs = tcp.ok ? tcp.ms : null;
          } catch {
            metrics.pingAvgMs = null;
          }
        }
      } catch {
        // unresolvable candidate: stays with null metrics and ranks last
      }

      // bounded capacity estimates through the candidate's HTTPS endpoint
      if (ip && family === 4) {
        const schemePort = candidate.port ?? 443;
        // Port 443 only, as before: the probe speaks TLS directly from Node,
        // so a candidate on another port keeps its null download estimate
        // rather than getting an invented fallback.
        if (schemePort === 443) {
          metrics.downloadMbps = await probeCapacity(ip, candidate.host, transferBytes, CAPACITY_TIMEOUT_MS);
          metrics.uploadMbps = null; // upload estimation needs POST bodies; kept null unless a probe endpoint is configured
        }
      }

      // optional route measurement
      if (req.withRoute && ip && family) {
        try {
          const trace = await controller.traceroute(ip, { maxHops: 15, timeoutMs: 700, family });
          const answered = trace.hops.filter((h) => h.status === 'ok');
          metrics.hops = answered.length > 0 ? answered[answered.length - 1]!.hop : trace.hops.length;
        } catch {
          metrics.hops = null;
        }
      }

      // score with renormalized weights over measured components only
      const components: Partial<Record<SelectionWeightKey, number>> = {
        latency: metrics.pingAvgMs != null ? latencyScore(metrics.pingAvgMs) : undefined,
        packetLoss: metrics.lossPct != null ? lossScore(metrics.lossPct) : undefined,
        jitter: metrics.jitterMs != null ? jitterScore(metrics.jitterMs) : undefined,
        download: metrics.downloadMbps != null ? throughputScore(metrics.downloadMbps) : undefined,
        routeQuality: metrics.hops != null ? Math.max(0, 100 - (metrics.hops - 5) * 5) : undefined,
      };
      const measured = Object.keys(components).filter((k) => components[k as SelectionWeightKey] != null) as SelectionWeightKey[];
      const weighted = weightedScore(components as Record<string, number | undefined> as never, weights as never);
      const score = weighted.measured.length > 0 ? weighted.score : null;
      const result: SelectionCandidateResult = {
        candidate,
        score,
        label: score != null ? labelFor(score) : null,
        rank: 0,
        metrics,
        reasons: reasonsFor(metrics, measured),
        measured,
      };
      results.push(result);
      bus.publish(testId, {
        type: 'test:progress', testId, task: 'selection', pct: Math.min(100, basePct + stepPct),
        message: `${candidate.name}: ${score != null ? `${score}/100` : 'no response'}`,
      });
    }

    results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    results.forEach((r, i) => { r.rank = i + 1; });
    const recommended = results[0] ?? null;

    let recommendation: string | null = null;
    if (recommended && recommended.score != null) {
      const parts = [`Recommended ${recommended.candidate.name} (score ${recommended.score}/100, ${recommended.label})`];
      if (recommended.metrics.pingAvgMs != null) parts.push(`latency ${recommended.metrics.pingAvgMs.toFixed(0)} ms`);
      if (recommended.metrics.lossPct != null) parts.push(`loss ${recommended.metrics.lossPct.toFixed(1)}%`);
      if (recommended.metrics.jitterMs != null) parts.push(`jitter ${recommended.metrics.jitterMs.toFixed(0)} ms`);
      if (recommended.metrics.downloadMbps != null) parts.push(`download ~${recommended.metrics.downloadMbps.toFixed(0)} Mbps`);
      recommendation = `${parts.join(', ')}.`;
    } else if (recommended) {
      recommendation = 'No candidate answered any probe — nothing can be recommended from measurements.';
    }

    tests.finish(testId, {
      status: 'done',
      summary: {
        candidates: results.length,
        recommended: recommended ? { id: recommended.candidate.id, name: recommended.candidate.name, score: recommended.score } : null,
        recommendation,
        results: results.map((r) => ({ id: r.candidate.id, score: r.score, rank: r.rank })),
      },
      result: { testId, results, recommended, recommendation },
    });
    events.record('info', 'network', recommendation ?? 'Selection run produced no recommendation', { testId });
    bus.publish(testId, { type: 'test:done', testId, result: { testId, results, recommended, recommendation } });

    return { testId, weights, results, recommended, recommendation };
  }
}
