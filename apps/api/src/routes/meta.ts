import fs from 'node:fs';
import path from 'node:path';

import pkg from '../../package.json';

import { proxyEngineStatus } from '../services/proxyEngineRunner';

import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context';

type CapabilityState = 'supported' | 'partial' | 'requires-permission' | 'unavailable' | 'unknown';

interface PlatformCapabilities {
  generatedAt: number;
  icmpPing: { state: CapabilityState; note: string };
  tcpProbe: { state: CapabilityState; note: string };
  dnsUdp: { state: CapabilityState; note: string };
  dnsDoH: { state: CapabilityState; note: string };
  dnsDoT: { state: CapabilityState; note: string };
  traceroute: { state: CapabilityState; note: string };
  mtuDiscovery: { state: CapabilityState; note: string };
  vpn: Record<string, { installed: boolean; note: string }>;
}

let capCache: { at: number; caps: PlatformCapabilities } | null = null;

async function detectCapabilities(ctx: AppContext): Promise<PlatformCapabilities> {
  const now = Date.now();
  if (capCache && now - capCache.at < 5 * 60_000) return capCache.caps;

  // ICMP needs raw sockets: available on Unix without privileges and on
  // Windows through the ping.exe helper (which needs admin on some builds).
  let icmpState: CapabilityState = 'unknown';
  let icmpNote = 'Not probed yet.';
  try {
    const ping = await ctx.controller.icmpPing('1.1.1.1', { count: 1, timeoutMs: 1_200, family: 4 });
    if (ping.received > 0) {
      icmpState = 'supported';
      icmpNote = `Raw ICMP answered (${Math.round(ping.avg ?? 0)} ms) — full latency/loss/jitter stats available.`;
    } else {
      icmpState = 'unavailable';
      icmpNote = 'ICMP probe got no reply from 1.1.1.1 — ICMP may be blocked by the network or require elevated privileges.';
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    icmpState = /permission|privilege|admin/i.test(message) ? 'requires-permission' : 'unavailable';
    icmpNote = message;
  }

  const binaries = await ctx.controller.detectVpnBinaries();
  // The app runs two kinds of engine. The tunnel providers above need their
  // binary on PATH; the app-managed proxy cores (installed by this app into its
  // data dir) drive node tests and the local proxy tunnel. Reporting only the
  // PATH side made "unavailable" mean "we found nothing" on a machine with
  // xray/sing-box/v2ray installed.
  const installedCores = proxyEngineStatus(ctx.services.settings.get().proxyEngine?.preferred ?? 'auto')
    .engines.filter((e) => e.available)
    .map((e) => e.id);
  const vpn: PlatformCapabilities['vpn'] = {
    wireGuard: { installed: binaries.wireguard ?? false, note: binaries.wireguard ? 'wireguard CLI present' : 'Not installed — WireGuard profiles import but cannot connect.' },
    openVpn: { installed: binaries.openvpn ?? false, note: binaries.openvpn ? 'openvpn CLI present' : 'Not installed — OpenVPN profiles import but cannot connect.' },
    singBox: {
      installed: binaries.singbox ?? false,
      note: binaries.singbox
        ? 'sing-box present'
        : installedCores.length > 0
          ? `sing-box is not on PATH, so the sing-box tunnel provider is unavailable. The app-managed cores (${installedCores.join(', ')}) still run node tests and the local proxy tunnel for these protocols.`
          : 'Not installed — VLESS/VMess/Trojan/Shadowsocks profiles import but cannot connect.',
    },
    proxyCores: {
      installed: installedCores.length > 0,
      note: installedCores.length > 0
        ? `App-managed proxy cores installed: ${installedCores.join(', ')}.`
        : 'No app-managed proxy core — node tests that need a real proxied request report unavailable.',
    },
  };

  const caps: PlatformCapabilities = {
    generatedAt: now,
    icmpPing: { state: icmpState, note: icmpNote },
    tcpProbe: { state: 'supported', note: 'Pure-Node TCP connect timing — no privileges required.' },
    dnsUdp: { state: 'supported', note: 'Pure-Node UDP DNS client.' },
    dnsDoH: { state: 'supported', note: 'HTTPS DNS queries — needs outbound 443.' },
    dnsDoT: { state: 'supported', note: 'Pure-Node TLS DNS client — requires outbound TCP 853; many networks block it.' },
    traceroute: { state: 'supported', note: 'Uses the OS traceroute binary (tracert on Windows).' },
    mtuDiscovery: { state: 'supported', note: 'Pure-Node payload-size discovery with the DF bit.' },
    vpn,
  };
  capCache = { at: now, caps };
  return caps;
}

export function registerMetaRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/meta', async () => {
    const binaries = await ctx.controller.detectVpnBinaries();
    return {
      name: 'NetPulse',
      version: pkg.version,
      demoMode: ctx.config.demoMode,
      safeMode: ctx.config.safeMode === true,
      platform: process.platform,
      node: process.version,
      capabilities: {
        ipInfo: true,
        pingTest: true,
        // pure-Node implementations: no OS dependency
        speedTest: true,
        dnsTests: true,
        dnsLeakTest: true,
        endpointTesting: true,
        optimization: true,
        serverMonitoring: true,
        gaming: true,
        // shells out to tracert/traceroute, shipped by default on Windows and
        // standard on Unix distributions
        routeTracing: true,
        // real only when a provider binary is actually installed
        vpn: ctx.vpn.all().some((p) => p.info.available),
        vpnBinaries: binaries,
      },
    };
  });

  app.get('/api/v1/meta/capabilities', async () => detectCapabilities(ctx));

  /**
   * Reset App State — recover a wedged installation without deleting
   * unrelated user files.
   *
   * Every file/dir in the app data dir is MOVED (never deleted) into
   * `backup-<timestamp>/` — history, settings, VPN profiles, secrets, the
   * node database and a corrupt DB all survive there. The sidecar then exits;
   * in desktop mode the Rust supervisor's stdin-EOF handshake detects the
   * exit and the watchdog respawns a fresh backend that migrates a brand-new
   * database. In web/dev mode the process exits and the dev runner restarts
   * it — the payload always tells the caller what just happened.
   *
   * Order matters: the SQLite handle is closed BEFORE moving the DB file
   * (Windows keeps renamed-but-open files mapped). Locked files (e.g. an AV
   * scanner holding the DB) are copied and left in place — the backup is
   * still complete and the next boot recovers them.
   */
  app.post('/api/v1/meta/reset-state', { config: { rateLimit: { max: 2, timeWindow: '1 hour' } } }, async () => {
    const backupDir = path.join(ctx.config.dataDir, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(backupDir, { recursive: true });
    const moved: string[] = [];
    const copied: string[] = [];

    // Close the DB first so the move below cannot race an open handle.
    try { ctx.db.close(); } catch { /* already closed */ }

    for (const entry of fs.readdirSync(ctx.config.dataDir, { withFileTypes: true })) {
      if (entry.name.startsWith('backup-')) continue;
      const src = path.join(ctx.config.dataDir, entry.name);
      const dst = path.join(backupDir, entry.name);
      try {
        fs.renameSync(src, dst);
        moved.push(entry.name);
      } catch {
        try {
          fs.cpSync(src, dst, { recursive: true, force: true });
          copied.push(entry.name);
        } catch {
          // locked or unreadable — leave it in place, backup stays partial
        }
      }
    }

    const desktop = process.env.NETPULSE_DESKTOP === '1';
    const payload = {
      ok: true as const,
      backupDir,
      movedCount: moved.length,
      copiedCount: copied.length,
      restarting: true as const,
      note: copied.length
        ? `Some files could not be moved and were copied instead. Backup: ${backupDir}. The app will restart now.`
        : `Previous state preserved at ${backupDir}. The app will restart now.`,
    };

    // Respond first, then exit so the supervisor respawns a fresh backend.
    setImmediate(() => {
      process.exit(desktop ? 0 : 78);
    });
    return payload;
  });
}
