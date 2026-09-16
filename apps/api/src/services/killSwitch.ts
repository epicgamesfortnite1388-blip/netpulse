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
  /** a proxy-mode tunnel is up and holds the system-proxy handoff */
  armed: boolean;
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

interface Hold {
  previousProxy: string | null;
  label: string;
}

export class KillSwitchService {
  private hold: Hold | null = null;
  private blockingAt: number | null = null;
  private blockReason: string | null = null;
  private since: number | null = null;
  private lastError: string | null = null;

  constructor(private readonly deps: KillSwitchDeps) {}

  /**
   * Take ownership of the handoff after a tunnel has successfully set the
   * system proxy. Records what to restore; writes nothing itself.
   */
  arm(input: { previousProxy: string | null; label: string }): KillSwitchStatus {
    this.hold = { previousProxy: input.previousProxy, label: input.label };
    this.blockingAt = null;
    this.blockReason = null;
    this.since = Date.now();
    this.lastError = null;
    this.deps.saveHold?.({ previousProxy: input.previousProxy, label: input.label, blocking: false });
    if (this.deps.enabled()) {
      this.deps.event?.('info', `Kill switch armed for "${input.label}" — a drop will block non-bypassed traffic`);
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
    if (this.blockingAt != null) await this.restoreHold();
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
    const layer = 'Enforced at the system-proxy layer, so a failure blocks apps that honour the system proxy (this build does not install OS firewall rules).';
    if (blocking) {
      return `ENGAGED: the tunnel dropped, so non-bypassed traffic is fail-closed. ${exempt} ${layer}`;
    }
    return `Armed: if this tunnel drops, non-bypassed traffic is blocked instead of falling back to a direct connection. ${exempt} ${layer}`;
  }
}
