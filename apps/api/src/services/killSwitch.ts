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

import net from 'node:net';

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

/** The shape of a proxy handoff this app owns (after `socks=` stripping): a
 *  loopback endpoint. Third-party proxies (corp, other VPN tools) are not. */
function isLoopbackProxy(value: string | null): boolean {
  if (!value) return false;
  const host = value.split(':')[0]?.trim().toLowerCase() ?? '';
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/**
 * A CLEARED hold is persisted as `{}` (see `saveHold`), which is not evidence
 * that this app ever took the system proxy over. The boolean `blocking` flag is
 * what every live hold record carries — and what `saveHold(null)` writes
 * without — so requiring it is what separates "there is a handoff to undo" from
 * "the last session left nothing behind". Trusting the empty row instead meant
 * every launch of the app could write the proxy setting.
 */
function isHoldRecord(value: unknown): value is KillSwitchHoldRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as KillSwitchHoldRecord).blocking === 'boolean'
  );
}

/** `host:port` / `[::1]:port` as an endpoint, or null for anything else. */
function parseHostPort(value: string | null): { host: string; port: number } | null {
  if (!value) return null;
  const match = value.trim().match(/^\[?([^\]:]+)\]?:(\d+)$/);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host: match[1] ?? '', port };
}

/**
 * Is anything listening on this loopback proxy endpoint? A bare TCP connect
 * sends no bytes, so a live proxy sees a connection that is immediately
 * dropped, and a port with no listener fails at once.
 */
async function proxyEndpointAlive(proxy: string | null): Promise<boolean> {
  const endpoint = parseHostPort(proxy);
  if (!endpoint) return false;
  return new Promise((resolve) => {
    const socket = net.connect({ host: endpoint.host, port: endpoint.port });
    let settled = false;
    const finish = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(300);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

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
  /** persisted hold, so a crash mid-block can be undone on the next boot.
   *  `unknown`: the row is JSON in a settings table — including the `{}` that a
   *  cleared hold leaves behind — so it is validated before it is believed. */
  loadHold?(): unknown;
  /** Is a proxy endpoint answering? Injected by tests; defaults to a TCP probe. */
  endpointAlive?(proxy: string | null): Promise<boolean>;
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
    // The value to hand back is ALWAYS the one captured before the block. A
    // re-arm after a drop (the watchdog healing a capture) reads the CURRENT
    // system proxy — which, while we are blocking, is the sink WE wrote — so
    // adopting the caller's reading would both lose the user's setting and
    // make the sink the thing that gets "restored" later, leaving the machine
    // pointed at a dead port with nothing left to explain why.
    const callerReadsOurSink = normalizeProxyValue(input.previousProxy) === KILL_SWITCH_SINK;
    const previousProxy =
      (this.hold != null && (callerReadsOurSink || this.sinkApplied)) || (this.hold == null && callerReadsOurSink)
        ? (this.hold?.previousProxy ?? null)
        : input.previousProxy;
    // Claim the hold, but only keep it if the recovery record was persisted:
    // that record is what undoes the handoff after a crash, so a failed write
    // means the hold is not real. Rolling back keeps `status().armed` honest —
    // a caller that swallows this error must never be reading `armed: true`.
    const before = { hold: this.hold, blockingAt: this.blockingAt, blockReason: this.blockReason, since: this.since };
    this.hold = { previousProxy, label: input.label, mode };
    this.blockingAt = null;
    this.blockReason = null;
    this.since = Date.now();
    this.lastError = null;
    try {
      this.deps.saveHold?.({ previousProxy, label: input.label, blocking: false });
    } catch (err) {
      this.hold = before.hold;
      this.blockingAt = before.blockingAt;
      this.blockReason = before.blockReason;
      this.since = before.since;
      this.lastError = `kill-switch hold could not be persisted: ${err instanceof Error ? err.message : String(err)}`;
      this.deps.event?.('error', this.lastError);
      throw new Error(this.lastError);
    }
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
   * Boot recovery — the force-kill cleanup guard. The hold record persisted
   * at arm time is the proof of WHAT we took over, so the next boot can undo
   * it no matter how the last session ended:
   *   - `blocking: true`  → the last session died fail-closed: the OS still
   *     points at our sink and the machine is cut off. Restore.
   *   - `blocking: false` → an ordinary system-proxy handoff was live. If the
   *     process was force-killed, nothing ever ran its restore path and the
   *     OS keeps pointing at a dead local port — every proxy-honoring app
   *     breaks with no process left to explain why (observed live: a killed
   *     app left ProxyEnable=1 → 127.0.0.1:<port> with nothing listening).
   *     Restore the captured value in both cases; if the OS already shows the
   *     user's own value (clean shutdown got there first), write nothing.
   * The record is dropped either way — it describes the previous session.
   *
   * Two things this guard must NOT do, both learned from live behavior:
   *   - believe a CLEARED record (`{}`) as a hold: it captured nothing, so it
   *     restores nothing — writing here deletes the user's proxy every launch;
   *   - claim a loopback proxy as OURS because it is loopback. This app is a
   *     VPN client competing for one setting with every other proxy tool on
   *     the machine, and those are all loopback too. Observed live: boot
   *     recovery deleted a user's working v2rayN proxy within a second of
   *     launch, after which the app's own cloud traffic had to go direct into
   *     a filtered network. Liveness decides: a dead port is our stranded
   *     handoff (restore), a port something answers on belongs to someone who
   *     is here now (leave it).
   */
  async recoverAfterRestart(): Promise<KillSwitchStatus> {
    const record = this.deps.loadHold?.() ?? null;
    if (!isHoldRecord(record)) return this.status();
    let current: string | null = null;
    try {
      current = (await this.deps.getSystemProxy()).proxy;
    } catch {
      current = null;
    }
    const ours = normalizeProxyValue(current);
    const captured = normalizeProxyValue(record.previousProxy);
    const strandedSink = record.blocking && ours === KILL_SWITCH_SINK;
    /**
     * A stale handoff is only claimed when the OS points at a LOOPBACK proxy
     * that differs from what we captured AND nothing is answering on that port.
     * A non-loopback value belongs to a tool on the network (a corp proxy), and
     * a loopback port that answers belongs to a tool running right now —
     * writing our captured value over either would stomp a proxy that works.
     * Replacing a dead local port always fixes something; restoring nothing
     * never breaks networking.
     */
    const strandedHandoff =
      ours !== captured && isLoopbackProxy(ours) && !(await this.endpointAlive(ours));
    if (strandedSink || strandedHandoff) {
      const set = await this.deps.setSystemProxy(record.previousProxy);
      this.deps.event?.(
        set.ok ? (strandedSink ? 'warn' : 'info') : 'error',
        set.ok
          ? strandedSink
            ? `Kill switch state recovered after a restart: the tunnel was gone but traffic was still blocked, so the previous proxy was restored`
            : `Stale system-proxy handoff recovered after a restart: the previous session exited without restoring it, so the captured setting was put back`
          : `Kill switch state recovered after a restart but the previous proxy could not be restored: ${set.error ?? 'unknown error'}`,
      );
    }
    this.deps.saveHold?.(null);
    this.clearHold();
    return this.status();
  }

  /** Who owns the proxy the OS currently points at. Test seam over the probe. */
  private endpointAlive(proxy: string | null): Promise<boolean> {
    return this.deps.endpointAlive?.(proxy) ?? proxyEndpointAlive(proxy);
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
