/**
 * Process privileges — ONE owner for "does this process have administrator
 * rights" and for the capability matrix that depends on that answer.
 *
 * Why this exists: the app has three features that Windows will only let an
 * elevated process perform, and before this file each caller decided for itself
 * (and two of them didn't ask at all, then reported a cryptic OS error):
 *
 *   - creating a TUN adapter (wintun) for system-wide routing
 *   - handing a tunnel config to the WireGuard service (per-action elevation)
 *   - raw ICMP probes on builds that restrict them
 *
 * Detection is REAL, never assumed: Windows runs `net session`, which only
 * succeeds from an elevated token; Unix checks uid 0. The result is cached
 * briefly because the check spawns a process, and the cache is reset for tests.
 *
 * The matrix always carries a reason and, where the app can actually fix the
 * situation, a remedy — a refusal the user cannot act on is a dead end, which is
 * the bug this file was written to remove.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type PrivilegeId = 'tun-gateway' | 'wireguard-tunnel-install' | 'raw-icmp';

export interface PrivilegeCapability {
  id: PrivilegeId;
  label: string;
  /** True when the feature cannot work at all without admin rights. */
  requiresAdmin: boolean;
  /** Usable right now, from this process's privilege level. */
  available: boolean;
  /** One honest sentence: why it is or is not available. */
  reason: string;
  /** What the user can do, or null when there is nothing to offer. */
  remedy: string | null;
}

const ELEVATION_CACHE_MS = 60_000;

let elevatedCache: { at: number; elevated: boolean } | null = null;

/**
 * Is the process that runs the cores elevated?
 *
 * Windows: `net session` requires an elevated token; a non-zero exit means we
 * are not elevated (spawn failure also means "not elevated" — fail closed, so a
 * broken probe can never be mistaken for a privilege we do not have).
 * Unix: uid 0. Other platforms: false.
 */
export function isProcessElevated(): boolean {
  const now = Date.now();
  if (elevatedCache && now - elevatedCache.at < ELEVATION_CACHE_MS) return elevatedCache.elevated;
  const elevated = detectElevated();
  elevatedCache = { at: now, elevated };
  return elevated;
}

function detectElevated(): boolean {
  if (process.platform === 'win32') {
    try {
      execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }
  if (process.platform === 'linux' || process.platform === 'darwin') {
    return typeof process.getuid === 'function' && process.getuid() === 0;
  }
  return false;
}

/** Force the next check to re-probe (after an elevated relaunch, or in tests). */
export function invalidatePrivilegeCache(): void {
  elevatedCache = null;
}

/**
 * Can the desktop shell relaunch itself with administrator rights?
 *
 * Only when a Tauri shell spawned this sidecar (`NETPULSE_DESKTOP=1`) on
 * Windows — the browser-only dev/API mode has no process to elevate, and saying
 * otherwise would offer the user a button that cannot work.
 */
export function canRelaunchElevated(): boolean {
  return process.platform === 'win32' && process.env['NETPULSE_DESKTOP'] === '1' && !isProcessElevated();
}

/**
 * The WireGuard executables the per-action elevation broker is allowed to
 * launch. Kept here so ONE list decides both "is WireGuard installed" and
 * "may Rust elevate into it" — they must never disagree.
 */
export const WIREGUARD_EXES = [
  path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'WireGuard', 'wireguard.exe'),
  path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'WireGuard', 'wireguard.exe'),
];

/** Filesystem-only wireguard install check — no process is spawned. */
export function wireguardInstalled(): boolean {
  return WIREGUARD_EXES.some((p) => fs.existsSync(p));
}

/**
 * Static capability notes that do not depend on privilege level. Both default
 * to a real filesystem check, so callers do not have to gather them (and cannot
 * accidentally pass a stale network probe instead).
 */
export interface AdminContext {
  /** Whether an installed sing-box binary can act as the TUN gateway. */
  tunGatewayCoreInstalled: boolean;
  /** Whether WireGuard's CLI exists for the per-action elevation path. */
  wireguardInstalled: boolean;
}

/**
 * The honest privilege matrix. Every entry states why it is unavailable and, if
 * the app can fix it, what to do — the UI renders these verbatim, so no surface
 * has to invent its own wording.
 */
export function adminCapabilities(ctx: Partial<AdminContext> = {}): PrivilegeCapability[] {
  const elevated = isProcessElevated();
  const relaunchable = canRelaunchElevated();
  // Both default to a real filesystem check — a caller that does not know the
  // answer must not be able to pass "unknown" and get a claim instead.
  const tunCore = ctx.tunGatewayCoreInstalled ?? false;
  const wgInstalled = ctx.wireguardInstalled ?? wireguardInstalled();

  return [
    {
      id: 'tun-gateway',
      label: 'System-wide routing (TUN)',
      requiresAdmin: true,
      available: elevated && tunCore,
      reason: elevated
        ? tunCore
          ? 'Administrator rights present — the app can create a TUN adapter and claim the default route.'
          : 'Administrator rights present, but no sing-box binary is installed to act as the TUN gateway.'
        : 'Windows only lets an administrator create a TUN adapter (wintun), so system-wide routing falls back to system-proxy mode.',
      remedy: elevated
        ? tunCore
          ? null
          : 'Install sing-box on the sing-box tab — it is the only core with a TUN inbound.'
        : relaunchable
          ? 'Restart the app with administrator rights.'
          : 'Start the app with administrator rights (the dev API alone cannot raise a UAC prompt).',
    },
    {
      id: 'wireguard-tunnel-install',
      label: 'WireGuard tunnel service',
      requiresAdmin: true,
      available: wgInstalled,
      reason: wgInstalled
        ? 'The app asks for elevation per connect — one UAC prompt when it hands the config to the WireGuard service.'
        : 'WireGuard is not installed, so its tunnel service cannot be used even with administrator rights.',
      remedy: wgInstalled ? null : 'Install WireGuard, then import a .conf profile.',
    },
    {
      id: 'raw-icmp',
      label: 'Raw ICMP probes',
      requiresAdmin: false,
      available: true,
      reason:
        process.platform === 'win32' && !elevated
          ? 'ICMP runs through the ping.exe helper, which works without administrator rights; raw-socket mode would need them.'
          : 'ICMP probes run at this privilege level.',
      remedy: null,
    },
  ];
}

/**
 * What to DO about TUN's privilege requirement — the remedy the matrix above
 * owns, for callers that must state it without rendering the whole capability
 * list (a refused TUN start, a route that cannot be released without admin
 * rights). Null when the privilege is not what is missing: a remedy about
 * installing sing-box would be the wrong advice for a route that is already
 * being held.
 */
export function tunGatewayRemedy(): string | null {
  if (isProcessElevated()) return null;
  return adminCapabilities().find((c) => c.id === 'tun-gateway')?.remedy ?? null;
}

/** Shape the API returns; kept next to the matrix so both stay in step. */
export function adminStatus(ctx: Partial<AdminContext> = {}) {
  const elevated = isProcessElevated();
  return {
    elevated,
    platform: process.platform,
    /** True only when a one-click elevated relaunch is genuinely possible. */
    canRelaunchElevated: canRelaunchElevated(),
    /** True when an elevated relaunch would even change anything. */
    elevatedWouldUnlock: !elevated && process.platform === 'win32',
    privileges: adminCapabilities(ctx),
    note: elevated
      ? 'This process runs with administrator rights.'
      : 'This process does not have administrator rights. Features that need them say so individually below.',
  };
}
