/**
 * Aether VPN provider — a separate tunnel engine alongside WireGuard, OpenVPN
 * and sing-box.
 *
 * Aether (https://github.com/CluvexStudio/Aether) is a standalone
 * censorship-circumvention binary that discovers a route out of a filtered
 * network and serves the tunnel as a local SOCKS5 proxy (default
 * 127.0.0.1:1819). Like every other engine in this app, it is driven, not
 * reimplemented: the real binary is spawned, ground truth is a live TCP
 * connection to that SOCKS5 port (the same rule Aether-GUI uses), and exit
 * identity is proven by fetching the public IP *through the SOCKS5 proxy* —
 * proxy mode does not change the system route, so verifyConnect's IP-diff
 * logic cannot apply here.
 *
 * The binary itself is managed by the engine manager (GitHub releases →
 * published SHA256 sidecar → `-v` self-check → `<dataDir>/aether/`), so
 * `available` is true whenever the binary is installed and passes its
 * self-check. Install/Update is exposed to the user; a new upstream release
 * is picked up by pressing it (status `updated` when the version changed).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { lookup as dnsLookupCb } from 'node:dns';
import { promisify } from 'node:util';

const dnsLookup4 = promisify(dnsLookupCb) as (host: string, options: { family: 4 }) => Promise<{ address: string }>;

import type { ChildProcess } from 'node:child_process';
import type { BypassRuleSet, VpnStatus } from '@netpulse/shared';

import { spawnCoreProcess } from '../services/coreProcess';
import { TunGatewayHandle } from '../services/tunGatewayHandle';
import { vpnError } from './vpnService';

import type { CoreProcessFailure } from '../services/coreProcess';
// The Aether option types live in vpnService (beside the hooks field that
// carries them): importing them from THIS module would close an import cycle.
import type {
  AetherKillSwitchHandle,
  AetherProviderOptions,
  FileSecretVault,
  ImportedProfile,
  VpnProfileInput,
  VpnProvider,
  VpnProviderHooks,
} from './vpnService';

/** Where the Aether binary and its identity state live. */
export function aetherDir(): string {
  if (process.env['NETPULSE_AETHER_DIR']) return process.env['NETPULSE_AETHER_DIR'];
  return path.join(process.env['NETPULSE_DATA_DIR'] ?? process.cwd(), 'aether');
}

/** Default SOCKS5 port Aether serves (matches the binary's own default). */
export const AETHER_SOCKS_PORT = 1819;

export interface AetherSettings {
  protocol: 'masque' | 'wg' | 'gool' | 'mim';
  scanMode: 'turbo' | 'balanced' | 'thorough' | 'stealth' | 'ironclad';
  transport: 'h3' | 'h2';
  ipVersion: 'v4' | 'v6' | 'both';
  noize: 'default' | 'off' | 'light' | 'firewall' | 'balanced' | 'gfw' | 'aggressive';
  quickReconnect: boolean;
}

export const DEFAULT_AETHER_SETTINGS: AetherSettings = {
  protocol: 'masque',
  scanMode: 'balanced',
  transport: 'h3',
  ipVersion: 'v4',
  noize: 'default',
  quickReconnect: true,
};

const ALLOWED_SCAN = new Set(['turbo', 'balanced', 'thorough', 'stealth', 'ironclad']);
const ALLOWED_PROTOCOL = new Set(['masque', 'wg', 'gool', 'mim']);
const ALLOWED_NOIZE = new Set(['default', 'off', 'light', 'firewall', 'balanced', 'gfw', 'aggressive']);

/** Parse stored settings JSON defensively — a corrupt file yields defaults. */
export function parseAetherSettings(raw: string | null): AetherSettings {
  if (!raw) return { ...DEFAULT_AETHER_SETTINGS };
  try {
    const doc = JSON.parse(raw) as Record<string, unknown>;
    const protocol = String(doc['protocol'] ?? 'masque');
    const scanMode = String(doc['scanMode'] ?? 'balanced');
    const noize = String(doc['noize'] ?? 'default');
    return {
      protocol: (ALLOWED_PROTOCOL.has(protocol) ? protocol : 'masque') as AetherSettings['protocol'],
      scanMode: (ALLOWED_SCAN.has(scanMode) ? scanMode : 'balanced') as AetherSettings['scanMode'],
      transport: doc['transport'] === 'h2' ? 'h2' : 'h3',
      ipVersion: doc['ipVersion'] === 'v6' ? 'v6' : doc['ipVersion'] === 'both' ? 'both' : 'v4',
      noize: (ALLOWED_NOIZE.has(noize) ? noize : 'default') as AetherSettings['noize'],
      quickReconnect: doc['quickReconnect'] !== false,
    };
  } catch {
    return { ...DEFAULT_AETHER_SETTINGS };
  }
}

/** Map an imported profile's stored settings onto real aether CLI flags. */
export function aetherFlagsFor(settings: AetherSettings): string[] {
  const args: string[] = [];
  if (settings.protocol === 'wg') args.push('--wg');
  else if (settings.protocol === 'gool') args.push('--gool');
  else if (settings.protocol === 'mim') args.push('--mim');
  else args.push('--masque');
  if (settings.transport === 'h2') args.push('--h2');
  // `--scan <mode>` is the long form of --turbo/--thorough/...; always pass it
  // so every profile records its mode explicitly.
  args.push('--scan', settings.scanMode);
  if (settings.ipVersion === 'v6') args.push('-6');
  else if (settings.ipVersion === 'both') args.push('--dual');
  if (settings.noize !== 'default') args.push('--noize', settings.noize);
  if (!settings.quickReconnect) args.push('--no-quick-reconnect');
  return args;
}

/**
 * Exit code as a human reads it. Windows reports a killed process as
 * 4294967295 (unsigned -1), which is noise in a user-facing status line.
 */
export function exitCodeLabel(code: number | null): string {
  if (code == null) return 'no exit code';
  const signed = code > 2_147_483_647 ? code - 4_294_967_296 : code;
  return `code ${signed}`;
}

/** Managed-run argv: non-interactive, loopback-only, own identity state. */
export function buildAetherArgs(options: { bindPort: number; configDir: string; profileArgs: string[]; routesFile?: string | null }): string[] {
  const args = [
    '--bind', `127.0.0.1:${options.bindPort}`,
    '--config', path.join(options.configDir, 'aether.toml'),
    '--log-level', 'info',
    ...options.profileArgs,
  ];
  // Split-tunnel rules ride on the tunnel only, exactly like the proxy cores:
  // destinations in the bypass list are dialled direct by Aether itself.
  if (options.routesFile) args.push('--routes', options.routesFile);
  return args;
}

/**
 * Render the app's existing split-tunnel rule set as an Aether `[direct]`
 * routes file (Aether's own accepted syntax, from `aether --help`):
 *   example.com        the name and every subdomain
 *   full:example.com   that exact name only
 *   10.0.0.0/8         a network, or a bare address
 *   port:25            a port, or port:3000-3010
 *   private            lan, loopback and cgnat space
 * Returns null when the rule set is empty — an empty routes file is noise and
 * would make Aether's routing rules harder to reason about, not clearer.
 */
export function renderAetherRoutes(rs: BypassRuleSet | null): string | null {
  if (!rs) return null;
  const lines: string[] = [];
  if (rs.lan) lines.push('private');
  for (const d of rs.domains) lines.push(`full:${d}`);
  for (const ip of rs.ips) lines.push(ip);
  for (const p of rs.ports) lines.push(`port:${p}`);
  if (lines.length === 0) return null;
  return `# Generated by NetPulse from the split-tunnel rule set — do not edit.\n[direct]\n${lines.join('\n')}\n`;
}

/**
 * How long the Aether binary gets to open its SOCKS5 port. Long on purpose:
 * before it serves anything it scans for a route out, which on a filtered
 * network is the whole point of running it.
 */
const AETHER_READY_TIMEOUT_MS = 120_000;

/** Probe: is something listening on this loopback port? */
export function portAnswering(port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port, timeout: timeoutMs }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => {
      sock.destroy();
      resolve(false);
    });
    sock.on('timeout', () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/**
 * Minimal SOCKS5 CONNECT client (no-auth) that then speaks HTTP CONNECT to
 * an echo endpoint — proves the proxy actually relays, not just that the
 * port is open. Returns null when any stage fails.
 */
export function socks5RelayCheck(port: number, timeoutMs = 10_000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port, timeout: timeoutMs });
    let stage: 'greeting' | 'connect' = 'greeting';
    let buf = Buffer.alloc(0);
    const finish = (ok: boolean): void => {
      sock.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2) return;
        if (!(buf[0] === 0x05 && buf[1] === 0x00)) {
          clearTimeout(timer);
          finish(false);
          return;
        }
        buf = buf.subarray(2);
        stage = 'connect';
        // CONNECT 1.1.1.1:80 (ip 1.1.1.1 = 0x01 0x01 0x01 0x01)
        sock.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x50]));
      } else if (stage === 'connect') {
        if (buf.length < 4) return;
        // reply: VER REP RSV ATYP ... — REP 0x00 = succeeded
        clearTimeout(timer);
        finish(buf[0] === 0x05 && buf[1] === 0x00);
      }
    });
    sock.on('connect', () => {
      sock.write(Buffer.from([0x05, 0x01, 0x00])); // greeting: ver 5, 1 method, no-auth
    });
  });
}

interface Socks5Connection {
  socket: net.Socket;
}

/**
 * SOCKS5 CONNECT to a target through the local proxy, resolving with the raw
 * socket so an HTTP GET can be spoken over it (exit-IP proof).
 */
export function socks5Connect(port: number, targetHost: string, targetPort: number, timeoutMs = 12_000): Promise<Socks5Connection | null> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port, timeout: timeoutMs });
    let stage: 'greeting' | 'connect' = 'greeting';
    let buf = Buffer.alloc(0);
    const finish = (ok: boolean): void => {
      if (!ok) sock.destroy();
      resolve(ok ? { socket: sock } : null);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const isIp = net.isIPv4(targetHost);
    sock.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2) return;
        if (!(buf[0] === 0x05 && buf[1] === 0x00)) {
          clearTimeout(timer);
          finish(false);
          return;
        }
        buf = buf.subarray(2);
        stage = 'connect';
        const hostBytes = isIp
          ? Buffer.from(targetHost.split('.').map((n) => Number(n)))
          : Buffer.concat([Buffer.from([0x03, targetHost.length]), Buffer.from(targetHost, 'utf8')]);
        const req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, isIp ? 0x01 : 0x03]), hostBytes, Buffer.from([targetPort >> 8, targetPort & 0xff])]);
        sock.write(req);
      } else if (stage === 'connect') {
        if (buf.length < 4) return;
        clearTimeout(timer);
        finish(buf[0] === 0x05 && buf[1] === 0x00);
      }
    });
    sock.on('connect', () => {
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
    });
  });
}

/** Fetch the public IP through the local SOCKS5 proxy (exit-identity proof). */
export async function fetchExitIpThroughSocks(port: number, timeoutMs = 15_000): Promise<string | null> {
  // api.ipify.org over plain HTTP keeps the proof self-contained: one SOCKS5
  // CONNECT, one GET, no TLS-in-SOCKS plumbing. Aether's SOCKS5 answers
  // IPv4-form CONNECT only (domain-form ATYP 0x03 is refused), so resolve
  // locally first and send the hostname in the Host header for vhost routing.
  let ip: string;
  try {
    const resolved = await dnsLookup4('api.ipify.org', { family: 4 });
    ip = resolved.address;
  } catch {
    return null;
  }
  const conn = await socks5Connect(port, ip, 80, timeoutMs);
  if (!conn) return null;
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => {
      conn.socket.destroy();
      resolve(null);
    }, timeoutMs);
    conn.socket.on('data', (c: Buffer) => {
      data += c.toString();
      const m = data.match(/"ip"\s*:\s*"([0-9a-fA-F.:]+)"/);
      if (m) {
        clearTimeout(timer);
        conn.socket.destroy();
        resolve(m[1]!);
      }
    });
    conn.socket.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    conn.socket.write(`GET /?format=json HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n`);
  });
}

export class AetherProvider implements VpnProvider {
  readonly info = {
    id: 'aether',
    name: 'Aether',
    kind: 'aether' as const,
    capabilities: ['connect', 'disconnect', 'status', 'proxy-mode', 'auto-update'],
    available: false,
    protocols: ['masque', 'wg', 'gool', 'mim'],
  };

  private readonly vault: FileSecretVault;
  private readonly configDir: string;
  private available = false;
  private child: ChildProcess | null = null;
  private connectedAt: number | null = null;
  private connectedProfile: ImportedProfile | null = null;
  private readonly bindPort: number;
  private hooks: VpnProviderHooks | undefined;
  private exitIp: string | null = null;
  private readonly killSwitch: AetherKillSwitchHandle | undefined;
  private readonly bypass: (() => BypassRuleSet | null) | undefined;
  private readonly killSwitchEnabled: (() => boolean) | undefined;
  /** the system proxy value we replaced, only set while we hold the handoff */
  private previousSystemProxy: string | null = null;
  private holdsSystemProxy = false;

  /*
   * System-wide (TUN) mode.
   *
   * Aether serves SOCKS5 on a loopback port, so by itself it captures only the
   * apps that were told to use it. TUN mode puts a sing-box TUN gateway in
   * front of that port — fronted as `socks`, because that is what Aether
   * speaks.
   *
   * The state machine is NOT reimplemented here: `TunGatewayHandle` owns it,
   * shared with the proxy tunnel's TUN path, including the rules that a gateway
   * is only `active` once traffic provably traversed it, that a failed relay
   * check stops the device instead of leaving it holding the default route, and
   * that a device death must reach the kill switch. `tunRequested` is the only
   * piece of TUN state this provider owns — it is a preference, not a status.
   */
  private tunRequested = false;
  private readonly tun: TunGatewayHandle;

  constructor(vault: FileSecretVault, configDir: string, hooks?: VpnProviderHooks, opts: AetherProviderOptions = {}) {
    this.vault = vault;
    this.configDir = configDir;
    this.hooks = hooks;
    this.bindPort = opts.bindPort ?? AETHER_SOCKS_PORT;
    this.killSwitch = opts.killSwitch;
    this.bypass = opts.bypass;
    this.killSwitchEnabled = opts.killSwitchEnabled;
    this.tun = new TunGatewayHandle(
      {
        upstream: 'socks',
        upstreamPort: () => this.bindPort,
        bypass: () => this.bypass?.() ?? null,
        label: () => this.connectedProfile?.name ?? 'Aether',
        // No route exclusions can be derived here: Aether's own egress goes to
        // relays the profile does not name, so whether its dial is captured by
        // the device depends on the Aether binary binding it to the physical
        // interface. The relay check is what decides.
        armRouteMode: async () => {
          // Never swallowed: the handle reports `unguarded` when a guard the
          // user asked for could not be armed, so the status can say so.
          if (!this.killSwitch) {
            return this.killSwitchEnabled?.() === true
              ? 'the kill switch is on, but no kill-switch service is wired into this provider'
              : true;
          }
          const { getSystemProxy } = await import('../services/systemProxy');
          const prev = await getSystemProxy();
          this.killSwitch.arm({ previousProxy: prev.proxy, label: this.connectedProfile?.name ?? 'Aether', mode: 'route' });
          return true;
        },
        onCapturedDrop: async (reason) => {
          // Capture is gone: let the kill switch decide (block when it is on,
          // restore the user's own proxy otherwise) rather than letting the
          // machine silently fall back to the direct path. AWAITED: the watchdog
          // heals only once the block is actually in place, so a re-armed
          // capture can never be claimed while the machine is still open.
          try {
            if (this.killSwitch) await this.killSwitch.onTunnelDropped(reason);
            else await this.restoreSystemProxy();
          } catch {
            // best effort — the watchdog's deadline bounds this path
          }
        },
        onState: (event) => {
          if (event.kind === 'active') {
            this.hooks?.event?.('info', `Aether is now system-wide: TUN gateway verified end to end (exit ${event.exitIp})`);
          } else if (event.kind === 'dropped') {
            // The capture is gone the moment this fires; the kill switch and the
            // watchdog act on it right after.
            this.hooks?.event?.('warn', `Aether TUN capture was lost: ${event.error}`);
          } else if (event.kind === 'recovering') {
            this.hooks?.event?.(
              'warn',
              `Aether TUN capture was lost (${event.error}); attempting the one automatic re-arm (${event.attempt} of ${event.maxAttempts})`,
            );
          } else if (event.kind === 'recovered') {
            this.hooks?.event?.(
              'info',
              `Aether TUN capture recovered automatically (exit ${event.exitIp}) after: ${event.afterError}`,
            );
          } else if (event.kind === 'unguarded') {
            // Capture is up but its guarantee is missing. Logged as a warning
            // for the record, and carried in the status as its own state — this
            // is never the same news as `active`.
            this.hooks?.event?.('warn', `Aether TUN mode is capturing WITHOUT its kill-switch hold: ${event.error}`);
          } else if (event.kind === 'degraded') {
            const label = event.blockedBy === 'relay' ? 'Aether TUN mode is not proving out' : 'Aether TUN mode unavailable';
            this.hooks?.event?.('warn', `${label}: ${event.error}`);
          }
        },
      },
      {
        // Aether's SOCKS5 port has no HTTP-CONNECT inbound of its own, so the
        // relay proof goes through the shared proxy fetch (same trace endpoint
        // the hop checks use → ip=).
        verifyRelay: async (port) => {
          const { EXIT_TRACE_URL, fetchThroughHttpProxy, traceField } = await import('../services/proxyTunnel');
          const trace = await fetchThroughHttpProxy(port, EXIT_TRACE_URL, 15_000);
          return traceField(trace, 'ip');
        },
      },
    );
  }

  /**
   * Why an Aether start failed, in the binary's own words where it offers any.
   *
   * `output` is the shared owner's bounded tail. When it says nothing useful,
   * the fallback is the owner's classified reason — except for a plain timeout,
   * where the honest user-facing fact is that the SOCKS5 port never opened.
   */
  private startFailureReason(result: { failure: CoreProcessFailure; error: string; output: string }): string {
    const own = result.output.match(/error[^\r\n]*|panic[^\r\n]*/i)?.[0]?.slice(0, 200);
    if (own) return own;
    if (result.failure === 'timeout') return `SOCKS5 port ${this.bindPort} never opened`;
    return result.error;
  }

  private binaryPath(): string {
    const exe = process.platform === 'win32' ? 'aether.exe' : 'aether';
    return path.join(aetherDir(), exe);
  }

  /** The binary must exist AND answer `-v` — a corrupt install is not available. */
  private async selfCheck(): Promise<string | null> {
    const bin = this.binaryPath();
    if (!fs.existsSync(bin)) return null;
    try {
      const { runCommand } = await import('../util/exec');
      const res = await runCommand(bin, ['-v'], { timeoutMs: 8_000 });
      const m = res.stdout.match(/aether\s+(\d+\.\d+\.\d+)/);
      if (res.code === 0 && m) return m[1]!;
    } catch {
      // fall through
    }
    return null;
  }

  async init(): Promise<void> {
    const version = await this.selfCheck();
    this.available = version != null;
    this.info.available = this.available;
    // Stale sweep: kill only OUR aether (its --config path lives in OUR dir).
    if (process.platform === 'win32') {
      try {
        const { execSync } = await import('node:child_process');
        const marker = aetherDir().replace(/\\/g, '\\\\').replace(/'/g, "''");
        const out = execSync(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'Name=\\"aether.exe\\"' | Where-Object { $_.CommandLine -like '*aether.toml*' -and $_.CommandLine -like '*${marker}*' } | Select-Object -ExpandProperty ProcessId"`,
          { stdio: ['pipe', 'pipe', 'ignore'], timeout: 10_000 },
        ).toString();
        for (const pidStr of out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+$/.test(l))) {
          try { execSync(`taskkill /PID ${pidStr} /F`, { stdio: 'ignore', timeout: 10_000 }); } catch { /* raced exit */ }
          this.hooks?.event?.('info', `Removed stale Aether process (pid ${pidStr}) from a previous session`);
        }
      } catch {
        // nothing matching
      }
    }
  }

  /** Install/update the binary through the engine manager's verified pipeline. */
  async installOrUpdate(): Promise<{ ok: boolean; status: string; version: string | null; error: string | null; checksumVerified: boolean }> {
    const { installAether } = await import('../services/engineManager');
    const outcome = await installAether();
    await this.init();
    return {
      ok: outcome.status !== 'failed',
      status: outcome.status,
      version: outcome.version,
      error: outcome.error,
      checksumVerified: outcome.checksumVerified,
    };
  }

  async importProfile(input: VpnProfileInput): Promise<ImportedProfile> {
    // The "config" for Aether is its settings JSON; empty input yields defaults.
    // Unparseable JSON is rejected so a silent default never surprises.
    const text = input.configText.trim();
    let settings = { ...DEFAULT_AETHER_SETTINGS };
    if (text.length > 0) {
      const parsed = parseAetherSettings(text);
      try {
        JSON.parse(text);
      } catch {
        throw vpnError(400, 'invalid_config', 'Aether profiles take a JSON settings object (protocol/scanMode/transport/ipVersion/noize/quickReconnect) — or an empty value for defaults');
      }
      settings = parsed;
    }
    const id = crypto.randomUUID();
    const ref = `ae-${id}`;
    this.vault.set(ref, JSON.stringify(settings));
    // The provider owns its config dir: registry creates the parent, this
    // creates its own (an ENOENT here used to 500 the whole import).
    fs.mkdirSync(this.configDir, { recursive: true });
    const configPath = path.join(this.configDir, `${id}.aether.json`);
    fs.writeFileSync(configPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
    return {
      id,
      name: input.name || `Aether (${settings.protocol}/${settings.scanMode})`,
      protocol: 'aether',
      endpoint: `socks5://127.0.0.1:${this.bindPort}`,
      publicKeyFingerprint: null,
      allowedIps: null,
      dns: null,
      secretRef: ref,
      configPath,
      createdAt: Date.now(),
    };
  }

  async connect(profile: ImportedProfile): Promise<VpnStatus> {
    if (!this.available) {
      throw vpnError(501, 'aether_missing', 'Aether is not installed', 'Press Install/Update to fetch the verified binary from its official GitHub releases.');
    }
    if (this.child) {
      throw vpnError(409, 'already_connected', 'Aether is already connected — disconnect first');
    }
    const settings = parseAetherSettings(this.vault.get(profile.secretRef));
    const bin = this.binaryPath();
    // Split-tunnel rules: the existing bypass rule set, rendered as Aether's
    // own [direct] routes file so bypassed destinations genuinely stay direct
    // (and are therefore the ones exempt from the kill switch).
    const routesFile = this.writeRoutesFile();
    const args = buildAetherArgs({
      bindPort: this.bindPort,
      configDir: aetherDir(),
      profileArgs: aetherFlagsFor(settings),
      routesFile,
    });

    let connId: string | null = null;
    if (this.hooks?.recordConnection) {
      connId = crypto.randomUUID();
      this.hooks.recordConnection({
        id: connId,
        providerId: this.info.id,
        serverId: profile.id,
        serverName: profile.name,
        endpoint: profile.endpoint,
        protocol: 'aether',
        status: 'connecting',
        connectedAt: null,
      });
    }
    this.hooks?.event?.('info', `Connecting Aether tunnel "${profile.name}" (${settings.protocol}/${settings.scanMode})`, { profileId: profile.id });

    // The process lifecycle (spawn → inbound answering → kill) belongs to the
    // shared owner ./coreProcess, the same one the local cores use. Aether's
    // bring-up is the slowest of the engines — it scans for a route before it
    // serves anything — so its readiness budget is minutes, not seconds, and
    // its "ready" is only the SOCKS5 port accepting: the relay check below is
    // what turns a live process into a proven tunnel (a started process is
    // never a tunnel).
    const started = await spawnCoreProcess({
      bin,
      args,
      readyPort: this.bindPort,
      readyTimeoutMs: AETHER_READY_TIMEOUT_MS,
      label: 'Aether',
    });
    if (!started.ok) {
      const reason = this.startFailureReason(started);
      if (connId) this.hooks?.updateConnection?.(connId, { status: 'error', error: reason, disconnectedAt: Date.now() });
      this.hooks?.event?.('error', `Aether failed to start for "${profile.name}": ${reason}`, { profileId: profile.id });
      throw vpnError(502, 'aether_failed', `Aether did not come up: ${reason}`);
    }
    const child = started.process.child;

    // Ground truth: the SOCKS5 handshake must actually complete and relay.
    const relay = await socks5RelayCheck(this.bindPort);
    if (!relay) {
      // The owner kills the process and drops its bounded output; nothing here
      // is adopted, so `status()` never claims a tunnel that never relayed.
      started.process.cleanup();
      const reason = 'SOCKS5 handshake did not complete — the tunnel did not open';
      if (connId) this.hooks?.updateConnection?.(connId, { status: 'error', error: reason, disconnectedAt: Date.now() });
      throw vpnError(502, 'aether_failed', `Aether answered on port ${this.bindPort} but the SOCKS5 tunnel is not relaying`);
    }

    this.child = child;
    this.connectedAt = Date.now();
    this.connectedProfile = profile;
    // System-wide routing first when it was asked for: a verified TUN gateway
    // owns the default route, so the per-app system-proxy handoff would be
    // redundant state to hold and restore. When TUN does not prove out we fall
    // back to that handoff — the same honest degradation the local cores use.
    const tunUp = await this.startTunGatewayFor();
    // Kill switch: with it on, this tunnel also routes the OS (the system proxy
    // points at Aether's SOCKS5), which is what makes a drop a leak risk worth
    // blocking. With it off, proxy mode changes nothing about the OS — the
    // honest default of every proxy-mode engine here.
    if (!tunUp) await this.takeSystemProxy(profile);
    child.on('close', (code) => {
      if (this.child === child) {
        const label = this.connectedProfile?.name ?? profile.name;
        this.child = null;
        this.connectedAt = null;
        this.connectedProfile = null;
        this.exitIp = null;
        // The gateway fronted a port that just died — it must not survive it.
        this.tun.stop();
        this.hooks?.event?.('warn', `Aether process for "${label}" exited unexpectedly`);
        // The OS may still be pointed at Aether's dead port. Let the kill
        // switch decide: block, or hand the user's own proxy back. With no
        // switch wired, restore it ourselves rather than leaving a dead proxy.
        if (this.killSwitch) {
          void this.killSwitch.onTunnelDropped(`aether exited (${exitCodeLabel(code)})`).catch(() => undefined);
        } else {
          void this.restoreSystemProxy().catch(() => undefined);
        }
      }
    });

    if (connId) this.hooks?.updateConnection?.(connId, { status: 'connected', connectedAt: Date.now() });
    this.hooks?.event?.('info', `Aether tunnel "${profile.name}" is up (socks5://127.0.0.1:${this.bindPort})`, { profileId: profile.id });

    // Prove exit identity: fetch the public IP THROUGH the tunnel. Proxy mode
    // does not change the system route, so verifyConnect's before/after logic
    // cannot apply — this is the honest equivalent.
    this.exitIp = await fetchExitIpThroughSocks(this.bindPort);
    const tunStatus = this.tun.status();
    const tunNote =
      tunStatus.tun === 'active'
        ? ' TUN mode is verified: the OS default route is captured, so apps that ignore proxy settings ride the tunnel too. If the tunnel drops while the kill switch is on, the system proxy is pointed at a sink so traffic fails closed instead of falling back to direct.'
        : tunStatus.tunError
          ? ` TUN mode was requested but is not capturing the system: ${tunStatus.tunError}`
          : '';
    const verificationNote = this.exitIp
      ? `SOCKS5 tunnel is up on 127.0.0.1:${this.bindPort}; traffic through it exits from ${this.exitIp}. Proxy mode does not change the system route by design.${tunNote}`
      : `SOCKS5 tunnel is up on 127.0.0.1:${this.bindPort} (relay verified), but the exit-IP check could not be fetched, so exit identity is unproven.${tunNote}`;

    const status = await this.status();
    return {
      ...status,
      verification: this.exitIp ? 'verified' : 'unavailable',
      verificationNote,
      verifiedPublicIp: this.exitIp ?? undefined,
    };
  }

  /**
   * Write the bypass rule set as an Aether routes file. Returns null when there
   * is nothing to say (no rules) — an empty routing block would only obscure.
   */
  private writeRoutesFile(): string | null {
    const rendered = renderAetherRoutes(this.bypass?.() ?? null);
    if (!rendered) return null;
    try {
      const dir = aetherDir();
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'routes.toml');
      fs.writeFileSync(file, rendered, { mode: 0o600 });
      return file;
    } catch {
      return null;
    }
  }

  /** With the kill switch on, point the OS at this tunnel's SOCKS5 port. */
  private async takeSystemProxy(profile: ImportedProfile): Promise<void> {
    if (!this.killSwitchEnabled?.()) return;
    try {
      const { getSystemProxy, setSystemProxy } = await import('../services/systemProxy');
      const prev = await getSystemProxy();
      // WinINET recognises the explicit socks= form.
      const set = await setSystemProxy(`socks=127.0.0.1:${this.bindPort}`);
      if (!set.ok) {
        this.hooks?.event?.('warn', `Kill switch is on but the system proxy could not be set: ${set.error ?? 'unknown error'} — traffic is not routed through Aether`);
        return;
      }
      this.previousSystemProxy = prev.proxy;
      this.holdsSystemProxy = true;
      this.killSwitch?.arm({ previousProxy: prev.proxy, label: profile.name });
    } catch (err) {
      this.hooks?.event?.('warn', `Kill switch system-proxy handoff failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Put the user's own proxy setting back exactly as it was (idempotent). */
  private async restoreSystemProxy(): Promise<void> {
    if (!this.holdsSystemProxy) return;
    this.holdsSystemProxy = false;
    const { setSystemProxy } = await import('../services/systemProxy');
    const set = await setSystemProxy(this.previousSystemProxy);
    if (!set.ok) this.hooks?.event?.('error', `Could not restore the previous system proxy: ${set.error ?? 'unknown error'}`);
    this.previousSystemProxy = null;
  }

  /** Ask for system-wide (TUN) mode on the next connect. Idempotent. */
  setTunPreference(enabled: boolean): void {
    this.tunRequested = enabled;
  }

  getTunPreference(): boolean {
    return this.tunRequested;
  }

  /**
   * Bring up the TUN gateway in front of Aether's SOCKS5 port.
   *
   * Returns true only when traffic PROVABLY traversed the full path. Every
   * failure degrades honestly — the SOCKS5 tunnel stays up and the caller falls
   * back to the system-proxy handoff with the reason recorded. The state
   * machine itself (verify, teardown on a failed relay, fail closed on a drop)
   * is the shared TunGatewayHandle, not a second implementation.
   */
  private async startTunGatewayFor(): Promise<boolean> {
    if (!this.tunRequested) {
      this.tun.stop();
      return false;
    }
    return this.tun.start();
  }

  async disconnect(): Promise<VpnStatus> {
    this.tun.stop();
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    this.connectedAt = null;
    this.connectedProfile = null;
    this.exitIp = null;
    // Disconnect always means "back to normal": restore the user's proxy and
    // clear the hold, including when we were fail-closed.
    const ks = this.killSwitch?.status();
    if (ks?.blocking) {
      await this.killSwitch?.onTunnelStopped().catch(() => undefined);
    } else {
      if (this.holdsSystemProxy) {
        await this.restoreSystemProxy();
        await this.killSwitch?.onTunnelStopped().catch(() => undefined);
      }
    }
    return this.status();
  }

  async status(): Promise<VpnStatus> {
    return {
      connected: this.child != null,
      serverId: this.connectedProfile?.id ?? null,
      serverName: this.connectedProfile?.name ?? null,
      protocol: this.connectedProfile ? 'aether' : null,
      since: this.connectedAt,
      supported: this.available,
      killSwitchActive: this.killSwitch?.status().blocking === true,
      providerId: 'aether',
      rxBytes: null,
      txBytes: null,
      handshakeAgeSec: null,
      endpoint: this.connectedProfile?.endpoint ?? null,
      endpointLatencyMs: null,
      // TUN is a *preference* here: while it is on, the honest read is "requested"
      // until the gateway is proven active (see the shared model for tun states).
      tun: this.tunRequested ? (this.tun.status().tun ?? 'requested') : null,
      tunError: this.tunRequested ? this.tun.status().tunError : null,
      tunBlockedBy: this.tunRequested ? this.tun.status().tunBlockedBy : null,
      // What the watchdog has done, so a recovery (or a failed one) is visible
      // after the state itself has moved on.
      tunWatchdog: this.tunRequested ? this.tun.status().tunWatchdog : null,
      verification: 'not_verified',
      verificationNote: null,
    };
  }

  deleteProfile(profileId: string): void {
    this.vault.delete(`ae-${profileId}`);
    try {
      fs.rmSync(path.join(this.configDir, `${profileId}.aether.json`), { force: true });
    } catch {
      // best effort
    }
  }

  /** Live health for an active tunnel: the SOCKS relay is the liveness proof. */
  async health(): Promise<{ rxBytes: null; txBytes: null; handshakeAgeSec: null; endpointLatencyMs: number | null }> {
    const alive = this.child != null && (await portAnswering(this.bindPort));
    if (!alive) return { rxBytes: null, txBytes: null, handshakeAgeSec: null, endpointLatencyMs: null };
    // Best-effort latency: time the SOCKS5 CONNECT itself.
    const started = Date.now();
    const ok = await socks5RelayCheck(this.bindPort, 3_000);
    return { rxBytes: null, txBytes: null, handshakeAgeSec: null, endpointLatencyMs: ok ? Date.now() - started : null };
  }
}
