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

import type { ParsedNodeConfig, ProxyEngineId } from '@netpulse/shared';

/* ============================ config generation ============================ */

/**
 * Xray outbound for a node. Follows the V2Ray/Xray outbound schema
 * (protocol + settings + streamSettings), which differs from sing-box's
 * flat format.
 */
export function buildXrayOutbound(config: ParsedNodeConfig, secret: string | null): Record<string, unknown> {
  const proto = config.protocol === 'shadowsocksr' ? 'shadowsocks' : config.protocol;
  const isReality = config.security === 'reality' || Boolean(config.realityPublicKey);

  const network = config.transport === 'none' || config.transport === 'unknown' ? 'tcp' : config.transport;
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
  }

  let settings: Record<string, unknown>;
  switch (proto) {
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

/** Xray config JSON: node outbound + one HTTP inbound on the given port. */
export function buildXrayConfig(config: ParsedNodeConfig, secret: string | null, httpPort: number): Record<string, unknown> {
  return {
    log: { loglevel: 'warning' },
    inbounds: [{
      tag: 'probe-in',
      listen: '127.0.0.1',
      port: httpPort,
      protocol: 'http',
    }],
    outbounds: [buildXrayOutbound(config, secret)],
  };
}

/**
 * sing-box config (same shape proxyProbe already used, extracted so both
 * engines share one lifecycle).
 */
export function buildSingboxConfig(config: ParsedNodeConfig, secret: string | null, mixedPort: number): Record<string, unknown> {
  const proto = config.protocol === 'shadowsocksr' ? 'shadowsocks' : config.protocol;
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
  }

  switch (proto) {
    case 'vless':
      outbound['uuid'] = secret ?? '';
      if (config.flow) outbound['flow'] = config.flow;
      break;
    case 'vmess':
      outbound['uuid'] = secret ?? '';
      outbound['alter_id'] = config.alterId ?? 0;
      outbound['security'] = config.encryption ?? 'auto';
      break;
    case 'trojan':
    case 'shadowsocks':
      outbound['password'] = secret ?? '';
      if (proto === 'shadowsocks') outbound['method'] = config.encryption ?? 'aes-256-gcm';
      break;
    default:
      break;
  }

  return {
    log: { level: 'warn', timestamp: true },
    inbounds: [{ type: 'mixed', tag: 'probe-in', listen: '127.0.0.1', listen_port: mixedPort }],
    outbounds: [outbound],
    route: { auto_detect_interface: true },
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
  const names = id === 'xray'
    ? (process.platform === 'win32' ? ['xray.exe'] : ['xray'])
    : (process.platform === 'win32' ? ['sing-box.exe'] : ['sing-box']);
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
): Promise<CoreStartResult> {
  const inboundPort = await reservePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-core-'));
  const cfgPath = path.join(tmpDir, 'core.json');
  const cfgJson = engine.id === 'xray'
    ? buildXrayConfig(config, secret, inboundPort)
    : buildSingboxConfig(config, secret, inboundPort);
  fs.writeFileSync(cfgPath, JSON.stringify(cfgJson));

  const child = spawn(engine.bin, [...engine.args, '-c', cfgPath], {
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let stderrTail = '';
  child.stderr?.on('data', (c: Buffer) => { stderrTail = (stderrTail + c.toString()).slice(-2_000); });

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
      finishFail(
        'engine_start_failed',
        redactSecrets(stderrTail.match(/FATAL|ERROR.*/)?.[0] ?? `core did not become ready in ${readyTimeoutMs}ms`),
      );
    }, readyTimeoutMs);

    child.once('error', (err: Error) => {
      finishFail('engine_unavailable', `core spawn failed: ${err.message}`);
    });
    child.once('close', (code) => {
      if (!settled) finishFail('engine_start_failed', redactSecrets(`core exited during startup (code ${code ?? '?'}) ${stderrTail.slice(-120)}`));
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

/** Which engines can dial a protocol (xray cannot do hy2/tuic/ssr). */
export function engineSupports(engine: ProxyEngineId, protocol: string): boolean {
  if (engine === 'xray') return ['vless', 'vmess', 'trojan', 'shadowsocks'].includes(protocol);
  return ['vless', 'vmess', 'trojan', 'shadowsocks', 'shadowsocksr', 'hysteria2', 'tuic'].includes(protocol);
}
