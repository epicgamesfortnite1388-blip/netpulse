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
 *   4. A verified capture whose hold could not be armed is `unguarded`, never
 *      `active`. The device stays up (traffic is genuinely flowing), but the
 *      status must not promise a guarantee the machine does not have — the
 *      alternative was a log line nobody reads.
 *   5. A drop is handled fail-closed FIRST and healed SECOND: the kill switch is
 *      told immediately (so a capture loss never leaves a window where traffic
 *      leaks direct), and only then does the watchdog attempt ONE bounded
 *      automatic re-arm. It reports `recovering` while it tries — never
 *      `active`, because nothing is captured yet — and if the attempt does not
 *      restore a verified capture the drop stands, with the re-arm's own reason
 *      on the status. The budget is one attempt per capture generation, refilled
 *      only by a manual start or by a capture that held long enough to count as
 *      healthy, so a flapping gateway cannot become a respawn loop.
 *
 * Callers supply only what is genuinely theirs — which port to front, which
 * addresses must stay out of the route, who to notify, which hold to arm — and
 * then read `status()` straight into their own status payloads.
 */
import type { BypassRuleSet } from '@netpulse/shared';

import { tunGatewayRemedy } from '../util/privileges';
import { findEngineBinary, startTunGateway, tunGatewayStartRefusal } from './proxyCores';
import { sweepOrphanedTunGateways, tunSweepReport } from './tunClaim';

import type { CoreRun } from './proxyCores';
import type { TunSweepSummary } from './tunClaim';

/** The running device this state machine owns (the gateway is a core run). */
export type TunGatewayDevice = Pick<CoreRun, 'child' | 'cleanup'>;

/**
 * `requested`  = asked for, not (yet) proven
 * `recovering` = capture was lost and the watchdog is re-establishing it right
 *                now (nothing is captured while this is the state)
 * `active`     = verified AND guarded
 * `unguarded`  = verified capture whose fail-closed hold could not be armed
 * null         = not capturing
 */
export type TunState = 'requested' | 'recovering' | 'active' | 'unguarded' | null;

/**
 * Whose problem a degraded TUN mode is: privileges, the core, the path, the
 * hold, or a route a force-killed session left behind that only an elevated
 * process can release.
 */
export type TunBlockedBy = 'admin' | 'core' | 'relay' | 'kill-switch' | 'stranded-route' | null;

/** What the watchdog has done, so a recovery is visible after the fact. */
export interface TunWatchdogStatus {
  /** re-establishing capture right now */
  rearming: boolean;
  /** automatic re-arms used in this budget (0 = none) */
  autoAttempts: number;
  /** how many the budget allows before a drop simply stands */
  maxAutoAttempts: number;
  /** why the last automatic attempt did NOT restore capture (null when it did, or none ran) */
  lastError: string | null;
}

/** The TUN slice of a status payload, in exactly the shape both surfaces publish. */
export interface TunGatewayStatus {
  tun: TunState;
  tunError: string | null;
  tunBlockedBy: TunBlockedBy;
  tunGatewayPort: number | null;
  tunWatchdog: TunWatchdogStatus;
}

/**
 * A transition, reported exactly once per change.
 *
 * A crash reports no `blockedBy`: nothing was *blocked*, capture was lost, and
 * the caller's payload must not claim a cause it did not diagnose. `recovering`
 * and `recovered` carry the watchdog's own accounting so a caller can log the
 * healing without inventing a number.
 */
export type TunGatewayEvent =
  | { kind: 'requested' }
  | { kind: 'active'; exitIp: string; gatewayPort: number }
  /** Capture up, guarantee missing — not `degraded` (nothing was torn down). */
  | { kind: 'unguarded'; error: string }
  /**
   * Capture LOST, reported the instant it is detected — before the drop is
   * handed on and before the watchdog decides anything. It exists so a caller's
   * status stops claiming capture immediately instead of waiting for the
   * kill-switch handoff to finish; what happens next is `recovering`,
   * `recovered` or `degraded`.
   */
  | { kind: 'dropped'; error: string }
  /** Capture lost, watchdog re-arming. `error` is why it was lost. */
  | { kind: 'recovering'; error: string; attempt: number; maxAttempts: number }
  /** The automatic re-arm restored a verified capture. */
  | { kind: 'recovered'; exitIp: string; gatewayPort: number; attempt: number; afterError: string }
  | { kind: 'degraded'; error: string; blockedBy?: Exclude<TunBlockedBy, null> };

/** How far the watchdog will go to heal a dropped capture. */
export interface TunWatchdogPolicy {
  /** Automatic re-arms allowed per budget. 0 disables the watchdog. */
  maxAutoAttempts: number;
  /** Shorter than a manual start: a user is already living on this capture. */
  rearmReadyTimeoutMs: number;
  /** Hard cap on re-verifying a re-armed device, so the attempt stays bounded. */
  rearmDeadlineMs: number;
  /** A capture that held this long earns a fresh budget (anti-flap). */
  healthyMs: number;
}

export const DEFAULT_TUN_WATCHDOG: TunWatchdogPolicy = {
  maxAutoAttempts: 1,
  rearmReadyTimeoutMs: 8_000,
  rearmDeadlineMs: 10_000,
  healthyMs: 60_000,
};

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
   * drop into a block instead of a silent fallback to direct.
   *
   * Called only after the relay is verified, and its outcome is NOT the
   * caller's to swallow: return `true`/nothing when the hold is armed (or when
   * no hold was needed), and `false` — or a reason string — when a guard was
   * required and is missing. A thrown error counts as the same. The capture
   * stays up either way (traffic really is flowing), but the status must say
   * `unguarded` rather than claim a protection the machine does not have.
   *
   * Re-arming after a drop also CLEARS a block the drop engaged, so the healed
   * capture is guarded again rather than left behind a sink.
   */
  armRouteMode?(): void | boolean | string | Promise<void | boolean | string>;
  /**
   * The device died while capturing; the kill switch decides block vs restore.
   * Return a promise when the work is asynchronous (the watchdog awaits it
   * before healing, so `active` can never be claimed while the block the drop
   * engaged is still being applied).
   */
  onCapturedDrop?(reason: string): void | Promise<void>;
  /** Where every transition is reported (each caller has its own event surface). */
  onState?(event: TunGatewayEvent): void;
  /** Watchdog budget/policy overrides; `null` disables self-healing entirely. */
  watchdog?: Partial<TunWatchdogPolicy> | null;
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
  /**
   * The route-claim sweep that runs before a manual capture starts. Defaults to
   * the real sweep; injected so the pre-flight's rules are provable without an
   * elevated orphan on the test machine.
   */
  sweepRouteClaims?: () => Promise<TunSweepSummary>;
}

/** The only core with a TUN inbound. */
const TUN_CAPABLE_ENGINE = 'sing-box';

const NO_UPSTREAM = 'engine hop has no inbound port to route through';
const NO_CORE =
  'TUN mode needs sing-box (the only core with a TUN inbound) and it is not installed — install it on the sing-box tab, then reconnect in proxy mode.';
const NO_EXIT_IP = 'trace through the TUN gateway did not contain an ip= line';
const STRANDED_ROUTE =
  'a route from a force-killed session is still held by an orphaned TUN gateway that could not be stopped, so TUN will not be started on top of it';

/** How long the device gets to open its inbound before the start is a failure. */
const READY_TIMEOUT_MS = 12_000;

export class TunGatewayHandle {
  private state: TunState = null;
  private error: string | null = null;
  private blockedBy: TunBlockedBy = null;
  private port: number | null = null;
  private device: TunGatewayDevice | null = null;
  /**
   * Capture generation. Every attempt takes it and re-checks it after each
   * await, so a late answer from an attempt the user has since stopped (or
   * replaced) can never write state or resurrect capture.
   */
  private epoch = 0;
  /** Automatic re-arms used in the current budget (reset by a manual start). */
  private autoAttempts = 0;
  /** When the current capture became `active` — how the budget refills. */
  private activeSince: number | null = null;
  private lastRearmError: string | null = null;
  private rearming = false;
  private readonly policy: TunWatchdogPolicy;

  constructor(
    private readonly opts: TunGatewayOptions,
    private readonly runtime: TunGatewayRuntime,
  ) {
    this.policy =
      opts.watchdog === null
        ? { ...DEFAULT_TUN_WATCHDOG, maxAutoAttempts: 0 }
        : { ...DEFAULT_TUN_WATCHDOG, ...(opts.watchdog ?? {}) };
  }

  /** True only while capture is proven (see rule 1). */
  get active(): boolean {
    return this.state === 'active';
  }

  /** Snapshot in the payload shape both callers publish. */
  status(): TunGatewayStatus {
    return {
      tun: this.state,
      tunError: this.error,
      tunBlockedBy: this.blockedBy,
      tunGatewayPort: this.port,
      tunWatchdog: {
        rearming: this.rearming,
        autoAttempts: this.autoAttempts,
        maxAutoAttempts: this.policy.maxAutoAttempts,
        lastError: this.lastRearmError,
      },
    };
  }

  /**
   * Bring the device up in front of the upstream port and prove it relays.
   * Returns true only for a verified capture; every other outcome is a degraded
   * status with the real reason, and the device is never left running.
   *
   * A manual start is also a new watchdog budget: the user asking for the
   * capture is the clearest possible signal that the last drop is history.
   */
  async start(): Promise<boolean> {
    this.autoAttempts = 0;
    this.lastRearmError = null;
    return this.bringUp('manual');
  }

  /**
   * Tear the device down and stop claiming capture. Idempotent, and silent: a
   * device we stop is a deliberate teardown, not the drop in rule 3. The last
   * honest `error`/`blockedBy` are kept so the reason a previous attempt failed
   * stays visible until the next one.
   */
  stop(): void {
    // Cancel in-flight work FIRST (rule 5): a watchdog attempt that started
    // before this call must not re-establish capture the user just turned off.
    this.epoch += 1;
    this.rearming = false;
    const device = this.device;
    // Forget the device BEFORE killing it, so its exit event finds no owner and
    // cannot be reported as an unexpected death.
    this.device = null;
    this.state = null;
    this.port = null;
    this.activeSince = null;
    if (device) {
      try {
        device.cleanup();
      } catch {
        // already dead — cleanup is idempotent by contract
      }
    }
  }

  /* ------------------------------ capture bring-up ----------------------------- */

  private async bringUp(mode: 'manual' | 'rearm', lostReason?: string): Promise<boolean> {
    // One device at a time: a previous run (a reconnect, a retry) is torn down
    // first, deliberately, so its exit is not mistaken for a crash.
    this.stop();
    const epoch = ++this.epoch;
    this.rearming = mode === 'rearm';
    this.state = mode === 'rearm' ? 'recovering' : 'requested';
    this.error = mode === 'rearm' ? (lostReason ?? null) : null;
    this.blockedBy = null;
    this.port = null;
    if (mode === 'rearm') {
      this.opts.onState?.({
        kind: 'recovering',
        error: lostReason ?? 'capture lost',
        attempt: this.autoAttempts,
        maxAttempts: this.policy.maxAutoAttempts,
      });
    } else {
      this.opts.onState?.({ kind: 'requested' });
    }

    // Pre-flight: a default route stranded by a force-killed session must be
    // released — or explained — before a device is put on top of it. This is
    // also the RETRY point: boot is not the only chance to reap an orphan, so
    // the attempt is repeated every time the user asks for TUN, and an elevated
    // session (whose kill cannot be refused) releases the route then. Only a
    // manual start pays for it: a watchdog re-arm rebuilds a capture this same
    // session already owned, and the sweep at boot covered what preceded it.
    if (mode === 'manual') {
      const sweep = await (this.runtime.sweepRouteClaims
        ?? (() => sweepOrphanedTunGateways({ liveOwnerPid: () => process.pid })))();
      if (!this.owns(epoch)) return false;
      if (sweep.refused > 0) {
        const report = tunSweepReport(sweep, tunGatewayRemedy());
        // The consequence belongs to the caller, not to the sweep: at boot the
        // sweep is recovery, here it is a refusal to start on top of it.
        return this.fail(mode, epoch, `TUN was not started — ${report?.message ?? STRANDED_ROUTE}`, 'stranded-route');
      }
    }

    const refusal = tunGatewayStartRefusal();
    if (refusal) return this.fail(mode, epoch, refusal, 'admin');

    const bin = findEngineBinary(TUN_CAPABLE_ENGINE);
    if (!bin) return this.fail(mode, epoch, NO_CORE, 'core');

    const upstreamPort = this.opts.upstreamPort();
    if (upstreamPort == null) return this.fail(mode, epoch, NO_UPSTREAM, 'relay');

    const excludeAddresses = (await this.opts.excludeAddresses?.()) ?? [];
    if (!this.owns(epoch)) return false;

    const started = await (this.runtime.startGateway ?? startTunGateway)(
      bin,
      upstreamPort,
      this.opts.bypass?.() ?? null,
      mode === 'rearm' ? Math.min(this.policy.rearmReadyTimeoutMs, READY_TIMEOUT_MS) : READY_TIMEOUT_MS,
      this.opts.upstream,
      excludeAddresses,
    );
    // A stopped handle must not adopt a device it no longer wants: kill it and
    // report nothing, because the user's stop is the truth that won.
    if (!this.owns(epoch)) {
      if (started.ok) started.run.cleanup();
      return false;
    }
    if (!started.ok) return this.fail(mode, epoch, started.error, 'relay');

    this.device = { child: started.run.child, cleanup: started.run.cleanup };
    this.watch(started.run);

    let exitIp: string | null;
    try {
      // Rule 5's bound: a re-arm gets a hard deadline for re-verification, so a
      // hung probe cannot leave the status in `recovering` forever.
      exitIp =
        mode === 'rearm'
          ? await withDeadline(
              this.runtime.verifyRelay(started.gatewayPort),
              this.policy.rearmDeadlineMs,
              `no relay proof within ${this.policy.rearmDeadlineMs}ms`,
            )
          : await this.runtime.verifyRelay(started.gatewayPort);
      if (!exitIp) throw new Error(NO_EXIT_IP);
    } catch (err) {
      // Rule 2: the device came up but nothing provably traversed it. Kill it
      // before reporting — a live device holds the default route regardless of
      // what the caller's status says.
      if (!this.owns(epoch)) return false;
      this.stop();
      // Reported through `reportFailedAttempt`, not `fail`: `stop()` deliberately
      // bumps the epoch to cancel in-flight work, so an ownership check here
      // would silently swallow the failure.
      return this.reportFailedAttempt(
        mode,
        `a gateway started but the TUN path did not relay: ${reasonOf(err)} — it was stopped, so the system is not left routed into a dead tunnel`,
        'relay',
      );
    }

    if (!this.owns(epoch)) return false;
    this.state = 'active';
    this.port = started.gatewayPort;
    this.activeSince = Date.now();

    // Arming the hold is the LAST thing a verified capture does, and its
    // failure is unskippable: a device that holds the default route with
    // nothing armed to block a drop is a weaker promise than `active` makes.
    // It stays up (unlike a failed relay, nothing is broken) but the status
    // says so instead of a log line.
    let armed: void | boolean | string;
    let armError: string | null = null;
    try {
      armed = await this.opts.armRouteMode?.();
    } catch (err) {
      armed = false;
      armError = reasonOf(err);
    }
    if (!this.owns(epoch)) return false;
    if (armed === false || typeof armed === 'string') {
      this.state = 'unguarded';
      const why = typeof armed === 'string' ? armed : armError;
      this.error =
        `TUN is capturing but the kill-switch hold could not be armed${why ? `: ${why}` : ''}` +
        ' — a drop now falls back to the direct path instead of blocking';
      this.blockedBy = 'kill-switch';
      this.rearming = false;
      this.opts.onState?.({ kind: 'unguarded', error: this.error });
      return true;
    }

    this.rearming = false;
    if (mode === 'rearm') {
      // The recovery is real and verified; `autoAttempts` deliberately stays
      // spent, so a gateway that dies again immediately is not re-armed again.
      this.lastRearmError = null;
      this.error = null;
      this.opts.onState?.({
        kind: 'recovered',
        exitIp,
        gatewayPort: started.gatewayPort,
        attempt: this.autoAttempts,
        afterError: lostReason ?? 'capture lost',
      });
      return true;
    }

    this.lastRearmError = null;
    this.opts.onState?.({ kind: 'active', exitIp, gatewayPort: started.gatewayPort });
    return true;
  }

  /** Rule 3 + rule 5: the device died while we believed it was capturing. */
  private watch(run: { child: TunGatewayDevice['child']; cleanup: () => void }): void {
    run.child.once('close', (code: number | null) => {
      if (this.device?.cleanup !== run.cleanup) return; // stopped or replaced
      void this.handleDeath(run, code);
    });
  }

  private async handleDeath(run: { cleanup: () => void }, code: number | null): Promise<void> {
    // A death invalidates whatever attempt owned the capture: an attempt still
    // awaiting its relay proof must not conclude `active` over a dead device.
    const epoch = ++this.epoch;
    this.rearming = false;
    // How long the capture actually held, read BEFORE the state is cleared: a
    // heal must not be able to see this as a fresh, healthy capture.
    const heldForMs = this.activeSince == null ? null : Date.now() - this.activeSince;
    this.device = null;
    this.state = null;
    this.port = null;
    this.activeSince = null;
    try {
      run.cleanup();
    } catch {
      // already dead
    }
    const reason = `TUN gateway exited unexpectedly (code ${code ?? '?'})`;
    this.error = reason;
    // Reported synchronously: whatever the caller publishes must stop saying
    // `active` the moment the device is gone, not after the handoff below.
    this.opts.onState?.({ kind: 'dropped', error: reason });

    // Fail closed FIRST (rule 5): the kernel withdrew the routes with the
    // process, so until something is armed or restored the machine would fall
    // straight back to the direct path.
    await this.notifyDrop(reason);
    if (!this.owns(epoch)) return; // the user stopped or restarted while we notified

    if (!this.canAutoRearm(heldForMs)) {
      // No budget (or the watchdog is off): the drop stands, exactly as it did
      // before self-healing existed.
      this.opts.onState?.({ kind: 'degraded', error: reason });
      return;
    }

    this.autoAttempts += 1;
    // `bringUp` reports `recovering` with this very reason, and the loss itself
    // was already reported, so a loss is never announced twice.
    await this.bringUp('rearm', reason);
  }

  /**
   * Rule 5: is another automatic re-arm owed, or does this drop stand?
   * `heldForMs` is how long the lost capture had been active (null when it never
   * reached `active`).
   */
  private canAutoRearm(heldForMs: number | null): boolean {
    if (this.policy.maxAutoAttempts <= 0) return false;
    // A capture that held long enough counts as healthy, which refills the
    // budget — so a drop after an hour is healed, while a flapping gateway gets
    // exactly one attempt and then stays down instead of respawning forever.
    if (heldForMs != null && heldForMs >= this.policy.healthyMs) this.autoAttempts = 0;
    return this.autoAttempts < this.policy.maxAutoAttempts;
  }

  /** Tell the caller a capture was lost, bounded so healing is never blocked on it. */
  private async notifyDrop(reason: string): Promise<void> {
    const drop = this.opts.onCapturedDrop?.(reason);
    if (!drop) return;
    await withDeadline(drop, this.policy.rearmDeadlineMs, 'drop handling timed out').catch(() => undefined);
  }

  /** Whether this attempt still owns the capture (nothing replaced/stopped it). */
  private owns(epoch: number): boolean {
    return this.epoch === epoch;
  }

  private degrade(error: string, blockedBy: Exclude<TunBlockedBy, null>): false {
    this.state = null;
    this.port = null;
    this.error = error;
    this.blockedBy = blockedBy;
    this.opts.onState?.({ kind: 'degraded', error, blockedBy });
    return false;
  }

  /**
   * Report a failed attempt in the caller's own terms: a manual start keeps the
   * existing wording, a watchdog attempt says that capture is still down AND
   * that healing was tried, so the status never reads like a fresh request.
   */
  private fail(mode: 'manual' | 'rearm', epoch: number, error: string, blockedBy: Exclude<TunBlockedBy, null>): false {
    // A stale attempt reports nothing: whatever replaced it owns the truth now.
    if (!this.owns(epoch)) return false;
    return this.reportFailedAttempt(mode, error, blockedBy);
  }

  /** Record a failed attempt in the caller's own terms (see `fail`). */
  private reportFailedAttempt(
    mode: 'manual' | 'rearm',
    error: string,
    blockedBy: Exclude<TunBlockedBy, null>,
  ): false {
    this.rearming = false;
    if (mode === 'rearm') {
      // The capture is still down AND healing was already tried: the status must
      // read as that, not as a fresh request.
      this.lastRearmError = error;
      return this.degrade(`TUN capture was lost and the automatic re-arm did not restore it: ${error}`, blockedBy);
    }
    return this.degrade(error, blockedBy);
  }
}

/** Reject when `promise` has not settled inside `ms` — a bound, not a guess. */
function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
