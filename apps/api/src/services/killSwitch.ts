/**
 * Kill switch for proxy-mode tunnels (Aether, and the proxy tunnel core).
 *
 * The problem it solves honestly: proxy-mode engines never take the default
 * route — the OS is routed by the *system proxy setting* pointing at the
 * engine's local port. If the engine dies while that setting still points at
 * its (now dead) port, apps fail to connect; but if anything restores the
 * user's original proxy on a crash, those apps silently fall back to a DIRECT
 * connection — traffic that was supposed to be tunnelled leaks out.
 *
 * The rule implemented here (Aether-style):
 *   - a tunnel that takes the system proxy also ARMS this service;
 *   - a DROP while the user enabled the kill switch is fail-closed: the system
 *     proxy is pointed at a sink that answers nothing, so proxied traffic
 *     cannot reach the network until the tunnel is back or the user disconnects;
 *   - a DROP with the kill switch disabled restores the user's previous proxy
 *     (direct access returns deliberately, not by accident);
 *   - an explicit stop always restores the user's previous proxy.
 *
 * What stays reachable: the destinations in the existing split-tunnel rule set
 * (`BypassRuleSet`) are dialled DIRECT by the tunnel itself — they never went
 * through the system proxy, so the block does not apply to them. The same rule
 * set is what the Aether engine receives as `[direct]` routes.
 *
 * Honest limits, stated in the status: enforcement is at the system-proxy layer
 * (WinINET on Windows). Applications that ignore the system proxy are outside
 * this guarantee — no SOCKS-mode client can claim otherwise without OS firewall
 * rules, which this build does not install.
 */
import { bypassSummary } from '@netpulse/shared';

import type { BypassRuleSet } from '@netpulse/shared';

/**
 * Compare proxy settings modulo the shapes Windows accepts for one value
 * (`127.0.0.1:9` and `socks=127.0.0.1:9` address the same endpoint).
 */
function normalizeProxyValue(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.replace(/^[a-z0-9-]+=/, '');
}

/**
 * Where proxied traffic is sent while the switch is engaged: the discard port
 * on loopback. Nothing in this app listens there, so connections fail fast and
 * no packet leaves the machine.
 */
export const KILL_SWITCH_SINK = '127.0.0.1:9';

export interface KillSwitchStatus {
  /** the user enabled it in Settings → VPN */
  enabled: boolean;
  /** a tunnel is up and this service holds its handoff */
  armed: boolean;
  /**
   * Which capture the armed tunnel holds: `proxy` = system-proxy handoff,
   * `route` = TUN owns the default route. null when not armed. The drop
   * decision is the same in both modes, but the note must say honestly what
   * each mode can and cannot enforce.
   */
  mode: 'proxy' | 'route' | null;
  /** traffic is currently fail-closed */
  blocking: boolean;
  /** what stays direct because the split-tunnel rules dial it direct */
  bypassSummary: string | null;
  /** the proxy value that will be restored when the tunnel stops */
  previousProxy: string | null;
  /** when the current state began */
  since: number | null;
  /** why it is blocking (null when it is not) */
  reason: string | null;
  /** human explanation of what is and is not enforced */
  note: string | null;
}

/** What we remember across restarts so a crash cannot strand the machine. */
export interface KillSwitchHoldRecord {
  previousProxy: string | null;
  label: string;
  blocking: boolean;
}

export interface KillSwitchDeps {
  setSystemProxy(proxyOrNull: string | null): Promise<{ ok: boolean; error?: string }>;
  getSystemProxy(): Promise<{ proxy: string | null }>;
  /** user preference: Settings → VPN → kill switch */
  enabled(): boolean;
  /** the live split-tunnel rule set (normalized), or null when inactive */
  bypass(): BypassRuleSet | null;
  event?(level: 'info' | 'warn' | 'error', message: string): void;
  publish?(kind: string, payload: Record<string, unknown>): void;
  /** persisted hold, so a crash mid-block can be undone on the next boot */
  loadHold?(): KillSwitchHoldRecord | null;
  saveHold?(record: KillSwitchHoldRecord | null): void;
}

export interface KillSwitchArmInput {
  previousProxy: string | null;
  label: string;
  /**
   * 'proxy' (default): the tunnel took over the system proxy — restore it on
   * stop. 'route': the TUN device owns the default route and the system proxy
   * was NOT touched — on drop, the kernel withdraws the TUN routes and traffic
   * would silently fall back to direct, so the switch must step in itself.
   */
  mode?: 'proxy' | 'route';
}

interface Hold {
  previousProxy: string | null;
  label: string;
  /** 'proxy' = we own the system-proxy handoff; 'route' = the TUN device owns the route */
  mode: 'proxy' | 'route';
}

export class KillSwitchService {
  private hold: Hold | null = null;
  private blockingAt: number | null = null;
  private blockReason: string | null = null;
  private since: number | null = null;
  private lastError: string | null = null;
  /**
   * True only while the sink proxy is ACTUALLY applied (a drop wrote it and no
   * restore has run since). Route mode must survive a drop → re-arm cycle:
   * reconnecting clears `blockingAt`, but the OS still points at the sink, so
   * the next arm or stop has to clear it — and a route-mode hold that never
   * applied anything must never write the proxy at all.
   */
  private sinkApplied = false;

  constructor(private readonly deps: KillSwitchDeps) {}

  /**
   * Persist the hold BEFORE the system proxy is written. A crash between
   * `setSystemProxy` and `arm()` would otherwise leave the OS pointing at a
   * dead port with no recovery record; with the hold on disk first, boot
   * recovery can always undo the handoff.
   */
  preArm(input: { previousProxy: string | null; label: string }): void {
    this.hold = { previousProxy: input.previousProxy, label: input.label, mode: 'proxy' };
    this.blockingAt = null;
    this.blockReason = null;
    this.since = null;
    this.lastError = null;
    this.deps.saveHold?.({ previousProxy: input.previousProxy, label: input.label, blocking: false });
  }

  /**
   * Claim the hold once the tunnel's capture is verified. In 'proxy' mode the
   * caller has already written the system proxy; in 'route' mode nothing was
   * written — the hold exists so the DROP decision point exists. If a previous
   * drop left the sink in place, re-arming (reconnect) clears it.
   */
  arm(input: KillSwitchArmInput): KillSwitchStatus {
    const mode = input.mode ?? 'proxy';
    this.hold = { previousProxy: input.previousProxy, label: input.label, mode };
    this.blockingAt = null;
    this.blockReason = null;
    this.since = Date.now();
    this.lastError = null;
    this.deps.saveHold?.({ previousProxy: input.previousProxy, label: input.label, blocking: false });
    if (mode === 'route' && this.sinkApplied) {
      // Re-arm after a drop: the sink is still applied from the previous drop
      // and the TUN device now owns the route again — proxy-aware apps would
      // send traffic to a dead port, so clear the sink as part of arming.
      void this.restoreHold().catch(() => undefined);
    }
    if (this.deps.enabled()) {
      this.deps.event?.(
        'info',
        mode === 'route'
          ? `Kill switch armed in route mode for "${input.label}" — a TUN drop will block non-bypassed traffic instead of falling back to direct`
          : `Kill switch armed for "${input.label}" — a drop will block non-bypassed traffic`,
      );
    }
    return this.status();
  }

  /**
   * A tunnel dropped WITHOUT the user asking. This is the decision point:
   * enabled → fail closed; disabled → give the user their direct proxy back.
   * Safe to call when nothing is armed (no-op): we never write a proxy we did
   * not take over.
   */
  async onTunnelDropped(reason: string): Promise<KillSwitchStatus> {
    if (!this.hold) return this.status();
    if (!this.deps.enabled()) {
      await this.restoreHold();
      this.hold = null;
      this.since = null;
      this.deps.event?.('info', `Tunnel dropped (${reason}); kill switch is off — previous proxy restored`);
      return this.status();
    }
    const set = await this.deps.setSystemProxy(KILL_SWITCH_SINK);
    if (!set.ok) {
      // Never claim a block we did not apply.
      this.lastError = set.error ?? 'system proxy write failed';
      this.blockingAt = null;
      this.blockReason = null;
      this.deps.event?.('error', `Kill switch could not block traffic: ${this.lastError}`);
      this.deps.publish?.('killswitch:error', { reason, error: this.lastError });
      return this.status();
    }
    this.blockingAt = Date.now();
    this.blockReason = reason;
    this.since = Date.now();
    this.sinkApplied = true;
    this.deps.saveHold?.({ previousProxy: this.hold.previousProxy, label: this.hold.label, blocking: true });
    this.deps.event?.('warn', `Kill switch engaged (${reason}) — non-bypassed traffic is blocked until the tunnel returns`);
    this.deps.publish?.('killswitch:engaged', { reason, sink: KILL_SWITCH_SINK });
    return this.status();
  }

  /**
   * The tunnel stopped on purpose. The tunnel restores the proxy itself, so
   * this only clears the hold — unless it is currently blocking (the user
   * disconnected while fail-closed), in which case the original proxy is put
   * back so "disconnect" always means "back to normal".
   */
  async onTunnelStopped(): Promise<KillSwitchStatus> {
    // Restore when the switch actually holds something of the user's:
    //   - we are blocking right now (disconnect while fail-closed), or
    //   - the capture was a system-proxy hold: arming in 'proxy' mode happens
    //     only AFTER that write succeeded, so the hold is the record of a write
    //     that must be handed back. The tunnel restores it too; doing it here as
    //     well is what keeps "disconnect means back to normal" true even when
    //     the tunnel's own restore failed.
    //   - route mode only when OUR sink is applied: otherwise the system proxy
    //     was never touched and writing would clobber the user's own setting.
    const holdsUsersProxy = this.hold != null && this.hold.mode !== 'route';
    if (this.blockingAt != null || holdsUsersProxy || this.sinkApplied) {
      await this.restoreHold();
    }
    this.clearHold();
    return this.status();
  }

  /**
   * Boot recovery. If the last session died while fail-closed, the OS proxy is
   * still pointed at the sink — the machine would be cut off with no process
   * left to explain why. Put the user's own proxy back and say so; if no block
   * was in effect, forget the stale record without writing anything.
   */
  async recoverAfterRestart(): Promise<KillSwitchStatus> {
    const record = this.deps.loadHold?.() ?? null;
    if (!record) return this.status();
    let current: string | null = null;
    try {
      current = (await this.deps.getSystemProxy()).proxy;
    } catch {
      current = null;
    }
    const stranded = record.blocking && normalizeProxyValue(current) === KILL_SWITCH_SINK;
    if (stranded) {
      const set = await this.deps.setSystemProxy(record.previousProxy);
      this.deps.event?.(
        set.ok ? 'warn' : 'error',
        set.ok
          ? `Kill switch state recovered after a restart: the tunnel was gone but traffic was still blocked, so the previous proxy was restored`
          : `Kill switch state recovered after a restart but the previous proxy could not be restored: ${set.error ?? 'unknown error'}`,
      );
    }
    this.deps.saveHold?.(null);
    this.clearHold();
    return this.status();
  }

  private clearHold(): void {
    this.hold = null;
    this.blockingAt = null;
    this.blockReason = null;
    this.since = null;
  }

  /**
   * Release the block without touching a healthy tunnel (used when the user
   * turns the kill switch off mid-session): restores the proxy and drops the
   * hold so a later drop cannot arm itself against a stale value.
   */
  async release(reason: string): Promise<KillSwitchStatus> {
    if (this.blockingAt != null) await this.restoreHold();
    this.clearHold();
    this.deps.saveHold?.(null);
    this.deps.event?.('info', `Kill switch released (${reason})`);
    return this.status();
  }

  /** Put the user's own proxy setting back exactly as it was. */
  private async restoreHold(): Promise<void> {
    if (!this.hold) return;
    const set = await this.deps.setSystemProxy(this.hold.previousProxy);
    if (!set.ok) {
      this.lastError = set.error ?? 'system proxy write failed';
      this.deps.event?.('error', `Kill switch could not restore the previous proxy: ${this.lastError}`);
      return;
    }
    this.sinkApplied = false;
    this.lastError = null;
  }

  status(): KillSwitchStatus {
    const enabled = this.deps.enabled();
    const blocking = this.blockingAt != null;
    const bypass = this.deps.bypass();
    const summary = bypass ? bypassSummary(bypass) : null;
    return {
      enabled,
      armed: this.hold != null,
      mode: this.hold?.mode ?? null,
      blocking,
      bypassSummary: summary,
      previousProxy: this.hold?.previousProxy ?? null,
      since: this.since,
      reason: this.blockReason,
      note: this.note(enabled, blocking, summary),
    };
  }

  private note(enabled: boolean, blocking: boolean, summary: string | null): string {
    if (this.lastError) {
      return `Kill switch could not apply its rule: ${this.lastError}. Traffic is NOT blocked.`;
    }
    if (!enabled) {
      return 'Kill switch is off (Settings → VPN). A drop restores your previous proxy and direct traffic resumes.';
    }
    const exempt = summary ? `Bypass-listed destinations stay direct (${summary}).` : 'No bypass rules are active, so nothing is exempt.';
    const routeMode = this.hold?.mode === 'route';
    if (routeMode) {
      const layer =
        'Enforced while TUN owns the default route: if the TUN device drops, its routes are withdrawn and the system proxy is pointed at a sink, so proxy-aware apps are blocked instead of falling back to direct. Apps that ignore the system proxy would still ride the withdrawn route back to direct — that residual window needs OS firewall rules, which this build does not install.';
      if (blocking) {
        return `ENGAGED: the TUN device dropped, so non-bypassed traffic is fail-closed at the system-proxy layer. ${exempt} ${layer}`;
      }
      return `Armed in route mode: if the TUN device drops, non-bypassed traffic is blocked instead of silently falling back to a direct connection. ${exempt} ${layer}`;
    }
    const layer = 'Enforced at the system-proxy layer, so a failure blocks apps that honour the system proxy (this build does not install OS firewall rules).';
    if (blocking) {
      return `ENGAGED: the tunnel dropped, so non-bypassed traffic is fail-closed. ${exempt} ${layer}`;
    }
    return `Armed: if this tunnel drops, non-bypassed traffic is blocked instead of falling back to a direct connection. ${exempt} ${layer}`;
  }
}
