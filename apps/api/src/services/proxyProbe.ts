/**
 * Real proxy probe for public nodes.
 *
 * Given a normalized node config, this module:
 *   1. builds a sing-box config with the node as outbound + a mixed inbound on
 *      an EPHEMERAL loopback port (never the VPN profile's fixed port),
 *   2. spawns sing-box with windowsHide and a bounded lifecycle,
 *   3. issues a real HTTPS request through the proxy to a lightweight endpoint,
 *   4. reports measured latency ONLY if traffic provably traversed the proxy
 *      (handshake via CONNECT, response received),
 *   5. always terminates the child and deletes the temp config.
 *
 * If the sing-box binary is not installed, the probe reports
 * `engine_unavailable` instead of a fake success — the UI can then say
 * "install sing-box to test proxy latency" instead of showing a green check.
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

import { redactSecrets } from '../util/redact';
import tls from 'node:tls';

import { reservePort, spawnCoreProcess } from './coreProcess';

import type { ParsedNodeConfig } from '@netpulse/shared';

/** sing-box protocol families supported by this probe. */
const SUPPORTED = new Set(['vless', 'vmess', 'trojan', 'shadowsocks', 'shadowsocksr']);

/** Convert a normalized node config into a sing-box outbound object. */
export function buildNodeOutbound(config: ParsedNodeConfig): Record<string, unknown> {
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
      outbound['uuid'] = '<secret>';
      if (config.flow) outbound['flow'] = config.flow;
      break;
    case 'vmess':
      outbound['uuid'] = '<secret>';
      outbound['alter_id'] = config.alterId ?? 0;
      outbound['security'] = config.encryption ?? 'auto';
      break;
    case 'trojan':
      outbound['password'] = '<secret>';
      break;
    case 'shadowsocks':
      outbound['method'] = config.encryption ?? 'aes-256-gcm';
      outbound['password'] = '<secret>';
      break;
    default:
      break;
  }
  return outbound;
}

export interface ProxyProbeResult {
  status: 'done' | 'failed';
  /** End-to-end latency (proxy handshake + TLS + HTTP) in ms. */
  latencyMs: number | null;
  totalMs: number;
  tlsVersion: string | null;
  httpStatus: number | null;
  /** Classification of failure, for honest UI messaging. */
  failureKind: 'engine_unavailable' | 'engine_start_failed' | 'handshake_failed' | 'target_failed' | null;
  error: string | null;
}

const PROBE_TIMEOUT_MS = 12_000;

/** How long the core gets to open its mixed inbound before this is a failure. */
const ENGINE_READY_TIMEOUT_MS = 5_000;

/** HTTPS request through an HTTP CONNECT tunnel. */
export function httpsViaConnectRef(
  proxyPort: number,
  targetHost: string,
  targetPort: number,
  timeoutMs: number,
): Promise<{ status: number | null; latencyMs: number; tlsVersion: string | null }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const socket = net.connect({ host: '127.0.0.1', port: proxyPort });
    let tlsSocket: tls.TLSSocket | null = null;
    // One deadline for the whole exchange: socket timeouts reset on activity,
    // so an endpoint that keeps dribbling bytes could otherwise hold the
    // promise open well past the caller's budget.
    const deadline = setTimeout(() => fail(new Error('probe timed out')), timeoutMs);

    const fail = (err: Error) => {
      clearTimeout(deadline);
      tlsSocket?.destroy();
      socket.destroy();
      reject(err);
    };
    socket.setTimeout(timeoutMs, () => fail(new Error('proxy handshake timed out')));

    socket.on('connect', () => {
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`,
      );
    });

    let buf = '';
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('latin1');
      if (!buf.includes('\r\n\r\n')) return;
      socket.removeListener('data', onData);
      const statusLine = buf.split('\r\n')[0] ?? '';
      const m = statusLine.match(/HTTP\/1\.[01] (\d{3})/);
      if (!m || m[1] !== '200') {
        return fail(new Error(`proxy CONNECT rejected: ${statusLine.slice(0, 80)}`));
      }
      // TLS upgrade through the tunnel
      tlsSocket = tls.connect({ socket, servername: targetHost }, () => {
        const tlsVersion = tlsSocket?.getProtocol() ?? null;
        tlsSocket?.write(
          `GET / HTTP/1.1\r\nHost: ${targetHost}\r\nUser-Agent: NetPulse-ProxyProbe/1.0\r\nConnection: close\r\n\r\n`,
        );
        let resp = '';
        tlsSocket?.on('data', (d: Buffer) => {
          resp += d.toString('latin1');
          const first = resp.split('\r\n\r\n')[0] ?? '';
          const statusMatch = first.match(/HTTP\/1\.[01] (\d{3})/);
          const headersEnd = resp.indexOf('\r\n\r\n');
          if (statusMatch && headersEnd >= 0) {
            const done = Date.now();
            clearTimeout(deadline);
            tlsSocket?.destroy();
            socket.destroy();
            resolve({ status: Number(statusMatch[1]), latencyMs: done - started, tlsVersion });
          }
        });
        tlsSocket?.on('error', (err: Error) => fail(err));
      });
      tlsSocket.setTimeout(timeoutMs, () => fail(new Error('TLS through proxy timed out')));
      tlsSocket.on('error', (err: Error) => fail(err));
    });

    function onData(): void {
      /* replaced by the closure above */
    }
    socket.on('error', (err: Error) => fail(err));
  });
}

export interface ProxyProbeOptions {
  /** Resolved secret material for the node (uuid/password). */
  secret: string | null;
  /** HTTPS endpoint to request through the proxy. */
  testUrl?: string;
  timeoutMs?: number;
}

/**
 * Probe a node by tunneling real traffic through it via sing-box.
 * Never throws — always returns a classified result.
 */
export async function proxyProbe(
  config: ParsedNodeConfig,
  opts: ProxyProbeOptions,
): Promise<ProxyProbeResult> {
  const started = Date.now();
  const testUrl = opts.testUrl ?? 'https://www.cloudflare.com/cdn-cgi/trace';
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;

  let parsed: URL;
  try {
    parsed = new URL(testUrl);
  } catch {
    return { status: 'failed', latencyMs: null, totalMs: 0, tlsVersion: null, httpStatus: null, failureKind: 'target_failed', error: 'invalid test URL' };
  }
  const targetHost = parsed.hostname;
  const targetPort = Number(parsed.port) || 443;

  if (!SUPPORTED.has(config.protocol)) {
    return { status: 'failed', latencyMs: null, totalMs: 0, tlsVersion: null, httpStatus: null, failureKind: 'handshake_failed', error: `protocol ${config.protocol} is not proxy-testable` };
  }

  const outbound = buildNodeOutbound(config);
  if (opts.secret) {
    if (outbound['uuid'] === '<secret>') outbound['uuid'] = opts.secret;
    else if (outbound['password'] === '<secret>') outbound['password'] = opts.secret;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-probe-'));
  const cfgPath = path.join(tmpDir, 'probe.json');
  const bin = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
  // The core process lifecycle (spawn → inbound answering → kill + temp-config
  // removal) belongs to ./coreProcess; this probe owns only its config and its
  // measurement.
  let cleanup: (() => void) | null = null;
  try {
    // Port reservation is INSIDE the try: under heavy socket pressure the
    // kernel can refuse the ephemeral bind (ENOBUFS) — that must surface as a
    // classified failure, never escape the probe's never-throws contract.
    const mixedPort = await reservePort();
    const cfg = {
      log: { level: 'warn', timestamp: true },
      inbounds: [{ type: 'mixed', tag: 'probe-in', listen: '127.0.0.1', listen_port: mixedPort }],
      outbounds: [outbound],
      route: { auto_detect_interface: true },
    };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));

    const core = await spawnCoreProcess({
      bin,
      args: ['run', '-c', cfgPath],
      readyPort: mixedPort,
      readyTimeoutMs: ENGINE_READY_TIMEOUT_MS,
      tempDir: tmpDir,
      label: 'sing-box',
    });
    if (!core.ok) {
      // A core that could not be EXECUTED is missing (or blocked), which the UI
      // answers with an install offer — never a claim about the node.
      const missing = core.failure === 'spawn_error';
      return {
        status: 'failed', latencyMs: null, totalMs: Date.now() - started, tlsVersion: null, httpStatus: null,
        failureKind: missing ? 'engine_unavailable' : 'engine_start_failed',
        error: missing ? 'sing-box is not installed — proxy tests require it' : core.error,
      };
    }
    cleanup = core.process.cleanup;

    const result = await httpsViaConnectRef(mixedPort, targetHost, targetPort, timeoutMs);
    return { status: 'done', latencyMs: result.latencyMs, totalMs: Date.now() - started, tlsVersion: result.tlsVersion, httpStatus: result.status, failureKind: null, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Local bind/socket failures are the app's environment, not the remote
    // target — never blame the target for them.
    if (/EADDRINUSE|ENOBUFS|EACCES/i.test(msg)) {
      return { status: 'failed', latencyMs: null, totalMs: Date.now() - started, tlsVersion: null, httpStatus: null, failureKind: 'engine_unavailable', error: `local probe port unavailable: ${msg.slice(0, 150)}` };
    }
    return {
      status: 'failed', latencyMs: null, totalMs: Date.now() - started, tlsVersion: null, httpStatus: null,
      failureKind: /timed out/i.test(msg) ? 'handshake_failed' : 'target_failed',
      error: redactSecrets(msg),
    };
  } finally {
    // Kills the child and removes the temp config. On a refusal that never
    // spawned anything the owner already removed the dir.
    cleanup?.();
  }
}
