/**
 * TUN gateway handle — the ONE owner of system-wide (TUN) capture state.
 *
 * Every engine that can take the OS default route (the proxy tunnel's sing-box
 * gateway, and Aether's) used to carry its own copy of this state machine, and
 * the two copies drifted. What it owns is a set of honesty rules that must hold
 * identically wherever TUN mode exists:
 *
 *   1. `active` means traffic PROVABLY traversed the device. A process that
 *      started is not a tunnel: the gateway is verified with a real request
 *      through its own inbound, and anything less is reported as a failure.
 *   2. A gateway whose relay check fails is STOPPED before returning. A live
 *      TUN device holds the default route no matter what the status says, so
 *      leaving one up blackholes the machine's traffic (DNS included) while the
 *      status claims TUN is not capturing. The caller keeps serving in proxy
 *      mode; the device does not survive.
 *   3. The device dying is not a normal exit. The kernel withdraws the TUN
 *      routes with the process, so the drop is handed to the kill switch (fail
 *      closed when it is on) instead of silently falling back to the direct
 *      path. A device we killed ourselves is deliberately NOT that event.
 *
 * Callers supply only what is genuinely theirs — which port to front, which
 * addresses must stay out of the route, who to notify, which hold to arm — and
 * then read `status()` straight into their own status payloads.
 */
import type { BypassRuleSet } from '@netpulse/shared';

import { findEngineBinary, startTunGateway, tunGatewayStartRefusal } from './proxyCores';

import type { CoreRun } from './proxyCores';

/** The running device this state machine owns (the gateway is a core run). */
export type TunGatewayDevice = Pick<CoreRun, 'child' | 'cleanup'>;

/** `requested` = asked for, not (yet) proven; `active` = verified; null = not capturing. */
export type TunState = 'requested' | 'active' | null;

/** Whose problem a degraded TUN mode is: the privilege layer, the core, the path. */
export type TunBlockedBy = 'admin' | 'core' | 'relay' | null;

/** The TUN slice of a status payload, in exactly the shape both surfaces publish. */
export interface TunGatewayStatus {
  tun: TunState;
  tunError: string | null;
  tunBlockedBy: TunBlockedBy;
  tunGatewayPort: number | null;
}

/**
 * A transition, reported exactly once per change.
 *
 * A crash reports no `blockedBy`: nothing was *blocked*, capture was lost, and
 * the caller's payload must not claim a cause it did not diagnose.
 */
export type TunGatewayEvent =
  | { kind: 'requested' }
  | { kind: 'active'; exitIp: string; gatewayPort: number }
  | { kind: 'degraded'; error: string; blockedBy?: Exclude<TunBlockedBy, null> };

export interface TunGatewayOptions {
  /** `http` fronts a local core's inbound; `socks` fronts an engine that speaks SOCKS5. */
  upstream: 'http' | 'socks';
  /** The local port the device must forward to (null = nothing to front yet). */
  upstreamPort(): number | null;
  /** Bypass rules the device applies to its own traffic, if any. */
  bypass?(): BypassRuleSet | null;
  /**
   * Addresses the device must NOT capture: the hop's own dial out. Without it
   * that dial is captured by the device, handed back to the gateway and
   * forwarded to the hop again — a loop that relays nothing while the device
   * holds the default route.
   */
  excludeAddresses?(): Promise<string[]>;
  /** Label for the route-mode kill-switch hold. */
  label(): string;
  /**
   * Arm the route-mode kill switch. The device owns the default route and the
   * system proxy was NOT touched, so this is the decision point that turns a
   * drop into a block instead of a silent fallback to direct. Called only after
   * the relay is verified; errors are the caller's to report (they never change
   * this handle's verdict).
   */
  armRouteMode?(): void | Promise<void>;
  /** The device died while capturing; the kill switch decides block vs restore. */
  onCapturedDrop?(reason: string): void;
  /** Where every transition is reported (each caller has its own event surface). */
  onState?(event: TunGatewayEvent): void;
}

/** The seams the handle needs from the outside world, injectable for tests. */
export interface TunGatewayRuntime {
  /** Start the device in front of an upstream port. Defaults to the real core. */
  startGateway?: typeof startTunGateway;
  /**
   * Probe the gateway's verification inbound and return the exit address the
   * reply carried, or null when it carried none. Injected because each caller
   * owns its fetch seam (the tunnel service's `fetchThroughPort`, Aether's
   * HTTP-CONNECT fetch) — the handle must not reach into either.
   */
  verifyRelay(gatewayPort: number): Promise<string | null>;
}

/** The only core with a TUN inbound. */
const TUN_CAPABLE_ENGINE = 'sing-box';

const NO_UPSTREAM = 'engine hop has no inbound port to route through';
const NO_CORE =
  'TUN mode needs sing-box (the only core with a TUN inbound) and it is not installed — install it on the sing-box tab, then reconnect in proxy mode.';
const NO_EXIT_IP = 'trace through the TUN gateway did not contain an ip= line';

/** How long the device gets to open its inbound before the start is a failure. */
const READY_TIMEOUT_MS = 12_000;

export class TunGatewayHandle {
  private state: TunState = null;
  private error: string | null = null;
  private blockedBy: TunBlockedBy = null;
  private port: number | null = null;
  private device: TunGatewayDevice | null = null;

  constructor(
    private readonly opts: TunGatewayOptions,
    private readonly runtime: TunGatewayRuntime,
  ) {}

  /** True only while capture is proven (see rule 1). */
  get active(): boolean {
    return this.state === 'active';
  }

  /** Snapshot in the payload shape both callers publish. */
  status(): TunGatewayStatus {
    return { tun: this.state, tunError: this.error, tunBlockedBy: this.blockedBy, tunGatewayPort: this.port };
  }

  /**
   * Bring the device up in front of the upstream port and prove it relays.
   * Returns true only for a verified capture; every other outcome is a degraded
   * status with the real reason, and the device is never left running.
   */
  async start(): Promise<boolean> {
    // One device at a time: a previous run (a reconnect, a retry) is torn down
    // first, deliberately, so its exit is not mistaken for a crash.
    this.stop();
    this.state = 'requested';
    this.error = null;
    this.blockedBy = null;
    this.port = null;
    this.opts.onState?.({ kind: 'requested' });

    const refusal = tunGatewayStartRefusal();
    if (refusal) return this.degrade(refusal, 'admin');

    const bin = findEngineBinary(TUN_CAPABLE_ENGINE);
    if (!bin) return this.degrade(NO_CORE, 'core');

    const upstreamPort = this.opts.upstreamPort();
    if (upstreamPort == null) return this.degrade(NO_UPSTREAM, 'relay');

    const excludeAddresses = (await this.opts.excludeAddresses?.()) ?? [];
    const started = await (this.runtime.startGateway ?? startTunGateway)(
      bin,
      upstreamPort,
      this.opts.bypass?.() ?? null,
      READY_TIMEOUT_MS,
      this.opts.upstream,
      excludeAddresses,
    );
    if (!started.ok) return this.degrade(started.error, 'relay');

    this.device = { child: started.run.child, cleanup: started.run.cleanup };
    this.watch(started.run);

    let exitIp: string | null;
    try {
      exitIp = await this.runtime.verifyRelay(started.gatewayPort);
      if (!exitIp) throw new Error(NO_EXIT_IP);
    } catch (err) {
      // Rule 2: the device came up but nothing provably traversed it. Kill it
      // before reporting — a live device holds the default route regardless of
      // what the caller's status says.
      this.stop();
      return this.degrade(
        `gateway started but the TUN path did not relay: ${reasonOf(err)} — the gateway was stopped, so the system is not left routed into a dead tunnel`,
        'relay',
      );
    }

    this.state = 'active';
    this.port = started.gatewayPort;
    try {
      await this.opts.armRouteMode?.();
    } catch {
      // Arming the hold is the caller's to report: a failed arm must not undo a
      // capture that is genuinely up, and must never surface as a relay failure.
    }
    this.opts.onState?.({ kind: 'active', exitIp, gatewayPort: started.gatewayPort });
    return true;
  }

  /**
   * Tear the device down and stop claiming capture. Idempotent, and silent: a
   * device we stop is a deliberate teardown, not the drop in rule 3. The last
   * honest `error`/`blockedBy` are kept so the reason a previous attempt failed
   * stays visible until the next one.
   */
  stop(): void {
    const device = this.device;
    // Forget the device BEFORE killing it, so its exit event finds no owner and
    // cannot be reported as an unexpected death.
    this.device = null;
    this.state = null;
    this.port = null;
    if (device) {
      try {
        device.cleanup();
      } catch {
        // already dead — cleanup is idempotent by contract
      }
    }
  }

  /** Rule 3: the device died while we believed it was capturing. */
  private watch(run: { child: TunGatewayDevice['child']; cleanup: () => void }): void {
    run.child.once('close', (code: number | null) => {
      if (this.device?.cleanup !== run.cleanup) return; // stopped or replaced
      this.device = null;
      this.state = null;
      this.port = null;
      try {
        run.cleanup();
      } catch {
        // already dead
      }
      const reason = `TUN gateway exited unexpectedly (code ${code ?? '?'})`;
      this.error = reason;
      // The kernel withdrew the routes with the process; without this the
      // machine would silently fall back to the direct path.
      this.opts.onCapturedDrop?.(reason);
      this.opts.onState?.({ kind: 'degraded', error: reason });
    });
  }

  private degrade(error: string, blockedBy: Exclude<TunBlockedBy, null>): false {
    this.state = null;
    this.port = null;
    this.error = error;
    this.blockedBy = blockedBy;
    this.opts.onState?.({ kind: 'degraded', error, blockedBy });
    return false;
  }
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
