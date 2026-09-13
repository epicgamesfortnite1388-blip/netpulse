import type { StabilitySample, StabilityStatus } from '@netpulse/shared';
import { jitterMs } from '@netpulse/shared';

import type { RealtimeBus } from '../realtime/bus';
import type { StabilityRepository } from '../db/repositories';
import { udpQuery } from '../providers/dns/resolver';
import { DnsType } from '../providers/dns/codec';
import type { PlatformNetworkController } from '../providers/platform/types';
import type { EventService } from './eventService';

import type { Logger } from '../logger';

const STABILITY_TOPIC = 'stability';
const RETENTION_MS = 24 * 3600 * 1000;

/**
 * Continuous connection monitor: periodically measures latency (TCP connect),
 * DNS resolution time and connectivity; detects outages and latency spikes
 * and records both samples and events.
 */
export class StabilityService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private startedAt: number | null = null;
  private samples: StabilitySample[] = [];
  private outageActive = false;
  private intervalMs = 5_000;
  private consecutiveFailures = 0;

  constructor(
    private readonly deps: {
      controller: PlatformNetworkController;
      stability: StabilityRepository;
      events: EventService;
      bus: RealtimeBus;
      log: Logger;
    },
  ) {}

  start(intervalMs = 5_000): StabilityStatus {
    this.intervalMs = Math.min(Math.max(intervalMs, 2_000), 60_000);
    if (this.running) return this.status();
    this.running = true;
    this.startedAt = Date.now();
    this.consecutiveFailures = 0;
    this.deps.events.record('info', 'network', `Stability monitor started (every ${Math.round(this.intervalMs / 1000)}s)`);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    return this.status();
  }

  stop(): StabilityStatus {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.running) {
      this.running = false;
      this.deps.events.record('info', 'network', 'Stability monitor stopped');
    }
    this.startedAt = null;
    return this.status();
  }

  status(): StabilityStatus {
    return {
      running: this.running,
      intervalMs: this.intervalMs,
      startedAt: this.startedAt,
      samples: this.samples.slice(-300),
    };
  }

  private async tick(): Promise<void> {
    const { controller, stability, events, bus } = this.deps;
    try {
      const probe = await controller.tcpProbe('1.1.1.1', 443, 2_000, 4);

      // DNS resolution timing through the first system resolver
      let dnsMs: number | null = null;
      try {
        const servers = await controller.systemDnsServers();
        const server = servers[0];
        if (server) {
          const res = await udpQuery(server, 'example.com', DnsType.A, { timeoutMs: 1_500 });
          if (res.response?.rcode === 0) dnsMs = res.ms;
        }
      } catch {
        dnsMs = null;
      }

      // jitter/loss over the recent window
      const recentLatencies = this.samples.slice(-20).map((s) => s.latencyMs).filter((v): v is number => v != null);
      const windowLoss = this.samples.slice(-20);
      const lossPct = windowLoss.length > 0 ? (windowLoss.filter((s) => !s.online).length / windowLoss.length) * 100 : null;

      const sample: StabilitySample = {
        t: Date.now(),
        latencyMs: probe.ok ? probe.ms : null,
        jitterMs: jitterMs([...recentLatencies, probe.ms ?? 0].filter((v) => v > 0)),
        lossPct: lossPct == null ? null : Math.round(lossPct * 10) / 10,
        dnsMs,
        online: probe.ok,
      };
      this.samples.push(sample);
      if (this.samples.length > 600) this.samples = this.samples.slice(-600);
      stability.insertSample(sample);

      // events
      if (!probe.ok) {
        this.consecutiveFailures += 1;
        if (!this.outageActive && this.consecutiveFailures >= 2) {
          this.outageActive = true;
          events.record('error', 'network', 'Connection outage detected: no replies to stability probes', {});
        }
      } else {
        this.consecutiveFailures = 0;
        if (this.outageActive) {
          this.outageActive = false;
          events.record('info', 'network', `Connection recovered (${probe.ms} ms)`, {});
        } else {
          // spike detection vs rolling baseline
          const baseline = recentLatencies.slice(0, -1);
          if (baseline.length >= 8) {
            const sorted = [...baseline].sort((a, b) => a - b);
            const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0;
            const cur = probe.ms ?? 0;
            if (p50 > 0 && cur > p50 * 2 && cur - p50 > 30) {
              events.record('warn', 'network', `Latency spike: ${cur} ms (baseline median ${p50} ms)`, {});
            }
          }
        }
      }

      bus.publish(STABILITY_TOPIC, { type: 'stability:sample', sample });

      // prune old rows occasionally (1/50 ticks)
      if (Math.random() < 0.02) {
        stability.prune(Date.now() - RETENTION_MS);
      }
    } catch (err) {
      this.deps.log.warn({ err }, 'stability tick failed');
    }
  }
}
