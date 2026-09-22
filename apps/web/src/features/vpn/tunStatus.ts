/**
 * What TUN mode may CLAIM — one owner for both surfaces (the tunnel card and
 * the Aether surface), so the wording cannot drift and neither can promise a
 * protection the machine does not have.
 *
 * The rule this encodes, and why it needs a module: a verified capture whose
 * kill-switch hold could not be armed is NOT `active`. Traffic really is
 * flowing through the device, so calling it a failure would be a lie in the
 * other direction — but a drop would silently fall back to the direct path, so
 * it must not read as protected either. It is its own state (`unguarded`), and
 * its tone is the alarm tone, never the success one.
 */
export type TunTone = 'ok' | 'warn' | 'danger';

export type TunState = 'requested' | 'recovering' | 'active' | 'unguarded' | null;
export type TunBlockedBy = 'admin' | 'core' | 'relay' | 'kill-switch' | 'stranded-route' | null;

/** Automatic-recovery accounting, as the status carriers publish it. */
export interface TunWatchdogSlice {
  rearming: boolean;
  autoAttempts: number;
  maxAutoAttempts: number;
  lastError: string | null;
}

/** The one colour mapping both surfaces use, so a tone cannot read differently. */
export const TUN_TONE_CLASS: Record<TunTone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
};

/**
 * The TUN slice of a status payload, shaped to accept BOTH carriers (the
 * tunnel status and the provider status) — every field optional because the
 * provider payload only fills them once TUN has been requested.
 */
export interface TunStatusSlice {
  tun?: TunState;
  tunError?: string | null;
  tunBlockedBy?: TunBlockedBy;
  tunWatchdog?: TunWatchdogSlice | null;
}

/** The kill-switch slice the capture line reads. */
export interface KillSwitchSlice {
  /** the user's preference — NOT a claim that anything is armed */
  enabled: boolean;
  /** a hold is actually claimed */
  armed: boolean;
  /** traffic is fail-closed right now */
  blocking: boolean;
}

export interface TunClaim {
  /** never `ok` unless the capture is verified AND guarded */
  tone: TunTone;
  /** terse text for the status strip */
  label: string;
  /** full sentence for the engine surface */
  sentence: string;
}

/**
 * What the TUN state may say about itself, or null when nothing is capturing
 * and nothing was requested (the caller renders no TUN line at all).
 */
export function tunClaim(status: TunStatusSlice): TunClaim | null {
  switch (status.tun) {
    case 'active':
      return {
        tone: 'ok',
        label: 'active — all system traffic captured',
        sentence:
          'Verified: the TUN device, the route claim and the relay all prove out (checked with a real trace through the gateway), and the kill switch holds the drop.',
      };
    case 'unguarded':
      return {
        tone: 'danger',
        label: 'CAPTURING — kill switch not armed',
        sentence:
          'Capturing, but NOT protected: system traffic does ride the tunnel, yet the kill-switch hold could not be armed, so a drop would fall back to the direct path. The reason is below.',
      };
    case 'recovering':
      return {
        tone: 'danger',
        label: 'LOST — re-establishing the capture',
        sentence:
          'The capture was lost. The drop was handed to the kill switch first, and one automatic re-arm is now rebuilding the tunnel — nothing is captured until it proves out again.',
      };
    case 'requested':
      return {
        tone: 'warn',
        label: 'requested (not yet verified)',
        sentence: 'Requested, not verified — traffic is still per-app until the full path proves out.',
      };
    default:
      return null;
  }
}

/**
 * What to DO about a refused or failed TUN request. A code, not a sentence, so
 * the two surfaces can give the same remedy; null when nothing was diagnosed
 * (a lost capture has no cause to name).
 */
export function tunRemedy(blockedBy: TunBlockedBy | undefined): string | null {
  switch (blockedBy) {
    case 'core':
      return 'Install sing-box on the sing-box tab — it is the only core with a TUN inbound.';
    case 'admin':
      return 'Grant administrator rights, then restart the tunnel with TUN enabled.';
    case 'stranded-route':
      // The action only. What the sweep established (and how sure it is about
      // the route) is in the error text above, straight from the one owner that
      // computed it — this line must not restate it as a stronger claim.
      return 'Use "Grant admin rights" (below), then enable TUN again — releasing a route stranded by a force-killed session needs administrator rights.';
    case 'relay':
      return 'The gateway process did not relay traffic — the tunnel is still carrying your traffic in system-proxy mode.';
    case 'kill-switch':
      return 'The capture itself is up and carrying traffic; only the hold that blocks a drop is missing. Fix the cause above, or turn the kill switch off in Settings → VPN and accept that a drop falls back to the direct path.';
    default:
      return null;
  }
}

export interface KillSwitchClaim {
  tone: TunTone;
  text: string;
}

/**
 * What to say about the watchdog's work, or null when it has done nothing.
 *
 * This exists because the state itself moves on: a healed capture reads
 * `active`, and without this line nothing would tell the user the app had to
 * rebuild the tunnel — or that it tried once and could not.
 */
export function watchdogClaim(
  watchdog: TunWatchdogSlice | null | undefined,
  tun: TunState | undefined,
): KillSwitchClaim | null {
  if (!watchdog) return null;
  if (watchdog.rearming) {
    return {
      tone: 'warn',
      text: `Automatic re-arm ${watchdog.autoAttempts} of ${watchdog.maxAutoAttempts} in progress — the capture is down until it proves out again`,
    };
  }
  if (watchdog.lastError) {
    return {
      tone: 'danger',
      text: `Automatic re-arm ${watchdog.autoAttempts} of ${watchdog.maxAutoAttempts} did not restore the capture: ${watchdog.lastError}`,
    };
  }
  if (watchdog.autoAttempts <= 0) return null;
  return {
    // The claim describes the WATCHDOG, and stays humble about the rest: it was
    // rebuilt once, which is not the same as protected.
    tone: tun === 'active' || tun === 'unguarded' ? 'ok' : 'warn',
    text: `Recovered automatically — the capture was rebuilt by re-arm ${watchdog.autoAttempts} of ${watchdog.maxAutoAttempts}`,
  };
}

/**
 * The kill-switch line under a live capture. `armed` is the claim, never
 * `enabled`: the preference being on while no hold exists is exactly the state
 * `unguarded` describes, and it must read as a hole rather than as protection.
 */
export function killSwitchClaim(ks: KillSwitchSlice | null | undefined): KillSwitchClaim | null {
  if (!ks) return null;
  if (ks.blocking) {
    return {
      tone: 'danger',
      text: 'ENGAGED — TUN dropped; non-bypassed traffic is fail-closed (system-proxy sink), not falling back to direct',
    };
  }
  if (ks.armed) {
    return {
      tone: 'ok',
      text: 'armed in route mode — a TUN drop blocks non-bypassed traffic instead of falling back to direct',
    };
  }
  if (ks.enabled) {
    return {
      tone: 'danger',
      text: 'ENABLED BUT NOT ARMED — this capture has no fail-closed hold, so a TUN drop would fall back to the direct path',
    };
  }
  return { tone: 'warn', text: 'OFF — a TUN drop falls back to the direct path' };
}
