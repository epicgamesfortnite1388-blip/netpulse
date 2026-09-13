import type { PingTestRequest, PingResult, HealthScore, HealthComponent } from '@netpulse/shared';
import {
  latencyScore,
  lossScore,
  jitterScore,
  labelFor,
  weightedScore,
  DEFAULT_WEIGHTS,
} from '@netpulse/shared';

import type { RealtimeBus } from '../realtime/bus';
import type { EventService } from './eventService';
import type { SettingsService } from './settingsService';
import type { TestsRepository } from '../db/repositories';
import { familyOfIp, pickIp, resolveTarget } from '../util/targetGuard';
import type { PlatformNetworkController } from '../providers/platform/types';
import type { Logger } from '../logger';

export interface PingTestResultWithId extends PingResult {
  testId: string;
}

/**
 * Orchestrates an ICMP ping test: validates + resolves the target through
 * the SSRF guard, records the test in the database, streams live progress
 * over the realtime bus and stores the outcome in history.
 */
export class PingService {
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

  async runTest(req: PingTestRequest): Promise<PingTestResultWithId> {
    const { controller, tests, events, bus, log } = this.deps;

    // resolveTarget enforces the SSRF policy; probing uses the resolved IP.
    const target = await resolveTarget(req.target);
    const ip = pickIp(target.ips, req.family);
    const family = familyOfIp(ip);

    const testId = crypto.randomUUID();
    tests.create(testId, 'ping', { ...req, resolvedIp: ip });

    try {
      const result = await controller.icmpPing(ip, {
        count: req.count,
        timeoutMs: req.timeoutMs,
        family,
        onProgress: (completed, total) => {
          bus.publish(testId, {
            type: 'test:progress',
            testId,
            task: 'icmp',
            pct: Math.round((completed / Math.max(total, 1)) * 100),
            message: `${completed}/${total} replies`,
          });
        },
      });

      const done: PingTestResultWithId = { testId, ...result };
      tests.finish(testId, {
        status: 'done',
        summary: {
          target: target.host,
          resolvedIp: ip,
          avg: result.avg,
          min: result.min,
          max: result.max,
          median: result.median,
          jitterMs: result.jitterMs,
          lossPct: result.lossPct,
          sent: result.sent,
          received: result.received,
        },
        result: done,
      });
      events.record('info', 'network', `Ping test ${target.host}: avg ${result.avg ?? '—'} ms, loss ${result.lossPct}%`, {
        testId,
      });

      bus.publish(testId, { type: 'test:done', testId, result: done });
      return done;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tests.finish(testId, { status: 'error', error: message });
      events.record('error', 'network', `Ping test ${target.host} failed: ${message}`, { testId });
      log.warn({ err, testId }, 'ping test failed');
      throw err;
    }
  }
}

/**
 * Connection health v1: only measured components contribute (weighted
 * renormalization). Offline scores 0 regardless of everything else.
 */
export function computeHealth(input: {
  online: boolean;
  latencyTcpMs: number | null;
  jitterMs?: number | null;
  lossPct?: number | null;
}): HealthScore {
  const components: HealthComponent[] = [
    { component: 'connectivity', label: 'Connectivity', value: input.online ? 1 : 0, measured: true },
    {
      component: 'latency',
      label: 'Latency',
      value: input.latencyTcpMs,
      measured: input.latencyTcpMs != null,
    },
    { component: 'jitter', label: 'Jitter', value: input.jitterMs ?? null, measured: input.jitterMs != null },
    { component: 'loss', label: 'Packet loss', value: input.lossPct ?? null, measured: input.lossPct != null },
    { component: 'dns', label: 'DNS', value: null, measured: false },
    { component: 'download', label: 'Download', value: null, measured: false },
    { component: 'upload', label: 'Upload', value: null, measured: false },
    { component: 'route', label: 'Route quality', value: null, measured: false },
  ];

  if (!input.online) {
    return { score: 0, label: 'Offline', components };
  }

  const weighted = weightedScore(
    {
      latency: input.latencyTcpMs != null ? latencyScore(input.latencyTcpMs) : undefined,
      jitter: input.jitterMs != null ? jitterScore(input.jitterMs) : undefined,
      packetLoss: input.lossPct != null ? lossScore(input.lossPct) : undefined,
    },
    DEFAULT_WEIGHTS,
  );

  if (weighted.measured.length === 0) {
    return { score: null, label: null, components };
  }
  return { score: weighted.score, label: labelFor(weighted.score), components };
}
