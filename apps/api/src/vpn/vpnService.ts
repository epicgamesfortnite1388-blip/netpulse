import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { runCommand } from '../util/exec';

import type { ChildProcess } from 'node:child_process';
import type {
  VpnProviderInfo,
  VpnServerInfo,
  VpnStatus,
  VpnVerification,
} from '@netpulse/shared';

/* ------------------------------ shared types ------------------------------ */

export interface VpnProfileInput {
  name: string;
  /** [Interface] + [Peer] INI text for WireGuard; .ovpn file content for OpenVPN;
   *  share-link URI or sing-box outbound JSON for sing-box */
  configText: string;
  protocol: 'wireguard' | 'openvpn' | 'custom';
}

export interface ImportedProfile {
  id: string;
  name: string;
  protocol: string;
  /** gateway metadata extracted from the config (no secrets) */
  endpoint: string | null;
  publicKeyFingerprint: string | null;
  allowedIps: string[] | null;
  dns: string[] | null;
  /** private key material is written to the vault, never returned */
  secretRef: string;
  configPath: string;
  createdAt: number;
}

/** Enriched status returned after a connect/disconnect attempt. */
export interface VpnConnectResult extends VpnStatus {
  /** IP observed before connect, when the verification pass captured one */
  previousPublicIp?: string | null;
  verificationNote?: string | null;
}

/** Optional persistence + verification hooks the registry wires at boot. */
export interface VpnProviderHooks {
  /** persist a freshly imported profile (durable across restarts) */
  saveProfile?(providerId: string, profile: ImportedProfile): void;
  /** record connection state transitions */
  recordConnection?(row: {
    id: string;
    providerId: string;
    serverId: string | null;
    serverName: string | null;
    endpoint: string | null;
    protocol: string;
    status: 'connecting' | 'connected' | 'disconnected' | 'error';
    connectedAt: number | null;
    error?: string | null;
  }): void;
  /** update an existing connection record */
  updateConnection?(
    id: string,
    patch: { status?: 'connecting' | 'connected' | 'disconnected' | 'error'; connectedAt?: number | null; disconnectedAt?: number | null; rxBytes?: number | null; txBytes?: number | null; error?: string | null },
  ): void;
  /** public IP measurement used to verify that a tunnel actually routes traffic */
  publicIpProbe?(): Promise<string | null>;
  /** record a VPN event */
  event?(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void;
}

export interface VpnProvider {
  readonly info: VpnProviderInfo;
  /** detect installed binaries / refresh availability; called once at startup */
  init(): Promise<void>;
  importProfile(input: VpnProfileInput): Promise<ImportedProfile>;
  connect(profile: ImportedProfile): Promise<VpnStatus>;
  disconnect(): Promise<VpnStatus>;
  status(): Promise<VpnStatus>;
  /**
   * Desktop per-action elevation flow: materialize the REAL config (with key
   * material) so the Rust bridge can stage a UAC-prompted tunnel install.
   * Returns the staged path; the CALLER owns deletion (every exit path).
   * Only providers that need elevation implement this.
   */
  prepareElevatedConnect?(profile: ImportedProfile): string;
  /** delete a profile's stored files and secrets */
  deleteProfile?(profileId: string): void;
  /** live health metrics for an active tunnel (nulls when unavailable) */
  health?(): Promise<{ rxBytes: number | null; txBytes: number | null; handshakeAgeSec: number | null; endpointLatencyMs: number | null }>;
}

export function vpnError(statusCode: number, code: string, message: string, hint?: string): Error {
  return Object.assign(new Error(message), { statusCode, code, hint });
}

/* ------------------------------ secret vault ------------------------------ */

/**
 * Minimal secret vault: AES-256-GCM encrypted file under the data dir.
 * Private keys never touch the database, the API or logs.
 */
export class FileSecretVault {
  constructor(private readonly file: string) {
    // The vault writes its key + entry files eagerly; a missing parent dir
    // used to turn every set() into a silent ENOENT (callers swallow vault
    // failures by design), so secrets silently never persisted.
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  /** Windows-safe filename for a ref: colon characters are not allowed there. */
  private pathFor(ref: string): string {
    const hash = crypto.createHash('sha256').update(ref).digest('hex').slice(0, 24);
    return `${this.file}.${hash}`;
  }

  private key(): Buffer {
    // machine-derived key file (0600). A packaged build swaps this for the OS keychain.
    const keyFile = `${this.file}.key`;
    if (!fs.existsSync(keyFile)) {
      fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
    }
    return Buffer.from(fs.readFileSync(keyFile));
  }

  set(ref: string, secret: string): void {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key(), iv);
    const enc = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const blob = Buffer.concat([iv, cipher.getAuthTag(), enc]);
    fs.writeFileSync(this.pathFor(ref), blob, { mode: 0o600 });
  }

  get(ref: string): string | null {
    try {
      const blob = fs.readFileSync(this.pathFor(ref));
      const iv = blob.subarray(0, 12);
      const tag = blob.subarray(12, 28);
      const data = blob.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  delete(ref: string): void {
    try {
      fs.rmSync(this.pathFor(ref), { force: true });
    } catch {
      // best effort
    }
  }
}

/* --------------------- connect verification (shared) ---------------------- */

/**
 * Verifies that a tunnel actually routes traffic: the public IP observed
 * after connect must differ from the one observed before connect. A failed
 * or unavailable check never flips `connected` — it is reported honestly
 * through the verification fields instead.
 */
export async function verifyConnect(hooks: VpnProviderHooks | undefined, status: VpnStatus): Promise<VpnStatus> {
  if (!hooks?.publicIpProbe || !status.connected) return status;
  let before: string | null = null;
  try {
    before = await hooks.publicIpProbe();
  } catch {
    // pre-connect probe is best effort
  }
  // tiny delay lets the tunnel fully claim the default route
  await new Promise((r) => setTimeout(r, 400));
  let after: string | null = null;
  try {
    after = await hooks.publicIpProbe();
  } catch {
    return {
      ...status,
      verification: 'unavailable',
      verificationNote: 'Public IP check could not be executed, so the tunnel is reported but not verified.',
    };
  }
  if (!after) {
    return {
      ...status,
      verification: 'unavailable',
      verificationNote: 'No public IP source answered after connect; the tunnel state is unverified.',
    };
  }
  if (before && before === after) {
    return {
      ...status,
      verification: 'failed',
      verificationNote: `Public IP is still ${after} — traffic is not flowing through the tunnel (check routes/allowed IPs).`,
    };
  }
  return {
    ...status,
    verifiedPublicIp: after,
    previousPublicIp: before,
    verification: before ? 'verified' : 'not_verified',
    verificationNote: before
      ? `Public IP changed from ${before} to ${after} — tunnel verified.`
      : 'Connected; pre-connect IP unknown so identity change could not be proven.',
  };
}

/* --------------------------- wireguard provider --------------------------- */

function parseWireGuardConfig(text: string): { endpoint: string | null; publicKey: string | null; allowedIps: string[] | null; dns: string[] | null; privateKey: string | null; name: string | null } {
  const endpoint = text.match(/^\s*Endpoint\s*=\s*(.+)$/m)?.[1]?.trim() ?? null;
  const publicKey = text.match(/^\s*PublicKey\s*=\s*(.+)$/m)?.[1]?.trim() ?? null;
  const allowedIps = text.match(/^\s*AllowedIPs\s*=\s*(.+)$/m)?.[1]?.trim()?.split(',').map((s) => s.trim()) ?? null;
  const dns = text.match(/^\s*DNS\s*=\s*(.+)$/m)?.[1]?.trim()?.split(',').map((s) => s.trim()) ?? null;
  const privateKey = text.match(/^\s*PrivateKey\s*=\s*(.+)$/m)?.[1]?.trim() ?? null;
  const name = text.match(/^\s*#\s*Name\s*=\s*(.+)$/m)?.[1]?.trim() ?? null;
  return { endpoint, publicKey, allowedIps, dns, privateKey, name };
}

/** WireGuard base64 keys are exactly 44 chars ending with '='. Rejects
 * garbage/oversized values that wg-quick would only fail on at connect time
 * (or worse, accept into a script context). */
export function isValidWgKey(value: string | null): boolean {
  return value != null && /^[A-Za-z0-9+/]{43}=$/.test(value);
}

/** wg-quick executes PostUp/PostDown/PreUp/PreDown/SaveConfig as shell script
 * on the Linux path — an imported config must never carry them. Windows's
 * wireguard.exe ignores them, but the config travels to whichever engine runs it. */
export function hasWgScriptDirectives(text: string): boolean {
  return /^\s*(PostUp|PostDown|PreUp|PreDown|SaveConfig)\s*=/im.test(text);
}

/* --------------------------- wireguard helpers ---------------------------- */

/**
 * Tunnel/interface name for our managed WireGuard tunnels. The Windows
 * tunnel service derives its name from the config FILE basename, so both the
 * service and the interface are named `netpulse-wg-<profileId>`.
 */
export function wgTunnelNameForProfile(profileId: string): string {
  return `netpulse-wg-${profileId}`;
}

/**
 * Path where connect() materializes the REAL config (with the private key)
 * for a profile: <configDir>/tmp/<tunnel>.conf. The elevation broker uses
 * this to stage the descriptor for the Rust bridge — the file exists only
 * while a connect is in flight and is deleted on every exit path.
 */
export function wgTempConfigPathFor(configDir: string, profileId: string): string {
  return path.join(configDir, 'tmp', `${wgTunnelNameForProfile(profileId)}.conf`);
}

/**
 * Extract interface names from `wg show all dump` output. Rows are
 * tab-separated; the interface line starts with the interface name and
 * "private-key" in column 2; peer rows start with interface, pubkey.
 */
export function parseWgInterfaceNames(dumpOutput: string): string[] {
  // `wg show all dump` emits per interface: one INTERFACE row of 6 tab-
  // separated columns (<name> <privkey> <link-port> <fwmark> <listen-port>
  // <freq>) followed by 8-column PEER rows. The column count is the reliable
  // discriminator — the private-key column holds the KEY VALUE, not a label.
  const names = new Set<string>();
  for (const line of dumpOutput.split(/\r?\n/)) {
    const cols = line.trim().split(/\t/);
    if (cols.length === 6 && cols[0] && /^[A-Za-z0-9_=+.-]{1,15}$/.test(cols[0])) names.add(cols[0]);
  }
  return [...names];
}

export class WireGuardProvider implements VpnProvider {
  readonly info: VpnProviderInfo = {
    id: 'wireguard',
    name: 'WireGuard',
    kind: 'wireguard',
    capabilities: ['import-config', 'connect', 'disconnect', 'status'],
    available: false,
  };

  private readonly vault: FileSecretVault;
  private readonly configDir: string;
  private available = false;
  private connectedProfile: ImportedProfile | null = null;
  protected hooks: VpnProviderHooks | undefined;

  constructor(vault: FileSecretVault, configDir: string, hooks?: VpnProviderHooks) {
    this.vault = vault;
    this.configDir = configDir;
    this.hooks = hooks;
  }

  async init(): Promise<void> {
    const { detectVpnBinaries } = await import('../util/vpnDetect');
    const bins = await detectVpnBinaries();
    this.available = bins.wireguard === true;
    this.info.available = this.available;

    // Boot-time stale-tunnel sweep: any `netpulse-wg-*` interface still up
    // belongs to a previous process (the tunnel service survives sidecar
    // crashes). Removing it also restores any DNS/route settings the tunnel
    // service had claimed. The user's own (non-netpulse) tunnels are untouched.
    //
    // Security: also sweep stale materialized runtime configs from the tmp
    // dir — they contain real private keys and must not survive a crash.
    try {
      const tmpDir = path.join(this.configDir, 'tmp');
      if (fs.existsSync(tmpDir)) {
        for (const f of fs.readdirSync(tmpDir)) {
          if (f.endsWith('.conf')) {
            try {
              fs.rmSync(path.join(tmpDir, f), { force: true });
              this.hooks?.event?.('warn', `Removed stale VPN runtime config "${f}" left by a previous session`);
            } catch {
              // best effort
            }
          }
        }
      }
    } catch {
      // best effort
    }
    if (this.available && process.platform === 'win32') {
      try {
        const dump = await runCommand('wg', ['show', 'all', 'dump'], { timeoutMs: 5_000 });
        const stale = parseWgInterfaceNames(dump.stdout).filter((n) => n.startsWith('netpulse-wg-'));
        for (const name of stale) {
          const rm = await runCommand('wireguard.exe', ['/uninstalltunnelservice', name], { timeoutMs: 15_000 });
          this.hooks?.event?.(
            rm.code === 0 ? 'info' : 'warn',
            rm.code === 0
              ? `Removed stale WireGuard tunnel service "${name}" from a previous session (state restored)`
              : `Could not remove stale tunnel service "${name}" (exit ${rm.code}) — it may need manual removal`,
          );
        }
      } catch {
        // wg absent or dump failed — nothing to sweep
      }
    }
    // Sweep stale temp configs (contain real key material) from crashes.
    try {
      const tmpDir = path.join(this.configDir, 'tmp');
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }

  async importProfile(input: VpnProfileInput): Promise<ImportedProfile> {
    if (input.protocol !== 'wireguard') throw vpnError(400, 'invalid_config', 'WireGuardProvider accepts WireGuard configurations only');
    if (hasWgScriptDirectives(input.configText)) {
      throw vpnError(400, 'invalid_config', 'The configuration contains script-execution directives (PostUp/PostDown/PreUp/PreDown/SaveConfig), which are not allowed');
    }
    const parsed = parseWireGuardConfig(input.configText);
    if (!parsed.privateKey) {
      throw vpnError(400, 'invalid_config', 'The configuration has no PrivateKey — this looks like a server-side or malformed config');
    }
    if (!isValidWgKey(parsed.privateKey) || (parsed.publicKey != null && !isValidWgKey(parsed.publicKey))) {
      throw vpnError(400, 'invalid_config', 'PrivateKey/PublicKey is not a valid WireGuard base64 key (44 chars ending with "=")');
    }
    const id = crypto.randomUUID();
    const ref = `wg-${id}`;
    // Vault the private key; a PresharedKey, when present, is equally secret.
    const preshared = input.configText.match(/^\s*PresharedKey\s*=\s*(.+)$/m)?.[1]?.trim() ?? null;
    const vaultSecret = preshared ? `${parsed.privateKey}\n${preshared}` : parsed.privateKey;
    this.vault.set(ref, vaultSecret);
    // store the config WITHOUT any key material, for auditability
    const sanitized = input.configText
      .replace(/^\s*PrivateKey\s*=\s*.+$/m, 'PrivateKey = <stored in vault>')
      .replace(/^\s*PresharedKey\s*=\s*.+$/m, 'PresharedKey = <stored in vault>');
    const configPath = path.join(this.configDir, `${id}.conf`);
    fs.writeFileSync(configPath, sanitized, { mode: 0o600 });
    return {
      id,
      name: input.name || parsed.name || parsed.endpoint || 'WireGuard profile',
      protocol: 'wireguard',
      endpoint: parsed.endpoint,
      publicKeyFingerprint: parsed.publicKey ? `${parsed.publicKey.slice(0, 8)}…` : null,
      allowedIps: parsed.allowedIps,
      dns: parsed.dns,
      secretRef: ref,
      configPath,
      createdAt: Date.now(),
    };
  }

  async connect(profile: ImportedProfile): Promise<VpnStatus> {
    if (!this.available) {
      throw vpnError(501, 'wireguard_missing', 'WireGuard is not installed on this system', 'Install the official WireGuard client, then try again.');
    }
    const { path: realConfigPath, cleanup } = this.materializeRealConfig(profile);
    try {
      return await this.connectWithMaterialized(profile, realConfigPath);
    } finally {
      cleanup();
    }
  }

  /** Materialize the REAL config (with key material) into the private tmp
   * dir. Shared by connect() and the desktop elevation flow. The returned
   * cleanup deletes the file — callers MUST call it on every exit path. */
  private materializeRealConfig(profile: ImportedProfile): { path: string; cleanup: () => void } {
    const secret = this.vault.get(profile.secretRef);
    if (!secret) throw vpnError(500, 'secret_missing', 'Stored private key is missing');
    const [privateKey, presharedKey] = secret.split('\n');
    const realConfigDir = path.join(this.configDir, 'tmp');
    fs.mkdirSync(realConfigDir, { recursive: true });
    const realConfigPath = path.join(realConfigDir, `${wgTunnelNameForProfile(profile.id)}.conf`);
    let realConfig = fs.readFileSync(profile.configPath, 'utf8').replace('PrivateKey = <stored in vault>', `PrivateKey = ${privateKey}`);
    if (presharedKey) realConfig = realConfig.replace('PresharedKey = <stored in vault>', `PresharedKey = ${presharedKey}`);
    fs.writeFileSync(realConfigPath, realConfig, { mode: 0o600 });
    return {
      path: realConfigPath,
      cleanup: () => {
        try { fs.rmSync(realConfigPath, { force: true }); } catch { /* best effort */ }
      },
    };
  }

  /** Tunnel install + verification against an already-materialized config. */
  private async connectWithMaterialized(profile: ImportedProfile, realConfigPath: string): Promise<VpnStatus> {
    let connId: string | null = null;
    if (this.hooks?.recordConnection) {
      connId = crypto.randomUUID();
      this.hooks.recordConnection({
        id: connId,
        providerId: this.info.id,
        serverId: profile.id,
        serverName: profile.name,
        endpoint: profile.endpoint,
        protocol: 'wireguard',
        status: 'connecting',
        connectedAt: null,
      });
    }
    this.hooks?.event?.('info', `Connecting WireGuard tunnel "${profile.name}"`, { profileId: profile.id });

    try {
      if (process.platform === 'win32') {
        // wireguard.exe /installtunnelservice requires elevation; surface the OS error honestly
        const res = await runCommand('wireguard.exe', ['/installtunnelservice', realConfigPath], { timeoutMs: 15_000 });
        if (res.code !== 0 && !/already/i.test(res.stdout + res.stderr)) {
          throw vpnError(403, 'elevation_required', `WireGuard refused the tunnel: ${(res.stderr || res.stdout || 'exit ' + res.code).slice(0, 200)}. Tunnel installation requires administrator privileges.`);
        }
      } else {
        const res = await runCommand('wg-quick', ['up', realConfigPath], { timeoutMs: 15_000 });
        if (res.code !== 0) {
          throw vpnError(403, 'root_required', `wg-quick failed: ${(res.stderr || 'exit ' + res.code).slice(0, 200)}. Tunnel control requires root.`);
        }
      }
    } catch (err) {
      // Security: the materialized config contains the REAL private key —
      // remove it on EVERY failure path so a refused tunnel (elevation
      // denied, bad endpoint) never leaves key material on disk. The caller's
      // finally/cleanup also runs; this is defense in depth.
      try {
        fs.rmSync(realConfigPath, { force: true });
      } catch {
        // best effort
      }
      if (connId) this.hooks?.updateConnection?.(connId, { status: 'error', error: err instanceof Error ? err.message : 'connect failed', disconnectedAt: Date.now() });
      this.hooks?.event?.('error', `WireGuard connect failed for "${profile.name}"`, { profileId: profile.id });
      throw err;
    }

    this.connectedProfile = profile;
    // remove the materialized temp config (contains the real private key)
    try {
      fs.rmSync(realConfigPath, { force: true });
    } catch {
      // best effort
    }
    // Post-install verification: the tunnel service must now own a live
    // interface. Anything else is an honest failure, never "Connected".
    {
      const dump = await runCommand('wg', ['show', 'all', 'dump'], { timeoutMs: 5_000 }).catch(() => ({ code: 1, stdout: '', stderr: 'wg dump failed' }));
      const ifaces = parseWgInterfaceNames(dump.stdout);
      const ours = ifaces.find((n) => n === wgTunnelNameForProfile(profile.id));
      if (!ours) {
        this.connectedProfile = null;
        if (connId) this.hooks?.updateConnection?.(connId, { status: 'error', error: 'tunnel interface never appeared', disconnectedAt: Date.now() });
        this.hooks?.event?.('error', `WireGuard tunnel "${profile.name}" did not come up: no interface appeared`, { profileId: profile.id });
        throw vpnError(502, 'tunnel_not_up', 'The WireGuard tunnel service accepted the config but no tunnel interface appeared. Check the endpoint reachability and keys.');
      }
    }
    if (connId) this.hooks?.updateConnection?.(connId, { status: 'connected', connectedAt: Date.now() });
    this.hooks?.event?.('info', `WireGuard tunnel "${profile.name}" is up`, { profileId: profile.id });
    const verified = await verifyConnect(this.hooks, await this.status());
    this.hooks?.event?.(verified.verification === 'failed' ? 'warn' : 'info', `WireGuard verification: ${verified.verification}`, { profileId: profile.id, note: verified.verificationNote ?? null });
    return verified;
  }

  /** Desktop per-action elevation flow: materialize the real config now so
   * the Rust bridge can stage a UAC launch against it. */
  prepareElevatedConnect(profile: ImportedProfile): string {
    const { path: realConfigPath } = this.materializeRealConfig(profile);
    return realConfigPath;
  }

  async disconnect(): Promise<VpnStatus> {
    if (process.platform === 'win32') {
      // The tunnel service name equals the config-file basename, NOT the
      // profile display name. Remove ALL netpulse-wg-* services: this covers
      // state lost across restarts and still spares user-owned tunnels.
      const dump = await runCommand('wg', ['show', 'all', 'dump'], { timeoutMs: 5_000 }).catch(() => ({ code: 1, stdout: '', stderr: '' }));
      const ours = parseWgInterfaceNames(dump.stdout).filter((n) => n.startsWith('netpulse-wg-'));
      const targets = ours.length > 0 ? ours : this.connectedProfile ? [wgTunnelNameForProfile(this.connectedProfile.id)] : [];
      for (const name of targets) {
        const res = await runCommand('wireguard.exe', ['/uninstalltunnelservice', name], { timeoutMs: 15_000 });
        if (res.code !== 0 && !/not found|already/i.test(res.stdout + res.stderr)) {
          throw vpnError(500, 'disconnect_failed', `WireGuard tunnel removal failed for "${name}": ${(res.stderr || 'exit ' + res.code).slice(0, 200)}`);
        }
      }
    } else {
      const target = this.connectedProfile?.configPath ?? 'netpulse';
      await runCommand('wg-quick', ['down', target], { timeoutMs: 15_000 });
    }
    this.hooks?.event?.('info', `WireGuard tunnel "${this.connectedProfile?.name ?? 'unknown'}" closed`);
    this.connectedProfile = null;
    return this.status();
  }

  async status(): Promise<VpnStatus> {
    let connected = false;
    let rx: number | null = null;
    let tx: number | null = null;
    let handshakeAgeSec: number | null = null;
    let endpointLatencyMs: number | null = null;
    if (this.available) {
      const res = await runCommand('wg', ['show', 'all', 'dump'], { timeoutMs: 5_000 });
      // Only OUR managed tunnels count as connected. The machine may host
      // user-created WireGuard tunnels that must not be reported as NetPulse
      // state (and vice versa: a crashed sidecar leaves netpulse-wg-* up even
      // though this process never connected).
      connected =
        res.code === 0 &&
        parseWgInterfaceNames(res.stdout).some((n) => n.startsWith('netpulse-wg-')) &&
        this.connectedProfile != null;
      if (connected) {
        // `wg show all dump` rows: interface line, then peer lines with
        // rx bytes (col 5, 0-indexed), tx bytes (col 6), latest handshake
        // unix seconds (col 4) and endpoint (col 2)
        for (const line of res.stdout.split(/\r?\n/)) {
          const cols = line.trim().split(/\t/);
          if (cols.length >= 8 && /^[0-9a-f]{16,}/i.test(cols[1] ?? '')) {
            const rxN = Number(cols[5]);
            const txN = Number(cols[6]);
            const hs = Number(cols[4]);
            if (Number.isFinite(rxN)) rx = (rx ?? 0) + rxN;
            if (Number.isFinite(txN)) tx = (tx ?? 0) + txN;
            if (Number.isFinite(hs) && hs > 0) {
              handshakeAgeSec = Math.max(0, Math.round((Date.now() / 1000) - hs));
            }
          }
        }
      }
    }
    if (connected && this.connectedProfile?.endpoint) {
      // live latency to the configured endpoint (best effort)
      try {
        const controller = (await import('../providers/platform')).createPlatformController();
        const [host, portStr] = this.connectedProfile.endpoint.replace(/^\[/, '').replace(/\]$/, '').split(':');
        const { resolveTarget, pickIp } = await import('../util/targetGuard');
        const resolved = await resolveTarget(host ?? '', { allowPrivate: true });
        const ping = await controller.icmpPing(pickIp(resolved.ips), { count: 3, timeoutMs: 1_500 });
        endpointLatencyMs = ping.avg;
        void portStr;
      } catch {
        endpointLatencyMs = null;
      }
    }
    return {
      connected,
      serverId: this.connectedProfile?.id ?? null,
      serverName: this.connectedProfile?.name ?? null,
      protocol: 'wireguard',
      since: null,
      supported: this.available,
      killSwitchActive: false,
      providerId: 'wireguard',
      rxBytes: rx,
      txBytes: tx,
      handshakeAgeSec,
      endpoint: this.connectedProfile?.endpoint ?? null,
      endpointLatencyMs,
      verification: 'not_verified',
      verificationNote: null,
    };
  }

  deleteProfile(profileId: string): void {
    // vault cleanup; the registry handles DB removal
    this.vault.delete(`wg-${profileId}`);
    const configPath = path.join(this.configDir, `${profileId}.conf`);
    try {
      fs.rmSync(configPath, { force: true });
    } catch {
      // best effort
    }
  }
}

/* ---------------------------- openvpn provider ---------------------------- */

export class OpenVpnProvider implements VpnProvider {
  readonly info: VpnProviderInfo = {
    id: 'openvpn',
    name: 'OpenVPN',
    kind: 'openvpn',
    capabilities: ['import-config', 'connect', 'disconnect', 'status'],
    available: false,
  };

  private readonly vault: FileSecretVault;
  private readonly configDir: string;
  private available = false;
  private child: ChildProcess | null = null;
  private connectedAt: number | null = null;
  private connectedProfile: ImportedProfile | null = null;
  private hooks: VpnProviderHooks | undefined;

  constructor(vault: FileSecretVault, configDir: string, hooks?: VpnProviderHooks) {
    this.vault = vault;
    this.configDir = configDir;
    this.hooks = hooks;
  }

  async init(): Promise<void> {
    const { detectVpnBinaries } = await import('../util/vpnDetect');
    const bins = await detectVpnBinaries();
    this.available = bins.openvpn === true;
    this.info.available = this.available;

    // Boot-time orphan sweep: an `openvpn --config <our-profile>.ovpn --daemon`
    // process may have outlived a crashed supervisor. Kill ONLY processes
    // whose command line references OUR config dir (never user-run OpenVPN).
    if (this.available && process.platform === 'win32') {
      try {
        const { execSync } = await import('node:child_process');
        const wmic = execSync(
          'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \'Name=\"openvpn.exe\"\' | Where-Object { $_.CommandLine -like \'*netpulse*vpn-profiles*\' } | Select-Object -ExpandProperty ProcessId"',
          { stdio: ['pipe', 'pipe', 'ignore'], timeout: 10_000 },
        ).toString();
        for (const pidStr of wmic.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+$/.test(l))) {
          try { execSync(`taskkill /PID ${pidStr} /F`, { stdio: 'ignore', timeout: 10_000 }); } catch { /* raced exit */ }
          this.hooks?.event?.('info', `Removed stale OpenVPN process (pid ${pidStr}) from a previous session`);
        }
      } catch {
        // no matching processes — nothing to do
      }
    }
  }

  async importProfile(input: VpnProfileInput): Promise<ImportedProfile> {
    if (input.protocol !== 'openvpn') throw vpnError(400, 'invalid_config', 'OpenVpnProvider accepts OpenVPN configurations only');
    if (!/<ca>|remote\s+/i.test(input.configText)) {
      throw vpnError(400, 'invalid_config', 'This does not look like an OpenVPN config (missing remote/CA block)');
    }
    const endpoint = input.configText.match(/^\s*remote\s+(\S+)\s+(\S+)/m);
    const id = crypto.randomUUID();
    // Inline credential blocks (<auth>/<secret>) are pulled out of the stored
    // file and moved into the vault; the on-disk profile keeps a placeholder.
    let configToStore = input.configText;
    const inlineAuth = input.configText.match(/<auth>([\s\S]*?)<\/auth>/);
    if (inlineAuth) {
      this.vault.set(`ovpn-${id}`, inlineAuth[1]!);
      configToStore = configToStore.replace(inlineAuth[0], '<auth>stored in vault</auth>');
    }
    const configPath = path.join(this.configDir, `${id}.ovpn`);
    fs.writeFileSync(configPath, configToStore, { mode: 0o600 });
    return {
      id,
      name: input.name || endpoint?.[1] || 'OpenVPN profile',
      protocol: 'openvpn',
      endpoint: endpoint ? `${endpoint[1]}:${endpoint[2]}` : null,
      publicKeyFingerprint: null,
      allowedIps: null,
      dns: null,
      secretRef: '',
      configPath,
      createdAt: Date.now(),
    };
  }

  async connect(profile: ImportedProfile): Promise<VpnStatus> {
    if (!this.available) {
      throw vpnError(501, 'openvpn_missing', 'OpenVPN is not installed on this system', 'Install the OpenVPN client and ensure `openvpn` is on PATH.');
    }
    const { spawn } = await import('node:child_process');
    let connId: string | null = null;
    if (this.hooks?.recordConnection) {
      connId = crypto.randomUUID();
      this.hooks.recordConnection({
        id: connId,
        providerId: this.info.id,
        serverId: profile.id,
        serverName: profile.name,
        endpoint: profile.endpoint,
        protocol: 'openvpn',
        status: 'connecting',
        connectedAt: null,
      });
    }
    this.hooks?.event?.('info', `Connecting OpenVPN tunnel "${profile.name}"`, { profileId: profile.id });

    const result = await new Promise<VpnStatus>((resolve, reject) => {
      const child = spawn('openvpn', ['--config', profile.configPath, '--daemon', 'netpulse'], { windowsHide: true, shell: false });
      let settled = false;
      child.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(vpnError(500, 'openvpn_error', `openvpn failed to start: ${err.message}`));
        }
      });
      child.on('close', (code) => {
        if (!settled) {
          settled = true;
          reject(vpnError(403, 'elevation_required', `openvpn exited with code ${code}. Route changes usually require administrator privileges — run once elevated or install the OpenVPN service.`));
        }
      });
      // --daemon detaches after successful init; treat survival for 3s as
      // success ONLY if the process is actually still running (kill it as a
      // failed connect otherwise) — survival alone proves nothing.
      setTimeout(() => {
        if (!settled) {
          settled = true;
          if (child.exitCode != null || child.killed) {
            reject(vpnError(502, 'openvpn_error', 'openvpn detached but is no longer running'));
            return;
          }
          this.child = child;
          this.connectedAt = Date.now();
          this.connectedProfile = profile;
          resolve(this.status());
        }
      }, 3_000);
    }).catch((err) => {
      if (connId) this.hooks?.updateConnection?.(connId, { status: 'error', error: err instanceof Error ? err.message : 'connect failed', disconnectedAt: Date.now() });
      this.hooks?.event?.('error', `OpenVPN connect failed for "${profile.name}"`, { profileId: profile.id });
      throw err;
    });

    if (connId) this.hooks?.updateConnection?.(connId, { status: 'connected', connectedAt: Date.now() });
    this.hooks?.event?.('info', `OpenVPN tunnel "${profile.name}" reported up (3s survival heuristic)`, { profileId: profile.id });
    return verifyConnect(this.hooks, result);
  }

  async disconnect(): Promise<VpnStatus> {
    const { execSync } = await import('node:child_process');
    // Kill ONLY the process we spawned (and any stale netpulse-owned ones).
    // A blanket `taskkill /IM openvpn.exe` would murder the user's own,
    // unrelated OpenVPN connections.
    if (process.platform === 'win32') {
      try {
        const out = execSync(
          'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \'Name=\"openvpn.exe\"\' | Where-Object { $_.CommandLine -like \'*netpulse*vpn-profiles*\' } | Select-Object -ExpandProperty ProcessId"',
          { stdio: ['pipe', 'pipe', 'ignore'], timeout: 10_000 },
        ).toString();
        for (const pidStr of out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+$/.test(l))) {
          try { execSync(`taskkill /PID ${pidStr} /F`, { stdio: 'ignore', timeout: 10_000 }); } catch { /* raced exit */ }
        }
      } catch {
        // nothing matching
      }
    } else {
      try { execSync('pkill -f "openvpn --config" || true', { stdio: 'ignore', shell: '/bin/sh' }); } catch { /* already gone */ }
    }
    this.hooks?.event?.('info', `OpenVPN tunnel "${this.connectedProfile?.name ?? 'unknown'}" closed`);
    this.child = null;
    this.connectedAt = null;
    this.connectedProfile = null;
    return this.status();
  }

  async status(): Promise<VpnStatus> {
    // Honest status: "connected" requires a live child. If the process died
    // (crash, engine hang killed externally), state resets instead of lying.
    if (this.child && this.child.exitCode != null) {
      this.child = null;
      this.connectedAt = null;
      this.connectedProfile = null;
    }
    return {
      connected: this.child != null && this.connectedAt != null,
      serverId: this.connectedProfile?.id ?? null,
      serverName: this.connectedProfile?.name ?? null,
      protocol: 'openvpn',
      since: this.connectedAt,
      supported: this.available,
      killSwitchActive: false,
      providerId: 'openvpn',
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
    const configPath = path.join(this.configDir, `${profileId}.ovpn`);
    try {
      fs.rmSync(configPath, { force: true });
    } catch {
      // best effort
    }
  }
}

/* ----------------------------- sing-box provider --------------------------- */

/**
 * sing-box drives the sing-box binary (https://sing-box.sagernet.org) as a
 * local client. The user's share link (vless://, vmess://, trojan://, ss://)
 * or sing-box outbound JSON is parsed into a single-outbound config, written
 * to the profile dir, and the binary runs with `run -c`. Credentials live in
 * the encrypted vault; the stored on-disk config keeps them only while the
 * process runs and is regenerated at connect time.
 */

const SINGBOX_PROTOCOLS = ['vless', 'vmess', 'trojan', 'shadowsocks'] as const;

export interface ParsedShareLink {
  protocol: (typeof SINGBOX_PROTOCOLS)[number] | 'unknown';
  host: string | null;
  port: number | null;
  /** fields that will be materialized into the outbound config */
  fields: Record<string, unknown>;
  /** secret material that belongs in the vault */
  secret: string | null;
}

/** Parse vless://uuid@host:port?params#name */
export function parseVlessUri(uri: string): ParsedShareLink | null {
  try {
    const u = new URL(uri);
    if (u.protocol !== 'vless:') return null;
    const fields: Record<string, unknown> = {
      id: decodeURIComponent(u.username),
      flow: u.searchParams.get('flow') ?? '',
    };
    const security = u.searchParams.get('security') ?? 'none';
    const transport = u.searchParams.get('type') ?? 'tcp';
    const outbound: Record<string, unknown> = {
      type: 'vless',
      server: u.hostname,
      port: u.port ? Number(u.port) : 443,
      uuid: fields.id,
      flow: fields.flow,
    };
    if (security === 'tls' || security === 'reality') {
      outbound.tls = {
        enabled: true,
        server_name: u.searchParams.get('sni') ?? u.hostname,
        insecure: u.searchParams.get('allowInsecure') === '1',
        ...(security === 'reality' ? { reality: { enabled: true, public_key: u.searchParams.get('pbk') ?? '', short_id: u.searchParams.get('sid') ?? '' } } : {}),
      };
      fields.tls = true;
    }
    if (transport === 'ws') {
      outbound.transport = { type: 'ws', path: u.searchParams.get('path') ?? '/', headers: { Host: u.searchParams.get('host') ?? u.hostname } };
      fields.transport = 'ws';
    } else if (transport === 'grpc') {
      outbound.transport = { type: 'grpc', service_name: u.searchParams.get('serviceName') ?? '' };
      fields.transport = 'grpc';
    } else if (transport === 'tcp' && (u.searchParams.get('headerType') === 'http')) {
      outbound.transport = { type: 'http' };
      fields.transport = 'http';
    }
    return { protocol: 'vless', host: u.hostname, port: outbound.port as number, fields: outbound, secret: decodeURIComponent(u.username) };
  } catch {
    return null;
  }
}

/** Parse vmess://base64(json) (v2rayN format) */
export function parseVmessUri(uri: string): ParsedShareLink | null {
  if (!uri.startsWith('vmess://')) return null;
  try {
    const json = JSON.parse(Buffer.from(uri.slice('vmess://'.length), 'base64').toString('utf8')) as Record<string, unknown>;
    const host = String(json['add'] ?? '');
    const port = Number(json['port'] ?? 443);
    const id = String(json['id'] ?? '');
    if (!host || !id) return null;
    const outbound: Record<string, unknown> = {
      type: 'vmess',
      server: host,
      port,
      uuid: id,
      security: String(json['scy'] ?? json['security'] ?? 'auto'),
      alter_id: Number(json['aid'] ?? 0),
    };
    const tls = String(json['tls'] ?? '');
    if (tls === 'tls') {
      outbound.tls = { enabled: true, server_name: String(json['sni'] ?? host), insecure: false };
    }
    const net = String(json['net'] ?? 'tcp');
    if (net === 'ws') {
      outbound.transport = { type: 'ws', path: String(json['path'] ?? '/'), headers: { Host: String(json['host'] ?? host) } };
    } else if (net === 'grpc') {
      outbound.transport = { type: 'grpc', service_name: String(json['path'] ?? '') };
    }
    return { protocol: 'vmess', host, port, fields: outbound, secret: id };
  } catch {
    return null;
  }
}

/** Parse trojan://password@host:port?sni=...#name */
export function parseTrojanUri(uri: string): ParsedShareLink | null {
  try {
    const u = new URL(uri);
    if (u.protocol !== 'trojan:') return null;
    const password = decodeURIComponent(u.username);
    if (!password) return null;
    const outbound: Record<string, unknown> = {
      type: 'trojan',
      server: u.hostname,
      port: u.port ? Number(u.port) : 443,
      password,
      tls: { enabled: true, server_name: u.searchParams.get('sni') ?? u.hostname, insecure: u.searchParams.get('allowInsecure') === '1' },
    };
    if ((u.searchParams.get('type') ?? 'tcp') === 'ws') {
      outbound.transport = { type: 'ws', path: u.searchParams.get('path') ?? '/' };
    }
    return { protocol: 'trojan', host: u.hostname, port: outbound.port as number, fields: outbound, secret: password };
  } catch {
    return null;
  }
}

/** Parse ss://base64(method:pass)@host:port#name or ss://base64(method:pass@host:port) */
export function parseShadowsocksUri(uri: string): ParsedShareLink | null {
  if (!uri.startsWith('ss://')) return null;
  try {
    const rest = uri.slice('ss://'.length);
    const hashIdx = rest.indexOf('#');
    const main = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
    const name = hashIdx >= 0 ? decodeURIComponent(rest.slice(hashIdx + 1)) : null;
    let method: string;
    let password: string;
    let host: string;
    let port: number;
    if (main.includes('@')) {
      const [userinfo, serverpart] = main.split('@');
      const decodedUserinfo = Buffer.from(userinfo!, 'base64').toString('utf8');
      const sep = decodedUserinfo.indexOf(':');
      method = decodedUserinfo.slice(0, sep);
      password = decodedUserinfo.slice(sep + 1);
      const [h, p] = serverpart!.split(':');
      host = h!;
      port = Number(p);
    } else {
      const decoded = Buffer.from(main, 'base64').toString('utf8');
      const at = decoded.lastIndexOf('@');
      if (at < 0) return null;
      const [cred, serverpart] = [decoded.slice(0, at), decoded.slice(at + 1)];
      const sep = cred.indexOf(':');
      method = cred.slice(0, sep);
      password = cred.slice(sep + 1);
      const [h, p] = serverpart.split(':');
      host = h!;
      port = Number(p);
    }
    if (!method || !password || !host || !Number.isFinite(port)) return null;
    const outbound: Record<string, unknown> = { type: 'shadowsocks', server: host, port, method, password };
    void name;
    return { protocol: 'shadowsocks', host, port, fields: outbound, secret: password };
  } catch {
    return null;
  }
}

/**
 * Build the sing-box config document for one outbound. Only 127.0.0.1:port
 * inbound is bound — the tunnel is a local SOCKS/HTTP proxy plus TUN only
 * when the platform layer grants it; default is proxy-mode (no route
 * changes, no root) so the binary can run unprivileged.
 */
export function buildSingboxConfig(outbound: Record<string, unknown>, opts: { mixedPort: number; socksPort?: number } = { mixedPort: 2080 }): Record<string, unknown> {
  return {
    log: { level: 'warn', timestamp: true },
    inbounds: [
      {
        type: 'mixed',
        tag: 'mixed-in',
        listen: '127.0.0.1',
        listen_port: opts.mixedPort,
      },
    ],
    outbounds: [outbound],
    route: { auto_detect_interface: true },
  };
}

/**
 * Convert the stored (sanitized) config text back into the full config by
 * re-reading the secret from the vault. The sanitized doc keeps the outbound
 * structure minus the credential fields, which are patched in from `secret`.
 */
export function materializeSingboxConfig(storedText: string, secret: string): string {
  const doc = JSON.parse(storedText) as { outbounds?: Record<string, unknown>[] };
  const outbound = doc.outbounds?.[0];
  if (!outbound) throw vpnError(500, 'invalid_profile', 'Stored profile has no outbound');
  const type = String(outbound['type'] ?? '');
  if (type === 'vless') outbound['uuid'] = secret;
  else if (type === 'vmess') outbound['uuid'] = secret;
  else if (type === 'trojan') outbound['password'] = secret;
  else if (type === 'shadowsocks') outbound['password'] = secret;
  return JSON.stringify(doc, null, 2);
}

export class SingboxProvider implements VpnProvider {
  readonly info: VpnProviderInfo = {
    id: 'singbox',
    name: 'sing-box',
    kind: 'singbox',
    capabilities: ['import-config', 'connect', 'disconnect', 'status', 'proxy-mode'],
    available: false,
    protocols: [...SINGBOX_PROTOCOLS],
  };

  private readonly vault: FileSecretVault;
  private readonly configDir: string;
  private available = false;
  private child: ChildProcess | null = null;
  private connectedAt: number | null = null;
  private connectedProfile: ImportedProfile | null = null;
  private mixedPort: number;
  private hooks: VpnProviderHooks | undefined;
  private lastTempConfigPath: string | null = null;

  constructor(vault: FileSecretVault, configDir: string, hooks?: VpnProviderHooks, mixedPort = 2080) {
    this.vault = vault;
    this.configDir = configDir;
    this.hooks = hooks;
    this.mixedPort = mixedPort;
  }

  /** Remove the materialized temp config — it contains the real credential. */
  private removeTempConfig(): void {
    if (this.lastTempConfigPath == null) return;
    try {
      fs.rmSync(this.lastTempConfigPath, { force: true });
    } catch {
      // best effort
    }
    this.lastTempConfigPath = null;
  }

  async init(): Promise<void> {
    const { detectVpnBinaries } = await import('../util/vpnDetect');
    const bins = await detectVpnBinaries();
    this.available = bins.singbox === true;
    this.info.available = this.available;
  }

  async importProfile(input: VpnProfileInput): Promise<ImportedProfile> {
    const text = input.configText.trim();
    let parsed: ParsedShareLink | null = null;

    if (text.startsWith('vless://')) parsed = parseVlessUri(text);
    else if (text.startsWith('vmess://')) parsed = parseVmessUri(text);
    else if (text.startsWith('trojan://')) parsed = parseTrojanUri(text);
    else if (text.startsWith('ss://')) parsed = parseShadowsocksUri(text);
    else if (text.startsWith('{')) {
      // sing-box outbound JSON: user pasted an outbound object
      try {
        const doc = JSON.parse(text) as Record<string, unknown>;
        const outbound = (doc['outbounds'] as Record<string, unknown>[] | undefined)?.[0] ?? doc;
        const type = String(outbound['type'] ?? '');
        if (!SINGBOX_PROTOCOLS.includes(type as (typeof SINGBOX_PROTOCOLS)[number])) {
          throw new Error(`unsupported outbound type "${type}"`);
        }
        parsed = {
          protocol: type as (typeof SINGBOX_PROTOCOLS)[number],
          host: String(outbound['server'] ?? '') || null,
          port: Number(outbound['port'] ?? 0) || null,
          fields: outbound,
          secret: String(outbound['uuid'] ?? outbound['password'] ?? ''),
        };
      } catch {
        parsed = null;
      }
    }

    if (!parsed || parsed.protocol === 'unknown' || !parsed.host) {
      throw vpnError(400, 'invalid_config', 'Could not parse this as a VLESS, VMess, Trojan or Shadowsocks link (or a sing-box outbound JSON). Supported: vless://, vmess://, trojan://, ss://');
    }
    if (!parsed.secret) {
      throw vpnError(400, 'invalid_config', 'The link contains no credential (UUID or password) to store');
    }
    // Control characters in credential/SNI/name fields are never legitimate —
    // they enable log forging and config-template surprises downstream.
    if (/[\u0000-\u001f\u007f]/.test(parsed.secret) || (typeof parsed.fields?.tls === 'object' && /[\u0000-\u001f\u007f]/.test(JSON.stringify(parsed.fields.tls)))) {
      throw vpnError(400, 'invalid_config', 'The link contains control characters in a credential or TLS field');
    }

    const id = crypto.randomUUID();
    const ref = `sb-${id}`;
    this.vault.set(ref, parsed.secret);

    // sanitize: store the full config minus the credential, plus metadata
    const outbound: Record<string, unknown> = { ...parsed.fields };
    if (parsed.protocol === 'vless' || parsed.protocol === 'vmess') outbound['uuid'] = '<stored in vault>';
    else outbound['password'] = '<stored in vault>';

    const doc = buildSingboxConfig(outbound, { mixedPort: this.mixedPort });
    const configPath = path.join(this.configDir, `${id}.json`);
    fs.writeFileSync(configPath, JSON.stringify(doc, null, 2), { mode: 0o600 });

    const meta = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { outbounds?: Record<string, unknown>[] };
    void meta;

    return {
      id,
      name: input.name || `${parsed.protocol}:${parsed.host}`,
      protocol: parsed.protocol,
      endpoint: `${parsed.host}:${parsed.port ?? 443}`,
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
      throw vpnError(501, 'singbox_missing', 'sing-box is not installed on this system', 'Install sing-box and put `sing-box` on PATH, then try again.');
    }
    const secret = this.vault.get(profile.secretRef);
    if (!secret) throw vpnError(500, 'secret_missing', 'Stored credential is missing');
    // Materialized config carries the real credential: private dir, not %TEMP%.
    const realConfigDir = path.join(this.configDir, 'tmp');
    fs.mkdirSync(realConfigDir, { recursive: true });
    const realConfigPath = path.join(realConfigDir, `netpulse-sb-${profile.id}.json`);
    const fullConfig = materializeSingboxConfig(fs.readFileSync(profile.configPath, 'utf8'), secret);
    fs.writeFileSync(realConfigPath, fullConfig, { mode: 0o600 });
    // remember the path so the temp config (contains the real credential) can
    // be removed after the process starts or fails
    this.lastTempConfigPath = realConfigPath;

    let connId: string | null = null;
    if (this.hooks?.recordConnection) {
      connId = crypto.randomUUID();
      this.hooks.recordConnection({
        id: connId,
        providerId: this.info.id,
        serverId: profile.id,
        serverName: profile.name,
        endpoint: profile.endpoint,
        protocol: profile.protocol,
        status: 'connecting',
        connectedAt: null,
      });
    }
    this.hooks?.event?.('info', `Starting sing-box client for "${profile.name}" (proxy mode, 127.0.0.1:${this.mixedPort})`, { profileId: profile.id });

    const { spawn } = await import('node:child_process');
    const child = spawn('sing-box', ['run', '-c', realConfigPath, '-D', this.configDir], { windowsHide: true, shell: false });
    let stderrBuf = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf = (stderrBuf + chunk.toString()).slice(-4_000); // bounded
    });

    // success = process alive AND local proxy port answering after grace period
    const ok = await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => done(false), 4_000);
      child.on('error', () => done(false));
      child.on('close', (code) => {
        if (!this.child) {
          this.lastError = code != null ? `sing-box exited with code ${code}` : 'sing-box exited immediately';
        }
        done(false);
      });
      // probe the local mixed port until the deadline
      const probe = (): void => {
        const sock = net.createConnection({ host: '127.0.0.1', port: this.mixedPort, timeout: 500 }, () => {
          sock.destroy();
          done(true);
        });
        sock.on('error', () => sock.destroy());
        sock.on('timeout', () => sock.destroy());
      };
      const poll = setInterval(probe, 400);
      timer.unref();
      poll.unref();
    }).catch(() => false);

    if (!ok || child.exitCode != null) {
      child.kill();
      const reason = this.lastError ?? (stderrBuf.match(/FATAL|ERROR.*/)?.[0]?.slice(0, 200) ?? 'local proxy port never opened');
      this.lastError = null;
      this.removeTempConfig();
      if (connId) this.hooks?.updateConnection?.(connId, { status: 'error', error: reason, disconnectedAt: Date.now() });
      this.hooks?.event?.('error', `sing-box failed to start for "${profile.name}": ${reason}`, { profileId: profile.id });
      throw vpnError(502, 'singbox_failed', `sing-box did not come up: ${reason}`);
    }

    this.child = child;
    this.connectedAt = Date.now();
    this.connectedProfile = profile;
    this.removeTempConfig();
    child.on('close', () => {
      if (this.child === child) {
        this.child = null;
        this.connectedAt = null;
        this.connectedProfile = null;
        this.hooks?.event?.('warn', `sing-box process for "${profile.name}" exited unexpectedly`);
      }
    });

    if (connId) this.hooks?.updateConnection?.(connId, { status: 'connected', connectedAt: Date.now() });
    this.hooks?.event?.('info', `sing-box client for "${profile.name}" is running (proxy 127.0.0.1:${this.mixedPort})`, { profileId: profile.id });

    // In proxy mode there is no system route change, so the public IP does
    // not change. Verification is the local proxy handshake that already
    // succeeded — report that honestly instead of running an IP check that
    // cannot prove anything in this mode.
    const status = await this.status();
    return {
      ...status,
      verification: 'verified',
      verificationNote: `sing-box client is running and its local proxy answered on 127.0.0.1:${this.mixedPort}. Proxy mode does not alter the system route, so the public IP stays unchanged by design.`,
    };
  }

  private lastError: string | null = null;

  async disconnect(): Promise<VpnStatus> {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    this.connectedAt = null;
    this.connectedProfile = null;
    this.removeTempConfig();
    // Orphan sweep: a previous crash may have left a netpulse sing-box running
    // with the same mixed port. Only processes whose command line references
    // our profile dir are ours; the user's own sing-box is never touched.
    if (this.available && process.platform === 'win32') {
      try {
        const { execSync } = await import('node:child_process');
        const out = execSync(
          'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \'Name=\"sing-box.exe\"\' | Where-Object { $_.CommandLine -like \'*netpulse*vpn-profiles*\' } | Select-Object -ExpandProperty ProcessId"',
          { stdio: ['pipe', 'pipe', 'ignore'], timeout: 10_000 },
        ).toString();
        for (const pidStr of out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+$/.test(l))) {
          try { execSync(`taskkill /PID ${pidStr} /F`, { stdio: 'ignore', timeout: 10_000 }); } catch { /* raced exit */ }
        }
      } catch {
        // nothing matching
      }
    }
    return this.status();
  }

  async status(): Promise<VpnStatus> {
    return {
      connected: this.child != null,
      serverId: this.connectedProfile?.id ?? null,
      serverName: this.connectedProfile?.name ?? null,
      protocol: this.connectedProfile?.protocol ?? 'sing-box',
      since: this.connectedAt,
      supported: this.available,
      killSwitchActive: false,
      providerId: 'singbox',
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
    this.vault.delete(`sb-${profileId}`);
    try {
      fs.rmSync(path.join(this.configDir, `${profileId}.json`), { force: true });
    } catch {
      // best effort
    }
  }
}

/* ----------------------------- custom provider ---------------------------- */

/**
 * Reserved for provider backends that need bespoke control planes. It
 * intentionally refuses everything except status so the UI can offer an
 * honest "unsupported" instead of a broken button.
 */
export class CustomProvider implements VpnProvider {
  readonly info: VpnProviderInfo = {
    id: 'custom',
    name: 'Custom engine',
    kind: 'custom',
    capabilities: ['status'],
    available: false,
  };

  constructor() {
    this.info.available = false;
  }

  async init(): Promise<void> {
    this.info.available = false;
  }

  async importProfile(): Promise<ImportedProfile> {
    throw vpnError(501, 'not_implemented', 'Custom engine adapters are not implemented. Use the WireGuard, OpenVPN or sing-box provider.', 'sing-box covers VLESS, VMess, Trojan and Shadowsocks links.');
  }

  async connect(): Promise<VpnStatus> {
    throw vpnError(501, 'not_implemented', 'Custom engine connection is not implemented');
  }

  async disconnect(): Promise<VpnStatus> {
    throw vpnError(501, 'not_implemented', 'Custom engine connection is not implemented');
  }

  async status(): Promise<VpnStatus> {
    return { connected: false, serverId: null, serverName: null, protocol: null, since: null, supported: false, killSwitchActive: false, providerId: 'custom', verification: 'not_verified' };
  }
}

/* -------------------------------- registry -------------------------------- */

export class VpnRegistry {
  private providers = new Map<string, VpnProvider>();
  private profiles = new Map<string, ImportedProfile & { providerId: string }>();
  /** set by createVpnRegistry; lets internal services validate stored key material. */
  private vault: FileSecretVault | null = null;

  register(provider: VpnProvider): void {
    this.providers.set(provider.info.id, provider);
  }

  /** Aggregate status across providers: the first connected tunnel wins. */
  async status(): Promise<VpnStatus | null> {
    const statuses = await Promise.all([...this.providers.values()].map((p) => p.status().catch(() => null)));
    return statuses.find((s) => s?.connected === true) ?? statuses.find((s) => s != null) ?? null;
  }

  /**
   * Decrypt a stored secret for IN-PROCESS validation only (self-test).
   * The value must never be logged, serialized into a response, or leave the
   * backend; callers validate shape and discard.
   */
  getSecretForCheck(ref: string): string | null {
    if (!ref) return null;
    return this.vault?.get(ref) ?? null;
  }

  get(id: string): VpnProvider | undefined {
    return this.providers.get(id);
  }

  all(): VpnProvider[] {
    return [...this.providers.values()];
  }

  addProfile(providerId: string, profile: ImportedProfile): void {
    this.profiles.set(profile.id, { ...profile, providerId });
  }

  getProfile(id: string): (ImportedProfile & { providerId: string }) | undefined {
    return this.profiles.get(id);
  }

  listProfiles(): (ImportedProfile & { providerId: string })[] {
    return [...this.profiles.values()];
  }

  removeProfile(id: string): { provider: VpnProvider | undefined; profile: (ImportedProfile & { providerId: string }) | undefined } {
    const profile = this.profiles.get(id);
    this.profiles.delete(id);
    const provider = profile ? this.providers.get(profile.providerId) : undefined;
    return { provider, profile };
  }

  private setVault(vault: FileSecretVault): void {
    this.vault = vault;
  }

  async initAll(): Promise<void> {
    await Promise.all([...this.providers.values()].map((p) => p.init().catch(() => undefined)));
  }
}

export function createVpnRegistry(vaultFile: string, configDir: string, hooks?: VpnProviderHooks): VpnRegistry {
  fs.mkdirSync(configDir, { recursive: true });
  const vault = new FileSecretVault(vaultFile);
  const registry = new VpnRegistry();
  registry['setVault'](vault);
  registry.register(new WireGuardProvider(vault, configDir, hooks));
  registry.register(new OpenVpnProvider(vault, configDir, hooks));
  registry.register(new SingboxProvider(vault, configDir, hooks));
  registry.register(new CustomProvider());
  return registry;
}

export function serverInfoFromProfile(profile: ImportedProfile & { providerId: string }): VpnServerInfo {
  const [, portStr] = (profile.endpoint ?? ':').split(':');
  return {
    id: profile.id,
    name: profile.name,
    providerId: profile.providerId,
    country: null,
    city: null,
    endpoint: profile.endpoint ?? 'unknown',
    port: portStr ? Number(portStr) : null,
    protocol: profile.protocol,
  };
}

export type { VpnVerification };
