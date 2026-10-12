/**
 * AppTransport — the UI's single seam to the backend.
 *
 * Two implementations:
 *   - DesktopTransport: Tauri desktop. The Rust core hands us the loopback
 *     sidecar URL + ephemeral token via the typed `bootstrap` IPC command;
 *     every HTTP/WS request is authenticated with `Bearer <token>`.
 *   - WebTransport: web mode against the same-origin deployment
 *     (cookie session auth, unchanged behavior).
 *
 * Components never touch fetch/WebSocket/`window.__TAURI__` directly — they
 * import `transport` from here. `src/lib/api.ts` and `src/lib/ws.ts` are thin
 * wrappers over this module.
 *
 * The transport is chosen once at startup (see `initTransport`) and memoized.
 * If Tauri IPC is present but the sidecar is unreachable (backend crashed),
 * requests fail with a typed error — the Rust watchdog restarts the backend.
 */

export interface AppTransport {
  readonly mode: 'desktop' | 'web';
  readonly apiBase: string;
  readonly wsBase: string;
  /** Headers appended to every request (desktop: Bearer token). */
  authHeaders(): Record<string, string>;
}

interface TauriBootstrap {
  api_base: string;
  ws_base: string;
  token: string;
  desktop: boolean;
  app_version: string;
  os: string;
  arch: string;
}

interface TauriGlobals {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
}

function resolveInvokeFn(): TauriGlobals['invoke'] | null {
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: TauriGlobals['invoke'] };
    __TAURI__?: { invoke?: TauriGlobals['invoke']; core?: { invoke?: TauriGlobals['invoke'] } };
  };
  // Tauri v2's global bundle (withGlobalTauri) exposes `invoke` under
  // `__TAURI__.core.invoke` — NOT at the top level. `__TAURI_INTERNALS__.invoke`
  // exists in both v1/v2. Checking only the top level silently returns null in
  // every packaged build, which made the desktop app fall back to same-origin
  // web mode and report "Backend unreachable" forever.
  return w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.core?.invoke ?? w.__TAURI__?.invoke ?? null;
}

function tauriGlobals(): TauriGlobals | null {
  const invoke = resolveInvokeFn();
  return invoke ? { invoke } : null;
}

/**
 * Typed Tauri IPC invoke for app modules. Returns null when IPC is
 * unavailable (web mode), so callers can branch cleanly instead of probing
 * window globals themselves.
 */
export function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> | null {
  const invoke = resolveInvokeFn();
  if (!invoke) return null;
  return invoke<T>(cmd, args);
}

/**
 * True when Tauri IPC is reachable (the packaged desktop
 * app), without issuing a command — lets modules branch on
 * the runtime instead of probing window globals themselves.
 */
export function hasTauriIpc(): boolean {
  return resolveInvokeFn() !== null;
}

let current: AppTransport | null = null;
let initPromise: Promise<AppTransport> | null = null;
let sidecarListenerAttached = false;

type TransportResetListener = () => void;
const resetListeners = new Set<TransportResetListener>();

/**
 * Drop the memoized transport so the next request re-bootstraps. Called when
 * the Rust core reports a sidecar restart (which may carry a NEW ephemeral
 * port/token) — without this, the UI would poll a dead endpoint forever
 * while the watchdog reports healthy.
 */
export function resetTransport(): void {
  current = null;
  initPromise = null;
  for (const cb of resetListeners) {
    try { cb(); } catch { /* listener errors must not break the reset */ }
  }
}

/** Subscribe to transport resets (the startup-health hook refreshes on them). */
export function onTransportReset(cb: TransportResetListener): () => void {
  resetListeners.add(cb);
  return () => resetListeners.delete(cb);
}

/** Listen once for the Rust `sidecar-restarted` event (Tauri global API). */
function attachSidecarRestartListener(): void {
  if (sidecarListenerAttached) return;
  sidecarListenerAttached = true;
  const w = window as unknown as {
    __TAURI__?: { event?: { listen?: (event: string, cb: (ev: unknown) => void) => Promise<unknown> } };
  };
  const listen = w.__TAURI__?.event?.listen;
  if (!listen) return;
  void listen('sidecar-restarted', () => resetTransport());
}

async function initDesktopTransport(): Promise<AppTransport> {
  const t = tauriGlobals();
  if (!t) throw new Error('desktop transport requested but Tauri IPC is unavailable');
  const b = await t.invoke<TauriBootstrap>('bootstrap');
  attachSidecarRestartListener();
  return {
    mode: 'desktop',
    apiBase: b.api_base,
    wsBase: b.ws_base,
    authHeaders: () => ({ authorization: `Bearer ${b.token}` }),
  };
}

function webTransport(): AppTransport {
  return {
    mode: 'web',
    apiBase: '/api/v1',
    wsBase: `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`,
    authHeaders: () => ({}),
  };
}

/** Choose + memoize the transport. Safe to call repeatedly. */
export async function initTransport(): Promise<AppTransport> {
  if (current) return current;
  if (!initPromise) {
    initPromise = (tauriGlobals() ? initDesktopTransport() : Promise.resolve(webTransport()))
      .then((t) => {
        current = t;
        return t;
      })
      .catch((err) => {
        initPromise = null;
        throw err;
      });
  }
  return initPromise;
}

/** Synchronous accessor for after `initTransport()` resolved (e.g. inside hooks). */
export function transport(): AppTransport {
  if (!current) {
    // Graceful fallback for early renders before init resolves; api.ts awaits
    // initTransport() anyway, so this only triggers on misuse.
    return webTransport();
  }
  return current;
}

export function isDesktop(): boolean {
  return current?.mode === 'desktop';
}

/** Desktop runtime info for the About screen (null in web mode). */
export interface DesktopInfo {
  appVersion: string;
  os: string;
  arch: string;
}

export async function desktopInfo(): Promise<DesktopInfo | null> {
  if (!isDesktop()) return null;
  const t = tauriGlobals();
  if (!t) return null;
  const b = await t.invoke<TauriBootstrap>('bootstrap');
  return { appVersion: b.app_version, os: b.os, arch: b.arch };
}
