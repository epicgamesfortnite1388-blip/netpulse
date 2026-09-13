import type { SpeedTestRequest, SpeedTestResult, ThroughputSample } from '@netpulse/shared';
import { jitterMs, lossPct, median, round } from '@netpulse/shared';

import { CloudflareSpeedProvider, defaultSpeedRequest } from '../providers/speed/cloudflare';
import type { SpeedTestProvider } from '../providers/speed/cloudflare';
import type { RealtimeBus } from '../realtime/bus';
import type { DbHandle } from '../db/client';
import { speedTests } from '../db/schema';
import type { TestsRepository } from '../db/repositories';
import type { PlatformNetworkController } from '../providers/platform/types';
import type { EventService } from './eventService';

const SPEED_PROVIDERS = new Map<string, SpeedTestProvider>([
  ['cloudflare', new CloudflareSpeedProvider()],
]);

export interface SpeedServiceDeps {
  tests: TestsRepository;
  events: EventService;
  bus: RealtimeBus;
  db: DbHandle;
  controller: PlatformNetworkController;
  log?: { warn(msg: string): void };
}

interface LatencyStat {
  min: number | null;
  avg: number | null;
  max: number | null;
  median: number | null;
  jitter: number | null;
  lossPct: number;
}

/**
 * Real speed measurement: streaming throughput from a SpeedTestProvider
 * (Cloudflare by default) plus TCP-connect latency statistics against the
 * provider's reference target. Every number originates from actual socket
 * I/O — fabricated values are structurally impossible here.
 */
export class SpeedService {
  constructor(private readonly deps: SpeedServiceDeps) {}

  /** TCP connect-time latency stats against the provider reference target. */
  async latencyStats(
    target: string,
    probes: number,
    signal: AbortSignal,
    onProgress?: (pct: number) => void,
  ): Promise<LatencyStat> {
    const samples: number[] = [];
    for (let i = 0; i < probes; i++) {
      if (signal.aborted) break;
      const probe = await this.deps.controller.tcpProbe(target, 443, 2_000);
      if (probe.ok && probe.ms != null) samples.push(probe.ms);
      onProgress?.(Math.round(((i + 1) / probes) * 100));
    }
    const sent = probes;
    const received = samples.length;
    return {
      min: samples.length ? round(Math.min(...samples), 1) : null,
      avg: samples.length ? round(samples.reduce((a, b) => a + b, 0) / samples.length, 1) : null,
      max: samples.length ? round(Math.max(...samples), 1) : null,
      median: median(samples),
      jitter: jitterMs(samples),
      lossPct: round(lossPct(sent, received), 1),
    };
  }

  /**
   * Full speed test. Emits live throughput samples on the realtime bus,
   * persists the result and returns it.
   */
  async runTest(
    req: SpeedTestRequest,
    opts: { testId: string; signal: AbortSignal },
  ): Promise<SpeedTestResult> {
    const { tests, bus, events } = this.deps;
    const provider = SPEED_PROVIDERS.get(req.provider ?? 'cloudflare') ?? SPEED_PROVIDERS.get('cloudflare')!;
    const defaults = defaultSpeedRequest();
    const downloadStreams = req.downloadStreams ?? defaults.downloadStreams;
    const uploadStreams = req.uploadStreams ?? defaults.uploadStreams;
    const durationMs = req.durationMs ?? defaults.durationMs;

    const publish = (pct: number, task: string, extra?: Record<string, unknown>) =>
      bus.publish(opts.testId, { type: 'test:progress', testId: opts.testId, task, pct, ...extra });

    tests.create(opts.testId, 'speed', { provider: req.provider ?? 'cloudflare', durationMs, downloadStreams, uploadStreams });

    try {
      publish(2, 'ping');
      const latency = await this.latencyStats(provider.pingTarget(req.family), 8, opts.signal, (pct) =>
        publish(Math.round(2 + pct * 0.08), 'ping'),
      );

      publish(10, 'download');
      const download = await provider.download({
        durationMs,
        streams: downloadStreams,
        signal: opts.signal,
        onSample: (sample: ThroughputSample, pct) => publish(10 + Math.round(pct * 0.45), 'download', { mbps: sample.mbps }),
      });

      publish(55, 'upload');
      const upload = await provider.upload({
        durationMs,
        streams: uploadStreams,
        signal: opts.signal,
        onSample: (sample: ThroughputSample, pct) => publish(55 + Math.round(pct * 0.44), 'upload', { mbps: sample.mbps }),
      });

      publish(99, 'finalize');
      const result: SpeedTestResult = {
        downloadMbps: download.mbps,
        uploadMbps: upload.mbps,
        pingMin: latency.min,
        pingAvg: latency.avg,
        pingMax: latency.max,
        pingMedian: latency.median,
        jitterMs: latency.jitter,
        packetLoss: latency.lossPct,
        loadedLatencyMs: null,
        server: provider.serverLabel,
        durationMs: download.durationMs + upload.durationMs,
        downloadSamples: download.samples,
        uploadSamples: upload.samples,
        error: download.error ?? upload.error,
      };

      this.deps.db.db.insert(speedTests)
        .values({
          id: crypto.randomUUID(),
          testId: opts.testId,
          server: result.server,
          downloadMbps: result.downloadMbps,
          uploadMbps: result.uploadMbps,
          pingMin: result.pingMin,
          pingAvg: result.pingAvg,
          pingMax: result.pingMax,
          pingMedian: result.pingMedian,
          jitterMs: result.jitterMs,
          packetLoss: result.packetLoss,
          durationMs: result.durationMs,
        })
        .run();

      events.record(
        'info',
        'network',
        `Speed test: ↓ ${result.downloadMbps ?? '—'} Mbps, ↑ ${result.uploadMbps ?? '—'} Mbps, ping ${result.pingAvg ?? '—'} ms`,
        { testId: opts.testId },
      );
      tests.finish(opts.testId, {
        status: 'done',
        summary: {
          downloadMbps: result.downloadMbps,
          uploadMbps: result.uploadMbps,
          pingAvg: result.pingAvg,
          jitterMs: result.jitterMs,
          packetLoss: result.packetLoss,
          // surface partial failures (e.g. throughput endpoint unreachable)
          // so a null value is always explainable, never silent
          error: result.error ?? null,
        },
        result,
      });
      bus.publish(opts.testId, { type: 'test:done', testId: opts.testId, result });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tests.finish(opts.testId, { status: 'error', error: message });
      events.record('error', 'network', `Speed test failed: ${message}`, { testId: opts.testId });
      throw err;
    }
  }

  listHistory(limit = 50) {
    return this.deps.tests.list({ type: 'speed', limit });
  }
}
