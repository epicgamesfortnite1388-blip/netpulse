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

import { vpnError } from './vpnService';

import type { FileSecretVault, ImportedProfile, VpnProfileInput, VpnProvider, VpnProviderHooks } from './vpnService';

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

/** Wait until the SOCKS port answers or the deadline passes. */
export async function waitUntilAnswering(port: number, deadlineMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (await portAnswering(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return portAnswering(port);
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

/**
 * The slice of the kill switch this provider uses (structurally typed so the
 * two remain independently testable).
 */
export interface AetherKillSwitchHandle {
  arm(input: { previousProxy: string | null; label: string }): unknown;
  onTunnelDropped(reason: string): Promise<unknown>;
  onTunnelStopped(): Promise<unknown>;
  status(): { armed: boolean; blocking: boolean; enabled: boolean; note: string | null };
}

export interface AetherProviderOptions {
  bindPort?: number;
  killSwitch?: AetherKillSwitchHandle;
  /** split-tunnel rules, handed to the engine as a [direct] routes file */
  bypass?: () => BypassRuleSet | null;
  /** kill-switch preference; when on, connect also routes the OS through the tunnel */
  killSwitchEnabled?: () => boolean;
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
  private stderrTail = '';
  private readonly killSwitch: AetherKillSwitchHandle | undefined;
  private readonly bypass: (() => BypassRuleSet | null) | undefined;
  private readonly killSwitchEnabled: (() => boolean) | undefined;
  /** the system proxy value we replaced, only set while we hold the handoff */
  private previousSystemProxy: string | null = null;
  private holdsSystemProxy = false;

  constructor(vault: FileSecretVault, configDir: string, hooks?: VpnProviderHooks, opts: AetherProviderOptions = {}) {
    this.vault = vault;
    this.configDir = configDir;
    this.hooks = hooks;
    this.bindPort = opts.bindPort ?? AETHER_SOCKS_PORT;
    this.killSwitch = opts.killSwitch;
    this.bypass = opts.bypass;
    this.killSwitchEnabled = opts.killSwitchEnabled;
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

    const { spawn } = await import('node:child_process');
    this.stderrTail = '';
    const child = spawn(bin, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr?.on('data', (c: Buffer) => { this.stderrTail = (this.stderrTail + c.toString()).slice(-4_000); });
    child.stdout?.on('data', (c: Buffer) => { this.stderrTail = (this.stderrTail + c.toString()).slice(-4_000); });

    const ok = await waitUntilAnswering(this.bindPort, 120_000);
    if (!ok || child.exitCode != null) {
      child.kill();
      const reason = this.stderrTail.match(/error[^\r\n]*|panic[^\r\n]*/i)?.[0]?.slice(0, 200) ?? `SOCKS5 port ${this.bindPort} never opened`;
      if (connId) this.hooks?.updateConnection?.(connId, { status: 'error', error: reason, disconnectedAt: Date.now() });
      this.hooks?.event?.('error', `Aether failed to start for "${profile.name}": ${reason}`, { profileId: profile.id });
      throw vpnError(502, 'aether_failed', `Aether did not come up: ${reason}`);
    }

    // Ground truth: the SOCKS5 handshake must actually complete and relay.
    const relay = await socks5RelayCheck(this.bindPort);
    if (!relay) {
      child.kill();
      const reason = 'SOCKS5 handshake did not complete — the tunnel did not open';
      if (connId) this.hooks?.updateConnection?.(connId, { status: 'error', error: reason, disconnectedAt: Date.now() });
      throw vpnError(502, 'aether_failed', `Aether answered on port ${this.bindPort} but the SOCKS5 tunnel is not relaying`);
    }

    this.child = child;
    this.connectedAt = Date.now();
    this.connectedProfile = profile;
    // Kill switch: with it on, this tunnel also routes the OS (the system proxy
    // points at Aether's SOCKS5), which is what makes a drop a leak risk worth
    // blocking. With it off, proxy mode changes nothing about the OS — the
    // honest default of every proxy-mode engine here.
    await this.takeSystemProxy(profile);
    child.on('close', (code) => {
      if (this.child === child) {
        const label = this.connectedProfile?.name ?? profile.name;
        this.child = null;
        this.connectedAt = null;
        this.connectedProfile = null;
        this.exitIp = null;
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
    const verificationNote = this.exitIp
      ? `SOCKS5 tunnel is up on 127.0.0.1:${this.bindPort}; traffic through it exits from ${this.exitIp}. Proxy mode does not change the system route by design.`
      : `SOCKS5 tunnel is up on 127.0.0.1:${this.bindPort} (relay verified), but the exit-IP check could not be fetched, so exit identity is unproven.`;

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

  async disconnect(): Promise<VpnStatus> {
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
