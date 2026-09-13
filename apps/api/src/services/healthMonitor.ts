import type { ServerHealthStatus } from '@netpulse/shared';
import { jitterScore, latencyScore, lossScore, weightedScore } from '@netpulse/shared';

import type { ServerHealthRepository, ServersRepository } from '../db/repositories';
import type { PlatformNetworkController } from '../providers/platform/types';
import type { EventService } from './eventService';

import type { Logger } from '../logger';

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Background health monitor: probes every enabled server on an interval
 * (ICMP latency + TCP reachability), stores a health sample and records
 * status transitions to the event log.
 */
export class HealthMonitorService {
  private timer: NodeJS.Timeout | null = null;
  private lastStatus = new Map<string, ServerHealthStatus>();
  private running = false;

  constructor(
    private readonly deps: {
      controller: PlatformNetworkController;
      servers: ServersRepository;
      health: ServerHealthRepository;
      events: EventService;
      log: Logger;
    },
  ) {}

  start(intervalMs = DEFAULT_INTERVAL_MS): void {
    if (this.running) return;
    this.running = true;
    const interval = Math.min(Math.max(intervalMs, 15_000), 600_000);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), interval);
    this.deps.log.info(`health monitor started (every ${Math.round(interval / 1000)}s)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  async checkServer(serverId: string): Promise<void> {
    const { controller, servers, health } = this.deps;
    const server = servers.get(serverId);
    if (!server || !server.enabled) return;

    const checkedAt = Date.now();
    let pingMs: number | null = null;
    let jitterMs: number | null = null;
    let loss: number | null = null;

    const ip = server.ipv4 ?? server.host;
    try {
      const ping = await controller.icmpPing(ip, { count: 3, timeoutMs: 2_000, family: 4 });
      pingMs = ping.avg;
      jitterMs = ping.jitterMs;
      loss = ping.lossPct;
    } catch {
      pingMs = null;
    }

    const tcpTarget = server.ipv4 ?? server.host;
    const tcpOk = server.port
      ? (await controller.tcpProbe(tcpTarget, server.port, 3_000).catch(() => ({ ok: false, ms: null }))).ok
      : null;

    let status: ServerHealthStatus;
    if (pingMs != null && (loss ?? 100) <= 2) status = 'online';
    else if (tcpOk === true) status = 'degraded';
    else if (pingMs != null) status = 'degraded';
    else status = 'offline';

    const components = {
      latency: pingMs != null ? latencyScore(pingMs) : undefined,
      packetLoss: loss != null ? lossScore(loss) : undefined,
      jitter: jitterMs != null ? jitterScore(jitterMs) : undefined,
    };
    const weighted = weightedScore(components, { latency: 30, packetLoss: 20, jitter: 15, throughput: 20, routeQuality: 10, load: 5 });
    const score = weighted.measured.length > 0 ? weighted.score : null;

    health.insert({ serverId, checkedAt, pingMs, jitterMs, packetLoss: loss, status, healthScore: score });

    const prev = this.lastStatus.get(serverId);
    if (prev !== status) {
      this.lastStatus.set(serverId, status);
      this.deps.events.record(status === 'offline' ? 'error' : status === 'degraded' ? 'warn' : 'info', 'network', `Server ${server.name} is now ${status}`, { serverId });
    }
  }

  private async tick(): Promise<void> {
    const servers = this.deps.servers.list().filter((s) => s.enabled);
    await Promise.allSettled(servers.map((s) => this.checkServer(s.id)));
  }
}
