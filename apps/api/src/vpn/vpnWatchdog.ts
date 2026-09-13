import type { VpnRegistry } from './vpnService';
import type { Logger } from '../logger';
import type { RealtimeBus } from '../realtime/bus';

/**
 * VPN drop watchdog.
 *
 * While a managed tunnel is up, this supervisor periodically asks the active
 * provider for status. When a previously-connected tunnel disappears (engine
 * crash, adapter change, sleep/resume tearing the interface down) it:
 *
 *   1. marks the tunnel down in process state (providers do this themselves
 *      in status()), and
 *   2. performs BOUNDED reconnect attempts with exponential backoff for the
 *      profile that was connected — 3 attempts at 5 s / 10 s / 20 s — unless
 *      the user disconnected deliberately or cancellation was requested.
 *
 * It deliberately does NOT attempt unbounded reconnection: a server that is
 * gone should surface as a failed tunnel, not an infinite retry loop.
 * Reconnects run through the same serialized operation chain as user actions
 * (serializeVpnOp in routes/vpn.ts) is NOT used here — the watchdog calls the
 * provider directly, and user-triggered reconnects race-resolution happens in
 * the provider's own connect() which refuses when a tunnel is already up.
 */

const DROP_POLL_MS = 10_000;
const RECONNECT_DELAYS_MS = [5_000, 10_000, 20_000];

export class VpnDropWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cancelled = false;
  private lastConnectedProfileId: string | null = null;
  private lastConnectedProviderId: string | null = null;
  private reconnecting = false;

  constructor(
    private readonly vpn: VpnRegistry,
    private readonly opts: {
      log?: Logger;
      bus?: RealtimeBus;
      event?: (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void;
      onReconnect?: (profileId: string, providerId: string, attempt: number) => void;
    } = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.cancelled = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, DROP_POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.cancelled = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** User-initiated disconnect: forget the last profile so no auto-reconnect fires. */
  acknowledgeUserDisconnect(): void {
    this.lastConnectedProfileId = null;
    this.lastConnectedProviderId = null;
  }

  private async tick(): Promise<void> {
    if (this.cancelled || this.reconnecting) return;
    try {
      const statuses = await Promise.all(this.vpn.all().map((p) => p.status().catch(() => null)));
      const active = statuses.find((s) => s?.connected);
      if (active) {
        this.lastConnectedProfileId = active.serverId;
        this.lastConnectedProviderId = active.providerId;
        return;
      }
      // Nothing connected: was something connected before (i.e. a drop)?
      if (!this.lastConnectedProfileId || !this.lastConnectedProviderId) return;
      const profileId = this.lastConnectedProfileId;
      const providerId = this.lastConnectedProviderId;
      // A drop happened. Forget it FIRST so a failed reconnect chain doesn't loop.
      this.lastConnectedProfileId = null;
      this.lastConnectedProviderId = null;

      const provider = this.vpn.get(providerId);
      const profile = this.vpn.getProfile(profileId);
      if (!provider || !profile) return;

      this.reconnecting = true;
      this.opts.event?.('warn', `VPN tunnel for "${profile.name}" dropped — starting bounded reconnect`, { profileId, providerId });
      this.opts.bus?.publish('vpn', { type: 'vpn:dropped', profileId, providerId });

      for (let attempt = 1; attempt <= RECONNECT_DELAYS_MS.length; attempt++) {
        if (this.cancelled) break;
        if (attempt > 1) await new Promise((r) => setTimeout(r, RECONNECT_DELAYS_MS[attempt - 1]));
        this.opts.onReconnect?.(profileId, providerId, attempt);
        try {
          await provider.connect(profile);
          this.opts.event?.('info', `VPN tunnel for "${profile.name}" restored (attempt ${attempt})`, { profileId, attempt });
          this.opts.bus?.publish('vpn', { type: 'vpn:reconnected', profileId, providerId, attempt });
          break;
        } catch (err) {
          this.opts.event?.(
            attempt === RECONNECT_DELAYS_MS.length ? 'error' : 'warn',
            `Reconnect attempt ${attempt}/${RECONNECT_DELAYS_MS.length} failed for "${profile.name}": ${err instanceof Error ? err.message : String(err)}`,
            { profileId, attempt },
          );
          if (attempt === RECONNECT_DELAYS_MS.length) {
            this.opts.bus?.publish('vpn', { type: 'vpn:reconnect_gave_up', profileId, providerId });
          }
        }
      }
      this.reconnecting = false;
    } catch {
      // status probes failing — treat as transient; next tick retries
    }
  }
}
