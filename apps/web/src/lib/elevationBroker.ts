import { isDesktop, tauriInvoke } from '@/lib/transport';

/**
 * Frontend arm of the per-action elevation broker.
 *
 * Flow (desktop only): mint an opId AND nonce here → hand both to POST
 * /vpn/connect as `elevation.{opId,nonce}` → the backend stages the op bound
 * to that nonce and long-polls → WE invoke the Rust `vpn_elevation_bridge`
 * command with the same pair → Rust fetches the pending descriptor with both
 * values, validates, shows ONE UAC prompt, launches the allowed wireguard.exe
 * and reports back → the backend verifies the interface and the connect
 * request resolves.
 *
 * In web mode (no IPC) we simply omit the elevation field: the plain
 * unprivileged connect runs and surfaces the OS's own 403, exactly as before.
 */
export interface ElevationArm {
  opId: string;
  /** Capability the Rust bridge must echo to the sidecar's /pending route. */
  nonce: string;
  /** Call after the connect request is in flight (backend has the op staged). */
  run(): Promise<ElevationOutcome>;
}

export interface ElevationOutcome {
  launched: boolean;
  declined: boolean;
  error: string | null;
}

/** The Rust command's result shape (src-tauri/src/elevation.rs). */
interface BridgeOutcome {
  launched: boolean;
  declined: boolean;
  error: string | null;
}

export function newElevationOpId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 24 random bytes as 48 hex chars — inside the sidecar's 16-128 alphanumeric contract. */
export function newElevationNonce(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Arm the bridge for one connect. Returns null in web mode — callers should
 * proceed with a plain (unelevated) connect.
 */
export function armElevationBridge(): ElevationArm | null {
  if (!isDesktop()) return null;
  const invoke = tauriInvoke<BridgeOutcome>;
  if (!invoke) return null;
  const opId = newElevationOpId();
  const nonce = newElevationNonce();
  return {
    opId,
    nonce,
    run: async () => {
      try {
        const outcome = await invoke('vpn_elevation_bridge', { opId, nonce });
        return {
          launched: outcome?.launched ?? false,
          declined: outcome?.declined ?? false,
          error: outcome?.error ?? null,
        };
      } catch (err) {
        return { launched: false, declined: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
