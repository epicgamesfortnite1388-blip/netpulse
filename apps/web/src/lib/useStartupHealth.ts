import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/lib/api';
import { phaseForFailedProbe } from '@/lib/startupPhase';
import { resetTransport } from '@/lib/transport';

/**
 * Startup / runtime health state machine.
 *
 *   Starting         — app booted, backend not yet answered
 *   Checking         — backend answered, health probe running
 *   Ready            — all checks ok
 *   Degraded         — something is off (offline, no VPN engine, Safe Mode)
 *                     but the app is usable; failed components + actions shown
 *   Recovery Required — backend unreachable (sidecar dead) or a hard failure
 */
export type StartupPhase = 'starting' | 'checking' | 'ready' | 'degraded' | 'recovery';

export interface HealthCheck {
  id: string;
  label: string;
  state: 'ok' | 'degraded' | 'failed';
  detail: string;
  action?: { kind: string; label: string };
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  safeMode: boolean;
  checks: HealthCheck[];
  generatedAt: number;
  tookMs: number;
  version: string;
}

export interface RuntimeStatus {
  sidecar_running: boolean;
  sidecar_restarts: number;
  /** Loopback port the sidecar listens on (null = not running). */
  sidecar_port: number | null;
  /** Why the sidecar last restarted (decoded exit code + stderr tail). */
  last_restart_reason: string | null;
  /** Unix seconds of the last sidecar restart. */
  last_restart_at_unix: number | null;
  safe_mode: boolean;
  window_visible: boolean;
  data_dir: string;
  log_dir: string;
  log_file_bytes: number;
  log_rotation_cap_bytes: number;
}

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** Fast retry cadence while starting/recovering (also the banner countdown). */
const RETRY_INTERVAL_MS = 3_000;


function invokeFn(): InvokeFn | null {
  const w = window as unknown as { __TAURI__?: { invoke?: InvokeFn } };
  return w.__TAURI__?.invoke ?? null;
}

/**
 * Polls the backend health endpoint (every 30 s) and the Rust runtime status
 * (every 10 s). `phase` drives the startup banner; `report`/`runtime` drive
 * the System Health page.
 */
export function useStartupHealth(): {
  phase: StartupPhase;
  report: HealthReport | null;
  runtime: RuntimeStatus | null;
  error: string | null;
  refresh: () => void;
  /** Failed health attempts since the last success (0 when healthy). */
  retryAttempt: number;
  /** Seconds until the next automatic retry; null when not reconnecting. */
  secondsUntilRetry: number | null;
} {
  const [phase, setPhase] = useState<StartupPhase>('starting');
  const [report, setReport] = useState<HealthReport | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Completed failed health attempts since the last success. */
  const [retryAttempt, setRetryAttempt] = useState(0);
  /** Wall-clock time of the next scheduled retry (null = not reconnecting). */
  const [nextRetryAt, setNextRetryAt] = useState<number | null>(null);
  /** 1s-ticked countdown to the next retry, for the reconnecting banner. */
  const [secondsUntilRetry, setSecondsUntilRetry] = useState<number | null>(null);
  const timers = useRef<ReturnType<typeof setInterval>[]>([]);
  /** When this UI session started — the anchor for the startup grace window. */
  const bootAt = useRef(Date.now());

  const refresh = useCallback(() => {
    void (async () => {
      setPhase((p) => (p === 'starting' ? 'checking' : p));
      try {
        const r = await api.get<HealthReport>('/meta/health');
        // Shape guard: a malformed/legacy/error-shaped 200 must never be
        // interpreted as a healthy report (this is what produced a
        // "0 components degraded" banner with an empty check list).
        const checks = Array.isArray(r?.checks) ? r.checks : null;
        if (!r || (r.status !== 'ok' && r.status !== 'degraded') || checks === null) {
          throw new Error('Malformed health report from backend');
        }
        const bad = checks.filter((c) => c && c.state !== 'ok');
        setReport(r);
        setError(null);
        // Back to healthy: clear the reconnecting state entirely.
        setRetryAttempt(0);
        setNextRetryAt(null);
        setSecondsUntilRetry(null);
        // The check list is the source of truth for the banner; `status` only
        // breaks ties so UI text and the listed components can never diverge.
        setPhase(bad.length > 0 || r.status === 'degraded' ? 'degraded' : 'ready');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setRetryAttempt((a) => a + 1);
        setNextRetryAt(Date.now() + RETRY_INTERVAL_MS);
        setSecondsUntilRetry(RETRY_INTERVAL_MS / 1000);
        // Still inside the startup window: the backend is booting, so the
        // honest phase is "starting", not "unreachable".
        setPhase(phaseForFailedProbe(Date.now() - bootAt.current));
      }
    })();
  }, []);

  useEffect(() => {
    const invoke = invokeFn();
    const pollRuntime = () => {
      if (!invoke) return;
      void invoke('runtime_status')
        .then((s) => setRuntime(s as RuntimeStatus))
        .catch(() => undefined);
    };
    pollRuntime();
    const t1 = setInterval(pollRuntime, 10_000);
    timers.current.push(t1);
    return () => {
      timers.current.forEach(clearInterval);
      timers.current = [];
    };
  }, []);

  // First probe of this session. `api.get` awaits the transport, and in the
  // desktop shell that call resolves only once the sidecar answers, so this
  // request is not racing backend start-up.
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Polling cadence — fast while starting/recovering so the state clears as
  // soon as the backend answers (or the watchdog respawns the sidecar), then
  // relaxed once healthy. Keyed on the phase only to switch cadence: firing an
  // extra probe here would double-count every attempt in the banner.
  useEffect(() => {
    const interval = phase === 'starting' || phase === 'recovery' || phase === 'checking'
      ? RETRY_INTERVAL_MS
      : 30_000;
    const t = setInterval(refresh, interval);
    return () => clearInterval(t);
  }, [refresh, phase]);

  // Re-fetch the Rust runtime status so the port/last-restart rows on the
  // System Health page update immediately after a sidecar respawn (the 10s
  // poll would eventually catch it, but the event makes it instant).
  useEffect(() => {
    const invoke = invokeFn();
    if (!invoke) return;
    void invoke('runtime_status')
      .then((s) => setRuntime(s as RuntimeStatus))
      .catch(() => undefined);
  }, [phase, retryAttempt]);

  // 1s countdown ticker while a retry is pending — drives the banner's
  // "reconnecting in Ns" label between actual health probes.
  useEffect(() => {
    if (nextRetryAt === null) return;
    const tick = () => {
      setSecondsUntilRetry(Math.max(0, Math.ceil((nextRetryAt - Date.now()) / 1000)));
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [nextRetryAt]);

  // The Rust core emits `sidecar-restarted` on every successful spawn. Reset
  // the transport here too (not only inside the transport layer) because the
  // transport-level listener only exists after a FIRST successful bootstrap —
  // when the sidecar was down at app start, this is the listener that heals.
  useEffect(() => {
    const w = window as unknown as {
      __TAURI__?: { event?: { listen?: (event: string, cb: (ev: unknown) => void) => Promise<unknown> } };
    };
    const listen = w.__TAURI__?.event?.listen;
    if (!listen) return;
    let unlisten: (() => void) | null = null;
    void listen('sidecar-restarted', () => {
      resetTransport();
      refresh();
      // Refresh the runtime status (port, restarts, last restart reason) so
      // the System Health page reflects the respawn immediately.
      const invoke = invokeFn();
      if (invoke) {
        void invoke('runtime_status')
          .then((s) => setRuntime(s as RuntimeStatus))
          .catch(() => undefined);
      }
    }).then((fn) => {
      unlisten = fn as (() => void) | null;
    });
    return () => { unlisten?.(); };
  }, [refresh]);

  return { phase, report, runtime, error, refresh, retryAttempt, secondsUntilRetry };
}
