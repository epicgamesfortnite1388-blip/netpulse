/**
 * Engine-aware proxy probe runner.
 *
 * Picks an available local core (xray or sing-box) honoring the user's
 * preference and the node's protocol, spawns it with the node's REAL secret
 * (from the at-rest vault — tests without credentials can never succeed for
 * authenticated protocols), tunnels a real HTTPS request through the core,
 * and reports the engine used alongside the measurement.
 */
import type { ParsedNodeConfig, ProxyEngineId, ProxyEngineStatus } from '@netpulse/shared';

import { engineSupports, findEngineBinary, startCore, type CoreRun, type ResolvedEngine } from './proxyCores';

/** HTTPS-through-CONNECT probe (shared with the legacy single-engine path). */
const httpsViaConnect = (
  proxyPort: number,
  targetHost: string,
  targetPort: number,
  timeoutMs: number,
): Promise<{ status: number | null; latencyMs: number; tlsVersion: string | null }> => {
  // Reuse the proven implementation from proxyProbe.
  return import('./proxyProbe').then((m) => m.httpsViaConnectRef(proxyPort, targetHost, targetPort, timeoutMs));
};

export interface EngineProbeOptions {
  secret: string | null;
  testUrl?: string;
  timeoutMs?: number;
  /** user preference from settings */
  preferred: 'auto' | ProxyEngineId;
  onEngineResolved?: (engine: ProxyEngineId | null) => void;
}

export interface EngineProbeResult {
  status: 'done' | 'failed';
  engine: ProxyEngineId | null;
  latencyMs: number | null;
  totalMs: number;
  tlsVersion: string | null;
  httpStatus: number | null;
  failureKind: 'engine_unavailable' | 'engine_start_failed' | 'handshake_failed' | 'target_failed' | null;
  error: string | null;
}

/** Enumerate local core availability (cheap: PATH existence checks). */
export function proxyEngineStatus(preferred: 'auto' | ProxyEngineId): ProxyEngineStatus {
  const engines: ProxyEngineStatus['engines'] = [];
  let effective: ProxyEngineId | null = null;

  const order: ProxyEngineId[] = preferred === 'auto' ? ['xray', 'sing-box'] : [preferred, preferred === 'xray' ? 'sing-box' : 'xray'];
  for (const id of order) {
    const bin = findEngineBinary(id);
    const available = bin !== null;
    engines.push({
      id,
      label: id === 'xray' ? 'Xray-core' : 'sing-box',
      available,
      path: bin,
      version: null, // version spawn is deferred to the health page probe
      protocols: id === 'xray'
        ? ['vless', 'vmess', 'trojan', 'shadowsocks']
        : ['vless', 'vmess', 'trojan', 'shadowsocks', 'shadowsocksr', 'hysteria2', 'tuic'],
    });
    if (effective === null && available) effective = id;
  }
  return { engines, preferred, effective };
}

const PROBE_TIMEOUT_MS = 12_000;

/**
 * Probe a node through the best available engine. Never throws.
 */
export async function proxyProbeWithEngine(
  config: ParsedNodeConfig,
  opts: EngineProbeOptions,
): Promise<EngineProbeResult> {
  const started = Date.now();
  const testUrl = opts.testUrl ?? 'https://www.cloudflare.com/cdn-cgi/trace';
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;

  let parsed: URL;
  try {
    parsed = new URL(testUrl);
  } catch {
    return { status: 'failed', engine: null, latencyMs: null, totalMs: 0, tlsVersion: null, httpStatus: null, failureKind: 'target_failed', error: 'invalid test URL' };
  }
  const targetHost = parsed.hostname;
  const targetPort = Number(parsed.port) || 443;

  // ---- engine selection: preference ∩ availability ∩ protocol support ----
  const status = proxyEngineStatus(opts.preferred);
  const usable = status.engines.filter((e) => e.available && engineSupports(e.id, config.protocol));
  if (usable.length === 0) {
    const anyInstalled = status.engines.some((e) => e.available);
    const supportedBy = (Object.keys({ vless: 1 }).length, config.protocol);
    void supportedBy;
    return {
      status: 'failed',
      engine: null,
      latencyMs: null,
      totalMs: Date.now() - started,
      tlsVersion: null,
      httpStatus: null,
      failureKind: 'engine_unavailable',
      error: anyInstalled
        ? `no installed core supports protocol ${config.protocol}`
        : 'no proxy core installed — install xray or sing-box to test proxy latency',
    };
  }
  const chosen = usable[0]!;
  const engine: ResolvedEngine = {
    id: chosen.id,
    bin: chosen.path!,
    args: ['run'],
  };
  opts.onEngineResolved?.(chosen.id);

  const run = await startCore(engine, config, opts.secret);
  if (!run.ok) {
    return {
      status: 'failed',
      engine: chosen.id,
      latencyMs: null,
      totalMs: Date.now() - started,
      tlsVersion: null,
      httpStatus: null,
      failureKind: run.failure,
      error: run.error,
    };
  }

  const active: CoreRun = run.run;
  try {
    const result = await httpsViaConnect(active.inboundPort, targetHost, targetPort, timeoutMs);
    return {
      status: 'done',
      engine: chosen.id,
      latencyMs: result.latencyMs,
      totalMs: Date.now() - started,
      tlsVersion: result.tlsVersion,
      httpStatus: result.status,
      failureKind: null,
      error: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'failed',
      engine: chosen.id,
      latencyMs: null,
      totalMs: Date.now() - started,
      tlsVersion: null,
      httpStatus: null,
      failureKind: /timed out|rejected|reset/i.test(msg) ? 'handshake_failed' : 'target_failed',
      error: msg.slice(0, 200),
    };
  } finally {
    active.cleanup();
  }
}
