import fs from 'node:fs';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';

import pkg from '../../package.json';

import { proxyEngineStatus } from '../services/proxyEngineRunner';

import type { AppContext } from './context';

export type HealthState = 'ok' | 'degraded' | 'failed';

export interface HealthCheck {
  id: string;
  label: string;
  state: HealthState;
  detail: string;
  /** Safe recovery action surfaced in the UI when state !== 'ok'. */
  action?: { kind: 'repair-restart-backend' | 'repair-reset-state' | 'open-logs' | 'safe-mode'; label: string };
}

/** Timeouts so a wedged probe can never hang the health endpoint itself. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref()),
  ]);
}

/** Write probe: create/delete a temp file in the data dir (permissions + AV locks). */
function probeFilesystem(dataDir: string): { state: HealthState; detail: string } {
  const probe = path.join(dataDir, `.write-probe-${process.pid}`);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(probe, 'netpulse fs probe');
    fs.rmSync(probe, { force: true });
    return { state: 'ok', detail: `Data directory is writable (${dataDir})` };
  } catch (err) {
    return {
      state: 'failed',
      detail: `Data directory not writable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Network reachability: single TCP connect to a public resolver, 2s budget. */
async function probeNetwork(controller: AppContext['controller']): Promise<{ state: HealthState; detail: string }> {
  try {
    const res = await withTimeout(controller.tcpProbe('1.1.1.1', 53, 2_000, 4), 3_000);
    if (res.ok) return { state: 'ok', detail: `Internet reachable (TCP 1.1.1.1:53 in ${res.ms ?? '?'} ms)` };
    return { state: 'degraded', detail: 'No TCP connection to 1.1.1.1:53 — offline or firewalled. Tests that need internet will fail.' };
  } catch (err) {
    return { state: 'degraded', detail: `Network probe failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/meta/health', async () => {
    const started = Date.now();
    const safeMode = ctx.config.safeMode === true;

    // 1. Database: cheapest possible round-trip on the live handle.
    let db: HealthCheck;
    try {
      const row = ctx.db.db.get('SELECT 1 AS ok');
      const ok = (row as { ok?: number } | undefined)?.ok === 1;
      db = ok
        ? { id: 'database', label: 'Database', state: 'ok', detail: 'SQLite responding (SELECT 1 ok)' }
        : { id: 'database', label: 'Database', state: 'failed', detail: 'SQLite returned an unexpected result', action: { kind: 'repair-reset-state', label: 'Reset App State (with backup)' } };
    } catch (err) {
      db = {
        id: 'database', label: 'Database', state: 'failed',
        detail: `SQLite error: ${err instanceof Error ? err.message : String(err)}`,
        action: { kind: 'repair-reset-state', label: 'Reset App State (with backup)' },
      };
    }

    // 2. Filesystem permissions (write probe in the data dir).
    const fsProbe = probeFilesystem(ctx.config.dataDir);
    const filesystem: HealthCheck = {
      id: 'filesystem',
      label: 'Filesystem',
      ...fsProbe,
      ...(fsProbe.state !== 'ok' ? { action: { kind: 'open-logs' as const, label: 'Open logs folder' } } : {}),
    };

    // 3. VPN engines — two classes, named separately (degraded, not failed:
    //    the app works without them). Reporting only the first class described
    //    a machine with xray/sing-box/v2ray installed as having no engines:
    //      a) system providers (WireGuard / OpenVPN / sing-box on PATH) that the
    //         VPN page's tunnel providers spawn,
    //      b) the app-managed proxy cores in the data dir (xray / sing-box /
    //         v2ray) that node tests and the local proxy tunnel actually run.
    //    Detection only — no binary is executed here.
    let vpnBinaries: Record<string, boolean> = {};
    try {
      vpnBinaries = safeMode ? { wireguard: false, openvpn: false, singbox: false } : await withTimeout(ctx.controller.detectVpnBinaries(), 3_000);
    } catch { /* reported as degraded below */ }
    const providers = Object.entries(vpnBinaries).filter(([, v]) => v).map(([k]) => k);
    // Same owner the engine strip on Node Explorer uses, so this check and
    // /nodes/engines can never disagree about which cores are installed.
    const cores = safeMode
      ? []
      : proxyEngineStatus(ctx.services.settings.get().proxyEngine?.preferred ?? 'auto')
          .engines.filter((e) => e.available)
          .map((e) => e.id);
    const vpn: HealthCheck = {
      id: 'vpn-engines',
      label: 'VPN engines',
      state: safeMode ? 'degraded' : providers.length + cores.length > 0 ? 'ok' : 'degraded',
      detail: safeMode
        ? 'Safe Mode: engine detection disabled.'
        : [
            providers.length > 0
              ? `System providers: ${providers.join(', ')}`
              : 'No system VPN provider (WireGuard/OpenVPN)',
            cores.length > 0
              ? `Proxy cores: ${cores.join(', ')}`
              : 'No app-managed proxy core — node tests that need a proxied request report unavailable',
          ].join(' · '),
    };

    // 4. Network (skipped in Safe Mode — null controller refuses).
    const netProbe = safeMode ? null : await probeNetwork(ctx.controller);
    const network: HealthCheck = {
      id: 'network',
      label: 'Network',
      ...(netProbe ?? { state: 'degraded' as HealthState, detail: 'Safe Mode: network probes disabled.' }),
    };

    // 5. Bundled sidecar assets next to the running executable.
    const backendAssets: HealthCheck = ((): HealthCheck => {
      try {
        const exeDir = path.dirname(process.execPath);
        const script = path.join(exeDir, 'backend', 'netpulse-backend.js');
        // In the packaged sidecar, process.execPath IS backend/node.exe, so
        // also accept the layout where node.exe lives inside backend/.
        const scriptAlt = path.join(exeDir, 'netpulse-backend.js');
        const found = fs.existsSync(script) || fs.existsSync(scriptAlt);
        if (found) return { id: 'backend-assets', label: 'Bundled backend assets', state: 'ok', detail: 'Sidecar script and node_modules found next to the executable.' };
        // Dev/source runs (node apps/api/...): report honestly instead of failing.
        if (!process.env.NETPULSE_DESKTOP) {
          return { id: 'backend-assets', label: 'Bundled backend assets', state: 'ok', detail: 'Source run — bundled assets not applicable.' };
        }
        return {
          id: 'backend-assets', label: 'Bundled backend assets', state: 'failed',
          detail: `backend/ assets missing next to ${exeDir}`,
          action: { kind: 'open-logs', label: 'Open logs folder' },
        };
      } catch (err) {
        return {
          id: 'backend-assets', label: 'Bundled backend assets', state: 'failed',
          detail: `Asset check failed: ${err instanceof Error ? err.message : String(err)}`,
          action: { kind: 'open-logs', label: 'Open logs folder' },
        };
      }
    })();

    const checks: HealthCheck[] = [db, filesystem, vpn, network, backendAssets];

    // Aggregate: any non-ok check → 'degraded' overall (the UI stays usable;
    // 'failed' is reserved for genuinely broken components in the details).
    const overallState: HealthState = checks.some((c) => c.state !== 'ok') ? 'degraded' : 'ok';

    return {
      status: overallState,
      safeMode,
      checks,
      generatedAt: Date.now(),
      tookMs: Date.now() - started,
      version: pkg.version,
    };
  });

  // ---- Scheduled VPN tunnel self-test (dry-run) ----

  // Latest self-test result + live scheduler state for the System Health page.
  app.get('/api/v1/vpn/selftest', async () => {
    const scheduleStatus = ctx.services.schedule.statusSnapshot();
    return {
      last: ctx.services.vpnSelfTest.lastResult(),
      running: ctx.services.vpnSelfTest.isRunning(),
      schedule: scheduleStatus.vpn,
      safeMode: ctx.config.safeMode === true,
    };
  });

  // Trigger an immediate dry-run self-check ("Run now" on System Health).
  app.post('/api/v1/vpn/selftest/run', async () => {
    const result = await ctx.services.vpnSelfTest.run('manual');
    return { result };
  });
}
