/**
 * Local proxy cores for testing public V2Ray/Xray-flavored nodes.
 *
 * Two engines, one interface:
 *   - sing-box (already supported) — universal protocol coverage
 *   - xray (NEW) — the reference V2Ray core; best Reality/XTLS fidelity
 *
 * Flow per probe: generate a config with the node as outbound + an inbound on
 * an EPHEMERAL loopback port → spawn the core (windowsHide, bounded lifecycle)
 * → CONNECT through it → measure → always kill + delete temp config.
 *
 * If a core binary is not installed the probe reports `engine_unavailable`
 * instead of a fake success.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { redactSecrets } from '../util/redact';

import { bypassIsEmpty, type BypassRuleSet, type ParsedNodeConfig, type ProxyEngineId } from '@netpulse/shared';

/* ============================ config generation ============================ */

/** Outbound tag of the injected dial-through outbound in a chained core. */
const CHAIN_DIAL_TAG = 'chain-upstream';

/**
 * Temp-dir prefixes this app creates for core binaries. Every dir we make is
 * prefixed, so housekeeping can recognise ours without touching anything else
 * in the shared temp directory.
 */
const CORE_TMP_PREFIXES = [
  'netpulse-core-',
  'netpulse-probe-',
  'netpulse-aether-',
  'netpulse-xray-',
  'netpulse-sing-box-',
  'netpulse-v2ray-',
] as const;

/**
 * Remove core config dirs abandoned by a previous run.
 *
 * The graceful path deletes its dir when a core stops, but a crashed or
 * force-killed process cannot — and those dirs hold `core.json`, which embeds
 * the node's credentials (uuid/password), so leftovers are both litter and a
 * secrets-hygiene problem.
 *
 * Only dirs older than `maxAgeMs` are touched. A core's config is written once
 * at spawn and never rewritten, so age alone cannot distinguish a finished
 * probe from a long-lived tunnel core; the 24h default is far beyond any core
 * this app keeps running, which makes sweeping safe while still bounded.
 */
export function sweepStaleCoreDirs(maxAgeMs = 24 * 60 * 60 * 1000): { removed: number; failed: number } {
  const dir = os.tmpdir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { removed: 0, failed: 0 };
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  let failed = 0;
  for (const name of entries) {
    if (!CORE_TMP_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const target = path.join(dir, name);
    try {
      const stat = fs.statSync(target);
      if (!stat.isDirectory() || stat.mtimeMs > cutoff) continue;
      fs.rmSync(target, { recursive: true, force: true });
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}

/**
 * NESTED MODE guard — why an engine must not be the DIAL-THROUGH (exit) hop.
 *
 * Measured against the real binaries: v2ray-core 5.53 silently IGNORES
 * `streamSettings.sockopt.dialerProxy`, so a v2ray exit hop relays directly to
 * the node while the UI claims two hops. It is refused rather than trusted.
 * Only the exit hop is affected: any engine can serve as the entry hop, since
 * an entry only has to expose an HTTP-CONNECT inbound.
 */
export function chainExitUnsupported(engine: ProxyEngineId, protocol: string): string | null {
  if (engine === 'v2ray') {
    return 'v2ray-core ignores streamSettings.sockopt.dialerProxy, so it cannot chain to another core (use xray or sing-box)';
  }
  return chainExitProtocolUnsupported(protocol);
}

/**
 * The engine-independent half of the same rule: a UDP protocol can never be
 * the exit hop, whichever core runs it.
 */
export function chainExitProtocolUnsupported(protocol: string): string | null {
  if (protocol === 'hysteria2' || protocol === 'tuic') {
    return `${protocol} is UDP-based and cannot be dialled through a local TCP proxy, so it cannot be the exit hop of a chain`;
  }
  return null;
}

/**
 * Legacy SS ciphers none of the cores accepts for AEAD-style configs — running
 * them produces cryptic core exit codes instead of an honest error.
 */
const LEGACY_SS_CIPHERS = new Set(['rc4', 'rc4-md5', 'des-cfb', 'table', 'bf-cfb', 'chacha20', 'chacha20-ietf']);

/** True when a node's protocol/transport combination is engine-testable. */
export function configIsTestable(config: ParsedNodeConfig): { ok: true } | { ok: false; error: string } {
  if (config.protocol === 'shadowsocksr') {
    return { ok: false, error: 'shadowsocksr is not supported by xray, sing-box or v2ray (use a shadowsocks/vless/trojan node)' };
  }
  if (config.protocol === 'shadowsocks' && config.encryption && LEGACY_SS_CIPHERS.has(config.encryption.toLowerCase())) {
    return { ok: false, error: `shadowsocks cipher "${config.encryption}" is legacy and unsupported by xray/sing-box/v2ray (use an AEAD cipher, e.g. aes-256-gcm or chacha20-ietf-poly1305)` };
  }
  return { ok: true };
}

/**
 * V2Ray-family outbound for a node (Xray-core AND v2ray-core share the
 * outbound schema; buildXrayConfig serves both — `buildV2rayConfig` is an
 * alias so intent is explicit at call sites).
 *
 * Reality and the xhttp transport are Xray-only extensions: when the caller
 * routes a Reality node to v2ray-core, the public key has nowhere to go, so
 * engineSupports() refuses that combination upstream — this builder still
 * emits plain TLS for it rather than a silently wrong config.
 */
export function buildXrayOutbound(config: ParsedNodeConfig, secret: string | null): Record<string, unknown> {
  const proto = config.protocol;
  const isReality = config.security === 'reality' || Boolean(config.realityPublicKey);

  const network = config.transport === 'none' || config.transport === 'unknown' || config.transport === 'quic' || config.transport === 'udp' ? 'tcp' : config.transport;
  const streamSettings: Record<string, unknown> = {
    network,
    security: config.security === 'reality' ? 'reality' : config.security === 'tls' ? 'tls' : 'none',
  };

  if (config.security === 'tls' && !isReality) {
    const tlsSettings: Record<string, unknown> = {
      serverName: config.sni ?? config.host,
      allowInsecure: config.allowInsecure === true,
      fingerprint: config.fingerprint ?? 'chrome',
    };
    if (config.alpn && config.alpn.length > 0) tlsSettings['alpn'] = config.alpn;
    streamSettings['tlsSettings'] = tlsSettings;
  }
  if (isReality) {
    streamSettings['realitySettings'] = {
      serverName: config.sni ?? config.realityServerName ?? config.host,
      fingerprint: config.fingerprint ?? 'chrome',
      publicKey: config.realityPublicKey ?? '',
      shortId: config.realityShortId ?? '',
      spiderX: '/',
    };
  }

  if (config.transport === 'ws') {
    streamSettings['wsSettings'] = {
      path: config.path ?? '/',
      ...(config.hostHeader ? { headers: { Host: config.hostHeader } } : {}),
    };
  } else if (config.transport === 'grpc') {
    streamSettings['grpcSettings'] = { serviceName: config.serviceName ?? '' };
  } else if (config.transport === 'http') {
    streamSettings['httpSettings'] = {
      path: config.path ?? '/',
      ...(config.hostHeader ? { host: [config.hostHeader] } : {}),
    };
  } else if (config.transport === 'httpupgrade') {
    streamSettings['httpupgradeSettings'] = {
      path: config.path ?? '/',
      ...(config.hostHeader ? { host: config.hostHeader } : {}),
    };
  } else if (config.transport === 'xhttp') {
    streamSettings['xhttpSettings'] = {
      path: config.path ?? '/',
      ...(config.hostHeader ? { host: config.hostHeader } : {}),
    };
  }

  let settings: Record<string, unknown>;
  switch (proto) {
    case 'hysteria2': {
      // xray-core has no hysteria2 outbound — engineSupports() never routes
      // hy2 here; keep the honest guard in case routing changes.
      settings = { servers: [{ address: config.host, port: config.port }] };
      break;
    }
    case 'vless':
      settings = {
        vnext: [{
          address: config.host,
          port: config.port,
          users: [{ id: secret ?? '', encryption: 'none', ...(config.flow ? { flow: config.flow } : {}), level: 0 }],
        }],
      };
      break;
    case 'vmess':
      settings = {
        vnext: [{
          address: config.host,
          port: config.port,
          users: [{ id: secret ?? '', alterId: config.alterId ?? 0, security: config.encryption ?? 'auto', level: 0 }],
        }],
      };
      break;
    case 'trojan':
      settings = { servers: [{ address: config.host, port: config.port, password: secret ?? '' }] };
      break;
    case 'shadowsocks':
      settings = { servers: [{ address: config.host, port: config.port, method: config.encryption ?? 'aes-256-gcm', password: secret ?? '', uot: true }] };
      break;
    default:
      settings = {};
  }

  return { protocol: proto, settings, streamSettings, tag: 'proxy' };
}

/**
 * Xray/v2ray routing rules for a bypass set. Xray matches `domain:example.com`
 * against the name AND every subdomain, which is exactly the suffix semantics
 * the settings UI describes; `geoip:private` covers loopback/RFC1918/ULA.
 * Exported so the rule shape is unit-tested directly (it is easy to get subtly
 * wrong and a wrong rule silently routes the wrong traffic).
 */
export function buildXrayRoutingRules(rs: BypassRuleSet): Record<string, unknown>[] {
  const domain = rs.domains.map((d) => `domain:${d}`);
  const ip = [...rs.ips];
  if (rs.lan) ip.push('geoip:private');
  const rules: Record<string, unknown>[] = [];
  if (domain.length > 0 || ip.length > 0 || rs.ports.length > 0) {
    const rule: Record<string, unknown> = { type: 'field', outboundTag: 'direct' };
    if (domain.length > 0) rule['domain'] = domain;
    if (ip.length > 0) rule['ip'] = ip;
    if (rs.ports.length > 0) rule['port'] = rs.ports.join(',');
    rules.push(rule);
  }
  return rules;
}

/**
 * Xray config JSON: node outbound + one HTTP inbound on the given port.
 *
 * `bypass` is applied ONLY by the long-lived tunnel — a probe that skipped the
 * node would be measuring the wrong path, so the default (undefined) leaves
 * routing untouched.
 *
 * `dialThroughPort` is NESTED MODE: the node connection is dialled through a
 * local HTTP proxy (the other core in the chain) via `sockopt.dialerProxy`, so
 * this core's traffic leaves through the other hop. Measured against xray
 * 26.3.27: the chain is real (killing the peer core kills the path).
 */
export function buildXrayConfig(
  config: ParsedNodeConfig,
  secret: string | null,
  httpPort: number,
  bypass?: BypassRuleSet | null,
  dialThroughPort?: number | null,
): Record<string, unknown> {
  const nodeOutbound = buildXrayOutbound(config, secret) as { streamSettings: Record<string, unknown> };
  const outbounds: unknown[] = [nodeOutbound];
  if (dialThroughPort != null) {
    nodeOutbound.streamSettings['sockopt'] = { dialerProxy: CHAIN_DIAL_TAG };
    // An HTTP outbound performs CONNECT, which is what the peer core's inbound
    // speaks. (A SOCKS outbound only matches a SOCKS inbound.)
    outbounds.push({
      protocol: 'http',
      tag: CHAIN_DIAL_TAG,
      settings: { servers: [{ address: '127.0.0.1', port: dialThroughPort }] },
    });
  }
  const base: Record<string, unknown> = {
    log: { loglevel: 'warning' },
    inbounds: [{
      tag: 'probe-in',
      listen: '127.0.0.1',
      port: httpPort,
      protocol: 'http',
    }],
    outbounds,
  };
  if (bypass && !bypassIsEmpty(bypass)) {
    outbounds.push({ protocol: 'freedom', tag: 'direct' });
    base['routing'] = { domainStrategy: 'AsIs', rules: buildXrayRoutingRules(bypass) };
  }
  return base;
}

/** v2ray-core uses the same JSON schema as Xray-core (it is the upstream). */
export const buildV2rayConfig = buildXrayConfig;

/**
 * sing-box routing rules for a bypass set. Private ranges get their OWN rule:
 * `ip_is_private` is a standalone matcher, and folding it into the
 * domain/CIDR/port rule would make that rule match far more than intended.
 * Exported for direct unit testing.
 */
export function buildSingboxRouteRules(rs: BypassRuleSet): Record<string, unknown>[] {
  const rules: Record<string, unknown>[] = [];
  if (rs.domains.length > 0 || rs.ips.length > 0 || rs.ports.length > 0) {
    const rule: Record<string, unknown> = { outbound: 'direct' };
    if (rs.domains.length > 0) rule['domain_suffix'] = rs.domains;
    if (rs.ips.length > 0) rule['ip_cidr'] = rs.ips;
    if (rs.ports.length > 0) rule['port'] = rs.ports;
    rules.push(rule);
  }
  if (rs.lan) rules.push({ ip_is_private: true, outbound: 'direct' });
  return rules;
}

/**
 * sing-box config (same shape proxyProbe already used, extracted so both
 * engines share one lifecycle). `bypass` is tunnel-only, same rationale as
 * buildXrayConfig.
 */
export function buildSingboxConfig(
  config: ParsedNodeConfig,
  secret: string | null,
  mixedPort: number,
  bypass?: BypassRuleSet | null,
  dialThroughPort?: number | null,
): Record<string, unknown> {
  const proto = config.protocol;
  const outbound: Record<string, unknown> = {
    type: proto,
    server: config.host,
    server_port: config.port,
  };

  const tlsBlock: Record<string, unknown> = {
    enabled: true,
    server_name: config.sni ?? config.host,
    insecure: config.allowInsecure === true,
  };
  if (config.realityPublicKey) {
    tlsBlock['reality'] = {
      enabled: true,
      public_key: config.realityPublicKey,
      short_id: config.realityShortId ?? '',
    };
  } else {
    tlsBlock['utls'] = { enabled: true, fingerprint: config.fingerprint ?? 'chrome' };
  }

  const needsTls = proto === 'vless' || proto === 'vmess' || proto === 'trojan'
    ? config.security === 'tls' || config.security === 'reality' || Boolean(config.realityPublicKey)
    : proto === 'hysteria2' || proto === 'tuic';
  if (needsTls) outbound['tls'] = tlsBlock;

  if (config.transport === 'ws') {
    outbound['transport'] = { type: 'ws', path: config.path ?? '/' };
  } else if (config.transport === 'grpc') {
    outbound['transport'] = { type: 'grpc', service_name: config.serviceName ?? '' };
  } else if (config.transport === 'http') {
    outbound['transport'] = {
      type: 'http',
      path: config.path ?? '/',
      ...(config.hostHeader ? { host: [config.hostHeader] } : {}),
    };
  } else if (config.transport === 'httpupgrade') {
    outbound['transport'] = {
      type: 'httpupgrade',
      path: config.path ?? '/',
      ...(config.hostHeader ? { host: config.hostHeader } : {}),
    };
  }

  switch (proto) {
    case 'vless':
      outbound['uuid'] = secret ?? '';
      if (config.flow) outbound['flow'] = config.flow;
      break;
    case 'vmess':
      outbound['uuid'] = secret ?? '';
      outbound['alter_id'] = config.alterId ?? 0;
      outbound['security'] = config.vmessSecurity ?? config.encryption ?? 'auto';
      break;
    case 'trojan':
      outbound['password'] = secret ?? '';
      break;
    case 'shadowsocks':
      outbound['method'] = config.encryption ?? 'aes-256-gcm';
      outbound['password'] = secret ?? '';
      break;
    case 'hysteria2': {
      // Credentials are REQUIRED — without them sing-box exits at startup
      // and the probe blames the node for a local config bug.
      outbound['password'] = secret ?? '';
      if (typeof config.extra?.['obfs'] === 'string' && config.extra['obfs']) {
        outbound['obfs'] = { type: String(config.extra['obfs']), password: String(config.extra['obfs-password'] ?? '') };
      }
      if (config.extra && config.extra['up'] != null) outbound['up_mbps'] = Number(config.extra['up']) || undefined;
      if (config.extra && config.extra['down'] != null) outbound['down_mbps'] = Number(config.extra['down']) || undefined;
      break;
    }
    case 'tuic': {
      outbound['uuid'] = secret ?? '';
      if (config.extra && config.extra['password'] != null) outbound['password'] = String(config.extra['password']);
      outbound['congestion_control'] = String(config.extra?.['congestion_control'] ?? 'bbr');
      outbound['udp_relay_mode'] = String(config.extra?.['udp_relay_mode'] ?? 'native');
      break;
    }
    default:
      break;
  }

  const outbounds: Record<string, unknown>[] = [outbound];
  if (dialThroughPort != null) {
    // NESTED MODE: `detour` makes this outbound dial through the peer core.
    outbound['detour'] = CHAIN_DIAL_TAG;
    outbounds.push({ type: 'http', tag: CHAIN_DIAL_TAG, server: '127.0.0.1', server_port: dialThroughPort });
  }
  const route: Record<string, unknown> = { auto_detect_interface: true };
  if (bypass && !bypassIsEmpty(bypass)) {
    outbounds.push({ type: 'direct', tag: 'direct' });
    route['rules'] = buildSingboxRouteRules(bypass);
  }

  return {
    log: { level: 'warn', timestamp: true },
    inbounds: [{ type: 'mixed', tag: 'probe-in', listen: '127.0.0.1', listen_port: mixedPort }],
    outbounds,
    route,
  };
}

/* ============================ binary detection ============================ */

export interface ResolvedEngine {
  id: ProxyEngineId;
  bin: string;
  /** spawn args before the config file */
  args: string[];
}

/**
 * Find a core binary. Search order:
 *   1. NETPULSE_CORES_DIR (explicit override)
 *   2. <dataDir>/cores/ — the desktop app's per-user drop-in folder; users
 *      copy xray.exe / sing-box.exe there and the app finds them without
 *      touching PATH (existence check only — nothing is executed here)
 *   3. PATH
 */
export function findEngineBinary(id: ProxyEngineId): string | null {
  const base = id === 'xray' ? 'xray' : id === 'sing-box' ? 'sing-box' : 'v2ray';
  const names = process.platform === 'win32' ? [`${base}.exe`] : [base];
  const dirs: string[] = [];
  if (process.env['NETPULSE_CORES_DIR']) dirs.push(process.env['NETPULSE_CORES_DIR']);
  if (process.env['NETPULSE_DATA_DIR']) dirs.push(path.join(process.env['NETPULSE_DATA_DIR'], 'cores'));
  dirs.push(...(process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean));
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
      } catch { /* unreadable dir */ }
    }
  }
  return null;
}

/* ============================ spawn + readiness ============================ */

export interface CoreRun {
  child: ReturnType<typeof spawn>;
  inboundPort: number;
  /** kill the core + delete the temp config (idempotent) */
  cleanup: () => void;
  readonly stderrTail: string;
}

export type EngineStartFailure = 'engine_unavailable' | 'engine_start_failed';

export type CoreStartResult =
  | { ok: true; run: CoreRun }
  | { ok: false; failure: EngineStartFailure; error: string };

/**
 * The line from a core's output that actually explains a startup failure.
 * Cores are inconsistent about it, so look for the known phrasings before
 * falling back to the caller's message.
 */
function startupReason(output: string, fallback: string): string {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const matched = lines.find((l) => /FATAL|failed to start|unknown cipher|ERROR/i.test(l));
  return redactSecrets(matched ?? fallback);
}

/** Reserve an ephemeral loopback port for the inbound. */
export function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
  });
}

/**
 * Start a core with a generated config; resolves when its inbound accepts TCP
 * connections, or with an honest classified failure. `run.cleanup()` is always
 * safe to call, twice, or after a failed start.
 */
export async function startCore(
  engine: ResolvedEngine,
  config: ParsedNodeConfig,
  secret: string | null,
  readyTimeoutMs = 5_000,
  opts?: { bypass?: BypassRuleSet | null; dialThroughPort?: number | null },
): Promise<CoreStartResult> {
  const dialThroughPort = opts?.dialThroughPort ?? null;
  if (dialThroughPort != null) {
    // Refuse a wiring the engine provably ignores instead of shipping a
    // "chain" that is really a direct connection.
    const why = chainExitUnsupported(engine.id, config.protocol);
    if (why) return { ok: false, failure: 'engine_unavailable', error: why };
  }
  const inboundPort = await reservePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-core-'));
  const cfgPath = path.join(tmpDir, 'core.json');
  const bypass = opts?.bypass ?? null;
  const cfgJson = engine.id === 'sing-box'
    ? buildSingboxConfig(config, secret, inboundPort, bypass, dialThroughPort)
    : buildXrayConfig(config, secret, inboundPort, bypass, dialThroughPort); // xray + v2ray share the schema
  fs.writeFileSync(cfgPath, JSON.stringify(cfgJson));

  const child = spawn(engine.bin, [...engine.args, '-c', cfgPath], {
    windowsHide: true,
    shell: false,
    // stdout too: xray logs config failures to stdout, so piping only stderr
    // reduced "unknown cipher method: aes-256-cfb" to a bare exit code 23.
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrTail = '';
  const capture = (c: Buffer) => { stderrTail = (stderrTail + c.toString()).slice(-2_000); };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);

  const cleanup = () => {
    try { child.kill(); } catch { /* already dead */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  return await new Promise<CoreStartResult>((resolve) => {
    let settled = false;
    const finishOk = () => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      resolve({
        ok: true,
        run: { child, inboundPort, cleanup, get stderrTail() { return stderrTail; } },
      });
    };
    const finishFail = (failure: EngineStartFailure, error: string) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      cleanup();
      resolve({ ok: false, failure, error });
    };

    const timer = setTimeout(() => {
      finishFail('engine_start_failed', startupReason(stderrTail, `core did not become ready in ${readyTimeoutMs}ms`));
    }, readyTimeoutMs);

    child.once('error', (err: Error) => {
      finishFail('engine_unavailable', `core spawn failed: ${err.message}`);
    });
    child.once('close', (code) => {
      if (!settled) finishFail('engine_start_failed', `core exited during startup (code ${code ?? '?'}) — ${startupReason(stderrTail, 'no output')}`);
    });

    const poll = setInterval(() => {
      const sock = net.createConnection({ host: '127.0.0.1', port: inboundPort, timeout: 400 }, () => {
        sock.destroy();
        finishOk();
      });
      sock.on('error', () => sock.destroy());
      sock.on('timeout', () => sock.destroy());
    }, 300);
  });
}

/**
 * Which engines can dial a protocol. Honest matrix: xray/v2ray have no
 * hysteria2/tuic outbounds; NO core supports shadowsocksr (it was removed
 * from sing-box and never existed in xray/v2ray) — advertising it made the
 * UI offer a test that can only fail.
 */
export function engineSupports(engine: ProxyEngineId, protocol: string): boolean {
  if (engine === 'sing-box') return ['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria2', 'tuic'].includes(protocol);
  return ['vless', 'vmess', 'trojan', 'shadowsocks'].includes(protocol); // xray, v2ray
}

/**
 * Shadowsocks ciphers that are AEAD (or none). The v2ray family dropped every
 * other method — measured on xray 26.3.27: `unknown cipher method: aes-256-cfb`
 * → the core exits during startup — while sing-box still carries them. Without
 * this check the engine picker hands such a node to xray and the only evidence
 * is a bare exit code.
 */
export function isAeadShadowsocksCipher(cipher: string): boolean {
  const c = cipher.trim().toLowerCase();
  return c === 'none' || c.includes('-gcm') || c.includes('poly1305') || c.startsWith('2022-blake3');
}

/**
 * Can this engine run THIS config? The checks a protocol name alone cannot make:
 * v2ray-core lacks Xray-only extensions (Reality, xhttp), and the v2ray family
 * cannot run non-AEAD shadowsocks ciphers at all.
 *
 * Refusing here means the picker chooses an engine that works (or reports an
 * honest, specific reason) instead of starting a core that dies with a cryptic
 * exit code.
 */
export function engineSupportsConfig(engine: ProxyEngineId, config: ParsedNodeConfig): { ok: true } | { ok: false; error: string } {
  if (engine !== 'sing-box' && config.protocol === 'shadowsocks') {
    const cipher = config.encryption ?? 'aes-256-gcm';
    if (!isAeadShadowsocksCipher(cipher)) {
      return { ok: false, error: `${engine}-core cannot run the shadowsocks cipher "${cipher}" (not AEAD — the v2ray family dropped those; use sing-box for this node)` };
    }
  }
  if (engine !== 'v2ray') return { ok: true };
  if (config.security === 'reality' || config.realityPublicKey) {
    return { ok: false, error: 'v2ray-core does not support Reality (use xray or sing-box for this node)' };
  }
  if (config.transport === 'xhttp') {
    return { ok: false, error: 'v2ray-core does not support the xhttp transport (use xray for this node)' };
  }
  return { ok: true };
}
