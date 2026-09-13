import type { ScheduleStatus, ScheduledRunStatus } from '@netpulse/shared';

import type { RealtimeBus } from '../realtime/bus';
import type { DnsService } from './dnsService';
import type { EventService } from './eventService';
import type { GamingService } from './gamingService';
import type { SettingsService } from './settingsService';
import type { VpnSelfTestService } from './vpnSelfTestService';

import type { Logger } from '../logger';

export type ScheduledKind = 'dns' | 'gaming' | 'vpn';

export const SCHEDULE_TOPIC = 'schedule';

/**
 * Recurring benchmark scheduler.
 *
 * Reads `settings.scheduling` and arms one unref'd timer per test kind. A run
 * that is still in progress when its timer fires is skipped (never stacked),
 * and the next run is scheduled after the previous one completes so runs never
 * overlap. Every state change is published on the `schedule` bus topic (which
 * replays its last message to late subscribers) so the UI can show live
 * "next run" state without polling.
 */
export class ScheduleService {
  private readonly timers: { dns: NodeJS.Timeout | null; gaming: NodeJS.Timeout | null; vpn: NodeJS.Timeout | null } = { dns: null, gaming: null, vpn: null };
  private readonly running: { dns: boolean; gaming: boolean; vpn: boolean } = { dns: false, gaming: false, vpn: false };
  private status: ScheduleStatus = {
    dns: emptyStatus(),
    gaming: emptyStatus(),
    vpn: emptyStatus(),
    updatedAt: Date.now(),
  };
  private started = false;

  constructor(
    private readonly deps: {
      settings: SettingsService;
      dns: DnsService;
      gaming: GamingService;
      vpnSelfTest: VpnSelfTestService;
      events: EventService;
      bus: RealtimeBus;
      log: Logger;
    },
  ) {
    // Settings are the source of truth for what is scheduled; a PUT /settings
    // that touches scheduling re-arms immediately.
    this.deps.settings.setOnChange(() => {
      if (this.started) this.reconfigure();
    });
  }

  start(): void {
    this.started = true;
    this.reconfigure();
  }

  stop(): void {
    this.started = false;
    this.clearTimer('dns');
    this.clearTimer('gaming');
    this.clearTimer('vpn');
  }

  /** Re-read settings and re-arm all timers. Safe to call at any time. */
  reconfigure(): void {
    if (!this.started) return;
    const s = this.deps.settings.get().scheduling;
    this.arm('dns', s.dnsEnabled, s.dnsIntervalMin);
    this.arm('gaming', s.gamingEnabled, s.gamingIntervalMin);
    this.arm('vpn', s.vpnSelfTestEnabled, s.vpnSelfTestIntervalMin);
    this.publish();
  }

  statusSnapshot(): ScheduleStatus {
    return this.status;
  }

  /** Trigger an immediate run (used by "Run now" and tests). */
  async runNow(kind: ScheduledKind): Promise<ScheduleStatus> {
    await this.run(kind);
    return this.status;
  }

  /* ------------------------------ internals ------------------------------ */

  private arm(kind: ScheduledKind, enabled: boolean, intervalMin: number): void {
    this.clearTimer(kind);
    const st = this.status[kind];
    if (!enabled || this.running[kind]) {
      st.enabled = enabled;
      st.intervalMin = intervalMin;
      st.nextRunAt = null;
      return;
    }
    // keep an already-scheduled future run if the interval didn't change
    let delayMs: number;
    if (st.enabled && st.intervalMin === intervalMin && st.nextRunAt && st.nextRunAt > Date.now()) {
      delayMs = st.nextRunAt - Date.now();
    } else {
      delayMs = intervalMin * 60_000;
    }
    st.enabled = true;
    st.intervalMin = intervalMin;
    st.nextRunAt = Date.now() + delayMs;
    const timer = setTimeout(() => void this.run(kind), delayMs);
    // do not keep the process alive just for a benchmark timer
    (timer as NodeJS.Timeout & { unref?: () => void }).unref?.();
    this.timers[kind] = timer;
  }

  private clearTimer(kind: ScheduledKind): void {
    const timer = this.timers[kind];
    if (timer) clearTimeout(timer);
    this.timers[kind] = null;
  }

  private async run(kind: ScheduledKind): Promise<void> {
    if (this.running[kind]) return; // a previous run is still in flight — skip, never stack
    this.running[kind] = true;
    const st = this.status[kind];
    st.running = true;
    st.lastRunAt = Date.now();
    this.publish();

    try {
      if (kind === 'dns') {
        await this.deps.dns.runTest({ probes: 4, timeoutMs: 2_000, transport: 'udp' });
      } else if (kind === 'vpn') {
        // The dry-run result IS the outcome: ok/unavailable/error. An
        // 'unavailable' finding (no engine, no profiles) is an honest
        // environmental state, not a scheduler failure.
        const result = await this.deps.vpnSelfTest.run('scheduled');
        if (result.state === 'error') throw new Error(result.detail);
      } else {
        const settings = this.deps.settings.get().scheduling;
        const gameId = settings.gamingGameId ?? firstGameId(this.deps.gaming.listGames());
        await this.deps.gaming.runGameTest({ gameId });
      }
      st.lastResult = 'ok';
      st.lastError = null;
      this.deps.events.record('info', kind === 'dns' ? 'dns' : kind === 'vpn' ? 'vpn' : 'gaming', `Scheduled ${kind === 'dns' ? 'DNS benchmark' : kind === 'vpn' ? 'VPN self-test' : 'gaming test'} completed automatically`, {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      st.lastResult = 'error';
      st.lastError = message;
      this.deps.events.record('warn', kind === 'dns' ? 'dns' : kind === 'vpn' ? 'vpn' : 'gaming', `Scheduled ${kind === 'dns' ? 'DNS benchmark' : kind === 'vpn' ? 'VPN self-test' : 'gaming test'} failed: ${message}`, {});
      this.deps.log.warn({ err, kind }, 'scheduled benchmark failed');
    } finally {
      st.running = false;
      this.running[kind] = false;
      // settings may have changed while the run was in flight — re-read them
      const s = this.deps.settings.get().scheduling;
      this.arm(
        kind,
        s[kind === 'dns' ? 'dnsEnabled' : kind === 'vpn' ? 'vpnSelfTestEnabled' : 'gamingEnabled'],
        s[kind === 'dns' ? 'dnsIntervalMin' : kind === 'vpn' ? 'vpnSelfTestIntervalMin' : 'gamingIntervalMin'],
      );
      this.publish();
    }
  }

  private publish(): void {
    this.status.updatedAt = Date.now();
    this.deps.bus.publish(SCHEDULE_TOPIC, { type: 'schedule:status', status: this.status });
  }
}

function emptyStatus(): ScheduledRunStatus {
  return {
    enabled: false,
    intervalMin: 60,
    running: false,
    lastRunAt: null,
    lastResult: null,
    lastError: null,
    nextRunAt: null,
  };
}

function firstGameId(games: { id: string }[]): string {
  if (games.length === 0) throw new Error('No games available for the scheduled gaming test');
  return games[0]!.id;
}