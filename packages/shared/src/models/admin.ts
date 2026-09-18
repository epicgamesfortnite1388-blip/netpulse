/**
 * Administrator rights — the shape the API and the desktop shell agree on.
 *
 * Two sources of truth, one vocabulary:
 *   - the sidecar reports what IT can do at its privilege level (it runs the
 *     cores, so its answer is the one that decides whether TUN or a WireGuard
 *     service install can work);
 *   - the Tauri shell reports whether the APP process is elevated and whether a
 *     one-click elevated relaunch is possible.
 *
 * Both are real OS checks. Neither is inferred from a setting, so the UI can
 * present them as facts and attribute them to the layer that observed them.
 */

/** `tun-gateway` / `wireguard-tunnel-install` / `raw-icmp` in the API. */
export type PrivilegeId = 'tun-gateway' | 'wireguard-tunnel-install' | 'raw-icmp';

export interface PrivilegeCapability {
  id: PrivilegeId;
  label: string;
  /** True when the feature cannot work at all without administrator rights. */
  requiresAdmin: boolean;
  available: boolean;
  /** Why it is or is not available — shown verbatim, never re-worded by the UI. */
  reason: string;
  /** What the user can do about it, or null when there is nothing to offer. */
  remedy: string | null;
}

export interface AdminStatus {
  elevated: boolean;
  platform: string;
  /** True only when a one-click elevated relaunch is genuinely possible. */
  canRelaunchElevated: boolean;
  /** True when an elevated relaunch would change anything at all. */
  elevatedWouldUnlock: boolean;
  privileges: PrivilegeCapability[];
  note: string;
}

/** What the Tauri shell knows about its OWN process (typed IPC, desktop only). */
export interface DesktopAdminRights {
  elevated: boolean;
  platform: string;
  can_relaunch: boolean;
}
